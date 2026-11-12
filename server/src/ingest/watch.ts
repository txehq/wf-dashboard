import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { ingestCodexFile, isRollout } from './codex.js';
import { ingestFile } from './ingest.js';

// Incremental import interval. An import reads only past the last offset; with nothing new it costs one open and one fstat
const POLL_MS = 250;

export interface SessionWatcher {
  close(): Promise<void>;
}

// Number of watchers doing incremental imports (GET /api/diagnostics)
let activeWatchers = 0;
export const watcherCount = () => activeWatchers;

// Live runs: every POLL_MS do an incremental import of the main jsonl (with <sessionId>/subagents/); returns after the first import.
// No file system events: macOS FSEvents drops whole batches of events under heavy writes, polling misses no writes.
// Import errors go to onError (the runner fails the run) and importing stops; throwing from the timer would
// become an uncaught exception and stop the whole server
export function watchSession(
  db: Db,
  file: string,
  onError: (error: Error) => void,
): SessionWatcher {
  const absolute = path.resolve(file);
  let stopped = false;
  // Codex rollouts are imported incrementally the same way as Claude Code jsonl (Contracts 25.2)
  const ingest = isRollout(absolute) ? ingestCodexFile : ingestFile;
  // Right after a run starts the jsonl may not exist yet
  const ingestNow = () => {
    if (existsSync(absolute)) ingest(db, absolute);
  };
  ingestNow();
  activeWatchers += 1;
  // Closing and failing count only once
  const stop = () => {
    if (stopped) return;
    stopped = true;
    activeWatchers -= 1;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    // No more imports after closing (run ended, test closed the database) or after an error
    if (stopped) return;
    try {
      ingestNow();
    } catch (error) {
      stop();
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, POLL_MS);
  return {
    close: () => {
      stop();
      return Promise.resolve();
    },
  };
}
