import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, runs } from '../../src/db/schema.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { recordPrSnapshot, StoredPrSnapshot } from '../../src/grading/pr-snapshot.js';
import { exportRun } from '../../src/insights/export.js';
import { saveTask } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import {
  buildFixtureTask,
  fixtureDir,
  testRunId,
  withoutHiddenTests,
} from '../helpers/ic-fixture.js';
import { repoWithoutPr, repoWithReadyPr } from '../helpers/test-repos.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

const { db, close } = openTestDb();
insertVariant(db, 'baseline');

// W7 fixture 的 IcTask 写成 tasks/<id>/task.yaml 并同步进 tasks 表
async function fixtureTask(timeoutSeconds = 600): Promise<IcTask> {
  const id = testRunId('w9-ic-task');
  const { dir, ...definition } = await buildFixtureTask(id, timeoutSeconds);
  const tasksDir = path.join(config.repoRoot, '.work/test-tasks', id, 'tasks');
  fs.cpSync(dir, path.join(tasksDir, definition.id), { recursive: true });
  const record = saveTask(db, tasksDir, definition);
  return { ...definition, dir: record.dir };
}

// 测试运行时现建的仓库（createRunRepo）：一个推了 W7 fixture 的实现分支、PR 已 ready 且 CI 结束；一个没有 PR
let REPO_WITH_PR = '';
let PR_HEAD = '';
let PR_BRANCH = '';
let REPO_WITHOUT_PR = '';

beforeAll(async () => {
  const task = await buildFixtureTask(testRunId('w9-ic-repo'));
  const [withPr, withoutPr] = await Promise.all([
    repoWithReadyPr(task, 'grade-pr', path.join(fixtureDir, 'pr'), 'feat: subtract'),
    repoWithoutPr(task, 'grade-nopr'),
  ]);
  REPO_WITH_PR = withPr.repo;
  PR_HEAD = withPr.head;
  PR_BRANCH = withPr.branch;
  REPO_WITHOUT_PR = withoutPr;
}, 15 * 60_000);

afterAll(close);

describe('ic 评分（测试现建的 GitHub 仓库）', { timeout: 10 * 60_000 }, () => {
  it('有 PR：隐藏测试 3 / 8 与终点判定写入 grades', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: REPO_WITH_PR });
    await gradeRun(db, runId, new AbortController().signal);
    const grades = readRunGrades(db, runId);
    const outDir = path.join(config.repoRoot, '.work/grading');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'ic-grades.json'), JSON.stringify(grades, null, 2));
    expect(grades).toMatchObject({ runId, kind: 'ic', costUsd: 0, lfg: null });
    const ic = grades?.ic;
    expect(ic).toMatchObject({ testsPassed: 3, testsDeclared: 8, reachedEnd: true });
    expect(ic?.detail.pr).toEqual({
      number: 1,
      url: `https://github.com/${REPO_WITH_PR}/pull/1`,
      branch: PR_BRANCH,
      head: PR_HEAD,
    });
    expect(ic?.detail.endpoint).toEqual({
      reached: true,
      ciGreen: true,
      isDraft: false,
      head: PR_HEAD,
      missingRequired: [],
    });
    expect(ic?.detail.fileErrors.map((e) => e.file)).toEqual(['test/hidden/divide.hidden.test.js']);
    expect(ic?.detail.outcomes.map((o) => [o.name, o.outcome])).toEqual([
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
    // Contracts 15.2：进入 grading 时存下 PR 的快照
    const stored = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'pr_snapshot')))
      .get();
    expect(stored?.location).toBe(`https://github.com/${REPO_WITH_PR}`);
    const snapshot = StoredPrSnapshot.parse(JSON.parse(stored?.snapshot ?? 'null'));
    expect(snapshot.pr).toMatchObject({ number: 1, head: PR_HEAD, isDraft: false, state: 'OPEN' });
    expect(snapshot.pr?.checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
  });

  it('PR 快照包含 review、review thread 与对话区评论；run.json 优先取快照，仓库不存在时记为不可用', async () => {
    const gh = async (args: string[], input?: string) =>
      (await execa('gh', args, input === undefined ? {} : { input })).stdout;
    await gh(['pr', 'comment', '1', '--repo', REPO_WITH_PR, '--body', 'W31 快照：对话区评论']);
    await gh([
      'pr',
      'review',
      '1',
      '--repo',
      REPO_WITH_PR,
      '--comment',
      '--body',
      'W31 快照：review',
    ]);
    await gh(
      ['api', `repos/${REPO_WITH_PR}/pulls/1/comments`, '--input', '-'],
      JSON.stringify({
        body: 'W31 快照：文件评论',
        commit_id: PR_HEAD,
        path: 'src/math.js',
        subject_type: 'file',
      }),
    );
    const task = await fixtureTask();
    const runId = testRunId('w31-snapshot');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: REPO_WITH_PR });
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) throw new Error('run 不存在');
    await recordPrSnapshot(db, run);
    const exported = (await exportRun(db, runId)) as {
      task: Record<string, unknown>;
      pr: { source: string } & StoredPrSnapshot;
    };
    expect(exported.pr.source).toBe('snapshot');
    const pr = exported.pr.pr;
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
      ['id', 'kind', 'persona', 'requiredChecks', 'ticket', 'title'].sort(),
    );

    // 没有快照的旧 run：仓库存在时现读，仓库不存在时记为不可用
    const live = testRunId('w31-live');
    insertRun(db, {
      id: live,
      taskId: task.id,
      variantId: 'baseline',
      githubRepo: REPO_WITHOUT_PR,
    });
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

  it('没有 PR：测试记 0 / 声明数，终点为否', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic-nopr');
    insertRun(db, {
      id: runId,
      taskId: task.id,
      variantId: 'baseline',
      githubRepo: REPO_WITHOUT_PR,
    });
    await gradeRun(db, runId, new AbortController().signal);
    const ic = readRunGrades(db, runId)?.ic;
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8, reachedEnd: false });
    expect(ic?.detail.pr).toBeNull();
    expect(ic?.detail.endpoint).toBeNull();
    expect(ic?.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
    expect(fs.existsSync(path.join(config.runsDir, runId, 'grading'))).toBe(false);
  });

  // Contracts 7.9：checkout 内的步骤超时是 agent 的结果，评分照常完成
  it('评分步骤超时：写入 0 / 8 与超时错误，gradeRun 正常结束', async () => {
    // 时限 1 秒，npm ci 一定超时；测试命令中的死循环由 isolation.test.ts 覆盖
    const timeoutSeconds = 1;
    const task = await fixtureTask(timeoutSeconds);
    const runId = testRunId('w18a-ic-timeout');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: REPO_WITH_PR });
    const message = `npm ci 超过 ${String(timeoutSeconds)} 秒没有结束，已强制结束`;
    await gradeRun(db, runId, new AbortController().signal);
    const ic = readRunGrades(db, runId)?.ic;
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8, reachedEnd: true });
    expect(ic?.detail.error).toBe(message);
    expect(ic?.detail.pr?.head).toBe(PR_HEAD);
    expect(ic?.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
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
      githubRepo: REPO_WITHOUT_PR,
    });
    await gradeRun(db, runId, new AbortController().signal);
    const grades = readRunGrades(db, runId);
    expect(grades).toMatchObject({ kind: 'ic', costUsd: 0, ic: null });
    expect(grades?.icCriteria).toMatchObject({
      score: 0,
      maxScore: 4,
      reachedEnd: false,
      judgeModel: null,
      detail: { pr: null, endpoint: null, checks: [], diffChars: 0 },
    });
    expect(grades?.icCriteria?.items.map((i) => [i.itemId, i.score, i.reasoning])).toEqual([
      ['ac1', 0, '该 run 没有建出 PR，该条记 0 分。'],
      ['ac2', 0, '该 run 没有建出 PR，该条记 0 分。'],
    ]);
  });

  it('没有 GitHub 仓库的 run 评分抛错，不写 grades', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic-norepo');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline' });
    await expect(gradeRun(db, runId, new AbortController().signal)).rejects.toThrow(
      '没有 GitHub 仓库',
    );
    expect(readRunGrades(db, runId)).toBeNull();
  });
});
