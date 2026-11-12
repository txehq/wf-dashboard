import fs from 'node:fs';
import path from 'node:path';
import createError from '@fastify/error';
import {
  bundleHead,
  createRepoBundle,
  defaultBranch,
  parsePrUrl,
  readCommit,
  readLinkedPr,
  readRemoteWorkflow,
  readWorkflowFiles,
} from '../external/github.js';
import { readIssueForImport } from '../external/linear.js';
import { draftCriteria } from './criteria-draft.js';
import {
  type CommitSource,
  type ImportPreview,
  type ImportPreviewRequest,
  issueIdentifier,
  type LinearIssueDetail,
  type LinkedPr,
} from './import-schema.js';
import type { TaskDefinition, TaskDraft } from './schema.js';
import { analyzeWorkflows } from './workflow-checks.js';

// The page uses this to ask the user to pick a repo
export const RepoRequired = createError<[string]>(
  'REPO_REQUIRED',
  'Ticket %s has no linked merged GitHub PR, so a repo must be given',
  400,
);

// Merged first (by merge time), unmerged after
const byMerge = (a: LinkedPr, b: LinkedPr) =>
  a.mergedAt === null
    ? b.mergedAt === null
      ? 0
      : 1
    : b.mergedAt === null
      ? -1
      : a.mergedAt.localeCompare(b.mergedAt);

// Ticket details: the original body and the GitHub PRs among its attachments (read only)
export async function readLinearIssue(identifier: string): Promise<LinearIssueDetail> {
  const issue = await readIssueForImport(identifier);
  const prRefs = issue.attachmentUrls.flatMap((url) => {
    const ref = parsePrUrl(url);
    return ref === null ? [] : [ref];
  });
  const linkedPrs = await Promise.all(prRefs.map((r) => readLinkedPr(r.repo, r.number)));
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    project: issue.project,
    url: issue.url,
    team: issue.team,
    description: issue.description,
    linkedPrs: linkedPrs.sort(byMerge),
  };
}

// Default commit (Contracts section 13): the base commit of the repo's earliest merged linked PR (before this ticket's changes began),
// or the latest commit of the default branch when there is no merged PR
async function defaultCommit(issue: LinearIssueDetail, repo: string) {
  const merged = issue.linkedPrs.find((p) => p.repo === repo && p.baseCommit !== null);
  if (merged?.baseCommit != null) {
    return { commit: merged.baseCommit, source: { kind: 'merged-pr', pr: merged } as CommitSource };
  }
  const branch = await defaultBranch(repo);
  const head = await readCommit(repo, branch);
  return { commit: head.sha, source: { kind: 'default-branch', branch } as CommitSource };
}

const slug = (identifier: string) => `ic-${identifier.toLowerCase()}`;

function persona(issue: LinearIssueDetail) {
  return `The person who filed Linear ticket ${issue.identifier} (${issue.title}), familiar with this repo of the ${issue.team} team. Answers only from the ticket body; for anything the ticket does not mention, answers "follow the ticket".`;
}

const HIDDEN_REQUIREMENTS = 'There are no requirements beyond the ticket body; when asked about anything the ticket does not mention, answer "follow the ticket".';

// POST /api/tasks/from-linear: reads the ticket, picks the repo and commit, analyses the workflows and returns an editable task draft without writing any file.
// copyRunnerLabels are the self-hosted runner labels available to copies, from Settings
export async function previewLinearImport(
  request: ImportPreviewRequest,
  copyRunnerLabels: string[],
): Promise<ImportPreview> {
  const identifier = issueIdentifier(request.issue);
  if (identifier === null) throw new Error(`Not a Linear ticket URL or identifier: ${request.issue}`);
  const issue = await readLinearIssue(identifier);
  const repo = request.repo ?? issue.linkedPrs.find((p) => p.mergedAt !== null)?.repo;
  if (repo === undefined) throw new RepoRequired(issue.identifier);
  const chosen =
    request.commit === undefined
      ? await defaultCommit(issue, repo)
      : { commit: request.commit, source: { kind: 'given' } as CommitSource };
  const commit = await readCommit(repo, chosen.commit);
  const workflows = await analyzeWorkflows(
    await readWorkflowFiles(repo, commit.sha),
    readRemoteWorkflow,
    copyRunnerLabels,
  );
  // The judge reads the ticket title and full body to determine the acceptance criteria (Contracts section 13)
  const criteria =
    request.criteria === false ? null : await draftCriteria(issue.title, issue.description);
  const task: TaskDraft = {
    id: slug(issue.identifier),
    kind: 'ic',
    title: issue.title,
    persona: persona(issue),
    hiddenRequirements: HIDDEN_REQUIREMENTS,
    source: {
      linear: { identifier: issue.identifier, url: issue.url },
      // PRs linked to the source ticket that belong to this repo; reading the source's history matches only these numbers
      github: {
        repo,
        prs: issue.linkedPrs.filter((p) => p.repo === repo).map((p) => p.number),
      },
    },
    ticket: {
      title: issue.title,
      // The body is stored as is; for a ticket with an empty body the user fills it in on the form
      body: issue.description,
      acceptanceCriteria: criteria?.criteria.map((c) => c.text) ?? [],
    },
    repo: { path: 'repo.bundle', commit: commit.sha },
    requiredChecks: workflows.requiredChecks,
  };
  return {
    issue,
    repo,
    commit: commit.sha,
    commitSource: chosen.source,
    commitTitle: commit.title,
    commitDate: commit.date,
    workflows,
    criteria,
    task,
  };
}

// Before saving a task imported from Linear: rebuilds the bundle from the source repo when the task directory has none or its main is not repo.commit
export async function ensureImportedBundle(task: TaskDefinition, tasksDir: string) {
  if (task.source === undefined) return;
  if (task.repo === undefined) throw new Error(`Imported task ${task.id} has no repo`);
  const bundle = path.join(tasksDir, task.id, task.repo.path);
  if (fs.existsSync(bundle) && (await bundleHead(bundle)) === task.repo.commit) return;
  await createRepoBundle(task.source.github.repo, task.repo.commit, bundle);
}
