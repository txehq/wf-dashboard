import { formatInteger } from './format';
import type { DiskSession, PickedSession } from './sessions-api';

// Checks and staged changes in the three columns above (Contracts 25.1). manage: the Sessions page, a check means
// in the manage table; imported ones are checked by default and can be unchecked.
// live: the "Import local sessions" picker, import only; sessions already in the workspace cannot be checked
export type ImportMode = 'manage' | 'live';

// Staged changes by file; kept across pages, projects and configs. In manage, those that differ from the
// original state (to import, to clear); in live, the checked ones
export type ImportChanges = ReadonlyMap<string, PickedSession>;

// Config and project of a change
export interface ImportPlace {
  config: string;
  cwd: string;
}

// In manage, whether a change imports or clears: by the state when it was staged
export const changeKind = (s: PickedSession) => (s.imported ? 'clear' : 'import');

// Original state: in manage, imported ones are checked (changed ones by the state when staged); none in live
function original(mode: ImportMode, changes: ImportChanges, s: DiskSession): boolean {
  return mode === 'manage' && (changes.get(s.file)?.imported ?? s.imported);
}

export function isChecked(mode: ImportMode, changes: ImportChanges, s: DiskSession): boolean {
  return changes.has(s.file) !== original(mode, changes, s);
}

// In manage any session can be checked or unchecked (clear only hides it in the manage table); in live, those
// already in the workspace (not hidden) cannot be checked
export function isSelectable(mode: ImportMode, s: DiskSession): boolean {
  return mode === 'manage' || s.liveId === null || s.liveHidden;
}

// Set these sessions to want: drop the change when it equals the original state (a second click restores it)
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

// Select all on this page: only the checkable ones on this page; unchecks them when all are already checked
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

// "Imported x / y (+2 −1)" next to a project in the second column
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
  return `Imported ${formatInteger(project.importedCount)} / ${formatInteger(project.sessionCount)}${
    delta.length > 0 ? ` (${delta.join(' ')})` : ''
  }`;
}

// "Apply: import N, clear M", naming only the kind present when there is one
export function applyLabel(imports: number, clears: number): string {
  const parts = [
    ...(imports > 0 ? [`import ${formatInteger(imports)}`] : []),
    ...(clears > 0 ? [`clear ${formatInteger(clears)}`] : []),
  ];
  return parts.length === 0 ? 'Apply' : `Apply: ${parts.join(', ')}`;
}

// Remove the applied part from the staged changes
export function withoutApplied(changes: ImportChanges, done: PickedSession[]): ImportChanges {
  const next = new Map(changes);
  for (const s of done) next.delete(s.file);
  return next;
}
