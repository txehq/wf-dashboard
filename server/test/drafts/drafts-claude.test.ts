import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sum } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';

// 真实档（Contracts 22.2）：唯一一次真实调用 Claude Code 的设计会话。在草稿目录中启动交互的 claude（node-pty，
// sandbox 只允许写草稿目录与 npm 缓存，配置目录为草稿自己的 claude-config/），提示只有一句
// "在 src/skills/hello-flow/SKILL.md 末尾加一行 ok"，等文件出现这一行后结束进程；记录耗时与花费。
// 草稿目录由 drafts.open 建，src/ 是从空白开始的骨架（不装 skill，不跑完整的生成）
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { requests } = await import('../../src/db/schema.js');
const { createDrafts } = await import('../../src/drafts/index.js');
const { copyDraftSource, draftLayout, writeDraftDocs } = await import('../../src/drafts/dir.js');
const { ingestFile } = await import('../../src/ingest/ingest.js');
const { createLive } = await import('../../src/live/index.js');
const { createSettingsStore } = await import('../../src/runs/settings.js');
const { createVariants } = await import('../../src/variants/index.js');
const { writeSkeleton } = await import('../../src/variants/skills.js');
const { parseDefinition } = await import('../../src/workflows/index.js');
const { testCodex } = await import('../helpers/codex.js');
const { testRepos } = await import('../helpers/local-repos.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: config.liveDir,
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(config.dataDir, 'home'),
  repos: testRepos(),
  codex: testCodex(),
  claudeBin: config.claudeBin,
  autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
});
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  dataDir: config.dataDir,
  skillSources: config.codexSkillSources,
});
const created: string[] = [];

afterAll(async () => {
  await live.shutdown();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('Claude Code 的设计会话（真实 Claude Code，一次）', { timeout: 600_000 }, () => {
  test('在草稿目录中启动交互的 claude，按一句提示写一行，然后结束', async () => {
    const workflowId = 'hello-flow';
    const { draft } = drafts.open({
      mode: 'workflow',
      engine: 'claude',
      workflowId,
      name: '你好流程',
      description: '',
      requirement: '测试',
    });
    created.push(draft.dir);
    const layout = draftLayout(draft.dir, 'workflow');
    const definition = parseDefinition(
      { id: workflowId, name: '你好流程', stages: [{ id: 'gather' }] },
      'W59 真实档',
    );
    await copyDraftSource(layout, (dest) => {
      writeSkeleton(path.join(dest, 'skills'), definition);
      return Promise.resolve();
    });
    writeDraftDocs(layout, 'workflow', definition, 'claude');
    const file = path.join(draft.dir, 'src/skills/hello-flow/SKILL.md');
    const before = fs.readFileSync(file, 'utf8');
    const started = Date.now();
    const item = live.createDraftItem({
      cwd: draft.dir,
      prompt: '在 src/skills/hello-flow/SKILL.md 末尾加一行 ok',
      title: 'W59 真实 Claude Code',
      workflow: null,
      purpose: 'design',
      engine: 'claude',
    });
    const detail = await live.startDraft(item.id);
    expect(detail.engine).toBe('claude');
    expect(detail.status).toBe('running');
    let lines: string[] = [];
    while (Date.now() - started < 300_000) {
      lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      if (lines.at(-1)?.trim() === 'ok') break;
      await sleep(1000);
    }
    const seconds = (Date.now() - started) / 1000;
    expect(lines.at(-1)?.trim()).toBe('ok');
    expect(fs.readFileSync(file, 'utf8').startsWith(before.trimEnd())).toBe(true);
    // 等这一轮写完 jsonl 再结束
    await sleep(5000);
    const stopped = await live.stop(detail.id);
    expect(stopped.status).toBe('exited');
    // 会话记录在草稿自己的配置目录中，不在用户的 ~/.claude
    const sessionId = detail.claudeSessionId ?? '';
    const jsonl = path.join(draft.dir, 'claude-config/projects', item.id, `${sessionId}.jsonl`);
    expect(fs.existsSync(jsonl)).toBe(true);
    ingestFile(db, jsonl);
    const cost = db
      .select({ usd: sum(requests.costUsd) })
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .get();
    expect(Number(cost?.usd ?? 0)).toBeGreaterThan(0);
    // 耗时与花费写进 .work/，报告引用（通过的用例的 console 输出不显示）
    const result = path.join(config.repoRoot, '.work', 'real-results', 'w59-claude.json');
    fs.mkdirSync(path.dirname(result), { recursive: true });
    fs.writeFileSync(
      result,
      `${JSON.stringify({ seconds, costUsd: Number(cost?.usd ?? 0), sessionId }, null, 2)}\n`,
    );
  });
});
