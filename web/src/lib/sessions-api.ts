import {
  keepPreviousData,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { SessionAction, SessionActionPlan } from '@wf-dashboard/server/deletion/session-views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, throttled, useLiveEvent } from '@/lib/live-events';

// 与 Contracts.md 第 2、5、25 节的 Sessions API 对应

export type SessionEngine = 'claude' | 'codex';

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface SessionSummary {
  id: string;
  engine: SessionEngine;
  // 所属的配置（Contracts 25.1）：local、variant:<目录>、design；不在这些目录中的为空
  config: string | null;
  // 设计与优化下的 session 的用途
  purpose: 'design' | 'optimize' | null;
  archivedAt: string | null;
  cwd: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string;
  requestCount: number;
  tokens: Tokens;
  costUsd: number;
  // 全部请求的模型都在价格表中；false 时不显示花费（Contracts 25.5）
  priced: boolean;
  // dashboard 记录的 workflow 配置（Contracts 25.4）：variant 配置下的 session 为它所属 variant 的 workflow
  workflows: string[];
  runId: string | null;
  // 交互产生或被交互 resume 的 session
  liveId: string | null;
  // 所属的交互项已关闭
  liveHidden: boolean;
  // deleted：绑定的 variant 已删除（Contracts 24.3），名字后有「（已删除）」，不能点进 variant 页面
  variant: { id: string; name: string; deleted: boolean } | null;
  variantBinding: 'run' | 'auto' | 'manual' | null;
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

export type StageStatus = 'done' | 'active' | 'skipped' | 'not-reached';

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

// 进入阶段的那次调用：主 agent 的 Skill 调用或用户输入的 slash 命令
export interface StageEvidence {
  seq: number;
  kind: 'skill' | 'command';
  text: string;
}

export interface StageView {
  stage: string;
  status: StageStatus;
  startSeq: number | null;
  endSeq: number | null;
  // 这个阶段被调用的次数（fix-pr 的修复轮数）
  entries: number;
  evidence: StageEvidence | null;
  stats: StageStats;
}

export interface WorkflowCycle {
  index: number;
  // 开启这一轮的输入（例如 "/ic TXE-3767"），由 Skill 调用开启时为"第 N 轮"
  label: string;
  startSeq: number;
  endSeq: number;
  stages: StageView[];
}

// 一个 workflow 的全部轮次；session 中没有这个 workflow 时 cycles 为空
export interface WorkflowCycles {
  workflow: string;
  cycles: WorkflowCycle[];
}

export interface StageReport {
  sessionId: string;
  // 划分所用的 workflow，按 lfg、ic、其他的顺序（Contracts 16.6）
  workflows: WorkflowCycles[];
  // 不属于任何阶段的请求
  outside: StageStats;
}

const getJson = (url: string) => requestJson('GET', url);
const sendJson = (method: 'PUT' | 'POST', url: string, body?: unknown) =>
  requestJson(method, url, body);

// 上面的三列（Contracts 25.1、25.5）：磁盘上的配置、项目与 session，只读元数据
export interface ImportConfig {
  id: string;
  label: string;
  // variant 的配置所属的 workflow（第一列按它分组）；本机配置、设计与优化为 null
  workflow: { id: string; name: string } | null;
  sessionCount: number;
}

export interface ImportProject {
  cwd: string;
  name: string;
  sessionCount: number;
  importedCount: number;
}

export interface DiskSession {
  id: string;
  file: string;
  title: string | null;
  startedAt: string;
  size: number;
  imported: boolean;
  liveId: string | null;
  liveHidden: boolean;
}

// 三列中改动的 session，带它所在的配置与项目（第二列的计数用）
export interface PickedSession extends DiskSession {
  config: string;
  cwd: string;
}

interface ColumnPage {
  total: number;
  page: number;
  pageSize: number;
}

// 第二、三列每页的个数
export const IMPORT_PAGE_SIZE = 50;

export function importConfigsQuery(engine: SessionEngine) {
  return queryOptions({
    queryKey: ['session-import', engine, 'configs'],
    queryFn: async () =>
      (
        (await getJson(`/api/session-import/configs?engine=${engine}`)) as {
          configs: ImportConfig[];
        }
      ).configs,
  });
}

const columnParams = (
  engine: SessionEngine,
  q: string,
  page: number,
  extra: Record<string, string>,
) => {
  const params = new URLSearchParams({
    engine,
    ...extra,
    page: String(page),
    pageSize: String(IMPORT_PAGE_SIZE),
  });
  if (q !== '') params.set('q', q);
  return params.toString();
};

export function importProjectsQuery(
  engine: SessionEngine,
  config: string,
  q: string,
  page: number,
) {
  return queryOptions({
    queryKey: ['session-import', engine, 'projects', { config, q, page }],
    queryFn: async () => ({
      ...((await getJson(
        `/api/session-import/projects?${columnParams(engine, q, page, { config })}`,
      )) as ColumnPage & { projects: ImportProject[] }),
      q,
    }),
    placeholderData: keepPreviousData,
  });
}

export function diskSessionsQuery(
  engine: SessionEngine,
  config: string,
  cwd: string,
  q: string,
  page: number,
) {
  return queryOptions({
    queryKey: ['session-import', engine, 'sessions', { config, cwd, q, page }],
    queryFn: async () => ({
      ...((await getJson(
        `/api/session-import/sessions?${columnParams(engine, q, page, { config, cwd })}`,
      )) as ColumnPage & { sessions: DiskSession[] }),
      q,
    }),
    placeholderData: keepPreviousData,
  });
}

// "导入 N 个"：files 为第三列中勾选的文件
export async function importSessions(
  engine: SessionEngine,
  files: string[],
): Promise<{ sessions: { id: string; file: string }[]; durationMs: number }> {
  return (await sendJson('POST', '/api/session-import', { engine, files })) as {
    sessions: { id: string; file: string }[];
    durationMs: number;
  };
}

// 管理表格的范围：引擎、配置（为空时是全部）、是否只看已归档的、搜索与页码
export interface SessionFilter {
  engine: SessionEngine;
  config: string | null;
  archived: boolean;
  q: string;
  page: number;
}

export const SESSION_PAGE_SIZE = 50;

function scopeParams(filter: Omit<SessionFilter, 'page'>) {
  const params = new URLSearchParams({ engine: filter.engine });
  if (filter.config !== null) params.set('config', filter.config);
  if (filter.archived) params.set('archived', 'true');
  if (filter.q !== '') params.set('q', filter.q);
  return params;
}

export function sessionsQuery(filter: SessionFilter) {
  return queryOptions({
    queryKey: ['sessions', filter],
    queryFn: async () => {
      const params = scopeParams(filter);
      params.set('page', String(filter.page));
      params.set('pageSize', String(SESSION_PAGE_SIZE));
      const body = (await getJson(`/api/sessions?${params.toString()}`)) as {
        sessions: SessionSummary[];
        total: number;
      };
      // 结果带上它是哪一页、哪个搜索与范围：新的结果到达之前，分页与空结果的说明仍对应列出的这一份
      return { ...body, page: filter.page, q: filter.q, archived: filter.archived };
    },
    placeholderData: keepPreviousData,
  });
}

// 范围与搜索内全部的 id（"选择全部 N 个"），顺序与表格相同
export function sessionIdsQuery(filter: Omit<SessionFilter, 'page'>) {
  return queryOptions({
    queryKey: ['sessions', 'ids', filter],
    queryFn: async () => {
      const params = scopeParams(filter);
      params.set('idsOnly', 'true');
      return (await getJson(`/api/sessions?${params.toString()}`)) as {
        ids: string[];
        total: number;
      };
    },
  });
}

// 删除、归档与恢复（Contracts 25.3、25.5）
export type { SessionAction, SessionActionPlan };

// ids 放在请求体中（POST）：选中全部时 id 很多
export function actionPlanQuery(action: SessionAction, ids: string[]) {
  return queryOptions({
    queryKey: ['session-action-plan', action, ids],
    queryFn: async () =>
      (await sendJson('POST', '/api/sessions/action-plan', { action, ids })) as SessionActionPlan,
  });
}

export async function runSessionAction(
  action: SessionAction,
  ids: string[],
): Promise<SessionActionPlan> {
  return (await sendJson('POST', `/api/sessions/${action}`, { ids })) as SessionActionPlan;
}

export function sessionQuery(id: string) {
  return queryOptions({
    queryKey: ['session', id],
    queryFn: async () => (await getJson(`/api/sessions/${id}`)) as SessionDetail,
  });
}

// "绑定的对象"（Contracts 18.2）
export interface SessionLinks {
  github: { label: string; url: string }[];
  linear: { label: string; url: string }[];
  obsidian: { label: string; path: string }[];
}

export function sessionLinksQuery(id: string) {
  return queryOptions({
    queryKey: ['session', id, 'bindings'],
    queryFn: async () => (await getJson(`/api/sessions/${id}/bindings`)) as SessionLinks,
  });
}

// 阶段在导入时划分，已导入的 session 总是有结果
export function stagesQuery(id: string) {
  return queryOptions({
    queryKey: ['stages', id],
    queryFn: async () => (await getJson(`/api/sessions/${id}/stages`)) as StageReport,
  });
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

// session 有新请求写入或阶段变化时刷新相关查询
export function useSessionEvents() {
  const client = useQueryClient();
  useLiveEvent((type, data) => {
    switch (type) {
      case 'session.updated':
      case 'stage.changed':
        invalidateSession(client, (data as { sessionId: string }).sessionId);
        return;
      default:
    }
  });
}
