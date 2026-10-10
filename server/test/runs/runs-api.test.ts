import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { batches, runs, variants } from '../../src/db/schema.js';
import { models, setModels } from '../../src/llm/client.js';
import { newId, RUN_ID } from '../../src/runs/index.js';
import { RunSummary } from '../../src/runs/views.js';
import { createSettingsStore, defaultSettings } from '../../src/runs/settings.js';
import { syncTasks } from '../../src/tasks/loader.js';

const work = path.join(config.repoRoot, '.work', 'test-runs', randomUUID());
fs.mkdirSync(work, { recursive: true });
const dbFile = path.join(work, 'db.sqlite');
const db = openDatabase(dbFile, config.migrationsDir);
syncTasks(db, config.tasksDir);

const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `runs-test-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261009-before', repeats: 1 }).run();
// 服务重启前停在各个状态的 run
const before = {
  preparing: 'r-20261009-prep01',
  running: 'r-20261009-runn01',
  grading: 'r-20261009-grad01',
  succeeded: 'r-20261009-succ01',
} as const;
for (const [i, [status, id]] of Object.entries(before).entries()) {
  db.insert(runs)
    .values({
      id,
      batchId: 'b-20261009-before',
      taskId: 'lfg-calculator',
      variantId,
      repeatIndex: i,
      status: status as keyof typeof before,
      sessionId: randomUUID(),
      workspacePath: path.join(work, id),
      startedAt: new Date(Date.now() - 60_000),
    })
    .run();
}

const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('run id', () => {
  test('r-<yyyymmdd>-<6 位小写字母数字>，本身是 slug', () => {
    const id = newId('r', new Date('2026-10-09T12:00:00Z'));
    expect(id).toMatch(RUN_ID);
    expect(id.startsWith('r-20261009-')).toBe(true);
  });
});

describe('服务重启时的状态修正', () => {
  test('preparing / running / grading 改为 failed，其余不变', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/runs?batch=b-20261009-before' });
    expect(response.statusCode).toBe(200);
    const list = response.json<{ id: string; status: string; error: string | null }[]>();
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const id of [before.preparing, before.running, before.grading]) {
      expect(byId.get(id)).toMatchObject({ status: 'failed', error: '服务重启中断' });
    }
    expect(byId.get(before.succeeded)).toMatchObject({ status: 'succeeded', error: null });
  });

  test('run 详情：没有 session 时 stages 为 null，成本四项为 0', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/runs/${before.running}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: before.running,
      taskKind: 'lfg',
      mode: 'simulated',
      pending: null,
      stages: null,
      messages: [],
      costs: { agent: 0, simulatedUser: 0, stageCheck: 0, grading: 0, total: 0 },
    });
  });

  test('不在运行中的 run 不能接管、回答或取消', async () => {
    for (const action of ['takeover', 'release', 'finish', 'cancel']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/runs/${before.running}/${action}`,
      });
      expect(response.statusCode, action).toBe(409);
    }
    const reply = await app.inject({
      method: 'POST',
      url: `/api/runs/${before.running}/reply`,
      payload: { text: '你好' },
    });
    expect(reply.statusCode).toBe(409);
    const missing = await app.inject({ method: 'GET', url: '/api/runs/r-20261009-nonexi' });
    expect(missing.statusCode).toBe(404);
  });
});

// Contracts 7.12
describe('把 run 标为无效', () => {
  const post = (id: string, action: string, payload?: object) =>
    app.inject({
      method: 'POST',
      url: `/api/runs/${id}/${action}`,
      ...(payload === undefined ? {} : { payload }),
    });
  const reasonOf = async (id: string) =>
    RunSummary.parse((await app.inject({ method: 'GET', url: `/api/runs/${id}` })).json())
      .invalidReason;

  test('终态的 run：写入原因，详情与列表返回它，status 不变；恢复后清空', async () => {
    expect(await reasonOf(before.succeeded)).toBeNull();
    const marked = await post(before.succeeded, 'invalidate', {
      reason: '  Codex 配置未带进 variant  ',
    });
    expect(marked.statusCode).toBe(200);
    expect(await reasonOf(before.succeeded)).toBe('Codex 配置未带进 variant');
    const list = RunSummary.array().parse(
      (await app.inject({ method: 'GET', url: '/api/runs?batch=b-20261009-before' })).json(),
    );
    expect(list.find((r) => r.id === before.succeeded)).toMatchObject({
      status: 'succeeded',
      invalidReason: 'Codex 配置未带进 variant',
    });
    expect((await post(before.succeeded, 'revalidate')).statusCode).toBe(200);
    expect(await reasonOf(before.succeeded)).toBeNull();
  });

  test('原因为空 400；排队中的 run 409；不存在的 run 404', async () => {
    expect((await post(before.succeeded, 'invalidate', { reason: '  ' })).statusCode).toBe(400);
    expect((await post(before.succeeded, 'invalidate', {})).statusCode).toBe(400);
    const queued = 'r-20261010-queue1';
    db.insert(runs)
      .values({
        id: queued,
        batchId: 'b-20261009-before',
        taskId: 'lfg-calculator',
        variantId,
        repeatIndex: 9,
        status: 'queued',
        sessionId: randomUUID(),
        workspacePath: path.join(work, queued),
      })
      .run();
    expect((await post(queued, 'invalidate', { reason: '环境出错' })).statusCode).toBe(409);
    expect((await post(queued, 'revalidate')).statusCode).toBe(409);
    expect((await post('r-20261009-nonexi', 'invalidate', { reason: 'x' })).statusCode).toBe(404);
  });
});

describe('POST /api/batches', () => {
  test('variant 没有构建成功时 400，不建 batch、不冻结', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { variantIds: [variantId], taskIds: ['lfg-calculator'], repeats: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('还没有按当前内容构建成功');
    expect(db.select().from(batches).all()).toHaveLength(1);
    expect(db.select().from(variants).where(eq(variants.id, variantId)).get()?.status).toBe(
      'draft',
    );
  });

  test('请求体校验：空集合与多余字段 400，未知 variant 404', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { variantIds: [], taskIds: ['lfg-calculator'] },
    });
    expect(empty.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { variantIds: [variantId], taskIds: ['lfg-calculator'], extra: 1 },
    });
    expect(extra.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { variantIds: [randomUUID()], taskIds: ['lfg-calculator'] },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('GET / PUT /api/settings', () => {
  test('默认值取 settings env 的模型别名；保存到数据库，模型立即生效', async () => {
    const defaults = defaultSettings();
    const initial = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(initial.json()).toEqual(defaults);
    expect(defaults.models.stageCheck).not.toMatch(/\[/);
    const next = {
      runConcurrency: 1,
      maxUserTurns: 40,
      defaultRepeats: 2,
      models: { ...defaults.models, stageCheck: defaults.models.simulatedUser },
    };
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: next });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(next);
    expect(models.stageCheck).toBe(defaults.models.simulatedUser);
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json()).toEqual(next);
    // 重新打开（服务重启）读回数据库中的设置
    expect(createSettingsStore(db).get()).toEqual(next);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...next, runConcurrency: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    const emptyModel = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...next, models: { ...next.models, judge: ' ' } },
    });
    expect(emptyModel.statusCode).toBe(400);
    setModels(defaults.models);
  });
});
