import { z } from 'zod';
import { EVAL_KINDS } from '../workflows/eval-kinds.js';
import { evalKinds, rubricOf, taskFieldsOf, type TaskFieldName } from '../workflows/schema.js';

// This file depends only on zod (as do workflows/schema and eval-kinds); web imports these schemas directly

// A relative path inside the task directory: not absolute and never through .. (files are copied by it when loading and grading)
const taskPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
    'Must be a relative path inside the task directory (no leading /, no .. or backslashes)',
  );

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const RUBRIC_ITEM_ID = /^[a-z][a-z0-9-]*$/;

export const RubricItem = z.strictObject({
  id: z.string().regex(RUBRIC_ITEM_ID),
  criterion: z.string().trim().min(1),
  maxScore: z.int().positive(),
});
export type RubricItem = z.infer<typeof RubricItem>;

export const ArtifactRubric = z.strictObject({
  // Id of an artifact graded by the eval kind's rubric (Contracts 16.2), e.g. brief, research
  artifact: slug,
  items: z.array(RubricItem).min(1),
});
export type ArtifactRubric = z.infer<typeof ArtifactRubric>;

// Each group appears once and item ids are unique across the rubric; groups are matched to the eval kind's artifacts when a task is loaded
export const Rubric = z.array(ArtifactRubric).superRefine((groups, ctx) => {
  const artifacts = groups.map((g) => g.artifact);
  for (const a of new Set(artifacts.filter((x, i) => artifacts.indexOf(x) !== i))) {
    ctx.addIssue({ code: 'custom', message: `Duplicate rubric group: ${a}` });
  }
  const seen = new Set<string>();
  for (const id of groups.flatMap((g) => g.items.map((i) => i.id))) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `Duplicate rubric item id: ${id}` });
    seen.add(id);
  }
});

export const rubricMaxScore = (rubric: ArtifactRubric[]) =>
  rubric.flatMap((g) => g.items).reduce((sum, i) => sum + i.maxScore, 0);

const id = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'id may contain only lowercase letters, digits and hyphens');

const Ticket = z.strictObject({
  title: z.string().trim().min(1),
  // Not trimmed: a body imported from Linear is stored as is and reads back byte for byte
  body: z.string().refine((s) => s.trim() !== '', 'Body must not be empty'),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});
export type Ticket = z.infer<typeof Ticket>;

// Source of a task imported from Linear (Contracts section 13): the original ticket is only read; saving builds the bundle from github.repo and repo.commit
export const IcTaskSource = z.strictObject({
  linear: z.strictObject({
    identifier: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
    url: z.url(),
  }),
  github: z.strictObject({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must be written as owner/name'),
    // PR numbers of this repo among the source ticket's GitHub attachments; reading the source's history matches only these
    prs: z.array(z.int().positive()).default([]),
  }),
});
export type IcTaskSource = z.infer<typeof IcTaskSource>;

const TaskRepo = z.strictObject({
  // Relative to the task directory, points at a git bundle
  path: taskPath,
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit must be a full 40-character sha'),
});
export type TaskRepo = z.infer<typeof TaskRepo>;

export const HiddenTests = z.strictObject({
  // Relative to the task directory, copied into the checkout's test/hidden/ at run time
  dir: taskPath,
  // Test config file relative to the task directory; during grading it sits outside the checkout and reaches the command via {configPath}
  config: taskPath,
  command: z
    .string()
    .includes('{junitPath}', { message: 'command must contain the {junitPath} placeholder' })
    .includes('{configPath}', { message: 'command must contain the {configPath} placeholder' }),
  // Time limit for npm ci and for the test command each; on timeout the process is killed and recorded as a grading error
  timeoutSeconds: z.int().positive().default(600),
  // Keys are paths relative to the checkout root (the JUnit classname), values are test names; the grading denominator. Test names are unique within a file
  manifest: z
    .record(
      z.string().min(1),
      z
        .array(z.string().min(1))
        .min(1)
        .refine((names) => new Set(names).size === names.length, 'Test names must be unique within a file'),
    )
    .refine((m) => Object.keys(m).length > 0, 'Manifest must not be empty'),
});
export type HiddenTests = z.infer<typeof HiddenTests>;

const RequiredChecks = z
  .array(z.string().trim().min(1))
  .refine((names) => new Set(names).size === names.length, 'requiredChecks must not contain duplicates');

// Content of task.yaml (Contracts 16.3): belongs to one eval kind, whose blocks decide the optional fields (taskFieldIssues);
// field order is the order written in the file
const taskFields = {
  id,
  kind: z.enum(evalKinds),
  title: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  hiddenRequirements: z.string().trim().min(1),
  // Value of {input} in the initial message, e.g. the original input of /lfg
  input: z.string().trim().min(1).optional(),
  rubric: Rubric.optional(),
  source: IcTaskSource.optional(),
  ticket: Ticket.optional(),
  repo: TaskRepo.optional(),
  // Checks the end point requires to pass (check names as GitHub reports them); createRunRepo builds a ruleset from them, none when empty and the end point only requires a non-draft PR
  requiredChecks: RequiredChecks.optional(),
  // May be absent when the eval kind also has criteria-judge: the judge grades each acceptance criterion
  hiddenTests: HiddenTests.optional(),
};

export const TaskDefinition = z.strictObject(taskFields);
export type TaskDefinition = z.infer<typeof TaskDefinition>;

// Preview of a Linear import: empty when the ticket has no acceptance criteria section (or no body); the user fills it in on the form before saving
export const TaskDraft = z.strictObject({
  ...taskFields,
  ticket: Ticket.extend({
    body: z.string(),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
  }),
});
export type TaskDraft = z.infer<typeof TaskDraft>;

// Fields of a task that depend on the blocks (id, kind, title are always present)
const optionalFields: readonly (keyof TaskDefinition)[] = [
  'input',
  'persona',
  'hiddenRequirements',
  'rubric',
  'source',
  'ticket',
  'repo',
  'requiredChecks',
  'hiddenTests',
];

// 16.3: fields are checked against the eval kind's blocks, with the exact text for missing or extra ones; empty when there is no problem
export function taskFieldIssues(task: TaskDefinition): string[] {
  const config = EVAL_KINDS[task.kind];
  const derived: readonly TaskFieldName[] = taskFieldsOf(config);
  // Hidden tests are optional when criteria-judge is also present; source belongs only to tasks with a ticket
  const optional = new Set<string>([
    ...(config.grading.includes('criteria-judge') ? ['hiddenTests'] : []),
    ...(derived.includes('ticket') ? ['source'] : []),
  ]);
  const required = derived.filter((f) => !optional.has(f));
  const allowed = new Set<string>([...derived, ...optional]);
  const present = optionalFields.filter((f) => task[f] !== undefined);
  const where = `task ${task.id} (${task.kind})`;
  const issues: string[] = [];
  const missing = required.filter((f) => task[f] === undefined);
  if (missing.length > 0) issues.push(`${where} is missing fields: ${missing.join(', ')}`);
  const extra = present.filter((f) => !allowed.has(f));
  if (extra.length > 0) issues.push(`${where} has extra fields: ${extra.join(', ')}`);
  const rubric = rubricOf(config);
  if (rubric !== null && task.rubric !== undefined) {
    const expected = rubric.map((a) => a.id).join(',');
    const actual = task.rubric.map((g) => g.artifact).join(',');
    if (expected !== actual) {
      issues.push(
        `${where}: the rubric must contain the groups ${expected.replaceAll(',', ', ')} in this order, got ${actual}`,
      );
    }
  }
  return issues;
}

// Tasks from the loader also carry the absolute path of the task directory
export type Task = TaskDefinition & { dir: string };
export type RubricTask = Task & { rubric: ArtifactRubric[] };
export type TicketTask = Task & { ticket: Ticket };
// Task with a copied repo (repo-copy)
export type RepoTask = Task & { repo: TaskRepo; requiredChecks: string[] };
// Task with a PR: copied repo plus ticket (criteria-judge)
export type PrTask = RepoTask & TicketTask;
// Task with hidden tests: grading runs the hidden tests
export type TestsTask = RepoTask & { hiddenTests: HiddenTests };

// Task as returned by the API
export const TaskRecord = z.object({
  task: TaskDefinition,
  dir: z.string(),
  updatedAt: z.number(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

// Request to draft a rubric: the task definition from the page form (rubric may be omitted); the eval kind must have rubric grading
export const RubricDraftRequest = TaskDefinition;
export type RubricDraftRequest = z.infer<typeof RubricDraftRequest>;

// Output of the LLM drafting a rubric; groups are limited to the eval kind's artifact ids. Structured output does not support superRefine,
// so the caller checks group order and id uniqueness again with Rubric and taskFieldIssues.
// ids are written as in RubricItem, 4 to 8 items per group (as the drafting prompt requires); otherwise it fails with zod's own text
export function rubricDraftOutput(artifacts: [string, ...string[]]) {
  return z.object({
    rubric: z.array(
      z.object({
        artifact: z.enum(artifacts),
        items: z
          .array(
            z.object({
              id: z.string().regex(RUBRIC_ITEM_ID),
              criterion: z.string().min(1),
              maxScore: z.int(),
            }),
          )
          .min(4)
          .max(8),
      }),
    ),
  });
}
export type RubricDraftOutput = z.infer<ReturnType<typeof rubricDraftOutput>>;

export const RubricDraft = z.object({
  rubric: Rubric,
  model: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type RubricDraft = z.infer<typeof RubricDraft>;
