import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { liveSessions, sessions, userMessages } from '../db/schema.js';
import { sessionTitle } from './user-text.js';

// Session title, used everywhere a session title is shown (management table, third import column, confirm dialogs, error messages, analyses):
// a session belonging to a Live item takes the item's name (Contracts 14.1, 14.3, renames apply at once), otherwise the main session's
// first user message (sessionTitle: a slash command shows as "/lfg Build a calculator"). Sessions with neither are left out
export function sessionTitles(db: Db, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  // In SQLite, bare columns next to min() come from the row holding the minimum
  const titles = new Map(
    db
      .select({
        sessionId: userMessages.sessionId,
        text: userMessages.text,
        first: sql<number>`min(${userMessages.timestamp})`,
      })
      .from(userMessages)
      .where(
        and(
          inArray(userMessages.sessionId, [...ids]),
          isNull(userMessages.agentId),
          eq(userMessages.kind, 'user'),
        ),
      )
      .groupBy(userMessages.sessionId)
      .all()
      .map((m) => [m.sessionId, sessionTitle(m.text)]),
  );
  for (const item of db
    .select({ sessionId: sessions.id, title: liveSessions.title })
    .from(sessions)
    .innerJoin(liveSessions, eq(liveSessions.id, sessions.liveId))
    .where(inArray(sessions.id, [...ids]))
    .all())
    titles.set(item.sessionId, item.title);
  return titles;
}
