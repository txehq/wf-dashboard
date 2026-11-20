import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { refetchBuildLog } from '@/pages/variants-api';

// One /api/events connection shared by the page (W15 H11):
// - on every connect (reconnects included) the server first sends ready, which refreshes all queries
//   (except failed ones) to catch up on changes missed while disconnected;
// - when the connection is closed (e.g. the Vite proxy returns 502 during a server restart and
//   EventSource stops retrying by itself), it is rebuilt with backoff;
// - the connection status lets the layout show that the live connection was lost.
// Pages subscribe to the events they care about with useLiveEvent

export type LiveStatus = 'connecting' | 'open' | 'lost';

const EVENT_TYPES = [
  'session.updated',
  'stage.changed',
  'run.status',
  'run.message',
  'run.pending',
  'run.stage',
  'run.artifact',
  'run.cost',
  'variant.build',
  'variant.updated',
  'variant.deleted',
  'workflow.deleted',
  'workflow.release',
  'live.updated',
  'orca.updated',
  'draft.updated',
  'analysis.updated',
  'magi.updated',
  'magi.deploy',
  'ssh-hosts.updated',
  'team.sync',
  'install.updated',
  'environment.updated',
] as const;
export type LiveEventType = (typeof EVENT_TYPES)[number];

type Handler = (type: LiveEventType, data: unknown) => void;

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

let status: LiveStatus = 'connecting';
const statusListeners = new Set<() => void>();
const handlers = new Set<Handler>();

function setStatus(next: LiveStatus) {
  status = next;
  for (const l of statusListeners) l();
}

// Full refresh (SSE ready, variant.updated): failed queries are not requested again; only the page's
// "Retry" recovers them (same rule as variants-api.ts, which does not repeat failed requests automatically)
export function refreshAllExceptFailed(client: QueryClient) {
  void client.invalidateQueries({ predicate: (query) => query.state.status !== 'error' });
}

// Opens the connection and returns a close function. Mounted once by the layout
export function connectLiveEvents(client: QueryClient, url = '/api/events'): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = RETRY_MIN_MS;
  let closed = false;
  const open = () => {
    const s = new EventSource(url);
    source = s;
    s.addEventListener('ready', () => {
      delay = RETRY_MIN_MS;
      setStatus('open');
      refreshAllExceptFailed(client);
    });
    s.addEventListener('error', () => {
      if (closed) return;
      setStatus('lost');
      // CONNECTING: the browser reconnects by itself; CLOSED: it will not retry, so rebuild here
      if (s.readyState === EventSource.CLOSED) {
        s.close();
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    });
    for (const type of EVENT_TYPES) {
      s.addEventListener(type, (event: MessageEvent<string>) => {
        const data: unknown = JSON.parse(event.data);
        for (const h of handlers) h(type, data);
      });
    }
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}

export const liveStatus = () => status;

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore((listener) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  }, liveStatus);
}

// Subscribe to events; handler may differ on each render, the latest one is called
export function useLiveEvent(handler: Handler) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const h: Handler = (type, data) => {
      latest.current(type, data);
    };
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, []);
}

// A query key refreshes at most once per ms window (at the end of the window, picking up its last change):
// during long runs session.updated fires several times a second, and creating a batch sends dozens of run.status at once
const pending = new Map<string, ReturnType<typeof setTimeout>>();

// Run work at most once per ms for the same key (at the end of the window)
export function throttled(key: string, ms: number, work: () => void) {
  if (pending.has(key)) return;
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      work();
    }, ms),
  );
}

export function invalidateThrottled(client: QueryClient, queryKey: QueryKey, ms: number) {
  throttled(JSON.stringify(queryKey), ms, () => {
    void client.invalidateQueries({ queryKey });
  });
}

// Mounted by the layout: opens the connection. variant.build refreshes the variant list and that
// variant's detail and build log (so the status is current when returning to Variants, and the Runs
// start list offers the variant once built). File contents are not refreshed; unsaved edits are kept.
// variant.updated (renamed, overwritten or restored, Contracts 16.4, 17.4): variant names and statuses
// appear in queries on many pages (Workflows, Sessions bindings, Live, Runs, Compare, Analyses, drafts,
// History), so everything is re-read (except failed queries); the editor reads content only when a file
// opens, so unsaved edits are kept.
// variant.deleted and workflow.deleted (Contracts 24.6) also re-read everything: deleted items leave the
// lists, and kept records show them as deleted.
// workflow.release re-reads the workflow and variant lists
export function useLiveConnection() {
  const client = useQueryClient();
  useEffect(() => connectLiveEvents(client), [client]);
  useLiveEvent((type, data) => {
    if (type === 'variant.updated' || type === 'variant.deleted' || type === 'workflow.deleted') {
      refreshAllExceptFailed(client);
      return;
    }
    // workflow.release (Contracts 29.1): the latest release's check results changed or a variant was auto-imported
    if (type === 'workflow.release') {
      for (const queryKey of [['workflows'], ['variants']]) {
        void client.invalidateQueries({ queryKey });
      }
      return;
    }
    // install.updated (Contracts 39.4): the installed package's self-update changed
    if (type === 'install.updated') {
      void client.invalidateQueries({ queryKey: ['install'] });
      return;
    }
    // environment.updated (Contracts 8): a paid check got a new state; reading the environment runs no paid check
    if (type === 'environment.updated') {
      void client.invalidateQueries({ queryKey: ['environment'] });
      return;
    }
    if (type !== 'variant.build') return;
    const { variantId } = data as { variantId: string };
    for (const queryKey of [['variants'], ['variants', variantId]]) {
      void client.invalidateQueries({ queryKey, exact: true });
    }
    void refetchBuildLog(client, variantId);
  });
}
