import type { SessionEngine } from '@/lib/sessions-api';

// 管理表格的多选（Contracts 25.1）：逐个选的（可以跨页），或选中当前搜索与配置筛选下的全部。
// 选中全部时操作按服务端返回的这个范围内的全部 id 执行（GET /api/sessions?idsOnly=true）
export interface SelectedSession {
  id: string;
  engine: SessionEngine;
  archived: boolean;
}

export type SessionSelection =
  { kind: 'some'; picked: ReadonlyMap<string, SelectedSession> } | { kind: 'all' };

export const noSelection: SessionSelection = { kind: 'some', picked: new Map() };

export function isRowSelected(selection: SessionSelection, id: string): boolean {
  return selection.kind === 'all' || selection.picked.has(id);
}

// 表头勾选框：本页全选、部分选中（半选）或没有选
export function pageState(
  selection: SessionSelection,
  pageIds: readonly string[],
): 'none' | 'some' | 'all' {
  const n = pageIds.filter((id) => isRowSelected(selection, id)).length;
  if (n === 0) return 'none';
  return n === pageIds.length ? 'all' : 'some';
}

// 切换一行；选中全部时取消一行，得到全部中除它以外的（all 为这个范围内的全部）
export function toggledRow(
  selection: SessionSelection,
  row: SelectedSession,
  all: readonly SelectedSession[],
): SessionSelection {
  const picked = new Map(
    selection.kind === 'all' ? all.map((s) => [s.id, s] as const) : selection.picked,
  );
  if (picked.has(row.id)) picked.delete(row.id);
  else picked.set(row.id, row);
  return { kind: 'some', picked };
}

// 表头勾选框：本页全部选中时取消本页（选中全部时取消全部），否则选中本页
export function toggledPage(
  selection: SessionSelection,
  page: readonly SelectedSession[],
): SessionSelection {
  if (selection.kind === 'all') return noSelection;
  const picked = new Map(selection.picked);
  const ids = page.map((s) => s.id);
  if (pageState(selection, ids) === 'all') for (const id of ids) picked.delete(id);
  else for (const s of page) picked.set(s.id, s);
  return { kind: 'some', picked };
}

// 表格上方一行的文字；offerAll：本页全部选中、还有没选的，提供"选择全部 N 个"
export function selectionSummary(
  selection: SessionSelection,
  pageIds: readonly string[],
  total: number,
): { text: string; offerAll: boolean } | null {
  if (selection.kind === 'all') return { text: `已选全部 ${String(total)} 个`, offerAll: false };
  const size = selection.picked.size;
  if (size === 0) return null;
  const pageFull = pageIds.length > 0 && pageState(selection, pageIds) === 'all';
  if (!pageFull) return { text: `已选 ${String(size)} 个`, offerAll: false };
  const n = String(pageIds.length);
  return {
    text: size === pageIds.length ? `已选本页 ${n} 个` : `已选 ${String(size)} 个（本页 ${n} 个）`,
    offerAll: total > size,
  };
}

// 操作的对象：选中全部时为这个范围内的全部（all 还没读到时为 undefined）
export function selectedTargets(
  selection: SessionSelection,
  all: readonly SelectedSession[] | undefined,
): readonly SelectedSession[] | undefined {
  return selection.kind === 'all' ? all : [...selection.picked.values()];
}
