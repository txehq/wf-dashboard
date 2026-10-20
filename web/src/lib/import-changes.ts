import { formatInteger } from './format';
import type { DiskSession, PickedSession } from './sessions-api';

// 上面三列的勾选与暂存的改动（Contracts 25.1）。manage：Sessions 页面，勾选表示在管理表格中，已导入的默认勾选、可以取消；
// live："导入本机 session"选择框，只用来导入，已在交互区的不能勾选
export type ImportMode = 'manage' | 'live';

// 暂存的改动，按文件；翻页、换项目、换配置时保留。manage 中是与原状不同的（待导入、待清除），live 中是勾选的
export type ImportChanges = ReadonlyMap<string, PickedSession>;

// 改动所在的配置与项目
export interface ImportPlace {
  config: string;
  cwd: string;
}

// manage 中一个改动是导入还是清除：按暂存时的状态
export const changeKind = (s: PickedSession) => (s.imported ? 'clear' : 'import');

// 原状：manage 中已导入的勾选（有改动的按暂存时的状态），live 中都不勾选
function original(mode: ImportMode, changes: ImportChanges, s: DiskSession): boolean {
  return mode === 'manage' && (changes.get(s.file)?.imported ?? s.imported);
}

export function isChecked(mode: ImportMode, changes: ImportChanges, s: DiskSession): boolean {
  return changes.has(s.file) !== original(mode, changes, s);
}

// manage 中任何 session 都可以勾选或取消（清除只在管理表格中隐藏）；live 中已在交互区（没有隐藏）的不能勾选
export function isSelectable(mode: ImportMode, s: DiskSession): boolean {
  return mode === 'manage' || s.liveId === null || s.liveHidden;
}

// 把这些 session 勾选成 want：与原状相同时去掉改动（再点一次恢复原状）
export function withChecked(
  mode: ImportMode,
  changes: ImportChanges,
  list: DiskSession[],
  want: boolean,
  place: ImportPlace,
): ImportChanges {
  const next = new Map(changes);
  for (const s of list) {
    if (want === original(mode, changes, s)) next.delete(s.file);
    else if (!next.has(s.file)) next.set(s.file, { ...s, ...place });
  }
  return next;
}

export function toggled(
  mode: ImportMode,
  changes: ImportChanges,
  s: DiskSession,
  place: ImportPlace,
): ImportChanges {
  return withChecked(mode, changes, [s], !isChecked(mode, changes, s), place);
}

// 本页的全选：只作用于本页能勾选的，都已勾选时取消它们的勾选
export function pageAllChecked(
  mode: ImportMode,
  changes: ImportChanges,
  selectable: DiskSession[],
): boolean {
  return selectable.length > 0 && selectable.every((s) => isChecked(mode, changes, s));
}

export function toggledPage(
  mode: ImportMode,
  changes: ImportChanges,
  selectable: DiskSession[],
  place: ImportPlace,
): ImportChanges {
  return withChecked(mode, changes, selectable, !pageAllChecked(mode, changes, selectable), place);
}

export function splitChanges(changes: ImportChanges): {
  imports: PickedSession[];
  clears: PickedSession[];
} {
  const all = [...changes.values()];
  return {
    imports: all.filter((s) => changeKind(s) === 'import'),
    clears: all.filter((s) => changeKind(s) === 'clear'),
  };
}

// 第二列项目旁的"已导入 x / y（+2 −1）"
export function projectCountText(
  changes: ImportChanges,
  config: string,
  project: { cwd: string; sessionCount: number; importedCount: number },
): string {
  const here = [...changes.values()].filter((c) => c.config === config && c.cwd === project.cwd);
  const plus = here.filter((c) => changeKind(c) === 'import').length;
  const minus = here.length - plus;
  if (project.importedCount === 0 && plus === 0) return formatInteger(project.sessionCount);
  const delta = [
    ...(plus > 0 ? [`+${formatInteger(plus)}`] : []),
    ...(minus > 0 ? [`−${formatInteger(minus)}`] : []),
  ];
  return `已导入 ${formatInteger(project.importedCount)} / ${formatInteger(project.sessionCount)}${
    delta.length > 0 ? `（${delta.join(' ')}）` : ''
  }`;
}

// "应用：导入 N 个，清除 M 个"，只有一种时只写那一种
export function applyLabel(imports: number, clears: number): string {
  const parts = [
    ...(imports > 0 ? [`导入 ${formatInteger(imports)} 个`] : []),
    ...(clears > 0 ? [`清除 ${formatInteger(clears)} 个`] : []),
  ];
  return parts.length === 0 ? '应用' : `应用：${parts.join('，')}`;
}

// 应用完成的部分从暂存中去掉
export function withoutApplied(changes: ImportChanges, done: PickedSession[]): ImportChanges {
  const next = new Map(changes);
  for (const s of done) next.delete(s.file);
  return next;
}
