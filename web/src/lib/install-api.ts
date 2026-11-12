import { queryOptions, useQuery } from '@tanstack/react-query';
import type { InstallView } from '@wf-dashboard/server/install/views';
import { requestJson } from '@/lib/http';

// GET /api/install (Contracts 39.4): the installed version and its self-update; installed false from a git checkout
export type { InstallView };

export const installQuery = queryOptions({
  queryKey: ['install'],
  queryFn: async () => (await requestJson('GET', '/api/install')) as InstallView,
});

export const useInstall = () => useQuery(installQuery);
