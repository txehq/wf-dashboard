import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runRoutes } from '../../src/api/runs.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { batches, type RunStatus, runs, variants } from '../../src/db/schema.js';
import { type AppEvent, events } from '../../src/events.js';
import { createRuns, RUN_ID } from '../../src/runs/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { BatchDetail, RunSummary } from '../../src/runs/views.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { testRepos } from '../helpers/local-repos.js';

const work = path.join(config.repoRoot, '.work', 'test-rerun', randomUUID());
fs.mkdirSync(work, { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const runsDir = path.join(work, 'runs');

const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `rerun-test-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    workflowId: 'dev-workflow',
    status: 'frozen',
  })
  .run();
const batchId = 'b-20261010-rerun1';
db.insert(batches).values({ id: batchId, repeats: 3 }).run();

function insert(id: string, taskId: string, repeatIndex: number, status: RunStatus) {
  db.insert(runs)
    .values({
      id,
      batchId,
      taskId,
      variantId,
      repeatIndex,
      model: 'opus',
      effort: 'high',
      status,
      error: status === 'failed' ? 'claude 进程意外退出' : null,
      sessionId: randomUUID(),
      workspacePath: path.join(runsDir, id, 'workspace'),
    })
    .run();
}

// lfg-calculator 的三次重复（失败、取消、成功），ic-money-format 一次
insert('r-20261010-lfg000', 'lfg-calculator', 0, 'failed');
insert('r-20261010-lfg001', 'lfg-calculator', 1, 'cancelled');
insert('r-20261010-lfg002', 'lfg-calculator', 2, 'succeeded');
insert('r-20261010-ic0000', 'ic-money-format', 0, 'failed');

const settings = createSettingsStore(db);
const runsModule = createRuns({
  db,
  variants: createVariants({
    db,
    dataDir: work,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
  }),
  settings,
  vaultDir: path.join(work, 'vault'),
  product: config.evalProduct,
  runsDir,
  repos: testRepos(),
});
// 队列停止取出：重跑建出的 run 停在 queued，测试不启动真实的 claude 与外部对象
await runsModule.shutdown();

// 非终态的 run 在队列停止后再写入，避免启动时被改为 failed
const live = {
  queued: 'r-20261010-queue0',
  preparing: 'r-20261010-prep00',
  running: 'r-20261010-runn00',
  grading: 'r-20261010-grad00',
} as const;
for (const [i, [status, id]] of Object.entries(live).entries()) {
  insert(id, 'ic-money-format', 10 + i, status as RunStatus);
}

const app = Fastify({ logger: false });
await app.register(runRoutes, { runs: runsModule, settings });

const published: AppEvent[] = [];
const unsubscribe = events.subscribe((event) => {
  published.push(event);
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  unsubscribe();
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const rerun = (id: string) => app.inject({ method: 'POST', url: `/api/runs/${id}/rerun` });

describe('POST /api/runs/:id/rerun', () => {
  test('同一 batch、同一 task × variant 新建 run，repeat_index 取最大值加一，进入队列；原 run 不变', async () => {
    const original = db.select().from(runs).where(eq(runs.id, 'r-20261010-lfg000')).get();
    const response = await rerun('r-20261010-lfg000');
    expect(response.statusCode).toBe(201);
    const created = RunSummary.parse(response.json());
    expect(created.id).toMatch(RUN_ID);
    expect(created).toMatchObject({
      batchId,
      taskId: 'lfg-calculator',
      variantId,
      repeatIndex: 3,
      model: 'opus',
      effort: 'high',
      status: 'queued',
      humanIntervened: false,
      invalidReason: null,
      grading: { status: 'none', error: null },
      error: null,
      startedAt: null,
    });
    const row = db.select().from(runs).where(eq(runs.id, created.id)).get();
    expect(row?.sessionId).not.toBe(original?.sessionId);
    expect(row?.workspacePath).toBe(path.join(runsDir, created.id, 'workspace'));
    expect(db.select().from(runs).where(eq(runs.id, 'r-20261010-lfg000')).get()).toEqual(original);
    expect(published).toContainEqual({ type: 'run.status', runId: created.id, status: 'queued' });

    // 再次重跑（取消的、成功的 run）继续递增；另一个 task 按自己的最大值递增
    const fromCancelled = RunSummary.parse((await rerun('r-20261010-lfg001')).json());
    expect(fromCancelled.repeatIndex).toBe(4);
    const fromSucceeded = RunSummary.parse((await rerun('r-20261010-lfg002')).json());
    expect(fromSucceeded.repeatIndex).toBe(5);
    const ic = RunSummary.parse((await rerun('r-20261010-ic0000')).json());
    expect(ic).toMatchObject({ taskId: 'ic-money-format', repeatIndex: 14, status: 'queued' });

    // 新 run 在同一个 batch 里，按创建顺序排在队列中已有的 run 之后
    const batch = BatchDetail.parse(
      (await app.inject({ method: 'GET', url: `/api/batches/${batchId}` })).json(),
    );
    expect(batch.runs).toBe(12);
    expect(batch.statusCounts.queued).toBe(5);
    const queued = RunSummary.array()
      .parse((await app.inject({ method: 'GET', url: '/api/runs?status=queued' })).json())
      .sort((a, b) => a.createdAt - b.createdAt);
    expect(queued.map((r) => r.id).slice(-4)).toEqual([
      created.id,
      fromCancelled.id,
      fromSucceeded.id,
      ic.id,
    ]);
  });

  test('非终态的 run 返回 409，不建新 run；不存在的 run 返回 404', async () => {
    const before = db.select().from(runs).all().length;
    for (const [status, id] of Object.entries(live)) {
      const response = await rerun(id);
      expect(response.statusCode, status).toBe(409);
      expect(response.json<{ message: string }>().message).toContain('不能重跑');
    }
    expect((await rerun('r-20261010-nonexi')).statusCode).toBe(404);
    expect(db.select().from(runs).all()).toHaveLength(before);
  });

  test('标为无效的 run 可以重跑，原 run 的无效原因保持', async () => {
    db.update(runs)
      .set({ invalidReason: 'Codex 配置未带进 variant' })
      .where(eq(runs.id, 'r-20261010-lfg002'))
      .run();
    const created = RunSummary.parse((await rerun('r-20261010-lfg002')).json());
    expect(created).toMatchObject({ repeatIndex: 6, invalidReason: null, status: 'queued' });
    expect(
      db.select().from(runs).where(eq(runs.id, 'r-20261010-lfg002')).get()?.invalidReason,
    ).toBe('Codex 配置未带进 variant');
  });
});
