import { eq, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from './db/index.js';
import { grades, requests, runMessages, runs } from './db/schema.js';
import type { CostBreakdown } from './grading/schema.js';

const sum = (column: SQLiteColumn) => ({ value: sql<number>`coalesce(sum(${column}), 0)` });

function value(row: { value: number } | undefined): number {
  if (row === undefined) throw new Error('聚合查询没有返回行');
  return row.value;
}

// Contracts 7.8：三项成本都从来源表现算；runs.cost_usd 只是 total 的缓存
export function runCostBreakdown(db: Db, runId: string): CostBreakdown {
  const run = db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`没有 run ${runId}`);
  // requests 按 session_id 取，主 session 与子代理的请求都在其中
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
