import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { StageReport, Workflow } from '@/lib/sessions-api';

// 与 Contracts.md 第 7 节的 Runs API 对应（server/src/runs/views.ts）

export type RunStatus =
  'queued' | 'preparing' | 'running' | 'grading' | 'succeeded' | 'failed' | 'cancelled';

export const runStatuses: RunStatus[] = [
  'queued',
  'preparing',
  'running',
  'grading',
  'succeeded',
  'failed',
  'cancelled',
];

// 还会变化的状态
export const liveStatuses: ReadonlySet<RunStatus> = new Set([
  'queued',
  'preparing',
  'running',
  'grading',
]);

export interface AskQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export type MessagePayload =
  | { kind: 'question'; requestId: string; questions: AskQuestion[] }
  | {
      kind: 'answers';
      requestId: string;
      questions: AskQuestion[];
      answers: Record<string, string>;
    }
  | { kind: 'reply'; done: boolean }
  | { kind: 'initial' }
  | { kind: 'denied'; toolName: string; input: unknown; reason: string | null }
  | { kind: 'event'; event: string };

export interface RunMessage {
  id: number;
  seq: number;
  role: 'agent' | 'simulated_user' | 'human' | 'system';
  content: string;
  costUsd: number;
  payload: MessagePayload | null;
  createdAt: number;
}

export type Pending =
  | { kind: 'text'; text: string; since: number }
  | { kind: 'questions'; requestId: string; questions: AskQuestion[]; since: number };

export type ArtifactKind =
  'brief' | 'research' | 'plan' | 'tickets' | 'pr' | 'repo' | 'ticket' | 'friction' | 'acceptance';

export interface Artifact {
  kind: ArtifactKind;
  location: string;
  snapshot: string | null;
  createdAt: number;
  updatedAt: number;
}

// Contracts 7.11：这个 run 的请求中指向其他评估 run 的引用
export interface CrossRunRef {
  runId: string;
  kind: 'repo' | 'vault' | 'ticket' | 'other';
  // 主 session 的 seq；子代理中的调用取发起该子代理的主 session 请求
  requestSeq: number;
  toolCallId: string;
  excerpt: string;
}

export interface RunSummary {
  id: string;
  batchId: string;
  taskId: string;
  taskKind: Workflow;
  taskTitle: string;
  variantId: string;
  variantName: string;
  repeatIndex: number;
  status: RunStatus;
  currentStage: { workflow: Workflow; stage: string; status: string } | null;
  costUsd: number;
  durationMs: number | null;
  humanIntervened: boolean;
  crossRunRefs: CrossRunRef[];
  // 标为无效的原因；compare 总是排除这类 run
  invalidReason: string | null;
  // Contracts 7.6：none 不会评分，running 正在评分，done 已评分，failed 评分出错
  grading: { status: 'none' | 'running' | 'done' | 'failed'; error: string | null };
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CostBreakdown {
  agent: number;
  simulatedUser: number;
  stageCheck: number;
  grading: number;
  total: number;
}

// 运行中的 run 耗时按当前时间计算
export function runDuration(run: RunSummary, now: number): number | null {
  if (run.startedAt === null) return null;
  return (run.endedAt ?? now) - run.startedAt;
}

export interface RunDetail extends RunSummary {
  sessionId: string;
  workspacePath: string;
  mode: 'simulated' | 'human';
  pending: Pending | null;
  stages: StageReport | null;
  messages: RunMessage[];
  artifacts: Artifact[];
  costs: CostBreakdown;
  links: { repo: string | null; ticket: string | null; pr: string | null; vault: string | null };
  friction: { url: string; title: string }[];
}

export interface BatchSummary {
  id: string;
  repeats: number;
  variantIds: string[];
  taskIds: string[];
  createdAt: number;
  runs: number;
  statusCounts: Record<string, number>;
  costUsd: number;
}

export interface BatchDetail extends BatchSummary {
  runList: RunSummary[];
}

export interface Settings {
  runConcurrency: number;
  maxUserTurns: number;
  defaultRepeats: number;
  models: { simulatedUser: string; judge: string; stageCheck: string };
}

// 失败时抛出服务端返回的 message
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const message = (json as { message?: unknown }).message;
    throw new Error(
      typeof message === 'string' ? message : `${url} 返回 ${String(response.status)}`,
    );
  }
  return json as T;
}

export interface RunFilter {
  status: RunStatus | null;
  task: string | null;
  variant: string | null;
}

export const runsQuery = (filter: RunFilter) =>
  queryOptions({
    queryKey: ['runs', 'list', filter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.status !== null) params.set('status', filter.status);
      if (filter.task !== null) params.set('task', filter.task);
      if (filter.variant !== null) params.set('variant', filter.variant);
      const query = params.toString();
      return call<RunSummary[]>('GET', `/api/runs${query === '' ? '' : `?${query}`}`);
    },
  });

export const batchesQuery = queryOptions({
  queryKey: ['runs', 'batches'],
  queryFn: () => call<BatchSummary[]>('GET', '/api/batches'),
});

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ['runs', 'detail', id],
    queryFn: () => call<RunDetail>('GET', `/api/runs/${id}`),
  });

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => call<Settings>('GET', '/api/settings'),
});

export function saveSettings(settings: Settings) {
  return call<Settings>('PUT', '/api/settings', settings);
}

export function createBatch(input: { variantIds: string[]; taskIds: string[]; repeats: number }) {
  return call<BatchDetail>('POST', '/api/batches', input);
}

export type RunAction = 'takeover' | 'release' | 'finish' | 'cancel';

export function runAction(id: string, action: RunAction) {
  return call<{ ok: true }>('POST', `/api/runs/${id}/${action}`);
}

export function replyRun(id: string, text: string) {
  return call<{ ok: true }>('POST', `/api/runs/${id}/reply`, { text });
}

export function answerRun(id: string, answers: Record<string, string>) {
  return call<{ ok: true }>('POST', `/api/runs/${id}/answer`, { answers });
}

// Contracts 7.12：标为无效（reason 非空）或恢复
export function setRunInvalid(id: string, reason: string | null) {
  return reason === null
    ? call<{ ok: true }>('POST', `/api/runs/${id}/revalidate`)
    : call<{ ok: true }>('POST', `/api/runs/${id}/invalidate`, { reason });
}

// Contracts 10：同一 batch 中为同一 task × variant 新建 run，返回新 run
export function rerunRun(id: string) {
  return call<RunSummary>('POST', `/api/runs/${id}/rerun`);
}

// 页面上显示"重跑"按钮的 run：失败、取消或已标为无效
export function rerunnable(run: RunSummary): boolean {
  return run.status === 'failed' || run.status === 'cancelled' || run.invalidReason !== null;
}

const runEvents = [
  'run.status',
  'run.message',
  'run.pending',
  'run.stage',
  'run.artifact',
  'run.cost',
];

// 订阅 /api/events：run.* 刷新列表与对应 run 的详情；session.updated 刷新该 session 的请求明细
export function useRunEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    const onRun = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { runId: string };
      void client.invalidateQueries({ queryKey: ['runs', 'list'] });
      void client.invalidateQueries({ queryKey: ['runs', 'batches'] });
      void client.invalidateQueries({ queryKey: ['runs', 'detail', data.runId] });
      void client.invalidateQueries({ queryKey: ['runs', data.runId, 'grades'] });
    };
    const onSession = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { sessionId: string };
      void client.invalidateQueries({ queryKey: ['requests', data.sessionId] });
      void client.invalidateQueries({ queryKey: ['session', data.sessionId] });
    };
    for (const type of runEvents) source.addEventListener(type, onRun);
    source.addEventListener('session.updated', onSession);
    source.addEventListener('stage.changed', onSession);
    return () => {
      source.close();
    };
  }, [client]);
}

export const statusLabel: Record<RunStatus, string> = {
  queued: '排队中',
  preparing: '准备中',
  running: '运行中',
  grading: '评分中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
