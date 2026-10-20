import { expect, test } from 'vitest';
import {
  applyLabel,
  type ImportChanges,
  isChecked,
  isSelectable,
  pageAllChecked,
  projectCountText,
  splitChanges,
  toggled,
  toggledPage,
  withoutApplied,
} from './import-changes';
import type { DiskSession } from './sessions-api';

const disk = (id: string, imported: boolean): DiskSession => ({
  id,
  file: `/home/u/.claude/projects/-p/${id}.jsonl`,
  title: `标题 ${id}`,
  startedAt: '2026-10-15T00:00:00.000Z',
  size: 100,
  imported,
  liveId: null,
  liveHidden: false,
});
const here = { config: 'local', cwd: '/p' };
const empty: ImportChanges = new Map();

// W70：第三列的勾选表示在不在管理表格中，改动先暂存，再点一次恢复原状
test('已导入的默认勾选，取消即待清除；未导入的勾选即待导入；再点一次恢复原状', () => {
  const a = disk('a', true);
  const b = disk('b', false);
  expect(isChecked('manage', empty, a)).toBe(true);
  expect(isChecked('manage', empty, b)).toBe(false);

  let changes = toggled('manage', empty, a, here);
  changes = toggled('manage', changes, b, here);
  expect(isChecked('manage', changes, a)).toBe(false);
  expect(isChecked('manage', changes, b)).toBe(true);
  const { imports, clears } = splitChanges(changes);
  expect(imports.map((s) => s.id)).toEqual(['b']);
  expect(clears.map((s) => s.id)).toEqual(['a']);
  expect(applyLabel(imports.length, clears.length)).toBe('应用：导入 1 个，清除 1 个');

  changes = toggled('manage', changes, a, here);
  changes = toggled('manage', changes, b, here);
  expect(changes.size).toBe(0);
  expect(applyLabel(0, 0)).toBe('应用');
});

test('改动按文件保存，翻页、换项目后回来仍在；按暂存时的状态判断导入还是清除', () => {
  const a = disk('a', true);
  const other = disk('c', false);
  let changes = toggled('manage', empty, a, here);
  // 换到另一个项目的另一页勾选
  changes = toggled('manage', changes, other, { config: 'local', cwd: '/q' });
  // 回到第一页时，同样的行（重新读到的新对象）仍是改动后的状态
  expect(isChecked('manage', changes, disk('a', true))).toBe(false);
  // 应用了导入后重新读到 a 的状态不变，c 已导入：暂存中的 c 按暂存时的状态仍显示为勾选
  expect(isChecked('manage', changes, { ...other, imported: true })).toBe(true);
  const { imports, clears } = splitChanges(changes);
  expect(applyLabel(imports.length, clears.length)).toBe('应用：导入 1 个，清除 1 个');
  // 导入完成、清除失败时，暂存中只留下没完成的清除
  const left = withoutApplied(changes, imports);
  expect([...left.values()].map((s) => s.id)).toEqual(['a']);
  expect(applyLabel(0, 1)).toBe('应用：清除 1 个');
  expect(applyLabel(2, 0)).toBe('应用：导入 2 个');
});

// W74：清除只在管理表格中隐藏，任何 session 都可以取消勾选（run 的、运行中的交互项的也可以）
test('manage 中每一行都能选；本页全选第一次勾选全部，第二次取消全部', () => {
  const run = disk('run', true);
  const live = { ...disk('live', true), liveId: 'l1' };
  const fresh = disk('fresh', false);
  const page = [run, live, fresh];
  expect(page.every((s) => isSelectable('manage', s))).toBe(true);
  expect(pageAllChecked('manage', empty, page)).toBe(false);
  // 第一次全选：未导入的勾选，已导入的不变
  let changes = toggledPage('manage', empty, page, here);
  expect(page.map((s) => isChecked('manage', changes, s))).toEqual([true, true, true]);
  expect([...changes.keys()]).toEqual([fresh.file]);
  // 第二次：本页全部取消勾选，已导入的两个待清除
  changes = toggledPage('manage', changes, page, here);
  expect(page.map((s) => isChecked('manage', changes, s))).toEqual([false, false, false]);
  expect(splitChanges(changes).clears.map((s) => s.id)).toEqual(['run', 'live']);
  expect(changes.has(fresh.file)).toBe(false);
});

test('第二列的已导入数随暂存的改动变化', () => {
  const project = { cwd: '/p', sessionCount: 52, importedCount: 50 };
  const a = disk('a', true);
  const b = disk('b', true);
  let changes = toggled('manage', empty, a, here);
  changes = toggled('manage', changes, b, here);
  expect(projectCountText(empty, 'local', project)).toBe('已导入 50 / 52');
  expect(projectCountText(changes, 'local', project)).toBe('已导入 50 / 52（−2）');
  changes = toggled('manage', changes, disk('c', false), here);
  expect(projectCountText(changes, 'local', project)).toBe('已导入 50 / 52（+1 −2）');
  // 别的配置、别的项目的改动不算
  expect(projectCountText(changes, 'design', project)).toBe('已导入 50 / 52');
  expect(projectCountText(changes, 'local', { ...project, cwd: '/q' })).toBe('已导入 50 / 52');
  expect(projectCountText(empty, 'local', { cwd: '/p', sessionCount: 3, importedCount: 0 })).toBe(
    '3',
  );
  expect(
    projectCountText(toggled('manage', empty, disk('c', false), here), 'local', {
      cwd: '/p',
      sessionCount: 3,
      importedCount: 0,
    }),
  ).toBe('已导入 0 / 3（+1）');
});

test('live 中只能勾选导入，已在交互区的（没有隐藏）不能勾选', () => {
  const imported = disk('a', true);
  expect(isChecked('live', empty, imported)).toBe(false);
  const changes = toggled('live', empty, imported, here);
  expect(isChecked('live', changes, imported)).toBe(true);
  expect(isSelectable('live', { ...imported, liveId: 'l1' })).toBe(false);
  expect(isSelectable('live', { ...imported, liveId: 'l1', liveHidden: true })).toBe(true);
});
