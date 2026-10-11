import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradeItems, grades } from '../../src/db/schema.js';
import { compareRuns } from '../../src/grading/compare.js';
import { loadIcTask, saveTask, syncTasks } from '../../src/tasks/loader.js';
import { testRunId, withoutHiddenTests } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';
import { insertRun, insertVariant } from './seed.js';

const { db, close } = openTestDb();
afterAll(close);
syncTasks(db, config.tasksDir);
insertVariant(db, 'baseline');

// ic-money-format 去掉隐藏测试，作为没有隐藏测试的 ic task（5 条验收标准）
const definition = withoutHiddenTests(loadIcTask(db, 'ic-money-format'), 'w28-compare-criteria');
const tasksDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w28-compare'), 'tasks');
const taskId = saveTask(db, tasksDir, definition).task.id;

function criteriaRun(id: string, scores: number[], reachedEnd: boolean) {
  insertRun(db, { id, taskId, variantId: 'baseline', status: 'succeeded' });
  const grade = db
    .insert(grades)
    .values({
      runId: id,
      kind: 'ic_criteria',
      judgeModel: 'claude-opus-5-5',
      costUsd: 0.04,
      reachedEnd,
      criteriaDetail: { pr: null, endpoint: null, checks: [], diffChars: 0 },
    })
    .returning({ id: grades.id })
    .get();
  db.insert(gradeItems)
    .values(
      scores.map((score, i) => ({
        gradeId: grade.id,
        itemId: `ac${String(i + 1)}`,
        criterion: definition.ticket.acceptanceCriteria[i] ?? '',
        score,
        maxScore: 2,
        reasoning: '理由。',
      })),
    )
    .run();
}

criteriaRun('c1', [2, 2, 2, 2, 2], true);
criteriaRun('c2', [2, 1, 0, 1, 1], false);

describe('Compare：没有隐藏测试的 ic task', () => {
  it('质量为验收标准得分率与到达终点的比例，并给出每条验收标准的得分', () => {
    const result = compareRuns(db, {
      variants: ['baseline'],
      tasks: [taskId],
      includeIntervened: false,
      includeCrossRef: false,
      includeCancelled: false,
    });
    const c = result.cells[0];
    if (c === undefined) throw new Error('没有格子');
    expect(c.runIds).toEqual(['c1', 'c2']);
    if (c.quality.kind !== 'ic_criteria') throw new Error('应为 ic_criteria');
    expect(c.quality.criteriaRate.values).toEqual([
      { runId: 'c1', value: 1 },
      { runId: 'c2', value: 0.5 },
    ]);
    expect(c.quality.criteriaRate.mean).toBeCloseTo(0.75, 12);
    expect(c.quality.reachedEnd.ratio).toBe(0.5);
    expect(c.rubricItems).toEqual([]);
    expect(c.criteriaItems.map((i) => [i.itemId, i.maxScore, i.score.mean])).toEqual([
      ['ac1', 2, 2],
      ['ac2', 2, 1.5],
      ['ac3', 2, 1],
      ['ac4', 2, 1.5],
      ['ac5', 2, 1.5],
    ]);
    expect(c.cost?.total.grading).toBeCloseTo(0.04, 12);
  });
});
