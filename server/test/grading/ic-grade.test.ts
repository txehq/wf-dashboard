import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts } from '../../src/db/schema.js';
import {
  branchFrom,
  checksFrom,
  endpointFrom,
  latestPrFrom,
  prInfoFrom,
  snapshotFrom,
} from '../../src/external/github.js';
import { gradeIcPr } from '../../src/grading/ic.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { StoredPrSnapshot, storePrSnapshot } from '../../src/grading/pr-snapshot.js';
import { exportRun } from '../../src/insights/export.js';
import { saveTask } from '../../src/tasks/loader.js';
import type { PrTask, Task, TestsTask } from '../../src/tasks/schema.js';
import { recordedPr } from '../helpers/gh-fixtures.js';
import { buildFixtureTask, testRunId, withoutHiddenTests } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

const { db, close } = openTestDb();
insertVariant(db, 'baseline');
afterAll(close);

// 录下的真实 PR（scripts/record-gh-fixtures.ts）：W7 fixture 的 subtract PR，ready、ci 通过，带 review、文件评论与对话区评论；
// head 的完整历史在 pr-head.bundle 中
const graded = recordedPr('grade-pr');
const latest = latestPrFrom(graded.stdout('list'));
if (latest === null) throw new Error('grade-pr 的录制中没有 PR');
const checks = checksFrom(graded.repo, graded.pr(), graded.result('checks'));
const prInfo = prInfoFrom(latest, checks);
const branch = branchFrom(graded.stdout('branch'));
// 没有任何 PR 的真实仓库（只读）：评分的"没有 PR"路径照常读 GitHub
const NO_PR_REPO = recordedPr('no-pr').repo;

// W7 fixture 的 task 写成 tasks/<id>/task.yaml 并同步进 tasks 表
async function fixtureTask(timeoutSeconds = 600): Promise<TestsTask & PrTask> {
  const id = testRunId('w9-ic-task');
  const { dir, ...definition } = await buildFixtureTask(id, timeoutSeconds);
  const tasksDir = path.join(config.repoRoot, '.work/test-tasks', id, 'tasks');
  fs.cpSync(dir, path.join(tasksDir, definition.id), { recursive: true });
  const record = saveTask(db, tasksDir, definition);
  return { ...definition, dir: record.dir };
}

// 隐藏测试在录下的 PR head 上运行，终点由录下的 pr view 与 pr checks 判定
const gradeRecorded = (task: TestsTask, runId: string) =>
  gradeIcPr(
    task,
    runId,
    { pr: prInfo, branch },
    {
      checkout: (dest) => graded.checkout(prInfo.head, dest),
      endpoint: () =>
        Promise.resolve(endpointFrom(graded.stdout('endpoint'), checks, task.requiredChecks)),
    },
    new AbortController().signal,
  );

describe('ic 评分（录下的 PR 与只读的 GitHub）', { timeout: 10 * 60_000 }, () => {
  it('有 PR：隐藏测试 3 / 8，PR、分支、head 与终点写入明细，评分后删除 checkout', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic');
    const ic = await gradeRecorded(task, runId);
    const outDir = path.join(config.repoRoot, '.work/grading');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'ic-grades.json'), JSON.stringify(ic, null, 2));
    expect(ic).toMatchObject({ testsPassed: 3, testsDeclared: 8, reachedEnd: true });
    expect(ic.detail.pr).toEqual({
      number: 1,
      url: `https://github.com/${graded.repo}/pull/1`,
      branch: 'feat/test-change',
      head: 'c47fec0d5aec772afae43f4038748040489c3011',
    });
    expect(ic.detail.endpoint).toEqual({
      reached: true,
      ciGreen: true,
      isDraft: false,
      head: 'c47fec0d5aec772afae43f4038748040489c3011',
      missingRequired: [],
    });
    expect(ic.detail.fileErrors.map((e) => e.file)).toEqual(['test/hidden/divide.hidden.test.js']);
    expect(ic.detail.outcomes.map((o) => [o.name, o.outcome])).toEqual([
      ['subtract(5, 3) returns 2', 'passed'],
      ['subtract handles negatives', 'passed'],
      ['add still works', 'passed'],
      ['subtract(0.3, 0.1) returns exactly 0.2', 'failed'],
      ['multiply(2, 3) returns 6', 'failed'],
      ['multiply by zero', 'failed'],
      ['divide(6, 3) returns 2', 'not-run'],
      ['divide by one', 'not-run'],
    ]);
    expect(fs.existsSync(path.join(config.runsDir, runId, 'grading/junit.xml'))).toBe(true);
    // W15 Medium 18：评分之后删除 checkout（含 node_modules）与评分用的 HOME
    for (const dir of ['checkout', 'home', 'tmp']) {
      expect(fs.existsSync(path.join(config.runsDir, runId, 'grading', dir)), dir).toBe(false);
    }
  });

  it('终点判定读到的 head 与 checkout 不同时抛错', async () => {
    const task = await fixtureTask();
    const moved = graded.stdout('endpoint').replace(prInfo.head, 'f'.repeat(40));
    await expect(
      gradeIcPr(
        task,
        testRunId('w9-ic-moved'),
        { pr: prInfo, branch },
        {
          checkout: (dest) => graded.checkout(prInfo.head, dest),
          endpoint: () => Promise.resolve(endpointFrom(moved, checks, task.requiredChecks)),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(`的 head 在评分期间变化：${prInfo.head} → ${'f'.repeat(40)}`);
  });

  it('PR 快照包含 review、review thread 与对话区评论；run.json 优先取快照，仓库没有 PR 或不存在时现读', async () => {
    const snapshot = snapshotFrom(
      graded.repo,
      prInfo,
      graded.stdout('snapshot'),
      graded.stdout('reviewThreads'),
    );
    const task = await fixtureTask();
    const runId = testRunId('w31-snapshot');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: graded.repo });
    storePrSnapshot(db, runId, graded.repo, snapshot);
    const stored = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'pr_snapshot')))
      .get();
    expect(stored?.location).toBe(`https://github.com/${graded.repo}`);
    expect(StoredPrSnapshot.parse(JSON.parse(stored?.snapshot ?? 'null')).pr).toEqual(snapshot);
    const exported = (await exportRun(db, runId)) as {
      task: Record<string, unknown>;
      pr: { source: string } & StoredPrSnapshot;
    };
    expect(exported.pr.source).toBe('snapshot');
    const pr = exported.pr.pr;
    expect(pr).toMatchObject({ number: 1, head: prInfo.head, isDraft: false, state: 'OPEN' });
    expect(pr?.checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
    expect(pr?.comments.map((c) => c.body)).toEqual(['W31 快照：对话区评论']);
    expect(pr?.reviews.map((r) => [r.state, r.body])).toContainEqual([
      'COMMENTED',
      'W31 快照：review',
    ]);
    expect(pr?.reviewThreads).toEqual([
      expect.objectContaining({
        path: 'src/math.js',
        isResolved: false,
        comments: [expect.objectContaining({ body: 'W31 快照：文件评论' })],
      }),
    ]);
    // task 中没有隐藏需求、rubric 与隐藏测试
    expect(Object.keys(exported.task).sort()).toEqual(
      ['bigStage', 'id', 'persona', 'requiredChecks', 'ticket', 'title', 'workflow'].sort(),
    );

    // 没有快照的旧 run：仓库存在时现读，仓库不存在时记为不可用
    const live = testRunId('w31-live');
    insertRun(db, { id: live, taskId: task.id, variantId: 'baseline', githubRepo: NO_PR_REPO });
    expect(((await exportRun(db, live)) as { pr: unknown }).pr).toEqual({
      source: 'github',
      pr: null,
    });
    const gone = testRunId('w31-gone');
    insertRun(db, {
      id: gone,
      taskId: task.id,
      variantId: 'baseline',
      githubRepo: `txehq/wfe-test-w31-missing-${gone}`,
    });
    const unavailable = ((await exportRun(db, gone)) as { pr: { unavailable: string } }).pr;
    expect(unavailable.unavailable).toContain('HTTP 404');
  });

  it('没有 PR：gradeRun 记 0 / 声明数，终点为否，存下空的 PR 快照', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic-nopr');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: NO_PR_REPO });
    await gradeRun(db, runId, new AbortController().signal);
    const grades = readRunGrades(db, runId);
    const ic = grades?.hiddenTests;
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8 });
    expect(grades?.endpoint).toEqual({ reached: false, detail: null });
    expect(ic?.detail.pr).toBeNull();
    expect(ic?.detail.endpoint).toBeNull();
    expect(ic?.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
    expect(fs.existsSync(path.join(config.runsDir, runId, 'grading'))).toBe(false);
    const stored = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'pr_snapshot')))
      .get();
    expect(StoredPrSnapshot.parse(JSON.parse(stored?.snapshot ?? 'null')).pr).toBeNull();
  });

  // Contracts 7.9：checkout 内的步骤超时是 agent 的结果，评分照常完成
  it('评分步骤超时：0 / 8 与超时错误，评分正常结束', async () => {
    // 时限 1 秒，npm ci 一定超时；测试命令中的死循环由 isolation.test.ts 覆盖
    const timeoutSeconds = 1;
    const task = await fixtureTask(timeoutSeconds);
    const ic = await gradeRecorded(task, testRunId('w18a-ic-timeout'));
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8, reachedEnd: true });
    expect(ic.detail.error).toBe(`npm ci 超过 ${String(timeoutSeconds)} 秒没有结束，已强制结束`);
    expect(ic.detail.pr?.head).toBe(prInfo.head);
    expect(ic.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
  });

  // Contracts 第 13 节：没有隐藏测试时按验收标准评分；没有 PR 时每条记 0 分，不调用 judge
  it('没有隐藏测试、没有 PR：验收标准每条 0 / 2，终点为否，没有 judge 花费', async () => {
    const id = testRunId('w28-criteria-nopr');
    const fixture = await buildFixtureTask(id);
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', id, 'tasks');
    fs.cpSync(fixture.dir, path.join(tasksDir, 'w28-criteria-nopr'), { recursive: true });
    const record = saveTask(db, tasksDir, withoutHiddenTests(fixture, 'w28-criteria-nopr'));
    const runId = testRunId('w28-criteria-nopr-run');
    insertRun(db, {
      id: runId,
      taskId: record.task.id,
      variantId: 'baseline',
      githubRepo: NO_PR_REPO,
    });
    await gradeRun(db, runId, new AbortController().signal);
    const grades = readRunGrades(db, runId);
    expect(grades).toMatchObject({ costUsd: 0, rubric: null, hiddenTests: null });
    expect(grades?.endpoint).toEqual({ reached: false, detail: null });
    expect(grades?.criteria).toMatchObject({
      score: 0,
      maxScore: 4,
      judgeModel: null,
      detail: { pr: null, endpoint: null, checks: [], diffChars: 0 },
    });
    expect(grades?.criteria?.items.map((i) => [i.itemId, i.score, i.reasoning])).toEqual([
      ['ac1', 0, '该 run 没有建出 PR，该条记 0 分。'],
      ['ac2', 0, '该 run 没有建出 PR，该条记 0 分。'],
    ]);
  });

  it('没有仓库的 run 评分抛错，不写 grades', async () => {
    const task: Task = await fixtureTask();
    const runId = testRunId('w9-ic-norepo');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline' });
    await expect(gradeRun(db, runId, new AbortController().signal)).rejects.toThrow(
      `run ${runId} 没有仓库`,
    );
    expect(readRunGrades(db, runId)).toBeNull();
  });
});
