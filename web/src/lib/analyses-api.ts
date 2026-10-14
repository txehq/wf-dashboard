import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { formatInteger, formatUsd } from '@/lib/format';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';

// Contracts 第 15 节、第 19 节：session 绑定 variant 与由 session-analysis 驱动的分析

export type VariantBinding = 'run' | 'auto' | 'manual';

export interface Named {
  id: string;
  name: string;
}

export interface SessionBinding {
  // deleted：绑定的 variant 已删除（run 的 session 随 run 保留，Contracts 24.3），不能点进 variant 页面
  variant: (Named & { deleted: boolean }) | null;
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

export const engineLabel: Record<AnalysisEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

// 方面与步骤是所选 session-analysis variant 的小阶段（Contracts 19.2）；W45 之前的分析是四个方面与 synthesis
const stageNames: Record<string, string> = {
  'process-adherence': '流程遵守',
  'plan-adherence': '计划遵守',
  failures: '经常失败的地方',
  'repeated-work': '重复的工作',
  'token-waste': '浪费 token',
  'time-waste': '浪费时间',
  'user-interaction': '和用户的交互',
  'output-quality': '产物质量',
  'request-conflicts': '与请求的冲突',
  synthesize: '综合：报告与修改建议',
  process: '流程遵守',
  efficiency: '效率与花费',
  interaction: '和用户的交互',
  quality: '产物质量',
  synthesis: '综合修改建议',
};

// 已知的小阶段显示中文名，其余（派生出的 workflow 的阶段）显示阶段 id
export const stageName = (key: string) => stageNames[key] ?? key;

// 综合步骤：最后一步
const SYNTHESIS_KEYS = ['synthesize', 'synthesis'];
export const aspectKeys = (steps: { key: string }[]) =>
  steps.map((s) => s.key).filter((k) => !SYNTHESIS_KEYS.includes(k));

export const outcomeLabel: Record<AnalysisReport['outcome'], string> = {
  achieved: '完成',
  partially_achieved: '部分完成',
  not_achieved: '没有完成',
  unclear: '看不出',
};

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
  variantId: string;
  variantName: string;
  // 驱动分析的 session-analysis variant；W45 之前的分析为空
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

// synthesize 写出的报告（Contracts 19.2）：workflowChanges 是"需要新建 workflow"的建议
export interface AnalysisReport {
  summary: string;
  goal: string;
  outcome: 'achieved' | 'partially_achieved' | 'not_achieved' | 'unclear';
  topIssues: { title: string; findingIds: string[]; impact: string }[];
  workflowChanges: { findingIds: string[]; rationale: string; change: string }[];
}

export interface AnalysisDetail extends AnalysisSummary {
  // 被分析的与驱动分析的 variant 已删除（Contracts 24.3）：只显示名字
  variantDeleted: boolean;
  analysisVariantDeleted: boolean;
  sessions: ScopeSession[];
  report: AnalysisReport | null;
  // 交给 Codex 优化的草稿与它在 Live 中的项（Contracts 19.3）
  optimizeDrafts: { id: string; liveId: string | null }[];
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

export interface AnalysisOptions {
  defaults: Record<AnalysisEngine, string> & { analysisVariantId: string | null };
  // 可以选用的 session-analysis variant（按当前内容构建通过的）
  analysisVariants: Named[];
}

export const analysisOptionsQuery = queryOptions({
  queryKey: ['analyses', 'options'],
  queryFn: () => call<AnalysisOptions>('GET', '/api/analyses/options'),
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
  input: ScopeInput & { engine: AnalysisEngine; model: string; analysisVariantId: string },
): Promise<{ id: string }> {
  return call('POST', '/api/analyses', {
    ...('batch' in input ? { batchId: input.batch } : { sessionIds: input.sessions }),
    engine: input.engine,
    model: input.model,
    analysisVariantId: input.analysisVariantId,
  });
}

// 优化（Contracts 19.3、22.1）：用选的引擎在 Live 中建会话，返回草稿与 Live 中的项
export function startOptimize(id: string, engine: 'codex' | 'claude') {
  return call<{ draft: { id: string }; live: { id: string } }>(
    'POST',
    `/api/analyses/${id}/optimize`,
    { engine },
  );
}

export function cancelAnalysis(id: string) {
  return call<{ id: string }>('POST', `/api/analyses/${id}/cancel`);
}

// 另存为 variant（Contracts 15.3、19.3）：名字与描述必填，不构建
export function saveAnalysisVariant(
  id: string,
  body: { name: string; description: string; files: { path: string; content: string }[] },
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
