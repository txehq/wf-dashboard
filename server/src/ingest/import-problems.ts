// A session's import problem (Requirements Log round 13 item 19): affects only that session; the text is shown in the Sessions management table and detail.
// - failed: the import failed, with the original error; retried on the next incremental import, cleared on success
// - waiting: a referenced spill file has not appeared yet; the record referencing it and everything after are imported once it appears (when a remote session syncs back to this machine the jsonl may arrive first)
export interface ImportProblem {
  kind: 'failed' | 'waiting';
  message: string;
  at: Date;
}

const failures = new Map<string, ImportProblem>();
// session id -> the spill file waited for and when the wait started
const waits = new Map<string, { spill: string; at: Date }>();

// Record an import failure (message is the original error, prefixed with the imported file); returns whether it differs from the last one (the same error
// recurs on every incremental import; log and notify the page only on change)
export function recordImportFailure(sessionId: string, message: string): boolean {
  const changed = failures.get(sessionId)?.message !== message;
  failures.set(sessionId, { kind: 'failed', message, at: new Date() });
  return changed;
}

// Returns whether there was a failure before
export function clearImportFailure(sessionId: string): boolean {
  return failures.delete(sessionId);
}

// This import stopped before a record referencing a spill file that has not appeared (spill), or did not stop (null); returns whether the state changed
export function setSpillWait(sessionId: string, spill: string | null): boolean {
  const before = waits.get(sessionId)?.spill ?? null;
  if (before === spill) return false;
  if (spill === null) waits.delete(sessionId);
  else waits.set(sessionId, { spill, at: new Date() });
  return true;
}

// A failure takes precedence over waiting
export function importProblemOf(sessionId: string): ImportProblem | null {
  const failure = failures.get(sessionId);
  if (failure !== undefined) return failure;
  const wait = waits.get(sessionId);
  if (wait === undefined) return null;
  return {
    kind: 'waiting',
    message: `Spill file has not appeared yet; the record referencing it and everything after are imported once it appears: ${wait.spill}`,
    at: wait.at,
  };
}
