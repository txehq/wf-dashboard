import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { liveRoutes } from '../../src/api/live.js';
import { sessionsRoutes } from '../../src/api/sessions.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { liveEvents, liveProcesses, liveSessions, sessions } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { createLive } from '../../src/live/index.js';
import type { LiveDetail, LiveSummary } from '../../src/live/views.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';

// 交互项的关闭、恢复显示与删除（Contracts 14.5）：只操作数据库与 data/live/<liveId>/，不调用 claude
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = Fastify();
const fixtureSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const projects = path.join(config.dataDir, 'home-projects', 'w39-hide');

beforeAll(async () => {
  fs.mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${fixtureSession}.jsonl`);
  fs.copyFileSync(
    path.join(import.meta.dirname, '../fixtures/live', `${fixtureSession}.jsonl`),
    file,
  );
  ingestFile(db, file);
  await app.register(fastifyWebsocket);
  const live = createLive({
    db,
    variants: createVariants({
      db,
      dataDir: config.dataDir,
      repo: config.txeWorkflowRepo,
      ctxBin: config.ctxBin,
    }),
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
  });
  await app.register(liveRoutes, { live });
  await app.register(sessionsRoutes, {
    prefix: '/api',
    db,
    dirs: { projectsDir: projects, variantsDir: path.join(config.dataDir, 'variants') },
  });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

const call = async (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  return { status: response.statusCode, body: response.body };
};

const listIds = async (includeHidden: boolean) =>
  (
    JSON.parse(
      (await call('GET', `/api/live?includeHidden=${String(includeHidden)}`)).body,
    ) as LiveSummary[]
  ).map((l) => l.id);

const kinds = async (id: string) =>
  (JSON.parse((await call('GET', `/api/live/${id}`)).body) as LiveDetail).events.map((e) => e.kind);

const sessionRow = async () =>
  (
    JSON.parse((await call('GET', `/api/sessions?q=${fixtureSession}`)).body) as {
      sessions: { id: string; liveId: string | null; liveHidden: boolean }[];
    }
  ).sessions.find((s) => s.id === fixtureSession);

test('关闭、显示已关闭的项、恢复显示；导入已关闭项的 session 即恢复显示；运行中 409；删除要输入名字', async () => {
  const imported = await call('POST', '/api/live/import', { sessionIds: [fixtureSession] });
  expect(imported.status).toBe(201);
  const [item] = JSON.parse(imported.body) as LiveSummary[];
  if (item === undefined) throw new Error('没有导入');
  const id = item.id;

  // 关闭：列表中不再出现，打开"显示已关闭的项"时出现
  const hidden = await call('POST', `/api/live/${id}/hide`);
  expect(hidden.status).toBe(200);
  expect((JSON.parse(hidden.body) as LiveDetail).hiddenAt).not.toBeNull();
  expect(await listIds(false)).not.toContain(id);
  expect(await listIds(true)).toContain(id);
  expect(await sessionRow()).toMatchObject({ liveId: id, liveHidden: true });

  // 恢复显示
  expect((await call('POST', `/api/live/${id}/unhide`)).status).toBe(200);
  expect(await listIds(false)).toContain(id);
  expect(await sessionRow()).toMatchObject({ liveId: id, liveHidden: false });

  // 已关闭项的 session 再导入：用原来那一项并恢复显示，不建新项
  await call('POST', `/api/live/${id}/hide`);
  const again = await call('POST', '/api/live/import', { sessionIds: [fixtureSession] });
  expect(again.status).toBe(201);
  expect((JSON.parse(again.body) as LiveSummary[]).map((l) => l.id)).toEqual([id]);
  expect(await listIds(false)).toContain(id);
  expect(await kinds(id)).toEqual(['import', 'hide', 'unhide', 'hide', 'unhide']);
  // 已显示的项再导入仍是 409
  expect((await call('POST', '/api/live/import', { sessionIds: [fixtureSession] })).status).toBe(
    409,
  );

  // 有运行中的进程：关闭与删除都 409
  const [proc] = db
    .insert(liveProcesses)
    .values({ liveId: id, kind: 'resume', driver: 'human', startedAt: new Date() })
    .returning({ id: liveProcesses.id })
    .all();
  if (proc === undefined) throw new Error('没有写入进程');
  const busyHide = await call('POST', `/api/live/${id}/hide`);
  expect(busyHide.status).toBe(409);
  expect(busyHide.body).toContain('先结束进程再关闭');
  const busyDelete = await call('DELETE', `/api/live/${id}`, { confirmTitle: item.title });
  expect(busyDelete.status).toBe(409);
  expect(busyDelete.body).toContain('先结束进程再删除');
  db.update(liveProcesses)
    .set({ status: 'exited', exitCode: 0, endedAt: new Date() })
    .where(eq(liveProcesses.id, proc.id))
    .run();

  // 名字不对 400，什么都不删
  const dir = path.join(config.liveDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pty.log'), 'output');
  const wrong = await call('DELETE', `/api/live/${id}`, { confirmTitle: `${item.title}x` });
  expect(wrong.status).toBe(400);
  expect(await listIds(false)).toContain(id);

  // 名字正确：项、进程、事件与 data/live/<liveId>/ 都删掉；Sessions 的记录仍在，live_id 为空
  const removed = await call('DELETE', `/api/live/${id}`, { confirmTitle: item.title });
  expect(removed.status).toBe(200);
  expect(await listIds(true)).not.toContain(id);
  expect(db.select().from(liveSessions).where(eq(liveSessions.id, id)).all()).toEqual([]);
  expect(db.select().from(liveProcesses).where(eq(liveProcesses.liveId, id)).all()).toEqual([]);
  expect(db.select().from(liveEvents).where(eq(liveEvents.liveId, id)).all()).toEqual([]);
  expect(fs.existsSync(dir)).toBe(false);
  expect(
    db.select().from(sessions).where(eq(sessions.id, fixtureSession)).get()?.liveId,
  ).toBeNull();
  expect(fs.existsSync(path.join(projects, `${fixtureSession}.jsonl`))).toBe(true);
  expect((await call('GET', `/api/live/${id}`)).status).toBe(404);
});
