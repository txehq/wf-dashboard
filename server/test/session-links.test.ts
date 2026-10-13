import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { artifacts, liveEvents, liveSessions, sessions } from '../src/db/schema.js';
import { initialParseState } from '../src/ingest/ingest.js';
import { syncTasks } from '../src/tasks/loader.js';
import { insertRun, insertVariant } from './grading/seed.js';
import { openLog } from './setup/basic-tier.js';

// Session 详情的"绑定的对象"（Contracts 18.2）与"在访达中打开"session 的工作目录（16.7 的 session-cwd）。
// 基础档 PATH 中的 open 只记下参数（test/setup/basic-bin/open），不真的打开访达
const work = path.join(config.repoRoot, '.work', 'test-session-links', randomUUID());
fs.mkdirSync(work, { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});

const runId = `r-w43-${randomUUID().slice(0, 6)}`;
const feature = `/vault/Project Magi Eval/Features/${runId}`;
let runSession = '';
const bare = randomUUID();
const isolated = randomUUID();
const liveId = `l-20261013-${randomUUID().slice(0, 6)}`;
const cwd = path.join(work, 'cwd');

function insertSession(id: string, values: { cwd?: string | null; liveId?: string | null }) {
  const at = new Date('2026-10-13T08:00:00Z');
  db.insert(sessions)
    .values({
      id,
      filePath: `/sessions/${id}.jsonl`,
      startedAt: at,
      endedAt: at,
      parseState: initialParseState(),
      ...values,
    })
    .run();
}

beforeAll(async () => {
  insertVariant(db, `v-${runId}`, 'ic');
  runSession = insertRun(db, { id: runId, taskId: 'ic-money-format', variantId: `v-${runId}` });
  const repo = `https://github.com/txehq/wfe-${runId}`;
  for (const [kind, location] of [
    ['repo', repo],
    ['pr', `${repo}/pull/1`],
    ['ticket', 'https://linear.app/capso/issue/TXE-3767/eval-ic-money-format'],
    ['brief', `${feature}/Brief.md`],
    ['research', `${feature}/Research.md`],
    // plan 与 research 是同一份文档：只列一次
    ['plan', `${feature}/Research.md`],
    // 不是绑定的对象
    ['friction', 'https://github.com/txehq/txe-workflow/issues/12'],
    ['acceptance', 'https://engapp.dev/r/abc'],
    ['pr_snapshot', repo],
  ] as const) {
    db.insert(artifacts).values({ runId, kind, location }).run();
  }
  insertSession(bare, { cwd: path.join(work, 'missing') });
  // isolated 交互项：start 事件中有副本仓库与工单副本
  db.insert(liveSessions)
    .values({
      id: liveId,
      claudeSessionId: isolated,
      title: 'isolated',
      environment: 'isolated',
      cwd,
      updatedAt: new Date(),
    })
    .run();
  db.insert(liveEvents)
    .values({
      liveId,
      processId: null,
      at: new Date(),
      kind: 'start',
      payload: {
        repo: `txehq/wfe-${liveId}`,
        repoUrl: `https://github.com/txehq/wfe-${liveId}`,
        ticket: 'TXE-3900',
        ticketUrl: 'https://linear.app/capso/issue/TXE-3900/copy',
      },
    })
    .run();
  fs.mkdirSync(cwd);
  insertSession(isolated, { cwd, liveId });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const bindings = async (id: string) => {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}/bindings` });
  return { status: response.statusCode, body: response.json<unknown>() };
};

test('有 run 的 session：仓库、PR、工单与 vault 文档；没有绑定的 session 三项都为空；不存在 404', async () => {
  expect(await bindings(runSession)).toEqual({
    status: 200,
    body: {
      github: [
        { label: `txehq/wfe-${runId}`, url: `https://github.com/txehq/wfe-${runId}` },
        { label: `txehq/wfe-${runId}#1`, url: `https://github.com/txehq/wfe-${runId}/pull/1` },
      ],
      linear: [
        { label: 'TXE-3767', url: 'https://linear.app/capso/issue/TXE-3767/eval-ic-money-format' },
      ],
      obsidian: [
        { label: 'Brief.md', path: `${feature}/Brief.md` },
        { label: 'Research.md', path: `${feature}/Research.md` },
      ],
    },
  });
  expect(await bindings(bare)).toEqual({
    status: 200,
    body: { github: [], linear: [], obsidian: [] },
  });
  expect((await bindings('no-such-session')).status).toBe(404);
});

test('isolated 交互项的 session：副本仓库与工单副本', async () => {
  expect(await bindings(isolated)).toEqual({
    status: 200,
    body: {
      github: [{ label: `txehq/wfe-${liveId}`, url: `https://github.com/txehq/wfe-${liveId}` }],
      linear: [{ label: 'TXE-3900', url: 'https://linear.app/capso/issue/TXE-3900/copy' }],
      obsidian: [],
    },
  });
});

test('在访达中打开 session 的工作目录：只接受已知 session，目录不存在时 404 原文', async () => {
  const open = (id: string) =>
    app.inject({
      method: 'POST',
      url: '/api/open',
      payload: { target: { kind: 'session-cwd', id } },
    });
  const opened = await open(isolated);
  expect(opened.statusCode).toBe(200);
  expect(opened.json()).toEqual({ dir: cwd });
  expect(fs.readFileSync(openLog, 'utf8').split('\n')).toContain(cwd);
  const missing = await open(bare);
  expect(missing.statusCode).toBe(404);
  expect(missing.json<{ message: string }>().message).toBe(
    `目录不存在：${path.join(work, 'missing')}`,
  );
  const unknown = await open('no-such-session');
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json<{ message: string }>().message).toBe('session 不存在：no-such-session');
  expect(fs.readFileSync(openLog, 'utf8')).not.toContain(path.join(work, 'missing'));
});
