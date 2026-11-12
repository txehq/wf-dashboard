import { queryOptions, useQueryClient } from '@tanstack/react-query';
import {
  type WorkspaceAgainst,
  WorkspaceDiffView,
  type WorkspaceEvent,
  WorkspaceFileView,
  type WorkspaceFileStatus,
  type WorkspaceStageStatus,
  WorkspaceView,
} from '@wf-dashboard/server/drafts/views';
import { useEffect, useRef } from 'react';
import { requestJson } from '@/lib/http';

// Matches the API of Contracts 26.4 (the workflow panel of design and optimize sessions)
export type { WorkspaceAgainst, WorkspaceEvent, WorkspaceFileStatus, WorkspaceStageStatus };
export type Workspace = WorkspaceView;
export type WorkspaceFile = WorkspaceFileView;

// What "Compare" can compare against (28.4): base (absent for a blank start), last saved, previous version, in this
// order; missing ones are not listed
export interface AgainstOption {
  value: WorkspaceAgainst;
  label: string;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

export function againstOptions(workspace: Pick<Workspace, 'base' | 'against'>): AgainstOption[] {
  const { saved, previous } = workspace.against;
  return [
    ...(workspace.base === null ? [] : [{ value: 'base' as const, label: 'Base' }]),
    ...(saved === null
      ? []
      : [{ value: 'saved' as const, label: `Last saved ${clock(saved.at)}` }]),
    ...(previous === null
      ? []
      : [{ value: 'previous' as const, label: `Previous version ${clock(previous.at)}` }]),
  ];
}

// Use the stored choice while it is still available, otherwise the first available one; null when there is none
export const chosenAgainst = (
  options: readonly AgainstOption[],
  stored: WorkspaceAgainst,
): WorkspaceAgainst | null =>
  options.find((o) => o.value === stored)?.value ?? options[0]?.value ?? null;

const pathQuery = (path: string) => `?path=${encodeURIComponent(path)}`;

export const workspaceQuery = (liveId: string) =>
  queryOptions({
    queryKey: ['workspace', liveId],
    queryFn: async () =>
      WorkspaceView.parse(await requestJson('GET', `/api/live/${liveId}/workspace`)),
  });

export const workspaceFileQuery = (liveId: string, path: string) =>
  queryOptions({
    queryKey: ['workspace', liveId, 'file', path],
    queryFn: async () =>
      WorkspaceFileView.parse(
        await requestJson('GET', `/api/live/${liveId}/workspace/file${pathQuery(path)}`),
      ),
  });

export const workspaceDiffQuery = (liveId: string, path: string, against: WorkspaceAgainst) =>
  queryOptions({
    queryKey: ['workspace', liveId, 'diff', path, against],
    queryFn: async () =>
      WorkspaceDiffView.parse(
        await requestJson(
          'GET',
          `/api/live/${liveId}/workspace/diff${pathQuery(path)}&against=${against}`,
        ),
      ),
  });

const EVENT_TYPES = ['changed', 'closed', 'failed'] as const;

// Watch this item's working directory (SSE): on every connect (including reconnects) refresh the panel's queries first
// to pick up changes made while disconnected; close the connection after closed or failed and do not reconnect
export function useWorkspaceEvents(liveId: string, onEvent: (event: WorkspaceEvent) => void) {
  const client = useQueryClient();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    const source = new EventSource(`/api/live/${liveId}/workspace/events`);
    source.addEventListener('ready', () => {
      void client.invalidateQueries({ queryKey: ['workspace', liveId] });
    });
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as WorkspaceEvent;
        if (event.type !== 'changed') source.close();
        handler.current(event);
      });
    }
    return () => {
      source.close();
    };
  }, [client, liveId]);
}
