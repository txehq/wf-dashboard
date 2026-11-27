import { z } from 'zod';
import { type GhResult, ghResult } from '../external/github.js';

// GitHub reads of the stats sync (Contracts 37.2): the PRs an issue's attachments link to, every merged PR of the
// team's repos found by search, and the timings of the timed repo's merged PRs (37.6)

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface PrRef {
  // https://github.com/<owner>/<repo>/pull/<n>, without a trailing /files or #anchor
  url: string;
  repo: string;
  number: number;
}

export function prRef(url: string): PrRef | null {
  const match = PR_URL.exec(url);
  if (match === null) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repo: `${owner}/${repo}`,
    number: Number(number),
  };
}

// Only the fields the stats use, so a PR's title and body are never read
const PR_JQ =
  '{id, state, draft, merged_at, closed_at, additions, deletions, commits, created_at, user: {login: .user.login}}';

export function prArgs(ref: PrRef): string[] {
  return ['api', `repos/${ref.repo}/pulls/${String(ref.number)}`, '--jq', PR_JQ];
}

const Pr = z.object({
  id: z.number(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.iso.datetime().nullable(),
  closed_at: z.iso.datetime().nullable(),
  additions: z.number(),
  deletions: z.number(),
  commits: z.number(),
  created_at: z.iso.datetime(),
  user: z.object({ login: z.string() }),
});
export type Pr = z.infer<typeof Pr>;

// A PR that does not exist or cannot be read is recorded with gh's text and left out of the counts; any other failure
// (network, authentication, a 403 for the rate limit) fails the sync, and the next sync reads the PR again
export type PrRead = { ok: true; pr: Pr } | { ok: false; error: string };

export function prReadFrom(
  ref: PrRef,
  result: { exitCode: number; stdout: string; stderr: string },
): PrRead {
  if (result.exitCode === 0) return { ok: true, pr: Pr.parse(JSON.parse(result.stdout)) };
  if (/\(HTTP 40[34]\)/.test(result.stderr) && !/rate limit/i.test(result.stderr)) {
    return {
      ok: false,
      error: [result.stderr.trim(), result.stdout.trim()].filter((s) => s !== '').join('\n'),
    };
  }
  throw new Error(
    `gh ${prArgs(ref).join(' ')} exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
  );
}

export async function readPr(ref: PrRef): Promise<PrRead> {
  return prReadFrom(ref, await ghResult(prArgs(ref)));
}

const failed = (args: string[], result: GhResult) =>
  new Error(
    `gh ${args.join(' ')} exit code ${String(result.exitCode)}: ${[result.stderr.trim(), result.stdout.trim()].filter((s) => s !== '').join('\n')}`,
  );

export function repoArgs(repo: string): string[] {
  return ['api', `repos/${repo}`, '--jq', '.full_name'];
}

// A repo's current owner/name: GitHub redirects a renamed org or repo, and the search finds nothing under the old name.
// null when the repo no longer exists (404); any other failure fails the sync
export function repoNameFrom(repo: string, result: GhResult): string | null {
  if (result.exitCode === 0) return z.string().min(1).parse(result.stdout.trim());
  if (result.stderr.includes('(HTTP 404)')) return null;
  throw failed(repoArgs(repo), result);
}

export async function readRepoName(repo: string): Promise<string | null> {
  return repoNameFrom(repo, await ghResult(repoArgs(repo)));
}

// GitHub search returns at most this many results for one query; a window with more is split in two
export const SEARCH_CAP = 1000;

// What a search of merged PRs reads: the GraphQL fields of each PullRequest node, their shape, and how many PRs one
// request asks for
export interface SearchSpec<T> {
  fields: string;
  node: z.ZodType<T>;
  page: number;
  // Newest first: the pages come latest created first, and the newer half of a split window is searched first. The
  // page shows a long first read's recent PRs while older ones are still being read
  newestFirst?: boolean;
}

const SearchedPr = z.object({
  url: z.string(),
  number: z.number(),
  databaseId: z.number(),
  mergedAt: z.iso.datetime(),
  closedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  // null for a deleted account
  author: z.object({ login: z.string() }).nullable(),
  commits: z.object({ totalCount: z.number() }),
});
export type SearchedPr = z.infer<typeof SearchedPr>;

// Every merged PR of the team's repos with its author and commit count (37.2)
export const MERGED_PRS: SearchSpec<SearchedPr> = {
  fields:
    'url number databaseId mergedAt closedAt createdAt author { login } commits { totalCount }',
  node: SearchedPr,
  page: 100,
};

// The GitHub Actions app: its check suites are the workflow runs of a commit
const ACTIONS_APP_ID = 15368;
// More check suites than this on one commit fails the read; txe's commits have up to 24 (2026-11-18)
const SUITES = 100;

const CheckSuite = z.object({
  status: z.string(),
  conclusion: z.string().nullable(),
  // null for a suite with no run
  workflowRun: z
    .object({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      workflow: z.object({ id: z.string(), name: z.string() }),
    })
    .nullable(),
});

const TimedPr = z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  mergedAt: z.iso.datetime(),
  author: z.object({ login: z.string() }).nullable(),
  timelineItems: z.object({ nodes: z.array(z.object({ createdAt: z.iso.datetime() })) }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          checkSuites: z.object({ totalCount: z.number(), nodes: z.array(CheckSuite) }),
        }),
      }),
    ),
  }),
});
export type TimedPr = z.infer<typeof TimedPr>;

const TIMED_FIELDS = `url number title createdAt mergedAt author { login } timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } } commits(last: 1) { nodes { commit { checkSuites(first: ${String(SUITES)}, filterBy: { appId: ${String(ACTIONS_APP_ID)} }) { totalCount nodes { status conclusion workflowRun { createdAt updatedAt workflow { id name } } } } } } }`;

// The timed repo's merged PRs with their last ready for review and the Actions runs of their last head commit (37.6).
// 25 per request: under the sync's 4 at once, a page of 50 takes 3-12 s and GitHub answers some with a 504 at its 10 s
// limit, a page of 100 more often; a page of 25 takes 2.5-5.5 s
export const PR_TIMINGS: SearchSpec<TimedPr> = {
  fields: TIMED_FIELDS,
  node: TimedPr,
  page: 25,
  newestFirst: true,
};

// Conclusions of a run that did not fail
const PASSED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

export interface PrTiming {
  readyAt: number | null;
  ciStartedAt: number | null;
  ciEndedAt: number | null;
  ciRuns: number;
  ciAllSucceeded: boolean | null;
  // The longest run (createdAt to updatedAt) and whether it ended after the merge; null without runs or while one goes
  slowest: { workflow: string; ms: number; afterMerge: boolean } | null;
}

// The CI of a merged PR (37.6): the workflow runs of its last head commit created up to the merge (a review or a close
// after the merge starts runs of its own), from the earliest creation to the latest last update. A re-run keeps its
// run's creation and moves its last update to the re-run's end; the shards of a workflow are jobs of one run. All
// succeeded when each workflow's latest run passed. While a run still goes, the end, the outcome and the slowest run
// are not known yet
export function prTiming(pr: TimedPr): PrTiming {
  const [head] = pr.commits.nodes;
  if (head === undefined || pr.commits.nodes.length !== 1)
    throw new Error(`${pr.url} has no single last commit`);
  const suites = head.commit.checkSuites;
  if (suites.totalCount > suites.nodes.length) {
    throw new Error(
      `${pr.url} has ${String(suites.totalCount)} Actions check suites, more than the ${String(SUITES)} read`,
    );
  }
  const mergedAt = Date.parse(pr.mergedAt);
  const runs = suites.nodes.flatMap((s) => {
    if (s.workflowRun === null) return [];
    const createdAt = Date.parse(s.workflowRun.createdAt);
    if (createdAt > mergedAt) return [];
    return [
      {
        status: s.status,
        conclusion: s.conclusion,
        workflow: s.workflowRun.workflow.id,
        name: s.workflowRun.workflow.name,
        createdAt,
        updatedAt: Date.parse(s.workflowRun.updatedAt),
      },
    ];
  });
  const ready = pr.timelineItems.nodes[0];
  const readyAt = ready === undefined ? null : Date.parse(ready.createdAt);
  const none = { ciEndedAt: null, ciAllSucceeded: null, slowest: null };
  if (runs.length === 0) return { readyAt, ciStartedAt: null, ciRuns: 0, ...none };
  const ciStartedAt = Math.min(...runs.map((r) => r.createdAt));
  const ciRuns = runs.length;
  if (runs.some((r) => r.status !== 'COMPLETED')) return { readyAt, ciStartedAt, ciRuns, ...none };
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const seen = latest.get(r.workflow);
    if (seen === undefined || r.createdAt >= seen.createdAt) latest.set(r.workflow, r);
  }
  const slowest = runs.reduce((a, b) =>
    b.updatedAt - b.createdAt > a.updatedAt - a.createdAt ? b : a,
  );
  return {
    readyAt,
    ciStartedAt,
    ciEndedAt: Math.max(...runs.map((r) => r.updatedAt)),
    ciRuns,
    ciAllSucceeded: [...latest.values()].every((r) => PASSED.has(r.conclusion ?? '')),
    slowest: {
      workflow: slowest.name,
      ms: slowest.updatedAt - slowest.createdAt,
      afterMerge: slowest.updatedAt > mergedAt,
    },
  };
}

const searchQuery = (spec: SearchSpec<unknown>) => `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${String(spec.page)}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${spec.fields} } }
  }
}`;

// GitHub search takes times to the second; both ends are included
const searchTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A window ends in the past, so the PRs it matches are fixed while its pages are read, in either order
export function searchArgs(
  spec: SearchSpec<unknown>,
  repo: string,
  from: number,
  to: number,
  after?: string,
): string[] {
  const q = `repo:${repo} is:pr is:merged merged:${searchTime(from)}..${searchTime(to)} sort:created-${spec.newestFirst === true ? 'desc' : 'asc'}`;
  return [
    'api',
    'graphql',
    '-f',
    `query=${searchQuery(spec)}`,
    '-f',
    `q=${q}`,
    ...(after === undefined ? [] : ['-f', `after=${after}`]),
  ];
}

async function searchPage<T>(
  spec: SearchSpec<T>,
  repo: string,
  from: number,
  to: number,
  after?: string,
) {
  const args = searchArgs(spec, repo, from, to, after);
  const result = await ghResult(args);
  if (result.exitCode !== 0) throw failed(args, result);
  return z
    .object({
      data: z.object({
        search: z.object({
          issueCount: z.number(),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(spec.node),
        }),
      }),
    })
    .parse(JSON.parse(result.stdout)).data.search;
}

// Every PR of repo merged from from to to (ms, both included), page by page through onPage; onWindow gets each window
// once all its PRs went through onPage (to the second, both ends included). Each request is one call of limit (the
// sync's GitHub concurrency); the halves of a split window are searched side by side
export async function searchMergedPrs<T>(
  spec: SearchSpec<T>,
  repo: string,
  from: number,
  to: number,
  limit: <R>(task: () => Promise<R>) => Promise<R>,
  onPage: (prs: T[]) => void,
  signal: AbortSignal,
  onWindow: (from: number, to: number) => void = () => undefined,
): Promise<void> {
  const window = async (start: number, end: number): Promise<void> => {
    signal.throwIfAborted();
    const first = await limit(() => searchPage(spec, repo, start, end));
    if (first.issueCount > SEARCH_CAP) {
      const seconds = Math.floor((end - start) / 2_000);
      if (seconds === 0) {
        throw new Error(
          `${repo} has ${String(first.issueCount)} PRs merged within one second at ${searchTime(start)}, more than the search returns`,
        );
      }
      const mid = start + seconds * 1_000;
      // The half called first queues its requests first
      await Promise.all(
        spec.newestFirst === true
          ? [window(mid + 1_000, end), window(start, mid)]
          : [window(start, mid), window(mid + 1_000, end)],
      );
      return;
    }
    let page = first;
    for (;;) {
      signal.throwIfAborted();
      onPage(page.nodes);
      const cursor = page.pageInfo.endCursor;
      if (!page.pageInfo.hasNextPage) break;
      if (cursor === null) throw new Error(`The search of ${repo} has a next page but no cursor`);
      page = await limit(() => searchPage(spec, repo, start, end, cursor));
    }
    onWindow(start, end);
  };
  await window(Math.floor(from / 1_000) * 1_000, Math.floor(to / 1_000) * 1_000);
}

// Saved PRs read again by number, in batches of this many PRs per GraphQL request: the commit counts of PRs saved before
// team_prs held them (37.2), and the timings of PRs whose CI still ran or that were saved before team_pr_timings held
// the slowest run (37.6)
export const PR_BATCH = 100;
export const TIMINGS_BATCH = PR_TIMINGS.page;

// One request for refs, grouped by repo; GitHub resolves the old owner/name of a renamed repo. Aliases are r<i> for the
// i-th repo and p<n> for PR number n
export function prBatchArgs(refs: PrRef[], fields: string): string[] {
  const repos = [...new Set(refs.map((r) => r.repo))];
  const selections = repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    if (owner === undefined || name === undefined) throw new Error(`Not owner/name: ${repo}`);
    const prs = refs
      .filter((r) => r.repo === repo)
      .map((r) => `p${String(r.number)}: pullRequest(number: ${String(r.number)}) { ${fields} }`);
    return `r${String(i)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.join(' ')} }`;
  });
  return ['api', 'graphql', '-f', `query=query { ${selections.join(' ')} }`];
}

export type BatchRead<T> = { ok: true; pr: T } | { ok: false; error: string };

const GraphqlErrors = z
  .array(
    z.object({
      type: z.string().optional(),
      path: z.array(z.union([z.string(), z.number()])).optional(),
      message: z.string(),
    }),
  )
  .optional();

// A repo or PR GitHub cannot find or will not show (NOT_FOUND, FORBIDDEN) is that PR's read error, as a 404 or 403 of
// the REST read is; any other failure (network, authentication, the rate limit) fails the sync, and the next sync reads
// the PRs again. what names the read in the error
export function prBatchFrom<T>(
  refs: PrRef[],
  result: GhResult,
  node: z.ZodType<T>,
  what: string,
): [PrRef, BatchRead<T>][] {
  const repos = [...new Set(refs.map((r) => r.repo))];
  // The query lists every PR, too long for the page: the error names the PRs by repo instead
  const fail = () =>
    new Error(
      `gh api graphql reading ${what} of ${String(refs.length)} PRs of ${repos.join(', ')} exit code ${String(result.exitCode)}: ${[result.stderr.trim(), result.stdout.trim()].filter((s) => s !== '').join('\n')}`,
    );
  if (result.exitCode !== 0 && !result.stdout.trimStart().startsWith('{')) throw fail();
  const { data, errors = [] } = z
    .object({
      data: z.record(z.string(), z.record(z.string(), node.nullable()).nullable()),
      errors: GraphqlErrors,
    })
    .parse(JSON.parse(result.stdout));
  for (const e of errors) {
    if ((e.type !== 'NOT_FOUND' && e.type !== 'FORBIDDEN') || e.path === undefined) throw fail();
  }
  if (result.exitCode !== 0 && errors.length === 0) throw fail();
  const errorAt = (...path: string[]) => {
    const e = errors.find((x) => JSON.stringify(x.path) === JSON.stringify(path));
    return e === undefined ? null : `${String(e.type)}: ${e.message}`;
  };
  return refs.map((ref): [PrRef, BatchRead<T>] => {
    const alias = `r${String(repos.indexOf(ref.repo))}`;
    const field = `p${String(ref.number)}`;
    const repo = data[alias];
    const pr = repo?.[field];
    if (pr != null) return [ref, { ok: true, pr }];
    const error = repo === null ? errorAt(alias) : errorAt(alias, field);
    if (error === null)
      throw new Error(`gh api graphql returned no ${ref.url} and no error for it`);
    return [ref, { ok: false, error }];
  });
}

export type CommitsRead = { ok: true; commits: number } | { ok: false; error: string };

const Commits = z.object({ commits: z.object({ totalCount: z.number() }) });

export async function readCommits(refs: PrRef[]): Promise<[PrRef, CommitsRead][]> {
  const result = await ghResult(prBatchArgs(refs, 'commits { totalCount }'));
  return prBatchFrom(refs, result, Commits, 'the commit counts').map(([ref, read]) => [
    ref,
    read.ok ? { ok: true, commits: read.pr.commits.totalCount } : read,
  ]);
}

export async function readTimings(refs: PrRef[]): Promise<[PrRef, BatchRead<TimedPr>][]> {
  const result = await ghResult(prBatchArgs(refs, PR_TIMINGS.fields));
  return prBatchFrom(refs, result, PR_TIMINGS.node, 'the timings');
}
