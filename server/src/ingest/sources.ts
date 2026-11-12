import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type SessionEngine, sessionImports, sessions } from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import { ingestCodexFile, isRollout, readSessionMeta } from './codex.js';
import { recordImportFailure } from './import-problems.js';
import { markAnalysisOnly, restoreCleared } from './imports.js';
import { ingestFile } from './ingest.js';
import { configSourceDirs } from './session-config.js';

export const defaultSourceDirs: SourceDirs = configSourceDirs;

export interface SourceDirs {
  // ~/.claude/projects (config.claudeProjectsDir)
  projectsDir: string;
  // data/variants
  variantsDir: string;
  // This machine's Codex CODEX_HOME (config.codexHome, Contracts 25.1)
  codexHome: string;
  // Design sessions (Contracts 17, 19.3, 22): the drafts and analyses directories, with their claude-config/ and codex-home/
  draftsDir: string;
  analysesDir: string;
  // Local copies of sessions synced back from SSH hosts (Contracts 31.6): data/remote/<hostId>/<remote path>
  remoteDir: string;
}

function subdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort();
}

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Bytes read per import chunk: a 37 MB session takes about twenty chunks, yielding the event loop between them so pages, Live and other requests stay responsive
const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;

// Incrementally import a file in chunks; returns whether anything changed
export async function importInChunks(
  db: Db,
  engine: SessionEngine,
  file: string,
): Promise<boolean> {
  const ingest = engine === 'claude' ? ingestFile : ingestCodexFile;
  let changed = false;
  for (;;) {
    const result = ingest(db, file, IMPORT_CHUNK_BYTES);
    changed ||= result.changed;
    await setImmediate();
    if (!result.more) break;
  }
  return changed;
}

// One session in an incremental import (Requirements Log round 13 item 19): a failure affects only this session; the text is recorded (shown in the Sessions management table
// and detail) and logged, other sessions import as usual, the server keeps running; retried on the next incremental import. Returns whether the import succeeded
export async function importIsolated(
  db: Db,
  sessionId: string,
  engine: SessionEngine,
  file: string,
): Promise<boolean> {
  try {
    await importInChunks(db, engine, file);
    return true;
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    if (recordImportFailure(sessionId, `Import of ${file} failed: ${e.message}`)) {
      console.error(`[sessions] Import of ${sessionId} failed`, e);
      events.publish({ type: 'session.updated', sessionId });
    }
    return false;
  }
}

// When an analysis starts, read sessions not yet in the dashboard (Contracts 27): imported in chunks as usual, marked as read only for analysis once the first chunk creates the row,
// and kept out of the management table. 400 when the file has no timestamped record yet (no session can be created)
export async function readForAnalysis(
  db: Db,
  engine: SessionEngine,
  file: string,
  sessionId: string,
): Promise<void> {
  const ingest = engine === 'claude' ? ingestFile : ingestCodexFile;
  let marked = false;
  for (;;) {
    const result = ingest(db, file, IMPORT_CHUNK_BYTES);
    const created =
      db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get() !==
      undefined;
    if (!marked && created) {
      markAnalysisOnly(db, sessionId);
      marked = true;
    }
    await setImmediate();
    if (!result.more) break;
  }
  if (!marked)
    throw new HttpError(
      400,
      `Session ${sessionId} has no records yet and cannot be analysed: ${file}`,
    );
}

export interface ImportedFile {
  id: string;
  file: string;
}

// The user's "Import N" (Contracts 25.1, 25.5): import each in chunks; new ones are marked imported, cleared ones get their cleared time removed (back in the management table).
// Already imported ones continue incrementally; a Claude Code session already imported from another file (e.g. resume copied it into the interactive config directory) is not imported again from this one.
// When a Codex rollout moves after being archived or restored outside the dashboard, ingestCodexFile records the new location
export async function importFiles(
  db: Db,
  engine: SessionEngine,
  files: ImportedFile[],
): Promise<void> {
  for (const { id, file } of files) {
    const existing = db
      .select({ filePath: sessions.filePath })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!(engine === 'claude' && existing !== undefined && existing.filePath !== file))
      await importInChunks(db, engine, file);
    restoreCleared(db, id);
  }
}

// An earlier clear deleted the dashboard's rows: re-import from the files in the import records, still marked cleared (cleared time unchanged),
// so the runs, analyses and Live items using them can read their data again. Missing files are skipped; on an import error it stays cleared and later incremental imports retry
export async function restoreClearedRecords(db: Db): Promise<number> {
  const rows = db
    .select({
      sessionId: sessionImports.sessionId,
      engine: sessionImports.engine,
      filePath: sessionImports.filePath,
      clearedAt: sessionImports.clearedAt,
    })
    .from(sessionImports)
    .leftJoin(sessions, eq(sessions.id, sessionImports.sessionId))
    .where(and(isNotNull(sessionImports.clearedAt), isNull(sessions.id)))
    .all();
  let restored = 0;
  for (const row of rows) {
    if (!existsSync(row.filePath)) continue;
    const imported = await importIsolated(db, row.sessionId, row.engine, row.filePath);
    db.update(sessionImports)
      .set({ clearedAt: row.clearedAt })
      .where(eq(sessionImports.sessionId, row.sessionId))
      .run();
    if (imported) restored++;
  }
  return restored;
}

// Claude Code design sessions (Contracts 22.2): project directories under claude-config/projects/ in the drafts and analyses directories
export function designClaudeDirs(dirs: SourceDirs): string[] {
  return [dirs.draftsDir, dirs.analysesDir].flatMap((root) =>
    isDir(root)
      ? subdirs(root).flatMap((d) => {
          const projects = path.join(d, 'claude-config', 'projects');
          return isDir(projects) ? subdirs(projects) : [];
        })
      : [],
  );
}

export interface RolloutInfo {
  file: string;
  id: string;
  cwd: string;
  archived: boolean;
}

// session_meta of every rollout under sessions/ and archived_sessions/ in a CODEX_HOME (cached by file size and mtime)
const metaCache = new Map<string, { size: number; mtimeMs: number; meta: RolloutInfo | null }>();

export function rolloutsOf(codexHome: string): RolloutInfo[] {
  const out: RolloutInfo[] = [];
  for (const [sub, archived] of [
    ['sessions', false],
    ['archived_sessions', true],
  ] as const) {
    const dir = path.join(codexHome, sub);
    if (!isDir(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (!isRollout(file)) continue;
      const stat = statSync(file);
      const cached = metaCache.get(file);
      let meta =
        cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.meta : undefined;
      if (meta === undefined) {
        const read = readSessionMeta(file);
        meta = read === null ? null : { file, id: read.id, cwd: read.cwd, archived };
        metaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
      }
      if (meta !== null) out.push(meta);
    }
  }
  return out;
}

export const localCodexRollouts = (dirs: SourceDirs) => rolloutsOf(dirs.codexHome);

// Codex design sessions: codex-home/ in the drafts and analyses directories
export function designCodexRollouts(dirs: SourceDirs): RolloutInfo[] {
  return [dirs.draftsDir, dirs.analysesDir].flatMap((root) =>
    isDir(root) ? subdirs(root).flatMap((d) => rolloutsOf(path.join(d, 'codex-home'))) : [],
  );
}
