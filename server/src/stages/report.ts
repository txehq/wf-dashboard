import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { stageAnalyses, stageChecks, stageSpans, type StageStatus } from '../db/schema.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from '../ingest/workflows.js';
import { judgeIcSession, type IcBoundary } from './ic.js';
import { lfgOfflineBoundaries, type LfgBoundary } from './lfg.js';
import { loadSessionRows, type SessionRows } from './rows.js';
import { IC_STAGES, LFG_STAGES } from './workflow.js';

const StageStats = z.object({
  requests: z.number(),
  toolCalls: z.record(z.string(), z.number()),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  subagents: z.number(),
});

export const StageView = z.object({
  stage: z.string(),
  status: z.enum(['done', 'active', 'skipped', 'not-reached']),
  startSeq: z.number().nullable(),
  endSeq: z.number().nullable(),
  method: z.enum(['artifact', 'llm']),
  evidence: z.unknown(),
  stats: StageStats,
});
export type StageView = z.infer<typeof StageView>;

export const StageReport = z.object({
  sessionId: z.string(),
  lfg: z.array(StageView).nullable(),
  ic: z.array(StageView).nullable(),
  checks: z.object({
    count: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  }),
});
export type StageReport = z.infer<typeof StageReport>;

interface Span {
  stage: string;
  status: StageStatus;
  startSeq: number | null;
  endSeq: number | null;
  evidence: unknown;
}

// System Design 第 5 节最后一条，与 ingest 写入 sessions.has_lfg / has_ic 的规则相同：
// 返回各 workflow 第一个标志所在的主 session 请求；用户以 <command-name> 启动时取其后的第一条请求
export function workflowStarts(rows: SessionRows): { lfg: number | null; ic: number | null } {
  const starts: { lfg: number | null; ic: number | null } = { lfg: null, ic: null };
  const mark = (flags: WorkflowFlags, seq: number | undefined) => {
    if (seq === undefined) return;
    if (flags.lfg && (starts.lfg === null || seq < starts.lfg)) starts.lfg = seq;
    if (flags.ic && (starts.ic === null || seq < starts.ic)) starts.ic = seq;
  };
  for (const row of rows.main) {
    for (const call of row.toolCalls) mark(detectFromToolCall(call), row.seq);
  }
  for (const m of rows.userMessages) {
    if (m.kind !== 'user') continue;
    const next = rows.main.find((r) => r.timestamp.getTime() >= m.timestamp.getTime());
    mark(detectFromUserText(m.text), next?.seq);
  }
  return starts;
}

// 当前阶段之后没有请求时，active 阶段没有区间
function activeSpan(stage: string, cursor: number, lastSeq: number, evidence: unknown): Span {
  return cursor <= lastSeq
    ? { stage, status: 'active', startSeq: cursor, endSeq: lastSeq, evidence }
    : { stage, status: 'active', startSeq: null, endSeq: null, evidence };
}

function lfgSpans(start: number, boundaries: LfgBoundary[], lastSeq: number): Span[] {
  const spans: Span[] = [];
  let cursor = start;
  let reachedEnd = false;
  for (const [i, stage] of LFG_STAGES.entries()) {
    if (reachedEnd) {
      spans.push({ stage, status: 'not-reached', startSeq: null, endSeq: null, evidence: null });
      continue;
    }
    const b = boundaries.find((x) => x.stage === stage && x.seq >= cursor);
    if (b) {
      spans.push({ stage, status: 'done', startSeq: cursor, endSeq: b.seq, evidence: b });
      cursor = b.seq + 1;
      continue;
    }
    const later = LFG_STAGES.slice(i + 1).find((s) =>
      boundaries.some((x) => x.stage === s && x.seq >= cursor),
    );
    if (later !== undefined) {
      const evidence = stage === 'plan' ? { note: '未检测到锁定标记' } : null;
      spans.push({ stage, status: 'skipped', startSeq: cursor, endSeq: cursor - 1, evidence });
      continue;
    }
    spans.push(activeSpan(stage, cursor, lastSeq, null));
    reachedEnd = true;
  }
  return spans;
}

function icSpans(start: number, boundaries: IcBoundary[], lastSeq: number): Span[] {
  const starts = new Map<string, IcBoundary | null>([['claim', null]]);
  for (const b of boundaries) starts.set(b.stage, b);
  const seqOf = (stage: string) => {
    const b = starts.get(stage);
    return b === undefined ? undefined : (b?.seq ?? start);
  };
  return IC_STAGES.map((stage, i): Span => {
    const s = seqOf(stage);
    if (s === undefined) {
      return { stage, status: 'not-reached', startSeq: null, endSeq: null, evidence: null };
    }
    const evidence = starts.get(stage) ?? null;
    const next = IC_STAGES[i + 1];
    const nextSeq = next === undefined ? undefined : seqOf(next);
    if (nextSeq === undefined) {
      if (stage === 'ready-for-review') {
        return { stage, status: 'done', startSeq: s, endSeq: lastSeq, evidence };
      }
      return activeSpan(stage, s, lastSeq, evidence);
    }
    if (nextSeq === s) {
      return { stage, status: 'skipped', startSeq: s, endSeq: s - 1, evidence };
    }
    return { stage, status: 'done', startSeq: s, endSeq: nextSeq - 1, evidence };
  });
}

function emptyStats(): z.infer<typeof StageStats> {
  return {
    requests: 0,
    toolCalls: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    subagents: 0,
  };
}

// 子代理的请求计入其父调用所在阶段；耗时为阶段内第一条到最后一条主 session 请求的时间
function statsOf(rows: SessionRows, startSeq: number | null, endSeq: number | null) {
  const stats = emptyStats();
  if (startSeq === null || endSeq === null || endSeq < startSeq) return stats;
  const main = rows.main.filter((r) => r.seq >= startSeq && r.seq <= endSeq);
  const agentIds = new Set(
    main.flatMap((r) => r.toolCalls.map((c) => c.subagentId).filter((id) => id !== null)),
  );
  const all = [...main, ...rows.subagent.filter((r) => agentIds.has(r.agentId ?? ''))];
  for (const r of all) {
    stats.requests += 1;
    stats.inputTokens += r.inputTokens;
    stats.outputTokens += r.outputTokens;
    stats.cacheReadTokens += r.cacheReadTokens;
    stats.cacheCreationTokens += r.cacheCreationTokens;
    stats.costUsd += r.costUsd;
    for (const c of r.toolCalls) stats.toolCalls[c.name] = (stats.toolCalls[c.name] ?? 0) + 1;
  }
  const first = main[0];
  const last = main[main.length - 1];
  if (first && last) stats.durationMs = last.timestamp.getTime() - first.timestamp.getTime();
  stats.subagents = agentIds.size;
  return stats;
}

export function readReport(db: Db, sessionId: string): StageReport | null {
  const analysis = db
    .select()
    .from(stageAnalyses)
    .where(eq(stageAnalyses.sessionId, sessionId))
    .get();
  if (!analysis) return null;
  const rows = loadSessionRows(db, sessionId);
  const order = (workflow: 'lfg' | 'ic', stages: readonly string[]): StageView[] =>
    db
      .select()
      .from(stageSpans)
      .where(and(eq(stageSpans.sessionId, sessionId), eq(stageSpans.workflow, workflow)))
      .all()
      .sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage))
      .map((s) => ({
        stage: s.stage,
        status: s.status,
        startSeq: s.startSeq,
        endSeq: s.endSeq,
        method: s.method,
        evidence: s.evidence,
        stats: statsOf(rows, s.startSeq, s.endSeq),
      }));
  const checks = db.select().from(stageChecks).where(eq(stageChecks.sessionId, sessionId)).all();
  return StageReport.parse({
    sessionId,
    lfg: analysis.hasLfg ? order('lfg', LFG_STAGES) : null,
    ic: analysis.hasIc ? order('ic', IC_STAGES) : null,
    checks: {
      count: checks.length,
      inputTokens: checks.reduce((n, c) => n + c.inputTokens, 0),
      outputTokens: checks.reduce((n, c) => n + c.outputTokens, 0),
      costUsd: checks.reduce((n, c) => n + c.costUsd, 0),
    },
  });
}

async function analyze(db: Db, sessionId: string): Promise<StageReport> {
  const rows = loadSessionRows(db, sessionId);
  const lastSeq = rows.main[rows.main.length - 1]?.seq ?? -1;
  const lfgBoundaries = lfgOfflineBoundaries(rows.main, rows.cwd);
  const starts = workflowStarts(rows);
  const lfg = starts.lfg === null ? null : lfgSpans(starts.lfg, lfgBoundaries, lastSeq);
  let ic: Span[] | null = null;
  if (starts.ic !== null) {
    const judged = await judgeIcSession(db, sessionId, rows.main, starts.ic);
    ic = icSpans(starts.ic, judged.boundaries, lastSeq);
  }
  db.transaction((tx) => {
    const insert = (workflow: 'lfg' | 'ic', method: 'artifact' | 'llm', spans: Span[]) => {
      for (const s of spans) {
        tx.insert(stageSpans)
          .values({ sessionId, workflow, method, ...s })
          .run();
      }
    };
    if (lfg) insert('lfg', 'artifact', lfg);
    if (ic) insert('ic', 'llm', ic);
    tx.insert(stageAnalyses)
      .values({ sessionId, hasLfg: lfg !== null, hasIc: ic !== null })
      .run();
  });
  const report = readReport(db, sessionId);
  if (!report) throw new Error(`session ${sessionId} 判定后没有读到结果`);
  return report;
}

const inFlight = new Map<string, Promise<StageReport>>();

// 离线判定入口：已判定过的 session 直接返回已有结果；同一 session 的并发请求共用一次判定
export function analyzeSession(db: Db, sessionId: string): Promise<StageReport> {
  const existing = readReport(db, sessionId);
  if (existing) return Promise.resolve(existing);
  let pending = inFlight.get(sessionId);
  if (!pending) {
    pending = analyze(db, sessionId).finally(() => inFlight.delete(sessionId));
    inFlight.set(sessionId, pending);
  }
  return pending;
}
