import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type SessionEngine, sessionImports, sessions } from '../db/schema.js';
import { HttpError } from '../variants/errors.js';
import { ingestCodexFile, isRollout, readSessionMeta } from './codex.js';
import { markAnalysisOnly, restoreCleared } from './imports.js';
import { ingestFile } from './ingest.js';
import { configSourceDirs } from './session-config.js';

export const defaultSourceDirs: SourceDirs = configSourceDirs;

export interface SourceDirs {
  // ~/.claude/projects（config.claudeProjectsDir）
  projectsDir: string;
  // data/variants
  variantsDir: string;
  // 本机 Codex 的 CODEX_HOME（config.codexHome，Contracts 25.1）
  codexHome: string;
  // 设计与优化（Contracts 17、19.3、22）：草稿目录与分析目录，其中的 claude-config/ 与 codex-home/
  draftsDir: string;
  analysesDir: string;
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

// 导入时每段读的字节数：37 MB 的 session 分成约二十段，每段之间让出事件循环，导入大的 session 时页面、Live 与其他请求照常响应
const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;

// 分段增量导入一个文件；返回是否有变化
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

// 开始分析时读入还不在 dashboard 中的 session（Contracts 27）：照常分段导入，第一段建出记录后即记为只为分析读入，
// 不进入管理表格。文件中还没有带时间的记录（建不出 session）时 400
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
  if (!marked) throw new HttpError(400, `session ${sessionId} 中还没有记录，不能分析：${file}`);
}

export interface ImportedFile {
  id: string;
  file: string;
}

// 用户点"导入 N 个"（Contracts 25.1、25.5）：逐个分段导入，新建的记为已导入，清除过的清空清除时间（重新进入管理表格）。
// 已导入的接着增量导入；Claude Code 的同一个 session 已从另一个文件导入时（例如 resume 复制进了交互的配置目录）不再导入这一份。
// Codex 的 rollout 在 dashboard 之外归档或恢复后换了位置，ingestCodexFile 记下新的位置
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

// 早先的清除删除了 dashboard 中的记录：按导入记录中的文件重新导入，仍记为清除（清除时间不变），
// 用到它的 run、分析与 Live 项重新读得到它的数据。文件已不在的不导入
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
    await importInChunks(db, row.engine, row.filePath);
    db.update(sessionImports)
      .set({ clearedAt: row.clearedAt })
      .where(eq(sessionImports.sessionId, row.sessionId))
      .run();
    restored++;
  }
  return restored;
}

// 设计与优化的 Claude Code 会话（Contracts 22.2）：草稿目录与分析目录中 claude-config/projects/ 下的项目目录
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

// 一个 CODEX_HOME 中 sessions/ 与 archived_sessions/ 下全部 rollout 的 session_meta（按文件的大小与修改时间缓存）
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

// 设计与优化的 Codex 会话：草稿目录与分析目录中的 codex-home/
export function designCodexRollouts(dirs: SourceDirs): RolloutInfo[] {
  return [dirs.draftsDir, dirs.analysesDir].flatMap((root) =>
    isDir(root) ? subdirs(root).flatMap((d) => rolloutsOf(path.join(d, 'codex-home'))) : [],
  );
}
