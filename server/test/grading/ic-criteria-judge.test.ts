import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { loadIcTask, saveTask, syncTasks } from '../../src/tasks/loader.js';
import { testRunId, withoutHiddenTests } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

// W12 的真实 ic run r-20261010-upfwvv（工单 TXE-3861）建出的 PR，只读取
const REPO = 'txehq/wfe-r-20261010-upfwvv';

const { db, close } = openTestDb();
afterAll(close);
syncTasks(db, config.tasksDir);
insertVariant(db, 'baseline');

describe('验收标准 judge（真实 gateway 与 GitHub）', { timeout: 10 * 60_000 }, () => {
  it('ic-money-format 去掉隐藏测试：对 PR #1 逐条评分，写入 ic_criteria 与 grade_items', async () => {
    const id = testRunId('w28-criteria');
    const definition = withoutHiddenTests(loadIcTask(db, 'ic-money-format'), 'w28-criteria-task');
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', id, 'tasks');
    const task = saveTask(db, tasksDir, definition);
    const runId = testRunId('w28-criteria-run');
    insertRun(db, { id: runId, taskId: task.task.id, variantId: 'baseline', githubRepo: REPO });

    await gradeRun(db, runId, new AbortController().signal);
    const grades = readRunGrades(db, runId);
    const out = path.join(config.repoRoot, '.work/grading');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic-criteria-grades.json'), JSON.stringify(grades, null, 2));
    expect(grades).toMatchObject({ kind: 'ic', lfg: null, ic: null });
    const criteria = grades?.icCriteria;
    if (criteria == null) throw new Error('没有验收标准评分');
    expect(criteria.items.map((i) => i.itemId)).toEqual(['ac1', 'ac2', 'ac3', 'ac4', 'ac5']);
    expect(criteria.items.map((i) => i.criterion)).toEqual(definition.ticket.acceptanceCriteria);
    for (const item of criteria.items) {
      expect([0, 1, 2]).toContain(item.score);
      expect(item.maxScore).toBe(2);
      expect(item.reasoning.length).toBeGreaterThan(10);
    }
    expect(criteria.maxScore).toBe(10);
    expect(criteria.detail.pr).toMatchObject({ number: 1 });
    expect(criteria.detail.checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
    expect(criteria.detail.diffChars).toBeGreaterThan(1000);
    expect(criteria.detail.endpoint).toMatchObject({ ciGreen: true, missingRequired: [] });
    expect(criteria.judgeModel).not.toBeNull();
    expect(criteria.costUsd).toBeGreaterThan(0);
    expect(grades?.costUsd).toBe(criteria.costUsd);
    console.log(
      `验收标准评分 ${String(criteria.score)} / ${String(criteria.maxScore)}，${String(criteria.judgeModel)}，输入 ${String(criteria.inputTokens)} 输出 ${String(criteria.outputTokens)} token，花费 $${criteria.costUsd.toFixed(4)}`,
    );
    for (const item of criteria.items) {
      console.log(`${item.itemId} ${String(item.score)}/2 ${item.reasoning}`);
    }
  });
});
