import { queryOptions, useQuery } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';
import { settingsQuery } from '@/lib/runs-api';

// GET /api/environment, Contracts 8 (server/src/environment.ts)
export interface EnvironmentCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export interface EnvironmentReport {
  checkedAt: number;
  checks: EnvironmentCheck[];
}

async function getReport(refresh: boolean): Promise<EnvironmentReport> {
  const url = refresh ? '/api/environment?refresh=1' : '/api/environment';
  return (await requestJson('GET', url)) as EnvironmentReport;
}

// The key includes the current role models: saving Settings refetches, and the server re-checks when models change
const environmentQuery = (modelsKey: string) =>
  queryOptions({
    queryKey: ['environment', modelsKey],
    queryFn: () => getReport(false),
    staleTime: 10 * 60_000,
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
