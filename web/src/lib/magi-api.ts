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

// 与 Contracts 第 23 节（Magi Agent）的 API 对应
export type { MagiAgentView, MagiDeployView, MagiSessionView };
export type MagiEngine = LiveSummary['engine'];

export const magiQuery = queryOptions({
  queryKey: ['magi'],
  queryFn: async () => (await requestJson('GET', '/api/magi-agent')) as MagiAgentView,
});

export const useMagi = () => useQuery(magiQuery);

// worktree 中文件的改动没有事件：显示 Magi Agent 这一项时每 5 秒重新读取分支状态（领先、落后、未提交）
const WORKTREE_REFRESH_MS = 5_000;
export const useMagiWorktree = () =>
  useQuery({ ...magiQuery, refetchInterval: WORKTREE_REFRESH_MS });

// 打开（Contracts 23.6）：继续所选的会话（没有运行中的进程时 resume），liveId 为空时新建
export async function openMagi(body: MagiOpenBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/magi-agent/open', body)) as LiveDetail;
}

export async function resumeMagi(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/magi-agent/${liveId}/resume`)) as LiveDetail;
}

export const deployLogUrl = (id: number) => `/api/magi-agent/deploys/${String(id)}/log`;

// 弹出框的三项选择（Contracts 23.6）：引擎（默认 Codex）、配置（默认本机配置）、会话（继续哪一个或新会话）。
// localStorage 中记下上次打开的会话（新会话时为新建的那一个），下次默认继续它；它不在所选的引擎与配置下时
// （被删除，或换了引擎与配置）选最近的一个
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

// magi.updated 与 magi.deploy：重新读取 Magi Agent 的状态与交互列表（worktree 的准备、部署的进度）；
// live.updated：弹出框中会话的列表与顺序
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
