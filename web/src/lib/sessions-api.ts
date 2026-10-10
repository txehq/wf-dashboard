import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

// 与 Contracts.md 第 2、5 节的 Sessions API 对应

export type Workflow = 'lfg' | 'ic';

export interface Source {
  path: string;
  variant: string | null;
  sessionCount: number;
  lastModified: string | null;
  checked: boolean;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface SessionSummary {
  id: string;
  cwd: string | null;
  title: string | null;
  source: string | null;
  startedAt: string;
  endedAt: string;
  requestCount: number;
  tokens: Tokens;
  costUsd: number;
  workflows: Workflow[];
  analyzed: boolean;
  runId: string | null;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description: string | null;
  parentToolUseId: string;
  requestCount: number;
}

export interface SessionDetail extends SessionSummary {
  subagentCount: number;
  toolCallCount: number;
  toolCounts: Record<string, number>;
  subagents: SubagentInfo[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result: string | null;
  resultChars: number;
  isError: boolean;
  spillPath: string | null;
  subagentId: string | null;
}

export interface RequestItem {
  kind: 'request';
  seq: number;
  messageId: string;
  agentId: string | null;
  timestamp: string;
  model: string;
  thinking: string | null;
  text: string | null;
  toolCalls: ToolCall[];
  tokens: Tokens;
  costUsd: number;
  durationMs: number | null;
  attributionSkill: string | null;
}

export interface MessageItem {
  kind: 'user' | 'notice';
  text: string;
  timestamp: string;
}

export type TimelineItem = RequestItem | MessageItem;

// interrupted：后来开始了另一轮流程，这一轮在那之前结束时正在进行的阶段
export type StageStatus = 'done' | 'active' | 'skipped' | 'not-reached' | 'interrupted';

export interface StageStats {
  // 含子代理的请求
  requests: number;
  // 只计主 session 的请求：各轮与流程外的 mainRequests 之和等于主 agent 请求总数
  mainRequests: number;
  toolCalls: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  subagents: number;
}

export interface StageView {
  stage: string;
  status: StageStatus;
  startSeq: number | null;
  endSeq: number | null;
  method: 'artifact' | 'llm';
  evidence: unknown;
  stats: StageStats;
}

export interface WorkflowCycle {
  index: number;
  // 工单编号、PR 编号或"第 N 轮"
  label: string;
  startSeq: number;
  endSeq: number | null;
  stages: StageView[];
}

export interface StageReport {
  sessionId: string;
  lfg: WorkflowCycle[];
  ic: WorkflowCycle[];
  // 不属于任何一轮流程的请求
  outside: StageStats;
  checks: { count: number; inputTokens: number; outputTokens: number; costUsd: number };
}

// 错误响应：路由自己返回 { error }；路由中抛出的错误由 Fastify 返回 { statusCode, error, message }，原文在 message
export async function readJson(response: Response, url: string): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json()) as { error?: string; message?: string };
    const reason = body.message ?? body.error;
    throw new Error(`${url} 返回 ${String(response.status)}${reason ? `：${reason}` : ''}`);
  }
  return response.json();
}

async function getJson(url: string): Promise<unknown> {
  return readJson(await fetch(url), url);
}

async function sendJson(method: 'PUT' | 'POST', url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return readJson(response, url);
}

export const sourcesQuery = queryOptions({
  queryKey: ['sources'],
  queryFn: async () => (await getJson('/api/sources')) as Source[],
});

export interface ImportResult {
  sources: Source[];
  imported: { files: number; changedSessions: number; durationMs: number };
}

export async function putSources(paths: string[]): Promise<ImportResult> {
  return (await sendJson('PUT', '/api/sources', { paths })) as ImportResult;
}

export interface SessionFilter {
  q: string;
  workflow: Workflow | null;
}

const PAGE_SIZE = 50;

export function sessionsQuery(filter: SessionFilter) {
  return infiniteQueryOptions({
    queryKey: ['sessions', filter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filter.q !== '') params.set('q', filter.q);
      if (filter.workflow !== null) params.set('workflow', filter.workflow);
      if (pageParam !== null) params.set('cursor', pageParam);
      return (await getJson(`/api/sessions?${params.toString()}`)) as {
        sessions: SessionSummary[];
        nextCursor: string | null;
      };
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function sessionQuery(id: string) {
  return queryOptions({
    queryKey: ['session', id],
    queryFn: async () => (await getJson(`/api/sessions/${id}`)) as SessionDetail,
  });
}

// 未判定的 session 返回 404，这里表示为 null
export function stagesQuery(id: string) {
  return queryOptions({
    queryKey: ['stages', id],
    queryFn: async () => {
      const url = `/api/sessions/${id}/stages`;
      const response = await fetch(url);
      if (response.status === 404) return null;
      return (await readJson(response, url)) as StageReport;
    },
  });
}

export interface AnalysisProgress {
  workflow: Workflow;
  batchesDone: number;
  batchesTotal: number;
  costUsd: number;
}

// 离线判定的状态（Contracts 第 9 节）；failed 保留最近一次失败的原文
export interface AnalysisState {
  status: 'idle' | 'running' | 'failed' | 'done';
  progress: AnalysisProgress | null;
  error: string | null;
}

export function analysisQuery(id: string) {
  return queryOptions({
    queryKey: ['analysis', id],
    queryFn: async () => (await getJson(`/api/sessions/${id}/analysis`)) as AnalysisState,
  });
}

// 已判定过返回 StageReport；否则后台开始判定，返回当前进度
export async function analyzeSession(
  id: string,
): Promise<StageReport | { status: 'running'; progress: AnalysisProgress | null }> {
  return (await sendJson('POST', `/api/sessions/${id}/analyze`)) as
    StageReport | { status: 'running'; progress: AnalysisProgress | null };
}

export interface RequestRange {
  agent?: string;
  fromSeq?: number;
  toSeq?: number;
}

export function requestsQuery(id: string, range: RequestRange) {
  return queryOptions({
    queryKey: ['requests', id, range],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (range.agent !== undefined) params.set('agent', range.agent);
      if (range.fromSeq !== undefined) params.set('fromSeq', String(range.fromSeq));
      if (range.toSeq !== undefined) params.set('toSeq', String(range.toSeq));
      const query = params.toString();
      const url = `/api/sessions/${id}/requests${query === '' ? '' : `?${query}`}`;
      return ((await getJson(url)) as { items: TimelineItem[] }).items;
    },
  });
}

function invalidateSession(client: QueryClient, sessionId: string) {
  void client.invalidateQueries({ queryKey: ['sessions'] });
  void client.invalidateQueries({ queryKey: ['session', sessionId] });
  void client.invalidateQueries({ queryKey: ['requests', sessionId] });
  void client.invalidateQueries({ queryKey: ['stages', sessionId] });
}

// 订阅 /api/events：session 有新请求写入或阶段变化时刷新相关查询；
// 判定进度直接写入 analysis 查询，判定完成后刷新阶段结果
export function useSessionEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    const onSession = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { sessionId: string };
      invalidateSession(client, data.sessionId);
    };
    const onProgress = (event: MessageEvent<string>) => {
      const { sessionId, workflow, batchesDone, batchesTotal, costUsd } = JSON.parse(
        event.data,
      ) as AnalysisProgress & { sessionId: string };
      client.setQueryData<AnalysisState>(analysisQuery(sessionId).queryKey, {
        status: 'running',
        progress: { workflow, batchesDone, batchesTotal, costUsd },
        error: null,
      });
    };
    const onFailed = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { sessionId: string; error: string };
      client.setQueryData<AnalysisState>(analysisQuery(data.sessionId).queryKey, (prev) => ({
        status: 'failed',
        progress: prev?.progress ?? null,
        error: data.error,
      }));
    };
    const onAnalyzed = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { sessionId: string };
      void client.invalidateQueries({ queryKey: ['analysis', data.sessionId] });
      invalidateSession(client, data.sessionId);
    };
    source.addEventListener('session.updated', onSession);
    source.addEventListener('stage.changed', onSession);
    source.addEventListener('stage.progress', onProgress);
    source.addEventListener('stage.failed', onFailed);
    source.addEventListener('stage.analyzed', onAnalyzed);
    return () => {
      source.close();
    };
  }, [client]);
}
