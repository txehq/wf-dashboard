import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, runs, variants } from '../../src/db/schema.js';
import { type AppEvent, events } from '../../src/events.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { watchAcceptanceReport } from '../../src/runs/acceptance-report.js';
import { COST_REFRESH_MS } from '../../src/runs/cost-refresh.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// W19 的 ic run r-20261010-t5x8pr 的真实 session：/ic 整个是一轮，验收报告 3lpww2so 在轮中发布。
// 先导入发布之前的部分，再导入其余部分；不经过轮结束，链接在 session.updated 的节流间隔内写入
const sessionId = 'f40729f0-3944-40a8-b106-52d6a9b602d6';
const fixture = path.join(import.meta.dirname, '../fixtures/runs', `${sessionId}.jsonl.gz`);
const work = path.join(config.repoRoot, '.work', 'test-acceptance-live', randomUUID());
const REPORT = 'https://engapp.dev/artifacts/page/3lpww2so';
const runId = 'r-20261010-acclve';
const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `acceptance-live-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261010-acclve', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261010-acclve',
    taskId: 'ic-unit-converter',
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

const acceptance = () =>
  db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'acceptance')))
    .get();

describe('watchAcceptanceReport', () => {
  test(
    '轮中发布的验收报告在 session.updated 的节流间隔内写入 artifacts 并推送 run.artifact',
    async () => {
      const lines = gunzipSync(fs.readFileSync(fixture)).toString('utf8').split('\n');
      const published = lines.findIndex((l) => l.includes(REPORT));
      expect(published).toBeGreaterThan(0);
      const file = path.join(work, `${sessionId}.jsonl`);
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(file, `${lines.slice(0, published).join('\n')}\n`);
      const pushed: AppEvent[] = [];
      const unsubscribe = events.subscribe((e) => {
        if (e.type === 'run.artifact') pushed.push(e);
      });
      const errors: Error[] = [];
      const stop = watchAcceptanceReport(db, runId, sessionId, (error) => errors.push(error));

      // 第一次 session.updated 立即扫描：报告尚未发布
      ingestFile(db, file);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(acceptance()).toBeUndefined();

      fs.writeFileSync(file, lines.join('\n'));
      ingestFile(db, file);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // 距上次扫描不足节流间隔：还没有扫描
      expect(acceptance()).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, COST_REFRESH_MS));
      const row = acceptance();
      expect(row?.location).toBe(REPORT);
      expect(JSON.parse(row?.snapshot ?? 'null')).toMatchObject({
        title: 'TXE-3875 单位换算页面 - acceptance',
      });
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        type: 'run.artifact',
        runId,
        artifact: { kind: 'acceptance', location: REPORT },
      });
      expect(errors).toEqual([]);
      stop();
      unsubscribe();
    },
    COST_REFRESH_MS + 30_000,
  );
});
