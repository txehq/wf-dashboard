import { expect, test } from 'vitest';
import { rememberPicked } from './analyses-api';
import { preselection } from './analysis-pick';

// ?picked= 的 id 在本标签页的 sessionStorage 中（Contracts 25.5），在真实的浏览器中测
test('带着选择进入：?picked= 读本标签页 sessionStorage 中的 id，读不到时为 missing', () => {
  const key = rememberPicked(['a', 'b', 'c']);
  expect(preselection(new URLSearchParams({ picked: key }))).toEqual({
    sessions: ['a', 'b', 'c'],
  });
  expect(preselection(new URLSearchParams({ picked: crypto.randomUUID() }))).toBe('missing');
  // batch 优先于其他两种
  expect(preselection(new URLSearchParams({ batch: 'b-1', picked: key }))).toEqual({
    batch: 'b-1',
  });
});
