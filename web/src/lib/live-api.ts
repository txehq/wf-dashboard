import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLiveBody,
  LiveDetail,
  LiveSummary,
  LocalEntries,
  OrcaRunView,
  OrcaTopology,
  ResumeDefaults,
  ResumeLiveBody,
  ResumePlan,
  WorkerSendResult,
  WorkerTranscript,
} from '@wf-dashboard/server/live/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import type { Variant } from '@/pages/variants-api';

// Matches the interaction API in Contracts section 14
export type {
  CreateLiveBody,
  LiveDetail,
  LiveSummary,
  OrcaRunView,
  OrcaTopology,
  ResumeDefaults,
  ResumeLiveBody,
  ResumePlan,
  WorkerTranscript,
};
export type WorkerTurn = WorkerTranscript['turns'][number];
export type LiveDriver = LiveSummary['driver'];

// Interactions use only variants built from their current content
export const isBuiltVariant = (v: Variant) =>
  v.buildStatus === 'built' && v.builtHash === v.skillsHash;

// Items in the workspace; closed ones are listed only with includeHidden
export function liveListQuery(includeHidden: boolean) {
  return queryOptions({
    queryKey: ['live', 'list', includeHidden],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live?includeHidden=${String(includeHidden)}`,
      )) as LiveSummary[],
  });
}

export function liveQuery(id: string) {
  return queryOptions({
    queryKey: ['live', id],
    queryFn: async () => (await requestJson('GET', `/api/live/${id}`)) as LiveDetail,
  });
}

export function resumeDefaultsQuery(sessionId: string) {
  return queryOptions({
    queryKey: ['live', 'resume-defaults', sessionId],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live/resume-defaults?sessionId=${encodeURIComponent(sessionId)}`,
      )) as ResumeDefaults,
  });
}

export async function createLive(body: CreateLiveBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/live', body)) as LiveDetail;
}

// Entry commands available with local config (Contracts 29.2): workflows whose entry skill is installed locally
export const localEntriesQuery = queryOptions({
  queryKey: ['live', 'local-entries'],
  queryFn: async () => (await requestJson('GET', '/api/live/local-entries')) as LocalEntries,
});

export async function resumeLive(body: ResumeLiveBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/live/resume', body)) as LiveDetail;
}

// Resume preflight (Contracts 14.5): explains what will happen as soon as the dialog opens or the
// config changes; an empty variantId means local config
export function resumePlanQuery(sessionId: string, variantId: string | null) {
  return queryOptions({
    queryKey: ['live', 'resume-plan', sessionId, variantId],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live/resume-plan?sessionId=${encodeURIComponent(sessionId)}&variantId=${encodeURIComponent(variantId ?? '')}`,
      )) as ResumePlan,
  });
}

// Driver switch (Contracts 34.2): an item without a task records its goal the first time it is handed
// to the simulated user
export async function setLiveDriver(
  id: string,
  driver: LiveDriver,
  goal?: string,
): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/driver`, {
    driver,
    ...(goal === undefined ? {} : { goal }),
  })) as LiveDetail;
}

// Change the simulated user's goal from the toolbar (Contracts 34.2)
export async function setLiveGoal(id: string, goal: string): Promise<LiveDetail> {
  return (await requestJson('PUT', `/api/live/${id}/goal`, { goal })) as LiveDetail;
}

// A page button ends the process: the stop event records the page as its source
export async function stopLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/stop`, { source: 'page' })) as LiveDetail;
}

// Rename (Contracts 14.3): the server reports blank names and names over 200 characters with its own message
export async function renameLive(id: string, title: string): Promise<LiveDetail> {
  return (await requestJson('PATCH', `/api/live/${id}`, { title })) as LiveDetail;
}

// Import into the workspace (Contracts 14.5): creates items only, starts no process; closed items are restored
export async function importLive(sessionIds: string[]): Promise<LiveSummary[]> {
  return (await requestJson('POST', '/api/live/import', { sessionIds })) as LiveSummary[];
}

// Close ("×"), restore and delete (Contracts 14.5)
export async function hideLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/hide`)) as LiveDetail;
}

export async function unhideLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/unhide`)) as LiveDetail;
}

export async function deleteLive(id: string, confirmTitle: string): Promise<void> {
  await requestJson('DELETE', `/api/live/${id}`, { confirmTitle });
}

// The "Live" button on the Sessions page: restores and uses the existing item (closed ones included),
// otherwise imports a new one; returns that item's id
export async function openInLive(session: { id: string; liveId: string | null }): Promise<string> {
  if (session.liveId !== null) return (await unhideLive(session.liveId)).id;
  const [item] = await importLive([session.id]);
  if (item === undefined) throw new Error(`Importing session ${session.id} returned no item`);
  return item.id;
}

// Orca collaboration topology (Contracts 35.3): the server's latest sync, refreshed by orca.updated
export const orcaTopologyQuery = queryOptions({
  queryKey: ['live', 'orca'],
  queryFn: async () => (await requestJson('GET', '/api/live/orca')) as OrcaTopology,
});

// The sync the drawer starts when it opens. It sits outside the ['live'] keys, so the orca.updated it causes does not
// start it again; it is dropped when the drawer closes, so the next opening syncs once more
export const orcaSyncOnOpenQuery = queryOptions({
  queryKey: ['orca-sync-on-open'],
  queryFn: async () => (await requestJson('GET', '/api/live/orca?sync=true')) as OrcaTopology,
  staleTime: Infinity,
  gcTime: 0,
});

// A worker Orca runs without a pane (Contracts 35.4): one page of its transcript after cursor (from the start
// when null), and input sent to it as a message to its Dispatch
export async function readWorker(id: string, cursor: string | null): Promise<WorkerTranscript> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return (await requestJson('GET', `/api/live/${id}/worker${query}`)) as WorkerTranscript;
}

export async function sendToWorker(id: string, text: string): Promise<WorkerSendResult> {
  return (await requestJson('POST', `/api/live/${id}/worker/send`, { text })) as WorkerSendResult;
}

// live.updated and orca.updated: refresh the interaction list, each session's detail and the topology
// (all queries under the ['live'] prefix)
export function useLiveSessionEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'live.updated' && type !== 'orca.updated') return;
    invalidateThrottled(client, ['live'], 300);
  });
}
