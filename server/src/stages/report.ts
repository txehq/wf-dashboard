import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  liveProcesses,
  requests,
  runs,
  sessions,
  stageStates,
  stageCycles,
  stageSpans,
  stageStatuses,
  terminalRunStatuses,
  userMessages,
  variants,
  type StageStatus,
} from '../db/schema.js';
import { events } from '../events.js';
import { definitionHash, loadWorkflow } from '../workflows/index.js';
import { BUILTIN_WORKFLOWS, isBuiltinWorkflow } from '../workflows/schema.js';
import {
  type Cycle,
  cyclesOf,
  Evidence,
  foldStages,
  initialStageState,
  type Partition,
  StageState,
  stageItems,
} from './partition.js';
import { loadSessionRows, type RequestRow, type SessionRows } from './rows.js';

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
  // 这个阶段被调用的次数（repeatable 的小阶段为修复轮数）
  entries: z.number(),
  evidence: Evidence.nullable(),
  stats: StageStats,
});
export type StageView = z.infer<typeof StageView>;

export const WorkflowCycle = z.object({
  index: z.number(),
  label: z.string(),
  startSeq: z.number(),
  endSeq: z.number(),
  stages: z.array(StageView),
});
export type WorkflowCycle = z.infer<typeof WorkflowCycle>;

// 一个 workflow 的全部轮次；session 中没有这个 workflow 时 cycles 为空
export const WorkflowCycles = z.object({
  workflow: z.string(),
  cycles: z.array(WorkflowCycle),
});
export type WorkflowCycles = z.infer<typeof WorkflowCycles>;

export const StageReport = z.object({
  sessionId: z.string(),
  // 划分所用的 workflow（Contracts 16.6），按 lfg、ic、其他的顺序
  workflows: z.array(WorkflowCycles),
  outside: StageStats,
});
export type StageReport = z.infer<typeof StageReport>;

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

// 各轮各阶段加上统计；不在任何阶段区间内的主请求为 outside
function reportOf(rows: SessionRows, partition: Partition, cycles: Cycle[]): StageReport {
  const view = (c: Cycle): WorkflowCycle => ({
    index: c.index,
    label: c.label,
    startSeq: c.startSeq,
    endSeq: c.endSeq,
    stages: c.spans.map((s) => ({
      ...s,
      stats: statsOf(
        rows,
        rows.main.filter((r) => inRange(r.seq, s.startSeq, s.endSeq)),
      ),
    })),
  });
  const spans = cycles.flatMap((c) => c.spans);
  const outside = rows.main.filter((r) => !spans.some((s) => inRange(r.seq, s.startSeq, s.endSeq)));
  return StageReport.parse({
    sessionId: rows.sessionId,
    workflows: partition.map((w) => ({
      workflow: w.id,
      cycles: cycles.filter((c) => c.workflow === w.id).map(view),
    })),
    outside: statsOf(rows, outside),
  });
}

// 一次算出整个 session 的阶段划分（与导入时增量写入的结果相同）；finished 见 cyclesOf
export function stageReport(partition: Partition, rows: SessionRows, finished: boolean): StageReport {
  const lastSeq = rows.main.at(-1)?.seq ?? -1;
  const state = foldStages(
    partition,
    initialStageState(),
    stageItems(partition, rows.main, rows.userMessages),
  );
  return reportOf(rows, partition, cyclesOf(partition, state, lastSeq, finished));
}

// session 属于已到终态的 run
export function runFinished(db: Db, sessionId: string): boolean {
  const run = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .get();
  return run !== undefined && terminalRunStatuses.includes(run.status);
}

// session 所用的 variant：run 的 session 用 run 的 variant；交互的 session 用该项最近一次进程所用的 variant；
// 其余为 session 绑定的 variant（可能为空）
function sessionVariantId(db: Db, sessionId: string): string | null {
  const session = db
    .select({ runId: sessions.runId, liveId: sessions.liveId, variantId: sessions.variantId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (session === undefined) throw new Error(`session ${sessionId} 不存在`);
  const run =
    session.runId === null
      ? undefined
      : db.select({ variantId: runs.variantId }).from(runs).where(eq(runs.id, session.runId)).get();
  const live =
    session.liveId === null
      ? undefined
      : db
          .select({ variantId: liveProcesses.variantId })
          .from(liveProcesses)
          .where(eq(liveProcesses.liveId, session.liveId))
          .orderBy(desc(liveProcesses.id))
          .limit(1)
          .get();
  return run?.variantId ?? live?.variantId ?? session.variantId;
}

// 划分 session 所用的定义（Contracts 16.6）：所用的 variant 属于其他 workflow 时只按那个 workflow 划分；
// 属于内置的 lfg 或 ic，或没有 variant 时同时按 lfg 与 ic 划分
export function sessionPartition(db: Db, sessionId: string): Partition {
  const variantId = sessionVariantId(db, sessionId);
  const workflowId =
    variantId === null
      ? undefined
      : db
          .select({ workflowId: variants.workflowId })
          .from(variants)
          .where(eq(variants.id, variantId))
          .get()?.workflowId;
  if (workflowId !== undefined && !isBuiltinWorkflow(workflowId))
    return [loadWorkflow(db, workflowId)];
  return BUILTIN_WORKFLOWS.map((id) => loadWorkflow(db, id));
}

export interface StageChange {
  workflow: string;
  stage: string;
  status: StageStatus;
}

// stage_states.state：折叠状态加上划分所用的各 workflow 与其定义的 hash
const SavedState = StageState.extend({
  workflows: z.array(z.object({ id: z.string(), hash: z.string() })),
});

const definitionsOf = (partition: Partition) =>
  partition.map((w) => ({ id: w.id, hash: definitionHash(w) }));

const spanKey = (workflow: string, cycle: number, stage: string) =>
  `${workflow}:${String(cycle)}:${stage}`;

// 把 session 新增的主请求折叠进已保存的状态，重写 stage_cycles 与 stage_spans，返回状态变化的阶段。
// 最后一条请求在一轮结束前还可能追加 content block：已保存的状态只折叠到它之前，它与之后的命令每次重新折叠。
// 划分所用的 workflow 或其定义与保存时不同时从头折叠
export function updateStages(db: Db, sessionId: string): StageChange[] {
  // run 的 claude 还没有写出 jsonl：session 还没有导入，没有可划分的请求
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get())
    return [];
  const partition = sessionPartition(db, sessionId);
  const definitions = definitionsOf(partition);
  const stored = db.select().from(stageStates).where(eq(stageStates.sessionId, sessionId)).get();
  const parsed = stored === undefined ? undefined : SavedState.parse(stored.state);
  const saved =
    parsed !== undefined && JSON.stringify(parsed.workflows) === JSON.stringify(definitions)
      ? { ...stored, state: parsed }
      : undefined;
  const foldedSeq = saved?.foldedSeq ?? -1;
  const foldedAt = saved?.foldedAt ?? null;
  const fresh = db
    .select({ seq: requests.seq, timestamp: requests.timestamp, toolCalls: requests.toolCalls })
    .from(requests)
    .where(
      and(eq(requests.sessionId, sessionId), isNull(requests.agentId), gt(requests.seq, foldedSeq)),
    )
    .orderBy(asc(requests.seq))
    .all();
  const last = fresh.at(-1);
  if (last === undefined) return [];
  const users = db
    .select({ kind: userMessages.kind, timestamp: userMessages.timestamp, text: userMessages.text })
    .from(userMessages)
    .where(
      and(
        eq(userMessages.sessionId, sessionId),
        isNull(userMessages.agentId),
        eq(userMessages.kind, 'user'),
        foldedAt === null ? undefined : gt(userMessages.timestamp, foldedAt),
      ),
    )
    .orderBy(asc(userMessages.timestamp))
    .all();
  const complete = fresh.slice(0, -1);
  const state = foldStages(
    partition,
    saved === undefined ? initialStageState() : { cycles: saved.state.cycles },
    stageItems(partition, complete, users),
  );
  const committedAt = complete.at(-1)?.timestamp ?? foldedAt;
  const shown = foldStages(
    partition,
    state,
    stageItems(
      partition,
      [last],
      users.filter((u) => committedAt === null || u.timestamp > committedAt),
    ),
  );
  const cycles = cyclesOf(partition, shown, last.seq, runFinished(db, sessionId));
  const values = {
    state: { ...state, workflows: definitions },
    foldedSeq: complete.at(-1)?.seq ?? foldedSeq,
    foldedAt: committedAt,
    updatedAt: new Date(),
  };
  // 没有变化时不重写（Runs 列表每次读取都会调用）
  if (
    saved?.foldedSeq === values.foldedSeq &&
    JSON.stringify(savedCycles(db, partition, sessionId)) === JSON.stringify(cycles)
  )
    return [];
  return db.transaction((tx) => {
    const before = new Map(
      tx
        .select()
        .from(stageSpans)
        .where(eq(stageSpans.sessionId, sessionId))
        .all()
        .map((s) => [spanKey(s.workflow, s.cycle, s.stage), s.status]),
    );
    tx.insert(stageStates)
      .values({ sessionId, ...values })
      .onConflictDoUpdate({ target: stageStates.sessionId, set: values })
      .run();
    tx.delete(stageSpans).where(eq(stageSpans.sessionId, sessionId)).run();
    tx.delete(stageCycles).where(eq(stageCycles.sessionId, sessionId)).run();
    const changes: StageChange[] = [];
    for (const c of cycles) {
      tx.insert(stageCycles)
        .values({
          sessionId,
          workflow: c.workflow,
          cycle: c.index,
          label: c.label,
          startSeq: c.startSeq,
          endSeq: c.endSeq,
        })
        .run();
      for (const s of c.spans) {
        tx.insert(stageSpans)
          .values({ sessionId, workflow: c.workflow, cycle: c.index, ...s })
          .run();
        if (before.get(spanKey(c.workflow, c.index, s.stage)) !== s.status)
          changes.push({ workflow: c.workflow, stage: s.stage, status: s.status });
      }
    }
    return changes;
  });
}

export function publishStageChanges(sessionId: string, changes: StageChange[]) {
  for (const change of changes) events.publish({ type: 'stage.changed', sessionId, ...change });
}

// stage_cycles 与 stage_spans 中保存的各轮，形状与 cyclesOf 相同
function savedCycles(db: Db, partition: Partition, sessionId: string): Cycle[] {
  const cycles = db.select().from(stageCycles).where(eq(stageCycles.sessionId, sessionId)).all();
  const spans = db.select().from(stageSpans).where(eq(stageSpans.sessionId, sessionId)).all();
  const order = (workflow: string) =>
    partition.find((w) => w.id === workflow)?.stages.map((s) => s.id) ?? [];
  return cycles
    .sort((a, b) => a.startSeq - b.startSeq || a.id - b.id)
    .map((c) => ({
      workflow: c.workflow,
      index: c.cycle,
      label: c.label,
      startSeq: c.startSeq,
      endSeq: c.endSeq,
      spans: spans
        .filter((s) => s.workflow === c.workflow && s.cycle === c.cycle)
        .sort((a, b) => order(c.workflow).indexOf(a.stage) - order(c.workflow).indexOf(b.stage))
        .map((s) => ({
          stage: s.stage,
          status: s.status,
          startSeq: s.startSeq,
          endSeq: s.endSeq,
          entries: s.entries,
          evidence: s.evidence ?? null,
        })),
    }));
}

// 已保存的阶段划分加上统计；导入早于阶段划分的 session 在这里补算。
// session 还没有导入（run 的 claude 还没写出 jsonl）时为 null
export function readReport(db: Db, sessionId: string): StageReport | null {
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get())
    return null;
  const rows = loadSessionRows(db, sessionId);
  publishStageChanges(sessionId, updateStages(db, sessionId));
  const partition = sessionPartition(db, sessionId);
  return reportOf(rows, partition, savedCycles(db, partition, sessionId));
}
