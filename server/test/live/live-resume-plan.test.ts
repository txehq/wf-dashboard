import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { liveRoutes } from '../../src/api/live.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import {
  liveEvents,
  liveProcesses,
  liveSessions,
  sessions,
  subagents,
} from '../../src/db/schema.js';
import { initialParseState, ingestFile } from '../../src/ingest/ingest.js';
import { createLive } from '../../src/live/index.js';
import type { LiveDetail, ResumePlan } from '../../src/live/views.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';
import { sessionLines } from '../helpers/session-copies.js';

// resume 的预检与同步（Contracts 14.5）。session 用 fixture「请记住暗号」的副本（新的 session id）构造：
// 最新那份在一个来源目录中，目标配置（"本机配置"，HOME 在 .work/ 下）中另放一份较早的或分叉的。
// 基础档中 claude 是会报错的替身，进程立即退出；这里只看预检、文件与数据库
const work = path.join(config.repoRoot, '.work', 'test-resume-plan', randomUUID());
const home = path.join(work, 'home');
const projects = path.join(work, 'projects', '-w49');
const cwd = path.join(work, 'cwd');
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const settings = createSettingsStore(db);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const app = Fastify();
const live = createLive({
  db,
  variants,
  settings,
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: path.join(work, 'live'),
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: home,
  repos: testRepos(),
  codex: testCodex(),
});

beforeAll(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  await app.register(fastifyWebsocket);
  await app.register(liveRoutes, { live });
});

afterAll(async () => {
  await live.shutdown();
  await app.close();
  const dirs = variants.list().map((v) => variants.layout(v.id).dir);
  db.$client.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const lines = (sessionId: string, extra: string[] = []) => sessionLines(sessionId, cwd, extra);

// 一个已导入的 session：最新那份在来源目录中
function newSession(extra: string[] = ['还记得暗号吗？', '记得，青蛙-47。']) {
  const id = randomUUID();
  const file = path.join(projects, `${id}.jsonl`);
  fs.writeFileSync(file, lines(id, extra));
  ingestFile(db, file);
  return { id, file };
}

// 目标配置（本机配置）中的另一份
function targetCopy(id: string, content: string) {
  const file = path.join(home, '.claude', 'projects', `l-old-${id.slice(0, 6)}`, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const plan = async (sessionId: string, variantId = '') => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/live/resume-plan?sessionId=${sessionId}&variantId=${variantId}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ResumePlan>();
};
const resume = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/live/resume', payload: { driver: 'human', ...body } });

describe('目标配置中已有另一份', () => {
  test('没有时：预检为复制，resume 后复制进目标配置，导入的是目标中的那份', async () => {
    const { id, file } = newSession();
    expect(await plan(id)).toMatchObject({ action: 'copy', target: null, problems: [] });
    const response = await resume({ sessionId: id, variantId: null });
    expect(response.statusCode).toBe(201);
    const detail = response.json<LiveDetail>();
    const copied = path.join(home, '.claude', 'projects', detail.id, `${id}.jsonl`);
    expect(fs.readFileSync(copied, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
    expect(detail.events.find((e) => e.kind === 'resume')?.payload.copiedFrom).toBe(file);
    expect(db.select().from(sessions).where(eq(sessions.id, id)).get()?.filePath).toBe(copied);
  });

  test('目标中是最新那份的前一段：预检为同步，resume 时用最新的覆盖并记下覆盖了哪一份', async () => {
    const { id, file } = newSession();
    const older = targetCopy(id, lines(id));
    const p = await plan(id);
    expect(p).toMatchObject({ action: 'sync', problems: [] });
    expect(p.latest).toMatchObject({
      path: file,
      lastRole: 'assistant',
      lastText: '记得，青蛙-47。',
    });
    expect(p.target).toMatchObject({ path: older, lastText: '记住了' });
    const response = await resume({ sessionId: id, variantId: null });
    expect(response.statusCode).toBe(201);
    const detail = response.json<LiveDetail>();
    expect(fs.readFileSync(older, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
    const payload = detail.events.find((e) => e.kind === 'resume')?.payload;
    expect(payload).toMatchObject({ syncedFrom: file, overwrote: older, copiedFrom: null });
    // claude 在目标中的那份所在的目录中接着写同一个 session id
    expect(payload?.argv).toEqual(expect.arrayContaining(['--resume', id]));
    expect(payload?.jsonl).toBe(older);
    expect(db.select().from(sessions).where(eq(sessions.id, id)).get()?.filePath).toBe(older);
  });

  test('目标中的那份已是最新的（逐字节相同）：直接接着运行', async () => {
    const { id, file } = newSession();
    targetCopy(id, fs.readFileSync(file, 'utf8'));
    expect((await plan(id)).action).toBe('resume');
  });

  test('两份分叉：不 resume，返回两份的摘要；以最新的为准继续后旧份改名保留', async () => {
    const { id, file } = newSession();
    const other = targetCopy(id, lines(id, ['换个话题：今天几号？', '今天是 10 月 13 日。']));
    const p = await plan(id);
    expect(p.action).toBe('diverged');
    expect(p.latest).toMatchObject({ path: file, lastText: '记得，青蛙-47。' });
    expect(p.target).toMatchObject({ path: other, lastText: '今天是 10 月 13 日。' });
    expect(p.target?.lastAt).toBe('2026-10-13T09:01:00.000Z');

    const refused = await resume({ sessionId: id, variantId: null });
    expect(refused.statusCode).toBe(409);
    expect(db.select().from(liveSessions).where(eq(liveSessions.claudeSessionId, id)).get()).toBe(
      undefined,
    );
    expect(fs.readFileSync(other, 'utf8')).toContain('今天几号');

    const kept = fs.readFileSync(other, 'utf8');
    const response = await resume({ sessionId: id, variantId: null, onDiverged: 'use-latest' });
    expect(response.statusCode).toBe(201);
    const payload = response.json<LiveDetail>().events.find((e) => e.kind === 'resume')?.payload;
    const divergedKept = String(payload?.divergedKept);
    expect(divergedKept).toMatch(new RegExp(`${id}\\.jsonl\\.diverged-\\d{8}T\\d{6}Z$`, 'u'));
    expect(fs.readFileSync(divergedKept, 'utf8')).toBe(kept);
    expect(fs.readFileSync(other, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  });

  test('子代理目录以最新的为准：最新中有的覆盖过去，目标中多出的保留', async () => {
    const { id, file } = newSession();
    const older = targetCopy(id, lines(id));
    const fromDir = path.join(path.dirname(file), id, 'subagents');
    const toDir = path.join(path.dirname(older), id, 'subagents');
    fs.mkdirSync(fromDir, { recursive: true });
    fs.mkdirSync(toDir, { recursive: true });
    fs.writeFileSync(path.join(fromDir, 'agent-a.jsonl'), 'new\n');
    fs.writeFileSync(path.join(toDir, 'agent-a.jsonl'), 'old\n');
    fs.writeFileSync(path.join(toDir, 'agent-only-target.jsonl'), 'keep\n');
    expect((await resume({ sessionId: id, variantId: null })).statusCode).toBe(201);
    expect(fs.readFileSync(path.join(toDir, 'agent-a.jsonl'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(toDir, 'agent-only-target.jsonl'), 'utf8')).toBe('keep\n');
  });
});

describe('其他不能 resume 的情况：预检写明原因，resume 以同样的原文 409，不建项、不改文件', () => {
  const blocked = async (sessionId: string, code: string, text: string, variantId = '') => {
    const p = await plan(sessionId, variantId);
    expect(p.action).toBe('blocked');
    expect(p.problems.map((x) => x.code)).toContain(code);
    expect(p.problems.find((x) => x.code === code)?.message).toContain(text);
    const response = await resume({ sessionId, variantId: variantId === '' ? null : variantId });
    expect(response.statusCode).toBe(409);
    return p;
  };

  test('工作目录不在了', async () => {
    const { id } = newSession();
    db.update(sessions)
      .set({ cwd: path.join(work, 'gone') })
      .where(eq(sessions.id, id))
      .run();
    await blocked(id, 'cwd-missing', '已经不在了');
  });

  test('没有记录工作目录', async () => {
    const { id } = newSession();
    db.update(sessions).set({ cwd: null }).where(eq(sessions.id, id)).run();
    await blocked(id, 'no-cwd', '没有记录工作目录');
  });

  test('session 文件被移走', async () => {
    const { id, file } = newSession();
    fs.renameSync(file, `${file}.moved`);
    await blocked(id, 'file-missing', '已经不在了');
  });

  test('同一项有运行中的进程', async () => {
    const { id } = newSession();
    const liveId = `l-20261013-${randomUUID().slice(0, 6)}`;
    db.insert(liveSessions)
      .values({
        id: liveId,
        claudeSessionId: id,
        title: '运行中的项',
        environment: 'real',
        cwd,
        updatedAt: new Date(),
      })
      .run();
    db.insert(liveProcesses)
      .values({ liveId, kind: 'resume', driver: 'human', startedAt: new Date() })
      .run();
    await blocked(id, 'running', '「运行中的项」');
  });

  test('variant 没有构建成功；选了 variant 时返回设置中的默认 model 与 effort，本机配置时为空', async () => {
    const { id } = newSession();
    const variant = await variants.createBaseline({ name: `未构建 ${randomUUID().slice(0, 6)}` });
    const p = await blocked(id, 'variant-not-built', '还没有按当前内容构建成功', variant.id);
    expect(p).toMatchObject({ variantId: variant.id, model: 'opus', effort: 'high' });
    settings.set({ ...settings.get(), agentModel: 'sonnet', agentEffort: 'low' });
    expect(await plan(id, variant.id)).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(await plan(id)).toMatchObject({ variantId: null, model: null, effort: null });
  });

  test('有子代理但记录目录不在：照常 resume，说明之前子代理的明细不会带进目标配置', async () => {
    const { id } = newSession();
    db.insert(subagents)
      .values({
        sessionId: id,
        agentId: 'a1',
        filePath: path.join(projects, id, 'subagents', 'agent-a1.jsonl'),
        parentToolUseId: 'toolu_1',
        agentType: 'general-purpose',
        parseState: initialParseState(),
      })
      .run();
    const p = await plan(id);
    expect(p.action).toBe('copy');
    expect(p.notes.join('\n')).toContain('子代理的记录目录');
  });
});

test('同一项上的 resume 不报原始的"已从…导入"', async () => {
  const { id } = newSession();
  const older = targetCopy(id, lines(id));
  const response = await resume({ sessionId: id, variantId: null });
  expect(response.body).not.toContain('已从');
  expect(response.statusCode).toBe(201);
  expect(
    db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.liveId, response.json<LiveDetail>().id))
      .all()
      .some((e) => e.payload.overwrote === older),
  ).toBe(true);
});
