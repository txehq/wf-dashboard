import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeRun, readRunGrades } from '../../src/grading/index.js';
import { loadIcTask, saveTask, syncTasks } from '../../src/tasks/loader.js';
import { testRunId, withoutHiddenTests } from '../helpers/ic-fixture.js';
import { repoWithReadyPr } from '../helpers/test-repos.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

const { db, close } = openTestDb();
afterAll(close);
syncTasks(db, config.tasksDir);
insertVariant(db, 'baseline');

describe('验收标准 judge（真实 gateway 与 GitHub）', { timeout: 20 * 60_000 }, () => {
  it('ic-money-format 去掉隐藏测试：现建仓库，参考实现开 PR，逐条评分写入 ic_criteria 与 grade_items', async () => {
    const started = Date.now();
    const source = loadIcTask(db, 'ic-money-format');
    // 起始仓库照 ic-money-format 复制；PR 是 task 的参考实现（只改 src/，不加测试）
    const { repo, pr } = await repoWithReadyPr(
      source,
      'criteria-judge',
      path.join(source.dir, 'reference'),
      'fix: formatMoney uses the currency decimals, signs before the symbol, exact amounts',
    );
    const prepared = Date.now();
    const id = testRunId('w28-criteria');
    const definition = withoutHiddenTests(source, 'w28-criteria-task');
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', id, 'tasks');
    const task = saveTask(db, tasksDir, definition);
    const runId = testRunId('w28-criteria-run');
    insertRun(db, { id: runId, taskId: task.task.id, variantId: 'baseline', githubRepo: repo });

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
    // 参考实现满足前四条的行为；它不加单元测试，第 5 条（新增的单元测试）不能满分
    expect(criteria.items.slice(0, 4).every((i) => i.score >= 1)).toBe(true);
    expect(criteria.items[4]?.score).toBeLessThan(2);
    expect(criteria.maxScore).toBe(10);
    expect(criteria.detail.pr).toMatchObject({ number: pr });
    expect(criteria.detail.checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
    expect(criteria.detail.endpoint).toMatchObject({ reached: true, missingRequired: [] });
    expect(criteria.reachedEnd).toBe(true);
    expect(criteria.costUsd).toBeGreaterThan(0);
    expect(grades?.costUsd).toBe(criteria.costUsd);
    console.log(
      `建仓库与 PR ${String(Math.round((prepared - started) / 1000))} 秒，评分 ${String(Math.round((Date.now() - prepared) / 1000))} 秒；验收标准 ${String(criteria.score)} / ${String(criteria.maxScore)}，${String(criteria.judgeModel)}，输入 ${String(criteria.inputTokens)} 输出 ${String(criteria.outputTokens)} token，花费 $${criteria.costUsd.toFixed(4)}`,
    );
    for (const item of criteria.items) {
      console.log(`${item.itemId} ${String(item.score)}/2 ${item.reasoning}`);
    }
  });
});
