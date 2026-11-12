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
import { isWfWorkflow, WF_WORKFLOWS } from '../workflows/schema.js';
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
import { injectedSkillsOf, loadSessionRows, type RequestRow, type SessionRows } from './rows.js';

export const StageStats = z.object({
  // Including subagent requests
  requests: z.number(),
  // Main session requests only: the mainRequests of all cycles plus outside equal the main agent's total requests
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
  // How many times this stage was called (repair rounds for a repeatable stage)
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

// All cycles of one workflow; cycles is empty when the session has none of this workflow
export const WorkflowCycles = z.object({
  workflow: z.string(),
  cycles: z.array(WorkflowCycle),
});
export type WorkflowCycles = z.infer<typeof WorkflowCycles>;

export const StageReport = z.object({
  sessionId: z.string(),
  // The workflows used for the partition (Contracts 16.6), ordered lfg, ic, then others
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

// Stats of a set of main session requests: subagent requests count toward the request holding their parent call
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
  // Duration: the sum of each main request's duration_ms (from the user message or tool_result that triggered it to
  // its last record). Without a trigger record before the session's first request, duration_ms is null and not counted
  for (const r of main) stats.durationMs += r.durationMs ?? 0;
  stats.subagents = agentIds.size;
  stats.mainRequests = main.length;
  return stats;
}

function inRange(seq: number, startSeq: number | null, endSeq: number | null): boolean {
  return startSeq !== null && endSeq !== null && seq >= startSeq && seq <= endSeq;
}

// Every cycle and stage with stats; main requests outside every stage range are outside
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

// The stage partition of a whole session in one pass (same as what import writes incrementally); see cyclesOf for finished
export function stageReport(
  partition: Partition,
  rows: SessionRows,
  finished: boolean,
): StageReport {
  const lastSeq = rows.main.at(-1)?.seq ?? -1;
  const state = foldStages(
    partition,
    initialStageState(),
    stageItems(partition, rows.main, rows.userMessages, rows.injectedSkills),
  );
  return reportOf(rows, partition, cyclesOf(partition, state, lastSeq, finished));
}

// The session belongs to a run in a final state
export function runFinished(db: Db, sessionId: string): boolean {
  const run = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .get();
  return run !== undefined && terminalRunStatuses.includes(run.status);
}

// The session's variant: a run's session uses the run's variant; an interactive session uses the variant of the
// latest process of its Live item; otherwise the variant bound to the session (may be null)
function sessionVariantId(db: Db, sessionId: string): string | null {
  const session = db
    .select({ runId: sessions.runId, liveId: sessions.liveId, variantId: sessions.variantId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (session === undefined) throw new Error(`Session ${sessionId} does not exist`);
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

// The definitions used to partition a session (Contracts 16.6): when its variant belongs to another workflow, only
// that workflow; when it belongs to built-in lfg or ic, or there is no variant, lfg and ic together
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
  if (workflowId !== undefined && !isWfWorkflow(workflowId)) return [loadWorkflow(db, workflowId)];
  return WF_WORKFLOWS.map((id) => loadWorkflow(db, id));
}

export interface StageChange {
  workflow: string;
  stage: string;
  status: StageStatus;
}

// Version of the fold rules: when the rules change, previously saved state is folded again from the start
const STAGE_RULES = 2;

// stage_states.state: the folded state plus the rules version, and the partition's workflows with their definition
// hashes. Read only the version and workflows first
const Definitions = z.array(z.object({ id: z.string(), hash: z.string() }));
const SavedHeader = z.looseObject({ rules: z.number().optional(), workflows: Definitions });
const SavedState = StageState.extend({ rules: z.literal(STAGE_RULES), workflows: Definitions });

const definitionsOf = (partition: Partition) =>
  partition.map((w) => ({ id: w.id, hash: definitionHash(w) }));

const spanKey = (workflow: string, cycle: number, stage: string) =>
  `${workflow}:${String(cycle)}:${stage}`;

// Folds the session's new main requests into the saved state, rewrites stage_cycles and stage_spans, and returns the
// stages whose status changed. The last request may still get content blocks before its turn ends: the saved state
// folds only up to before it, and it and the commands after it are folded again each time. When the partition's
// workflows or their definitions, or the rules version, differ from the saved ones, fold from the start
export function updateStages(db: Db, sessionId: string): StageChange[] {
  // The run's claude has not written its jsonl yet: the session is not imported, nothing to partition
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get())
    return [];
  const partition = sessionPartition(db, sessionId);
  const definitions = definitionsOf(partition);
  const stored = db.select().from(stageStates).where(eq(stageStates.sessionId, sessionId)).get();
  const header = stored === undefined ? undefined : SavedHeader.parse(stored.state);
  const saved =
    stored !== undefined &&
    header?.rules === STAGE_RULES &&
    JSON.stringify(header.workflows) === JSON.stringify(definitions)
      ? { ...stored, state: SavedState.parse(stored.state) }
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
  const injected = injectedSkillsOf(db, sessionId, foldedAt);
  const complete = fresh.slice(0, -1);
  const state = foldStages(
    partition,
    saved === undefined ? initialStageState() : { cycles: saved.state.cycles },
    stageItems(partition, complete, users, injected),
  );
  const committedAt = complete.at(-1)?.timestamp ?? foldedAt;
  const after = (t: Date) => committedAt === null || t > committedAt;
  const shown = foldStages(
    partition,
    state,
    stageItems(
      partition,
      [last],
      users.filter((u) => after(u.timestamp)),
      injected.filter((s) => after(s.timestamp)),
    ),
  );
  const cycles = cyclesOf(partition, shown, last.seq, runFinished(db, sessionId));
  const values = {
    state: { ...state, rules: STAGE_RULES, workflows: definitions },
    foldedSeq: complete.at(-1)?.seq ?? foldedSeq,
    foldedAt: committedAt,
    updatedAt: new Date(),
  };
  // No rewrite when nothing changed (the Runs list calls this on every read)
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

// The cycles saved in stage_cycles and stage_spans, shaped like cyclesOf
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

// The saved stage partition with stats; sessions imported before stage partitioning existed are computed here.
// null when the session is not imported yet (the run's claude has not written its jsonl)
export function readReport(db: Db, sessionId: string): StageReport | null {
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get())
    return null;
  const rows = loadSessionRows(db, sessionId);
  publishStageChanges(sessionId, updateStages(db, sessionId));
  const partition = sessionPartition(db, sessionId);
  return reportOf(rows, partition, savedCycles(db, partition, sessionId));
}
