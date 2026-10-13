import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sources } from '../db/schema.js';
import { config } from '../config.js';
import { ingestFile } from './ingest.js';

export const defaultSourceDirs: SourceDirs = {
  projectsDir: config.claudeProjectsDir,
  variantsDir: config.variantsDir,
};

export interface SourceInfo {
  path: string;
  // variant 的来源总是勾选
  variant: string | null;
  sessionCount: number;
  lastModified: Date | null;
  checked: boolean;
}

export interface SourceDirs {
  // ~/.claude/projects（config.claudeProjectsDir）
  projectsDir: string;
  // data/variants
  variantsDir: string;
}

function subdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort();
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function describe(dir: string, variant: string | null, checked: boolean): SourceInfo {
  const files = sessionFiles(dir);
  const mtimes = files.map((f) => statSync(f).mtimeMs);
  return {
    path: dir,
    variant,
    sessionCount: files.length,
    lastModified: mtimes.length === 0 ? null : new Date(Math.max(...mtimes)),
    checked,
  };
}

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// data/variants/<id>/home/claude/projects/<slug>；variant 尚未安装时没有这个目录
function variantDirs(variantsDir: string): { dir: string; variant: string }[] {
  if (!isDir(variantsDir)) return [];
  const out: { dir: string; variant: string }[] = [];
  for (const variantDir of subdirs(variantsDir)) {
    const projects = path.join(variantDir, 'home', 'claude', 'projects');
    if (!isDir(projects)) continue;
    for (const dir of subdirs(projects)) out.push({ dir, variant: path.basename(variantDir) });
  }
  return out;
}

export function listSources(db: Db, dirs: SourceDirs): SourceInfo[] {
  const enabled = new Set(
    db
      .select({ path: sources.path })
      .from(sources)
      .where(eq(sources.enabled, true))
      .all()
      .map((r) => r.path),
  );
  return [
    ...subdirs(dirs.projectsDir).map((dir) => describe(dir, null, enabled.has(dir))),
    ...variantDirs(dirs.variantsDir).map(({ dir, variant }) => describe(dir, variant, true)),
  ];
}

// ~/.claude/projects 下可以勾选的目录
export function homeSourceDirs(dirs: SourceDirs): string[] {
  return subdirs(dirs.projectsDir);
}

// 设置 ~/.claude/projects 下的勾选集合；variant 目录登记为总是勾选
export function setCheckedSources(db: Db, dirs: SourceDirs, paths: string[]) {
  const known = new Set(homeSourceDirs(dirs));
  const unknown = paths.filter((p) => !known.has(p));
  if (unknown.length > 0)
    throw new Error(`不是 ${dirs.projectsDir} 下的目录：${unknown.join(', ')}`);
  db.$client.transaction(() => {
    for (const p of paths)
      db.insert(sources)
        .values({ path: p, enabled: true })
        .onConflictDoUpdate({ target: sources.path, set: { enabled: true } })
        .run();
    db.update(sources)
      .set({ enabled: false })
      .where(paths.length === 0 ? undefined : notInArray(sources.path, paths))
      .run();
    for (const { dir, variant } of variantDirs(dirs.variantsDir))
      db.insert(sources)
        .values({ path: dir, enabled: true, variant })
        .onConflictDoUpdate({ target: sources.path, set: { enabled: true, variant } })
        .run();
  })();
}

export interface ImportSummary {
  files: number;
  changedSessions: number;
  durationMs: number;
}

// 导入时每段读的字节数：37 MB 的 session 分成约二十段，每段之间让出事件循环，导入大的 session 时页面、Live 与其他请求照常响应
const IMPORT_CHUNK_BYTES = 2 * 1024 * 1024;

// 对全部勾选目录中的每个 session 做增量导入
export async function importCheckedSources(db: Db): Promise<ImportSummary> {
  const started = performance.now();
  const dirs = db
    .select({ path: sources.path })
    .from(sources)
    .where(eq(sources.enabled, true))
    .all()
    .map((r) => r.path);
  let files = 0;
  let changedSessions = 0;
  for (const dir of dirs)
    for (const file of sessionFiles(dir)) {
      files++;
      let changed = false;
      for (;;) {
        const result = ingestFile(db, file, IMPORT_CHUNK_BYTES);
        changed ||= result.changed;
        await setImmediate();
        if (!result.more) break;
      }
      if (changed) changedSessions++;
    }
  return { files, changedSessions, durationMs: Math.round(performance.now() - started) };
}
