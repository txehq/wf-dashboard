import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, sessions, userMessages } from '../db/schema.js';

export type RequestRow = typeof requests.$inferSelect;
export type UserMessageRow = typeof userMessages.$inferSelect;

// ingest 写入的一个 session
export interface SessionRows {
  sessionId: string;
  cwd: string | null;
  // 主 session 的请求，按 seq 升序
  main: RequestRow[];
  // 子代理的请求
  subagent: RequestRow[];
  // 主 session 的用户消息，按时间升序
  userMessages: UserMessageRow[];
}

export function loadSessionRows(db: Db, sessionId: string): SessionRows {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error(`session ${sessionId} 不存在`);
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .orderBy(asc(requests.seq))
    .all();
  return {
    sessionId,
    cwd: session.cwd,
    main: rows.filter((r) => r.agentId === null),
    subagent: rows.filter((r) => r.agentId !== null),
    userMessages: db
      .select()
      .from(userMessages)
      .where(and(eq(userMessages.sessionId, sessionId), isNull(userMessages.agentId)))
      .orderBy(asc(userMessages.timestamp))
      .all(),
  };
}

// tool 调用的 input 是 jsonl 原样，按字段读取
export function inputField(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

export function inputString(input: unknown, key: string): string | null {
  const value = inputField(input, key);
  return typeof value === 'string' ? value : null;
}
