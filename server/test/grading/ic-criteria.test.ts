import { describe, expect, it } from 'vitest';
import { criteriaSchema, readCriteriaJudgment } from '../../src/grading/ic-criteria.js';
import type { IcTask } from '../../src/tasks/schema.js';

const task: IcTask = {
  id: 'w28-read',
  kind: 'ic',
  dir: '/nonexistent',
  title: 't',
  persona: 'p',
  hiddenRequirements: 'h',
  ticket: { title: 't', body: 'b', acceptanceCriteria: ['第一条', '第二条'] },
  repo: { path: 'repo.bundle', commit: 'a'.repeat(40) },
  requiredChecks: [],
};

const ok = { reasoning: 'diff 中 `src/a.js` 实现了这一点。', score: 2 };

describe('验收标准 judge 的回答', () => {
  it('按编号对应回验收标准', () => {
    expect(readCriteriaJudgment(task, { item_1: ok, item_2: { ...ok, score: 1 } })).toEqual([
      { itemId: 'ac1', criterion: '第一条', score: 2, maxScore: 2, reasoning: ok.reasoning },
      { itemId: 'ac2', criterion: '第二条', score: 1, maxScore: 2, reasoning: ok.reasoning },
    ]);
    expect(Object.keys(criteriaSchema(task).shape)).toEqual(['item_1', 'item_2']);
  });

  it('缺少条目、占位内容、没有写完、分数不是 0 / 1 / 2 时抛错', () => {
    expect(() => readCriteriaJudgment(task, { item_1: ok })).toThrow('judge 没有返回验收标准 ac2');
    expect(() =>
      readCriteriaJudgment(task, { item_1: ok, item_2: { reasoning: 'placeholder', score: 0 } }),
    ).toThrow('judge 给 ac2 的 reasoning 是占位内容');
    expect(() =>
      readCriteriaJudgment(task, { item_1: ok, item_2: { reasoning: '代码改了一半的', score: 0 } }),
    ).toThrow('judge 给 ac2 的 reasoning 没有写完');
    expect(() => readCriteriaJudgment(task, { item_1: ok, item_2: { ...ok, score: 3 } })).toThrow(
      'judge 给 ac2 的分数 3 不是 0、1、2',
    );
  });
});
