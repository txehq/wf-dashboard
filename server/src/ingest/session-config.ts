import path from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { type SessionEngine, variants } from '../db/schema.js';
import type { SourceDirs } from './sources.js';

// 服务的来源目录（config）；sources.ts 的 defaultSourceDirs 即这一份。放在这里，绑定模块判定本机 session 时不必引用导入模块
export const configSourceDirs: SourceDirs = {
  projectsDir: config.claudeProjectsDir,
  variantsDir: config.variantsDir,
  codexHome: config.codexHome,
  draftsDir: config.workflowDraftsDir,
  analysesDir: path.join(config.dataDir, 'analyses'),
};

// 一个 session 文件在哪个配置目录中（Contracts 25.1、25.4）：本机配置、某个 variant 的配置目录（storageId 为
// data/variants/ 下的目录名）、设计与优化（草稿目录中的为设计，分析目录中的为优化）。不在这些目录中的（测试自己的目录）为 null
export type SessionConfig =
  | { id: 'local' }
  | { id: 'variant'; storageId: string }
  | { id: 'design'; purpose: 'design' | 'optimize' };

const inside = (file: string, dir: string) => file.startsWith(`${dir}${path.sep}`);

export function sessionConfigOf(
  dirs: SourceDirs,
  engine: SessionEngine,
  filePath: string,
): SessionConfig | null {
  if (engine === 'claude' && inside(filePath, dirs.projectsDir)) return { id: 'local' };
  if (engine === 'codex' && inside(filePath, dirs.codexHome)) return { id: 'local' };
  if (inside(filePath, dirs.draftsDir)) return { id: 'design', purpose: 'design' };
  if (inside(filePath, dirs.analysesDir)) return { id: 'design', purpose: 'optimize' };
  if (engine === 'claude' && inside(filePath, dirs.variantsDir)) {
    // data/variants/<目录>/home/claude/projects/<slug>/<session>.jsonl
    const [storageId, home, claude, projects] = path
      .relative(dirs.variantsDir, filePath)
      .split(path.sep);
    if (
      storageId !== undefined &&
      home === 'home' &&
      claude === 'claude' &&
      projects === 'projects'
    )
      return { id: 'variant', storageId };
  }
  return null;
}

// 本机配置的 session 不参与 workflow 独有的内容：不显示 workflow 与阶段，不绑定 variant（Contracts 25.4）
export const isLocalSession = (dirs: SourceDirs, engine: SessionEngine, filePath: string) =>
  sessionConfigOf(dirs, engine, filePath)?.id === 'local';

export type Variant = typeof variants.$inferSelect;

// 配置目录（data/variants/<storage_id 或 id>）所属的未删除的 variant，按创建时间；16.4 的迁移拆出的 lfg、ic 共用一个目录
export function configOwners(db: Db, storageId: string): Variant[] {
  return db
    .select()
    .from(variants)
    .where(
      and(
        isNull(variants.deletedAt),
        or(
          eq(variants.storageId, storageId),
          and(isNull(variants.storageId), eq(variants.id, storageId)),
        ),
      ),
    )
    .orderBy(asc(variants.createdAt), asc(variants.id))
    .all();
}

// 目录中的一个 session 归入哪个 variant 的配置（Contracts 25.1）：它绑定的 variant（run 的、交互进程的、自动绑定的）
// 是这个目录的 variant 之一时归入它，否则归入最早建的。目录的 variant 都已删除时为 undefined
export const ownerOf = (owners: Variant[], boundVariantId: string | null): Variant | undefined =>
  owners.find((o) => o.id === boundVariantId) ?? owners[0];
