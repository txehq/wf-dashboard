import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import matter from 'gray-matter';
import { afterAll, describe, expect, test } from 'vitest';
import {
  bindingView,
  deriveFromSession,
  rebindAll,
  sessionSkillLoads,
  setManualBinding,
} from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { batches, runs, sessions, sessionSkills, sessionSkillScans } from '../src/db/schema.js';
import { backfillSkillLoads, ingestFile } from '../src/ingest/ingest.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import {
  BASE_COMMIT,
  IC,
  LFG,
  modifiedIcSession,
  unpackSession,
  workDir,
} from './helpers/session-fixtures.js';

// Contracts 15.1：真实 session（dqva52 的 lfg、27yz3d 的 ic）与从 txe-workflow 9f2bed6 导出的真实 variant
const dir = workDir('bindings');
const dataDir = path.join(dir, 'data');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  onSkillsChanged: () => {
    rebindAll(db, dataDir);
  },
});

afterAll(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const binding = (id: string) =>
  db
    .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

const lfgFile = unpackSession(dir, LFG);
const icFile = unpackSession(dir, IC);

describe('session 绑定 variant', { timeout: 300_000 }, () => {
  test('导入时提取每次加载的 skill 正文与参数', () => {
    ingestFile(db, lfgFile);
    ingestFile(db, icFile);
    const lfg = sessionSkillLoads(db, LFG.sessionId);
    expect(lfg.map((l) => l.name)).toEqual([
      'lfg',
      'interview',
      'research',
      'plan',
      'decide',
      'publish-artifacts',
      'report-friction',
      'ticketing',
    ]);
    // slash 命令 /lfg 的参数来自命令消息的 <command-args>
    expect(lfg[0]?.args.startsWith('做一个计算器')).toBe(true);
    expect(lfg[0]?.text.endsWith(`\n\nARGUMENTS: ${lfg[0].args}`)).toBe(true);
    const ic = sessionSkillLoads(db, IC.sessionId);
    expect(ic.map((l) => [l.name, l.args])).toEqual([
      ['ic', 'TXE-3767'],
      ['claim', 'TXE-3767'],
      ['readiness', 'TXE-3767 --need node>=22.12.0 --need npm'],
      ['implement', 'TXE-3767'],
      ['open-pr', 'TXE-3767'],
      ['review-pr', 'https://github.com/txehq/wfe-r-20261009-27yz3d/pull/1'],
    ]);
    // 还没有 variant：不绑定
    expect(binding(IC.sessionId)).toEqual({ variantId: null, binding: null });
  });

  let first = '';
  let second = '';
  test('与基线逐字节一致时自动绑定；多个一致时绑定最早创建的，并列出其余', async () => {
    const a = await variants.createBaseline({
      name: 'w31-基线 A',
      commit: BASE_COMMIT,
      model: 'opus',
      effort: 'high',
    });
    first = a.id;
    expect(binding(LFG.sessionId)).toEqual({ variantId: a.id, binding: 'auto' });
    expect(binding(IC.sessionId)).toEqual({ variantId: a.id, binding: 'auto' });

    const b = variants.derive(a.id, { name: 'w31-基线 B' });
    second = b.id;
    // 后建的 B 同样一致：仍绑定最早的 A，B 列在其余一致的 variant 中
    expect(binding(IC.sessionId)).toEqual({ variantId: a.id, binding: 'auto' });
    const view = bindingView(db, dataDir, IC.sessionId);
    expect(view.matching.map((v) => v.id)).toEqual([a.id, b.id]);
    expect(view.skills.map((s) => s.name)).toEqual([
      'ic',
      'claim',
      'readiness',
      'implement',
      'open-pr',
      'review-pr',
    ]);
  });

  test('改一个 skill 的一个字后不再自动绑定到它', () => {
    const file = 'skills/claim/SKILL.md';
    const original = variants.readFile(first, file);
    expect(original).toContain('take the ticket');
    variants.writeFile(first, file, original.replace('take the ticket', 'take the tickets'));
    // A 的 claim 不再一致：ic session 改绑到仍一致的 B；lfg session 没有加载 claim，仍绑定 A
    expect(binding(IC.sessionId)).toEqual({ variantId: second, binding: 'auto' });
    expect(binding(LFG.sessionId)).toEqual({ variantId: first, binding: 'auto' });
    variants.writeFile(
      second,
      file,
      variants.readFile(second, file).replace('take the ticket', 'take the tickets'),
    );
    expect(binding(IC.sessionId)).toEqual({ variantId: null, binding: null });
    expect(bindingView(db, dataDir, IC.sessionId).matching).toEqual([]);
    // 改回原文后重新自动绑定，取最早的 A
    variants.writeFile(first, file, original);
    expect(binding(IC.sessionId)).toEqual({ variantId: first, binding: 'auto' });
    // frontmatter 暂时不是合法的 YAML 时照常比较正文：session 中没有 frontmatter，仍然一致
    const broken = original.replace(/^description: (.*)$/m, 'description: $1 e2e-edit');
    expect(broken).not.toBe(original);
    variants.writeFile(first, file, broken);
    expect(binding(IC.sessionId)).toEqual({ variantId: first, binding: 'auto' });
    variants.writeFile(first, file, original);
  });

  test('手动改选、解除与恢复自动判定；手动的绑定不随 variant 变化', () => {
    setManualBinding(db, dataDir, IC.sessionId, { variantId: second });
    expect(binding(IC.sessionId)).toEqual({ variantId: second, binding: 'manual' });
    variants.writeFile(second, 'skills/claim/NOTE.md', 'x\n');
    expect(binding(IC.sessionId)).toEqual({ variantId: second, binding: 'manual' });
    setManualBinding(db, dataDir, IC.sessionId, { variantId: null });
    expect(binding(IC.sessionId)).toEqual({ variantId: null, binding: 'manual' });
    rebindAll(db, dataDir);
    expect(binding(IC.sessionId)).toEqual({ variantId: null, binding: 'manual' });
    setManualBinding(db, dataDir, IC.sessionId, 'auto');
    expect(binding(IC.sessionId)).toEqual({ variantId: first, binding: 'auto' });
    expect(() => {
      setManualBinding(db, dataDir, IC.sessionId, { variantId: 'missing' });
    }).toThrow('variant 不存在');
  });

  test('按 session 的 skill 新建 variant：SKILL.md 正文换成 session 中的，frontmatter 来自底子，并自动绑定', () => {
    const modified = modifiedIcSession(dir, 'read everything it points at', 'read all of it');
    ingestFile(db, modified.file);
    // claim 与任何 variant 都不一致
    expect(binding(modified.sessionId)).toEqual({ variantId: null, binding: null });
    const created = deriveFromSession(db, variants, dataDir, modified.sessionId, {
      baseVariantId: first,
      name: 'w31-来自 session',
    });
    expect(created).toMatchObject({
      parentId: first,
      status: 'draft',
      sourceSessionId: modified.sessionId,
    });
    const claim = variants.readFile(created.id, 'skills/claim/SKILL.md');
    const base = variants.readFile(first, 'skills/claim/SKILL.md');
    expect(claim).toBe(base.replace('read everything it points at', 'read all of it'));
    expect(matter(claim).data).toEqual(matter(base).data);
    // 只有 claim 的正文不同
    expect(variants.diff(created.id, 'parent').files.map((f) => f.path)).toEqual([
      'skills/claim/SKILL.md',
    ]);
    expect(binding(modified.sessionId)).toEqual({ variantId: created.id, binding: 'auto' });
    expect(bindingView(db, dataDir, modified.sessionId).matching.map((v) => v.id)).toEqual([
      created.id,
    ]);
  });

  test('run 的 session 绑定 run 所用的 variant，手动绑定被拒绝', () => {
    const runDir = path.join(dir, 'run-session');
    const file = unpackSession(runDir, LFG);
    const sessionId = '5f1d7a52-3b5c-4d2e-9a43-0f1d8a6b7c11';
    const runFile = path.join(path.dirname(file), `${sessionId}.jsonl`);
    fs.renameSync(file, runFile);
    fs.renameSync(
      path.join(path.dirname(file), LFG.sessionId),
      path.join(path.dirname(file), sessionId),
    );
    db.insert(batches).values({ id: 'b-20261012-w31aaa', repeats: 1 }).run();
    db.insert(runs)
      .values({
        id: 'r-20261012-w31aaa',
        batchId: 'b-20261012-w31aaa',
        taskId: 'lfg-calculator',
        variantId: second,
        repeatIndex: 0,
        status: 'succeeded',
        sessionId,
        workspacePath: runDir,
      })
      .run();
    ingestFile(db, runFile);
    // 与 A 一致也不改：绑定 run 所用的 B
    expect(binding(sessionId)).toEqual({ variantId: second, binding: 'run' });
    expect(() => {
      setManualBinding(db, dataDir, sessionId, { variantId: first });
    }).toThrow('属于 run 或交互');
  });

  test('本功能之前导入的 session 在启动时补提取 skill 正文', () => {
    const load = () =>
      db.select().from(sessionSkills).where(eq(sessionSkills.sessionId, IC.sessionId)).all();
    const before = load();
    db.delete(sessionSkills).where(eq(sessionSkills.sessionId, IC.sessionId)).run();
    db.delete(sessionSkillScans).where(eq(sessionSkillScans.sessionId, IC.sessionId)).run();
    expect(backfillSkillLoads(db)).toEqual([IC.sessionId]);
    const after = load();
    const strip = (rows: typeof before) =>
      rows.map((r) => [r.agentId, r.uuid, r.name, r.baseDir, r.text, r.args, r.timestamp]);
    expect(strip(after)).toEqual(strip(before));
    expect(backfillSkillLoads(db)).toEqual([]);
    // jsonl 已被删除的 session：没有可以提取的内容，记为已提取
    db.delete(sessionSkillScans).where(eq(sessionSkillScans.sessionId, LFG.sessionId)).run();
    fs.rmSync(lfgFile);
    expect(backfillSkillLoads(db)).toEqual([]);
    expect(
      db
        .select()
        .from(sessionSkillScans)
        .where(eq(sessionSkillScans.sessionId, LFG.sessionId))
        .get(),
    ).toEqual({ sessionId: LFG.sessionId });
  });
});
