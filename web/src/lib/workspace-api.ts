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

// 与 Contracts 26.4（设计与优化会话的 workflow 面板）的接口对应
export type { WorkspaceAgainst, WorkspaceEvent, WorkspaceFileStatus, WorkspaceStageStatus };
export type Workspace = WorkspaceView;
export type WorkspaceFile = WorkspaceFileView;

// "对比"可以选的对象（28.4）：底子（空白新建时没有）、上次保存、上一版，按这个顺序，没有的不列出
export interface AgainstOption {
  value: WorkspaceAgainst;
  label: string;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function againstOptions(workspace: Pick<Workspace, 'base' | 'against'>): AgainstOption[] {
  const { saved, previous } = workspace.against;
  return [
    ...(workspace.base === null ? [] : [{ value: 'base' as const, label: '底子' }]),
    ...(saved === null ? [] : [{ value: 'saved' as const, label: `上次保存 ${clock(saved.at)}` }]),
    ...(previous === null
      ? []
      : [{ value: 'previous' as const, label: `上一版 ${clock(previous.at)}` }]),
  ];
}

// 记下的选择还在时用它，否则用第一个可用的；都没有时为 null
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

// 监视这一项的工作目录（SSE）：每次连上（含断开后重连）先刷新面板的查询，补上断开期间的变化；收到 closed 或
// failed 后关闭连接，不再重连
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
