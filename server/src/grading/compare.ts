import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { max, mean, min, sampleStandardDeviation } from 'simple-statistics';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { artifacts, grades, runs, tasks as tasksTable, variants } from '../db/schema.js';
import { readReport } from '../stages/report.js';
import { loadTask } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { HttpError } from '../variants/errors.js';
import { loadBigStage } from '../workflows/index.js';
import type { BigStageDefinition } from '../workflows/schema.js';
import { CRITERION_MAX, criterionId } from './ic-criteria.js';
import { readRunGrades } from './index.js';
import {
  type CompareCell,
  type CompareResult,
  type CostBreakdown,
  type Distribution,
  type FrictionStats,
  type Quality,
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

function rubricOfRun(g: GradedRun) {
  if (g.grades.rubric === null) throw new Error(`run ${g.run.id} 没有 rubric 评分`);
  return g.grades.rubric;
}

function testsOf(g: GradedRun) {
  if (g.grades.hiddenTests === null) throw new Error(`run ${g.run.id} 没有隐藏测试评分`);
  return g.grades.hiddenTests;
}

function criteriaOf(g: GradedRun) {
  if (g.grades.criteria === null) throw new Error(`run ${g.run.id} 没有验收标准评分`);
  return g.grades.criteria;
}

function endpointOf(g: GradedRun) {
  if (g.grades.endpoint === null) throw new Error(`run ${g.run.id} 没有终点判定`);
  return g.grades.endpoint;
}

// 按 task 所在大阶段的评分积木分项（Contracts 16.2）：有隐藏测试的 task 用隐藏测试，没有时用验收标准
function qualityOf(stage: BigStageDefinition, task: Task, graded: GradedRun[]): Quality {
  const rubric = task.rubric;
  const tests = stage.grading.includes('hidden-tests') && task.hiddenTests !== undefined;
  const criteria = stage.grading.includes('criteria-judge') && !tests;
  const reached = stage.grading.includes('pr-endpoint')
    ? graded.map((g) => ({ runId: g.run.id, reached: endpointOf(g).reached }))
    : null;
  return {
    rubric:
      rubric === undefined
        ? null
        : {
            total: distribution(
              graded.map((g) => ({
                runId: g.run.id,
                value: rubricOfRun(g).score / rubricOfRun(g).maxScore,
              })),
            ),
            artifacts: rubric.map(({ artifact }) => ({
              artifact,
              rate: distribution(
                graded.map((g) => {
                  const group = rubricOfRun(g).artifacts.find((a) => a.artifact === artifact);
                  if (group === undefined)
                    throw new Error(`run ${g.run.id} 没有 ${artifact} 的评分`);
                  return { runId: g.run.id, value: group.score / group.maxScore };
                }),
              ),
            })),
          },
    passRate: tests
      ? distribution(
          graded.map((g) => ({
            runId: g.run.id,
            value: testsOf(g).testsPassed / testsOf(g).testsDeclared,
          })),
        )
      : null,
    criteriaRate: criteria
      ? distribution(
          graded.map((g) => ({
            runId: g.run.id,
            value: criteriaOf(g).score / criteriaOf(g).maxScore,
          })),
        )
      : null,
    reachedEnd:
      reached === null
        ? null
        : {
            ratio:
              reached.length > 0 ? reached.filter((r) => r.reached).length / reached.length : null,
            values: reached,
          },
  };
}

// 每条验收标准的得分：先是 task 当前的验收标准，再是 run 评分时用过、之后被修改的条目（与 rubricItems 相同的键）
function criteriaItems(task: Task, graded: GradedRun[]): CompareCell['criteriaItems'] {
  const items = new Map<string, Omit<RubricEntry, 'artifact'>>();
  const keyOf = (e: { itemId: string; criterion: string; maxScore: number }) =>
    JSON.stringify([e.itemId, e.criterion, e.maxScore]);
  (task.ticket?.acceptanceCriteria ?? []).forEach((criterion, i) => {
    const entry = { itemId: criterionId(i), criterion, maxScore: CRITERION_MAX };
    items.set(keyOf(entry), { ...entry, values: [] });
  });
  for (const g of graded) {
    for (const item of criteriaOf(g).items) {
      const entry = { itemId: item.itemId, criterion: item.criterion, maxScore: item.maxScore };
      const key = keyOf(entry);
      const existing = items.get(key) ?? { ...entry, values: [] };
      existing.values.push({ runId: g.run.id, value: item.score });
      items.set(key, existing);
    }
  }
  return [...items.values()].map(({ values, ...rest }) => ({
    ...rest,
    score: distribution(values),
  }));
}

interface RubricEntry {
  artifact: string;
  itemId: string;
  criterion: string;
  maxScore: number;
  values: { runId: string; value: number }[];
}

// 按 rubric 顺序列出条目：先是 task 当前的 rubric（没有 run 时也列出，分布为空），再是 run 评分时用过、
// 之后被修改的条目。键含 criterion 与满分：task 修改过 rubric 时，满分不同的同一条目分开统计，原始分不混在一起平均
function rubricItems(task: Task, graded: GradedRun[]): CompareCell['rubricItems'] {
  const items = new Map<string, RubricEntry>();
  const keyOf = (e: Omit<RubricEntry, 'values'>) =>
    JSON.stringify([e.artifact, e.itemId, e.criterion, e.maxScore]);
  for (const group of task.rubric ?? []) {
    for (const item of group.items) {
      const entry = {
        artifact: group.artifact,
        itemId: item.id,
        criterion: item.criterion,
        maxScore: item.maxScore,
      };
      items.set(keyOf(entry), { ...entry, values: [] });
    }
  }
  for (const g of graded) {
    for (const group of rubricOfRun(g).artifacts) {
      for (const item of group.items) {
        const entry = {
          artifact: group.artifact,
          itemId: item.itemId,
          criterion: item.criterion,
          maxScore: item.maxScore,
        };
        const key = keyOf(entry);
        const existing = items.get(key) ?? { ...entry, values: [] };
        existing.values.push({ runId: g.run.id, value: item.score });
        items.set(key, existing);
      }
    }
  }
  return [...items.values()].map(({ values, ...rest }) => ({
    ...rest,
    score: distribution(values),
  }));
}

// 没有进入任何阶段的 run（session 没有导入，或其中没有这个大阶段的轮次，例如 agent 一开始就报告无法继续）：
// 全部阶段记为未到达，成本按 0 计入均值
function stageCosts(db: Db, graded: GradedRun[], stage: BigStageDefinition): StageCost[] {
  const reports = graded.map((g) => {
    // dashboard 发起的运行只有一轮
    const report = readReport(db, g.run.sessionId);
    return report?.bigStages.find((b) => b.bigStage === stage.id)?.cycles[0]?.stages ?? [];
  });
  return stage.stages.map(({ id }) => {
    const views = reports.map((vs) => vs.find((v) => v.stage === id));
    const stats = views.map((v) => v?.stats);
    const pick = (f: (s: NonNullable<(typeof stats)[number]>) => number) =>
      mean(stats.map((s) => (s === undefined ? 0 : f(s))));
    return {
      stage: id,
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
    grading: mean(breakdowns.map((b) => b.grading)),
    total: mean(breakdowns.map((b) => b.total)),
  };
}

// Contracts 7.10：这组 run 提的 friction issue 与每次 run 的平均数量
function frictionStats(db: Db, runIds: string[]): FrictionStats {
  const issues = db
    .select({ runId: artifacts.runId, url: artifacts.location, title: artifacts.snapshot })
    .from(artifacts)
    .where(and(eq(artifacts.kind, 'friction'), inArray(artifacts.runId, runIds)))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .all()
    .map((a) => ({ runId: a.runId, url: a.url, title: a.title ?? '' }));
  return { perRun: issues.length / runIds.length, issues };
}

export interface CompareQuery {
  variants: string[];
  tasks: string[];
  groupBy: 'variant' | 'model';
  includeIntervened: boolean;
  includeCrossRef: boolean;
  includeSourceRef: boolean;
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

// 所选 task 共同的 workflow 与大阶段；variant 必须属于该 workflow（Contracts 16.5），否则 400 原文
function compareScope(db: Db, query: CompareQuery) {
  const taskRows = db
    .select({ id: tasksTable.id, workflowId: tasksTable.workflowId, bigStage: tasksTable.bigStage })
    .from(tasksTable)
    .where(inArray(tasksTable.id, query.tasks))
    .all();
  const scopes = [...new Set(taskRows.map((t) => `${t.workflowId}/${t.bigStage}`))];
  const [first] = taskRows;
  if (first === undefined || scopes.length !== 1) {
    throw new HttpError(
      400,
      `只能对比同一 workflow 的同一大阶段的 task，所选 task 属于 ${scopes.join('、')}`,
    );
  }
  const others = db
    .select({ id: variants.id, name: variants.name, workflowId: variants.workflowId })
    .from(variants)
    .where(inArray(variants.id, query.variants))
    .all()
    .filter((v) => v.workflowId !== first.workflowId);
  if (others.length > 0) {
    throw new HttpError(
      400,
      `所选 task 属于 workflow ${first.workflowId}，variant ${others.map((v) => `${v.name} (${v.workflowId})`).join('、')} 不属于它：不同 workflow 之间不对比`,
    );
  }
  return { workflowId: first.workflowId, bigStage: first.bigStage };
}

// variant 的 run 中在这些 task 上出现过的模型，按名字排序
function modelsOf(db: Db, variantId: string, taskIds: string[]): string[] {
  return db
    .selectDistinct({ model: runs.model })
    .from(runs)
    .where(and(eq(runs.variantId, variantId), inArray(runs.taskId, taskIds)))
    .orderBy(asc(runs.model))
    .all()
    .map((r) => r.model);
}

// groupBy=variant 时每个 variant × task 一格；groupBy=model 时每个 (variant, model) × task 一格。
// 默认排除有人工干预、参考了其他 run、读取了来源与被取消的 run，四个开关各自只放回一类
export function compareRuns(db: Db, query: CompareQuery): CompareResult {
  const scope = compareScope(db, query);
  const stage = loadBigStage(db, scope.workflowId, scope.bigStage);
  const groups = query.variants.flatMap(
    (variantId): { variantId: string; model: string | null }[] =>
      query.groupBy === 'variant'
        ? [{ variantId, model: null }]
        : modelsOf(db, variantId, query.tasks).map((model) => ({ variantId, model })),
  );
  const cells = groups.flatMap(({ variantId, model }) =>
    query.tasks.map((taskId): CompareCell => {
      const task = loadTask(db, taskId);
      const rows = db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.variantId, variantId),
            eq(runs.taskId, taskId),
            model === null ? undefined : eq(runs.model, model),
            comparableRun(query.includeCancelled),
            query.includeIntervened ? undefined : eq(runs.humanIntervened, false),
            query.includeCrossRef ? undefined : sql`json_array_length(${runs.crossRunRefs}) = 0`,
            query.includeSourceRef ? undefined : sql`json_array_length(${runs.sourceRefs}) = 0`,
          ),
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all();
      const graded = rows.map((run): GradedRun => {
        const g = readRunGrades(db, run.id);
        if (g === null) throw new Error(`run ${run.id} 状态为 ${run.status} 但没有评分`);
        return { run, grades: g };
      });
      const quality = qualityOf(stage, task, graded);
      return {
        variantId,
        model,
        taskId,
        runIds: rows.map((r) => r.id),
        quality,
        cost:
          graded.length === 0
            ? null
            : {
                stages: stageCosts(db, graded, stage),
                total: meanBreakdown(graded.map((g) => runCostBreakdown(db, g.run.id))),
                friction: frictionStats(
                  db,
                  rows.map((r) => r.id),
                ),
              },
        rubricItems: quality.rubric === null ? [] : rubricItems(task, graded),
        criteriaItems: quality.criteriaRate === null ? [] : criteriaItems(task, graded),
      };
    }),
  );
  return { ...query, ...scope, cells };
}
