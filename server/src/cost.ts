import { eq, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from './db/index.js';
import { grades, requests, runMessages, runs } from './db/schema.js';
import type { CostBreakdown } from './grading/schema.js';

const sum = (column: SQLiteColumn) => ({ value: sql<number>`coalesce(sum(${column}), 0)` });

function value(row: { value: number } | undefined): number {
  if (row === undefined) throw new Error('Aggregate query returned no row');
  return row.value;
}

// Contracts 7.8: all three costs are computed from the source tables; runs.cost_usd only caches the total
export function runCostBreakdown(db: Db, runId: string): CostBreakdown {
  const run = db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`No run ${runId}`);
  // requests are selected by session_id, which covers both main-session and subagent requests
  const agent = value(
    db
      .select(sum(requests.costUsd))
      .from(requests)
      .where(eq(requests.sessionId, run.sessionId))
      .get(),
  );
  const simulatedUser = value(
    db.select(sum(runMessages.costUsd)).from(runMessages).where(eq(runMessages.runId, runId)).get(),
  );
  const grading = value(
    db.select(sum(grades.costUsd)).from(grades).where(eq(grades.runId, runId)).get(),
  );
  return { agent, simulatedUser, grading, total: agent + simulatedUser + grading };
}
