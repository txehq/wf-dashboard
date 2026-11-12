import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type { Effort, ModelAlias } from '@wf-dashboard/server/variants/model-names';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, type LiveEventType, useLiveEvent } from '@/lib/live-events';
import { refreshRequestsThrottled, type StageReport, type StageStatus } from '@/lib/sessions-api';

// Runs API, Contracts 7 (server/src/runs/views.ts)

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

// Statuses that can still change
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

// Rubric outputs use the rubric group id as their kind (e.g. brief, research); the rest are fixed kinds
export type ArtifactKind =
  'pr' | 'repo' | 'ticket' | 'friction' | 'acceptance' | 'pr_snapshot' | (string & {});

export interface Artifact {
  kind: ArtifactKind;
  location: string;
  snapshot: string | null;
  createdAt: number;
  updatedAt: number;
}

// Contracts 7.11: references in this run's requests that point at other evaluation runs
export interface CrossRunRef {
  runId: string;
  kind: 'repo' | 'vault' | 'ticket' | 'other';
  // seq in the main session; calls inside a subagent use the main-session request that started it
  requestSeq: number;
  toolCallId: string;
  excerpt: string;
}

// Contracts 13: a run of a task imported from Linear read its source
export interface SourceRef {
  kind: 'ticket' | 'pr' | 'repo';
  requestSeq: number;
  toolCallId: string;
  excerpt: string;
}

export interface RunSummary {
  id: string;
  batchId: string;
  taskId: string;
  // The variant's workflow (Contracts 16.4) and the task's evaluation kind (16.3)
  workflowId: string;
  kind: 'lfg' | 'ic';
  taskTitle: string;
  variantId: string;
  variantName: string;
  // Model alias and effort chosen when the batch started (Contracts 16.5)
  model: string;
  effort: string;
  repeatIndex: number;
  status: RunStatus;
  currentStage: { workflow: string; stage: string; status: StageStatus } | null;
  costUsd: number;
  durationMs: number | null;
  humanIntervened: boolean;
  crossRunRefs: CrossRunRef[];
  // Read the source ticket, repo or PR (Contracts 13); compare excludes these by default
  sourceRefs: SourceRef[];
  // Why the run was invalidated; compare always excludes these runs
  invalidReason: string | null;
  // Contracts 7.6: none = not graded, running = grading, done = graded, failed = grading errored
  grading: { status: 'none' | 'running' | 'done' | 'failed'; error: string | null };
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CostBreakdown {
  agent: number;
  simulatedUser: number;
  grading: number;
  total: number;
}

// A running run's duration counts up to now
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
  models: { simulatedUser: string; judge: string };
  // Self-hosted runner labels available to copy repos (Contracts 13)
  copyRunnerLabels: string[];
  // Default model and effort when starting a batch (Contracts 16.5)
  agentModel: ModelAlias;
  agentEffort: Effort;
  // Day boundaries of the Linear stats (Contracts 37.1), an IANA timezone
  teamStatsTimezone: string;
}

// Throws an error with the URL, status code and server reason on failure
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

export function createBatch(input: {
  variantIds: string[];
  taskIds: string[];
  repeats: number;
  model: string;
  effort: string;
}) {
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

// Contracts 7.12: invalidate (non-null reason) or restore
export function setRunInvalid(id: string, reason: string | null) {
  return reason === null
    ? call<{ ok: true }>('POST', `/api/runs/${id}/revalidate`)
    : call<{ ok: true }>('POST', `/api/runs/${id}/invalidate`, { reason });
}

// Contracts 10: creates a new run for the same task x variant in the same batch and returns it
export function rerunRun(id: string) {
  return call<RunSummary>('POST', `/api/runs/${id}/rerun`);
}

// Runs that show the Rerun button: failed, cancelled or invalidated
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

// run.* refreshes the list and that run's detail; session.updated refreshes that session's requests.
// Each query refreshes at most once per window: batch creation sends dozens of run.status, long runs send several session.updated per second
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
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  grading: 'Grading',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
