import { z } from 'zod';
import { callLinear, listAll } from '../external/linear.js';

// Linear reads of the stats sync (Contracts 37.2), every response validated

const ListedIssue = z.object({ id: z.string(), updatedAt: z.iso.datetime() });
export type ListedIssue = z.infer<typeof ListedIssue>;

const IssuePage = z.object({
  issues: z.array(ListedIssue),
  hasNextPage: z.boolean(),
  cursor: z.string().optional(),
});

// The listing asks only for what decides whether an issue is read again. scope holds extra list_issues filters (tests
// list one epic's children with parentId); the stats sync passes none
export function listIssuesArgs(
  team: string,
  scope: Record<string, unknown>,
  updatedAfter: Date | null,
  cursor?: string,
) {
  return {
    team,
    ...scope,
    includeArchived: true,
    orderBy: 'updatedAt',
    limit: 250,
    fields: ['id', 'updatedAt'],
    ...(updatedAfter === null ? {} : { updatedAt: updatedAfter.toISOString() }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

// Every issue of the team, or those updated after updatedAfter; onPage reports the running count
export async function listTeamIssues(
  team: string,
  scope: Record<string, unknown>,
  updatedAfter: Date | null,
  onPage: (listed: number) => void,
  signal: AbortSignal,
): Promise<ListedIssue[]> {
  const issues: ListedIssue[] = [];
  let cursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await callLinear(
      'list_issues',
      listIssuesArgs(team, scope, updatedAfter, cursor),
      IssuePage,
    );
    issues.push(...page.issues);
    onPage(issues.length);
    if (!page.hasNextPage) return issues;
    if (page.cursor === undefined)
      throw new Error('Linear list_issues hasNextPage is true but there is no cursor');
    cursor = page.cursor;
  }
}

export const ISSUE_FIELDS = [
  'uuid',
  'title',
  'url',
  'status',
  'statusType',
  'assignee',
  'assigneeId',
  'createdBy',
  'createdById',
  'createdAt',
  'startedAt',
  'completedAt',
  'canceledAt',
  'updatedAt',
  'archivedAt',
  'stateHistory',
  'attachments',
];

const Time = z.iso.datetime();
const TeamIssue = z.object({
  // The identifier (TXE-123); the database id is uuid
  id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  uuid: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  statusType: z.string(),
  assignee: z.string().nullable(),
  assigneeId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: Time,
  startedAt: Time.nullable(),
  completedAt: Time.nullable(),
  canceledAt: Time.nullable(),
  updatedAt: Time,
  archivedAt: Time.nullable(),
  stateHistory: z.array(
    z.object({
      state: z.object({ name: z.string(), type: z.string() }),
      startedAt: Time,
      endedAt: Time.nullable(),
    }),
  ),
  attachments: z.array(z.object({ url: z.string() })),
});
export type TeamIssue = z.infer<typeof TeamIssue>;

export function readTeamIssue(identifier: string): Promise<TeamIssue> {
  return callLinear('get_issue', { id: identifier, fields: ISSUE_FIELDS }, TeamIssue);
}

const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  isActive: z.boolean(),
});
export type TeamUser = z.infer<typeof User>;

export function listTeamUsers(): Promise<TeamUser[]> {
  return listAll('list_users', { limit: 250 }, 'users', User);
}
