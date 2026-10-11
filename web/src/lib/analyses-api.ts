import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { formatInteger, formatUsd } from '@/lib/format';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// Contracts 第 15 节：session 绑定 variant 与 skill 分析

export type VariantBinding = 'run' | 'auto' | 'manual';

export interface Named {
  id: string;
  name: string;
}

export interface SessionBinding {
  variant: Named | null;
  binding: VariantBinding | null;
  // 与 session 的 skill 逐字节一致的全部 variant，按创建时间
  matching: Named[];
  skills: { name: string; loads: number }[];
  defaultBase: Named | null;
}

export const bindingLabel: Record<VariantBinding, string> = {
  run: 'run 所用',
  auto: '自动',
  manual: '手动',
};

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
export type AnalysisAspect = 'process' | 'efficiency' | 'interaction' | 'quality';
export type StepKey = AnalysisAspect | 'synthesis';

export const engineLabel: Record<AnalysisEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const aspectLabel: Record<AnalysisAspect, string> = {
  process: '流程遵守',
  efficiency: '效率与花费',
  interaction: '和用户的交互',
  quality: '产物质量',
};

export const stepLabel: Record<StepKey, string> = { ...aspectLabel, synthesis: '综合修改建议' };

export const statusLabel: Record<AnalysisStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export interface AnalysisTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface AnalysisStep {
  key: StepKey;
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
  variantId: string;
  variantName: string;
  sessionIds: string[];
  status: AnalysisStatus;
  error: string | null;
  steps: AnalysisStep[];
  costUsd: number | null;
  createdAt: string;
  endedAt: string | null;
}

export interface ScopeSession {
  id: string;
  title: string | null;
  startedAt: string;
  runId: string | null;
  variant: Named | null;
  binding: VariantBinding | null;
}

export interface AnalysisScope {
  sessions: ScopeSession[];
  variant: Named | null;
  problem: string | null;
}

export interface Finding {
  findingId: string;
  aspect: AnalysisAspect;
  title: string;
  stage: string | null;
  skill: string | null;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  evidence: { sessionId: string; seq: number; quote: string }[];
}

export interface Hunk {
  index: number;
  // 原文中的行号（0 起）；行含换行符
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

export interface AnalysisDetail extends AnalysisSummary {
  sessions: ScopeSession[];
  findings: Finding[];
  patches: { file: string; findingIds: string[]; rationale: string; patch: string }[];
  files: FileProposal[];
}

export const tokenTotal = (t: AnalysisTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

// Codex 没有价格时只显示 token
export function costText(a: Pick<AnalysisSummary, 'costUsd' | 'steps'>): string {
  if (a.costUsd !== null) return formatUsd(a.costUsd);
  const tokens = a.steps.reduce((sum, s) => sum + tokenTotal(s.tokens), 0);
  return `${formatInteger(tokens)} token（无价格）`;
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

export const analysisOptionsQuery = queryOptions({
  queryKey: ['analyses', 'options'],
  queryFn: () => call<{ defaults: Record<AnalysisEngine, string> }>('GET', '/api/analyses/options'),
  staleTime: Infinity,
});

// 范围：?sessions=a,b 或 ?batch=<id>
export type ScopeInput = { sessions: string[] } | { batch: string };

export const scopeQuery = (input: ScopeInput) =>
  queryOptions({
    queryKey: ['analyses', 'scope', input],
    queryFn: () => {
      const params = new URLSearchParams(
        'batch' in input ? { batch: input.batch } : { sessions: input.sessions.join(',') },
      );
      return call<AnalysisScope>('GET', `/api/analyses/scope?${params.toString()}`);
    },
  });

export function createAnalysis(
  input: ScopeInput & { engine: AnalysisEngine; model: string },
): Promise<{ id: string }> {
  return call('POST', '/api/analyses', {
    ...('batch' in input ? { batchId: input.batch } : { sessionIds: input.sessions }),
    engine: input.engine,
    model: input.model,
  });
}

export function cancelAnalysis(id: string) {
  return call<{ id: string }>('POST', `/api/analyses/${id}/cancel`);
}

export function saveAnalysisVariant(
  id: string,
  body: { name: string; files: { path: string; content: string }[] },
) {
  return call<Named>('POST', `/api/analyses/${id}/variant`, body);
}

// 页面同样的算法：按选择的改动生成结果
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
