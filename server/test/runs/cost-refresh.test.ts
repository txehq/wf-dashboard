import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { runCostBreakdown } from '../../src/cost.js';
import { batches, runs, variants } from '../../src/db/schema.js';
import { type AppEvent, events } from '../../src/events.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { COST_REFRESH_MS, onSessionUpdates, watchRunCost } from '../../src/runs/cost-refresh.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// 真实 session 分两次导入：第一次立即刷新成本缓存，间隔内的第二次等满间隔再刷新。
// runner 的间隔是 COST_REFRESH_MS（30 秒）；这里用同一个实现的短间隔，按推送事件的时间判定，不等满 30 秒
const INTERVAL_MS = 2_000;
const sessionId = '40f6915a-cd31-4312-866c-dcb377515c42';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl`);
const work = path.join(config.repoRoot, '.work', 'test-cost-refresh', randomUUID());
const runId = 'r-20261010-costrf';
const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `cost-refresh-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    workflowId: 'lfg',
  })
  .run();
db.insert(batches).values({ id: 'b-20261010-costrf', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261010-costrf',
    taskId: 'lfg-calculator',
    variantId,
    repeatIndex: 0,
    model: 'opus',
    effort: 'high',
    status: 'running',
    sessionId,
    workspacePath: path.join(work, 'workspace'),
  })
  .run();

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

const cached = () => db.select().from(runs).where(eq(runs.id, runId)).get()?.costUsd;

describe('watchRunCost', () => {
  test('runner 用的间隔是 30 秒', () => {
    expect(COST_REFRESH_MS).toBe(30_000);
  });

  test(
    'session 有新请求写入时刷新 runs.cost_usd，同一 run 最多每个间隔一次，并推送 run.cost',
    async () => {
      const lines = fs.readFileSync(fixture, 'utf8').split('\n');
      const file = path.join(work, `${sessionId}.jsonl`);
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(file, `${lines.slice(0, 40).join('\n')}\n`);
      const published: { event: AppEvent; at: number }[] = [];
      let second: () => void = () => undefined;
      const secondPublished = new Promise<void>((resolve) => {
        second = resolve;
      });
      const unsubscribe = events.subscribe((e) => {
        if (e.type !== 'run.cost') return;
        published.push({ event: e, at: Date.now() });
        if (published.length === 2) second();
      });
      const errors: Error[] = [];
      const stop = watchRunCost(db, runId, sessionId, (error) => errors.push(error), INTERVAL_MS);

      ingestFile(db, file);
      // 第一次刷新立即进行（work 在下一个微任务中调用）
      await new Promise((resolve) => setImmediate(resolve));
      const first = runCostBreakdown(db, runId).total;
      expect(first).toBeGreaterThan(0);
      expect(cached()).toBe(first);
      const firstAt = published[0]?.at ?? 0;

      fs.writeFileSync(file, lines.join('\n'));
      ingestFile(db, file);
      const full = runCostBreakdown(db, runId).total;
      expect(full).toBeGreaterThan(first);
      // 距上次刷新不足间隔：还没有刷新；满间隔时刷新并推送
      expect(cached()).toBe(first);
      await secondPublished;
      expect((published[1]?.at ?? 0) - firstAt).toBeGreaterThanOrEqual(INTERVAL_MS);
      expect(cached()).toBe(full);
      expect(published.map((p) => p.event)).toEqual([
        { type: 'run.cost', runId, costUsd: first },
        { type: 'run.cost', runId, costUsd: full },
      ]);
      expect(errors).toEqual([]);
      stop();
      unsubscribe();
    },
    INTERVAL_MS + 20_000,
  );
});

describe('onSessionUpdates', () => {
  test(
    '间隔从上次调用结束时算起：调用期间的写入等上次结束后满间隔再调用',
    async () => {
      const id = randomUUID();
      const WORK_MS = 500;
      const calls: { start: number; end: number }[] = [];
      let done: () => void = () => undefined;
      const twoCalls = new Promise<void>((resolve) => {
        done = resolve;
      });
      const errors: Error[] = [];
      const stop = onSessionUpdates(
        id,
        async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, WORK_MS));
          calls.push({ start, end: Date.now() });
          if (calls.length === 2) done();
        },
        (error) => errors.push(error),
        INTERVAL_MS,
      );
      events.publish({ type: 'session.updated', sessionId: id });
      // 第一次调用进行中又有写入
      await new Promise((resolve) => setTimeout(resolve, WORK_MS / 2));
      events.publish({ type: 'session.updated', sessionId: id });
      await twoCalls;
      const [first, second] = calls;
      if (first === undefined || second === undefined) throw new Error('没有两次调用');
      expect(second.start - first.end).toBeGreaterThanOrEqual(INTERVAL_MS);
      expect(errors).toEqual([]);
      stop();
    },
    INTERVAL_MS + 20_000,
  );
});
