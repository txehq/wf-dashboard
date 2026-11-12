import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  type SessionEngine,
  sessionEngines,
  sessions,
  sshHosts,
  variants,
  workflowTable,
} from '../db/schema.js';
import { sessionTitle } from '../api/user-text.js';
import { HttpError } from '../variants/errors.js';
import { DRAFT_WORKFLOWS } from '../workflows/schema.js';
import { codexHead, codexHomeOf } from './codex.js';
import { importProblemOf } from './import-problems.js';
import { clearedSessionIds, managed } from './imports.js';
import { claudeHead, readCompleteLines } from './ingest.js';
import {
  configOwners,
  designVariantOfSession,
  ownerOf,
  sessionConfigOf,
  type Variant,
} from './session-config.js';
import {
  designClaudeDirs,
  designCodexRollouts,
  importIsolated,
  localCodexRollouts,
  restoreClearedRecords,
  rolloutsOf,
  type SourceDirs,
} from './sources.js';

// The three columns at the top of the Sessions page (Contracts 25.1, 25.5): configurations, projects and sessions on
// disk. Only file metadata is read; nothing is imported

export interface ImportConfig {
  id: string;
  label: string;
  // The workflow a variant configuration belongs to (the first column groups by it); null for the local configuration
  workflow: { id: string; name: string } | null;
  // Number of sessions on disk
  sessionCount: number;
}

export interface ImportProject {
  cwd: string;
  name: string;
  sessionCount: number;
  importedCount: number;
}

export interface DiskSession {
  id: string;
  file: string;
  title: string | null;
  startedAt: Date;
  size: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// A session file under a configuration and the working directory of its project
interface Entry {
  file: string;
  id: string;
  cwd: string;
}

interface ConfigEntries {
  id: string;
  label: string;
  workflow: ImportConfig['workflow'];
  entries: Entry[];
}

const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const subdirs = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort();
const sessionFiles = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name));

// The project name in the second column: the working directory's name
export const projectName = (cwd: string) => path.basename(cwd) || cwd;

// Bytes per chunk and at most when reading the beginning: a long skill body or Codex's base_instructions may come before
// the first user message
const HEAD_CHUNK = 256 * 1024;
const HEAD_LIMIT = 4 * 1024 * 1024;

interface FileHead {
  firstAt: number | null;
  cwd: string | null;
  title: string | null;
}

// The beginning of a file is cached by its size and modification time
const headCache = new Map<string, { size: number; mtimeMs: number; head: FileHead }>();

function headOf(engine: SessionEngine, file: string): FileHead & { size: number; mtimeMs: number } {
  const stat = statSync(file);
  const cached = headCache.get(file);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs)
    return { ...cached.head, size: stat.size, mtimeMs: stat.mtimeMs };
  const head: FileHead = { firstAt: null, cwd: null, title: null };
  let offset = 0;
  while (offset < Math.min(stat.size, HEAD_LIMIT)) {
    const { lines, end, more } = readCompleteLines(file, offset, HEAD_CHUNK);
    const h = engine === 'claude' ? claudeHead(lines) : { ...codexHead(lines), cwd: null };
    head.firstAt ??= h.firstAt;
    head.cwd ??= h.cwd;
    if (head.title === null && h.firstUserText !== null) head.title = sessionTitle(h.firstUserText);
    if (head.title !== null || !more || end === offset) break;
    offset = end;
  }
  headCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, head });
  return { ...head, size: stat.size, mtimeMs: stat.mtimeMs };
}

// The working directory of a Claude Code project directory: as recorded in imported sessions, else read from the
// newest jsonl in it; the directory itself when neither has one
function cwdOfClaudeDir(db: Db, dir: string, files: string[]): string {
  const imported = db
    .select({ cwd: sessions.cwd })
    .from(sessions)
    .where(and(like(sessions.filePath, `${dir}${path.sep}%`), isNotNull(sessions.cwd)))
    .get();
  if (imported?.cwd != null) return imported.cwd;
  const newest = [...files].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of newest) {
    const cwd = headOf('claude', file).cwd;
    if (cwd !== null) return cwd;
  }
  return dir;
}

function claudeEntries(db: Db, dirs: string[]): Entry[] {
  return dirs.flatMap((dir) => {
    const files = sessionFiles(dir);
    if (files.length === 0) return [];
    const cwd = cwdOfClaudeDir(db, dir, files);
    return files.map((file) => ({ file, id: path.basename(file, '.jsonl'), cwd }));
  });
}

// The configurations of every variant not deleted (Contracts 24.3, 25.1, 33.3): grouped by workflow (workflows by
// creation time), by creation time within a group, listed even without sessions. When the migrated lfg and ic of 16.4
// share the Claude Code configuration directory data/variants/<storage_id or id>/home/claude/projects, its sessions go
// to one of them per ownerOf; sessions of design and optimize sessions (in each draft's or analysis's own configuration
// directory) go to the workflow-design or workflow-optimize variant used. Codex sessions come only from design and
// optimize sessions, so only those two workflows are listed
function variantConfigs(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  designEntries: Entry[],
): ConfigEntries[] {
  const rows = db
    .select({ variant: variants, workflowName: workflowTable.name })
    .from(variants)
    .innerJoin(workflowTable, eq(workflowTable.id, variants.workflowId))
    .where(
      engine === 'claude'
        ? isNull(variants.deletedAt)
        : and(isNull(variants.deletedAt), inArray(variants.workflowId, [...DRAFT_WORKFLOWS])),
    )
    .orderBy(
      asc(workflowTable.createdAt),
      asc(workflowTable.id),
      asc(variants.createdAt),
      asc(variants.id),
    )
    .all();
  const dirOf = (v: Variant) => v.storageId ?? v.id;
  const entriesOf = new Map<string, Entry[]>(rows.map((r) => [r.variant.id, []]));
  const storageIds = engine === 'claude' ? new Set(rows.map((r) => dirOf(r.variant))) : [];
  for (const storageId of storageIds) {
    const projects = path.join(dirs.variantsDir, storageId, 'home', 'claude', 'projects');
    if (!isDir(projects)) continue;
    const entries = claudeEntries(db, subdirs(projects));
    const bound = boundVariants(
      db,
      entries.map((e) => e.id),
    );
    const owners = configOwners(db, storageId);
    for (const e of entries) {
      const owner = ownerOf(owners, bound.get(e.id) ?? null);
      if (owner === undefined)
        throw new Error(`Configuration directory ${storageId} has no variant that is not deleted`);
      entriesOf.get(owner.id)?.push(e);
    }
  }
  for (const e of designEntries) {
    const variantId = designVariantOfSession(db, e.id);
    if (variantId !== null) entriesOf.get(variantId)?.push(e);
  }
  return rows.map(({ variant: v, workflowName }) => ({
    id: `variant:${v.id}`,
    label: v.name,
    workflow: { id: v.workflowId, name: workflowName },
    entries: entriesOf.get(v.id) ?? [],
  }));
}

// The variants sessions are bound to (sessions without a record or binding are absent)
function boundVariants(db: Db, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: sessions.id, variantId: sessions.variantId })
      .from(sessions)
      .where(and(inArray(sessions.id, ids), isNotNull(sessions.variantId)))
      .all()
      .flatMap((r) => (r.variantId === null ? [] : [[r.id, r.variantId] as const])),
  );
}

// Every configuration of an engine and the session files in it: the local configuration and each variant's
// (Contracts 25.1, 33.3). Incremental imports need only the dashboard's own configurations (withLocal false)
const LOCAL_LABEL = 'Local config';

// Name of an SSH host's configuration (Contracts 31.6): "<label> config"; "Deleted host config" when the host is gone
export function hostConfigLabel(db: Db, hostId: string): string {
  const host = db
    .select({ label: sshHosts.label })
    .from(sshHosts)
    .where(eq(sshHosts.id, hostId))
    .get();
  return `${host?.label ?? 'Deleted host'} config`;
}
function allConfigs(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  withLocal = true,
): ConfigEntries[] {
  const local = (entries: Entry[]): ConfigEntries[] =>
    withLocal ? [{ id: 'local', label: LOCAL_LABEL, workflow: null, entries }] : [];
  if (engine === 'claude') {
    return [
      ...local(
        withLocal && isDir(dirs.projectsDir) ? claudeEntries(db, subdirs(dirs.projectsDir)) : [],
      ),
      ...variantConfigs(db, dirs, engine, claudeEntries(db, designClaudeDirs(dirs))),
    ];
  }
  const entriesOf = (rollouts: ReturnType<typeof localCodexRollouts>): Entry[] =>
    rollouts.map((r) => ({ file: r.file, id: r.id, cwd: r.cwd }));
  return [
    ...local(withLocal ? entriesOf(localCodexRollouts(dirs)) : []),
    ...variantConfigs(db, dirs, engine, entriesOf(designCodexRollouts(dirs))),
  ];
}

function configOf(db: Db, dirs: SourceDirs, engine: SessionEngine, id: string): ConfigEntries {
  const found = allConfigs(db, dirs, engine).find((c) => c.id === id);
  if (found === undefined) throw new HttpError(400, `No such configuration: ${id} (${engine})`);
  return found;
}

// In the management table (imported and not cleared)
export function importedIds(db: Db, engine: SessionEngine, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.engine, engine), inArray(sessions.id, ids), managed))
      .all()
      .map((r) => r.id),
  );
}

const pageOf = <T>(all: T[], page: number, pageSize: number): Page<T> => ({
  items: all.slice((page - 1) * pageSize, page * pageSize),
  total: all.length,
});

export function importConfigs(db: Db, dirs: SourceDirs, engine: SessionEngine): ImportConfig[] {
  return allConfigs(db, dirs, engine).map((c) => ({
    id: c.id,
    label: c.label,
    workflow: c.workflow,
    sessionCount: c.entries.length,
  }));
}

// Second column: merged by working directory, sorted by name; q searches name and cwd case-insensitively
export function importProjects(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  query: { config: string; q: string; page: number; pageSize: number },
): Page<ImportProject> {
  const { entries } = configOf(db, dirs, engine, query.config);
  const imported = importedIds(
    db,
    engine,
    entries.map((e) => e.id),
  );
  const byCwd = new Map<string, ImportProject>();
  for (const e of entries) {
    const project = byCwd.get(e.cwd) ?? {
      cwd: e.cwd,
      name: projectName(e.cwd),
      sessionCount: 0,
      importedCount: 0,
    };
    project.sessionCount += 1;
    if (imported.has(e.id)) project.importedCount += 1;
    byCwd.set(e.cwd, project);
  }
  const q = query.q.toLowerCase();
  const matched = [...byCwd.values()]
    .filter((p) => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
  return pageOf(matched, query.page, query.pageSize);
}

// Third column: a project's sessions on disk, by start time and id descending; q searches title and session id
// case-insensitively. The caller replaces imported titles with the dashboard's
export function diskSessions(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  query: { config: string; cwd: string; q: string; page: number; pageSize: number },
): Page<DiskSession> {
  const { entries } = configOf(db, dirs, engine, query.config);
  const all = entries
    .filter((e) => e.cwd === query.cwd)
    .map((e): DiskSession => {
      const head = headOf(engine, e.file);
      return {
        id: e.id,
        file: e.file,
        title: head.title,
        // With no timed record yet, use the file's modification time
        startedAt: new Date(head.firstAt ?? head.mtimeMs),
        size: head.size,
      };
    });
  const q = query.q.toLowerCase();
  const matched = all
    .filter((s) => (s.title ?? '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id));
  return pageOf(matched, query.page, query.pageSize);
}

// Every session file listed under this engine's configurations, with its configuration
function listedFiles(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  files: string[],
): { entry: Entry; config: ConfigEntries }[] {
  const known = new Map(
    allConfigs(db, dirs, engine).flatMap((config) =>
      config.entries.map((entry) => [entry.file, { entry, config }] as const),
    ),
  );
  const unknown = files.filter((f) => !known.has(f));
  if (unknown.length > 0) {
    const name = engine === 'claude' ? 'Claude Code' : 'Codex';
    throw new HttpError(
      400,
      `Not session files under a ${name} configuration: ${unknown.join(', ')}`,
    );
  }
  return files.flatMap((f) => known.get(f) ?? []);
}

// files of POST /api/session-import: must be session files listed under one of this engine's configurations
export function importableFiles(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  files: string[],
): Entry[] {
  return listedFiles(db, dirs, engine, files).map((f) => f.entry);
}

// A configuration's name (analysis scope and right pane, Contracts 27): variants are written "variant name (workflow)"
export const configLabel = (c: { label: string; workflow: { name: string } | null }) =>
  c.workflow === null ? c.label : `${c.label} (${c.workflow.name})`;

// Sessions picked from disk for a new analysis (Contracts 27): must be files listed under one of this engine's
// configurations; the configuration matches the first column's grouping, title and start time match the third column
export interface AnalysisEntry {
  id: string;
  engine: SessionEngine;
  file: string;
  cwd: string;
  config: { id: string; label: string };
  title: string | null;
  startedAt: Date;
}

export function analysisEntries(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  files: string[],
): AnalysisEntry[] {
  return listedFiles(db, dirs, engine, files).map(({ entry, config }) => {
    const head = headOf(engine, entry.file);
    return {
      id: entry.id,
      engine,
      file: entry.file,
      cwd: entry.cwd,
      config: { id: config.id, label: configLabel(config) },
      title: head.title,
      startedAt: new Date(head.firstAt ?? head.mtimeMs),
    };
  });
}

// The configuration of a session already in the dashboard (Contracts 25.1, 27): as the first column groups it (by
// ownerOf in variant configuration directories); null when in no configuration (tests' own directories, directories
// whose variants are all deleted)
export function sessionConfig(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  filePath: string,
  variantId: string | null,
): { id: string; label: string } | null {
  const c = sessionConfigOf(dirs, engine, filePath);
  if (c === null) return null;
  if (c.id === 'local') return { id: 'local', label: LOCAL_LABEL };
  if (c.id === 'ssh') return { id: `ssh:${c.hostId}`, label: hostConfigLabel(db, c.hostId) };
  // A design or optimize session's session belongs to the variant used, which is its bound variant (Contracts 33.3)
  const owner =
    c.id === 'design'
      ? variantId === null
        ? undefined
        : db
            .select()
            .from(variants)
            .where(and(eq(variants.id, variantId), isNull(variants.deletedAt)))
            .get()
      : ownerOf(configOwners(db, c.storageId), variantId);
  if (owner === undefined) return null;
  const workflow = db
    .select({ name: workflowTable.name })
    .from(workflowTable)
    .where(eq(workflowTable.id, owner.workflowId))
    .get();
  if (workflow === undefined) throw new Error(`The workflow of variant ${owner.id} does not exist`);
  return { id: `variant:${owner.id}`, label: configLabel({ label: owner.name, workflow }) };
}

// A literal in a LIKE pattern: % and _ are not wildcards (used with escape '\\')
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Sessions whose file is in one of these directories
const under = (...dirList: string[]) =>
  sql`(${sql.join(
    dirList.map(
      (d) => sql`${sessions.filePath} like ${`${likeLiteral(d + path.sep)}%`} escape '\\'`,
    ),
    sql` or `,
  )})`;

const localDir = (dirs: SourceDirs, engine: SessionEngine) =>
  engine === 'claude' ? dirs.projectsDir : dirs.codexHome;

// The config parameter of GET /api/sessions (Contracts 25.5): sessions in this configuration, as the first column groups
// them (by ownerOf in variant configuration directories)
export function configCondition(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  configId: string,
): SQL {
  if (configId === 'local') return under(localDir(dirs, engine));
  // SSH hosts (Contracts 31.6): copies under data/remote/<hostId>/
  const hostId = /^ssh:([^:]+)$/.exec(configId)?.[1];
  if (hostId !== undefined) return under(path.join(dirs.remoteDir, hostId));
  const variantId = /^variant:(.+)$/.exec(configId)?.[1];
  const variant =
    variantId === undefined
      ? undefined
      : db
          .select()
          .from(variants)
          .where(and(eq(variants.id, variantId), isNull(variants.deletedAt)))
          .get();
  if (variant === undefined)
    throw new HttpError(400, `No such configuration: ${configId} (${engine})`);
  // Sessions of design and optimize sessions are in each draft's or analysis's own configuration directory, bound to
  // the variant used (Contracts 33.3)
  const designed = sql`(${under(dirs.draftsDir, dirs.analysesDir)} and ${eq(sessions.variantId, variant.id)})`;
  if (engine !== 'claude') return designed;
  const storageId = variant.storageId ?? variant.id;
  const inDir = under(path.join(dirs.variantsDir, storageId, 'home', 'claude', 'projects'));
  const owners = configOwners(db, storageId);
  if (owners[0]?.id !== variant.id)
    return sql`((${inDir} and ${eq(sessions.variantId, variant.id)}) or ${designed})`;
  // The earliest-created one gets everything except what other variants sharing this directory are bound to
  const others = owners.slice(1).map((o) => o.id);
  if (others.length === 0) return sql`(${inDir} or ${designed})`;
  return sql`((${inDir} and (${isNull(sessions.variantId)} or ${notInArray(sessions.variantId, others)})) or ${designed})`;
}

// The modification time the last incremental import saw: a file with the same size but a new modification time
// (subagent writes, a rewritten rollout) is imported once too
const seenMtimes = new Map<string, number>();

// One incremental import (Contracts 25.1, 25.5): imported sessions (cleared ones included) that grew or changed
// modification time; new, never-cleared sessions in the dashboard's own configurations (variant configuration
// directories, design and optimize). Sessions not imported from the local configuration are not imported. Returns the
// number of files imported
export async function tailSessions(db: Db, dirs: SourceDirs): Promise<number> {
  let imported = await restoreClearedRecords(db);
  const rows = db
    .select({
      id: sessions.id,
      engine: sessions.engine,
      filePath: sessions.filePath,
      parseOffset: sessions.parseOffset,
    })
    .from(sessions)
    .all();
  const exists = (id: string) =>
    db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get() !== undefined;
  for (const row of rows) {
    let file = row.filePath;
    let stat = statSync(file, { throwIfNoEntry: false });
    // A Codex rollout archived or restored outside the dashboard has moved: find it by session id in the same
    // CODEX_HOME (Contracts 25.3)
    if (stat === undefined && row.engine === 'codex') {
      const found = rolloutsOf(codexHomeOf(file)).find((r) => r.id === row.id);
      if (found !== undefined) {
        file = found.file;
        stat = statSync(file);
      }
    }
    // Files deleted outside the dashboard: the record stays and its content no longer changes
    if (stat === undefined) continue;
    const seen = seenMtimes.get(file);
    seenMtimes.set(file, stat.mtimeMs);
    const moved = file !== row.filePath;
    // Try again those that failed last time or wait for spill files (while a subagent record waits the main jsonl may
    // no longer change) (Requirements Log round 13, item 19)
    if (
      !moved &&
      stat.size <= row.parseOffset &&
      (seen === undefined || seen === stat.mtimeMs) &&
      importProblemOf(row.id) === null
    )
      continue;
    // Sessions deleted after this import started are not imported
    if (!exists(row.id)) continue;
    if (await importIsolated(db, row.id, row.engine, file)) imported++;
  }
  const cleared = clearedSessionIds(db);
  for (const engine of sessionEngines)
    for (const c of allConfigs(db, dirs, engine, false))
      for (const e of c.entries) {
        if (cleared.has(e.id) || exists(e.id)) continue;
        if (await importIsolated(db, e.id, engine, e.file)) imported++;
      }
  return imported;
}

export interface SessionTail {
  close(): void;
}

// Interval of incremental imports
const TAIL_MS = 5000;

// An incremental import every TAIL_MS while the service runs (started by main.ts). The next one does not start until
// the last is done; importIsolated records one session's error, errors belonging to no session go to onError and stop
// further imports
export function startSessionTail(
  db: Db,
  dirs: SourceDirs,
  onError: (error: Error) => void,
): SessionTail {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      tailSessions(db, dirs).then(schedule, (error: unknown) => {
        closed = true;
        onError(error instanceof Error ? error : new Error(String(error)));
      });
    }, TAIL_MS);
  };
  schedule();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}
