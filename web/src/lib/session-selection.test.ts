import { expect, test } from 'vitest';
import {
  isRowSelected,
  noSelection,
  pageState,
  type SelectedSession,
  selectedTargets,
  selectionSummary,
  type SessionSelection,
  toggledPage,
  toggledRow,
} from './session-selection';

const row = (id: string): SelectedSession => ({ id, engine: 'claude', archived: false });
// 这个范围内共 5 个，每页 2 个
const all = ['a', 'b', 'c', 'd', 'e'].map(row);
const page1 = all.slice(0, 2);
const page2 = all.slice(2, 4);
const ids = (rows: readonly SelectedSession[] | undefined) => rows?.map((s) => s.id);

// W73：管理表格的多选与"选择全部 N 个"
test('表头勾选框：没有选、半选、本页全选；再点一次取消本页，别的页选的保留', () => {
  expect(pageState(noSelection, ids(page1) ?? [])).toBe('none');
  const one = toggledRow(noSelection, row('a'), all);
  expect(pageState(one, ['a', 'b'])).toBe('some');
  // 半选时点表头：选中本页
  const pageOne = toggledPage(one, page1);
  expect(pageState(pageOne, ['a', 'b'])).toBe('all');
  // 翻页后逐个选，再回到第一页取消本页
  const across = toggledRow(pageOne, row('c'), all);
  expect(pageState(across, ['c', 'd'])).toBe('some');
  expect(ids(selectedTargets(toggledPage(across, page1), undefined))).toEqual(['c']);
});

test('上方一行的文字：本页全部选中时提供选择全部；跨页选的写出总数；全部选中时写全部', () => {
  expect(selectionSummary(noSelection, ['a', 'b'], 5)).toBeNull();
  const one = toggledRow(noSelection, row('a'), all);
  expect(selectionSummary(one, ['a', 'b'], 5)).toEqual({ text: '已选 1 个', offerAll: false });
  const pageOne = toggledPage(noSelection, page1);
  expect(selectionSummary(pageOne, ['a', 'b'], 5)).toEqual({
    text: '已选本页 2 个',
    offerAll: true,
  });
  const across = toggledRow(pageOne, row('c'), all);
  expect(selectionSummary(toggledPage(across, page2), ['c', 'd'], 5)).toEqual({
    text: '已选 4 个（本页 2 个）',
    offerAll: true,
  });
  // 范围内只有一页、本页全部选中：没有更多可选
  expect(selectionSummary(pageOne, ['a', 'b'], 2)).toEqual({
    text: '已选本页 2 个',
    offerAll: false,
  });
  const everything: SessionSelection = { kind: 'all' };
  expect(selectionSummary(everything, ['c', 'd'], 5)).toEqual({
    text: '已选全部 5 个',
    offerAll: false,
  });
});

test('选中全部：每页都是选中的，操作的对象是服务端返回的全部；取消一行得到其余的，表头取消全部', () => {
  const everything: SessionSelection = { kind: 'all' };
  expect(isRowSelected(everything, 'e')).toBe(true);
  expect(pageState(everything, ['c', 'd'])).toBe('all');
  // 全部的 id 还没读到
  expect(selectedTargets(everything, undefined)).toBeUndefined();
  expect(ids(selectedTargets(everything, all))).toEqual(['a', 'b', 'c', 'd', 'e']);
  const without = toggledRow(everything, row('d'), all);
  expect(ids(selectedTargets(without, all))).toEqual(['a', 'b', 'c', 'e']);
  expect(pageState(without, ['c', 'd'])).toBe('some');
  expect(toggledPage(everything, page2)).toEqual(noSelection);
});
