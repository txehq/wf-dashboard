import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, gradeItems, grades, requests, runs } from '../db/schema.js';
import { icEndpoint, readPr } from '../external/github.js';
import { readIssueContent } from '../external/linear.js';
import { inputField } from '../stages/rows.js';
import { loadTask, withHiddenTests, withPr, withRepo, withRubric } from '../tasks/loader.js';
import type { ArtifactRubric, RubricTask, Task } from '../tasks/schema.js';
import { evalSpecOf, workflowOfVariant } from '../workflows/index.js';
import { hasGrading, rubricOf } from '../workflows/schema.js';
import { gradeIc } from './ic.js';
import { gradeIcCriteria } from './ic-criteria.js';
import { judgeArtifact, type JudgeStage, missingArtifactItems } from './rubric-judge.js';
import { recordPrSnapshot } from './pr-snapshot.js';
import { type ArtifactGrade, type GradeItem, IcEndpoint, RunGrades } from './schema.js';

type Run = typeof runs.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;

interface JudgedGroup {
  group: ArtifactRubric;
  artifact: ArtifactRow | undefined;
  items: GradeItem[];
  judgeModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const LINEAR_SAVE_ISSUE = /^mcp__.*linear.*__save_issue$/i;
const SavedIssue = z.looseObject({ id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/) });

// Tickets this run created (Contracts 7.9): identifiers returned by successful Linear save_issue create calls in the run's session (subagents included)
// (input without id; with id it edits an existing ticket), in call order
export function createdTickets(db: Db, run: Run): string[] {
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, run.sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  const out: string[] = [];
  for (const call of rows.flatMap((r) => r.toolCalls)) {
    if (!LINEAR_SAVE_ISSUE.test(call.name) || inputField(call.input, 'id') !== undefined) continue;
    if (call.isError || call.result === null) continue;
    if (call.resultChars > call.result.length) {
      throw new Error(`Result of save_issue ${call.id} is truncated, created ticket unreadable`);
    }
    const { id } = SavedIssue.parse(JSON.parse(call.result));
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// The linearTickets artifact: the file snapshot plus title and body of the tickets this run created in Linear
export async function ticketsContent(db: Db, run: Run, snapshot: string): Promise<string> {
  const issues = [];
  for (const identifier of createdTickets(db, run)) {
    issues.push(await readIssueContent(identifier));
  }
  const section =
    issues.length === 0
      ? 'This run created no tickets in Linear.'
      : issues
          .map((i) => `## ${i.id} ${i.title}\n\n${i.url}\n\n${i.description ?? '(empty body)'}`)
          .join('\n\n');
  return `${snapshot}\n\n---\n\n# Tickets this run created in Linear\n\n${section}`;
}

async function judgeGroup(
  db: Db,
  run: Run,
  task: RubricTask,
  judging: JudgeStage,
  group: ArtifactRubric,
  rows: ArtifactRow[],
  signal: AbortSignal,
) {
  const artifact = rows.find((a) => a.kind === group.artifact);
  if (artifact === undefined) {
    return {
      group,
      artifact,
      items: missingArtifactItems(group),
      judgeModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    } satisfies JudgedGroup;
  }
  if (artifact.snapshot === null) {
    throw new Error(`Artifact ${group.artifact} of run ${run.id} has no content snapshot`);
  }
  const spec = judging.artifacts.find((a) => a.id === group.artifact);
  const content =
    spec?.linearTickets === true
      ? await ticketsContent(db, run, artifact.snapshot)
      : artifact.snapshot;
  signal.throwIfAborted();
  const judged = await judgeArtifact(task, judging, group, content, signal);
  return {
    group,
    artifact,
    items: judged.items,
    judgeModel: judged.model,
    inputTokens: judged.usage.inputTokens,
    outputTokens: judged.usage.outputTokens,
    costUsd: judged.costUsd,
  } satisfies JudgedGroup;
}

// rubric block: one judge call per artifact (lfg grading, Contracts 7.9)
async function gradeRubric(
  db: Db,
  run: Run,
  task: RubricTask,
  judging: JudgeStage,
  signal: AbortSignal,
) {
  const rows = db.select().from(artifacts).where(eq(artifacts.runId, run.id)).all();
  const judged = await Promise.all(
    task.rubric.map((g) => judgeGroup(db, run, task, judging, g, rows, signal)),
  );
  signal.throwIfAborted();
  db.transaction((tx) => {
    for (const j of judged) {
      const grade = tx
        .insert(grades)
        .values({
          runId: run.id,
          kind: 'rubric',
          artifact: j.group.artifact,
          artifactId: j.artifact?.id ?? null,
          judgeModel: j.judgeModel,
          inputTokens: j.inputTokens,
          outputTokens: j.outputTokens,
          costUsd: j.costUsd,
        })
        .returning({ id: grades.id })
        .get();
      tx.insert(gradeItems)
        .values(j.items.map((i) => ({ gradeId: grade.id, ...i })))
        .run();
    }
  });
}

// hidden-tests block; endpoint tells whether the eval kind has pr-endpoint
async function gradeHiddenTests(
  db: Db,
  run: Run,
  task: Task,
  repo: string,
  endpoint: boolean,
  signal: AbortSignal,
) {
  const result = await gradeIc(withHiddenTests(task), run.id, repo, signal);
  db.insert(grades)
    .values({
      runId: run.id,
      kind: 'ic',
      testsPassed: result.testsPassed,
      testsDeclared: result.testsDeclared,
      reachedEnd: endpoint ? result.reachedEnd : null,
      icDetail: result.detail,
    })
    .run();
  // detail.error is a failure caused by the agent's code (Contracts 7.9): already scored 0 / declared, grading completes as usual
}

// criteria-judge block: one judge call grades each acceptance criterion (Contracts section 13); items go to grade_items
async function gradeCriteria(
  db: Db,
  run: Run,
  task: Task,
  repo: string,
  endpoint: boolean,
  signal: AbortSignal,
) {
  const result = await gradeIcCriteria(withPr(task), repo, signal);
  signal.throwIfAborted();
  db.transaction((tx) => {
    const grade = tx
      .insert(grades)
      .values({
        runId: run.id,
        kind: 'ic_criteria',
        judgeModel: result.judge?.model ?? null,
        inputTokens: result.judge?.usage.inputTokens ?? 0,
        outputTokens: result.judge?.usage.outputTokens ?? 0,
        costUsd: result.judge?.costUsd ?? 0,
        reachedEnd: endpoint ? result.reachedEnd : null,
        criteriaDetail: result.detail,
      })
      .returning({ id: grades.id })
      .get();
    tx.insert(gradeItems)
      .values(result.items.map((i) => ({ gradeId: grade.id, ...i })))
      .run();
  });
}

// Only pr-endpoint chosen: endpoint verdict of the repo's latest PR; false without a PR
async function gradeEndpoint(db: Db, run: Run, task: Task, repo: string) {
  const pr = await readPr(repo);
  const endpoint =
    pr === null ? null : await icEndpoint(repo, pr.number, withRepo(task).requiredChecks);
  db.insert(grades)
    .values({
      runId: run.id,
      kind: 'endpoint',
      reachedEnd: endpoint?.reached ?? false,
      icDetail: {
        pr: null,
        outcomes: [],
        fileErrors: [],
        endpoint,
        error: null,
      },
    })
    .run();
}

// Called by the runs module on entering grading: runs the grading blocks of the eval kind of the run's variant's workflow (Contracts 16.2). Writes once after all grading finishes,
// so a failing step leaves no partial result. When signal aborts (grading cancelled, server shutting down) it kills grading subprocesses and model requests, throws signal.reason and writes nothing
export async function gradeRun(db: Db, runId: string, signal: AbortSignal): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`No run ${runId}`);
  if (db.select({ id: grades.id }).from(grades).where(eq(grades.runId, runId)).get()) {
    throw new Error(`Run ${runId} is already graded`);
  }
  const task = loadTask(db, run.taskId);
  const stage = evalSpecOf(db, workflowOfVariant(db, run.variantId));
  await recordPrSnapshot(db, run);
  signal.throwIfAborted();
  const rubric = rubricOf(stage);
  if (rubric !== null) {
    await gradeRubric(db, run, withRubric(task), { stage, artifacts: rubric }, signal);
  }
  const tests = hasGrading(stage, 'hidden-tests') && task.hiddenTests !== undefined;
  const criteria = hasGrading(stage, 'criteria-judge') && !tests;
  const endpoint = hasGrading(stage, 'pr-endpoint');
  if (!tests && !criteria && !endpoint) return;
  if (run.githubRepo === null) throw new Error(`Run ${run.id} has no repo`);
  if (tests) await gradeHiddenTests(db, run, task, run.githubRepo, endpoint, signal);
  else if (criteria) await gradeCriteria(db, run, task, run.githubRepo, endpoint, signal);
  else await gradeEndpoint(db, run, task, run.githubRepo);
}

// null while not yet graded
export function readRunGrades(db: Db, runId: string): RunGrades | null {
  const rows = db
    .select()
    .from(grades)
    .where(eq(grades.runId, runId))
    .orderBy(asc(grades.id))
    .all();
  if (rows.length === 0) return null;
  const costUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const itemsOf = (gradeId: number) =>
    db
      .select()
      .from(gradeItems)
      .where(eq(gradeItems.gradeId, gradeId))
      .orderBy(asc(gradeItems.id))
      .all()
      .map(({ itemId, criterion, score, maxScore, reasoning }) => ({
        itemId,
        criterion,
        score,
        maxScore,
        reasoning,
      }));

  const rubricRows = rows.filter((r) => r.kind === 'rubric');
  const groups = rubricRows.map((g): ArtifactGrade => {
    if (g.artifact === null)
      throw new Error(`Rubric grade ${String(g.id)} of run ${runId} has no artifact group`);
    const items = itemsOf(g.id);
    return {
      artifact: g.artifact,
      present: g.judgeModel !== null,
      artifactId: g.artifactId,
      judgeModel: g.judgeModel,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      costUsd: g.costUsd,
      score: items.reduce((sum, i) => sum + i.score, 0),
      maxScore: items.reduce((sum, i) => sum + i.maxScore, 0),
      items,
    };
  });

  const ic = rows.find((r) => r.kind === 'ic');
  if (
    ic !== undefined &&
    (ic.testsPassed === null || ic.testsDeclared === null || ic.icDetail === null)
  ) {
    throw new Error(`Hidden tests grade of run ${runId} is incomplete`);
  }
  const criteria = rows.find((r) => r.kind === 'ic_criteria');
  if (criteria?.criteriaDetail === null) {
    throw new Error(`Acceptance criteria grade of run ${runId} is incomplete`);
  }
  const criteriaItems = criteria === undefined ? [] : itemsOf(criteria.id);
  const endpointRow = rows.find((r) => r.kind !== 'rubric' && r.reachedEnd !== null);
  const endpointDetail =
    endpointRow === undefined
      ? null
      : (endpointRow.icDetail?.endpoint ?? endpointRow.criteriaDetail?.endpoint ?? null);

  return RunGrades.parse({
    runId,
    costUsd,
    rubric:
      rubricRows.length === 0
        ? null
        : {
            artifacts: groups,
            score: groups.reduce((sum, g) => sum + g.score, 0),
            maxScore: groups.reduce((sum, g) => sum + g.maxScore, 0),
          },
    hiddenTests:
      ic === undefined
        ? null
        : { testsPassed: ic.testsPassed, testsDeclared: ic.testsDeclared, detail: ic.icDetail },
    criteria:
      criteria === undefined
        ? null
        : {
            items: criteriaItems,
            score: criteriaItems.reduce((sum, i) => sum + i.score, 0),
            maxScore: criteriaItems.reduce((sum, i) => sum + i.maxScore, 0),
            judgeModel: criteria.judgeModel,
            inputTokens: criteria.inputTokens,
            outputTokens: criteria.outputTokens,
            costUsd: criteria.costUsd,
            detail: criteria.criteriaDetail,
          },
    endpoint:
      endpointRow === undefined
        ? null
        : {
            reached: endpointRow.reachedEnd,
            detail: endpointDetail === null ? null : IcEndpoint.parse(endpointDetail),
          },
  });
}
