import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import { runCostBreakdown } from '../../src/cost.js';
import type { Db } from '../../src/db/index.js';
import {
  gradeItems,
  grades,
  requests,
  runMessages,
  STAGE_ANALYSIS_VERSION,
  stageAnalyses,
  stageChecks,
  stageCycles,
  stageSpans,
  type ToolCall,
} from '../../src/db/schema.js';
import { compareRuns } from '../../src/grading/compare.js';
import { CompareResult, type CrossRunRef } from '../../src/grading/schema.js';
import { IC_STAGES, LFG_STAGES } from '../../src/stages/workflow.js';
import { loadIcTask, loadLfgTask, syncTasks } from '../../src/tasks/loader.js';
import type { RubricArtifact } from '../../src/tasks/schema.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

const workDir = path.join(config.repoRoot, '.work/test-compare', randomUUID());
const tasksDir = path.join(workDir, 'tasks');
fs.cpSync(
  fileURLToPath(new URL('../fixtures/lfg-tasks/optional-mcp-install', import.meta.url)),
  path.join(tasksDir, 'optional-mcp-install'),
  { recursive: true },
);
fs.cpSync(path.join(config.tasksDir, 'ic-money-format'), path.join(tasksDir, 'ic-money-format'), {
  recursive: true,
});

const { db, close } = openTestDb();
syncTasks(db, tasksDir);
insertVariant(db, 'baseline');
insertVariant(db, 'modified');
const lfgTask = loadLfgTask(db, 'optional-mcp-install');
const icTask = loadIcTask(db, 'ic-money-format');

afterAll(() => {
  close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const t0 = new Date('2026-10-09T08:00:00Z').getTime();

function call(name: string, subagentId: string | null = null): ToolCall {
  return {
    id: `toolu_${randomUUID()}`,
    name,
    input: {},
    result: 'ok',
    resultChars: 2,
    isError: false,
    spillPath: null,
    subagentId,
  };
}

function request(sessionId: string, seq: number, costUsd: number, at: number, calls: ToolCall[]) {
  return {
    sessionId,
    messageId: `msg_${randomUUID()}`,
    seq,
    agentId: null as string | null,
    timestamp: new Date(at),
    model: 'claude-opus-5-5',
    toolCalls: calls,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 1000,
    costUsd,
  };
}

// 主 session 4 条请求，花费按 factor 放大：第一阶段 seq 0–1，第二阶段 seq 2–3（进行中），其余未到达。
// withSubagent 时 seq 2 的 Agent 调用带一个子代理，子代理有一条花费 1 美元的请求
function seedSession(
  db: Db,
  sessionId: string,
  workflow: 'lfg' | 'ic',
  factor: number,
  withSubagent: boolean,
) {
  const agentId = withSubagent ? `agent-${sessionId}` : null;
  const rows = [
    request(sessionId, 0, 0.1 * factor, t0, [call('Skill')]),
    request(sessionId, 1, 0.2 * factor, t0 + 1000, []),
    request(sessionId, 2, 0.3 * factor, t0 + 3000, [call('Read'), call('Agent', agentId)]),
    request(sessionId, 3, 0.4 * factor, t0 + 6000, []),
  ];
  if (agentId !== null) {
    rows.push({ ...request(sessionId, 0, 1, t0 + 4000, [call('Bash')]), agentId });
  }
  for (const r of rows) db.insert(requests).values(r).run();
  const stages = workflow === 'lfg' ? LFG_STAGES : IC_STAGES;
  // dashboard 发起的运行只有一轮
  db.insert(stageCycles)
    .values({ sessionId, workflow, cycle: 1, label: '第 1 轮', startSeq: 0, endSeq: null })
    .run();
  stages.forEach((stage, i) => {
    const span =
      i === 0
        ? { status: 'done' as const, startSeq: 0, endSeq: 1 }
        : i === 1
          ? { status: 'active' as const, startSeq: 2, endSeq: 3 }
          : { status: 'not-reached' as const, startSeq: null, endSeq: null };
    db.insert(stageSpans)
      .values({
        sessionId,
        workflow,
        cycle: 1,
        stage,
        method: workflow === 'lfg' ? 'artifact' : 'llm',
        evidence: null,
        ...span,
      })
      .run();
  });
  db.insert(stageAnalyses)
    .values({
      sessionId,
      version: STAGE_ANALYSIS_VERSION,
      hasLfg: workflow === 'lfg',
      hasIc: workflow === 'ic',
    })
    .run();
  db.insert(stageChecks)
    .values({
      sessionId,
      workflow,
      currentStage: stages[0],
      nextStage: stages[1],
      fromSeq: 0,
      toSeq: 3,
      inputChars: 100,
      entered: true,
      enteredAtSeq: 2,
      answer: '{}',
      model: 'claude-haiku-4-5',
      inputTokens: 50,
      outputTokens: 5,
      costUsd: 0.01,
    })
    .run();
}

function seedRunMessage(db: Db, runId: string) {
  db.insert(runMessages)
    .values({ runId, seq: 0, role: 'simulated_user', content: '好的', costUsd: 0.05 })
    .run();
}

// 每组一次 judge 调用（花费 0.02）；score(artifact) 为该组的得分比例，只取 0 或 1
function seedLfgGrades(db: Db, runId: string, full: (artifact: RubricArtifact) => boolean) {
  for (const group of lfgTask.rubric) {
    const grade = db
      .insert(grades)
      .values({
        runId,
        kind: 'rubric',
        artifact: group.artifact,
        judgeModel: 'claude-opus-5-5',
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.02,
      })
      .returning({ id: grades.id })
      .get();
    for (const item of group.items) {
      db.insert(gradeItems)
        .values({
          gradeId: grade.id,
          itemId: item.id,
          criterion: item.criterion,
          score: full(group.artifact) ? item.maxScore : 0,
          maxScore: item.maxScore,
          reasoning: full(group.artifact) ? '满足' : '不满足',
        })
        .run();
    }
  }
}

function seedIcGrades(db: Db, runId: string, passed: number, reachedEnd: boolean) {
  db.insert(grades)
    .values({
      runId,
      kind: 'ic',
      testsPassed: passed,
      testsDeclared: 8,
      reachedEnd,
      icDetail: { pr: null, outcomes: [], fileErrors: [], endpoint: null, error: null },
    })
    .run();
}

function lfgRun(
  id: string,
  variantId: string,
  factor: number,
  full: (a: RubricArtifact) => boolean,
  extra: { humanIntervened?: boolean; crossRef?: boolean; withSubagent?: boolean } = {},
) {
  const sessionId = insertRun(db, {
    id,
    taskId: lfgTask.id,
    variantId,
    status: 'succeeded',
    humanIntervened: extra.humanIntervened ?? false,
    crossRunRefs: extra.crossRef === true ? [crossRef] : [],
    createdAt: new Date(t0 + factor),
  });
  seedSession(db, sessionId, 'lfg', factor, extra.withSubagent ?? false);
  seedRunMessage(db, id);
  seedLfgGrades(db, id, full);
}

const crossRef: CrossRunRef = {
  runId: 'i1',
  kind: 'repo',
  requestSeq: 2,
  toolCallId: 'toolu_cross',
  excerpt: 'gh api repos/txehq/wfe-i1/contents/package.json',
};

// lfg：baseline 三个正常 run、一个有人工干预的 run、一个失败的 run、一个参考了其他 run 的 run、
// 一个两者都有的 run；modified 一个 run
lfgRun('l1', 'baseline', 1, () => true, { withSubagent: true });
lfgRun('l2', 'baseline', 2, (a) => a === 'brief');
lfgRun('l3', 'baseline', 3, (a) => a !== 'brief');
lfgRun('l4', 'baseline', 4, () => false, { humanIntervened: true });
insertRun(db, { id: 'l5', taskId: lfgTask.id, variantId: 'baseline', status: 'failed' });
lfgRun('l6', 'modified', 1, () => true);
lfgRun('l7', 'baseline', 7, () => true, { crossRef: true });
lfgRun('l8', 'baseline', 8, () => true, { humanIntervened: true, crossRef: true });

// ic：baseline 两个 run
for (const [id, factor, passed, reached] of [
  ['i1', 1, 3, true],
  ['i2', 2, 8, false],
] as const) {
  const sessionId = insertRun(db, {
    id,
    taskId: icTask.id,
    variantId: 'baseline',
    status: 'succeeded',
    createdAt: new Date(t0 + factor),
  });
  seedSession(db, sessionId, 'ic', factor, false);
  seedRunMessage(db, id);
  seedIcGrades(db, id, passed, reached);
}

// 与实现无关的样本标准差，用来核对
function sampleStd(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function cell(result: CompareResult, variantId: string, taskId: string) {
  const c = result.cells.find((x) => x.variantId === variantId && x.taskId === taskId);
  if (c === undefined) throw new Error(`没有 ${variantId} × ${taskId}`);
  return c;
}

describe('compare', () => {
  const query = {
    variants: ['baseline', 'modified'],
    tasks: [lfgTask.id, icTask.id],
    includeIntervened: false,
    includeCrossRef: false,
  };

  it('两个开关各自只放回一类：includeIntervened 放回人工干预的 run，includeCrossRef 放回参考了其他 run 的 run', () => {
    const ids = (q: Partial<typeof query>) =>
      cell(compareRuns(db, { ...query, ...q }), 'baseline', lfgTask.id).runIds;
    expect(ids({})).toEqual(['l1', 'l2', 'l3']);
    expect(ids({ includeIntervened: true })).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(ids({ includeCrossRef: true })).toEqual(['l1', 'l2', 'l3', 'l7']);
    expect(ids({ includeIntervened: true, includeCrossRef: true })).toEqual([
      'l1',
      'l2',
      'l3',
      'l4',
      'l7',
      'l8',
    ]);
  });

  it('lfg：排除有人工干预与未评分的 run，得分率的均值、标准差、最小值、最大值与原始值', () => {
    const c = cell(compareRuns(db, query), 'baseline', lfgTask.id);
    expect(c.runIds).toEqual(['l1', 'l2', 'l3']);
    if (c.quality.kind !== 'lfg') throw new Error('应为 lfg');
    const totals = [1, 19 / 55, 36 / 55];
    expect(c.quality.total.values).toEqual([
      { runId: 'l1', value: 1 },
      { runId: 'l2', value: 19 / 55 },
      { runId: 'l3', value: 36 / 55 },
    ]);
    expect(c.quality.total.n).toBe(3);
    expect(c.quality.total.mean).toBeCloseTo(2 / 3, 12);
    expect(c.quality.total.stdDev).toBeCloseTo(sampleStd(totals), 12);
    expect(c.quality.total.min).toBeCloseTo(19 / 55, 12);
    expect(c.quality.total.max).toBe(1);
    const brief = c.quality.artifacts.find((a) => a.artifact === 'brief')?.rate;
    expect(brief?.values.map((v) => v.value)).toEqual([1, 1, 0]);
    expect(brief?.mean).toBeCloseTo(2 / 3, 12);
    expect(brief?.stdDev).toBeCloseTo(Math.sqrt(1 / 3), 12);
    expect(c.quality.artifacts.map((a) => a.artifact)).toEqual([
      'brief',
      'research',
      'plan',
      'tickets',
    ]);

    // 每条 rubric 的平均得分：b1 满分 5，三个 run 为 5、5、0
    const b1 = c.rubricItems.find((i) => i.itemId === 'b1');
    expect(b1).toMatchObject({ artifact: 'brief', maxScore: 5 });
    expect(b1?.score.mean).toBeCloseTo(10 / 3, 12);
    expect(c.rubricItems.map((i) => i.itemId)).toEqual(
      lfgTask.rubric.flatMap((g) => g.items.map((i) => i.id)),
    );
  });

  it('lfg：includeIntervened 时包含有人工干预的 run；单个 run 的标准差为空', () => {
    const result = compareRuns(db, { ...query, includeIntervened: true });
    const c = cell(result, 'baseline', lfgTask.id);
    expect(c.runIds).toEqual(['l1', 'l2', 'l3', 'l4']);
    if (c.quality.kind !== 'lfg') throw new Error('应为 lfg');
    expect(c.quality.total.mean).toBeCloseTo(0.5, 12);
    expect(c.quality.total.stdDev).toBeCloseTo(sampleStd([1, 19 / 55, 36 / 55, 0]), 12);

    const modified = cell(result, 'modified', lfgTask.id);
    expect(modified.runIds).toEqual(['l6']);
    if (modified.quality.kind !== 'lfg') throw new Error('应为 lfg');
    expect(modified.quality.total).toMatchObject({ n: 1, mean: 1, stdDev: null, min: 1, max: 1 });
  });

  it('成本：每个阶段的均值（子代理计入所在阶段，未到达按 0）与四项总成本的均值', () => {
    const c = cell(compareRuns(db, query), 'baseline', lfgTask.id);
    const stages = c.cost?.stages ?? [];
    expect(stages.map((s) => [s.stage, s.reached])).toEqual([
      ['interview', 3],
      ['research', 3],
      ['plan', 0],
      ['ticketing', 0],
    ]);
    const [interview, research, plan] = stages;
    // interview：每个 run 0.3 × factor，factor 为 1、2、3
    expect(interview?.costUsd).toBeCloseTo(0.6, 12);
    expect(interview).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000 });
    expect(interview?.durationMs).toBe(1000);
    expect(interview?.toolCalls).toBe(1);
    // research：0.7 × factor，l1 另有子代理的 1 美元与一次 Bash 调用
    expect(research?.costUsd).toBeCloseTo((1.7 + 1.4 + 2.1) / 3, 12);
    expect(research?.toolCalls).toBeCloseTo(7 / 3, 12);
    expect(research?.durationMs).toBe(3000);
    expect(research?.inputTokens).toBeCloseTo(700 / 3, 12);
    expect(plan).toMatchObject({ costUsd: 0, toolCalls: 0, durationMs: 0 });

    // agent：1 + 1（子代理）、2、3；模拟用户 0.05；阶段判定 0.01；评分 4 × 0.02
    expect(runCostBreakdown(db, 'l1')).toEqual({
      agent: expect.closeTo(2, 12) as number,
      simulatedUser: 0.05,
      stageCheck: 0.01,
      grading: expect.closeTo(0.08, 12) as number,
      total: expect.closeTo(2.14, 12) as number,
    });
    expect(c.cost?.total.agent).toBeCloseTo(7 / 3, 12);
    expect(c.cost?.total.simulatedUser).toBeCloseTo(0.05, 12);
    expect(c.cost?.total.stageCheck).toBeCloseTo(0.01, 12);
    expect(c.cost?.total.grading).toBeCloseTo(0.08, 12);
    expect(c.cost?.total.total).toBeCloseTo(7 / 3 + 0.14, 12);
  });

  it('ic：测试通过率的分布与到达终点的比例；没有 run 的格子质量为空、成本为空', () => {
    const result = compareRuns(db, query);
    const c = cell(result, 'baseline', icTask.id);
    expect(c.runIds).toEqual(['i1', 'i2']);
    if (c.quality.kind !== 'ic') throw new Error('应为 ic');
    expect(c.quality.passRate.values).toEqual([
      { runId: 'i1', value: 3 / 8 },
      { runId: 'i2', value: 1 },
    ]);
    expect(c.quality.passRate.mean).toBeCloseTo(11 / 16, 12);
    expect(c.quality.passRate.stdDev).toBeCloseTo(sampleStd([3 / 8, 1]), 12);
    expect(c.quality.reachedEnd).toEqual({
      ratio: 0.5,
      values: [
        { runId: 'i1', reached: true },
        { runId: 'i2', reached: false },
      ],
    });
    expect(c.rubricItems).toEqual([]);
    expect(c.cost?.stages.map((s) => s.stage)).toEqual([...IC_STAGES]);
    expect(c.cost?.stages[0]?.costUsd).toBeCloseTo(0.45, 12);

    const empty = cell(result, 'modified', icTask.id);
    expect(empty.runIds).toEqual([]);
    expect(empty.cost).toBeNull();
    if (empty.quality.kind !== 'ic') throw new Error('应为 ic');
    expect(empty.quality.passRate).toEqual({
      n: 0,
      mean: null,
      stdDev: null,
      min: null,
      max: null,
      values: [],
    });
    expect(empty.quality.reachedEnd.ratio).toBeNull();
  });

  it('GET /api/compare：逗号分隔的参数、includeIntervened，不存在的 variant 或 task 返回 404', async () => {
    const app = await buildApp({
      db,
      sseHeartbeatMs: config.sseHeartbeatMs,
      logger: false,
      tasksDir,
    });
    const qs = `variants=baseline,modified&tasks=${lfgTask.id},${icTask.id}`;
    const ok = await app.inject({ method: 'GET', url: `/api/compare?${qs}` });
    expect(ok.statusCode).toBe(200);
    expect(CompareResult.parse(ok.json())).toEqual(compareRuns(db, query));
    const all = await app.inject({
      method: 'GET',
      url: `/api/compare?${qs}&includeIntervened=true`,
    });
    expect(cell(CompareResult.parse(all.json()), 'baseline', lfgTask.id).runIds).toHaveLength(4);
    const crossRefs = await app.inject({
      method: 'GET',
      url: `/api/compare?${qs}&includeCrossRef=true`,
    });
    const crossResult = CompareResult.parse(crossRefs.json());
    expect(crossResult.includeCrossRef).toBe(true);
    expect(cell(crossResult, 'baseline', lfgTask.id).runIds).toEqual(['l1', 'l2', 'l3', 'l7']);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/compare?variants=baseline,nope&tasks=${lfgTask.id}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('nope');
    const bad = await app.inject({
      method: 'GET',
      url: `/api/compare?variants=&tasks=${lfgTask.id}`,
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
