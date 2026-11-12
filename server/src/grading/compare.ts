import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { max, mean, min, sampleStandardDeviation } from 'simple-statistics';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { artifacts, grades, runs, tasks as tasksTable, variants } from '../db/schema.js';
import { readReport } from '../stages/report.js';
import { loadTask } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { HttpError } from '../variants/errors.js';
import { evalSpecOf, loadWorkflow } from '../workflows/index.js';
import type { EvalSpec, WorkflowDefinition } from '../workflows/schema.js';
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
  if (g.grades.rubric === null) throw new Error(`Run ${g.run.id} has no rubric grade`);
  return g.grades.rubric;
}

function testsOf(g: GradedRun) {
  if (g.grades.hiddenTests === null) throw new Error(`Run ${g.run.id} has no hidden tests grade`);
  return g.grades.hiddenTests;
}

function criteriaOf(g: GradedRun) {
  if (g.grades.criteria === null)
    throw new Error(`Run ${g.run.id} has no acceptance criteria grade`);
  return g.grades.criteria;
}

function endpointOf(g: GradedRun) {
  if (g.grades.endpoint === null) throw new Error(`Run ${g.run.id} has no endpoint verdict`);
  return g.grades.endpoint;
}

// Quality per grading block of the eval kind (Contracts 16.2): tasks with hidden tests use them, others use acceptance criteria
function qualityOf(stage: EvalSpec, task: Task, graded: GradedRun[]): Quality {
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
                    throw new Error(`Run ${g.run.id} has no grade for ${artifact}`);
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

// Score of each acceptance criterion: the task's current criteria first, then items used when runs were graded and changed since (same keys as rubricItems)
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

// Items in rubric order: the task's current rubric first (listed with empty distributions even without runs), then items used when runs were graded
// and changed since. Keys include criterion and max score: after a rubric edit, the same item with a different max score counts separately, raw scores are not averaged together
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

// A run that entered no stage (session not imported, or no turn of this workflow in it, e.g. the agent reported at once that it cannot continue):
// every stage counts as not reached, with cost 0 in the mean
function stageCosts(db: Db, graded: GradedRun[], workflow: WorkflowDefinition): StageCost[] {
  const reports = graded.map((g) => {
    // Runs started by the dashboard have a single cycle
    const report = readReport(db, g.run.sessionId);
    return report?.workflows.find((w) => w.workflow === workflow.id)?.cycles[0]?.stages ?? [];
  });
  return workflow.stages.map(({ id }) => {
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

// Contracts 7.10: friction issues these runs filed and the average count per run
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

// Comparable runs: graded (succeeded), or cancelled with the written artifacts graded (Contracts 7.5), and not marked invalid (7.12).
// Runs cancelled while queued have no grade and are left out
export function comparableRun(includeCancelled: boolean) {
  const graded = sql`exists (select 1 from ${grades} where ${grades.runId} = ${runs.id})`;
  return and(
    isNull(runs.invalidReason),
    includeCancelled
      ? or(eq(runs.status, 'succeeded'), and(eq(runs.status, 'cancelled'), graded))
      : eq(runs.status, 'succeeded'),
  );
}

// The workflow shared by the chosen variants: it must have an eval kind, and the chosen tasks' kind must be that eval kind (Contracts 16.5); otherwise 400 with the message
function compareScope(db: Db, query: CompareQuery) {
  const variantRows = db
    .select({ id: variants.id, name: variants.name, workflowId: variants.workflowId })
    .from(variants)
    .where(inArray(variants.id, query.variants))
    .all();
  const workflowIds = [...new Set(variantRows.map((v) => v.workflowId))];
  const [workflowId] = workflowIds;
  if (workflowId === undefined || workflowIds.length !== 1) {
    throw new HttpError(
      400,
      `Only variants of the same workflow can be compared; the chosen variants belong to ${variantRows.map((v) => `${v.name} (${v.workflowId})`).join(', ')}: different workflows are not compared`,
    );
  }
  const stage = evalSpecOf(db, workflowId);
  const others = db
    .select({ id: tasksTable.id, kind: tasksTable.kind })
    .from(tasksTable)
    .where(inArray(tasksTable.id, query.tasks))
    .all()
    .filter((t) => t.kind !== stage.kind);
  if (others.length > 0) {
    throw new HttpError(
      400,
      `The eval kind of workflow ${workflowId} is ${stage.kind}; task ${others.map((t) => `${t.id} (${t.kind})`).join(', ')} is not of this eval kind`,
    );
  }
  return { workflowId, kind: stage.kind, stage };
}

// Models seen in the variant's runs on these tasks, sorted by name
function modelsOf(db: Db, variantId: string, taskIds: string[]): string[] {
  return db
    .selectDistinct({ model: runs.model })
    .from(runs)
    .where(and(eq(runs.variantId, variantId), inArray(runs.taskId, taskIds)))
    .orderBy(asc(runs.model))
    .all()
    .map((r) => r.model);
}

// groupBy=variant: one cell per variant × task; groupBy=model: one cell per (variant, model) × task.
// By default excludes runs with human intervention, references to other runs, source reads, or cancellation; each of the four switches lets one class back in
export function compareRuns(db: Db, query: CompareQuery): CompareResult {
  const { workflowId, kind, stage } = compareScope(db, query);
  const workflow = loadWorkflow(db, workflowId);
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
        if (g === null) throw new Error(`Run ${run.id} has status ${run.status} but no grade`);
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
                stages: stageCosts(db, graded, workflow),
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
  return { ...query, workflowId, kind, cells };
}
