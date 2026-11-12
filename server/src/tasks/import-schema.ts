import { z } from 'zod';
import { TaskDraft } from './schema.js';

// This file depends only on zod and web imports its schemas directly: the API for importing ic tasks from Linear (Contracts section 13)

// How a job (one instance after matrix expansion, or one job in a reusable workflow) fares in the copied repo
export const workflowJobStatuses = [
  // Can run on the copy's PRs; its check name goes into the default requiredChecks
  'required',
  // runs-on is not among the runners available to copies (GitHub-hosted runners, self-hosted and copyRunnerLabels in Settings)
  'runner-unavailable',
  // A hosted runner label GitHub has retired
  'retired',
  // A job in needs cannot run, so this one does not run either
  'blocked',
  // The workflow is not triggered by pull_request to main
  'not-on-pr',
  // pull_request has a paths filter: runs only when particular paths change
  'path-filtered',
  // runs-on, the check name or the matrix uses values known only at run time
  'unresolved',
  // The workflow file itself is invalid and GitHub will not run it
  'invalid',
] as const;
export type WorkflowJobStatus = (typeof workflowJobStatuses)[number];

export const WorkflowJob = z.object({
  // Workflow file relative to the repo root
  workflow: z.string(),
  jobId: z.string(),
  // Check name as GitHub reports it; null when it cannot be determined
  checkName: z.string().nullable(),
  // runs-on labels joined by commas; null when they cannot be determined
  runsOn: z.string().nullable(),
  status: z.enum(workflowJobStatuses),
  reason: z.string(),
  // Also runs on push to main (createRunRepo waits for such required checks after pushing the starting code)
  onPush: z.boolean(),
});
export type WorkflowJob = z.infer<typeof WorkflowJob>;

export const WorkflowAnalysis = z.object({
  jobs: z.array(WorkflowJob),
  // Check names with status required, deduplicated in order of appearance
  requiredChecks: z.array(z.string()),
});
export type WorkflowAnalysis = z.infer<typeof WorkflowAnalysis>;

export const LinkedPr = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  // The PR's base commit; null for unmerged PRs
  baseCommit: z.string().nullable(),
});
export type LinkedPr = z.infer<typeof LinkedPr>;

export const LinearIssueDetail = z.object({
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  project: z.string().nullable(),
  url: z.string(),
  team: z.string(),
  // Original markdown returned by Linear
  description: z.string(),
  // GitHub PRs among the ticket's attachments, sorted by merge time, unmerged last
  linkedPrs: z.array(LinkedPr),
});
export type LinearIssueDetail = z.infer<typeof LinearIssueDetail>;

// Acceptance criteria the judge determined from the ticket title and full body; quote is the body text each rests on, shown only in the preview, and task.yaml stores only text
export const CriteriaDraft = z.object({
  criteria: z.array(z.object({ text: z.string(), quote: z.string() })),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});
export type CriteriaDraft = z.infer<typeof CriteriaDraft>;

// Where the default commit came from
export const CommitSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged-pr'), pr: LinkedPr }),
  z.object({ kind: z.literal('default-branch'), branch: z.string() }),
  z.object({ kind: z.literal('given') }),
]);
export type CommitSource = z.infer<typeof CommitSource>;

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must be written as owner/name');

// The identifier in a ticket URL (https://linear.app/<workspace>/issue/TXE-3546/<slug>) or a bare identifier (TXE-3546); null for neither
export function issueIdentifier(input: string): string | null {
  const text = input.trim();
  const bare = /^([A-Z][A-Z0-9]*-\d+)$/.exec(text);
  if (bare?.[1] !== undefined) return bare[1];
  const url = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/.exec(text);
  return url?.[1] ?? null;
}

export const ImportPreviewRequest = z.object({
  // The ticket URL or identifier the user pasted
  issue: z.string().superRefine((s, ctx) => {
    if (issueIdentifier(s) === null) {
      ctx.addIssue({ code: 'custom', message: `Not a Linear ticket URL or identifier: ${s}` });
    }
  }),
  // Imported tasks have eval kind ic (Contracts 16.3)
  // When omitted, the repo of the ticket's linked merged PR
  repo: repoName.optional(),
  // When omitted, the default from Contracts section 13
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'commit must be a full 40-character sha')
    .optional(),
  // false when only re-reading workflows for a repo and commit: the judge is not called again for acceptance criteria
  criteria: z.boolean().default(true),
});
export type ImportPreviewRequest = z.input<typeof ImportPreviewRequest>;

// Result of POST /api/tasks/from-linear, not saved. task is a task definition that can go straight to POST /api/tasks
export const ImportPreview = z.object({
  issue: LinearIssueDetail,
  repo: repoName,
  commit: z.string(),
  commitSource: CommitSource,
  // The commit's title line and time, for the page to check against
  commitTitle: z.string(),
  commitDate: z.string(),
  workflows: WorkflowAnalysis,
  // null when criteria is false in the request
  criteria: CriteriaDraft.nullable(),
  task: TaskDraft,
});
export type ImportPreview = z.infer<typeof ImportPreview>;
