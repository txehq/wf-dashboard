import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  OrcaGraph,
  OrcaGraphEdge,
  OrcaGraphMessage,
  OrcaGraphNode,
} from '@wf-dashboard/server/live/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// The Orca topology page (Contracts 40)
export type { OrcaGraph, OrcaGraphEdge, OrcaGraphMessage, OrcaGraphNode };

// The server's latest sync, refreshed by orca.updated
export const orcaGraphQuery = queryOptions({
  queryKey: ['orca', 'graph'],
  queryFn: async () => (await requestJson('GET', '/api/orca/graph')) as OrcaGraph,
});

// The sync the page starts when it opens; outside the ['orca'] keys, so the orca.updated it causes does not start it
// again, and dropped when the page closes, so the next visit syncs once more
export const orcaSyncOnOpenQuery = queryOptions({
  queryKey: ['orca-graph-sync-on-open'],
  queryFn: async () => (await requestJson('GET', '/api/orca/graph?sync=true')) as OrcaGraph,
  staleTime: Infinity,
  gcTime: 0,
});

// Every message between the nodes in a and the nodes in b, oldest first
export function orcaMessagesQuery(a: string[], b: string[]) {
  return queryOptions({
    queryKey: ['orca', 'messages', a, b],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/orca/messages?a=${encodeURIComponent(a.join(','))}&b=${encodeURIComponent(b.join(','))}`,
      )) as OrcaGraphMessage[],
  });
}

// "Open in Orca": the desktop Orca switches to the terminal
export const switchOrcaTerminal = (handle: string, hostId: string | null) =>
  requestJson('POST', '/api/orca/switch', { handle, hostId });

// "Open in Live": the node's Live item, imported from its session record when it has none yet
export const openOrcaNodeInLive = async (nodeId: string) =>
  ((await requestJson('POST', '/api/orca/open-live', { nodeId })) as { liveId: string }).liveId;

// orca.updated and live.updated (titles, states and costs of the Live items behind the nodes) refresh the page
export function useOrcaGraphEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'orca.updated' && type !== 'live.updated') return;
    invalidateThrottled(client, ['orca'], 500);
  });
}
