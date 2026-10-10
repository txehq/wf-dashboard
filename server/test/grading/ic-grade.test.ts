import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { saveTask } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { buildFixtureTask, testRunId } from '../helpers/ic-fixture.js';
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
    await gradeRun(db, runId);
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
    await gradeRun(db, runId);
    const ic = readRunGrades(db, runId)?.ic;
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8, reachedEnd: false });
    expect(ic?.detail.pr).toBeNull();
    expect(ic?.detail.endpoint).toBeNull();
    expect(ic?.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
    expect(fs.existsSync(path.join(config.runsDir, runId, 'grading'))).toBe(false);
  });

  it('隐藏测试超时：写入 0 / 8 与超时错误，gradeRun 抛出同样的错误', async () => {
    // 每次评分的 npm 缓存都是空的，并行跑全部测试时 npm ci 需要几十秒
    const timeoutSeconds = 90;
    const task = await fixtureTask(timeoutSeconds);
    fs.writeFileSync(
      path.join(task.dir, task.hiddenTests.dir, 'divide.hidden.test.js'),
      'while (true) {}\n',
    );
    const runId = testRunId('w18a-ic-timeout');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline', githubRepo: REPO_WITH_PR });
    const message = `隐藏测试命令 超过 ${String(timeoutSeconds)} 秒没有结束，已强制结束`;
    await expect(gradeRun(db, runId)).rejects.toThrow(message);
    const ic = readRunGrades(db, runId)?.ic;
    expect(ic).toMatchObject({ testsPassed: 0, testsDeclared: 8, reachedEnd: true });
    expect(ic?.detail.error).toBe(message);
    expect(ic?.detail.pr?.head).toBe(PR_HEAD);
    expect(ic?.detail.outcomes.every((o) => o.outcome === 'not-run')).toBe(true);
  });

  it('没有 GitHub 仓库的 run 评分抛错，不写 grades', async () => {
    const task = await fixtureTask();
    const runId = testRunId('w9-ic-norepo');
    insertRun(db, { id: runId, taskId: task.id, variantId: 'baseline' });
    await expect(gradeRun(db, runId)).rejects.toThrow('没有 GitHub 仓库');
    expect(readRunGrades(db, runId)).toBeNull();
  });
});
