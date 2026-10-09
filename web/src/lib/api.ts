import { queryOptions } from '@tanstack/react-query';

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} 返回 ${String(response.status)}`);
  return response.json();
}

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: async () => (await getJson('/api/health')) as { status: 'ok' },
});
