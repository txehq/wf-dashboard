import { queryOptions } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: async () => (await requestJson('GET', '/api/health')) as { status: 'ok' },
});
