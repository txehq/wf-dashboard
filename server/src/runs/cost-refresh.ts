import { eq } from 'drizzle-orm';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';
import { events } from '../events.js';

// Refreshes triggered by session.updated happen at most this often per run (Contracts 7.8)
export const COST_REFRESH_MS = 30_000;

// Recomputes the run's four cost items into the runs.cost_usd cache; publishes run.cost on change
export function refreshRunCost(db: Db, runId: string) {
  const row = db.select({ costUsd: runs.costUsd }).from(runs).where(eq(runs.id, runId)).get();
  if (row === undefined) throw new Error(`Run ${runId} does not exist`);
  const { total } = runCostBreakdown(db, runId);
  if (total === row.costUsd) return;
  db.update(runs).set({ costUsd: total }).where(eq(runs.id, runId)).run();
  events.publish({ type: 'run.cost', runId, costUsd: total });
}

// A turn can last an hour or two: the cost cache also refreshes when the run's session gets new requests
export function watchRunCost(
  db: Db,
  runId: string,
  sessionId: string,
  onError: (error: Error) => void,
  intervalMs = COST_REFRESH_MS,
): () => void {
  return onSessionUpdates(
    sessionId,
    () => {
      refreshRunCost(db, runId);
    },
    onError,
    intervalMs,
  );
}

// Calls work on session.updated for the session, at most once per intervalMs (runner uses COST_REFRESH_MS, tests a short interval).
// The interval counts from the end of the last call; within intervalMs of it, one call is deferred until the interval is up, so the last batch of writes is not missed.
// Errors from work go to onError (the runner fails the run). Returns a stop function
export function onSessionUpdates(
  sessionId: string,
  work: () => void | Promise<void>,
  onError: (error: Error) => void,
  intervalMs = COST_REFRESH_MS,
): () => void {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const refresh = () => {
    // setTimeout uses libuv's cached loop time and can fire a millisecond or two early by Date.now(): wait out the full interval
    const wait = last + intervalMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(refresh, wait);
      return;
    }
    timer = undefined;
    last = Date.now();
    Promise.resolve()
      .then(work)
      .then(() => {
        last = Date.now();
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
  };
  const unsubscribe = events.subscribe((event) => {
    if (event.type !== 'session.updated' || event.sessionId !== sessionId) return;
    if (timer !== undefined) return;
    const wait = last + intervalMs - Date.now();
    if (wait <= 0) refresh();
    else timer = setTimeout(refresh, wait);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
