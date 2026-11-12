import {
  type DiskPick,
  pickedSessions,
  type ScopeInput,
  type ScopeSession,
} from '@/lib/analyses-api';
import type { DiskSession, ImportConfig, SessionEngine } from '@/lib/sessions-api';

// Picks in a new analysis (Contracts 25.4, 27): all sessions of one analysis share one config and one engine.
// Picks from disk carry the file, config, engine, title and project (shown and dimmed before the scope loads); preselected ones carry only the id
export interface Picked {
  id: string;
  disk: {
    file: string;
    engine: SessionEngine;
    config: string;
    title: string | null;
    project: string;
  } | null;
}

export const SAME_CONFIG_REASON =
  'One analysis can only include sessions from one config. Clear the selection first';

// Config and engine of the picks: those of the first pick (preselected ones use the loaded scope); null when nothing is picked or loaded yet
export interface PickLock {
  engine: SessionEngine;
  config: string | null;
}

export function pickLock(
  picked: readonly Picked[],
  scoped: ReadonlyMap<string, ScopeSession>,
): PickLock | null {
  const first = picked[0];
  if (first === undefined) return null;
  if (first.disk !== null) return { engine: first.disk.engine, config: first.disk.config };
  const s = scoped.get(first.id);
  return s === undefined ? null : { engine: s.engine, config: s.config?.id ?? null };
}

// Configs in the first column that cannot be picked: once something is picked, other configs cannot
export function configBlock(c: ImportConfig, lock: PickLock | null): string | null {
  if (lock?.config == null || lock.config === c.id) return null;
  return SAME_CONFIG_REASON;
}

// Engine switch at the top: once something is picked, the other engine cannot
export const engineBlock = (engine: SessionEngine, lock: PickLock | null): string | null =>
  lock === null || lock.engine === engine ? null : SAME_CONFIG_REASON;

// Check or uncheck in the third column (the whole page for select all): new picks go at the end, no duplicates
export function toggledPicks(
  picked: readonly Picked[],
  list: readonly DiskSession[],
  want: boolean,
  place: { engine: SessionEngine; config: string; project: string },
): Picked[] {
  if (!want) {
    const gone = new Set(list.map((s) => s.id));
    return picked.filter((p) => !gone.has(p.id));
  }
  const have = new Set(picked.map((p) => p.id));
  const added = list
    .filter((s) => !have.has(s.id))
    .map((s) => ({ id: s.id, disk: { file: s.file, title: s.title, ...place } }));
  return [...picked, ...added];
}

// Scope request: preselected sessions by id, disk picks by file
export function pickedScope(picked: readonly Picked[]): {
  sessions: string[];
  disk: DiskPick | undefined;
} {
  const fromDisk = picked.flatMap((p) => (p.disk === null ? [] : [p.disk]));
  const first = fromDisk[0];
  return {
    sessions: picked.filter((p) => p.disk === null).map((p) => p.id),
    disk:
      first === undefined
        ? undefined
        : { engine: first.engine, files: fromDisk.map((d) => d.file) },
  };
}

// Arriving with a selection from Sessions, Runs or a session detail (?batch=, ?picked=, ?sessions=).
// picked is the sessionStorage key (in this tab) of the sessions selected in the Sessions table; 'missing' when it cannot be read
export function preselection(params: URLSearchParams): ScopeInput | 'missing' | null {
  const batch = params.get('batch');
  if (batch !== null && batch !== '') return { batch };
  const picked = params.get('picked');
  if (picked !== null && picked !== '') {
    const ids = pickedSessions(picked);
    return ids === null ? 'missing' : { sessions: ids };
  }
  const sessions = params.get('sessions');
  if (sessions !== null && sessions !== '') return { sessions: sessions.split(',') };
  return null;
}
