import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type {
  MagiAgentView,
  MagiDeployView,
  MagiOpenBody,
  MagiSessionView,
} from '@wf-dashboard/server/magi-agent/views';
import { requestJson } from '@/lib/http';
import type { LiveDetail, LiveSummary } from '@/lib/live-api';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// Matches the API in Contracts section 23 (Magi Agent)
export type { MagiAgentView, MagiDeployView, MagiSessionView };
export type MagiEngine = LiveSummary['engine'];

export const magiQuery = queryOptions({
  queryKey: ['magi'],
  queryFn: async () => (await requestJson('GET', '/api/magi-agent')) as MagiAgentView,
});

export const useMagi = () => useQuery(magiQuery);

// File changes in the worktree emit no events: while the Magi Agent item is shown, re-read the branch
// status (ahead, behind, uncommitted) every 5 seconds
const WORKTREE_REFRESH_MS = 5_000;
export const useMagiWorktree = () =>
  useQuery({ ...magiQuery, refetchInterval: WORKTREE_REFRESH_MS });

// Open (Contracts 23.6): continue the chosen session (resume when no process is running); an empty
// liveId creates a new one
export async function openMagi(body: MagiOpenBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/magi-agent/open', body)) as LiveDetail;
}

export async function resumeMagi(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/magi-agent/${liveId}/resume`)) as LiveDetail;
}

export const deployLogUrl = (id: number) => `/api/magi-agent/deploys/${String(id)}/log`;

// The popover's three choices (Contracts 23.6): engine (Codex by default), config (local config by
// default), session (which one to continue, or a new one). localStorage remembers the last opened
// session (for a new session, the one created) and continues it by default next time; when it is not
// under the chosen engine and config (deleted, or engine/config changed), the most recent one is chosen
export interface MagiChoice {
  engine: MagiEngine;
  config: string;
  session: { kind: 'continue'; liveId: string | null } | { kind: 'new' };
}

const CHOICE_KEY = 'wfd.magi.choice';

const StoredChoice = z.object({
  engine: z.enum(['codex', 'claude']),
  config: z.string().min(1),
  liveId: z.string(),
});

export function readMagiChoice(): MagiChoice {
  const saved = localStorage.getItem(CHOICE_KEY);
  if (saved === null) {
    return { engine: 'codex', config: 'local', session: { kind: 'continue', liveId: null } };
  }
  const { engine, config, liveId } = StoredChoice.parse(JSON.parse(saved));
  return { engine, config, session: { kind: 'continue', liveId } };
}

export function saveMagiChoice(opened: { engine: MagiEngine; config: string; liveId: string }) {
  localStorage.setItem(CHOICE_KEY, JSON.stringify(StoredChoice.parse(opened)));
}

// magi.updated and magi.deploy: re-read the Magi Agent status and the interaction list (worktree
// preparation, deploy progress); live.updated: the list and order of sessions in the popover
export function useMagiEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type === 'live.updated') {
      invalidateThrottled(client, ['magi'], 300);
      return;
    }
    if (type !== 'magi.updated' && type !== 'magi.deploy') return;
    invalidateThrottled(client, ['magi'], 300);
    invalidateThrottled(client, ['live'], 300);
  });
}
