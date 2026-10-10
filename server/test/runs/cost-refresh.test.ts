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
import { COST_REFRESH_MS, watchRunCost } from '../../src/runs/cost-refresh.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// 真实 session 分两次导入：第一次立即刷新成本缓存，30 秒内的第二次等满 30 秒再刷新
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
    model: 'opus',
    effort: 'high',
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
  test(
    'session 有新请求写入时刷新 runs.cost_usd，同一 run 最多每 30 秒一次，并推送 run.cost',
    async () => {
      const lines = fs.readFileSync(fixture, 'utf8').split('\n');
      const file = path.join(work, `${sessionId}.jsonl`);
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(file, `${lines.slice(0, 40).join('\n')}\n`);
      const published: AppEvent[] = [];
      const unsubscribe = events.subscribe((e) => {
        if (e.type === 'run.cost') published.push(e);
      });
      const errors: Error[] = [];
      const stop = watchRunCost(db, runId, sessionId, (error) => errors.push(error));

      ingestFile(db, file);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const first = runCostBreakdown(db, runId).total;
      expect(first).toBeGreaterThan(0);
      expect(cached()).toBe(first);

      fs.writeFileSync(file, lines.join('\n'));
      ingestFile(db, file);
      const full = runCostBreakdown(db, runId).total;
      expect(full).toBeGreaterThan(first);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // 距上次刷新不足 30 秒：还没有刷新
      expect(cached()).toBe(first);
      await new Promise((resolve) => setTimeout(resolve, COST_REFRESH_MS));
      expect(cached()).toBe(full);
      expect(published).toEqual([
        { type: 'run.cost', runId, costUsd: first },
        { type: 'run.cost', runId, costUsd: full },
      ]);
      expect(errors).toEqual([]);
      stop();
      unsubscribe();
    },
    COST_REFRESH_MS + 20_000,
  );
});
