import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { liveRoutes } from '../../src/api/live.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { liveProcesses, sessions } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { createLive } from '../../src/live/index.js';
import type { LiveDetail, LiveSummary, ResumeDefaults } from '../../src/live/views.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';

// 导入到交互区（Contracts 14.5）：只建项、不启动进程，不调用 claude
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = Fastify();
const fixtureSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';

beforeAll(async () => {
  const projects = path.join(config.dataDir, 'home-projects', 'w34-import');
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
  });
  await app.register(liveRoutes, { live });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
});

const call = async (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  return { status: response.statusCode, body: response.body };
};

test('导入一个本机 session：左侧多一项，没有进程，状态未运行，记 import 事件', async () => {
  const before = JSON.parse((await call('GET', '/api/live')).body) as LiveSummary[];
  const imported = await call('POST', '/api/live/import', { sessionIds: [fixtureSession] });
  expect(imported.status).toBe(201);
  const [item] = JSON.parse(imported.body) as LiveSummary[];
  if (item === undefined) throw new Error('没有导入');
  expect(item).toMatchObject({
    claudeSessionId: fixtureSession,
    title: '请记住暗号：青蛙-47。只回答：记住了',
    environment: 'real',
    workflow: null,
    status: 'idle',
    process: null,
    resumeCount: 0,
    variantId: null,
  });
  const after = JSON.parse((await call('GET', '/api/live')).body) as LiveSummary[];
  expect(after).toHaveLength(before.length + 1);
  expect(db.select().from(liveProcesses).where(eq(liveProcesses.liveId, item.id)).all()).toEqual(
    [],
  );
  const detail = JSON.parse((await call('GET', `/api/live/${item.id}`)).body) as LiveDetail;
  expect(detail.processes).toEqual([]);
  expect(detail.waiting).toBeNull();
  expect(detail.events.map((e) => [e.kind, e.processId, e.payload.sessionId])).toEqual([
    ['import', null, fixtureSession],
  ]);
  expect(db.select().from(sessions).where(eq(sessions.id, fixtureSession)).get()?.liveId).toBe(
    item.id,
  );
  // resume 对话框：这个 session 已属于这一项，不在运行
  const defaults = JSON.parse(
    (await call('GET', `/api/live/resume-defaults?sessionId=${fixtureSession}`)).body,
  ) as ResumeDefaults;
  expect(defaults).toMatchObject({ liveId: item.id, running: false });
  // 还没有进程：没有 pty.log
  expect(fs.existsSync(path.join(config.liveDir, item.id, 'pty.log'))).toBe(false);
});

test('重复导入 409 并列出；session 不存在 404；都不建项', async () => {
  const list = async () => JSON.parse((await call('GET', '/api/live')).body) as LiveSummary[];
  const before = (await list()).length;
  const again = await call('POST', '/api/live/import', { sessionIds: [fixtureSession] });
  expect(again.status).toBe(409);
  expect(again.body).toContain(`这些 session 已在交互区：${fixtureSession}`);
  const missing = await call('POST', '/api/live/import', {
    sessionIds: ['00000000-0000-4000-8000-000000000000'],
  });
  expect(missing.status).toBe(404);
  expect(missing.body).toContain('session 不存在：00000000-0000-4000-8000-000000000000');
  const empty = await call('POST', '/api/live/import', { sessionIds: [] });
  expect(empty.status).toBe(400);
  expect(await list()).toHaveLength(before);
});
