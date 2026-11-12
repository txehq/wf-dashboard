import { queryOptions, useQuery } from '@tanstack/react-query';
import type { VscodeOpenResult, VscodeServerView } from '@wf-dashboard/server/vscode/views';
import { requestJson } from '@/lib/http';

// VS Code for the web (Contracts section 32)
export type { VscodeOpenResult, VscodeServerView };

export const LOCAL_SERVER_ID = 'local';

export const listVscodeServers = async () =>
  (await requestJson('GET', '/api/vscode/servers')) as VscodeServerView[];

// The list is read again on vscode.servers events (live-events.ts)
export const vscodeServersQuery = queryOptions({
  queryKey: ['vscode', 'servers'],
  queryFn: listVscodeServers,
});

export const useVscodeServers = () => useQuery(vscodeServersQuery);

export const openVscode = async (liveId: string) =>
  (await requestJson('POST', '/api/vscode/open', { liveId })) as VscodeOpenResult;

export const stopVscodeServer = (id: string) =>
  requestJson('DELETE', `/api/vscode/servers/${encodeURIComponent(id)}`);

// The page opened in a new tab: opened on click (so the browser does not block it), replaced by the VS Code address once ready
export const vscodeOpenPath = (liveId: string) => `/vscode-open/${encodeURIComponent(liveId)}`;

const MB = 1024 * 1024;

const percentOf = (server: VscodeServerView) =>
  server.received === null || server.total === null
    ? null
    : Math.floor((server.received / server.total) * 100);

// Progress beside the toolbar button: a word or two so the toolbar does not wrap; the full sentence is in the tooltip and the new tab
export function shortProgressText(server: VscodeServerView): string {
  switch (server.phase) {
    case 'downloading': {
      const percent = percentOf(server);
      return percent === null ? 'Downloading' : `Downloading ${String(percent)}%`;
    }
    case 'extracting':
      return 'Extracting';
    case 'uploading':
      return 'Copying';
    case 'starting':
      return 'Starting';
    case 'forwarding':
      return 'Connecting';
    case 'checking':
    case null:
      return 'Checking version';
  }
}

// Preparation progress in one sentence, shared by the button, the new tab and Settings
export function progressText(server: VscodeServerView): string {
  if (server.status === 'failed') return 'Failed to start';
  if (server.status === 'unreachable')
    return 'Unreachable; the server may or may not still be running';
  if (server.status === 'running') return 'Running';
  switch (server.phase) {
    case 'downloading': {
      if (server.received === null) return 'Downloading';
      const received = (server.received / MB).toFixed(0);
      const percent = percentOf(server);
      if (server.total === null || percent === null) return `Downloading ${received} MB`;
      return `Downloading ${String(percent)}% (${received} / ${(server.total / MB).toFixed(0)} MB)`;
    }
    case 'extracting':
      return 'Extracting';
    case 'uploading':
      return `Copying to ${server.machine}`;
    case 'starting':
      return 'Starting';
    case 'forwarding':
      return `Connecting to ${server.machine}`;
    case 'checking':
    case null:
      return 'Checking the version';
  }
}
