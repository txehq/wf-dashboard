import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, type LiveEventType, useLiveEvent } from '@/lib/live-events';
import {
  refreshRequestsThrottled,
  type StageReport,
  type StageStatus,
  type Workflow,
} from '@/lib/sessions-api';

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
  currentStage: { workflow: Workflow; stage: string; status: StageStatus } | null;
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

// 失败时抛出带 URL、状态码与服务端原因的错误
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  return (await requestJson(method, url, body)) as T;
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

const runEvents = new Set<LiveEventType>([
  'run.status',
  'run.message',
  'run.pending',
  'run.stage',
  'run.artifact',
  'run.cost',
]);

// run.* 刷新列表与对应 run 的详情；session.updated 刷新该 session 的请求明细。
// 同一查询在窗口内只刷新一次：batch 创建时几十条 run.status、长时间运行中每秒数次 session.updated
export function useRunEvents() {
  const client = useQueryClient();
  useLiveEvent((type, data) => {
    if (runEvents.has(type)) {
      const { runId } = data as { runId: string };
      invalidateThrottled(client, ['runs', 'list'], 500);
      invalidateThrottled(client, ['runs', 'batches'], 500);
      invalidateThrottled(client, ['runs', 'detail', runId], 300);
      invalidateThrottled(client, ['runs', runId, 'grades'], 300);
    } else if (type === 'session.updated' || type === 'stage.changed') {
      const { sessionId } = data as { sessionId: string };
      refreshRequestsThrottled(client, sessionId);
      invalidateThrottled(client, ['session', sessionId], 1_000);
    }
  });
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
