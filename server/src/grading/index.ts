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

// 该 run 建出的工单（Contracts 7.9）：run 的 session（含子代理）中 Linear save_issue 成功的新建调用
// （输入不带 id；带 id 的是修改已有工单）返回的 identifier，按调用顺序
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
      throw new Error(`save_issue ${call.id} 的结果被截断，读不到建出的工单`);
    }
    const { id } = SavedIssue.parse(JSON.parse(call.result));
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// linearTickets 的产物：文件快照加上 Linear 中该 run 建出的工单的标题与正文
export async function ticketsContent(db: Db, run: Run, snapshot: string): Promise<string> {
  const issues = [];
  for (const identifier of createdTickets(db, run)) {
    issues.push(await readIssueContent(identifier));
  }
  const section =
    issues.length === 0
      ? '该 run 没有在 Linear 中建出工单。'
      : issues
          .map((i) => `## ${i.id} ${i.title}\n\n${i.url}\n\n${i.description ?? '（正文为空）'}`)
          .join('\n\n');
  return `${snapshot}\n\n---\n\n# Linear 中该 run 建出的工单\n\n${section}`;
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
    throw new Error(`run ${run.id} 的 ${group.artifact} 产物没有内容快照`);
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

// rubric 积木：每个产物一次 judge 调用（Contracts 7.9 的 lfg 评分）
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

// hidden-tests 积木；endpoint 为大阶段是否选了 pr-endpoint
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
  // detail.error 是 agent 的代码造成的失败（Contracts 7.9）：已记 0 / 声明数，评分照常完成
}

// criteria-judge 积木：一次 judge 调用按验收标准逐条评分（Contracts 第 13 节），条目写 grade_items
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

// 只选了 pr-endpoint：仓库中最新的 PR 的终点判定；没有 PR 时为否
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

// runs 模块在进入 grading 时调用：按 run 所用 variant 的 workflow 的评测类型的评分积木执行（Contracts 16.2）。全部评分完成后一次写入，
// 任何一步失败都不留下部分结果。signal 中止（取消评分、服务关闭）时结束评分的子进程与模型请求，抛出 signal.reason，不写入
export async function gradeRun(db: Db, runId: string, signal: AbortSignal): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`没有 run ${runId}`);
  if (db.select({ id: grades.id }).from(grades).where(eq(grades.runId, runId)).get()) {
    throw new Error(`run ${runId} 已经评分过`);
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
  if (run.githubRepo === null) throw new Error(`run ${run.id} 没有仓库`);
  if (tests) await gradeHiddenTests(db, run, task, run.githubRepo, endpoint, signal);
  else if (criteria) await gradeCriteria(db, run, task, run.githubRepo, endpoint, signal);
  else await gradeEndpoint(db, run, task, run.githubRepo);
}

// 尚未评分时为 null
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
      throw new Error(`run ${runId} 的 rubric 评分 ${String(g.id)} 没有产物组`);
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
    throw new Error(`run ${runId} 的隐藏测试评分不完整`);
  }
  const criteria = rows.find((r) => r.kind === 'ic_criteria');
  if (criteria?.criteriaDetail === null) {
    throw new Error(`run ${runId} 的验收标准评分不完整`);
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
