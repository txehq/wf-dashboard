import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  sessions,
  STAGE_ANALYSIS_VERSION,
  stageAnalyses,
  stageChecks,
  stageCycles,
  stageMethods,
  stageSpans,
  stageStatuses,
  workflows,
  type StageMethod,
  type StageStatus,
} from '../db/schema.js';
import type { ToolCall } from '../db/schema.js';
import { events } from '../events.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from '../ingest/workflows.js';
import { judgeIcSession, type IcBoundary, type IcProgress } from './ic.js';
import { lfgOfflineBoundaries, type LfgBoundary } from './lfg.js';
import { inputString, loadSessionRows, type RequestRow, type SessionRows } from './rows.js';
import { commandsOf } from './shell.js';
import { IC_STAGES, LFG_STAGES, type LfgStage } from './workflow.js';

export const StageStats = z.object({
  // 含子代理的请求
  requests: z.number(),
  // 只计主 session 的请求：各轮与 outside 的 mainRequests 之和等于主 agent 的请求总数
  mainRequests: z.number(),
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
  method: z.enum(stageMethods),
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
  method: StageMethod;
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
function activeSpan(
  stage: string,
  cursor: number,
  lastSeq: number,
  method: StageMethod,
  evidence: unknown,
): Span {
  return cursor <= lastSeq
    ? { stage, status: 'active', startSeq: cursor, endSeq: lastSeq, method, evidence }
    : { stage, status: 'active', startSeq: null, endSeq: null, method, evidence };
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
  // 回答之后还没有请求时，这一轮到回答之前的最后一条请求为止（不一定是写出 Tickets.md 的那一条）
  const before = rows.main.filter(
    (r) => following === undefined || r.timestamp.getTime() < following.timestamp.getTime(),
  );
  const last = before[before.length - 1];
  if (last === undefined)
    throw new Error(`dispatch gate 的回答之前没有请求（seq ${String(ticketingSeq)}）`);
  return last.seq;
}

// 离线用 wf obsidian 边界；实时运行（runs 模块）用产物出现时的 seq
export function lfgCycle(
  rows: SessionRows,
  start: number,
  boundaries: { stage: LfgStage; seq: number }[],
  lastSeq: number,
  // 这一轮从哪个阶段开始（Skill research 开始的一轮之前的阶段为 skipped）
  entered: LfgStage = 'interview',
) {
  const spans: Span[] = [];
  const method = 'artifact';
  let cursor = start;
  let reachedEnd = false;
  let endSeq: number | null = null;
  for (const [i, stage] of LFG_STAGES.entries()) {
    if (reachedEnd) {
      spans.push({
        stage,
        status: 'not-reached',
        startSeq: null,
        endSeq: null,
        method,
        evidence: null,
      });
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
          method,
          evidence: b,
        });
      } else {
        spans.push({ stage, status: 'done', startSeq: cursor, endSeq: b.seq, method, evidence: b });
      }
      cursor = b.seq + 1;
      continue;
    }
    const later = LFG_STAGES.slice(i + 1).find((s) =>
      boundaries.some((x) => x.stage === s && x.seq >= cursor),
    );
    if (later !== undefined || i < LFG_STAGES.indexOf(entered)) {
      const evidence = stage === 'plan' ? { note: '未检测到锁定标记' } : null;
      spans.push({
        stage,
        status: 'skipped',
        startSeq: cursor,
        endSeq: cursor - 1,
        method,
        evidence,
      });
      continue;
    }
    spans.push(activeSpan(stage, cursor, lastSeq, method, null));
    reachedEnd = true;
  }
  return { spans, endSeq };
}

// 标志所在的请求以哪个 lfg 阶段的 Skill 开始（Contracts 5：一轮从 /lfg 或首个 lfg 阶段开始）；
// /lfg、interview 或 wf obsidian 写出产物的标志从 interview 开始
function lfgEntry(rows: SessionRows, seq: number): LfgStage {
  const row = rows.main.find((r) => r.seq === seq);
  for (const call of row?.toolCalls ?? []) {
    if (call.name !== 'Skill') continue;
    const skill = inputString(call.input, 'skill');
    const stage = LFG_STAGES.find((s) => s === skill);
    if (stage !== undefined) return stage;
  }
  return 'interview';
}

// 一轮从 lfg 标志开始，在 dispatch gate 的回答之后结束；结束之后的下一个标志开始下一轮
function lfgCycles(rows: SessionRows, marks: number[], boundaries: LfgBoundary[]): Cycle[] {
  const lastSeq = rows.main[rows.main.length - 1]?.seq ?? -1;
  const cycles: Cycle[] = [];
  let start = marks[0];
  while (start !== undefined) {
    const from = start;
    const { spans, endSeq } = lfgCycle(rows, from, boundaries, lastSeq, lfgEntry(rows, from));
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
  const slug = file.split('/').at(-2);
  if (slug === undefined) throw new Error(`产物路径不在 Features/<slug>/ 下：${file}`);
  return slug;
}

const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;
const LINEAR_TOOL = /^mcp__.*linear.*__/i;
const PR_URL = /\/pull\/(\d+)\b/;

// 一次 tool 调用涉及的 PR 编号：gh pr <子命令> 的编号参数、--pr 参数，或输入中的 PR 链接
function prNumberOf(call: ToolCall): string | null {
  const command = call.name === 'Bash' ? inputString(call.input, 'command') : null;
  for (const argv of command === null ? [] : commandsOf(command)) {
    if (argv[0] === 'gh' && argv[1] === 'pr') {
      const number = argv.slice(3).find((w) => /^\d+$/.test(w));
      if (number !== undefined) return number;
    }
    for (const [i, w] of argv.entries()) {
      const value = w === '--pr' ? argv[i + 1] : w.startsWith('--pr=') ? w.slice(5) : undefined;
      if (value !== undefined && /^\d+$/.test(value)) return value;
    }
  }
  const strings = JSON.stringify(call.input);
  return PR_URL.exec(strings)?.[1] ?? null;
}

// 轮次标签：判定证据中 Linear 工具输入的工单编号，其次 PR 编号；证据按 toolCallId 找到原始的 tool 调用
function icLabel(evidence: IcBoundary[], index: number, calls: Map<string, ToolCall>): string {
  const evidenceCalls = evidence.map((b) => {
    const call = calls.get(b.toolCallId);
    if (call === undefined) throw new Error(`判定证据的 tool 调用 ${b.toolCallId} 不在 session 中`);
    return call;
  });
  for (const call of evidenceCalls) {
    if (!LINEAR_TOOL.test(call.name)) continue;
    for (const key of ['id', 'issueId', 'issue']) {
      const value = inputString(call.input, key);
      if (value !== null && TICKET.test(value)) return value;
    }
  }
  for (const call of evidenceCalls) {
    const pr = prNumberOf(call);
    if (pr !== null) return `PR #${pr}`;
  }
  return `第 ${String(index)} 轮`;
}

// 离开的那一条之前结束；离开的那一条本身仍属于这一轮（inclusive）时，到这一条所在的请求为止
export function cycleEnd(leave: IcBoundary): number {
  return leave.inclusive === true ? leave.seq : leave.seq - 1;
}

// 一轮 ic：进入的阶段之前的阶段 skipped；同一条上连续前进、或 Skill 调用越过的中间阶段 skipped；
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
  const evidenceOf = (b: IcBoundary) => ({
    seq: b.seq,
    toolCallId: b.toolCallId,
    summary: b.summary,
  });
  const order = (b: IcBoundary) => IC_STAGES.indexOf(b.stage as (typeof IC_STAGES)[number]);
  return IC_STAGES.map((stage, i): Span => {
    const b = reached.get(stage);
    if (b === undefined) {
      // 之后进入的第一个阶段：这一轮从它开始，或 Skill 调用越过了这个阶段
      const after = entries.find((e) => order(e) > i);
      if (after === undefined) {
        return {
          stage,
          status: 'not-reached',
          startSeq: null,
          endSeq: null,
          method: 'llm',
          evidence: null,
        };
      }
      return {
        stage,
        status: 'skipped',
        startSeq: after.seq,
        endSeq: after.seq - 1,
        method: after.method,
        evidence: after === first ? null : evidenceOf(after),
      };
    }
    const evidence = evidenceOf(b);
    const method = b.method;
    if (b === last) {
      if (leave !== undefined) {
        return {
          stage,
          status: 'done',
          startSeq: b.seq,
          endSeq: cycleEnd(leave),
          method,
          evidence,
        };
      }
      return activeSpan(stage, b.seq, lastSeq, method, evidence);
    }
    const next = entries[entries.indexOf(b) + 1];
    if (next === undefined) throw new Error('非最后一个阶段必须有下一阶段');
    return next.seq === b.seq
      ? { stage, status: 'skipped', startSeq: b.seq, endSeq: b.seq - 1, method, evidence }
      : { stage, status: 'done', startSeq: b.seq, endSeq: next.seq - 1, method, evidence };
  });
}

// main：主 session 的请求，轮次标签从判定证据对应的 tool 调用中读取
export function icCycles(boundaries: IcBoundary[], main: RequestRow[]): Cycle[] {
  const lastSeq = main[main.length - 1]?.seq ?? -1;
  const calls = new Map(main.flatMap((r) => r.toolCalls.map((c) => [c.id, c] as const)));
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
        label: icLabel(entries, index, calls),
        startSeq: first.seq,
        endSeq: leave === undefined ? null : cycleEnd(leave),
        spans: icCycle(entries, leave, lastSeq),
      };
    });
}

function emptyStats(): StageStats {
  return {
    requests: 0,
    mainRequests: 0,
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

// 一组主 session 请求的统计：子代理的请求计入其父调用所在的请求
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
  // 耗时：各条主请求的 duration_ms 之和（从触发它的用户消息或 tool_result 到它的最后一条记录）。
  // session 第一条请求之前没有触发记录时 duration_ms 为空，这一条不计入
  for (const r of main) stats.durationMs += r.durationMs ?? 0;
  stats.subagents = agentIds.size;
  stats.mainRequests = main.length;
  return stats;
}

function inRange(seq: number, startSeq: number | null, endSeq: number | null): boolean {
  return startSeq !== null && endSeq !== null && seq >= startSeq && seq <= endSeq;
}

// 有效的判定结果：当前版本的离线判定；dashboard 发起的 run 的 session 由实时判定写入，运行结束后不会重新判定，
// 不受版本号限制（版本提高后历史 run 的阶段与 Compare 的阶段成本照常可读）
function currentAnalysis(db: Db, sessionId: string) {
  const row = db.select().from(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).get();
  if (row === undefined) return undefined;
  if (row.version === STAGE_ANALYSIS_VERSION || isRunSession(db, sessionId)) return row;
  return undefined;
}

function isRunSession(db: Db, sessionId: string): boolean {
  const session = db
    .select({ runId: sessions.runId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return session?.runId != null;
}

// session 在判定之后继续增长时，未结束的轮次中最后一个进行中的阶段延伸到当前最后一条请求：
// 进行中（active）的阶段，或 ticketing 完成后仍停在 dispatch gate 的 ticketing。
// 判定时还没有请求的进行中阶段从上一阶段结束之后开始
function extendOpen<T extends Pick<Span, 'status' | 'startSeq' | 'endSeq'>>(
  spans: T[],
  cycleEnd: number | null,
  lastSeq: number,
): T[] {
  if (cycleEnd !== null) return spans;
  const open = spans.findLastIndex(
    (s) => s.status === 'active' || (s.status === 'done' && s.startSeq !== null),
  );
  return spans.map((s, i) => {
    if (i !== open) return s;
    const start = s.startSeq ?? (spans[i - 1]?.endSeq ?? -1) + 1;
    return start <= lastSeq ? { ...s, startSeq: start, endSeq: lastSeq } : s;
  });
}

export function readReport(db: Db, sessionId: string): StageReport | null {
  const analysis = currentAnalysis(db, sessionId);
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
        stages: extendOpen(
          spans
            .filter((s) => s.cycle === c.cycle)
            .sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage)),
          c.endSeq,
          lastSeq,
        ).map((s) => ({
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
      and(
        eq(stageChecks.sessionId, sessionId),
        isRunSession(db, sessionId) ? undefined : eq(stageChecks.version, STAGE_ANALYSIS_VERSION),
      ),
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
        method: s.method,
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
  // ic 判定先开始：它在第一次模型调用之前同步报告总批数，POST analyze 的响应带上这份进度
  const icStart = marks.ic[0];
  const icJudging =
    icStart === undefined
      ? null
      : judgeIcSession(db, sessionId, rows.main, icStart, model, onProgress);
  const lfgBoundaries = lfgOfflineBoundaries(rows.main, rows.cwd);
  const icJudged = await icJudging;
  const lfgJudged = lfgCycles(rows, marks.lfg, lfgBoundaries);
  const { lfg, ic } = exclusive(
    lfgJudged,
    icJudged === null ? [] : icCycles(icJudged.boundaries, rows.main),
    lastSeq,
  );
  db.transaction((tx) => {
    // 旧版本的判定结果整体替换
    tx.delete(stageSpans).where(eq(stageSpans.sessionId, sessionId)).run();
    tx.delete(stageCycles).where(eq(stageCycles.sessionId, sessionId)).run();
    tx.delete(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).run();
    const insert = (workflow: 'lfg' | 'ic', cycles: Cycle[]) => {
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
            .values({ sessionId, workflow, cycle, ...s })
            .run();
        }
      }
    };
    insert('lfg', lfg);
    insert('ic', ic);
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
  return currentAnalysis(db, sessionId) !== undefined;
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
