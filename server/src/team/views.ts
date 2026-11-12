import { z } from 'zod';
import { teamSyncStatuses } from '../db/schema.js';
import type { teamSync } from '../db/schema.js';

// API shapes of the Linear stats (Contracts 37.5), shared with the page

export const TeamSyncProgressView = z.object({
  listed: z.number(),
  toRead: z.number(),
  read: z.number(),
  prsRead: z.number(),
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

const Counts = {
  handled: z.number(),
  created: z.number(),
  completed: z.number(),
  canceled: z.number(),
  prsMerged: z.number(),
  additions: z.number(),
  deletions: z.number(),
};

export const PersonStats = z.object({
  ...Person.shape,
  ...Counts,
  handledPerDay: z.number(),
  // Of completed: issues done but not closed (37.3)
  doneNotClosed: z.number(),
  openInProgress: z.number(),
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
