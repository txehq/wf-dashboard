import { z } from 'zod';
import { teamSyncStatuses } from '../db/schema.js';
import type { teamSync } from '../db/schema.js';

// API shapes of the Linear stats (Contracts 37.5), shared with the page

export const TeamSyncProgressView = z.object({
  listed: z.number(),
  toRead: z.number(),
  read: z.number(),
  prsRead: z.number(),
  prsSearched: z.number(),
  commitsToRead: z.number(),
  commitsRead: z.number(),
  timingsRead: z.number(),
});

export const TeamSyncView = z.object({
  id: z.number(),
  status: z.enum(teamSyncStatuses),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  // null for a full sync
  updatedAfter: z.number().nullable(),
  progress: TeamSyncProgressView,
  error: z.string().nullable(),
  issues: z.number(),
});
export type TeamSyncView = z.infer<typeof TeamSyncView>;

export function teamSyncView(row: typeof teamSync.$inferSelect): TeamSyncView {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt.getTime(),
    endedAt: row.endedAt?.getTime() ?? null,
    updatedAfter: row.updatedAfter?.getTime() ?? null,
    progress: row.progress,
    error: row.error,
    issues: row.issues,
  };
}

// The latest sync (running, or how the last one ended) and the last one that succeeded
export const TeamSyncState = z.object({
  latest: TeamSyncView.nullable(),
  lastSucceeded: TeamSyncView.nullable(),
});
export type TeamSyncState = z.infer<typeof TeamSyncState>;

// A person is a Linear user id, or "unassigned" for issues without an assignee (or a creator)
export const UNASSIGNED = 'unassigned';

export const Person = z.object({ key: z.string(), name: z.string() });
export type Person = z.infer<typeof Person>;

// Durations are in ms; a spread is over the PRs or issues that have the duration, null with none (37.6, 37.7)
export const Spread = z
  .object({ mean: z.number(), median: z.number(), p90: z.number(), count: z.number() })
  .nullable();
export type Spread = z.infer<typeof Spread>;

// How long the issues completed in the range took from their first start, and from their creation (37.7)
export const TimeToComplete = z.object({ started: Spread, created: Spread });
export type TimeToComplete = z.infer<typeof TimeToComplete>;

// The closed issues of the range (37.7): issues completed (done but not closed included) and canceled in it
export const CloseTimes = z.object({
  completed: z.number(),
  ...TimeToComplete.shape,
  canceled: z.number(),
  createdToCanceled: Spread,
});
export type CloseTimes = z.infer<typeof CloseTimes>;

const Counts = {
  handled: z.number(),
  created: z.number(),
  completed: z.number(),
  canceled: z.number(),
  // Merged PRs linked to an issue, on its assignee; additions and deletions are theirs (37.3)
  prsMerged: z.number(),
  additions: z.number(),
  deletions: z.number(),
  // Merged PRs the person authored, linked to an issue or not
  prsAuthored: z.number(),
  // Commits of the same two sets of PRs; a PR whose commit count is not read yet is left out of the sum and counted as
  // unread instead
  commits: z.number(),
  commitsUnread: z.number(),
  commitsAuthored: z.number(),
  commitsAuthoredUnread: z.number(),
};

// A person's GitHub account (37.3): the login Linear attributes their PRs to, or else the most common author of the
// merged PRs linked to their issues; without one, why there is none
export const GithubAccount = z.union([
  z.object({ login: z.string(), source: z.enum(['linear', 'prs']) }),
  z.object({ login: z.null(), reason: z.string() }),
]);
export type GithubAccount = z.infer<typeof GithubAccount>;

export const PersonStats = z.object({
  ...Person.shape,
  ...Counts,
  // null without a GitHub account
  prsAuthored: z.number().nullable(),
  commitsAuthored: z.number().nullable(),
  github: GithubAccount,
  handledPerDay: z.number(),
  // Of completed: issues done but not closed (37.3)
  doneNotClosed: z.number(),
  openInProgress: z.number(),
  timeToComplete: TimeToComplete,
});
export type PersonStats = z.infer<typeof PersonStats>;

// One person on one day; days with nothing are left out
export const DayCell = z.object({ person: z.string(), day: z.string(), ...Counts });
export type DayCell = z.infer<typeof DayCell>;

export const PrProblem = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  error: z.string(),
  readAt: z.number(),
  issues: z.array(z.string()),
});
export type PrProblem = z.infer<typeof PrProblem>;

export const IsoDay = z.iso.date();

export const TeamStats = z.object({
  team: z.string(),
  timezone: z.string(),
  from: IsoDay,
  to: IsoDay,
  // Today in the timezone, and the day of the earliest issue (null before the first sync)
  today: IsoDay,
  firstDay: IsoDay.nullable(),
  days: z.array(IsoDay),
  // Everyone with an issue, for the people filter
  everyone: z.array(Person),
  people: z.array(PersonStats),
  closeTimes: CloseTimes,
  daily: z.array(DayCell),
  prProblems: z.array(PrProblem),
});
export type TeamStats = z.infer<typeof TeamStats>;

export const TeamIssuePr = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  state: z.enum(['open', 'closed']).nullable(),
  draft: z.boolean().nullable(),
  mergedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  error: z.string().nullable(),
});
export type TeamIssuePr = z.infer<typeof TeamIssuePr>;

export const TeamIssueRow = z.object({
  identifier: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  assignee: Person,
  creator: Person,
  status: z.string(),
  statusType: z.string(),
  createdAt: z.number(),
  // Linear's completedAt, or for an issue done but not closed its latest merged PR (37.3)
  completedAt: z.number().nullable(),
  canceledAt: z.number().nullable(),
  doneNotClosed: z.boolean(),
  // From the creation and from the first start to the completion or cancellation; null while open, for an issue never
  // started (startedToClosed) and for reversed times (37.7)
  createdToClosed: z.number().nullable(),
  startedToClosed: z.number().nullable(),
  prs: z.array(TeamIssuePr),
  // What the issue counts for in the selection
  handled: z.boolean(),
  created: z.boolean(),
  completed: z.boolean(),
  canceled: z.boolean(),
});
export type TeamIssueRow = z.infer<typeof TeamIssueRow>;

export const TeamIssues = z.object({ issues: z.array(TeamIssueRow) });
export type TeamIssues = z.infer<typeof TeamIssues>;

// txe PR timings (Contracts 37.6)
const Spreads = { openToMerge: Spread, readyToMerge: Spread, ci: Spread };

// A PR is slow CI when its CI took this long or longer
export const SLOW_CI_MS = 25 * 60_000;

export const PrTimingDay = z.object({
  day: IsoDay,
  prs: z.number(),
  // Of prs: PRs with slow CI
  slowCi: z.number(),
  ...Spreads,
});
export type PrTimingDay = z.infer<typeof PrTimingDay>;

export const PrTimingAuthor = z.object({
  key: z.string(),
  name: z.string(),
  prs: z.number(),
  slowCi: z.number(),
  ...Spreads,
});
export type PrTimingAuthor = z.infer<typeof PrTimingAuthor>;

export const PrTimingRow = z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  // The author's login (null for a deleted account) and the person it maps to (37.3), if any
  author: z.string().nullable(),
  person: z.string().nullable(),
  // The key of the author's entry in people: the person's key, or the login's for an author no person maps to
  authorKey: z.string(),
  day: IsoDay,
  createdAt: z.number(),
  // null when the PR never was a draft
  readyAt: z.number().nullable(),
  mergedAt: z.number(),
  // Each duration is null when GitHub's recorded times are reversed (the end before the start), and CI also without
  // runs or while a run still goes (ciRunning)
  openToMerge: z.number().nullable(),
  readyToMerge: z.number().nullable(),
  ci: z.number().nullable(),
  ciStartedAt: z.number().nullable(),
  ciEndedAt: z.number().nullable(),
  ciRunning: z.boolean(),
  ciRuns: z.number(),
  ciAllSucceeded: z.boolean().nullable(),
  // CI of SLOW_CI_MS or longer
  slowCi: z.boolean(),
  // The longest workflow run counted in CI (createdAt to updatedAt) and whether it ended after the merge; null without
  // runs, or for a PR whose timings were read before the slowest run was kept and are not read again yet
  slowest: z
    .object({ workflow: z.string(), duration: z.number(), afterMerge: z.boolean() })
    .nullable(),
});
export type PrTimingRow = z.infer<typeof PrTimingRow>;

export const TeamPrTimings = z.object({
  repo: z.string(),
  timezone: z.string(),
  from: IsoDay,
  to: IsoDay,
  days: z.array(IsoDay),
  // Over the whole range
  summary: z.object({ prs: z.number(), slowCi: z.number(), ...Spreads }),
  daily: z.array(PrTimingDay),
  // Each author of the range's PRs: a person, or a login no person maps to, named by the login; most PRs first
  people: z.array(PrTimingAuthor),
  // The PRs of the selected day, or of the range; longest open to merge first
  prs: z.array(PrTimingRow),
  // The sync reads the timings newest first: every PR merged from fetchedFrom (ms) to the newest read window is in;
  // null before the first window is read. fetched: the range is covered from its first day
  fetchedFrom: z.number().nullable(),
  fetched: z.boolean(),
});
export type TeamPrTimings = z.infer<typeof TeamPrTimings>;
