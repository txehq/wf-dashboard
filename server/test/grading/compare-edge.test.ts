import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeItems, grades, requests, type ToolCall } from '../../src/db/schema.js';
import { compareRuns } from '../../src/grading/compare.js';
import { readReport } from '../../src/stages/report.js';
import { loadTask, syncTasks, withRubric } from '../../src/tasks/loader.js';
import { loadWorkflow } from '../../src/workflows/index.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

// W15 H8、Medium 12、Low 10 的复现（wfd-w15/.work/review-grading/compare-repro.ts）
const workDir = path.join(config.repoRoot, '.work/test-compare-edge', randomUUID());
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
const lfgTask = withRubric(loadTask(db, 'optional-mcp-install'));
const IC_STAGES = loadWorkflow(db, 'ic').stages.map((s) => s.id);
insertVariant(db, 'ic-v', 'ic');
for (const v of ['lfg-v', 'empty-v']) insertVariant(db, v);

afterAll(() => {
  close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function icRun(id: string) {
  const sessionId = insertRun(db, {
    id,
    taskId: 'ic-money-format',
    variantId: 'ic-v',
    status: 'succeeded',
  });
  db.insert(grades)
    .values({
      runId: id,
      kind: 'ic',
      testsPassed: 0,
      testsDeclared: 19,
      reachedEnd: false,
      icDetail: { pr: null, outcomes: [], fileErrors: [], endpoint: null, error: null },
    })
    .run();
  return sessionId;
}

// agent 一开始就报告无法继续：session 有请求，但没有任何阶段标记
const noCycle = icRun('r-ic');
const request = (sessionId: string, seq: number, toolCalls: ToolCall[]) =>
  db
    .insert(requests)
    .values({
      sessionId,
      messageId: `msg-${sessionId}-${String(seq)}`,
      seq,
      agentId: null,
      timestamp: new Date(Date.parse('2026-10-09T08:00:00Z') + seq * 1000),
      model: 'claude-opus-5-5',
      toolCalls,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    })
    .run();
request(noCycle, 0, []);
// 只进入了 claim 就结束的 run
const claimed = icRun('r-claim');
const skill: ToolCall = {
  id: 'toolu_claim',
  name: 'Skill',
  input: { skill: 'claim', args: 'TXE-1' },
  result: 'Launching skill: claim',
  resultChars: 22,
  isError: false,
  spillPath: null,
  subagentId: null,
};
request(claimed, 0, [skill]);
// 没有任何请求
icRun('r-none');

// 两个 lfg run 都拿满分；b1 的满分在第二个 run 时被改成 1（task 的 rubric 被修改过）
function lfgRun(id: string, maxB1: number) {
  insertRun(db, { id, taskId: lfgTask.id, variantId: 'lfg-v', status: 'succeeded' });
  for (const group of lfgTask.rubric) {
    const g = db
      .insert(grades)
      .values({ runId: id, kind: 'rubric', artifact: group.artifact, judgeModel: 'm', costUsd: 0 })
      .returning({ id: grades.id })
      .get();
    for (const item of group.items) {
      const max = item.id === 'b1' ? maxB1 : item.maxScore;
      db.insert(gradeItems)
        .values({
          gradeId: g.id,
          itemId: item.id,
          criterion: item.criterion,
          score: max,
          maxScore: max,
          reasoning: 'ok',
        })
        .run();
    }
  }
}
const b1Max = lfgTask.rubric[0]?.items.find((i) => i.id === 'b1')?.maxScore;
lfgRun('r-a', b1Max ?? 0);
lfgRun('r-b', 1);

const query = {
  groupBy: 'variant' as const,
  includeIntervened: false,
  includeCrossRef: false,
  includeSourceRef: false,
  includeCancelled: false,
};

describe('compare 的边界情况', () => {
  it('H8：没有阶段轮次、没有请求的 run 不让 compare 报错，阶段记为未到达、成本按 0；终态 run 的最后一个阶段为 done', () => {
    const icCycles = (sessionId: string) =>
      readReport(db, sessionId)?.workflows.find((w) => w.workflow === 'ic')?.cycles;
    expect(icCycles(claimed)?.[0]?.stages[0]).toMatchObject({
      status: 'done',
      entries: 1,
      evidence: { seq: 0, kind: 'skill', text: 'Skill: claim TXE-1' },
    });
    expect(icCycles(noCycle)).toEqual([]);
    const c = compareRuns(db, { ...query, variants: ['ic-v'], tasks: ['ic-money-format'] })
      .cells[0];
    expect(c?.runIds).toEqual(['r-ic', 'r-claim', 'r-none']);
    expect(c?.cost?.stages.map((s) => [s.stage, s.reached])).toEqual(
      IC_STAGES.map((s, i) => [s, i === 0 ? 1 : 0]),
    );
    expect(c?.cost?.stages.every((s) => s.costUsd === 0)).toBe(true);
  });

  it('Medium 12：满分不同的同一条目分开统计；Low 10：没有 run 的格子也列出 rubric 条目', () => {
    const result = compareRuns(db, {
      ...query,
      variants: ['lfg-v', 'empty-v'],
      tasks: [lfgTask.id],
    });
    const b1 = result.cells[0]?.rubricItems.filter((i) => i.itemId === 'b1');
    expect(b1?.map((i) => [i.maxScore, i.score.mean, i.score.n])).toEqual([
      [b1Max, b1Max, 1],
      [1, 1, 1],
    ]);
    const empty = result.cells[1]?.rubricItems;
    expect(empty?.map((i) => i.itemId)).toEqual(
      lfgTask.rubric.flatMap((g) => g.items.map((i) => i.id)),
    );
    expect(empty?.every((i) => i.score.n === 0)).toBe(true);
  });
});
