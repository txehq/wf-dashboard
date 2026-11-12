import { z } from 'zod';
import { draftModes, draftStatuses, liveEngines } from '../db/schema.js';
import { WorkflowDefinition } from '../workflows/schema.js';

// API shapes for generating a workflow, generating a variant and optimising from an analysis (Contracts section 17, 19.3, 22); used directly by web

const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'Only lowercase letters, digits and hyphens, starting with a letter');

// The session's engine (Contracts 22.1): Codex or Claude Code
export const DraftEngine = z.enum(liveEngines);
export type DraftEngine = z.infer<typeof DraftEngine>;

// The workflow-design (generate workflow, generate variant) or workflow-optimize (optimise) variant the session uses (Contracts 33.2);
// the baseline when omitted
const DesignVariantId = z.string().min(1).optional();

export const CreateDraftBody = z.discriminatedUnion('mode', [
  // "Generate workflow" in the Workflows list: id, name, description and requirement of the new workflow; the draft starts from a blank skeleton (18.5)
  z.strictObject({
    mode: z.literal('workflow'),
    engine: DraftEngine,
    designVariantId: DesignVariantId,
    workflowId: Slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    requirement: z.string().trim().min(1),
  }),
  // "Generate variant" in the Workflow page: changes only skill content, not the entry or sub-stages
  z.strictObject({
    mode: z.literal('variant'),
    engine: DraftEngine,
    designVariantId: DesignVariantId,
    workflowId: z.string().min(1),
    requirement: z.string().trim().min(1),
    baseVariantId: z.string().min(1),
  }),
]);
export type CreateDraftBody = z.infer<typeof CreateDraftBody>;

// "Optimize" in an analysis report (Contracts 19.3, 22.1, 33.2)
export const OptimizeBody = z.strictObject({
  engine: DraftEngine,
  designVariantId: DesignVariantId,
});
export type OptimizeBody = z.infer<typeof OptimizeBody>;

// Variants selectable in the start dialog (Contracts 33.2): built from their current content, by creation time; defaultId is the baseline, null before it exists
const SessionVariantChoice = z.object({
  defaultId: z.string().nullable(),
  variants: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const SessionVariantsView = z.object({
  design: SessionVariantChoice,
  optimize: SessionVariantChoice,
});
export type SessionVariantsView = z.infer<typeof SessionVariantsView>;

// One draft preparation step (Contracts 17.1)
export const DraftStepView = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type DraftStepView = z.infer<typeof DraftStepView>;

export const DraftView = z.object({
  id: z.string(),
  mode: z.enum(draftModes),
  engine: DraftEngine,
  workflowId: z.string(),
  // Name and description of the new workflow, for mode workflow
  name: z.string().nullable(),
  description: z.string().nullable(),
  // Base variant for mode variant; the analysed variant for mode optimize; null for mode workflow
  baseVariantId: z.string().nullable(),
  // The analysis being optimised, for mode optimize (Contracts 19.3)
  analysisId: z.string().nullable(),
  requirement: z.string(),
  liveId: z.string().nullable(),
  // While preparing, the draft dir is being prepared in the background; when failed, error is the failed step's original text and can be retried
  status: z.enum(draftStatuses),
  error: z.string().nullable(),
  steps: z.array(DraftStepView),
  savedWorkflowId: z.string().nullable(),
  savedVariantId: z.string().nullable(),
  // Variants produced by each save, in save order
  savedVariants: z.array(
    z.object({ id: z.string(), name: z.string(), workflowId: z.string(), deleted: z.boolean() }),
  ),
  // The workflow-design or workflow-optimize variant the session uses (Contracts 33.2)
  designVariant: z.object({ id: z.string(), name: z.string(), deleted: z.boolean() }).nullable(),
  dir: z.string(),
  createdAt: z.number(),
});
export type DraftView = z.infer<typeof DraftView>;

// Preview of changes before saving (Contracts 21.3): per-file differences of the draft's src/ against the base variant
export const DraftDiffView = z.object({
  // A blank-start draft has no base; all files are added
  base: z.object({ id: z.string(), name: z.string() }).nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'removed', 'modified']),
      oldContent: z.string(),
      newContent: z.string(),
      // Unified diff text
      patch: z.string(),
    }),
  ),
});
export type DraftDiffView = z.infer<typeof DraftDiffView>;

// Save (Contracts 17.4): create a variant, or overwrite a variant of the same workflow; name and description are both required;
// the first save as a new workflow also carries the workflow name and description. Required fields and lengths are checked by the server, a 400 with the original text
export const SaveTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), name: z.string(), description: z.string() }),
  z.strictObject({
    kind: z.literal('overwrite'),
    variantId: z.string().min(1),
    name: z.string(),
    description: z.string(),
  }),
]);
export type SaveTarget = z.infer<typeof SaveTarget>;

export const SaveDraftBody = z.strictObject({
  target: SaveTarget,
  workflow: z.strictObject({ name: z.string(), description: z.string() }).optional(),
});
export type SaveDraftBody = z.infer<typeof SaveDraftBody>;

// Contents of the save dialog: first save as a new workflow, or save to an existing workflow (listing its variants, with the reason for those that cannot be overwritten)
export const SavePlanView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new-workflow'),
    workflowId: z.string(),
    workflowName: z.string(),
    workflowDescription: z.string(),
    variantName: z.string(),
  }),
  z.object({
    kind: z.literal('variant'),
    workflowId: z.string(),
    workflowName: z.string(),
    // Parent when creating, and the diff reference
    parent: z.object({ id: z.string(), name: z.string() }).nullable(),
    variants: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        // Why it cannot be overwritten (imported, frozen, building); null when it can
        reason: z.string().nullable(),
      }),
    ),
  }),
]);
export type SavePlanView = z.infer<typeof SavePlanView>;

// Workflow panel of design and optimize sessions (Contracts 26.4): marks of the working dir's src/skills against the base
export const WorkspaceFileStatus = z.enum(['added', 'modified', 'removed', 'unchanged']);
export type WorkspaceFileStatus = z.infer<typeof WorkspaceFileStatus>;
export const WorkspaceStageStatus = z.enum(['added', 'modified', 'unchanged', 'missing']);
export type WorkspaceStageStatus = z.infer<typeof WorkspaceStageStatus>;

export const WorkspaceView = z.object({
  draftId: z.string(),
  mode: z.enum(draftModes),
  analysisId: z.string().nullable(),
  // Relative to the working dir, for display
  root: z.string(),
  base: z.object({ id: z.string(), name: z.string() }).nullable(),
  workflow: z.union([
    z.object({
      definition: WorkflowDefinition,
      stages: z.array(
        z.object({ id: z.string(), entry: z.boolean(), status: WorkspaceStageStatus }),
      ),
    }),
    z.object({ error: z.string() }),
  ]),
  // Paths relative to src/ (skills/<skill>/...); files only in the base are removed, with mtimeMs null
  files: z.array(
    z.object({ path: z.string(), status: WorkspaceFileStatus, mtimeMs: z.number().nullable() }),
  ),
  // What Compare can choose (28.4): last saved and previous version, at being the ms time of the save or snapshot; null when absent
  against: z.object({
    saved: z.object({ at: z.number() }).nullable(),
    previous: z.object({ at: z.number() }).nullable(),
  }),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceAgainst = z.enum(['base', 'saved', 'previous']);
export type WorkspaceAgainst = z.infer<typeof WorkspaceAgainst>;

export const WorkspaceFileView = z.object({
  path: z.string(),
  // Null when in neither the working dir nor the base
  status: WorkspaceFileStatus.nullable(),
  // Null when missing from the working dir or binary
  content: z.string().nullable(),
  binary: z.boolean(),
});
export type WorkspaceFileView = z.infer<typeof WorkspaceFileView>;

export const WorkspaceDiffView = z.object({
  path: z.string(),
  against: WorkspaceAgainst,
  status: WorkspaceFileStatus.nullable(),
  oldContent: z.string(),
  newContent: z.string(),
  patch: z.string(),
});
export type WorkspaceDiffView = z.infer<typeof WorkspaceDiffView>;

// Events pushed by GET /api/live/:id/workspace/events
export type WorkspaceEvent =
  | { type: 'changed'; paths: string[]; workflow: boolean }
  | { type: 'closed'; reason: 'hidden' | 'deleted' }
  // Watching failed (e.g. reading a dir failed): the original text, then the connection ends. Not named error: EventSource's error is a connection error
  | { type: 'failed'; message: string };
