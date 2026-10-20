import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionActionRoutes } from '../src/api/session-actions.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { liveProcesses, liveSessions, requests, sessions } from '../src/db/schema.js';
import { createSessionActions } from '../src/deletion/sessions.js';
import type { SessionActionPlan } from '../src/deletion/session-views.js';
import { ingestCodexFile } from '../src/ingest/codex.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { createLive } from '../src/live/index.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { createVariants } from '../src/variants/index.js';
import { realCodexBin, testCodex } from './helpers/codex.js';
import { testRepos } from './helpers/local-repos.js';
import { sessionLines } from './helpers/session-copies.js';

// Contracts 25.3、25.5：Sessions 页面的删除、归档与恢复。Codex 的用真实的 codex archive、unarchive、delete（不调用模型），
// 只在这个测试自己建的 CODEX_HOME 中，rollout 是真实样本的副本；Claude Code 的删除只删测试自己建的配置目录中的文件
const work = path.join(config.repoRoot, '.work', 'test-session-actions', randomUUID());
const codexHome = path.join(work, 'codex-home');
const claudeDir = path.join(work, 'claude');
const cwd = path.join(work, 'cwd');
fs.mkdirSync(cwd, { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
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
  liveDir: path.join(work, 'live'),
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(work, 'home'),
  repos: testRepos(),
  codex: testCodex(),
  claudeBin: config.claudeBin,
  autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
});
const app = Fastify();
await app.register(fastifyWebsocket);
await app.register(sessionActionRoutes, {
  actions: createSessionActions({ db, live, codexBin: realCodexBin() }),
});

afterAll(async () => {
  await live.shutdown();
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const codexFixture = fs.readFileSync(
  path.join(
    import.meta.dirname,
    'fixtures/codex-rollouts/rollout-2026-10-04T20-22-00-01a106dd-2ba7-7e71-8490-0e170a634111.jsonl',
  ),
  'utf8',
);

// 真实样本换成新的 session id，复制进 <CODEX_HOME>/sessions/2026/10/04/ 并导入
function codexSession() {
  const id = randomUUID();
  const [meta = '', ...rest] = codexFixture.split('\n');
  const first = JSON.parse(meta) as { payload: { id: string; session_id: string; cwd: string } };
  first.payload.id = id;
  first.payload.session_id = id;
  first.payload.cwd = cwd;
  const file = path.join(
    codexHome,
    'sessions/2026/10/04',
    `rollout-2026-10-04T20-22-00-${id}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify(first), ...rest].join('\n'));
  ingestCodexFile(db, file);
  return { id, file };
}

// Claude Code 的 session 在一个配置目录中：主 jsonl、同名目录、file-history/<id> 与 session-env/<id>
function claudeSession() {
  const id = randomUUID();
  const file = path.join(claudeDir, 'projects', '-cwd', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sessionLines(id, cwd, ['还记得暗号吗？', '记得，青蛙-47。']));
  const extra = [
    path.join(claudeDir, 'projects', '-cwd', id, 'tool-results'),
    path.join(claudeDir, 'file-history', id),
    path.join(claudeDir, 'session-env', id),
  ];
  for (const dir of extra) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x'), 'x');
  }
  ingestFile(db, file);
  return {
    id,
    file,
    files: [
      file,
      path.join(claudeDir, 'projects', '-cwd', id),
      path.join(claudeDir, 'file-history', id),
      path.join(claudeDir, 'session-env', id),
    ],
  };
}

// 属于这个 session 的 Live 项
function liveItem(sessionId: string, engine: 'claude' | 'codex', running = false) {
  const id = `l-20261014-${randomUUID().slice(0, 6)}`;
  db.insert(liveSessions)
    .values({
      id,
      claudeSessionId: sessionId,
      engine,
      title: `项 ${id}`,
      environment: 'real',
      cwd,
      updatedAt: new Date(),
    })
    .run();
  if (running)
    db.insert(liveProcesses)
      .values({ liveId: id, kind: 'resume', driver: 'human', startedAt: new Date() })
      .run();
  db.update(sessions).set({ liveId: id }).where(eq(sessions.id, sessionId)).run();
  return id;
}

const plan = async (action: string, ids: string[]) => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/action-plan?action=${action}&ids=${ids.join(',')}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SessionActionPlan>();
};
const act = (action: string, ids: string[]) =>
  app.inject({ method: 'POST', url: `/api/sessions/${action}`, payload: { ids } });
const row = (id: string) => db.select().from(sessions).where(eq(sessions.id, id)).get();

describe('Codex', { timeout: 60_000 }, () => {
  test('归档：codex archive 把 rollout 移进 archived_sessions，记为已归档；恢复：codex unarchive 移回', async () => {
    const { id, file } = codexSession();
    expect(await plan('archive', [id])).toMatchObject({
      action: 'archive',
      sessions: [{ id, engine: 'codex', files: [file] }],
      liveItems: [],
      blockers: [],
    });
    const archived = path.join(codexHome, 'archived_sessions', path.basename(file));
    const response = await act('archive', [id]);
    expect(response.statusCode, response.body).toBe(200);
    expect([fs.existsSync(file), fs.existsSync(archived)]).toEqual([false, true]);
    expect(row(id)).toMatchObject({ filePath: archived, archivedAt: expect.any(Date) as Date });
    // 再次归档与恢复的拒绝
    expect((await plan('archive', [id])).blockers.map((b) => b.label)).toEqual([
      expect.stringContaining('已经归档') as string,
    ]);
    expect((await act('archive', [id])).statusCode).toBe(409);

    const restored = await act('unarchive', [id]);
    expect(restored.statusCode, restored.body).toBe(200);
    expect([fs.existsSync(file), fs.existsSync(archived)]).toEqual([true, false]);
    expect(row(id)).toMatchObject({ filePath: file, archivedAt: null });
    expect((await plan('unarchive', [id])).blockers.map((b) => b.label)).toEqual([
      expect.stringContaining('没有归档') as string,
    ]);
    // 移动后的 rollout 照常增量导入
    expect(ingestCodexFile(db, file).changed).toBe(false);
  });

  test('删除：codex delete 删除 rollout，dashboard 中的记录与属于它的 Live 项一起删除', async () => {
    const { id, file } = codexSession();
    const item = liveItem(id, 'codex');
    expect(await plan('delete', [id])).toMatchObject({
      sessions: [{ id, files: [file] }],
      liveItems: [{ id: item }],
      blockers: [],
    });
    const response = await act('delete', [id]);
    expect(response.statusCode, response.body).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
    expect(row(id)).toBeUndefined();
    expect(db.select().from(requests).where(eq(requests.sessionId, id)).all()).toEqual([]);
    expect(db.select().from(liveSessions).where(eq(liveSessions.id, item)).get()).toBeUndefined();
  });

  test('codex 的命令失败时 500 原文，这个 session 的记录不变，之前已完成的保留', async () => {
    const done = codexSession();
    const failing = codexSession();
    // rollout 已经不在：codex delete 找不到这个会话
    fs.rmSync(failing.file);
    const response = await act('delete', [done.id, failing.id]);
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain(`codex delete --force ${failing.id} 失败（退出码 1）`);
    expect(response.body).toContain('failed to delete session');
    expect(row(done.id)).toBeUndefined();
    expect(row(failing.id)?.filePath).toBe(failing.file);
  });
});

describe('Claude Code', () => {
  test('删除：主 jsonl、同名目录、file-history 与 session-env 一起永久删除', async () => {
    const s = claudeSession();
    const p = await plan('delete', [s.id]);
    expect(p.sessions).toEqual([
      { id: s.id, title: expect.any(String) as string, engine: 'claude', files: s.files },
    ]);
    const response = await act('delete', [s.id]);
    expect(response.statusCode, response.body).toBe(200);
    expect(s.files.filter((f) => fs.existsSync(f))).toEqual([]);
    expect(row(s.id)).toBeUndefined();
    expect(db.select().from(requests).where(eq(requests.sessionId, s.id)).all()).toEqual([]);
  });

  test('没有归档；run 的 session 与有运行中进程的不能删除，原文说明，什么都不改', async () => {
    const plain = claudeSession();
    expect((await plan('archive', [plain.id])).blockers).toEqual([
      {
        sessionId: plain.id,
        label: expect.stringContaining('Claude Code 没有单个 session 的归档，只能删除') as string,
      },
    ]);
    const ofRun = claudeSession();
    db.update(sessions).set({ variantBinding: 'run' }).where(eq(sessions.id, ofRun.id)).run();
    const busy = claudeSession();
    liveItem(busy.id, 'claude', true);
    const p = await plan('delete', [plain.id, ofRun.id, busy.id]);
    expect(p.blockers.map((b) => [b.sessionId, b.label])).toEqual([
      [ofRun.id, expect.stringContaining('run 的 session 随 run 保留，不能删除或归档')],
      [busy.id, expect.stringContaining('有运行中的进程用到这个 session，先结束进程')],
    ]);
    // ids 放在请求体中（POST）的内容与 GET 相同
    const posted = await app.inject({
      method: 'POST',
      url: '/api/sessions/action-plan',
      payload: { action: 'delete', ids: [plain.id, ofRun.id, busy.id] },
    });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json<SessionActionPlan>()).toEqual(p);
    const response = await act('delete', [plain.id, ofRun.id, busy.id]);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain('不能删除');
    for (const s of [plain, ofRun, busy]) {
      expect(row(s.id)).toBeDefined();
      expect(s.files.every((f) => fs.existsSync(f))).toBe(true);
    }
  });

  test('清除（Contracts 25.1）：有运行中进程的、run 的也可以清除；dashboard 中的记录、Live 项与磁盘上的文件都保留', async () => {
    const busy = claudeSession();
    liveItem(busy.id, 'claude', true);
    const ofRun = claudeSession();
    db.update(sessions).set({ variantBinding: 'run' }).where(eq(sessions.id, ofRun.id)).run();
    const idle = claudeSession();
    const item = liveItem(idle.id, 'claude');
    const all = [busy, ofRun, idle];
    const ids = all.map((s) => s.id);
    expect((await plan('clear', ids)).blockers).toEqual([]);
    const response = await act('clear', ids);
    expect(response.statusCode, response.body).toBe(200);
    for (const s of all) {
      expect(row(s.id)).toBeDefined();
      expect(db.select().from(requests).where(eq(requests.sessionId, s.id)).all()).not.toEqual([]);
      expect(s.files.every((f) => fs.existsSync(f))).toBe(true);
    }
    expect(db.select().from(liveSessions).where(eq(liveSessions.id, item)).get()).toBeDefined();
    // 交互区的 resume 照常：默认值与预检读的都是保留的记录
    expect(live.resumeDefaults(idle.id)).toMatchObject({
      engine: 'claude',
      cwd,
      liveId: item,
      running: false,
    });
    expect(live.resumePlan(idle.id, null)).toMatchObject({ sessionId: idle.id, problems: [] });
  });

  test('不存在的 session 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/action-plan?action=delete&ids=nope',
    });
    expect(response.statusCode).toBe(404);
  });
});
