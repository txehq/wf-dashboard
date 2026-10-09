import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { stageChecks } from '../../src/db/schema.js';
import { StageReport } from '../../src/stages/report.js';
import { openTestDb } from './db.js';
import { ingestSample, SAMPLES, type Sample, seqOfToolLine } from './samples.js';

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

async function analyze(id: string) {
  const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/analyze` });
  expect(res.statusCode).toBe(200);
  return StageReport.parse(res.json());
}

async function stages(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/stages` });
  expect(res.statusCode).toBe(200);
  return StageReport.parse(res.json());
}

const checkCount = (id: string) =>
  db.select({ n: count() }).from(stageChecks).where(eq(stageChecks.sessionId, id)).get()?.n;

const lastMainSeq = (s: Sample) => s.main[s.main.length - 1]?.seq;

// 端到端：ingest 导入真实样本 → POST analyze → GET stages
describe('端到端：导入真实样本后判定', () => {
  test('未知 session 的 analyze 与未判定 session 的 stages 返回 404', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/sessions/nope/analyze' });
    expect(unknown.statusCode).toBe(404);
    const s = ingestSample(db, SAMPLES.research);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}/stages` });
    expect(res.statusCode).toBe(404);
  });

  test('f0aca373：ic 边界与 Stage Markers 2.6 的 PR #72 一致，再次 analyze 不调用 Haiku', async () => {
    const s = ingestSample(db, SAMPLES.icPrs);
    const report = await analyze(s.sessionId);
    console.log('f0aca373 StageReport', JSON.stringify(report, null, 1));
    const ic = report.ic ?? [];
    expect(ic.map((v) => v.stage)).toEqual([
      'claim',
      'readiness',
      'implement',
      'acceptance',
      'open-pr',
      'fix-pr',
      'ready-for-review',
    ]);
    const openPr = seqOfToolLine(s, 5811);
    const fixPr = seqOfToolLine(s, 5883);
    const rfr = seqOfToolLine(s, 6153);
    const view = (stage: string) => ic.find((v) => v.stage === stage);
    expect(view('open-pr')).toMatchObject({ status: 'done', startSeq: openPr, endSeq: fixPr - 1 });
    expect(view('fix-pr')).toMatchObject({ status: 'done', startSeq: fixPr, endSeq: rfr - 1 });
    expect(view('ready-for-review')).toMatchObject({
      status: 'done',
      startSeq: rfr,
      endSeq: lastMainSeq(s),
    });
    // acceptance 在这些 PR 中没有运行，是长度为 0 的区间
    expect(view('acceptance')).toMatchObject({
      status: 'skipped',
      startSeq: openPr,
      endSeq: openPr - 1,
    });
    expect(ic.every((v) => v.method === 'llm')).toBe(true);
    // open-pr 阶段含 /review-pr 的子代理请求
    expect(view('open-pr')?.stats.toolCalls.Skill).toBeGreaterThanOrEqual(1);

    // /interview 以 <command-name> 启动（第 1390 行），session 中没有 wf obsidian 写入
    expect(report.lfg?.map((v) => v.status)).toEqual([
      'active',
      'not-reached',
      'not-reached',
      'not-reached',
    ]);

    expect(report.checks.count).toBe(checkCount(s.sessionId));
    expect(report.checks.costUsd).toBeGreaterThan(0);
    const calls = checkCount(s.sessionId);
    expect(await analyze(s.sessionId)).toEqual(report);
    expect(checkCount(s.sessionId)).toBe(calls);
    expect(await stages(s.sessionId)).toEqual(report);
  }, 600_000);

  test('9f4adf2d：调研 session 不含 lfg 与 ic，不调用 Haiku', async () => {
    const s = ingestSample(db, SAMPLES.research);
    const report = await analyze(s.sessionId);
    expect(report).toEqual({
      sessionId: s.sessionId,
      lfg: null,
      ic: null,
      checks: { count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(await stages(s.sessionId)).toEqual(report);
    const list = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}` });
    expect(list.json()).toMatchObject({ analyzed: true, workflows: [] });
  });

  test('d93c4511：lfg 停在 interview，子代理请求计入父调用所在阶段', async () => {
    const s = ingestSample(db, SAMPLES.interview);
    const report = await analyze(s.sessionId);
    expect(report.ic).toBeNull();
    expect(report.checks.count).toBe(0);
    const interview = report.lfg?.[0];
    const skillSeq = seqOfToolLine(s, 28);
    expect(interview).toMatchObject({
      stage: 'interview',
      status: 'active',
      startSeq: skillSeq,
      endSeq: lastMainSeq(s),
    });

    const inSpan = s.main.filter((r) => r.seq >= skillSeq);
    const agentIds = new Set(inSpan.flatMap((r) => r.toolCalls.map((c) => c.subagentId)));
    const subRows = s.subagent.filter((r) => agentIds.has(r.agentId));
    expect(subRows.length).toBeGreaterThan(0);
    const all = [...inSpan, ...subRows];
    expect(interview?.stats.requests).toBe(all.length);
    expect(interview?.stats.subagents).toBe(new Set(subRows.map((r) => r.agentId)).size);
    expect(interview?.stats.outputTokens).toBe(all.reduce((n, r) => n + r.outputTokens, 0));
    expect(interview?.stats.cacheReadTokens).toBe(all.reduce((n, r) => n + r.cacheReadTokens, 0));
    expect(interview?.stats.costUsd).toBeCloseTo(all.reduce((n, r) => n + r.costUsd, 0));
    expect(interview?.stats.durationMs).toBeGreaterThan(0);
  });
});
