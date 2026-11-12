import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { formatInteger, formatUsd } from '@/lib/format';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import type { SessionEngine } from '@/lib/sessions-api';

// Contracts sections 15 and 19: binding a session to a variant, and analyses driven by session-analysis

export type VariantBinding = 'run' | 'auto' | 'manual';

export interface Named {
  id: string;
  name: string;
}

export interface SessionBinding {
  // deleted: the bound variant was deleted (a run's sessions stay with the run, Contracts 24.3); the variant page cannot be opened
  variant: (Named & { deleted: boolean }) | null;
  binding: VariantBinding | null;
  // Every variant whose skills match the session's byte for byte, by creation time
  matching: Named[];
  skills: { name: string; loads: number }[];
  defaultBase: Named | null;
}

export const bindingLabel: Record<VariantBinding, string> = {
  run: 'from run',
  auto: 'auto',
  manual: 'manual',
};

// Binding kind run covers run sessions and Live interaction sessions (the variant the interaction used, Contracts 14.1);
// only the former says "from run" (28.5). Binding label on the session detail
export const bindingKindLabel = (binding: VariantBinding, fromRun: boolean) =>
  binding === 'run' && !fromRun ? 'from Live' : bindingLabel[binding];

// Second line of the variant column in the Sessions table: run id for run sessions, nothing for Live interactions, otherwise the binding kind
export function tableBindingNote(s: {
  variantBinding: VariantBinding | null;
  runId: string | null;
}): { run: string } | { label: string } | null {
  if (s.runId !== null) return { run: s.runId };
  if (s.variantBinding === null || s.variantBinding === 'run') return null;
  return { label: bindingLabel[s.variantBinding] };
}

const call = async <T>(method: string, url: string, body?: unknown) =>
  (await requestJson(method, url, body)) as T;

export const bindingQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ['session', sessionId, 'binding'],
    queryFn: () => call<SessionBinding>('GET', `/api/sessions/${sessionId}/binding`),
  });

export function putBinding(sessionId: string, body: { variantId: string | null } | { auto: true }) {
  return call<SessionBinding>('PUT', `/api/sessions/${sessionId}/binding`, body);
}

export function deriveVariantFromSession(
  sessionId: string,
  body: { baseVariantId: string; name: string },
) {
  return call<Named>('POST', `/api/sessions/${sessionId}/derive-variant`, body);
}

export type AnalysisEngine = 'claude' | 'codex';
export type AnalysisStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const engineLabel: Record<AnalysisEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

// Aspects and steps are the stages of the chosen session-analysis variant (Contracts 19.2); analyses before W45 have four aspects and synthesis
const stageNames: Record<string, string> = {
  'process-adherence': 'Process adherence',
  'plan-adherence': 'Plan adherence',
  failures: 'Frequent failures',
  'repeated-work': 'Repeated work',
  'token-waste': 'Wasted tokens',
  'time-waste': 'Wasted time',
  'user-interaction': 'User interaction',
  'output-quality': 'Output quality',
  'request-conflicts': 'Conflicts with the request',
  synthesize: 'Synthesis: report and suggested changes',
  process: 'Process adherence',
  efficiency: 'Efficiency and cost',
  interaction: 'User interaction',
  quality: 'Output quality',
  synthesis: 'Synthesis of suggested changes',
};

// Known stages show a name; others (stages of a derived workflow) show the stage id
export const stageName = (key: string) => stageNames[key] ?? key;

// The synthesis step: the last step
const SYNTHESIS_KEYS = ['synthesize', 'synthesis'];
export const aspectKeys = (steps: { key: string }[]) =>
  steps.map((s) => s.key).filter((k) => !SYNTHESIS_KEYS.includes(k));

export const outcomeLabel: Record<AnalysisReport['outcome'], string> = {
  achieved: 'Achieved',
  partially_achieved: 'Partially achieved',
  not_achieved: 'Not achieved',
  unclear: 'Unclear',
};

export const statusLabel: Record<AnalysisStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export interface AnalysisTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface AnalysisStep {
  key: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number | null;
  endedAt: number | null;
  tokens: AnalysisTokens;
  costUsd: number | null;
  events: number;
  error: string | null;
}

export interface AnalysisSummary {
  id: string;
  engine: AnalysisEngine;
  model: string;
  // Analyses of local-config sessions have no variant (Contracts 25.4); the page shows "Local config"
  variantId: string | null;
  variantName: string | null;
  // The session-analysis variant that drove the analysis; null for analyses before W45
  analysisVariantId: string | null;
  analysisVariantName: string | null;
  sessionIds: string[];
  status: AnalysisStatus;
  error: string | null;
  steps: AnalysisStep[];
  costUsd: number | null;
  createdAt: string;
  endedAt: string | null;
}

// Config (Contracts 25.1, 27): local, variant:<id>, design, with a name ("Local config" or "variant name (workflow)")
export interface ScopeConfig {
  id: string;
  label: string;
}

export interface ScopeSession {
  id: string;
  title: string | null;
  startedAt: string;
  runId: string | null;
  variant: Named | null;
  binding: VariantBinding | null;
  // A local-config session (Contracts 25.4)
  local: boolean;
  engine: SessionEngine;
  // The config it belongs to; null when it is in none
  config: ScopeConfig | null;
  // Project: the name of the working directory
  project: string | null;
  // Already in the dashboard; when false it is imported when the analysis starts and stays out of the management table
  inDashboard: boolean;
}

export interface AnalysisScope {
  sessions: ScopeSession[];
  // All sessions of one analysis share one engine and one config (Contracts 27); null when they do not
  engine: SessionEngine | null;
  config: ScopeConfig | null;
  variant: Named | null;
  // All are local-config sessions: the analysis has no variant, only a report
  local: boolean;
  problem: string | null;
}

export interface Finding {
  findingId: string;
  aspect: string;
  title: string;
  stage: string | null;
  skill: string | null;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  evidence: { sessionId: string; seq: number; quote: string }[];
}

export interface Hunk {
  index: number;
  // Line number in the original (0-based); lines include the newline
  start: number;
  remove: string[];
  insert: string[];
  findingIds: string[];
}

export interface FileProposal {
  path: string;
  original: string;
  proposed: string;
  hunks: Hunk[];
}

// The report written by synthesize (Contracts 19.2): workflowChanges are suggestions that need a new workflow
export interface AnalysisReport {
  summary: string;
  goal: string;
  outcome: 'achieved' | 'partially_achieved' | 'not_achieved' | 'unclear';
  topIssues: { title: string; findingIds: string[]; impact: string }[];
  workflowChanges: { findingIds: string[]; rationale: string; change: string }[];
}

export interface AnalysisDetail extends AnalysisSummary {
  // The analyzed and the driving variant were deleted (Contracts 24.3): show only the name
  variantDeleted: boolean;
  analysisVariantDeleted: boolean;
  sessions: ScopeSession[];
  report: AnalysisReport | null;
  // Drafts handed to Codex for optimizing and their Live items (Contracts 19.3)
  optimizeDrafts: { id: string; liveId: string | null }[];
  findings: Finding[];
  patches: { file: string; findingIds: string[]; rationale: string; patch: string }[];
  files: FileProposal[];
}

export const tokenTotal = (t: AnalysisTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

// Codex without a price shows only tokens
export function costText(a: Pick<AnalysisSummary, 'costUsd' | 'steps'>): string {
  if (a.costUsd !== null) return formatUsd(a.costUsd);
  const tokens = a.steps.reduce((sum, s) => sum + tokenTotal(s.tokens), 0);
  return `${formatInteger(tokens)} ${tokens === 1 ? 'token' : 'tokens'} (no price)`;
}

export const analysesQuery = queryOptions({
  queryKey: ['analyses'],
  queryFn: () => call<AnalysisSummary[]>('GET', '/api/analyses'),
});

export const analysisQuery = (id: string) =>
  queryOptions({
    queryKey: ['analyses', id],
    queryFn: () => call<AnalysisDetail>('GET', `/api/analyses/${id}`),
  });

export interface AnalysisOptions {
  defaults: Record<AnalysisEngine, string> & { analysisVariantId: string | null };
  // session-analysis variants that can be chosen (built successfully from their current content)
  analysisVariants: Named[];
}

export const analysisOptionsQuery = queryOptions({
  queryKey: ['analyses', 'options'],
  queryFn: () => call<AnalysisOptions>('GET', '/api/analyses/options'),
});

// Scope: sessions already in the dashboard (?sessions=, ?picked=) and files picked from disk in a new analysis (Contracts 27), or ?batch=<id>
export interface DiskPick {
  engine: SessionEngine;
  files: string[];
}
export type ScopeInput = { sessions: string[]; disk?: DiskPick | undefined } | { batch: string };

// Selected session ids do not go in the URL (there are many when all are selected): they go in this tab's sessionStorage, and the URL carries one key (Contracts 25.5)
const pickedItem = (key: string) => `analysis-sessions:${key}`;

export function rememberPicked(ids: readonly string[]): string {
  const key = crypto.randomUUID();
  sessionStorage.setItem(pickedItem(key), JSON.stringify(ids));
  return key;
}

export function pickedSessions(key: string): string[] | null {
  const raw = sessionStorage.getItem(pickedItem(key));
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

// Sessions already in the dashboard and files picked from disk (Contracts 27); empty ones are not sent
const scopeBody = (input: { sessions: string[]; disk?: DiskPick | undefined }) => ({
  ...(input.sessions.length > 0 ? { ids: input.sessions } : {}),
  ...(input.disk !== undefined && input.disk.files.length > 0 ? { disk: input.disk } : {}),
});

export const scopeQuery = (input: ScopeInput) =>
  queryOptions({
    queryKey: ['analyses', 'scope', input],
    queryFn: () =>
      'batch' in input
        ? call<AnalysisScope>(
            'GET',
            `/api/analyses/scope?${new URLSearchParams({ batch: input.batch }).toString()}`,
          )
        : call<AnalysisScope>('POST', '/api/analyses/scope', scopeBody(input)),
  });

export function createAnalysis(
  input: ScopeInput & { engine: AnalysisEngine; model: string; analysisVariantId: string },
): Promise<{ id: string }> {
  let scope;
  if ('batch' in input) scope = { batchId: input.batch };
  else {
    const { ids, disk } = scopeBody(input);
    scope = {
      ...(ids === undefined ? {} : { sessionIds: ids }),
      ...(disk === undefined ? {} : { disk }),
    };
  }
  return call('POST', '/api/analyses', {
    ...scope,
    engine: input.engine,
    model: input.model,
    analysisVariantId: input.analysisVariantId,
  });
}

// Optimize (Contracts 19.3, 22.1, 33.2): start a Live session with the chosen engine and workflow-optimize variant; returns the draft and the Live item
export function startOptimize(id: string, engine: 'codex' | 'claude', designVariantId: string) {
  return call<{ draft: { id: string }; live: { id: string } }>(
    'POST',
    `/api/analyses/${id}/optimize`,
    { engine, designVariantId },
  );
}

export function cancelAnalysis(id: string) {
  return call<{ id: string }>('POST', `/api/analyses/${id}/cancel`);
}

// Save as variant (Contracts 15.3, 19.3): name and description are required; does not build
export function saveAnalysisVariant(
  id: string,
  body: { name: string; description: string; files: { path: string; content: string }[] },
) {
  return call<Named>('POST', `/api/analyses/${id}/variant`, body);
}

// Build the result from the chosen hunks
export function applyHunks(original: string, hunks: Hunk[]): string {
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let line = 0;
  for (const h of [...hunks].sort((a, b) => a.start - b.start)) {
    out.push(...lines.slice(line, h.start), ...h.insert);
    line = h.start + h.remove.length;
  }
  out.push(...lines.slice(line));
  return out.join('');
}

export function useAnalysisEvents() {
  const client = useQueryClient();
  useLiveEvent((type, data) => {
    if (type !== 'analysis.updated') return;
    const { analysisId } = data as { analysisId: string };
    invalidateThrottled(client, ['analyses', analysisId], 500);
    invalidateThrottled(client, ['analyses'], 1_000);
  });
}
