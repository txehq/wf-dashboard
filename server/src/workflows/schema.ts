import { z } from 'zod';

// Structure of workflow definitions (Contracts 16.1) and of the internal eval kind configuration (16.2); this file
// depends only on zod, and web imports these schemas directly

const SLUG = /^[a-z][a-z0-9-]*$/;
const slug = z
  .string()
  .regex(SLUG, 'Only lowercase letters, digits and hyphens, starting with a letter');

// Eval kinds: determine preparation, initial message, end condition, dispatch gate and grading; every task has one (16.3)
export const evalKinds = ['lfg', 'ic'] as const;
export type EvalKind = (typeof evalKinds)[number];

// Built-in lfg and ic: the id equals the eval kind; variants are full txe-workflow exports built with wf (Contracts 18.6)
export const WF_WORKFLOWS = evalKinds;
export const isWfWorkflow = (id: string): id is EvalKind =>
  (WF_WORKFLOWS as readonly string[]).includes(id);

// Built-in analysis workflow (Contracts 19.2): no eval kind, variants managed by the dashboard itself; the last stage
// synthesizes
export const ANALYSIS_WORKFLOW = 'session-analysis';
export const SYNTHESIZE_STAGE = 'synthesize';

// Built-in design and optimize workflows (Contracts 33.1): no eval kind, variants managed by the dashboard itself; each
// has one skill, whose only stage has the workflow's name. Their variants drive the sessions that generate workflows
// and variants and the "Optimize" sessions of analyses
export const DESIGN_WORKFLOW = 'workflow-design';
export const OPTIMIZE_WORKFLOW = 'workflow-optimize';
export const DRAFT_WORKFLOWS = [DESIGN_WORKFLOW, OPTIMIZE_WORKFLOW] as const;
export type DraftWorkflow = (typeof DRAFT_WORKFLOWS)[number];

// Workflows written from the repo's yaml at startup; their definitions are read-only
export const BUILTIN_WORKFLOWS = [...WF_WORKFLOWS, ANALYSIS_WORKFLOW, ...DRAFT_WORKFLOWS] as const;
// Built-in workflows whose variants the dashboard manages: a baseline variant is created at startup
export const OWN_BUILTIN_WORKFLOWS = [ANALYSIS_WORKFLOW, ...DRAFT_WORKFLOWS] as const;
export type OwnBuiltinWorkflow = (typeof OWN_BUILTIN_WORKFLOWS)[number];
export type BuiltinWorkflow = (typeof BUILTIN_WORKFLOWS)[number];
export const isBuiltinWorkflow = (id: string): id is BuiltinWorkflow =>
  (BUILTIN_WORKFLOWS as readonly string[]).includes(id);

// Preparation bricks, run in order
export const prepareBricks = ['empty-repo', 'repo-copy', 'ticket-copy', 'vault-dir'] as const;
export type PrepareBrick = (typeof prepareBricks)[number];

// Grading bricks other than rubric
export const gradingBricks = ['hidden-tests', 'criteria-judge', 'pr-endpoint'] as const;
export type GradingBrick = (typeof gradingBricks)[number];

// Fixed artifact kinds of a run (fixedArtifactKinds in db/schema): rubric artifacts use their id as kind and must not
// share these names
const reservedArtifactIds = ['pr', 'repo', 'ticket', 'friction', 'acceptance', 'pr_snapshot'];

// One candidate file of a rubric artifact: its frontmatter kind must match
const ArtifactFile = z.strictObject({ file: z.string().trim().min(1), kind: slug });

// The shorthand { id, file } means files: [{ file, kind: id }], with the file name as description
const RubricArtifactInput = z.union([
  z.strictObject({
    id: slug,
    files: z.array(ArtifactFile).min(1),
    description: z.string().trim().min(1),
    lockedPlan: z.literal(true).optional(),
    linearTickets: z.literal(true).optional(),
  }),
  z.strictObject({
    id: slug,
    file: z.string().trim().min(1),
    lockedPlan: z.literal(true).optional(),
    linearTickets: z.literal(true).optional(),
  }),
]);

export const RubricArtifactSpec = RubricArtifactInput.transform((a) =>
  'files' in a
    ? a
    : {
        id: a.id,
        files: [{ file: a.file, kind: a.id }],
        description: a.file,
        ...(a.lockedPlan === undefined ? {} : { lockedPlan: a.lockedPlan }),
        ...(a.linearTickets === undefined ? {} : { linearTickets: a.linearTickets }),
      },
);
export type RubricArtifactSpec = z.output<typeof RubricArtifactSpec>;

const RubricGrading = z.strictObject({
  rubric: z.strictObject({ artifacts: z.array(RubricArtifactSpec).min(1) }),
});

const Grading = z.union([z.enum(gradingBricks), RubricGrading]);

// Task fields, derived from the eval kind's bricks (16.3)
export const taskFieldNames = [
  'input',
  'persona',
  'hiddenRequirements',
  'rubric',
  'ticket',
  'repo',
  'requiredChecks',
  'hiddenTests',
] as const;
export type TaskFieldName = (typeof taskFieldNames)[number];

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

// Placeholders in the initial message template
export function placeholdersOf(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))];
}

// Renders the initial message from the template; throws when a placeholder it uses has no value (the internal
// configuration tests already check that bricks provide the placeholders)
export function renderMessage(message: string, values: Record<string, string | null>): string {
  return message.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null)
      throw new Error(`Placeholder {${name}} of the initial message has no value`);
    return value;
  });
}

export const hasRepo = (config: Pick<EvalKindConfig, 'prepare'>) =>
  config.prepare.includes('empty-repo') || config.prepare.includes('repo-copy');

// Placeholders the bricks provide; {entry} is the workflow's entry command
export function providedPlaceholders(config: Pick<EvalKindConfig, 'prepare'>): string[] {
  return [
    'entry',
    'input',
    'runId',
    ...(hasRepo(config) ? ['repo'] : []),
    ...(config.prepare.includes('ticket-copy') ? ['ticket'] : []),
  ];
}

export function rubricOf(config: Pick<EvalKindConfig, 'grading'>): RubricArtifactSpec[] | null {
  for (const g of config.grading) if (typeof g !== 'string') return g.rubric.artifacts;
  return null;
}

export const hasGrading = (config: Pick<EvalKindConfig, 'grading'>, brick: GradingBrick) =>
  config.grading.includes(brick);

// 16.3: task fields are derived from the bricks and the grading
export function taskFieldsOf(config: EvalKindConfig): TaskFieldName[] {
  const fields: TaskFieldName[] = [];
  if (placeholdersOf(config.message).includes('input')) fields.push('input');
  fields.push('persona', 'hiddenRequirements');
  if (rubricOf(config) !== null) fields.push('rubric');
  if (config.prepare.includes('ticket-copy')) fields.push('ticket');
  if (config.prepare.includes('repo-copy')) fields.push('repo', 'requiredChecks');
  if (hasGrading(config, 'hidden-tests')) fields.push('hiddenTests');
  return fields;
}

// Internal configuration of one eval kind (16.2): made of bricks, not edited by users
export const EvalKindConfig = z
  .strictObject({
    kind: z.enum(evalKinds),
    prepare: z.array(z.enum(prepareBricks)),
    message: z.string().trim().min(1),
    // End condition written for the simulated user
    done: z.string().trim().min(1),
    // Adds a dispatch gate section to the simulated user's prompt; its answers must not contain go
    dispatchGate: z.literal(true).optional(),
    grading: z.array(Grading),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string) => {
      ctx.addIssue({ code: 'custom', message: `Eval kind ${config.kind}: ${message}` });
    };
    for (const brick of duplicates(config.prepare)) issue(`Duplicate preparation brick: ${brick}`);
    if (config.prepare.includes('empty-repo') && config.prepare.includes('repo-copy')) {
      issue('Choose only one of empty-repo and repo-copy');
    }
    const provided = providedPlaceholders(config);
    for (const name of placeholdersOf(config.message)) {
      if (!provided.includes(name)) {
        issue(
          `message uses placeholder {${name}}, which no brick provides (available: ${provided.map((p) => `{${p}}`).join(', ')})`,
        );
      }
    }
    const named = config.grading.map((g) => (typeof g === 'string' ? g : 'rubric'));
    for (const brick of duplicates(named)) issue(`Duplicate grading brick: ${brick}`);
    for (const brick of gradingBricks) {
      if (named.includes(brick) && !config.prepare.includes('repo-copy')) {
        issue(`Grading ${brick} requires the preparation brick repo-copy`);
      }
    }
    if (named.includes('criteria-judge') && !config.prepare.includes('ticket-copy')) {
      issue('Grading criteria-judge requires the preparation brick ticket-copy');
    }
    const rubric = rubricOf(config);
    if (rubric !== null) {
      if (!config.prepare.includes('vault-dir'))
        issue('Grading rubric requires the preparation brick vault-dir');
      for (const id of duplicates(rubric.map((a) => a.id)))
        issue(`Duplicate rubric artifact id: ${id}`);
      for (const a of rubric) {
        if (reservedArtifactIds.includes(a.id)) {
          issue(
            `Rubric artifact id ${a.id} has the name of a fixed run artifact kind (${reservedArtifactIds.join(', ')})`,
          );
        }
      }
    }
  });
export type EvalKindConfig = z.output<typeof EvalKindConfig>;

// The configuration a workflow with an eval kind uses at run time: the eval kind's internal configuration plus the
// workflow's id (also the entry command /<id>)
export type EvalSpec = EvalKindConfig & { id: string };

const SmallStage = z.strictObject({
  id: slug,
  // When it appears again, only count it (like fix-pr)
  repeatable: z.literal(true).optional(),
  // Calling these stages inside this one is not a switch (like acceptance inside fix-pr)
  allowInside: z.array(slug).optional(),
});
export type SmallStage = z.infer<typeof SmallStage>;

export const WorkflowDefinition = z
  .strictObject({
    // Also the entry command /<id> and the name of the entry skill
    id: slug,
    name: z.string().trim().min(1),
    stages: z.array(SmallStage).min(1),
  })
  .superRefine((w, ctx) => {
    const issue = (message: string, path: (string | number)[]) => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    const ids = w.stages.map((s) => s.id);
    for (const id of duplicates(ids)) issue(`Duplicate stage id: ${id}`, ['stages']);
    for (const [i, s] of w.stages.entries()) {
      // A single-skill workflow: its only stage has the workflow's name, and the entry itself is that stage
      // (Contracts 16.1, 33.1)
      if (s.id === w.id && w.stages.length > 1) {
        issue(`Stage ${s.id} has the workflow's name: allowed only when it is the only stage`, [
          'stages',
          i,
          'id',
        ]);
      }
      for (const inside of s.allowInside ?? []) {
        if (!ids.includes(inside)) {
          issue(`allowInside of stage ${s.id} refers to stage ${inside}, which does not exist`, [
            'stages',
            i,
            'allowInside',
          ]);
        }
      }
    }
  });
export type WorkflowDefinition = z.output<typeof WorkflowDefinition>;

// Skills a workflow requires of a variant: the entry skill (named like the workflow id) and each stage's skill (16.1)
export function requiredSkills(definition: WorkflowDefinition): string[] {
  return [...new Set([definition.id, ...definition.stages.map((s) => s.id)])];
}

// Latest txe-workflow release for lfg and ic (Contracts 29.1): the result of the latest check; variantId is the
// undeleted variant imported automatically for this tag
export const ReleaseView = z.object({
  tag: z.string().nullable(),
  publishedAt: z.number().nullable(),
  checkedAt: z.number(),
  variantId: z.string().nullable(),
  error: z.string().nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

export const WorkflowView = z.object({
  id: z.string(),
  name: z.string(),
  evalKind: z.enum(evalKinds).nullable(),
  description: z.string().nullable(),
  // Built-in workflows with read-only definitions (lfg, ic, session-analysis)
  builtin: z.boolean(),
  // Variants are txe-workflow exports built with wf (lfg, ic); the rest are managed by the dashboard itself
  wf: z.boolean(),
  definition: WorkflowDefinition,
  variants: z.number(),
  // Only lfg and ic have it; null before the first check
  release: ReleaseView.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkflowView = z.infer<typeof WorkflowView>;

// POST /api/workflows (16.1, 18.5): create from blank, together with the first variant "First draft"
export const NewWorkflowBody = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: z.unknown(),
});
export type NewWorkflowBody = z.infer<typeof NewWorkflowBody>;

// PUT /api/workflows/:id: built-in lfg and ic can change only the description
export const UpdateWorkflowBody = z.object({
  name: z.string(),
  description: z.string(),
  definition: z.unknown(),
});
export type UpdateWorkflowBody = z.infer<typeof UpdateWorkflowBody>;
