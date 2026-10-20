import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { refetchBuildLog } from '@/pages/variants-api';

// 一个页面共用一个 /api/events 连接（W15 H11）：
// - 每次连上（包括断开后重连）服务端先发 ready，这时刷新全部查询（已失败的除外），补上断开期间错过的变化；
// - 连接被关闭（例如服务重启期间 Vite 代理返回 502，EventSource 不会再自己重试）时按退避重建连接；
// - 连接状态供布局显示"实时连接已断开"。
// 各页面用 useLiveEvent 订阅自己关心的事件

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
  'draft.updated',
  'analysis.updated',
  'magi.updated',
  'magi.deploy',
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

// 整页刷新（SSE 的 ready、variant.updated）：已失败的查询不重新请求，只由页面上的「重试」恢复
// （与 variants-api.ts 中失败后不自动重复请求的约定相同）
export function refreshAllExceptFailed(client: QueryClient) {
  void client.invalidateQueries({ predicate: (query) => query.state.status !== 'error' });
}

// 建立连接；返回关闭函数。由布局挂载一次
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
      // CONNECTING：浏览器自己重连；CLOSED：不会再重试，由这里重建
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

// 订阅事件；handler 每次渲染可以不同，调用时取最新的一个
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

// 同一个查询键在 ms 内只刷新一次（窗口结束时刷新，取到窗口内最后的变化）：
// 长时间运行中 session.updated 每秒数次，一个 batch 创建时 run.status 一次几十条
const pending = new Map<string, ReturnType<typeof setTimeout>>();

// 同一个 key 在 ms 内只执行一次 work（窗口结束时执行）
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

// 布局挂载：建立连接；variant.build 刷新 variant 的列表与该 variant 的详情和构建日志（离开 Variants 页面再回来时
// 状态是最新的，Runs 的发起列表在构建完成时可选）。文件内容不刷新，编辑中的修改不受影响。
// variant.updated（改名、被覆盖或恢复，Contracts 16.4、17.4）：variant 的名字与状态出现在各个页面的查询中（Workflows、
// Sessions 的绑定、Live、Runs、Compare、Analyses、草稿、历史），全部重新读取（已失败的除外）；编辑器只在打开文件时读内容，编辑中的修改不受影响
// variant.deleted、workflow.deleted（Contracts 24.6）同样全部重新读取：已删除的从列表中消失，保留的记录显示「（已删除）」
// workflow.release 重新读取 workflow 与 variant 的列表
export function useLiveConnection() {
  const client = useQueryClient();
  useEffect(() => connectLiveEvents(client), [client]);
  useLiveEvent((type, data) => {
    if (type === 'variant.updated' || type === 'variant.deleted' || type === 'workflow.deleted') {
      refreshAllExceptFailed(client);
      return;
    }
    // workflow.release（Contracts 29.1）：最新版的检查结果变了或自动导入了 variant
    if (type === 'workflow.release') {
      for (const queryKey of [['workflows'], ['variants']]) {
        void client.invalidateQueries({ queryKey });
      }
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
