import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  batchVariants,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  tasks,
  variants,
  workflowTable,
} from '../db/schema.js';
import { stageItems } from '../stages/partition.js';
import { loadSessionRows } from '../stages/rows.js';
import { builtinDefinition } from './index.js';
import { WorkflowDefinition } from './schema.js';

// The built-in workflow of W36; migration 0012 deleted its row in the workflows table, and its variants are split here
const DEV_WORKFLOW = 'dev-workflow';

// Which of lfg or ic owns the first such marker in the session (entry command or a stage's Skill call); lfg when there
// is none (Contracts 16.4)
function firstMarkerWorkflow(db: Db, sessionId: string): 'lfg' | 'ic' {
  const partition = [builtinDefinition('lfg'), builtinDefinition('ic')];
  const rows = loadSessionRows(db, sessionId);
  const first = stageItems(partition, rows.main, rows.userMessages, rows.injectedSkills).find(
    (item) => item.markers.length > 0,
  )?.markers[0];
  if (first === undefined) return 'lfg';
  const owner = partition.find(
    (w) => w.id === first.name || w.stages.some((s) => s.id === first.name),
  );
  if (owner === undefined) throw new Error(`Marker ${first.name} belongs to neither lfg nor ic`);
  return owner.id === 'ic' ? 'ic' : 'lfg';
}

// Called after migration 0012 and before the service uses the database (openDatabase): each dev-workflow variant is
// split into two variants with the same name; the original (same id) belongs to lfg, and the new one belongs to ic and
// shares its directory (storage_id, no rebuild). Runs follow their task's kind; interactive processes and session
// bindings follow the first marker in the session. Does nothing when there are no dev-workflow variants
export function splitDevWorkflow(db: Db) {
  // Other workflows' definitions must also have the new structure: W36's top-level stage structure cannot be mapped to
  // one workflow automatically
  for (const r of db.select().from(workflowTable).all()) {
    const parsed = WorkflowDefinition.safeParse(r.definition);
    if (!parsed.success) {
      throw new Error(
        `The definition of workflow ${r.id} does not have the Contracts 16.1 structure (W36's top-level stage structure cannot be migrated automatically): ${parsed.error.message}`,
      );
    }
  }
  // Read only ids first: in a half-migrated database (migration tests) variants lacks later columns, so whole rows are
  // read only when there are variants to split
  const pending = db
    .select({ id: variants.id })
    .from(variants)
    .where(eq(variants.workflowId, DEV_WORKFLOW))
    .all();
  if (pending.length === 0) return;
  const dev = db
    .select()
    .from(variants)
    .where(eq(variants.workflowId, DEV_WORKFLOW))
    .orderBy(asc(variants.createdAt), asc(variants.id))
    .all();
  db.transaction((tx) => {
    // Original variant id -> split ic variant id
    const icOf = new Map<string, string>();
    for (const v of dev) {
      tx.update(variants).set({ workflowId: 'lfg' }).where(eq(variants.id, v.id)).run();
      const id = randomUUID();
      icOf.set(v.id, id);
      tx.insert(variants)
        .values({ ...v, id, workflowId: 'ic', storageId: v.storageId ?? v.id, parentId: null })
        .run();
    }
    // The ic variant's parent is the ic variant split from the parent
    for (const v of dev) {
      const ic = icOf.get(v.id);
      if (ic === undefined || v.parentId === null) continue;
      tx.update(variants)
        .set({ parentId: icOf.get(v.parentId) ?? v.parentId })
        .where(eq(variants.id, ic))
        .run();
    }
    const icVariant = (id: string) => {
      const ic = icOf.get(id);
      if (ic === undefined) throw new Error(`Variant ${id} has no split ic variant`);
      return ic;
    };
    const devIds = [...icOf.keys()];
    // Runs: those whose task kind is ic go to the ic variant
    const devRuns = tx
      .select({ id: runs.id, variantId: runs.variantId, batchId: runs.batchId, kind: tasks.kind })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(inArray(runs.variantId, devIds))
      .all();
    for (const r of devRuns) {
      if (r.kind === 'ic') {
        tx.update(runs)
          .set({ variantId: icVariant(r.variantId) })
          .where(eq(runs.id, r.id))
          .run();
      }
    }
    // Rewrite each batch's variant list from the variants its runs actually use
    for (const batchId of new Set(devRuns.map((r) => r.batchId))) {
      const used = tx
        .selectDistinct({ variantId: runs.variantId })
        .from(runs)
        .where(eq(runs.batchId, batchId))
        .all();
      tx.delete(batchVariants).where(eq(batchVariants.batchId, batchId)).run();
      for (const u of used) {
        tx.insert(batchVariants).values({ batchId, variantId: u.variantId }).run();
      }
    }
    // Session bindings: a run's session follows the run, others follow the first marker in the session
    const runVariant = new Map(
      tx
        .select({ sessionId: runs.sessionId, variantId: runs.variantId })
        .from(runs)
        .all()
        .map((r) => [r.sessionId, r.variantId]),
    );
    for (const s of tx
      .select({ id: sessions.id, variantId: sessions.variantId, runId: sessions.runId })
      .from(sessions)
      .where(inArray(sessions.variantId, devIds))
      .all()) {
      const variantId =
        s.runId !== null
          ? (runVariant.get(s.id) ?? s.variantId)
          : firstMarkerWorkflow(db, s.id) === 'ic'
            ? icVariant(s.variantId ?? '')
            : s.variantId;
      tx.update(sessions).set({ variantId }).where(eq(sessions.id, s.id)).run();
    }
    // Interactive processes: by the first marker in the item's session; lfg when the session is not imported yet
    for (const p of tx
      .select({
        id: liveProcesses.id,
        variantId: liveProcesses.variantId,
        claudeSessionId: liveSessions.claudeSessionId,
      })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(inArray(liveProcesses.variantId, devIds))
      .all()) {
      // Processes with a variant all belong to Claude Code items, which have a session id from creation
      if (p.claudeSessionId === null)
        throw new Error(`The item of interactive process ${String(p.id)} has no session id`);
      const imported = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, p.claudeSessionId))
        .get();
      if (imported !== undefined && firstMarkerWorkflow(db, imported.id) === 'ic') {
        tx.update(liveProcesses)
          .set({ variantId: icVariant(p.variantId ?? '') })
          .where(eq(liveProcesses.id, p.id))
          .run();
      }
    }
  });
}
