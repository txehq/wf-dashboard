import { queryOptions, useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@/lib/format';
import { requestJson } from '@/lib/http';
import { settingsQuery } from '@/lib/runs-api';

// GET /api/environment, Contracts 8 (server/src/environment.ts)
export interface EnvironmentCheck {
  id: string;
  label: string;
  ok: boolean;
  state: 'ok' | 'failed' | 'unverified';
  checkedAt: number | null;
  detail: string;
  fix: string;
}

export interface EnvironmentReport {
  checkedAt: number;
  checks: EnvironmentCheck[];
}

// The paid checks and their short names: set by real use, "Recheck" and the operations that need them, never by
// reading
const PAID_CHECKS = new Map([
  ['model-simulated-user', 'Simulated user'],
  ['model-judge', 'Judge'],
  ['codex', 'Codex'],
]);

export const paidName = (check: EnvironmentCheck) => PAID_CHECKS.get(check.id);

// "Last verified 11/19, 14:05" or "Unverified" for a paid check
export function verifiedText(check: EnvironmentCheck): string {
  if (check.state === 'unverified' || check.checkedAt === null) return 'Unverified';
  const at = formatDateTime(new Date(check.checkedAt).toISOString());
  return check.state === 'ok' ? `Last verified ${at}` : `Failed ${at}`;
}

async function getReport(refresh: boolean): Promise<EnvironmentReport> {
  const url = refresh ? '/api/environment?refresh=1' : '/api/environment';
  return (await requestJson('GET', url)) as EnvironmentReport;
}

// The key includes the current role models: saving Settings refetches, and the paid check of a changed model reads as
// unverified. No refetch on window focus; environment.updated events refetch when a paid check changes
const environmentQuery = (modelsKey: string) =>
  queryOptions({
    queryKey: ['environment', modelsKey],
    queryFn: () => getReport(false),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

export function useEnvironment() {
  const settings = useQuery(settingsQuery);
  const modelsKey = settings.data === undefined ? null : JSON.stringify(settings.data.models);
  return {
    query: useQuery({
      ...environmentQuery(modelsKey ?? ''),
      enabled: modelsKey !== null,
    }),
    queryKey: environmentQuery(modelsKey ?? '').queryKey,
  };
}

export function refreshEnvironment(): Promise<EnvironmentReport> {
  return getReport(true);
}
