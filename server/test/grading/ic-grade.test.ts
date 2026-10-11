import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { saveTask } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { buildFixtureTask, testRunId, withoutHiddenTests } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

// W7 外部测试建出的仓库，只读取：PR #1（feat/subtract）已 ready、CI 通过
const REPO_WITH_PR = 'txehq/wfe-w7-20261009101537820';
const PR_HEAD = 'e0075127ff5db648c67316338711da1d7bf171ef';
// W7 的另一次运行：main 已推送，没有 PR
const REPO_WITHOUT_PR = 'txehq/wfe-w7-20261009100328966';

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

afterAll(close);

describe('ic 评分（真实 GitHub 仓库，只读取）', { timeout: 10 * 60_000 }, () => {
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
      branch: 'feat/subtract',
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
