import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { max, mean, min, sampleStandardDeviation } from 'simple-statistics';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { grades, runs } from '../db/schema.js';
import { readReport } from '../stages/report.js';
import { IC_STAGES, LFG_STAGES } from '../stages/workflow.js';
import { loadTask } from '../tasks/loader.js';
import { rubricArtifacts } from '../tasks/schema.js';
import { readRunGrades } from './index.js';
import {
  type CompareCell,
  type CompareResult,
  type CostBreakdown,
  type Distribution,
  type RunGrades,
  type StageCost,
} from './schema.js';

type Run = typeof runs.$inferSelect;
interface GradedRun {
  run: Run;
  grades: RunGrades;
}

export function distribution(values: { runId: string; value: number }[]): Distribution {
  const xs = values.map((v) => v.value);
  return {
    n: xs.length,
    mean: xs.length > 0 ? mean(xs) : null,
    stdDev: xs.length > 1 ? sampleStandardDeviation(xs) : null,
    min: xs.length > 0 ? min(xs) : null,
    max: xs.length > 0 ? max(xs) : null,
    values,
  };
}

function lfgOf(g: GradedRun) {
  if (g.grades.lfg === null) throw new Error(`run ${g.run.id} 没有 lfg 评分`);
  return g.grades.lfg;
}

function icOf(g: GradedRun) {
  if (g.grades.ic === null) throw new Error(`run ${g.run.id} 没有 ic 评分`);
  return g.grades.ic;
}

function lfgQuality(graded: GradedRun[]): CompareCell['quality'] {
  return {
    kind: 'lfg',
    total: distribution(
      graded.map((g) => ({ runId: g.run.id, value: lfgOf(g).score / lfgOf(g).maxScore })),
    ),
    artifacts: rubricArtifacts.map((artifact) => ({
      artifact,
      rate: distribution(
        graded.map((g) => {
          const group = lfgOf(g).artifacts.find((a) => a.artifact === artifact);
          if (group === undefined) throw new Error(`run ${g.run.id} 没有 ${artifact} 的评分`);
          return { runId: g.run.id, value: group.score / group.maxScore };
        }),
      ),
    })),
  };
}

function icQuality(graded: GradedRun[]): CompareCell['quality'] {
  const reached = graded.map((g) => ({ runId: g.run.id, reached: icOf(g).reachedEnd }));
  return {
    kind: 'ic',
    passRate: distribution(
      graded.map((g) => ({ runId: g.run.id, value: icOf(g).testsPassed / icOf(g).testsDeclared })),
    ),
    reachedEnd: {
      ratio: reached.length > 0 ? reached.filter((r) => r.reached).length / reached.length : null,
      values: reached,
    },
  };
}

// 按 rubric 顺序（首次出现的顺序）列出条目；条目的 criterion 与满分取首次出现的 run
function rubricItems(graded: GradedRun[]): CompareCell['rubricItems'] {
  const items = new Map<
    string,
    {
      artifact: (typeof rubricArtifacts)[number];
      itemId: string;
      criterion: string;
      maxScore: number;
      values: { runId: string; value: number }[];
    }
  >();
  for (const g of graded) {
    for (const group of lfgOf(g).artifacts) {
      for (const item of group.items) {
        const key = `${group.artifact}\0${item.itemId}`;
        const entry = items.get(key) ?? {
          artifact: group.artifact,
          itemId: item.itemId,
          criterion: item.criterion,
          maxScore: item.maxScore,
          values: [],
        };
        entry.values.push({ runId: g.run.id, value: item.score });
        items.set(key, entry);
      }
    }
  }
  return [...items.values()].map(({ values, ...rest }) => ({
    ...rest,
    score: distribution(values),
  }));
}

function stageCosts(db: Db, graded: GradedRun[], kind: 'lfg' | 'ic'): StageCost[] {
  const stages = kind === 'lfg' ? LFG_STAGES : IC_STAGES;
  const reports = graded.map((g) => {
    const report = readReport(db, g.run.sessionId);
    if (report === null) throw new Error(`run ${g.run.id} 的 session 没有阶段判定结果`);
    // dashboard 发起的运行只有一轮
    const views = report[kind][0]?.stages;
    if (views === undefined) throw new Error(`run ${g.run.id} 的阶段判定中没有 ${kind}`);
    return views;
  });
  return stages.map((stage) => {
    const views = reports.map((vs) => vs.find((v) => v.stage === stage));
    const stats = views.map((v) => v?.stats);
    const pick = (f: (s: NonNullable<(typeof stats)[number]>) => number) =>
      mean(stats.map((s) => (s === undefined ? 0 : f(s))));
    return {
      stage,
      reached: views.filter((v) => v !== undefined && v.status !== 'not-reached').length,
      costUsd: pick((s) => s.costUsd),
      inputTokens: pick((s) => s.inputTokens),
      outputTokens: pick((s) => s.outputTokens),
      cacheReadTokens: pick((s) => s.cacheReadTokens),
      cacheCreationTokens: pick((s) => s.cacheCreationTokens),
      durationMs: pick((s) => s.durationMs),
      toolCalls: pick((s) => Object.values(s.toolCalls).reduce((n, c) => n + c, 0)),
    };
  });
}

function meanBreakdown(breakdowns: CostBreakdown[]): CostBreakdown {
  return {
    agent: mean(breakdowns.map((b) => b.agent)),
    simulatedUser: mean(breakdowns.map((b) => b.simulatedUser)),
    stageCheck: mean(breakdowns.map((b) => b.stageCheck)),
    grading: mean(breakdowns.map((b) => b.grading)),
    total: mean(breakdowns.map((b) => b.total)),
  };
}

export interface CompareQuery {
  variants: string[];
  tasks: string[];
  includeIntervened: boolean;
  includeCrossRef: boolean;
  includeCancelled: boolean;
}

// 可对比的 run：已评分（succeeded）、或被取消后评分了已写出产物的 run（Contracts 7.5），且未标为无效（7.12）。
// 只在排队中被取消的 run 没有评分，不参与
export function comparableRun(includeCancelled: boolean) {
  const graded = sql`exists (select 1 from ${grades} where ${grades.runId} = ${runs.id})`;
  return and(
    isNull(runs.invalidReason),
    includeCancelled
      ? or(eq(runs.status, 'succeeded'), and(eq(runs.status, 'cancelled'), graded))
      : eq(runs.status, 'succeeded'),
  );
}

// 每个 variant × task 一格；默认排除有人工干预、参考了其他 run 与被取消的 run，三个开关各自只放回一类
export function compareRuns(db: Db, query: CompareQuery): CompareResult {
  const cells = query.variants.flatMap((variantId) =>
    query.tasks.map((taskId): CompareCell => {
      const task = loadTask(db, taskId);
      const rows = db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.variantId, variantId),
            eq(runs.taskId, taskId),
            comparableRun(query.includeCancelled),
            query.includeIntervened ? undefined : eq(runs.humanIntervened, false),
            query.includeCrossRef ? undefined : sql`json_array_length(${runs.crossRunRefs}) = 0`,
          ),
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all();
      const graded = rows.map((run): GradedRun => {
        const g = readRunGrades(db, run.id);
        if (g === null) throw new Error(`run ${run.id} 状态为 ${run.status} 但没有评分`);
        return { run, grades: g };
      });
      return {
        variantId,
        taskId,
        kind: task.kind,
        runIds: rows.map((r) => r.id),
        quality: task.kind === 'lfg' ? lfgQuality(graded) : icQuality(graded),
        cost:
          graded.length === 0
            ? null
            : {
                stages: stageCosts(db, graded, task.kind),
                total: meanBreakdown(graded.map((g) => runCostBreakdown(db, g.run.id))),
              },
        rubricItems: task.kind === 'lfg' ? rubricItems(graded) : [],
      };
    }),
  );
  return { ...query, cells };
}
