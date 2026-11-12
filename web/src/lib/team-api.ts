import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  DayCell,
  Person,
  PersonStats,
  PrProblem,
  TeamIssuePr,
  TeamIssueRow,
  TeamIssues,
  TeamStats,
  TeamSyncState,
  TeamSyncView,
} from '@wf-dashboard/server/team/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// Linear stats (Contracts 37.5)
export type {
  DayCell,
  Person,
  PersonStats,
  PrProblem,
  TeamIssuePr,
  TeamIssueRow,
  TeamStats,
  TeamSyncState,
  TeamSyncView,
};

export interface StatsQuery {
  from: string | null;
  to: string | null;
  // Person keys; empty is everyone
  people: string[];
}

const search = (params: Record<string, string | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== '') s.set(k, v);
  const q = s.toString();
  return q === '' ? '' : `?${q}`;
};

export const teamStatsQuery = (q: StatsQuery) =>
  queryOptions({
    queryKey: ['team', 'stats', q],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/team/stats${search({ from: q.from, to: q.to, people: q.people.join(',') })}`,
      )) as TeamStats,
  });

export interface IssuesQuery extends StatsQuery {
  person: string | null;
  day: string | null;
  doneNotClosed: boolean;
}

export const teamIssuesQuery = (q: IssuesQuery) =>
  queryOptions({
    queryKey: ['team', 'issues', q],
    queryFn: async () =>
      (
        (await requestJson(
          'GET',
          `/api/team/issues${search({
            from: q.from,
            to: q.to,
            people: q.people.join(','),
            person: q.person,
            day: q.day,
            doneNotClosed: q.doneNotClosed ? '1' : null,
          })}`,
        )) as TeamIssues
      ).issues,
  });

export const teamSyncQuery = queryOptions({
  queryKey: ['team', 'sync'],
  queryFn: async () => (await requestJson('GET', '/api/team/sync')) as TeamSyncState,
});

export async function startTeamSync(): Promise<TeamSyncView> {
  return (await requestJson('POST', '/api/team/sync')) as TeamSyncView;
}

// team.sync: progress updates the sync state in place; when a sync ends the stats and lists are read again
export function useTeamSyncEvents() {
  const client = useQueryClient();
  useLiveEvent((type, data) => {
    if (type !== 'team.sync') return;
    const event = data as Pick<TeamSyncView, 'status' | 'progress'> & { syncId: number };
    if (event.status === 'running') {
      // The counts follow a long sync every few seconds
      invalidateThrottled(client, ['team', 'stats'], 5_000);
      client.setQueryData(teamSyncQuery.queryKey, (state) =>
        state?.latest?.id === event.syncId
          ? { ...state, latest: { ...state.latest, progress: event.progress } }
          : state,
      );
      // A new sync's first event: read its row
      if (client.getQueryData(teamSyncQuery.queryKey)?.latest?.id !== event.syncId) {
        void client.invalidateQueries({ queryKey: teamSyncQuery.queryKey });
      }
      return;
    }
    void client.invalidateQueries({ queryKey: ['team'] });
  });
}
