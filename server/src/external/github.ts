import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { LinkedPr } from '../tasks/import-schema.js';
import { copyCommitBody, copyWorkflows } from '../tasks/copy-workflows.js';
import type { RepoTask } from '../tasks/schema.js';
import {
  isWorkflowPath,
  type RemoteWorkflowRef,
  type WorkflowFile,
} from '../tasks/workflow-checks.js';

export const ORG = 'txehq';
// GitHub Actions app: only checks reported by Actions satisfy a required check; a commit status of the same name cannot impersonate one
const ACTIONS_INTEGRATION_ID = 15368;
const RUN_POLL_MS = 5_000;
const RUN_TIMEOUT_MS = 600_000;
const DEFAULT_BRANCH_TIMEOUT_MS = 60_000;

// Throws on a nonzero exit, with stderr in the error
async function cmd(file: string, args: string[], options: { cwd?: string; input?: string } = {}) {
  const { stdout } = await execa(file, args, options);
  return stdout;
}

async function ghJson<T>(args: string[], schema: z.ZodType<T>, input?: string): Promise<T> {
  return schema.parse(JSON.parse(await cmd('gh', args, input === undefined ? {} : { input })));
}

export const runRepoName = (runId: string) => `${ORG}/wfe-${runId}`;

export interface RunRepo {
  repo: string;
  url: string;
  mainSha: string;
}

const RepoView = z.object({
  url: z.string(),
  defaultBranchRef: z.object({ name: z.string() }),
});

const Branch = z.object({ commit: z.object({ sha: z.string() }) }).loose();

async function repoView(repo: string) {
  return ghJson(['repo', 'view', repo, '--json', 'url,defaultBranchRef'], RepoView);
}

// An empty repo's defaultBranchRef is empty; it becomes main a few seconds after the first push. Stops waiting when signal aborts (server shutdown)
async function waitDefaultBranchMain(repo: string, signal: AbortSignal) {
  const deadline = Date.now() + DEFAULT_BRANCH_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const view = await repoView(repo);
    if (view.defaultBranchRef.name === 'main') return view;
    if (view.defaultBranchRef.name !== '' || Date.now() > deadline) {
      throw new Error(`${repo} default branch is "${view.defaultBranchRef.name}", expected main`);
    }
    await sleep(1_000, undefined, { signal });
  }
}

async function branchSha(repo: string, branch: string): Promise<string> {
  return (await ghJson(['api', `repos/${repo}/branches/${branch}`], Branch)).commit.sha;
}

const Run = z
  .object({
    databaseId: z.number(),
    status: z.string(),
    conclusion: z.string(),
    name: z.string(),
    url: z.string(),
    event: z.string(),
  })
  .loose();
export type WorkflowRun = z.infer<typeof Run>;

// The list may be empty for a few seconds after a push, so wait until it is "nonempty and all completed"; stops waiting when signal aborts
export async function waitRuns(
  repo: string,
  sha: string,
  signal: AbortSignal,
): Promise<WorkflowRun[]> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const runs = await ghJson(
      [
        'run',
        'list',
        '--repo',
        repo,
        '--commit',
        sha,
        '--json',
        'databaseId,status,conclusion,name,url,event',
      ],
      z.array(Run),
    );
    if (runs.length > 0 && runs.every((r) => r.status === 'completed')) return runs;
    if (Date.now() > deadline) {
      throw new Error(
        `${repo}@${sha} workflow runs did not finish within ${String(RUN_TIMEOUT_MS)}ms`,
      );
    }
    await sleep(RUN_POLL_MS, undefined, { signal });
  }
}

// The ruleset's required checks accept only checks reported by GitHub Actions: a commit status of the same name cannot impersonate one
export function ciRuleset(requiredChecks: string[]) {
  return {
    name: 'ci-required',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: requiredChecks.map((context) => ({
            context,
            integration_id: ACTIONS_INTEGRATION_ID,
          })),
        },
      },
    ],
  };
}

// Workflow files of a commit in a local repo; empty without .github/workflows
export async function seedWorkflowFiles(seed: string, commit: string): Promise<WorkflowFile[]> {
  const tree = await execa('git', ['-C', seed, 'cat-file', '-t', `${commit}:.github/workflows`], {
    reject: false,
  });
  if (tree.exitCode !== 0) {
    await cmd('git', ['-C', seed, 'cat-file', '-e', `${commit}^{commit}`]);
    return [];
  }
  const names = await cmd('git', [
    '-C',
    seed,
    'ls-tree',
    '--name-only',
    `${commit}:.github/workflows`,
  ]);
  const paths = names
    .split('\n')
    .filter((name) => name !== '')
    .map((name) => `.github/workflows/${name}`)
    .filter(isWorkflowPath);
  return Promise.all(
    paths.map(async (p) => ({
      path: p,
      content: await cmd('git', ['-C', seed, 'show', `${commit}:${p}`]),
    })),
  );
}

// Local clone before pushing: data/runs/<runId>/seed, deleted after the push
export const seedDir = (runId: string) => path.join(config.runsDir, runId, 'seed');

// gh arguments for creating the repo: an ic copy carries the task id, lfg (task is null) only the run id. An imported task's id
// is derived from the source ticket id, and the source never appears in the copy
export function repoCreateArgs(task: RepoTask | null, runId: string): string[] {
  const description =
    task === null || task.source !== undefined
      ? `wf-dashboard eval run ${runId}`
      : `wf-dashboard eval run ${runId} (${task.id})`;
  return ['repo', 'create', runRepoName(runId), '--private', '--description', description];
}

// Content of the /ic run's repo copy (Contracts section 13), written in seed; returns the HEAD to push. Adds one commit by
// wf-dashboard on top of the starting commit: workflow `on` keeps only pull_request and workflow_call, files with neither are deleted; no commit when nothing changes
export async function prepareCopySeed(task: RepoTask, seed: string): Promise<string> {
  const bundle = path.join(task.dir, task.repo.path);
  if (!fs.existsSync(bundle))
    throw new Error(`Starting repo bundle of task ${task.id} does not exist: ${bundle}`);
  await cmd('git', ['clone', '--quiet', '--no-checkout', bundle, seed]);
  await cmd('git', ['-C', seed, 'checkout', '--quiet', '--detach', task.repo.commit]);
  const files = (await seedWorkflowFiles(seed, task.repo.commit)).map((f) => ({
    ...f,
    content: fs.readFileSync(path.join(seed, f.path), 'utf8'),
  }));
  const changes = copyWorkflows(files);
  for (const change of changes) {
    const file = path.join(seed, change.path);
    if (change.kind === 'deleted') fs.rmSync(file);
    else fs.writeFileSync(file, change.content);
  }
  if (changes.length > 0) {
    await cmd('git', ['-C', seed, 'add', '--all', '.github/workflows']);
    // Local git may have no identity configured; this commit is created as the dashboard
    await cmd('git', [
      '-C',
      seed,
      '-c',
      'user.name=wf-dashboard',
      '-c',
      'user.email=wf-dashboard@users.noreply.github.com',
      'commit',
      '--quiet',
      '-m',
      COPY_COMMIT_TITLE,
      '-m',
      copyCommitBody(changes),
    ]);
  }
  return (await cmd('git', ['-C', seed, 'rev-parse', 'HEAD'])).trim();
}

// Repo content for /lfg runs: a single initial commit, no CI. The initial commit is made locally on main, then pushed
// (gh repo create --add-readme would use the org's default branch name, master for txehq)
export async function prepareEmptySeed(runId: string, seed: string): Promise<string> {
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'README.md'), `# wfe-${runId}\n`);
  await cmd('git', ['init', '-b', 'main'], { cwd: seed });
  await cmd('git', ['add', 'README.md'], { cwd: seed });
  // Local git may have no identity configured; the initial commit is created as the dashboard
  await cmd(
    'git',
    [
      '-c',
      'user.name=wf-dashboard',
      '-c',
      'user.email=wf-dashboard@users.noreply.github.com',
      'commit',
      '-m',
      'chore: initial commit',
    ],
    { cwd: seed },
  );
  return (await cmd('git', ['-C', seed, 'rev-parse', 'HEAD'])).trim();
}

// Push seed's HEAD as the remote's main; remote is a GitHub URL or a local bare repo path
export async function pushSeed(seed: string, remote: string): Promise<void> {
  await cmd('git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);
}

// After the push GitHub has no workflow triggered by push, schedule or manual dispatch, so CI on the default branch is not awaited. The order
// matters: once the ruleset is active a direct push to main is rejected (GH013), so push first, then create the ruleset from the task's
// requiredChecks (none when empty); the agent can only change code through a PR
export async function createRunRepo(
  task: RepoTask,
  runId: string,
  signal: AbortSignal,
): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const seed = seedDir(runId);
  const head = await prepareCopySeed(task, seed);
  await cmd('gh', repoCreateArgs(task, runId));
  await pushSeed(seed, `https://github.com/${repo}.git`);
  // The local copy is no longer needed after the push
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
  const mainSha = await branchSha(repo, 'main');
  if (mainSha !== head) throw new Error(`${repo} main is at ${mainSha}, expected ${head}`);

  if (task.requiredChecks.length > 0) {
    await ghJson(
      ['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'],
      z.object({ id: z.number() }).loose(),
      JSON.stringify(ciRuleset(task.requiredChecks)),
    );
  }
  return { repo, url: view.url, mainSha };
}

export const COPY_COMMIT_TITLE = 'eval copy: keep only pull_request workflows';

// For /lfg runs: a single initial commit, no CI and no ruleset
export async function createEmptyRunRepo(runId: string, signal: AbortSignal): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const seed = seedDir(runId);
  await prepareEmptySeed(runId, seed);
  await cmd('gh', repoCreateArgs(null, runId));
  await pushSeed(seed, `https://github.com/${repo}.git`);
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
  return { repo, url: view.url, mainSha: await branchSha(repo, 'main') };
}

const CheckBucket = z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const PrCheck = z.object({ name: z.string(), bucket: CheckBucket, state: z.string() });
export type PrCheck = z.infer<typeof PrCheck>;

// The gh commands that read a PR are kept apart from parsing their output: the parsers also run on real recorded output in tests
// (test/fixtures/gh/, recorded by scripts/record-gh-fixtures.ts)
export const prArgs = {
  list: (repo: string) => [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'number,url,isDraft,headRefOid,state,createdAt',
  ],
  checks: (repo: string, pr: number) => [
    'pr',
    'checks',
    String(pr),
    '--repo',
    repo,
    '--json',
    'name,bucket,state',
  ],
  endpoint: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'isDraft,headRefOid,state',
  ],
  branch: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'headRefName',
  ],
  description: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'title,body,headRefOid',
  ],
  diff: (repo: string, pr: number) => ['pr', 'diff', String(pr), '--repo', repo],
  snapshot: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'number,url,title,body,state,isDraft,headRefOid,reviews,comments',
  ],
  reviewThreads: (repo: string, pr: number) => {
    const [owner, name] = repo.split('/');
    if (owner === undefined || name === undefined)
      throw new Error(`Repo name is not owner/name: ${repo}`);
    return [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${String(pr)}`,
    ];
  },
};

// The result of one gh call; on a nonzero exit code the parser decides whether it is an error
export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function ghResult(args: string[]): Promise<GhResult> {
  const result = await execa('gh', args, { reject: false });
  if (result.exitCode === undefined) {
    throw new Error(`gh ${args.join(' ')} was killed by signal ${String(result.signal)}`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export function checksFrom(repo: string, pr: number, result: GhResult): PrCheck[] {
  // With failing checks the exit code is 1 (fail) or 8 (pending) and the JSON is printed as usual
  if (result.stdout.trim() !== '' && [0, 1, 8].includes(result.exitCode)) {
    return z.array(PrCheck).parse(JSON.parse(result.stdout));
  }
  // No check on head yet (e.g. just pushed, workflow not registered): this stderr line is gh's only way to tell it from other exit-code-1 errors
  if (result.exitCode === 1 && result.stderr.includes('no checks reported')) return [];
  throw new Error(
    `gh pr checks ${repo}#${String(pr)} exit code ${String(result.exitCode)}: ${result.stderr}`,
  );
}

export async function prChecks(repo: string, pr: number): Promise<PrCheck[]> {
  return checksFrom(repo, pr, await ghResult(prArgs.checks(repo, pr)));
}

const PrListItem = z.object({
  number: z.number(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  state: z.string(),
  createdAt: z.string(),
});

export interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  head: string;
  state: string;
  checks: PrCheck[];
}

// The newest PR in gh pr list output; null when there is no PR yet
export function latestPrFrom(stdout: string): z.infer<typeof PrListItem> | null {
  const prs = z.array(PrListItem).parse(JSON.parse(stdout));
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function prInfoFrom(latest: z.infer<typeof PrListItem>, checks: PrCheck[]): PrInfo {
  return {
    number: latest.number,
    url: latest.url,
    isDraft: latest.isDraft,
    head: latest.headRefOid,
    state: latest.state,
    checks,
  };
}

// The newest PR in the run repo; null when there is no PR yet
export async function readPr(repo: string): Promise<PrInfo | null> {
  const latest = latestPrFrom(await cmd('gh', prArgs.list(repo)));
  if (latest === null) return null;
  return prInfoFrom(latest, await prChecks(repo, latest.number));
}

// A PR's reviews, comments and checks live only on GitHub; a snapshot is stored when the run enters grading (Contracts 15.2), so analyses can still read it after the repo is deleted
const Author = z.object({ login: z.string() }).nullable();
const login = (a: z.infer<typeof Author>) => a?.login ?? null;

const SnapshotView = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  reviews: z.array(
    z.object({ author: Author, state: z.string(), body: z.string(), submittedAt: z.string() }),
  ),
  comments: z.array(z.object({ author: Author, body: z.string(), createdAt: z.string() })),
});

const ThreadComment = z.object({
  author: Author,
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
const PageInfo = z.object({ hasNextPage: z.boolean() });
const ReviewThreads = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: PageInfo,
          nodes: z.array(
            z.object({
              path: z.string(),
              line: z.number().nullable(),
              isResolved: z.boolean(),
              isOutdated: z.boolean(),
              comments: z.object({ pageInfo: PageInfo, nodes: z.array(ThreadComment) }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          path line isResolved isOutdated
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

export const PrSnapshot = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  head: z.string(),
  reviews: z.array(
    z.object({
      author: z.string().nullable(),
      state: z.string(),
      body: z.string(),
      submittedAt: z.string(),
    }),
  ),
  // Inline review comments grouped by thread
  reviewThreads: z.array(
    z.object({
      path: z.string(),
      line: z.number().nullable(),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      comments: z.array(
        z.object({
          author: z.string().nullable(),
          body: z.string(),
          createdAt: z.string(),
          url: z.string(),
        }),
      ),
    }),
  ),
  // Comments in the PR conversation
  comments: z.array(
    z.object({ author: z.string().nullable(), body: z.string(), createdAt: z.string() }),
  ),
  checks: z.array(PrCheck),
});
export type PrSnapshot = z.infer<typeof PrSnapshot>;

// latest is readPr's result; view and threads are the output of prArgs.snapshot and prArgs.reviewThreads
export function snapshotFrom(
  repo: string,
  latest: PrInfo,
  viewStdout: string,
  threadsStdout: string,
): PrSnapshot {
  const view = SnapshotView.parse(JSON.parse(viewStdout));
  const threads = ReviewThreads.parse(JSON.parse(threadsStdout)).data.repository.pullRequest
    .reviewThreads;
  if (threads.pageInfo.hasNextPage || threads.nodes.some((t) => t.comments.pageInfo.hasNextPage)) {
    throw new Error(
      `${repo}#${String(latest.number)} has more than 100 review threads or comments, the snapshot is incomplete`,
    );
  }
  return {
    number: view.number,
    url: view.url,
    title: view.title,
    body: view.body,
    state: view.state,
    isDraft: view.isDraft,
    head: view.headRefOid,
    reviews: view.reviews.map((r) => ({ ...r, author: login(r.author) })),
    reviewThreads: threads.nodes.map((t) => ({
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({ ...c, author: login(c.author) })),
    })),
    comments: view.comments.map((c) => ({ ...c, author: login(c.author) })),
    checks: latest.checks,
  };
}

// Snapshot of the newest PR in the run repo; null when there is no PR yet
export async function readPrSnapshot(repo: string): Promise<PrSnapshot | null> {
  const latest = await readPr(repo);
  if (latest === null) return null;
  return snapshotFrom(
    repo,
    latest,
    await cmd('gh', prArgs.snapshot(repo, latest.number)),
    await cmd('gh', prArgs.reviewThreads(repo, latest.number)),
  );
}

const Rule = z.object({ type: z.string() }).loose();
const RequiredChecksRule = z
  .object({
    parameters: z
      .object({ required_status_checks: z.array(z.object({ context: z.string() }).loose()) })
      .loose(),
  })
  .loose();

export async function requiredContexts(repo: string, branch: string): Promise<string[]> {
  const rules = await ghJson(['api', `repos/${repo}/rules/branches/${branch}`], z.array(Rule));
  return rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) =>
      RequiredChecksRule.parse(r).parameters.required_status_checks.map((c) => c.context),
    );
}

export interface IcEndpoint {
  reached: boolean;
  ciGreen: boolean;
  isDraft: boolean;
  head: string;
  missingRequired: string[];
}

// Endpoint (Contracts section 13): the PR is still OPEN and out of draft, and the task's requiredChecks all pass on the current head
// (conclusion success, skipped or neutral, as with GitHub required checks); with no requiredChecks only a non-draft PR is required.
// Other checks (e.g. jobs queued forever because the copy has no runner) do not matter. The /ic endpoint is a PR awaiting human review: a closed or merged PR does not count.
// viewStdout is the output of prArgs.endpoint
export function endpointFrom(
  viewStdout: string,
  checks: PrCheck[],
  requiredChecks: string[],
): IcEndpoint {
  const view = z
    .object({ isDraft: z.boolean(), headRefOid: z.string(), state: z.string() })
    .parse(JSON.parse(viewStdout));
  const passed = new Set(
    checks.filter((c) => c.bucket === 'pass' || c.bucket === 'skipping').map((c) => c.name),
  );
  const missingRequired = requiredChecks.filter((name) => !passed.has(name));
  const ciGreen = missingRequired.length === 0;
  return {
    reached: view.state === 'OPEN' && !view.isDraft && ciGreen,
    ciGreen,
    isDraft: view.isDraft,
    head: view.headRefOid,
    missingRequired,
  };
}

export async function icEndpoint(
  repo: string,
  pr: number,
  requiredChecks: string[],
): Promise<IcEndpoint> {
  const view = await cmd('gh', prArgs.endpoint(repo, pr));
  return endpointFrom(view, await prChecks(repo, pr), requiredChecks);
}

export const branchFrom = (stdout: string) =>
  z.object({ headRefName: z.string().min(1) }).parse(JSON.parse(stdout)).headRefName;

// The PR's head branch name, recorded in the grading details
export async function prBranch(repo: string, pr: number): Promise<string> {
  return branchFrom(await cmd('gh', prArgs.branch(repo, pr)));
}

// For hidden tests: shallow-clone the PR head into dest (data/runs/<runId>/grading/checkout). Fetched by refs/pull/<n>/head,
// so it works after the PR is merged and the branch deleted
export async function clonePr(repo: string, pr: number, dest: string): Promise<{ head: string }> {
  await cmd('gh', ['repo', 'clone', repo, dest, '--', '--depth', '1']);
  await cmd('git', ['-C', dest, 'fetch', '--depth', '1', 'origin', `pull/${String(pr)}/head`]);
  await cmd('git', ['-C', dest, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  return { head: (await cmd('git', ['-C', dest, 'rev-parse', 'HEAD'])).trim() };
}

// Input of the acceptance criteria judge: the PR's full diff, title and body
export async function prDiff(repo: string, pr: number): Promise<string> {
  return cmd('gh', prArgs.diff(repo, pr));
}

export const descriptionFrom = (stdout: string) =>
  z
    .object({ title: z.string(), body: z.string(), headRefOid: z.string() })
    .parse(JSON.parse(stdout));

export async function prDescription(repo: string, pr: number) {
  return descriptionFrom(await cmd('gh', prArgs.description(repo, pr)));
}

// The following import ic tasks from Linear (Contracts section 13): they only read the source repo and never write to it

const PR_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

// A GitHub PR link from a Linear attachment; null for other links
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = PR_URL.exec(url);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { repo: m[1], number: Number(m[2]) };
}

const PrView = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  baseRefOid: z.string(),
});

// After a repo rename (capsohq → txehq) old links redirect through GitHub, so the repo name comes from the PR's canonical URL
export async function readLinkedPr(repo: string, pr: number): Promise<LinkedPr> {
  const view = await ghJson(
    [
      'pr',
      'view',
      String(pr),
      '--repo',
      repo,
      '--json',
      'number,url,title,state,mergedAt,baseRefOid',
    ],
    PrView,
  );
  const canonical = parsePrUrl(view.url);
  if (canonical === null) throw new Error(`PR URL returned by gh is not a GitHub PR: ${view.url}`);
  const merged = view.state === 'MERGED';
  return {
    repo: canonical.repo,
    number: view.number,
    url: view.url,
    title: view.title,
    state: view.state,
    mergedAt: merged ? view.mergedAt : null,
    // On merge GitHub sets base to the head of the base branch before the merge, i.e. the starting point of this change
    baseCommit: merged ? view.baseRefOid : null,
  };
}

const CommitView = z.object({
  sha: z.string(),
  commit: z
    .object({
      message: z.string(),
      committer: z.object({ date: z.string() }).loose(),
    })
    .loose(),
});

// ref is a commit sha or a branch name
export async function readCommit(repo: string, ref: string) {
  const view = await ghJson(['api', `repos/${repo}/commits/${ref}`], CommitView);
  return {
    sha: view.sha,
    title: view.commit.message.split('\n')[0] ?? '',
    date: view.commit.committer.date,
  };
}

export async function defaultBranch(repo: string): Promise<string> {
  const view = await repoView(repo);
  if (view.defaultBranchRef.name === '')
    throw new Error(`${repo} has no default branch (empty repo)`);
  return view.defaultBranchRef.name;
}

const Tree = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() }).loose()),
});
const Blob = z.object({ content: z.string(), encoding: z.literal('base64') });

async function treeEntries(repo: string, sha: string) {
  const tree = await ghJson(['api', `repos/${repo}/git/trees/${sha}`], Tree);
  if (tree.truncated) throw new Error(`${repo} tree ${sha} was truncated by GitHub`);
  return tree.tree;
}

const decodeBase64 = (content: string) => Buffer.from(content, 'base64').toString('utf8');

// Workflow files under .github/workflows/ in the commit; empty without that directory
export async function readWorkflowFiles(repo: string, commit: string): Promise<WorkflowFile[]> {
  let entries = await treeEntries(repo, commit);
  for (const dir of ['.github', 'workflows']) {
    const entry = entries.find((e) => e.path === dir && e.type === 'tree');
    if (entry === undefined) return [];
    entries = await treeEntries(repo, entry.sha);
  }
  const files = entries
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: `.github/workflows/${e.path}`, sha: e.sha }))
    .filter((f) => isWorkflowPath(f.path));
  return Promise.all(
    files.map(async (f) => ({
      path: f.path,
      content: decodeBase64(
        (await ghJson(['api', `repos/${repo}/git/blobs/${f.sha}`], Blob)).content,
      ),
    })),
  );
}

// A reusable workflow in another repo (uses: owner/repo/.github/workflows/x.yml@ref)
export async function readRemoteWorkflow(ref: RemoteWorkflowRef): Promise<string> {
  const file = await ghJson(
    [
      'api',
      `repos/${ref.owner}/${ref.repository}/contents/${ref.path}?ref=${encodeURIComponent(ref.version)}`,
    ],
    Blob,
  );
  return decodeBase64(file.content);
}

// Build the starting repo bundle at commit: fully clone the source repo (bare), point main at commit, then bundle all of main's history.
// Write a temporary file first, rename it after verifying
export async function createRepoBundle(repo: string, commit: string, bundlePath: string) {
  // Cloning and bundling happen in a temp directory next to the bundle; on success the bundle is renamed into place; the temp directory
  // is always deleted, and on failure the original error is thrown
  const dir = path.dirname(bundlePath);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, `.bundle-tmp-${String(process.pid)}-${String(Date.now())}`);
  fs.mkdirSync(work);
  try {
    const clone = path.join(work, 'source.git');
    await cmd('gh', ['repo', 'clone', repo, clone, '--', '--bare', '--quiet']);
    // A commit on no branch (e.g. only in a PR ref) must be fetched separately
    const present = await execa('git', ['-C', clone, 'cat-file', '-e', `${commit}^{commit}`], {
      reject: false,
    });
    if (present.exitCode !== 0) {
      await cmd('git', ['-C', clone, 'fetch', '--quiet', 'origin', commit]);
    }
    await cmd('git', ['-C', clone, 'update-ref', 'refs/heads/main', commit]);
    const tmp = path.join(work, 'repo.bundle');
    await cmd('git', ['-C', clone, 'bundle', 'create', '--quiet', tmp, 'main']);
    await cmd('git', ['-C', clone, 'bundle', 'verify', '--quiet', tmp]);
    fs.renameSync(tmp, bundlePath);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The commit main points to in the bundle
export async function bundleHead(bundlePath: string): Promise<string> {
  const heads = await cmd('git', ['bundle', 'list-heads', bundlePath, 'refs/heads/main'], {
    cwd: path.dirname(bundlePath),
  });
  const sha = heads.split(' ')[0];
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${bundlePath} has no refs/heads/main: ${heads}`);
  }
  return sha;
}
