import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  STAGE_ANALYSIS_VERSION,
  stageAnalyses,
  stageChecks,
  stageCycles,
  stageSpans,
  stageStatuses,
  workflows,
  type StageStatus,
} from '../db/schema.js';
import { events } from '../events.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from '../ingest/workflows.js';
import { judgeIcSession, type IcBoundary, type IcProgress } from './ic.js';
import { lfgOfflineBoundaries, type LfgBoundary } from './lfg.js';
import { loadSessionRows, type RequestRow, type SessionRows } from './rows.js';
import { IC_STAGES, LFG_STAGES, type LfgStage } from './workflow.js';

export const StageStats = z.object({
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
export type StageStats = z.infer<typeof StageStats>;

export const StageView = z.object({
  stage: z.string(),
  status: z.enum(stageStatuses),
  startSeq: z.number().nullable(),
  endSeq: z.number().nullable(),
  method: z.enum(['artifact', 'llm']),
  evidence: z.unknown(),
  stats: StageStats,
});
export type StageView = z.infer<typeof StageView>;

export const WorkflowCycle = z.object({
  index: z.number(),
  label: z.string(),
  startSeq: z.number(),
  endSeq: z.number().nullable(),
  stages: z.array(StageView),
});
export type WorkflowCycle = z.infer<typeof WorkflowCycle>;

export const StageReport = z.object({
  sessionId: z.string(),
  lfg: z.array(WorkflowCycle),
  ic: z.array(WorkflowCycle),
  outside: StageStats,
  checks: z.object({
    count: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  }),
});
export type StageReport = z.infer<typeof StageReport>;

export interface Span {
  stage: string;
  status: StageStatus;
  startSeq: number | null;
  endSeq: number | null;
  evidence: unknown;
}

export interface Cycle {
  label: string;
  startSeq: number;
  endSeq: number | null;
  spans: Span[];
}

// System Design 第 5 节最后一条，与 ingest 写入 sessions.has_lfg / has_ic 的规则相同：
// 每个标志所在的主 session 请求；用户以 <command-name> 启动时取其后的第一条请求
export function workflowMarks(rows: SessionRows): { lfg: number[]; ic: number[] } {
  const marks = { lfg: new Set<number>(), ic: new Set<number>() };
  const mark = (flags: WorkflowFlags, seq: number | undefined) => {
    if (seq === undefined) return;
    if (flags.lfg) marks.lfg.add(seq);
    if (flags.ic) marks.ic.add(seq);
  };
  for (const row of rows.main) {
    for (const call of row.toolCalls) mark(detectFromToolCall(call), row.seq);
  }
  for (const m of rows.userMessages) {
    if (m.kind !== 'user') continue;
    const next = rows.main.find((r) => r.timestamp.getTime() >= m.timestamp.getTime());
    mark(detectFromUserText(m.text), next?.seq);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { lfg: sorted(marks.lfg), ic: sorted(marks.ic) };
}

// 当前阶段之后没有请求时，active 阶段没有区间
function activeSpan(stage: string, cursor: number, lastSeq: number, evidence: unknown): Span {
  return cursor <= lastSeq
    ? { stage, status: 'active', startSeq: cursor, endSeq: lastSeq, evidence }
    : { stage, status: 'active', startSeq: null, endSeq: null, evidence };
}

// dispatch gate 的回答是 ticketing 写出 Tickets.md 之后的第一条用户消息；
// 这一轮在 agent 对回答的处理之后、下一条用户消息之前结束。还没有回答时返回 null
function gateEnd(rows: SessionRows, ticketingSeq: number): number | null {
  const at = rows.main.find((r) => r.seq === ticketingSeq)?.timestamp.getTime();
  if (at === undefined) throw new Error(`没有 seq ${String(ticketingSeq)} 的请求`);
  const users = rows.userMessages.filter((m) => m.kind === 'user' && m.timestamp.getTime() > at);
  const answer = users[0];
  if (answer === undefined) return null;
  const following = users[1];
  const before = rows.main.filter(
    (r) =>
      r.timestamp.getTime() > answer.timestamp.getTime() &&
      (following === undefined || r.timestamp.getTime() < following.timestamp.getTime()),
  );
  return before[before.length - 1]?.seq ?? ticketingSeq;
}

// 离线用 wf obsidian 边界；实时运行（runs 模块）用产物出现时的 seq
export function lfgCycle(
  rows: SessionRows,
  start: number,
  boundaries: { stage: LfgStage; seq: number }[],
  lastSeq: number,
) {
  const spans: Span[] = [];
  let cursor = start;
  let reachedEnd = false;
  let endSeq: number | null = null;
  for (const [i, stage] of LFG_STAGES.entries()) {
    if (reachedEnd) {
      spans.push({ stage, status: 'not-reached', startSeq: null, endSeq: null, evidence: null });
      continue;
    }
    const b = boundaries.find((x) => x.stage === stage && x.seq >= cursor);
    if (b) {
      if (stage === 'ticketing') {
        // ticketing 包括停在 dispatch gate 等待回答
        endSeq = gateEnd(rows, b.seq);
        spans.push({
          stage,
          status: 'done',
          startSeq: cursor,
          endSeq: endSeq ?? lastSeq,
          evidence: b,
        });
      } else {
        spans.push({ stage, status: 'done', startSeq: cursor, endSeq: b.seq, evidence: b });
      }
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
  return { spans, endSeq };
}

// 一轮从 lfg 标志开始，在 dispatch gate 的回答之后结束；结束之后的下一个标志开始下一轮
function lfgCycles(rows: SessionRows, marks: number[], boundaries: LfgBoundary[]): Cycle[] {
  const lastSeq = rows.main[rows.main.length - 1]?.seq ?? -1;
  const cycles: Cycle[] = [];
  let start = marks[0];
  while (start !== undefined) {
    const from = start;
    const { spans, endSeq } = lfgCycle(rows, from, boundaries, lastSeq);
    const brief = boundaries.find((b) => b.stage === 'interview' && b.seq >= from);
    cycles.push({
      label: brief === undefined ? `第 ${String(cycles.length + 1)} 轮` : featureOf(brief.path),
      startSeq: from,
      endSeq,
      spans,
    });
    if (endSeq === null) break;
    start = marks.find((m) => m > endSeq);
  }
  return cycles;
}

// Project X/Features/<slug>/Brief.md 的 slug
function featureOf(file: string): string {
  const parts = file.split('/');
  return parts[parts.length - 2] ?? file;
}

const TICKET_IN_LINEAR = /"(?:id|issueId|issue)":"([A-Z][A-Z0-9]*-\d+)"/;
const PR_NUMBER = [
  /\/pull\/(\d+)/,
  /\bgh\s+pr\s+(?:ready|view|checks|merge|edit|comment|review|diff)\s+(\d+)/,
  /--pr[\s=]+(\d+)/,
];

// 轮次标签：判定证据中的工单编号，其次 PR 编号
function icLabel(evidence: IcBoundary[], index: number): string {
  for (const b of evidence) {
    const ticket = /^mcp__[^:]*linear[^:]*:/.test(b.summary)
      ? TICKET_IN_LINEAR.exec(b.summary)
      : null;
    if (ticket?.[1]) return ticket[1];
  }
  for (const b of evidence) {
    for (const re of PR_NUMBER) {
      const m = re.exec(b.summary);
      if (m?.[1]) return `PR #${m[1]}`;
    }
  }
  return `第 ${String(index)} 轮`;
}

// 离开的那一条之前结束；离开的那一条本身仍属于这一轮（inclusive）时，到这一条所在的请求为止
export function cycleEnd(leave: IcBoundary): number {
  return leave.inclusive === true ? leave.seq : leave.seq - 1;
}

// 一轮 ic：进入的阶段之前的阶段 skipped；同一条上连续前进时中间的阶段 skipped；
// 离开时 ready-for-review 到离开那一条之前为止；session 结束时还在的阶段 active
export function icCycle(
  entries: IcBoundary[],
  leave: IcBoundary | undefined,
  lastSeq: number,
): Span[] {
  const first = entries[0];
  if (first === undefined) throw new Error('一轮至少有一个进入的阶段');
  const reached = new Map(entries.map((b) => [b.stage, b]));
  const last = entries[entries.length - 1] ?? first;
  return IC_STAGES.map((stage, i): Span => {
    const b = reached.get(stage);
    if (b === undefined) {
      return IC_STAGES.indexOf(first.stage as (typeof IC_STAGES)[number]) > i
        ? { stage, status: 'skipped', startSeq: first.seq, endSeq: first.seq - 1, evidence: null }
        : { stage, status: 'not-reached', startSeq: null, endSeq: null, evidence: null };
    }
    const evidence = { seq: b.seq, toolCallId: b.toolCallId, summary: b.summary };
    if (b === last) {
      if (leave !== undefined) {
        return {
          stage,
          status: 'done',
          startSeq: b.seq,
          endSeq: cycleEnd(leave),
          evidence,
        };
      }
      return activeSpan(stage, b.seq, lastSeq, evidence);
    }
    const next = entries[entries.indexOf(b) + 1];
    if (next === undefined) throw new Error('非最后一个阶段必须有下一阶段');
    return next.seq === b.seq
      ? { stage, status: 'skipped', startSeq: b.seq, endSeq: b.seq - 1, evidence }
      : { stage, status: 'done', startSeq: b.seq, endSeq: next.seq - 1, evidence };
  });
}

function icCycles(boundaries: IcBoundary[], lastSeq: number): Cycle[] {
  const byCycle = new Map<number, IcBoundary[]>();
  for (const b of boundaries) {
    if (b.cycle === 0) throw new Error('离线判定从流程外开始，不会有第 0 轮');
    byCycle.set(b.cycle, [...(byCycle.get(b.cycle) ?? []), b]);
  }
  return [...byCycle.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => {
      const entries = list.filter((b) => b.stage !== 'outside');
      const leave = list.find((b) => b.stage === 'outside');
      const first = entries[0];
      if (first === undefined) throw new Error(`第 ${String(index)} 轮没有进入的阶段`);
      return {
        label: icLabel(entries, index),
        startSeq: first.seq,
        endSeq: leave === undefined ? null : cycleEnd(leave),
        spans: icCycle(entries, leave, lastSeq),
      };
    });
}

function emptyStats(): StageStats {
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

// 一组主 session 请求的统计：子代理的请求计入其父调用所在的请求；
// 耗时为每段连续 seq 的第一条到最后一条请求的时间之和
function statsOf(rows: SessionRows, main: RequestRow[]): StageStats {
  const stats = emptyStats();
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
  let runStart: RequestRow | undefined;
  for (const [i, r] of main.entries()) {
    const prev = main[i - 1];
    if (prev === undefined || r.seq !== prev.seq + 1) runStart = r;
    const next = main[i + 1];
    if (next?.seq !== r.seq + 1 && runStart !== undefined) {
      stats.durationMs += r.timestamp.getTime() - runStart.timestamp.getTime();
    }
  }
  stats.subagents = agentIds.size;
  return stats;
}

function inRange(seq: number, startSeq: number | null, endSeq: number | null): boolean {
  return startSeq !== null && endSeq !== null && seq >= startSeq && seq <= endSeq;
}

function current<T extends { version: number }>(row: T | undefined): T | undefined {
  return row?.version === STAGE_ANALYSIS_VERSION ? row : undefined;
}

export function readReport(db: Db, sessionId: string): StageReport | null {
  const analysis = current(
    db.select().from(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).get(),
  );
  if (!analysis) return null;
  const rows = loadSessionRows(db, sessionId);
  const lastSeq = rows.main[rows.main.length - 1]?.seq ?? -1;
  const cyclesOf = (workflow: 'lfg' | 'ic', stages: readonly string[]): WorkflowCycle[] => {
    const spans = db
      .select()
      .from(stageSpans)
      .where(and(eq(stageSpans.sessionId, sessionId), eq(stageSpans.workflow, workflow)))
      .all();
    return db
      .select()
      .from(stageCycles)
      .where(and(eq(stageCycles.sessionId, sessionId), eq(stageCycles.workflow, workflow)))
      .all()
      .sort((a, b) => a.cycle - b.cycle)
      .map((c) => ({
        index: c.cycle,
        label: c.label,
        startSeq: c.startSeq,
        endSeq: c.endSeq,
        stages: spans
          .filter((s) => s.cycle === c.cycle)
          .sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage))
          .map((s) => ({
            stage: s.stage,
            status: s.status,
            startSeq: s.startSeq,
            endSeq: s.endSeq,
            method: s.method,
            evidence: s.evidence,
            stats: statsOf(
              rows,
              rows.main.filter((r) => inRange(r.seq, s.startSeq, s.endSeq)),
            ),
          })),
      }));
  };
  const lfg = cyclesOf('lfg', LFG_STAGES);
  const ic = cyclesOf('ic', IC_STAGES);
  const covered = [...lfg, ...ic];
  const outside = rows.main.filter(
    (r) => !covered.some((c) => inRange(r.seq, c.startSeq, c.endSeq ?? lastSeq)),
  );
  const checks = db
    .select()
    .from(stageChecks)
    .where(
      and(eq(stageChecks.sessionId, sessionId), eq(stageChecks.version, STAGE_ANALYSIS_VERSION)),
    )
    .all();
  return StageReport.parse({
    sessionId,
    lfg,
    ic,
    outside: statsOf(rows, outside),
    checks: {
      count: checks.length,
      inputTokens: checks.reduce((n, c) => n + c.inputTokens, 0),
      outputTokens: checks.reduce((n, c) => n + c.outputTokens, 0),
      costUsd: checks.reduce((n, c) => n + c.costUsd, 0),
    },
  });
}

// 在 cut 处结束一轮：cut 之后才开始的阶段为 not-reached；
// cut 的下一条请求所在的阶段（被打断时正在进行的阶段）为 interrupted，区间截到 cut
function interruptCycle(c: Cycle, cut: number, lastSeq: number): Cycle {
  const contains = (s: Span, seq: number) =>
    s.startSeq !== null && s.startSeq <= seq && seq <= (s.endSeq ?? lastSeq);
  const spans = c.spans.map((s): Span => {
    if (s.status === 'not-reached') return s;
    if (contains(s, cut + 1)) {
      return s.startSeq !== null && s.startSeq <= cut
        ? { ...s, status: 'interrupted', endSeq: cut }
        : { ...s, status: 'interrupted', startSeq: null, endSeq: null };
    }
    if (s.status === 'active' && s.startSeq === null) {
      return { ...s, status: 'interrupted' };
    }
    if (s.startSeq !== null && s.startSeq > cut) {
      return {
        stage: s.stage,
        status: 'not-reached',
        startSeq: null,
        endSeq: null,
        evidence: null,
      };
    }
    return s;
  });
  return { ...c, endSeq: cut, spans };
}

// 各轮次互斥：任一 workflow 的新一轮开始时，另一 workflow 正在进行的那一轮在新一轮开始之前结束
function exclusive(lfg: Cycle[], ic: Cycle[], lastSeq: number): { lfg: Cycle[]; ic: Cycle[] } {
  const all = [
    ...lfg.map((c, i) => ({ workflow: 'lfg' as const, i, c })),
    ...ic.map((c, i) => ({ workflow: 'ic' as const, i, c })),
  ].sort((a, b) => a.c.startSeq - b.c.startSeq);
  const out = { lfg: [...lfg], ic: [...ic] };
  // 按开始顺序处理；同一条请求上同时开始时排序在前的那一轮被结束
  for (const [j, next] of all.entries()) {
    for (const prev of all.slice(0, j)) {
      if (prev.workflow === next.workflow) continue;
      const p = out[prev.workflow][prev.i];
      if (p === undefined) throw new Error('轮次下标越界');
      if ((p.endSeq ?? lastSeq) >= next.c.startSeq) {
        out[prev.workflow][prev.i] = interruptCycle(p, next.c.startSeq - 1, lastSeq);
      }
    }
  }
  return out;
}

async function analyze(
  db: Db,
  sessionId: string,
  model: string,
  onProgress: (progress: IcProgress) => void,
): Promise<StageReport> {
  const rows = loadSessionRows(db, sessionId);
  const lastSeq = rows.main[rows.main.length - 1]?.seq ?? -1;
  const marks = workflowMarks(rows);
  const lfgJudged = lfgCycles(rows, marks.lfg, lfgOfflineBoundaries(rows.main, rows.cwd));
  let icJudged: Cycle[] = [];
  const icStart = marks.ic[0];
  if (icStart !== undefined) {
    const judged = await judgeIcSession(db, sessionId, rows.main, icStart, model, onProgress);
    icJudged = icCycles(judged.boundaries, lastSeq);
  }
  const { lfg, ic } = exclusive(lfgJudged, icJudged, lastSeq);
  db.transaction((tx) => {
    // 旧版本的判定结果整体替换
    tx.delete(stageSpans).where(eq(stageSpans.sessionId, sessionId)).run();
    tx.delete(stageCycles).where(eq(stageCycles.sessionId, sessionId)).run();
    tx.delete(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).run();
    const insert = (workflow: 'lfg' | 'ic', method: 'artifact' | 'llm', cycles: Cycle[]) => {
      for (const [i, c] of cycles.entries()) {
        const cycle = i + 1;
        tx.insert(stageCycles)
          .values({
            sessionId,
            workflow,
            cycle,
            label: c.label,
            startSeq: c.startSeq,
            endSeq: c.endSeq,
          })
          .run();
        for (const s of c.spans) {
          tx.insert(stageSpans)
            .values({ sessionId, workflow, cycle, method, ...s })
            .run();
        }
      }
    };
    insert('lfg', 'artifact', lfg);
    insert('ic', 'llm', ic);
    tx.insert(stageAnalyses)
      .values({
        sessionId,
        version: STAGE_ANALYSIS_VERSION,
        hasLfg: lfg.length > 0,
        hasIc: ic.length > 0,
      })
      .run();
  });
  const report = readReport(db, sessionId);
  if (!report) throw new Error(`session ${sessionId} 判定后没有读到结果`);
  return report;
}

export const AnalysisProgress = z.object({
  workflow: z.enum(workflows),
  batchesDone: z.number(),
  batchesTotal: z.number(),
  costUsd: z.number(),
});
export type AnalysisProgress = z.infer<typeof AnalysisProgress>;

export const AnalysisState = z.object({
  status: z.enum(['idle', 'running', 'failed', 'done']),
  progress: AnalysisProgress.nullable(),
  error: z.string().nullable(),
});
export type AnalysisState = z.infer<typeof AnalysisState>;

interface Job {
  promise: Promise<StageReport>;
  state: { progress: AnalysisProgress | null };
}

// 进行中的判定；同一 session 同时只有一个
const jobs = new Map<string, Job>();
// 最近一次失败的原文与失败时的进度，下一次判定开始时清除
const failures = new Map<string, { error: string; progress: AnalysisProgress | null }>();

function startJob(db: Db, sessionId: string, model: string): Job {
  const running = jobs.get(sessionId);
  if (running) return running;
  failures.delete(sessionId);
  const state: Job['state'] = { progress: null };
  // 只有 /ic 逐批调用模型；lfg 按产物判定，没有批次
  const promise = analyze(db, sessionId, model, (p) => {
    const progress: AnalysisProgress = { workflow: 'ic', ...p };
    state.progress = progress;
    events.publish({ type: 'stage.progress', sessionId, ...progress });
  });
  const job = { promise, state };
  jobs.set(sessionId, job);
  promise.then(
    () => {
      jobs.delete(sessionId);
      events.publish({ type: 'stage.analyzed', sessionId });
    },
    (err: unknown) => {
      jobs.delete(sessionId);
      const error = err instanceof Error ? err.message : String(err);
      failures.set(sessionId, { error, progress: state.progress });
      console.error(`session ${sessionId} 阶段判定失败`, err);
      events.publish({ type: 'stage.failed', sessionId, error });
    },
  );
  return job;
}

function isAnalyzed(db: Db, sessionId: string): boolean {
  return (
    current(db.select().from(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).get()) !==
    undefined
  );
}

// 等待判定完成：已按当前版本判定过的 session 直接返回已有结果；进行中的判定共用。
// model 为 ic 判定所用的模型，由调用方传入当前设置值
export function analyzeSession(db: Db, sessionId: string, model: string): Promise<StageReport> {
  const existing = readReport(db, sessionId);
  if (existing) return Promise.resolve(existing);
  return startJob(db, sessionId, model).promise;
}

// POST /analyze：已判定过返回结果；否则在后台开始（或沿用进行中的）判定，返回当前进度
export function startAnalysis(
  db: Db,
  sessionId: string,
  model: string,
): StageReport | { status: 'running'; progress: AnalysisProgress | null } {
  const existing = readReport(db, sessionId);
  if (existing) return existing;
  return { status: 'running', progress: startJob(db, sessionId, model).state.progress };
}

export function analysisState(db: Db, sessionId: string): AnalysisState {
  const job = jobs.get(sessionId);
  if (job) return { status: 'running', progress: job.state.progress, error: null };
  if (isAnalyzed(db, sessionId)) return { status: 'done', progress: null, error: null };
  const failure = failures.get(sessionId);
  if (failure !== undefined) return { status: 'failed', ...failure };
  return { status: 'idle', progress: null, error: null };
}
