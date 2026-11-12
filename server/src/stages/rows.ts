import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, sessions, sessionSkills, userMessages } from '../db/schema.js';

export type RequestRow = typeof requests.$inferSelect;
export type UserMessageRow = typeof userMessages.$inferSelect;

// A session written by ingest
export interface SessionRows {
  sessionId: string;
  cwd: string | null;
  // Main session requests, by seq ascending
  main: RequestRow[];
  // Subagent requests
  subagent: RequestRow[];
  // Main session user messages, by time ascending
  userMessages: UserMessageRow[];
  // Skills Codex injected in the main session, by time ascending
  injectedSkills: { timestamp: Date; name: string }[];
}

// Skills Codex injected in the main session (Contracts 16.6); with after, only those after it
export function injectedSkillsOf(db: Db, sessionId: string, after: Date | null = null) {
  return db
    .select({ timestamp: sessionSkills.timestamp, name: sessionSkills.name })
    .from(sessionSkills)
    .where(
      and(
        eq(sessionSkills.sessionId, sessionId),
        isNull(sessionSkills.agentId),
        eq(sessionSkills.injected, true),
        after === null ? undefined : gt(sessionSkills.timestamp, after),
      ),
    )
    .orderBy(asc(sessionSkills.timestamp))
    .all();
}

export function loadSessionRows(db: Db, sessionId: string): SessionRows {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error(`Session ${sessionId} does not exist`);
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
    injectedSkills: injectedSkillsOf(db, sessionId),
  };
}

// A tool call's input is the raw jsonl value; read it by field
export function inputField(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

export function inputString(input: unknown, key: string): string | null {
  const value = inputField(input, key);
  return typeof value === 'string' ? value : null;
}
