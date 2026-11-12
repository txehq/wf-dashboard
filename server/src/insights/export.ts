import fs from 'node:fs';
import path from 'node:path';
import { getTokenizer } from '@anthropic-ai/tokenizer';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  artifacts,
  requests,
  runMessages,
  runs,
  sessions,
  sessionSkills,
  subagents,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { readPrSnapshot } from '../external/github.js';
import { readRunGrades } from '../grading/index.js';
import { StoredPrSnapshot } from '../grading/pr-snapshot.js';
import { sessionConversation } from '../ingest/conversation.js';
import { resultText } from '../ingest/ingest.js';
import { AnyRecord, UserRecord } from '../ingest/records.js';
import { readReport, type StageReport } from '../stages/report.js';
import { loadTask } from '../tasks/loader.js';
import { displayUserText } from '../api/user-text.js';
import { sessionTitles } from '../api/session-titles.js';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { codexDetails, type ExportedInstructions } from './codex-export.js';

// Contracts 15.2: contents of the analysis dir input/. sessions/<id>.jsonl has one request per line (main agent and subagents), untruncated

export interface ExportedToolCall {
  id: string;
  name: string;
  input: unknown;
  result: string | null;
  isError: boolean;
  // Full content of the file when the result spilled to tool-results/
  spilledOutput: string | null;
  subagentId: string | null;
}

export interface ExportedThinking {
  type: ThinkingType;
  tokens: number;
}

export interface ExportedRow {
  seq: number;
  agent: string | null;
  // The main agent's own seq; for a subagent, the seq of the main-agent request that started it
  parentSeq: number;
  stage: string | null;
  timestamp: string;
  durationMs: number | null;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
  attributionSkill: string | null;
  userMessagesBefore: { kind: 'user' | 'notice'; text: string }[];
  skillLoads: { name: string; args: string }[];
  // Only the type and estimated tokens, without thinking text or signature; null when there are no thinking blocks
  thinking: ExportedThinking[] | null;
  text: string | null;
  toolCalls: ExportedToolCall[];
}

// Read the original text of truncated tool results back from the jsonl
function fullResults(files: string[], ids: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.size === 0) return out;
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"tool_result"')) continue;
      const raw: unknown = JSON.parse(line);
      if (AnyRecord.parse(raw).type !== 'user') continue;
      const { content } = UserRecord.parse(raw).message;
      if (typeof content === 'string') continue;
      for (const block of content) {
        if (block.type === 'tool_result' && ids.has(block.tool_use_id)) {
          out.set(block.tool_use_id, resultText(block.content));
        }
      }
    }
  }
  const missing = [...ids].filter((id) => !out.has(id));
  if (missing.length > 0)
    throw new Error(
      `Original text of these tool results not found in the jsonl: ${missing.join(', ')}`,
    );
  return out;
}

const THINKING_TYPES = ['thinking', 'redacted_thinking'] as const;
type ThinkingType = (typeof THINKING_TYPES)[number];

const ThinkingRecord = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({
    id: z.string(),
    content: z.array(z.looseObject({ type: z.string() })),
  }),
});

// Thinking block types of these messages in one agent's jsonl, in order; the block text is not read
function thinkingTypes(file: string, messageIds: Set<string>): Map<string, ThinkingType[]> {
  const out = new Map<string, ThinkingType[]>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"thinking"') && !line.includes('"redacted_thinking"')) continue;
    const raw: unknown = JSON.parse(line);
    if (AnyRecord.parse(raw).type !== 'assistant') continue;
    const { message } = ThinkingRecord.parse(raw);
    if (!messageIds.has(message.id)) continue;
    for (const block of message.content) {
      const type = THINKING_TYPES.find((t) => t === block.type);
      if (type === undefined) continue;
      const types = out.get(message.id) ?? [];
      types.push(type);
      out.set(message.id, types);
    }
  }
  return out;
}

// Thinking block tokens: a request's output tokens minus the estimated tokens of reply text and tool call inputs, split evenly across its blocks.
// Claude Code records thinking text as a summary or empty string (signature only), so inferring from output tokens is closer to actual use
function estimateThinking(
  tokenizer: ReturnType<typeof getTokenizer>,
  row: { outputTokens: number; text: string | null; toolCalls: ToolCall[] },
  types: ThinkingType[],
): ExportedThinking[] {
  const count = (s: string) => tokenizer.encode(s.normalize('NFKC'), 'all').length;
  const visible =
    (row.text === null ? 0 : count(row.text)) +
    row.toolCalls.reduce((sum, c) => sum + count(c.name) + count(JSON.stringify(c.input)), 0);
  const total = Math.max(0, row.outputTokens - visible);
  const each = Math.floor(total / types.length);
  const rest = total - each * types.length;
  return types.map((type, i) => ({ type, tokens: each + (i < rest ? 1 : 0) }));
}

function stageLabels(report: StageReport): (seq: number) => string | null {
  const spans = report.workflows.flatMap(({ workflow, cycles }) =>
    cycles.flatMap((cycle) =>
      cycle.stages.flatMap((s) =>
        s.startSeq === null || s.endSeq === null || s.endSeq < s.startSeq
          ? []
          : [
              {
                from: s.startSeq,
                to: s.endSeq,
                label: `${workflow}#${String(cycle.index)} ${s.stage}`,
              },
            ],
      ),
    ),
  );
  return (seq) => spans.find((s) => seq >= s.from && seq <= s.to)?.label ?? null;
}

export interface SessionExport {
  rows: ExportedRow[];
  // Local-machine sessions are not split into stages (Contracts 25.4): null, and every stage is null
  report: StageReport | null;
  instructions: ExportedInstructions[];
}

// Claude Code sessions: truncated results, thinking blocks and instruction files are read back from the jsonl; thinking tokens are estimated from output
function claudeDetails(
  session: { filePath: string },
  subs: { agentId: string; filePath: string }[],
  rows: (typeof requests.$inferSelect)[],
  truncated: Set<string>,
) {
  const results = fullResults([session.filePath, ...subs.map((s) => s.filePath)], truncated);
  // Search each agent only in its own jsonl: a forked subagent's jsonl starts with a copy of the parent's conversation
  const idsOf = (agent: string | null) =>
    new Set(rows.filter((r) => r.agentId === agent).map((r) => r.messageId));
  const types = new Map<string | null, Map<string, ThinkingType[]>>([
    [null, thinkingTypes(session.filePath, idsOf(null))],
  ]);
  for (const s of subs) types.set(s.agentId, thinkingTypes(s.filePath, idsOf(s.agentId)));
  const tokenizer = getTokenizer();
  const thinking = new Map<(typeof rows)[number], ExportedThinking[]>();
  for (const r of rows) {
    const t = types.get(r.agentId)?.get(r.messageId);
    if (t !== undefined) thinking.set(r, estimateThinking(tokenizer, r, t));
  }
  tokenizer.free();
  const instructions = sessionInstructions(session.filePath).map((r) => ({
    timestamp: r.timestamp,
    files: r.attachment.files.map((f) => ({ path: f.path, type: f.type, content: f.content })),
  }));
  return { results, thinking, instructions };
}

export function exportSessionRows(db: Db, sessionId: string, withStages = true): SessionExport {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (session === undefined) throw new Error(`Session ${sessionId} not found`);
  const report = withStages ? readReport(db, sessionId) : null;
  if (withStages && report === null) throw new Error(`Session ${sessionId} has no stage split`);
  const stageOf = report === null ? () => null : stageLabels(report);
  const subs = db.select().from(subagents).where(eq(subagents.sessionId, sessionId)).all();
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  const messages = db
    .select()
    .from(userMessages)
    .where(eq(userMessages.sessionId, sessionId))
    .orderBy(asc(userMessages.timestamp), asc(userMessages.id))
    .all();
  const loads = db
    .select()
    .from(sessionSkills)
    .where(eq(sessionSkills.sessionId, sessionId))
    .orderBy(asc(sessionSkills.timestamp), asc(sessionSkills.id))
    .all();

  const truncated = new Set(
    rows.flatMap((r) =>
      r.toolCalls
        .filter((c) => c.result !== null && c.resultChars > c.result.length)
        .map((c) => c.id),
    ),
  );
  // Codex sessions (Contracts 25.2) have no subagents; read back from the rollout in the same format
  const details =
    session.engine === 'codex'
      ? (() => {
          const d = codexDetails(session.filePath, truncated);
          const thinking = new Map<(typeof rows)[number], ExportedThinking[]>();
          for (const r of rows) {
            const t = d.thinking.get(r.messageId);
            if (t !== undefined) thinking.set(r, t);
          }
          return { results: d.results, thinking, instructions: d.instructions };
        })()
      : claudeDetails(session, subs, rows, truncated);
  const full = details.results;

  // tool_use.id -> main-agent seq: a main-agent call is its own row; a subagent call follows the start chain back to the main agent
  const callSeq = new Map<string, number>();
  for (const r of rows)
    if (r.agentId === null) for (const c of r.toolCalls) callSeq.set(c.id, r.seq);
  const parentOfAgent = new Map(subs.map((s) => [s.agentId, s.parentToolUseId]));
  const agentRoot = (agentId: string, depth = 0): number => {
    const toolUseId = parentOfAgent.get(agentId);
    if (toolUseId === undefined) throw new Error(`Subagent ${agentId} is not registered`);
    const direct = callSeq.get(toolUseId);
    if (direct !== undefined) return direct;
    const owner = rows.find((r) => r.toolCalls.some((c) => c.id === toolUseId));
    if (owner?.agentId == null || depth > 20) {
      throw new Error(`Start call ${toolUseId} of subagent ${agentId} is not in the session`);
    }
    return agentRoot(owner.agentId, depth + 1);
  };

  // Each agent gets the user messages and skill loads since its previous request, by time
  const lastAt = new Map<string | null, number>();
  const exported = rows.map((r): ExportedRow => {
    const at = r.timestamp.getTime();
    const since = lastAt.get(r.agentId) ?? Number.NEGATIVE_INFINITY;
    lastAt.set(r.agentId, at);
    const inWindow = (m: { agentId: string | null; timestamp: Date }) =>
      m.agentId === r.agentId && m.timestamp.getTime() > since && m.timestamp.getTime() <= at;
    const parentSeq = r.agentId === null ? r.seq : agentRoot(r.agentId);
    return {
      seq: r.seq,
      agent: r.agentId,
      parentSeq,
      stage: stageOf(parentSeq),
      timestamp: r.timestamp.toISOString(),
      durationMs: r.durationMs,
      model: r.model,
      tokens: {
        input: r.inputTokens,
        output: r.outputTokens,
        cacheRead: r.cacheReadTokens,
        cacheCreation: r.cacheCreationTokens,
      },
      costUsd: r.costUsd,
      attributionSkill: r.attributionSkill,
      userMessagesBefore: messages
        .filter(inWindow)
        .map((m) => ({ kind: m.kind, text: m.kind === 'user' ? displayUserText(m.text) : m.text })),
      skillLoads: loads.filter(inWindow).map((l) => ({ name: l.name, args: l.args })),
      thinking: details.thinking.get(r) ?? null,
      text: r.text,
      toolCalls: r.toolCalls.map((c: ToolCall) => ({
        id: c.id,
        name: c.name,
        input: c.input,
        result: truncated.has(c.id) ? (full.get(c.id) ?? null) : c.result,
        isError: c.isError,
        spilledOutput: c.spillPath === null ? null : fs.readFileSync(c.spillPath, 'utf8'),
        subagentId: c.subagentId,
      })),
    };
  });
  return { rows: exported, report, instructions: details.instructions };
}

// Whether the repo exists: returns gh's text when it does not; other errors (auth, network) are thrown as-is
async function repoMissing(repo: string): Promise<string | null> {
  const result = await execa('gh', ['api', `repos/${repo}`, '--silent'], { reject: false });
  if (result.exitCode === 0) return null;
  if (result.exitCode === 1 && result.stderr.includes('HTTP 404')) return result.stderr.trim();
  throw new Error(`gh api repos/${repo} exit code ${String(result.exitCode)}: ${result.stderr}`);
}

// A run's session: task (without hidden requirements, rubric and hidden tests), grades and reasons, artifacts, conversation, PR review and CI
export async function exportRun(db: Db, runId: string): Promise<unknown> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`Run ${runId} not found`);
  const task = loadTask(db, run.taskId);
  const taskView = {
    id: task.id,
    kind: task.kind,
    title: task.title,
    persona: task.persona,
    ...(task.input === undefined ? {} : { input: task.input }),
    ...(task.ticket === undefined ? {} : { ticket: task.ticket }),
    ...(task.requiredChecks === undefined ? {} : { requiredChecks: task.requiredChecks }),
  };
  const rows = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, runId))
    .orderBy(asc(artifacts.id))
    .all();
  const stored = rows.find((a) => a.kind === 'pr_snapshot');
  let pr: unknown;
  if (stored !== undefined) {
    if (stored.snapshot === null) throw new Error(`PR snapshot of run ${runId} is empty`);
    pr = { source: 'snapshot', ...StoredPrSnapshot.parse(JSON.parse(stored.snapshot)) };
  } else if (run.githubRepo === null) {
    pr = null;
  } else {
    const missing = await repoMissing(run.githubRepo);
    pr =
      missing === null
        ? { source: 'github', pr: await readPrSnapshot(run.githubRepo) }
        : { unavailable: missing };
  }
  return {
    run: {
      id: run.id,
      status: run.status,
      error: run.error,
      humanIntervened: run.humanIntervened,
      githubRepo: run.githubRepo,
      linearIssue: run.linearIssueIdentifier,
      prUrl: run.prUrl,
      costUsd: run.costUsd,
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
    },
    task: taskView,
    grades: readRunGrades(db, runId),
    artifacts: rows
      .filter((a) => a.kind !== 'pr_snapshot')
      .map((a) => ({ kind: a.kind, location: a.location, snapshot: a.snapshot })),
    messages: db
      .select({
        role: runMessages.role,
        content: runMessages.content,
        payload: runMessages.payload,
      })
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .orderBy(asc(runMessages.seq))
      .all(),
    pr,
  };
}

export const CaseFile = z.object({
  analysisId: z.string(),
  // Null for analyses of local-machine sessions (Contracts 25.4)
  variant: z.object({ id: z.string(), name: z.string() }).nullable(),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      cwd: z.string().nullable(),
      runId: z.string().nullable(),
      requests: z.number(),
      mainRequests: z.number(),
    }),
  ),
});
export type CaseFile = z.infer<typeof CaseFile>;

export interface ExportInput {
  analysisId: string;
  // The analysed variant, its src/skills and its workflow's definition (written as input/workflow.yaml, Contracts 19.2);
  // null for local-machine sessions: no skills/, workflow.yaml or stages.json (Contracts 25.4)
  variant: {
    id: string;
    name: string;
    skillsDir: string;
    workflow: WorkflowDefinition;
  } | null;
  sessionIds: string[];
  inputDir: string;
}

const InstructionsRecord = z.looseObject({
  type: z.literal('attachment'),
  timestamp: z.string(),
  attachment: z.looseObject({
    type: z.literal('instructions'),
    files: z.array(z.looseObject({ path: z.string(), type: z.string(), content: z.string() })),
  }),
});

// Instruction files loaded in a session record (attachment.type instructions: paths and text of CLAUDE.md etc.), in order
export function sessionInstructions(file: string): z.infer<typeof InstructionsRecord>[] {
  const out: z.infer<typeof InstructionsRecord>[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"instructions"') || !line.includes('"attachment"')) continue;
    const raw: unknown = JSON.parse(line);
    const record = z.looseObject({ type: z.string(), attachment: z.unknown() }).parse(raw);
    if (record.type !== 'attachment') continue;
    const kind = z.looseObject({ type: z.string() }).parse(record.attachment).type;
    if (kind === 'instructions') out.push(InstructionsRecord.parse(raw));
  }
  return out;
}

// Write input/; returns each session's exported rows for evidence validation
export async function writeInput(db: Db, input: ExportInput): Promise<Map<string, ExportedRow[]>> {
  const out = new Map<string, ExportedRow[]>();
  const sessionsDir = path.join(input.inputDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const meta = db
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      runId: sessions.runId,
      filePath: sessions.filePath,
    })
    .from(sessions)
    .where(inArray(sessions.id, input.sessionIds))
    .all();
  const titles = sessionTitles(db, input.sessionIds);
  const caseSessions: CaseFile['sessions'] = [];
  for (const id of input.sessionIds) {
    const m = meta.find((s) => s.id === id);
    if (m === undefined) throw new Error(`Session ${id} not found`);
    const { rows, report, instructions } = exportSessionRows(db, id, input.variant !== null);
    out.set(id, rows);
    fs.writeFileSync(
      path.join(sessionsDir, `${id}.jsonl`),
      rows.map((r) => `${JSON.stringify(r)}\n`).join(''),
    );
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    if (report !== null)
      fs.writeFileSync(path.join(dir, 'stages.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, 'conversation.json'),
      `${JSON.stringify(sessionConversation(db, id), null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'instructions.json'),
      `${JSON.stringify(instructions, null, 2)}\n`,
    );
    if (m.runId !== null) {
      fs.writeFileSync(
        path.join(dir, 'run.json'),
        `${JSON.stringify(await exportRun(db, m.runId), null, 2)}\n`,
      );
    }
    const mainRequests = db
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.sessionId, id), isNull(requests.agentId)))
      .all().length;
    caseSessions.push({
      id,
      title: titles.get(id) ?? null,
      cwd: m.cwd,
      runId: m.runId,
      requests: rows.length,
      mainRequests,
    });
  }
  const variant = input.variant;
  const caseFile: CaseFile = {
    analysisId: input.analysisId,
    variant: variant === null ? null : { id: variant.id, name: variant.name },
    sessions: caseSessions,
  };
  fs.writeFileSync(
    path.join(input.inputDir, 'case.json'),
    `${JSON.stringify(caseFile, null, 2)}\n`,
  );
  if (variant !== null) {
    fs.cpSync(variant.skillsDir, path.join(input.inputDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(input.inputDir, 'workflow.yaml'), stringify(variant.workflow));
  }
  return out;
}
