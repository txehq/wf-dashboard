import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { artifacts, gradeItems, grades, runs } from '../db/schema.js';
import { EVAL_TEAM, readIssueContent } from '../external/linear.js';
import { loadTask } from '../tasks/loader.js';
import type { ArtifactRubric, IcTask, LfgTask } from '../tasks/schema.js';
import { gradeIc } from './ic.js';
import { judgeArtifact, missingArtifactItems } from './rubric-judge.js';
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

// Tickets.md 中引用、且在 run 开始之后创建的工单视为该 run 建出的工单；Tickets.md 也会引用已有的相关工单
export async function ticketsContent(run: Run, snapshot: string): Promise<string> {
  if (run.startedAt === null) throw new Error(`run ${run.id} 没有 started_at`);
  const startedAt = run.startedAt.getTime();
  const identifiers = [...new Set(snapshot.match(new RegExp(`\\b${EVAL_TEAM}-\\d+\\b`, 'g')))];
  const issues = [];
  for (const identifier of identifiers) {
    const issue = await readIssueContent(identifier);
    if (Date.parse(issue.createdAt) >= startedAt) issues.push(issue);
  }
  const section =
    issues.length === 0
      ? 'Tickets.md 中没有引用该 run 建出的工单。'
      : issues
          .map((i) => `## ${i.id} ${i.title}\n\n${i.url}\n\n${i.description ?? '（正文为空）'}`)
          .join('\n\n');
  return `${snapshot}\n\n---\n\n# Linear 中该 run 建出的工单\n\n${section}`;
}

async function judgeGroup(run: Run, task: LfgTask, group: ArtifactRubric, rows: ArtifactRow[]) {
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
    group.artifact === 'tickets' ? await ticketsContent(run, artifact.snapshot) : artifact.snapshot;
  const judged = await judgeArtifact(task, group, content);
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

async function gradeLfg(db: Db, run: Run, task: LfgTask) {
  const rows = db.select().from(artifacts).where(eq(artifacts.runId, run.id)).all();
  const judged = await Promise.all(task.rubric.map((g) => judgeGroup(run, task, g, rows)));
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

async function gradeIcRun(db: Db, run: Run, task: IcTask) {
  if (run.githubRepo === null) throw new Error(`run ${run.id} 没有 GitHub 仓库`);
  const result = await gradeIc(task, run.id, run.githubRepo);
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
  // 评分错误写入 grades 之后让 run 失败，失败原因与 grades 中的 error 相同
  if (result.detail.error !== null) throw new Error(result.detail.error);
}

// runs 模块在进入 grading 时调用；全部评分完成后一次写入，任何一步失败都不留下部分结果
export async function gradeRun(db: Db, runId: string): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`没有 run ${runId}`);
  if (db.select({ id: grades.id }).from(grades).where(eq(grades.runId, runId)).get()) {
    throw new Error(`run ${runId} 已经评分过`);
  }
  const task = loadTask(db, run.taskId);
  if (task.kind === 'lfg') await gradeLfg(db, run, task);
  else await gradeIcRun(db, run, task);
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
    });
  }
  const groups = rows.map((g): ArtifactGrade => {
    if (g.artifact === null)
      throw new Error(`run ${runId} 的 rubric 评分 ${String(g.id)} 没有产物组`);
    const items = db
      .select()
      .from(gradeItems)
      .where(eq(gradeItems.gradeId, g.id))
      .orderBy(asc(gradeItems.id))
      .all()
      .map(({ itemId, criterion, score, maxScore, reasoning }) => ({
        itemId,
        criterion,
        score,
        maxScore,
        reasoning,
      }));
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
  });
}
