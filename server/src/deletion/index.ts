import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  analyses,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  variants as variantsTable,
  workflowDrafts,
  workflowTable,
} from '../db/schema.js';
import { draftLayout } from '../drafts/dir.js';
import { events } from '../events.js';
import { analysisLayout } from '../insights/index.js';
import type { Live } from '../live/index.js';
import { HttpError } from '../variants/errors.js';
import type { Variant, Variants } from '../variants/index.js';
import { workflowRow } from '../workflows/index.js';
import { isBuiltinWorkflow } from '../workflows/schema.js';
import type { DeleteBody, DeletionBlocker, DeletionPlan, SessionsChoice } from './views.js';
import { claudeSessionFiles, deleteClaudeSessions } from './session-files.js';

export interface DeletionDeps {
  db: Db;
  variants: Variants;
  live: Live;
  // data/workflow-drafts
  draftsDir: string;
  // Data directory: optimisation drafts live in its analyses/<id>/
  dataDir: string;
}

const ACTIVE_RUNS = ['queued', 'preparing', 'running', 'grading'] as const;
const ACTIVE_ANALYSES = ['queued', 'running'] as const;

type DraftRow = typeof workflowDrafts.$inferSelect;

// Deleting variants and workflows (Contracts section 24): whether deletion is allowed, the two ways to handle associated sessions, retained records, deleted files
export function createDeletion({ db, variants, live, draftsDir, dataDir }: DeletionDeps) {
  // Associated sessions (24.2): non-run sessions bound to these variants
  function boundSessions(ids: string[]) {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(sessions)
      .where(
        and(
          inArray(sessions.variantId, ids),
          or(isNull(sessions.variantBinding), ne(sessions.variantBinding, 'run')),
        ),
      )
      .all();
  }

  // Local-config Magi Agent sessions (Contracts 23.6): may be auto-bound to a variant but use this machine's ~/.claude, so
  // they are not deleted with the variant and neither is their Live item; on delete together they switch to local config.
  // Sessions of a Magi Agent configured with a variant are handled like that variant's other sessions
  function isLocalAgentSession(s: typeof sessions.$inferSelect): boolean {
    if (s.liveId === null) return false;
    const item = db
      .select({ purpose: liveSessions.purpose, agentConfig: liveSessions.agentConfig })
      .from(liveSessions)
      .where(eq(liveSessions.id, s.liveId))
      .get();
    return item?.purpose === 'agent' && item.agentConfig === 'local';
  }

  // Live items of Magi Agents configured with these variants: without a submitted message there is no session; deleted or rebound too
  function agentItemsUsing(ids: string[]): string[] {
    if (ids.length === 0) return [];
    return db
      .select({ id: liveSessions.id })
      .from(liveSessions)
      .where(and(eq(liveSessions.purpose, 'agent'), inArray(liveSessions.agentConfig, ids)))
      .all()
      .map((i) => i.id);
  }

  // A session's original files on disk (shared with deletion on the Sessions page, Contracts 25.3)
  const sessionFiles = claudeSessionFiles;

  // Draft directories to delete: the whole directory for a normal draft; an optimisation draft lives in the analysis directory (kept), so only its optimisation part
  function draftDirs(d: DraftRow): string[] {
    if (d.analysisId === null) return [path.join(draftsDir, d.id)];
    const layout = draftLayout(analysisLayout(dataDir, d.analysisId).dir, 'optimize');
    return [
      path.dirname(layout.src),
      layout.codexHome,
      layout.home,
      layout.claudeDir,
      path.dirname(layout.agentSkills),
      path.dirname(layout.claudeSkills),
      layout.platform,
      // Optimisation drafts before 0027 also wrote skills-lock.json and examples/
      path.join(layout.dir, 'skills-lock.json'),
      path.join(layout.dir, 'examples'),
    ];
  }

  // Running users (24.1): active runs, running interactive processes, active analyses, drafts preparing or with a running process
  function activeUsers(ids: string[], drafts: DraftRow[]): DeletionBlocker[] {
    const blockers: DeletionBlocker[] = [];
    if (ids.length > 0) {
      for (const r of db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(and(inArray(runs.variantId, ids), inArray(runs.status, ACTIVE_RUNS)))
        .all()) {
        blockers.push({ kind: 'run', id: r.id, label: `run ${r.id} (${r.status})` });
      }
      for (const p of db
        .select({ liveId: liveProcesses.liveId, title: liveSessions.title })
        .from(liveProcesses)
        .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
        .where(and(inArray(liveProcesses.variantId, ids), eq(liveProcesses.status, 'running')))
        .all()) {
        blockers.push({ kind: 'live', id: p.liveId, label: `Interactive ${p.title} (running)` });
      }
      for (const a of db
        .select({ id: analyses.id, status: analyses.status })
        .from(analyses)
        .where(
          and(
            or(inArray(analyses.variantId, ids), inArray(analyses.analysisVariantId, ids)),
            inArray(analyses.status, ACTIVE_ANALYSES),
          ),
        )
        .all()) {
        blockers.push({ kind: 'analysis', id: a.id, label: `Analysis ${a.id} (${a.status})` });
      }
    }
    for (const d of drafts) {
      const running =
        d.liveId !== null &&
        db
          .select({ id: liveProcesses.id })
          .from(liveProcesses)
          .where(and(eq(liveProcesses.liveId, d.liveId), eq(liveProcesses.status, 'running')))
          .get() !== undefined;
      if (d.status === 'preparing' || (d.status === 'open' && running)) {
        blockers.push({
          kind: 'draft',
          id: d.id,
          label: `Draft ${d.id} (${d.status === 'preparing' ? 'preparing' : 'session running'})`,
        });
      }
    }
    return blockers;
  }

  // Drafts using these variants (as their base, or in their session, Contracts 33.2); deleting a workflow adds its own drafts
  function draftsUsing(ids: string[], workflowId: string | null): DraftRow[] {
    const conditions = [
      ...(ids.length > 0
        ? [inArray(workflowDrafts.baseVariantId, ids), inArray(workflowDrafts.designVariantId, ids)]
        : []),
      ...(workflowId === null ? [] : [eq(workflowDrafts.workflowId, workflowId)]),
    ];
    if (conditions.length === 0) return [];
    return db
      .select()
      .from(workflowDrafts)
      .where(or(...conditions))
      .all();
  }

  function plan(
    target: DeletionPlan['target'],
    rows: Variant[],
    workflowId: string | null,
    blockers: DeletionBlocker[],
  ): DeletionPlan {
    const ids = rows.map((v) => v.id);
    const relatedDrafts = draftsUsing(ids, workflowId);
    // Deleting a workflow deletes its drafts too; deleting only variants keeps the drafts
    const removedDrafts = workflowId === null ? [] : relatedDrafts;
    const all = boundSessions(ids);
    const bound = all.filter((s) => !isLocalAgentSession(s));
    const agentSessions = all.length - bound.length;
    const sessionLiveIds = [
      ...new Set([
        ...bound.flatMap((s) => (s.liveId === null ? [] : [s.liveId])),
        ...agentItemsUsing(ids),
      ]),
    ];
    const liveItems = sessionLiveIds.map((id) => {
      const item = db.select().from(liveSessions).where(eq(liveSessions.id, id)).get();
      if (item === undefined) throw new Error(`Interactive item of session not found: ${id}`);
      return { id, title: item.title };
    });
    const installs = variants.installsOf(ids);
    for (const i of installs) {
      if (i.modified.length > 0) {
        blockers.push({
          kind: 'install',
          id: i.variantId,
          label: `Skills installed on this machine were changed after installation, so uninstalling is refused: ${i.modified.join(', ')}`,
        });
      }
    }
    // Live items kept: items whose processes used these variants, minus those deleted with their sessions
    const usedLive =
      ids.length === 0
        ? []
        : db
            .selectDistinct({ liveId: liveProcesses.liveId })
            .from(liveProcesses)
            .where(inArray(liveProcesses.variantId, ids))
            .all()
            .map((p) => p.liveId);
    const runSessions =
      ids.length === 0
        ? 0
        : db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(inArray(sessions.variantId, ids), eq(sessions.variantBinding, 'run')))
            .all().length;
    const removing = new Set(ids);
    return {
      target,
      variants: rows.map((v) => ({ id: v.id, name: v.name })),
      blockers: [...blockers, ...activeUsers(ids, relatedDrafts)],
      dirs: [
        ...variants.deletionDirs(ids),
        ...removedDrafts.flatMap(draftDirs).filter((d) => fs.existsSync(d)),
      ],
      installs: installs.map((i) => ({ variantId: i.variantId, dirs: i.manifest.dirs })),
      sessions: {
        count: bound.length,
        files: bound.flatMap(sessionFiles),
        liveItems,
        agent: agentSessions,
      },
      retained: {
        runs:
          ids.length === 0
            ? 0
            : db.select({ id: runs.id }).from(runs).where(inArray(runs.variantId, ids)).all()
                .length,
        runSessions,
        analyses:
          ids.length === 0
            ? 0
            : db
                .select({ id: analyses.id })
                .from(analyses)
                .where(
                  or(inArray(analyses.variantId, ids), inArray(analyses.analysisVariantId, ids)),
                )
                .all().length,
        liveItems: usedLive.filter((id) => !sessionLiveIds.includes(id)).length,
        children:
          ids.length === 0
            ? []
            : db
                .select({ id: variantsTable.id, name: variantsTable.name })
                .from(variantsTable)
                .where(and(inArray(variantsTable.parentId, ids), isNull(variantsTable.deletedAt)))
                .all()
                .filter((v) => !removing.has(v.id)),
        drafts: relatedDrafts.length - removedDrafts.length,
      },
      drafts: removedDrafts.map((d) => ({ id: d.id, liveId: d.liveId })),
    };
  }

  function variantPlan(id: string): DeletionPlan {
    const row = variants.get(id);
    const blockers: DeletionBlocker[] = [];
    const siblings = variants.list().filter((v) => v.workflowId === row.workflowId);
    if (siblings.length <= 1) {
      blockers.push({
        kind: 'last-variant',
        id: row.workflowId,
        label: `${row.name} is the last variant of workflow ${row.workflowId} and cannot be deleted alone; delete the workflow instead`,
      });
    }
    return plan(
      { kind: 'variant', id, name: row.name, workflowId: row.workflowId },
      [row],
      null,
      blockers,
    );
  }

  function workflowPlan(id: string): DeletionPlan {
    const w = workflowRow(db, id);
    const blockers: DeletionBlocker[] = [];
    if (isBuiltinWorkflow(id)) {
      blockers.push({
        kind: 'builtin',
        id,
        label: `${id} is a built-in workflow and cannot be deleted`,
      });
    }
    const rows = variants.list().filter((v) => v.workflowId === id);
    return plan({ kind: 'workflow', id, name: w.name, workflowId: id }, rows, id, blockers);
  }

  // The rebind target (24.2): the local configuration (null), or any variant not deleted and not part of this deletion
  function rebindTarget(choice: SessionsChoice, p: DeletionPlan): string | null {
    if (choice === 'delete' || choice.rebindTo === null) return null;
    const target = variants.get(choice.rebindTo);
    if (p.variants.some((v) => v.id === target.id)) {
      throw new HttpError(400, `Cannot rebind to variant ${target.name}, which is being deleted`);
    }
    return target.id;
  }

  function execute(p: DeletionPlan, body: DeleteBody) {
    const subject = `${p.target.kind} ${p.target.name}`;
    if (p.blockers.length > 0) {
      throw new HttpError(
        409,
        `Cannot delete ${subject}:\n${p.blockers.map((b) => `- ${b.label}`).join('\n')}`,
      );
    }
    const ids = p.variants.map((v) => v.id);
    const rebindTo = rebindTarget(body.sessions, p);
    const all = boundSessions(ids);
    const bound = all.filter((s) => !isLocalAgentSession(s));
    const agent = all.filter(isLocalAgentSession);
    // Live items deleted along must have their processes stopped: checked before changing anything
    const liveToRemove = [
      ...new Set([
        ...(body.sessions === 'delete' ? p.sessions.liveItems.map((i) => i.id) : []),
        ...p.drafts.flatMap((d) => (d.liveId === null ? [] : [d.liveId])),
      ]),
    ];
    const runningItems = liveToRemove.filter(
      (id) =>
        db
          .select({ id: liveProcesses.id })
          .from(liveProcesses)
          .where(and(eq(liveProcesses.liveId, id), eq(liveProcesses.status, 'running')))
          .get() !== undefined,
    );
    if (runningItems.length > 0) {
      throw new HttpError(
        409,
        `Cannot delete ${subject}: Live items to delete along have running processes; stop them first: ${runningItems.join(', ')}`,
      );
    }
    // 1. Uninstall local installs first: refused when changed, with nothing changed yet
    variants.removeFiles(ids, []);
    // 2. Linked sessions: deleted along (with their Live items and the original files on disk), or rebound;
    // 3. when deleting a workflow, the Live items of its drafts
    for (const id of liveToRemove) live.removeItem(id);
    const rebind = (rows: typeof all, variantId: string | null) => {
      if (rows.length === 0) return;
      db.update(sessions)
        .set({ variantId, variantBinding: 'manual' })
        .where(
          inArray(
            sessions.id,
            rows.map((s) => s.id),
          ),
        )
        .run();
    };
    if (body.sessions === 'delete') {
      deleteClaudeSessions(db, bound);
      // Magi Agent sessions of the local configuration are not deleted; they become local configuration
      rebind(agent, null);
    } else {
      rebind(all, rebindTo);
      // Magi Agent items configured with these variants switch to the rebind configuration
      const agentItems = agentItemsUsing(ids);
      if (agentItems.length > 0) {
        db.update(liveSessions)
          .set({ agentConfig: rebindTo ?? 'local' })
          .where(inArray(liveSessions.id, agentItems))
          .run();
        for (const id of agentItems) events.publish({ type: 'live.updated', liveId: id });
      }
    }
    const at = new Date();
    db.$client.transaction(() => {
      if (p.drafts.length > 0) {
        const draftIds = p.drafts.map((d) => d.id);
        // Variants saved from these drafts keep a row (24.3) with draft_id set to null: drafts are deleted with the
        // workflow (24.5) and the kept rows only show names. This column's foreign key has no ON DELETE action in the
        // database (0013 added it with ALTER TABLE), so deleting the drafts fails unless it is cleared
        db.update(variantsTable)
          .set({ draftId: null })
          .where(inArray(variantsTable.draftId, draftIds))
          .run();
        db.delete(workflowDrafts).where(inArray(workflowDrafts.id, draftIds)).run();
      }
      // 4. Keep one row, only to show the name
      variants.markDeleted(ids, at);
      if (p.target.kind === 'workflow') {
        db.update(workflowTable)
          .set({ deletedAt: at })
          .where(eq(workflowTable.id, p.target.id))
          .run();
      }
    })();
    // 5. Files: variant directories and archives (shared ones only when the last reference goes), draft directories
    variants.removeFiles([], p.dirs);
    console.info(
      `[delete] ${subject}: variants ${ids.join(', ')}; ${String(bound.length)} sessions ${body.sessions === 'delete' ? 'deleted' : `rebound to ${rebindTo ?? 'local configuration'}`}, ${String(agent.length)} Magi Agent sessions kept; directories ${p.dirs.join(', ')}`,
    );
    for (const id of ids) events.publish({ type: 'variant.deleted', variantId: id });
    if (p.target.kind === 'workflow') {
      events.publish({ type: 'workflow.deleted', workflowId: p.target.id });
    }
    for (const s of all) events.publish({ type: 'session.updated', sessionId: s.id });
  }

  return {
    variantPlan,
    workflowPlan,

    deleteVariant(id: string, body: DeleteBody): DeletionPlan {
      const p = variantPlan(id);
      execute(p, body);
      return p;
    },

    deleteWorkflow(id: string, body: DeleteBody): DeletionPlan {
      const p = workflowPlan(id);
      execute(p, body);
      return p;
    },
  };
}

export type Deletion = ReturnType<typeof createDeletion>;
