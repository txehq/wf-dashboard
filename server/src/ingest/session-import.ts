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
  variants,
  workflowTable,
} from '../db/schema.js';
import { sessionTitle } from '../api/user-text.js';
import { HttpError } from '../variants/errors.js';
import { codexHead, codexHomeOf } from './codex.js';
import { clearedSessionIds, managed } from './imports.js';
import { claudeHead, readCompleteLines } from './ingest.js';
import { configOwners, ownerOf, sessionConfigOf, type Variant } from './session-config.js';
import {
  designClaudeDirs,
  designCodexRollouts,
  importInChunks,
  localCodexRollouts,
  restoreClearedRecords,
  rolloutsOf,
  type SourceDirs,
} from './sources.js';

// Sessions 页面上面的三列（Contracts 25.1、25.5）：配置、项目、磁盘上的 session。只读文件的元数据，不导入

export interface ImportConfig {
  id: string;
  label: string;
  // variant 的配置所属的 workflow（第一列按它分组）；本机配置、设计与优化为 null
  workflow: { id: string; name: string } | null;
  // 磁盘上的 session 数
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

// 一个配置下的一个 session 文件与它所在项目的工作目录
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

// 第二列的项目名：工作目录的目录名
export const projectName = (cwd: string) => path.basename(cwd) || cwd;

// 读开头信息时每段读的字节数与最多读的字节数：第一条用户消息之前可能有很长的 skill 正文或 Codex 的 base_instructions
const HEAD_CHUNK = 256 * 1024;
const HEAD_LIMIT = 4 * 1024 * 1024;

interface FileHead {
  firstAt: number | null;
  cwd: string | null;
  title: string | null;
}

// 文件的开头信息按文件的大小与修改时间缓存
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

// Claude Code 项目目录的工作目录：已导入的 session 中记下的，否则从目录中最新的 jsonl 读出；都没有时为目录本身
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

// 全部未删除的 variant 的配置（Contracts 24.3、25.1）：按 workflow 分组（workflow 按创建时间），组内按创建时间，没有 session 的
// 也列出。配置目录 data/variants/<storage_id 或 id>/home/claude/projects 由 16.4 的迁移拆出的 lfg、ic 共用时，目录中的
// session 按 ownerOf 归入其中一个
function variantConfigs(db: Db, dirs: SourceDirs): ConfigEntries[] {
  const rows = db
    .select({ variant: variants, workflowName: workflowTable.name })
    .from(variants)
    .innerJoin(workflowTable, eq(workflowTable.id, variants.workflowId))
    .where(isNull(variants.deletedAt))
    .orderBy(
      asc(workflowTable.createdAt),
      asc(workflowTable.id),
      asc(variants.createdAt),
      asc(variants.id),
    )
    .all();
  const dirOf = (v: Variant) => v.storageId ?? v.id;
  const entriesOf = new Map<string, Entry[]>(rows.map((r) => [r.variant.id, []]));
  for (const storageId of new Set(rows.map((r) => dirOf(r.variant)))) {
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
      if (owner === undefined) throw new Error(`配置目录 ${storageId} 没有未删除的 variant`);
      entriesOf.get(owner.id)?.push(e);
    }
  }
  return rows.map(({ variant: v, workflowName }) => ({
    id: `variant:${v.id}`,
    label: v.name,
    workflow: { id: v.workflowId, name: workflowName },
    entries: entriesOf.get(v.id) ?? [],
  }));
}

// session 绑定的 variant（没有记录或没有绑定的不在其中）
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

// 一个引擎的全部配置与其中的 session 文件：本机配置、各 variant 的配置目录、设计与优化（Contracts 25.1）。
// 增量导入只要 dashboard 自己的配置（withLocal 为 false）
const LOCAL_LABEL = '本机配置';
const DESIGN_LABEL = '设计与优化';
function allConfigs(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  withLocal = true,
): ConfigEntries[] {
  const local = (entries: Entry[]): ConfigEntries[] =>
    withLocal ? [{ id: 'local', label: LOCAL_LABEL, workflow: null, entries }] : [];
  const design = (entries: Entry[]): ConfigEntries[] =>
    entries.length > 0 ? [{ id: 'design', label: DESIGN_LABEL, workflow: null, entries }] : [];
  if (engine === 'claude') {
    return [
      ...local(
        withLocal && isDir(dirs.projectsDir) ? claudeEntries(db, subdirs(dirs.projectsDir)) : [],
      ),
      ...variantConfigs(db, dirs),
      ...design(claudeEntries(db, designClaudeDirs(dirs))),
    ];
  }
  const entriesOf = (rollouts: ReturnType<typeof localCodexRollouts>): Entry[] =>
    rollouts.map((r) => ({ file: r.file, id: r.id, cwd: r.cwd }));
  return [
    ...local(withLocal ? entriesOf(localCodexRollouts(dirs)) : []),
    ...design(entriesOf(designCodexRollouts(dirs))),
  ];
}

function configOf(db: Db, dirs: SourceDirs, engine: SessionEngine, id: string): ConfigEntries {
  const found = allConfigs(db, dirs, engine).find((c) => c.id === id);
  if (found === undefined) throw new HttpError(400, `没有这个配置：${id}（${engine}）`);
  return found;
}

// 在管理表格中的（已导入、没有清除）
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

// 第二列：按工作目录合并，按名字排序；q 不分大小写地搜索名字与 cwd
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

// 第三列：一个项目在磁盘上的 session，按开始时间、id 倒序；q 不分大小写地搜索标题与 session id。
// 已导入的标题由调用者换成 dashboard 中的
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
        // 还没有带时间的记录时取文件的修改时间
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

// 这个引擎的配置下列出的全部 session 文件与所在的配置
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
    throw new HttpError(400, `不是 ${name} 配置下的 session 文件：${unknown.join(', ')}`);
  }
  return files.flatMap((f) => known.get(f) ?? []);
}

// POST /api/session-import 的 files：必须是这个引擎某个配置下列出的 session 文件
export function importableFiles(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  files: string[],
): Entry[] {
  return listedFiles(db, dirs, engine, files).map((f) => f.entry);
}

// 配置的名字（分析的范围与右栏，Contracts 27）：variant 的写「variant 名 (workflow)」
export const configLabel = (c: { label: string; workflow: { name: string } | null }) =>
  c.workflow === null ? c.label : `${c.label} (${c.workflow.name})`;

// 新建分析中从磁盘选的 session（Contracts 27）：必须是这个引擎某个配置下列出的文件；所在的配置与第一列的归属相同，
// 标题与开始时间与第三列相同
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

// 已在 dashboard 中的 session 所在的配置（Contracts 25.1、27）：与第一列的归属相同（variant 的配置目录中按 ownerOf 归入）；
// 不在任何配置中（测试自己的目录、目录的 variant 都已删除）时为 null
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
  if (c.id === 'design') return { id: 'design', label: DESIGN_LABEL };
  const owner = ownerOf(configOwners(db, c.storageId), variantId);
  if (owner === undefined) return null;
  const workflow = db
    .select({ name: workflowTable.name })
    .from(workflowTable)
    .where(eq(workflowTable.id, owner.workflowId))
    .get();
  if (workflow === undefined) throw new Error(`variant ${owner.id} 的 workflow 不存在`);
  return { id: `variant:${owner.id}`, label: configLabel({ label: owner.name, workflow }) };
}

// LIKE 模式中的字面量：% 与 _ 不是通配符（与 escape '\\' 一起用）
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 文件在这些目录之一中的 session
const under = (...dirList: string[]) =>
  sql`(${sql.join(
    dirList.map(
      (d) => sql`${sessions.filePath} like ${`${likeLiteral(d + path.sep)}%`} escape '\\'`,
    ),
    sql` or `,
  )})`;

const localDir = (dirs: SourceDirs, engine: SessionEngine) =>
  engine === 'claude' ? dirs.projectsDir : dirs.codexHome;

// GET /api/sessions 的 config 参数（Contracts 25.5）：这个配置中的 session，与第一列的归属相同（variant 的配置目录中按
// ownerOf 归入）
export function configCondition(
  db: Db,
  dirs: SourceDirs,
  engine: SessionEngine,
  configId: string,
): SQL {
  if (configId === 'local') return under(localDir(dirs, engine));
  if (configId === 'design') return under(dirs.draftsDir, dirs.analysesDir);
  const variantId = /^variant:(.+)$/.exec(configId)?.[1];
  const variant =
    variantId === undefined || engine !== 'claude'
      ? undefined
      : db
          .select()
          .from(variants)
          .where(and(eq(variants.id, variantId), isNull(variants.deletedAt)))
          .get();
  if (variant === undefined) throw new HttpError(400, `没有这个配置：${configId}（${engine}）`);
  const storageId = variant.storageId ?? variant.id;
  const inDir = under(path.join(dirs.variantsDir, storageId, 'home', 'claude', 'projects'));
  const owners = configOwners(db, storageId);
  if (owners[0]?.id !== variant.id) return sql`${inDir} and ${eq(sessions.variantId, variant.id)}`;
  // 最早建的得到除了绑定共用这个目录的其他 variant 以外的全部
  const others = owners.slice(1).map((o) => o.id);
  if (others.length === 0) return inDir;
  return sql`${inDir} and (${isNull(sessions.variantId)} or ${notInArray(sessions.variantId, others)})`;
}

// 增量导入的上一次所见的修改时间：文件大小不变但修改时间变了时（子代理写入、rollout 被改写）也导入一次
const seenMtimes = new Map<string, number>();

// 一次增量导入（Contracts 25.1、25.5）：已导入的 session（含清除了的）中变长或修改时间变了的；dashboard 自己的配置（variant 的
// 配置目录、设计与优化）中新出现的、没有清除过的。本机配置中没有导入的不导入。返回导入了的文件数
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
    // Codex 的 rollout 在 dashboard 之外归档或恢复后换了位置：在同一个 CODEX_HOME 中按 session id 找到它（Contracts 25.3）
    if (stat === undefined && row.engine === 'codex') {
      const found = rolloutsOf(codexHomeOf(file)).find((r) => r.id === row.id);
      if (found !== undefined) {
        file = found.file;
        stat = statSync(file);
      }
    }
    // 在 dashboard 之外删除了的文件：记录保留，内容不再变化
    if (stat === undefined) continue;
    const seen = seenMtimes.get(file);
    seenMtimes.set(file, stat.mtimeMs);
    const moved = file !== row.filePath;
    if (!moved && stat.size <= row.parseOffset && (seen === undefined || seen === stat.mtimeMs))
      continue;
    // 这一次开始之后删除了的不再导入
    if (!exists(row.id)) continue;
    await importInChunks(db, row.engine, file);
    imported++;
  }
  const cleared = clearedSessionIds(db);
  for (const engine of sessionEngines)
    for (const c of allConfigs(db, dirs, engine, false))
      for (const e of c.entries) {
        if (cleared.has(e.id) || exists(e.id)) continue;
        await importInChunks(db, engine, e.file);
        imported++;
      }
  return imported;
}

export interface SessionTail {
  close(): void;
}

// 增量导入的间隔
const TAIL_MS = 5000;

// 服务运行期间每 TAIL_MS 做一次增量导入（main.ts 启动）。一次没做完时不开始下一次；出错时交给 onError，之后不再导入
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
