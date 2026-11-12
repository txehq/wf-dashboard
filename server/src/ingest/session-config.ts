import path from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  liveSessions,
  type SessionEngine,
  sessions,
  variants,
  workflowDrafts,
} from '../db/schema.js';
import type { SourceDirs } from './sources.js';

// The server's source directories (config); sources.ts defaultSourceDirs is this one. Kept here so the binding module can tell local sessions without importing the import module
export const configSourceDirs: SourceDirs = {
  projectsDir: config.claudeProjectsDir,
  variantsDir: config.variantsDir,
  codexHome: config.codexHome,
  draftsDir: config.workflowDraftsDir,
  analysesDir: path.join(config.dataDir, 'analyses'),
  remoteDir: config.remoteDir,
};

// Which config directory a session file is in (Contracts 25.1, 25.4, 31.6, 33.3): the local machine config, a variant's config directory (storageId is
// the directory name under data/variants/), a design session's own config directory (design under the drafts directory, optimize under the analyses directory; these sessions belong to
// the workflow-design or workflow-optimize variant used, see designVariantOfSession), or an SSH host (copies under
// data/remote/<hostId>/). null outside these directories (tests' own directories)
export type SessionConfig =
  | { id: 'local' }
  | { id: 'variant'; storageId: string }
  | { id: 'design'; purpose: 'design' | 'optimize' }
  | { id: 'ssh'; hostId: string };

const inside = (file: string, dir: string) => file.startsWith(`${dir}${path.sep}`);

export function sessionConfigOf(
  dirs: SourceDirs,
  engine: SessionEngine,
  filePath: string,
): SessionConfig | null {
  if (inside(filePath, dirs.remoteDir)) {
    const [hostId] = path.relative(dirs.remoteDir, filePath).split(path.sep);
    if (hostId !== undefined && hostId !== '') return { id: 'ssh', hostId };
  }
  if (engine === 'claude' && inside(filePath, dirs.projectsDir)) return { id: 'local' };
  if (engine === 'codex' && inside(filePath, dirs.codexHome)) return { id: 'local' };
  if (inside(filePath, dirs.draftsDir)) return { id: 'design', purpose: 'design' };
  if (inside(filePath, dirs.analysesDir)) return { id: 'design', purpose: 'optimize' };
  if (engine === 'claude' && inside(filePath, dirs.variantsDir)) {
    // data/variants/<dir>/home/claude/projects/<slug>/<session>.jsonl
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

// Local machine config sessions take no part in workflow-specific content: no workflow or stages shown, no variant bound (Contracts 25.4)
export const isLocalSession = (dirs: SourceDirs, engine: SessionEngine, filePath: string) =>
  sessionConfigOf(dirs, engine, filePath)?.id === 'local';

export type Variant = typeof variants.$inferSelect;

// Undeleted variants owning a config directory (data/variants/<storage_id or id>), by creation time; the lfg and ic split by the 16.4 migration share one directory
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

// Which variant's config a session in the directory belongs to (Contracts 25.1): its bound variant (from a run, an interactive process, or auto-binding)
// if that is one of the directory's variants, otherwise the earliest created. undefined when all the directory's variants are deleted
export const ownerOf = (owners: Variant[], boundVariantId: string | null): Variant | undefined =>
  owners.find((o) => o.id === boundVariantId) ?? owners[0];

// The workflow-design or workflow-optimize variant used by a design session's session (Contracts 33.3): as recorded by its Live item's draft;
// when the interactive item is deleted, the session's currently bound variant. null when neither exists
export function designVariantOfSession(db: Db, sessionId: string): string | null {
  const draft = db
    .select({ variantId: workflowDrafts.designVariantId })
    .from(liveSessions)
    .innerJoin(workflowDrafts, eq(workflowDrafts.liveId, liveSessions.id))
    .where(eq(liveSessions.claudeSessionId, sessionId))
    .get();
  if (draft?.variantId != null) return draft.variantId;
  return (
    db
      .select({ variantId: sessions.variantId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()?.variantId ?? null
  );
}
