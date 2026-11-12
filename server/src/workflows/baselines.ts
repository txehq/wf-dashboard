import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { variants as variantsTable } from '../db/schema.js';
import type { Variant, Variants } from '../variants/index.js';
import { skillsHash } from '../variants/skills.js';
import { withBaselineSrc } from './index.js';
import { OWN_BUILTIN_WORKFLOWS, type OwnBuiltinWorkflow } from './schema.js';

// Baseline variants of built-in session-analysis, workflow-design and workflow-optimize (Contracts 19.2, 33.1): src/
// comes from the repo (withBaselineSrc), with no parent and no draft. When the repo's skills change, startup creates
// another baseline with the same content and keeps the earlier ones (old analyses and drafts reference them)

function baselines(db: Db, workflowId: OwnBuiltinWorkflow): Variant[] {
  return db
    .select()
    .from(variantsTable)
    .where(
      and(
        eq(variantsTable.workflowId, workflowId),
        isNull(variantsTable.parentId),
        isNull(variantsTable.draftId),
        // Deleted baselines are no longer used: startup recreates one from the repo content (Contracts 24.3)
        isNull(variantsTable.deletedAt),
      ),
    )
    .orderBy(desc(variantsTable.createdAt))
    .all();
}

// The baseline with the same skill content as the repo; new analyses, workflow and variant generation, and optimize use
// it by default
export function currentBaseline(
  db: Db,
  dataDir: string,
  workflowId: OwnBuiltinWorkflow,
): Variant | null {
  const hash = withBaselineSrc(dataDir, workflowId, skillsHash);
  return baselines(db, workflowId).find((v) => v.skillsHash === hash) ?? null;
}

// Called at startup: creates a baseline when none matches the repo content; after the build (18.6's own manager) it is
// frozen, and its content can only change through a derived variant
export async function ensureBaseline(
  db: Db,
  variants: Variants,
  dataDir: string,
  workflowId: OwnBuiltinWorkflow,
): Promise<Variant> {
  const baseline =
    currentBaseline(db, dataDir, workflowId) ??
    withBaselineSrc(dataDir, workflowId, (srcDir) =>
      variants.createFromSource({
        srcDir,
        workflowId,
        name: variants.freeName(workflowId, 'Baseline'),
        description: null,
        parentId: null,
        draftId: null,
        analysisId: null,
        note: `Baseline of ${workflowId}: the skills in server/src/workflows/ of the repo`,
      }),
    );
  if (baseline.status === 'frozen') return baseline;
  if (baseline.buildStatus !== 'built' || baseline.builtHash !== baseline.skillsHash) {
    await variants.build(baseline.id);
  }
  return variants.freeze(baseline.id);
}

export async function ensureBuiltinBaselines(
  db: Db,
  variants: Variants,
  dataDir: string,
): Promise<Record<OwnBuiltinWorkflow, Variant>> {
  const entries: [OwnBuiltinWorkflow, Variant][] = [];
  for (const id of OWN_BUILTIN_WORKFLOWS) {
    entries.push([id, await ensureBaseline(db, variants, dataDir, id)]);
  }
  return Object.fromEntries(entries) as Record<OwnBuiltinWorkflow, Variant>;
}
