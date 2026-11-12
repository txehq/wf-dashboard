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

// A real session imported in two parts: the first refreshes the cost cache at once, the second within the interval waits for the full interval.
// The runner's interval is COST_REFRESH_MS (30 s); here the same implementation uses a short interval, judged by event times without waiting 30 s
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
  test('the runner interval is 30 s', () => {
    expect(COST_REFRESH_MS).toBe(30_000);
  });

  test(
    'new session requests refresh runs.cost_usd at most once per interval per run and publish run.cost',
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
      // The first refresh happens at once (work runs in the next microtask)
      await new Promise((resolve) => setImmediate(resolve));
      const first = runCostBreakdown(db, runId).total;
      expect(first).toBeGreaterThan(0);
      expect(cached()).toBe(first);
      const firstAt = published[0]?.at ?? 0;

      fs.writeFileSync(file, lines.join('\n'));
      ingestFile(db, file);
      const full = runCostBreakdown(db, runId).total;
      expect(full).toBeGreaterThan(first);
      // Within the interval since the last refresh: not refreshed yet; refreshed and published when the interval is up
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
    'the interval counts from the end of the last call: writes during a call wait a full interval after it ends',
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
      // Another write while the first call is running
      await new Promise((resolve) => setTimeout(resolve, WORK_MS / 2));
      events.publish({ type: 'session.updated', sessionId: id });
      await twoCalls;
      const [first, second] = calls;
      if (first === undefined || second === undefined) throw new Error('Expected two calls');
      expect(second.start - first.end).toBeGreaterThanOrEqual(INTERVAL_MS);
      expect(errors).toEqual([]);
      stop();
    },
    INTERVAL_MS + 20_000,
  );
});
