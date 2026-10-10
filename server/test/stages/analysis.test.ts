import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { AnalysisState, StageReport, startAnalysis } from '../../src/stages/report.js';
import { watchAnalysis } from './analysis-events.js';
import { insertSession, openTestDb } from './db.js';
import { ingestSample, mainRowsInLines, SAMPLES } from './samples.js';

const { db, close } = openTestDb();
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
  close();
});

const prs = ingestSample(db, SAMPLES.icPrs);

// f0aca373 中 PR #72 一轮的片段（open-pr、fix-pr、ready-for-review），作为一个独立 session
function composeSession(): string {
  const id = randomUUID();
  insertSession(db, id, mainRowsInLines(prs, 5700, 6160), prs.cwd);
  return id;
}

async function state(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/analysis` });
  expect(res.statusCode).toBe(200);
  return AnalysisState.parse(res.json());
}

async function post(id: string) {
  const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/analyze` });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('离线判定的进度（Contracts 第 9 节，真实模型）', () => {
  test('未知 session 的 analysis 返回 404；未判定的为 idle', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/sessions/nope/analysis' });
    expect(unknown.statusCode).toBe(404);
    expect(await state(composeSession())).toEqual({ status: 'idle', progress: null, error: null });
  });

  test('POST analyze 立即返回进度，后台逐批推送 stage.progress，完成后推送 stage.analyzed', async () => {
    const id = composeSession();
    const watch = watchAnalysis(id);
    const started = await post(id);
    expect(started).toMatchObject({
      status: 'running',
      progress: { workflow: 'ic', batchesDone: 0, costUsd: 0 },
    });
    const total = (started.progress as { batchesTotal: number }).batchesTotal;
    expect(total).toBeGreaterThan(1);

    // 判定进行中：重复请求返回当前进度，analysis 为 running
    expect(await post(id)).toMatchObject({ status: 'running', progress: { batchesTotal: total } });
    expect(await state(id)).toMatchObject({ status: 'running', error: null });

    await watch.done;
    const done = [...new Set(watch.progress.map((p) => p.batchesDone))];
    console.log('进度事件', JSON.stringify(watch.progress.map((p) => [p.batchesDone, p.costUsd])));
    expect(done.length).toBeGreaterThanOrEqual(2);
    expect(done[done.length - 1]).toBe(total);
    // batchesDone 与花费都只增不减
    for (const [i, p] of watch.progress.entries()) {
      const prev = watch.progress[i - 1];
      if (prev === undefined) continue;
      expect(p.batchesDone).toBeGreaterThanOrEqual(prev.batchesDone);
      expect(p.costUsd).toBeGreaterThanOrEqual(prev.costUsd);
    }

    expect(await state(id)).toEqual({ status: 'done', progress: null, error: null });
    const report = StageReport.parse(await post(id));
    expect(report.ic[0]?.label).toBe('PR #72');
    const last = watch.progress[watch.progress.length - 1];
    expect(last?.costUsd).toBeCloseTo(report.checks.costUsd, 9);
  }, 300_000);

  test('判定失败时推送 stage.failed，analysis 保留错误原文直到下一次判定', async () => {
    const id = composeSession();
    const watch = watchAnalysis(id);
    // gateway 上不存在的模型名：第一次模型调用即失败
    expect(startAnalysis(db, id, 'claude-no-such-model')).toMatchObject({ status: 'running' });
    await expect(watch.done).rejects.toThrow();
    const failed = await state(id);
    console.log('失败原文', failed.error);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('claude-no-such-model');
  }, 120_000);
});
