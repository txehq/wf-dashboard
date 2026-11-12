import type { SessionEngine } from '@/lib/sessions-api';

// Multi-select in the manage table (Contracts 25.1): rows picked one by one (across pages), or everything under
// the current search and config filter. With all selected, operations run on every id the server returns for
// this scope (GET /api/sessions?idsOnly=true)
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

// Header checkbox: whole page selected, partly selected (indeterminate) or none
export function pageState(
  selection: SessionSelection,
  pageIds: readonly string[],
): 'none' | 'some' | 'all' {
  const n = pageIds.filter((id) => isRowSelected(selection, id)).length;
  if (n === 0) return 'none';
  return n === pageIds.length ? 'all' : 'some';
}

// Toggle one row; with all selected, unchecking a row leaves all the others (all is everything in this scope)
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

// Header checkbox: clears this page when it is fully selected (clears everything with all selected), otherwise
// selects this page
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

// Text of the row above the table; offerAll: the whole page is selected and more remain, so offer "Select all N"
export function selectionSummary(
  selection: SessionSelection,
  pageIds: readonly string[],
  total: number,
): { text: string; offerAll: boolean } | null {
  if (selection.kind === 'all') return { text: `All ${String(total)} selected`, offerAll: false };
  const size = selection.picked.size;
  if (size === 0) return null;
  const pageFull = pageIds.length > 0 && pageState(selection, pageIds) === 'all';
  if (!pageFull) return { text: `${String(size)} selected`, offerAll: false };
  const n = String(pageIds.length);
  return {
    text:
      size === pageIds.length
        ? `${n} selected on this page`
        : `${String(size)} selected (${n} on this page)`,
    offerAll: total > size,
  };
}

// Targets of an operation: with all selected, everything in this scope (undefined until all has loaded)
export function selectedTargets(
  selection: SessionSelection,
  all: readonly SelectedSession[] | undefined,
): readonly SelectedSession[] | undefined {
  return selection.kind === 'all' ? all : [...selection.picked.values()];
}
