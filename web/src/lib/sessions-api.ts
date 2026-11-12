import {
  keepPreviousData,
  queryOptions,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { SessionAction, SessionActionPlan } from '@wf-dashboard/server/deletion/session-views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, throttled, useLiveEvent } from '@/lib/live-events';

// The Sessions API of Contracts.md sections 2, 5 and 25

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
  // The config it belongs to (Contracts 25.1, 33.3): local, variant:<id>; null outside these directories
  config: string | null;
  // Purpose of a design or optimize session (Contracts 33.3)
  purpose: 'design' | 'optimize' | null;
  archivedAt: string | null;
  cwd: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string;
  requestCount: number;
  tokens: Tokens;
  costUsd: number;
  // Every request's model is in the price table; when false, no cost is shown (Contracts 25.5)
  priced: boolean;
  // Workflow config the dashboard records (Contracts 25.4): for a variant-config session, its variant's workflow
  workflows: string[];
  runId: string | null;
  // Session created or resumed by a Live interaction
  liveId: string | null;
  // Its Live item is closed
  liveHidden: boolean;
  // deleted: the bound variant was deleted (Contracts 24.3); the server appends its deleted suffix to the name
  // and the variant page cannot be opened
  variant: { id: string; name: string; deleted: boolean } | null;
  variantBinding: 'run' | 'auto' | 'manual' | null;
  // Session from an SSH host (Contracts 31.6): the host (label null once deleted) and the remote original file;
  // null for local ones
  host: { id: string; label: string | null; remotePath: string | null } | null;
  // Incremental import problem: failed carries the original error (retried on the next incremental import),
  // waiting means a referenced spill file has not appeared yet
  importProblem: { kind: 'failed' | 'waiting'; message: string; at: string } | null;
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
  // Requests including subagents
  requests: number;
  // Main-session requests only: mainRequests of all cycles plus outside equals the main agent's request total
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

// The call that entered a stage: a Skill call by the main agent or a slash command the user typed
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
  // How many times this stage was called (fix rounds for fix-pr)
  entries: number;
  evidence: StageEvidence | null;
  stats: StageStats;
}

export interface WorkflowCycle {
  index: number;
  // The input that opened this cycle (e.g. "/ic TXE-3767"); a cycle opened by a Skill call has the server's
  // default ordinal label
  label: string;
  startSeq: number;
  endSeq: number;
  stages: StageView[];
}

// All cycles of a workflow; cycles is empty when the session has none of this workflow
export interface WorkflowCycles {
  workflow: string;
  cycles: WorkflowCycle[];
}

export interface StageReport {
  sessionId: string;
  // Workflows used for partitioning, in the order lfg, ic, others (Contracts 16.6)
  workflows: WorkflowCycles[];
  // Requests outside every stage
  outside: StageStats;
}

const getJson = (url: string) => requestJson('GET', url);
const sendJson = (method: 'PUT' | 'POST', url: string, body?: unknown) =>
  requestJson(method, url, body);

// The three columns above (Contracts 25.1, 25.5): configs, projects and sessions on disk, read-only metadata
export interface ImportConfig {
  id: string;
  label: string;
  // Workflow of a variant config (the first column groups by it); null for the local config
  workflow: { id: string; name: string } | null;
  sessionCount: number;
  // Config of an SSH host (Contracts 31.6, id ssh:<hostId>): when unreachable, error is ssh's original text and
  // the item is grayed out
  hostId: string | null;
  error: string | null;
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

// A changed session in the three columns, with its config and project (for the second column's counts)
export interface PickedSession extends DiskSession {
  config: string;
  cwd: string;
}

interface ColumnPage {
  total: number;
  page: number;
  pageSize: number;
}

// Page size of columns two and three
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

// "Import N": files are the checked files in the third column
export async function importSessions(
  engine: SessionEngine,
  files: string[],
): Promise<{ sessions: { id: string; file: string }[]; durationMs: number }> {
  return (await sendJson('POST', '/api/session-import', { engine, files })) as {
    sessions: { id: string; file: string }[];
    durationMs: number;
  };
}

// Scope of the manage table: engine, config (null for all), archived only or not, search and page
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
      // The result carries its page, search and scope: until new results arrive, the pager and empty-state text
      // still match the list shown
      return { ...body, page: filter.page, q: filter.q, archived: filter.archived };
    },
    placeholderData: keepPreviousData,
  });
}

// Every id in the scope and search ("Select all N"), in table order
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

// Delete, archive and restore (Contracts 25.3, 25.5)
export type { SessionAction, SessionActionPlan };

// ids go in the request body (POST): there are many with all selected
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

// "Linked items" (Contracts 18.2)
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

// Stages are partitioned at import, so an imported session always has a result
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

// Refresh Requests when a session gets new requests (Medium 25): the full list fetches only the rows from the
// last request on (the last one still grows until its turn ends, so it is replaced along with the user messages
// after it) and appends them, so long sessions are not refetched whole; ranged lists (stage filter) and lists
// with no requests yet are refetched whole
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
    // The server returns user messages after #(last-1) and requests from #last: keep up to #(last-1)
    const current = client.getQueryData<TimelineItem[]>(query.queryKey);
    if (current === undefined)
      throw new Error(`Request list ${JSON.stringify(query.queryKey)} was removed`);
    const previous = current.findIndex((i) => i.kind === 'request' && i.seq === last.seq - 1);
    if (last.seq > 0 && previous === -1) {
      throw new Error(`Request list has no request #${String(last.seq - 1)}`);
    }
    const kept = last.seq === 0 ? [] : current.slice(0, previous + 1);
    client.setQueryData<TimelineItem[]>(query.queryKey, [...kept, ...fresh]);
  }
}

// Refresh Requests at most once a second per session
export function refreshRequestsThrottled(client: QueryClient, sessionId: string) {
  throttled(`requests:${sessionId}`, 1_000, () => {
    void refreshRequests(client, sessionId);
  });
}

// Each query refreshes once per window: a long-running session emits session.updated several times a second
function invalidateSession(client: QueryClient, sessionId: string) {
  invalidateThrottled(client, ['sessions'], 1_000);
  invalidateThrottled(client, ['session', sessionId], 1_000);
  refreshRequestsThrottled(client, sessionId);
  invalidateThrottled(client, ['stages', sessionId], 1_000);
}

// Contracts section 11: the main agent's conversation in a session; seq points at the row in Requests
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

// Keyed under ['session', id]: refreshes with the session on session.updated
export function conversationQuery(id: string) {
  return queryOptions({
    queryKey: ['session', id, 'conversation'],
    queryFn: async () =>
      ((await getJson(`/api/sessions/${id}/conversation`)) as { items: ConversationItem[] }).items,
  });
}

// Refresh related queries when a session gets new requests or its stages change
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
