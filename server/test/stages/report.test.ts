import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { stageAnalyses, stageChecks } from '../../src/db/schema.js';
import { analyzeSession, StageReport } from '../../src/stages/report.js';
import { openTestDb } from './db.js';
import { ingestSample, SAMPLES, type Sample, seqOfToolLine, TEST_STAGE_MODEL } from './samples.js';

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

const checks = (id: string) =>
  db.select().from(stageChecks).where(eq(stageChecks.sessionId, id)).all();

const checkCount = (id: string) =>
  db.select({ n: count() }).from(stageChecks).where(eq(stageChecks.sessionId, id)).get()?.n;

const lastMainSeq = (s: Sample) => s.main[s.main.length - 1]?.seq;

// 一组主 session 请求加上其中 Agent 调用对应的子代理请求
function withSubagents(s: Sample, main: Sample['main']) {
  const ids = new Set(main.flatMap((r) => r.toolCalls.map((c) => c.subagentId)));
  return [...main, ...s.subagent.filter((r) => ids.has(r.agentId))];
}

// 端到端：ingest 导入真实样本 → POST analyze → GET stages
describe('端到端：导入真实样本后判定', () => {
  test('未知 session 的 analyze 与未判定 session 的 stages 返回 404', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/sessions/nope/analyze' });
    expect(unknown.statusCode).toBe(404);
    const s = ingestSample(db, SAMPLES.research);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}/stages` });
    expect(res.statusCode).toBe(404);
  });

  test('f0aca373：三轮 ic（PR #72、#77、#78），边界与 Stage Markers 2.6 一致', async () => {
    const s = ingestSample(db, SAMPLES.icPrs);
    // 判定用测试模型；之后的 analyze 路由直接返回已有结果
    const report = StageReport.parse(await analyzeSession(db, s.sessionId, TEST_STAGE_MODEL));
    const cost = checks(s.sessionId);
    console.log(
      'f0aca373 判定',
      JSON.stringify({
        model: TEST_STAGE_MODEL,
        calls: cost.length,
        byQuestion: Object.fromEntries(
          ['enter', 'outside'].map((q) => [q, cost.filter((c) => c.nextStage === q).length]),
        ),
        inputTokens: report.checks.inputTokens,
        outputTokens: report.checks.outputTokens,
        costUsd: report.checks.costUsd,
      }),
    );
    console.log(
      'f0aca373 ic',
      JSON.stringify(
        report.ic.map((c) => ({
          label: c.label,
          startSeq: c.startSeq,
          endSeq: c.endSeq,
          stages: c.stages.map((v) => [v.stage, v.status, v.startSeq, v.endSeq, v.stats.requests]),
        })),
      ),
    );
    console.log('f0aca373 outside', JSON.stringify(report.outside));

    // 每轮 open-pr、fix-pr、ready-for-review 的起点（jsonl 行号，Stage Markers 2.6）。
    // rfr 第一项是 gh pr ready 那一条；PR #77 中 Sonnet 也会把 ready-for-review 判在第 9100 行（停掉 watcher 并查看 PR 状态）
    const expected = [
      { label: 'PR #72', openPr: 5811, fixPr: 5883, rfr: [6153] },
      { label: 'PR #77', openPr: 8397, fixPr: 8430, rfr: [9121, 9100] },
      { label: 'PR #78', openPr: 12802, fixPr: 12921, rfr: [13678] },
    ];
    expect(report.ic.map((c) => [c.index, c.label])).toEqual(
      expected.map((e, i) => [i + 1, e.label]),
    );
    for (const [i, e] of expected.entries()) {
      const cycle = report.ic[i];
      if (cycle === undefined) throw new Error(`缺少第 ${String(i + 1)} 轮`);
      const view = (stage: string) => cycle.stages.find((v) => v.stage === stage);
      const openPr = seqOfToolLine(s, e.openPr);
      const fixPr = seqOfToolLine(s, e.fixPr);
      const [prReadyLine] = e.rfr;
      if (prReadyLine === undefined) throw new Error('缺少 gh pr ready 的行号');
      const prReady = seqOfToolLine(s, prReadyLine);
      const ready = view('ready-for-review');
      const rfr = ready?.startSeq ?? -1;
      expect(e.rfr.map((line) => seqOfToolLine(s, line))).toContain(rfr);
      expect(cycle.stages.map((v) => v.stage)).toEqual([
        'claim',
        'readiness',
        'implement',
        'acceptance',
        'open-pr',
        'fix-pr',
        'ready-for-review',
      ]);
      expect(view('open-pr')).toMatchObject({
        status: 'done',
        startSeq: openPr,
        endSeq: fixPr - 1,
      });
      expect(view('fix-pr')).toMatchObject({ status: 'done', startSeq: fixPr, endSeq: rfr - 1 });
      // ready-for-review 在 gh pr ready 之后不久结束，这一轮随之结束
      expect(ready).toMatchObject({ status: 'done', startSeq: rfr });
      expect(ready?.endSeq).toBe(cycle.endSeq);
      expect(cycle.endSeq).not.toBeNull();
      expect((cycle.endSeq ?? 0) - prReady).toBeLessThanOrEqual(5);
      // 这些 PR 没有认领工单，claim 不含任何请求；acceptance 没有运行
      expect(view('claim')).toMatchObject({ status: 'skipped', stats: { requests: 0 } });
      expect(view('acceptance')).toMatchObject({ status: 'skipped', stats: { requests: 0 } });
      expect(cycle.stages.every((v) => v.method === 'llm')).toBe(true);
      // 轮次之间不重叠
      const next = report.ic[i + 1];
      if (next !== undefined) expect(cycle.endSeq ?? 0).toBeLessThan(next.startSeq);
    }
    // open-pr 阶段含 /review-pr 的 Skill 调用
    expect(report.ic[0]?.stages[4]?.stats.toolCalls.Skill).toBeGreaterThanOrEqual(1);

    // /interview 以 <command-name> 启动（第 1390 行），session 中没有 wf obsidian 写入：一轮 lfg 停在 interview
    expect(report.lfg).toHaveLength(1);
    expect(report.lfg[0]?.stages.map((v) => v.status)).toEqual([
      'active',
      'not-reached',
      'not-reached',
      'not-reached',
    ]);
    expect(report.lfg[0]?.endSeq).toBeNull();
    // 流程外：/interview 之前的请求
    const lfgStart = report.lfg[0]?.startSeq ?? 0;
    expect(report.outside.requests).toBeGreaterThanOrEqual(lfgStart);

    expect(report.checks.count).toBe(checkCount(s.sessionId));
    expect(report.checks.costUsd).toBeGreaterThan(0);
    const calls = checkCount(s.sessionId);
    expect(await analyze(s.sessionId)).toEqual(report);
    expect(checkCount(s.sessionId)).toBe(calls);
    expect(await stages(s.sessionId)).toEqual(report);
  }, 900_000);

  test('9f4adf2d：调研 session 没有任何轮次，全部计入流程外，不调用模型', async () => {
    const s = ingestSample(db, SAMPLES.research);
    const report = await analyze(s.sessionId);
    expect(report.lfg).toEqual([]);
    expect(report.ic).toEqual([]);
    expect(report.checks).toEqual({ count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const all = withSubagents(s, s.main);
    expect(report.outside.requests).toBe(all.length);
    expect(report.outside.costUsd).toBeCloseTo(all.reduce((n, r) => n + r.costUsd, 0));
    expect(await stages(s.sessionId)).toEqual(report);
    const list = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}` });
    expect(list.json()).toMatchObject({ analyzed: true, workflows: [] });
  });

  test('旧版本的判定结果视为未分析，analyze 重新判定', async () => {
    const s = ingestSample(db, SAMPLES.research);
    await analyze(s.sessionId);
    db.update(stageAnalyses)
      .set({ version: 1 })
      .where(eq(stageAnalyses.sessionId, s.sessionId))
      .run();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}/stages` });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}` });
    expect(list.json()).toMatchObject({ analyzed: false });
    const report = await analyze(s.sessionId);
    expect(report.ic).toEqual([]);
    expect(await stages(s.sessionId)).toEqual(report);
  });

  test('d93c4511：lfg 停在 interview，子代理请求计入父调用所在阶段', async () => {
    const s = ingestSample(db, SAMPLES.interview);
    const report = await analyze(s.sessionId);
    expect(report.ic).toEqual([]);
    expect(report.checks.count).toBe(0);
    const interview = report.lfg[0]?.stages[0];
    const skillSeq = seqOfToolLine(s, 28);
    expect(report.lfg[0]).toMatchObject({ index: 1, label: '第 1 轮', startSeq: skillSeq });
    expect(interview).toMatchObject({
      stage: 'interview',
      status: 'active',
      startSeq: skillSeq,
      endSeq: lastMainSeq(s),
    });

    const inSpan = s.main.filter((r) => r.seq >= skillSeq);
    const all = withSubagents(s, inSpan);
    const subRows = all.filter((r) => r.agentId !== null);
    expect(subRows.length).toBeGreaterThan(0);
    expect(interview?.stats.requests).toBe(all.length);
    expect(interview?.stats.subagents).toBe(new Set(subRows.map((r) => r.agentId)).size);
    expect(interview?.stats.outputTokens).toBe(all.reduce((n, r) => n + r.outputTokens, 0));
    expect(interview?.stats.cacheReadTokens).toBe(all.reduce((n, r) => n + r.cacheReadTokens, 0));
    expect(interview?.stats.costUsd).toBeCloseTo(all.reduce((n, r) => n + r.costUsd, 0));
    expect(interview?.stats.durationMs).toBeGreaterThan(0);
    // Skill interview 之前的请求在流程外
    expect(report.outside.requests).toBe(
      withSubagents(
        s,
        s.main.filter((r) => r.seq < skillSeq),
      ).length,
    );
  });
});
