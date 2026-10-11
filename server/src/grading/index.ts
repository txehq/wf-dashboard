import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, gradeItems, grades, requests, runs } from '../db/schema.js';
import { readIssueContent } from '../external/linear.js';
import { inputField } from '../stages/rows.js';
import { loadTask } from '../tasks/loader.js';
import type { ArtifactRubric, IcTask, LfgTask } from '../tasks/schema.js';
import { gradeIc } from './ic.js';
import { gradeIcCriteria } from './ic-criteria.js';
import { judgeArtifact, missingArtifactItems } from './rubric-judge.js';
import { recordPrSnapshot } from './pr-snapshot.js';
import { type ArtifactGrade, type GradeItem, RunGrades } from './schema.js';

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

// tickets 产物：Tickets.md 加上 Linear 中该 run 建出的工单的标题与正文
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
  task: LfgTask,
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
  const content =
    group.artifact === 'tickets'
      ? await ticketsContent(db, run, artifact.snapshot)
      : artifact.snapshot;
  signal.throwIfAborted();
  const judged = await judgeArtifact(task, group, content, signal);
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

async function gradeLfg(db: Db, run: Run, task: LfgTask, signal: AbortSignal) {
  const rows = db.select().from(artifacts).where(eq(artifacts.runId, run.id)).all();
  const judged = await Promise.all(
    task.rubric.map((g) => judgeGroup(db, run, task, g, rows, signal)),
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

async function gradeIcRun(db: Db, run: Run, task: IcTask, signal: AbortSignal) {
  if (run.githubRepo === null) throw new Error(`run ${run.id} 没有 GitHub 仓库`);
  if (task.hiddenTests === undefined) {
    await gradeIcCriteriaRun(db, run, task, run.githubRepo, signal);
    return;
  }
  const result = await gradeIc(
    { ...task, hiddenTests: task.hiddenTests },
    run.id,
    run.githubRepo,
    signal,
  );
  db.insert(grades)
    .values({
      runId: run.id,
      kind: 'ic',
      testsPassed: result.testsPassed,
      testsDeclared: result.testsDeclared,
      reachedEnd: result.reachedEnd,
      icDetail: result.detail,
    })
    .run();
  // detail.error 是 agent 的代码造成的失败（Contracts 7.9）：已记 0 / 声明数，评分照常完成
}

// 没有隐藏测试：一次 judge 调用按验收标准逐条评分（Contracts 第 13 节），条目写 grade_items
async function gradeIcCriteriaRun(
  db: Db,
  run: Run,
  task: IcTask,
  repo: string,
  signal: AbortSignal,
) {
  const result = await gradeIcCriteria(task, repo, signal);
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
        reachedEnd: result.reachedEnd,
        criteriaDetail: result.detail,
      })
      .returning({ id: grades.id })
      .get();
    tx.insert(gradeItems)
      .values(result.items.map((i) => ({ gradeId: grade.id, ...i })))
      .run();
  });
}

// runs 模块在进入 grading 时调用；全部评分完成后一次写入，任何一步失败都不留下部分结果。
// signal 中止（取消评分、服务关闭）时结束评分的子进程与模型请求，抛出 signal.reason，不写入
export async function gradeRun(db: Db, runId: string, signal: AbortSignal): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`没有 run ${runId}`);
  if (db.select({ id: grades.id }).from(grades).where(eq(grades.runId, runId)).get()) {
    throw new Error(`run ${runId} 已经评分过`);
  }
  const task = loadTask(db, run.taskId);
  await recordPrSnapshot(db, run);
  signal.throwIfAborted();
  if (task.kind === 'lfg') await gradeLfg(db, run, task, signal);
  else await gradeIcRun(db, run, task, signal);
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
  const criteria = rows.find((r) => r.kind === 'ic_criteria');
  if (criteria !== undefined) {
    if (criteria.reachedEnd === null || criteria.criteriaDetail === null) {
      throw new Error(`run ${runId} 的验收标准评分不完整`);
    }
    const items = itemsOf(criteria.id);
    return RunGrades.parse({
      runId,
      kind: 'ic',
      costUsd,
      lfg: null,
      ic: null,
      icCriteria: {
        items,
        score: items.reduce((sum, i) => sum + i.score, 0),
        maxScore: items.reduce((sum, i) => sum + i.maxScore, 0),
        reachedEnd: criteria.reachedEnd,
        judgeModel: criteria.judgeModel,
        inputTokens: criteria.inputTokens,
        outputTokens: criteria.outputTokens,
        costUsd: criteria.costUsd,
        detail: criteria.criteriaDetail,
      },
    });
  }
  const ic = rows.find((r) => r.kind === 'ic');
  if (ic !== undefined) {
    if (
      ic.testsPassed === null ||
      ic.testsDeclared === null ||
      ic.reachedEnd === null ||
      ic.icDetail === null
    ) {
      throw new Error(`run ${runId} 的 ic 评分不完整`);
    }
    return RunGrades.parse({
      runId,
      kind: 'ic',
      costUsd,
      lfg: null,
      ic: {
        testsPassed: ic.testsPassed,
        testsDeclared: ic.testsDeclared,
        reachedEnd: ic.reachedEnd,
        detail: ic.icDetail,
      },
      icCriteria: null,
    });
  }
  const groups = rows.map((g): ArtifactGrade => {
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
  return RunGrades.parse({
    runId,
    kind: 'lfg',
    costUsd,
    lfg: {
      artifacts: groups,
      score: groups.reduce((sum, g) => sum + g.score, 0),
      maxScore: groups.reduce((sum, g) => sum + g.maxScore, 0),
    },
    ic: null,
    icCriteria: null,
  });
}
