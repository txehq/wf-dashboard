import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type SessionEngine, sessionImports, sessions } from '../db/schema.js';

// Import (Contracts 25.1): a new sessions row records the import time and clears the cleared time. The user's "Import N",
// and the watchers and incremental imports of the dashboard's own processes (run, Live, design and optimisation, Magi Agent) all go through here
export function markImported(db: Db, sessionId: string, engine: SessionEngine, filePath: string) {
  const values = { engine, filePath, importedAt: new Date(), clearedAt: null };
  db.insert(sessionImports)
    .values({ sessionId, ...values })
    .onConflictDoUpdate({ target: sessionImports.sessionId, set: values })
    .run();
}

// Clear (Contracts 25.1): only records the cleared time; the dashboard keeps the data and keeps updating it incrementally
export function markCleared(db: Db, sessionId: string) {
  db.update(sessionImports)
    .set({ clearedAt: new Date() })
    .where(eq(sessionImports.sessionId, sessionId))
    .run();
}

// Read only for an analysis (Contracts 27): same as cleared, not in the management table, data kept and updated incrementally; importing it
// from Sessions later shows it as usual (importFiles clears the cleared time)
export const markAnalysisOnly = markCleared;

// Back into the management table: the user imports again, or the session starts a new process (Live resume, Magi Agent continue)
export function restoreCleared(db: Db, sessionId: string) {
  db.update(sessionImports)
    .set({ clearedAt: null })
    .where(eq(sessionImports.sessionId, sessionId))
    .run();
}

// Sessions in the management table (a sessions condition): never cleared, or imported again after clearing
export const managed = sql`not exists (select 1 from ${sessionImports} where ${sessionImports.sessionId} = ${sessions.id} and ${sessionImports.clearedAt} is not null)`;

// Permanent delete (Contracts 24.2, 25.3): the file is gone, its import records are deleted too
export function forgetImports(db: Db, sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  db.delete(sessionImports).where(inArray(sessionImports.sessionId, sessionIds)).run();
}

// Sessions cleared and not imported again since
export function clearedSessionIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: sessionImports.sessionId })
      .from(sessionImports)
      .where(isNotNull(sessionImports.clearedAt))
      .all()
      .map((r) => r.id),
  );
}
