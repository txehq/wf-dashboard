import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MagiAgentView, MagiDeployView } from '@wf-dashboard/server/magi-agent/views';
import { requestJson } from '@/lib/http';
import type { LiveDetail, LiveSummary } from '@/lib/live-api';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// 与 Contracts 第 23 节（Magi Agent）的 API 对应
export type { MagiAgentView, MagiDeployView };
export type MagiEngine = LiveSummary['engine'];

export const magiQuery = queryOptions({
  queryKey: ['magi'],
  queryFn: async () => (await requestJson('GET', '/api/magi-agent')) as MagiAgentView,
});

export const useMagi = () => useQuery(magiQuery);

// 打开这种引擎的当前会话：没有时新建，没有运行中的进程时 resume
export async function openMagi(engine: MagiEngine): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/magi-agent/open', { engine })) as LiveDetail;
}

export async function newMagiSession(engine: MagiEngine): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/magi-agent/new', { engine })) as LiveDetail;
}

export async function resumeMagi(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/magi-agent/${liveId}/resume`)) as LiveDetail;
}

export const deployLogUrl = (id: number) => `/api/magi-agent/deploys/${String(id)}/log`;

// 顶部按钮默认打开的引擎，记在 localStorage，默认 Codex（Contracts 23.6）
const ENGINE_KEY = 'wfd.magi.engine';

export function useMagiEngine(): [MagiEngine, (next: MagiEngine) => void] {
  const [engine, setEngine] = useState<MagiEngine>(() =>
    localStorage.getItem(ENGINE_KEY) === 'claude' ? 'claude' : 'codex',
  );
  return [
    engine,
    (next) => {
      localStorage.setItem(ENGINE_KEY, next);
      setEngine(next);
    },
  ];
}

// magi.updated 与 magi.deploy：重新读取 Magi Agent 的状态与交互列表（当前会话、worktree 的准备、部署的进度）
export function useMagiEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'magi.updated' && type !== 'magi.deploy') return;
    invalidateThrottled(client, ['magi'], 300);
    invalidateThrottled(client, ['live'], 300);
  });
}
