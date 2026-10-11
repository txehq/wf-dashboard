import {
  infiniteQueryOptions,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { readBody, requestJson } from '@/lib/http';
import { invalidateThrottled, throttled, useLiveEvent } from '@/lib/live-events';

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
  // artifact：按产物文件；skill：Skill 调用直接定的边界；llm：模型判定
  method: 'artifact' | 'llm' | 'skill';
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

const getJson = (url: string) => requestJson('GET', url);
const sendJson = (method: 'PUT' | 'POST', url: string, body?: unknown) =>
  requestJson(method, url, body);

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
      return (await readBody(response, url)) as StageReport;
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

async function fetchRequests(id: string, range: RequestRange): Promise<TimelineItem[]> {
  const params = new URLSearchParams();
  if (range.agent !== undefined) params.set('agent', range.agent);
  if (range.fromSeq !== undefined) params.set('fromSeq', String(range.fromSeq));
  if (range.toSeq !== undefined) params.set('toSeq', String(range.toSeq));
  const query = params.toString();
  const url = `/api/sessions/${id}/requests${query === '' ? '' : `?${query}`}`;
  return ((await getJson(url)) as { items: TimelineItem[] }).items;
}

export function requestsQuery(id: string, range: RequestRange) {
  return queryOptions({
    queryKey: ['requests', id, range],
    queryFn: () => fetchRequests(id, range),
  });
}

// session 有新请求写入时刷新请求明细（Medium 25）：完整的明细只拉取最后一条请求起的行——最后一条在一轮结束前
// 还会追加内容，连同它之后的用户消息一起替换——接在已有的列表后面，长 session 不再整份重拉；
// 带区间的明细（阶段筛选）与还没有请求的明细整段重新拉取
export async function refreshRequests(client: QueryClient, sessionId: string) {
  for (const query of client.getQueryCache().findAll({ queryKey: ['requests', sessionId] })) {
    const range = query.queryKey[2] as RequestRange;
    const items = query.state.data as TimelineItem[] | undefined;
    const last = items?.findLast((i) => i.kind === 'request');
    if (range.fromSeq !== undefined || range.toSeq !== undefined || last === undefined) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
      continue;
    }
    const fresh = await fetchRequests(sessionId, { ...range, fromSeq: last.seq });
    // 服务端返回 #(last-1) 之后的用户消息与 #last 起的请求：保留到 #(last-1) 为止
    const current = client.getQueryData<TimelineItem[]>(query.queryKey);
    if (current === undefined)
      throw new Error(`请求明细 ${JSON.stringify(query.queryKey)} 已被移除`);
    const previous = current.findIndex((i) => i.kind === 'request' && i.seq === last.seq - 1);
    if (last.seq > 0 && previous === -1) {
      throw new Error(`请求明细中没有请求 #${String(last.seq - 1)}`);
    }
    const kept = last.seq === 0 ? [] : current.slice(0, previous + 1);
    client.setQueryData<TimelineItem[]>(query.queryKey, [...kept, ...fresh]);
  }
}

// 同一 session 每秒最多刷新一次请求明细
export function refreshRequestsThrottled(client: QueryClient, sessionId: string) {
  throttled(`requests:${sessionId}`, 1_000, () => {
    void refreshRequests(client, sessionId);
  });
}

// 同一查询在窗口内只刷新一次：长时间运行的 session 每秒数次 session.updated
function invalidateSession(client: QueryClient, sessionId: string) {
  invalidateThrottled(client, ['sessions'], 1_000);
  invalidateThrottled(client, ['session', sessionId], 1_000);
  refreshRequestsThrottled(client, sessionId);
  invalidateThrottled(client, ['stages', sessionId], 1_000);
}

// Contracts 第 11 节：session 主 agent 的对话；seq 指向请求明细中的那一行
export interface ConversationQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export type ConversationItem =
  | { kind: 'user' | 'notice'; text: string; timestamp: string; seq: number | null }
  | { kind: 'agent'; text: string; timestamp: string; seq: number }
  | {
      kind: 'question';
      toolCallId: string;
      questions: ConversationQuestion[];
      answers: Record<string, string> | null;
      timestamp: string;
      seq: number;
    };

// 键在 ['session', id] 之下：session.updated 时随 session 一起刷新
export function conversationQuery(id: string) {
  return queryOptions({
    queryKey: ['session', id, 'conversation'],
    queryFn: async () =>
      ((await getJson(`/api/sessions/${id}/conversation`)) as { items: ConversationItem[] }).items,
  });
}

// session 有新请求写入或阶段变化时刷新相关查询；判定进度直接写入 analysis 查询，判定完成后刷新阶段结果
export function useSessionEvents() {
  const client = useQueryClient();
  useLiveEvent((type, data) => {
    switch (type) {
      case 'session.updated':
      case 'stage.changed':
        invalidateSession(client, (data as { sessionId: string }).sessionId);
        return;
      case 'stage.progress': {
        const { sessionId, workflow, batchesDone, batchesTotal, costUsd } =
          data as AnalysisProgress & { sessionId: string };
        client.setQueryData<AnalysisState>(analysisQuery(sessionId).queryKey, {
          status: 'running',
          progress: { workflow, batchesDone, batchesTotal, costUsd },
          error: null,
        });
        return;
      }
      case 'stage.failed': {
        const { sessionId, error } = data as { sessionId: string; error: string };
        client.setQueryData<AnalysisState>(analysisQuery(sessionId).queryKey, (prev) => ({
          status: 'failed',
          progress: prev?.progress ?? null,
          error,
        }));
        return;
      }
      case 'stage.analyzed': {
        const { sessionId } = data as { sessionId: string };
        void client.invalidateQueries({ queryKey: ['analysis', sessionId] });
        invalidateSession(client, sessionId);
        return;
      }
      default:
    }
  });
}
