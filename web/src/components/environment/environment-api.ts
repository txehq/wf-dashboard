import { queryOptions, useQuery } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';
import { settingsQuery } from '@/lib/runs-api';

// 与 Contracts 第 8 节的 GET /api/environment 对应（server/src/environment.ts）
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

// 键带上当前的角色模型：Settings 保存后重新请求，服务端发现模型变化会重新检查
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
