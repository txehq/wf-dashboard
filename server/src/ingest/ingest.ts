import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  liveProcesses,
  liveSessions,
  type ParseState,
  requests,
  runs,
  sessions,
  sessionSkills,
  sessionSkillScans,
  subagents,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { events } from '../events.js';
import { costUsd, fromApiUsage } from '../llm/pricing.js';
import { config } from '../config.js';
import { commandArgs, sessionTitle } from '../api/user-text.js';
import { rebindSession, SKILL_PREFIX } from '../bindings/index.js';
import { publishStageChanges, type StageChange, updateStages } from '../stages/report.js';
import { inputString } from '../stages/rows.js';
import {
  AgentResultRecord,
  AnyRecord,
  AssistantRecord,
  SubagentMeta,
  UserRecord,
} from './records.js';
import { clearImportFailure, setSpillWait } from './import-problems.js';
import { markImported } from './imports.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from './workflows.js';

type RequestRow = typeof requests.$inferInsert;
type UserMessageRow = typeof userMessages.$inferInsert;
type SkillLoadRow = typeof sessionSkills.$inferInsert;

const resultLimit = 20_000;

// Tool results are truncated to 20000 UTF-16 units (Contracts 2); when the cut falls inside a surrogate pair keep one fewer, never half a character
export function truncateResult(text: string): string {
  if (text.length <= resultLimit) return text;
  const code = text.charCodeAt(resultLimit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? resultLimit - 1 : resultLimit;
  return text.slice(0, cut);
}
// API errors and interruption notices Claude Code generates locally; not model requests
const syntheticModel = '<synthetic>';
const persisted = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: (.+)$/m;

export function initialParseState(): ParseState {
  return { nextSeq: 0, lastUserAt: null, pending: {} };
}

// Read all complete lines after offset; a trailing half line without a newline waits for next time
// Complete lines from offset up to the last newline. With limit, read at most limit bytes (a line longer than limit is read to its end),
// more means content remains past limit. When stopBefore returns a reason for a line, stop before it: that line and the rest wait for next time,
// and stopped is that reason
export function readCompleteLines(
  file: string,
  offset: number,
  limit = Infinity,
  stopBefore?: (line: string) => string | null,
): { lines: string[]; end: number; more: boolean; stopped: string | null } {
  const fd = openSync(file, 'r');
  const size = fstatSync(fd).size;
  if (size < offset)
    throw new Error(
      `Size ${String(size)} of ${file} is smaller than the parsed offset ${String(offset)}`,
    );
  const readFrom = (length: number) => {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  };
  let buffer = readFrom(Math.min(size - offset, limit));
  let lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1 && buffer.length < size - offset) {
    buffer = readFrom(size - offset);
    lastNewline = buffer.lastIndexOf(0x0a);
  }
  closeSync(fd);
  const more = offset + buffer.length < size;
  if (lastNewline === -1) return { lines: [], end: offset, more: false, stopped: null };
  const segments = buffer.toString('utf8', 0, lastNewline).split('\n');
  if (stopBefore === undefined)
    return {
      lines: segments.filter((l) => l.length > 0),
      end: offset + lastNewline + 1,
      more,
      stopped: null,
    };
  const lines: string[] = [];
  let start = offset;
  for (const segment of segments) {
    if (segment.length > 0) {
      const stopped = stopBefore(segment);
      if (stopped !== null) return { lines, end: start, more: false, stopped };
      lines.push(segment);
    }
    start += Buffer.byteLength(segment, 'utf8') + 1;
  }
  return { lines, end: offset + lastNewline + 1, more, stopped: null };
}

export function resultText(content: UserRecordToolResult['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

type UserRecordContent = Exclude<UserRecord['message']['content'], string>[number];
type UserRecordToolResult = Extract<UserRecordContent, { type: 'tool_result' }>;

interface ParseContext {
  db: Db;
  sessionId: string;
  agentId: string | null;
  // <sessionId>/tool-results
  spillDir: string;
  // parent_tool_use_id → agent_id
  subagentByToolUse: Map<string, string>;
  state: ParseState;
}

interface ParseOutput {
  rows: Map<string, RequestRow>;
  userMessages: UserMessageRow[];
  skillLoads: SkillLoadRow[];
  firstAt: number | null;
  lastAt: number | null;
  cwd: string | null;
}

function loadRequest(ctx: ParseContext, messageId: string): RequestRow | undefined {
  return ctx.db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.sessionId, ctx.sessionId),
        ctx.agentId === null ? isNull(requests.agentId) : eq(requests.agentId, ctx.agentId),
        eq(requests.messageId, messageId),
      ),
    )
    .get();
}

// The parent conversation a fork subagent inherits: skip every record before the tool_result of the Agent call that spawned it
function inheritedFromParent(state: ParseState, raw: unknown, type: string): boolean {
  const spawn = state.forkToolUseId;
  if (spawn === undefined) return false;
  if (type !== 'user') return true;
  const { content } = UserRecord.parse(raw).message;
  return (
    typeof content === 'string' ||
    !content.some((b) => b.type === 'tool_result' && b.tool_use_id === spawn)
  );
}

// User records Claude Code generates itself: background task notifications, local command output; plus messages from other agent sessions (Contracts section 2)
function isNotice(record: UserRecord, text: string): boolean {
  return (
    record.origin?.kind === 'task-notification' ||
    isPeer(record) ||
    text.startsWith('<local-command-stdout>')
  );
}

// A message from another Claude session (Orca orchestration): origin.kind peer, isMeta, text is
// "Another Claude session sent a message:" followed by a <cross-session-message> element naming the sender
function isPeer(record: UserRecord): boolean {
  return record.origin?.kind === 'peer';
}

// Head of some main jsonl lines (Contracts 25.1, for listing sessions on disk): the time of the first timestamped record, the cwd of the first record with a cwd,
// and the first user message (kind user) under the same rules as parseLines
export function claudeHead(lines: string[]): {
  firstAt: number | null;
  cwd: string | null;
  firstUserText: string | null;
} {
  const head = {
    firstAt: null as number | null,
    cwd: null as string | null,
    firstUserText: null as string | null,
  };
  for (const line of lines) {
    const raw: unknown = JSON.parse(line);
    const any = AnyRecord.parse(raw);
    if (head.firstAt === null && any.timestamp !== undefined)
      head.firstAt = Date.parse(any.timestamp);
    if (head.cwd === null && any.cwd !== undefined) head.cwd = any.cwd;
    if (any.type === 'user' && head.firstUserText === null) {
      const record = UserRecord.parse(raw);
      const isInput =
        (record.isMeta !== true || isPeer(record)) && record.isCompactSummary !== true;
      const { content } = record.message;
      const texts =
        typeof content === 'string'
          ? [content]
          : content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
      const text = texts.join('\n');
      if (isInput && texts.length > 0 && !isNotice(record, text)) head.firstUserText = text;
    }
    if (head.firstAt !== null && head.cwd !== null && head.firstUserText !== null) break;
  }
  return head;
}

function parseLines(ctx: ParseContext, lines: string[]): ParseOutput {
  const out: ParseOutput = {
    rows: new Map(),
    userMessages: [],
    skillLoads: [],
    firstAt: null,
    lastAt: null,
    cwd: null,
  };
  const { state } = ctx;

  const touch = (messageId: string) => {
    const row = out.rows.get(messageId) ?? loadRequest(ctx, messageId);
    if (row !== undefined) out.rows.set(messageId, row);
    return row;
  };

  for (const line of lines) {
    const raw: unknown = JSON.parse(line);
    const any = AnyRecord.parse(raw);
    if (inheritedFromParent(state, raw, any.type)) continue;
    if (any.timestamp !== undefined) {
      const at = Date.parse(any.timestamp);
      out.firstAt ??= at;
      out.lastAt = at;
    }
    if (any.cwd !== undefined) out.cwd ??= any.cwd;

    if (any.type === 'assistant') {
      const record = AssistantRecord.parse(raw);
      const { message } = record;
      if (message.model === syntheticModel) continue;
      const at = Date.parse(record.timestamp);
      let row = touch(message.id);
      if (row === undefined) {
        row = {
          sessionId: ctx.sessionId,
          messageId: message.id,
          seq: state.nextSeq++,
          agentId: ctx.agentId,
          timestamp: new Date(at),
          triggerAt: state.lastUserAt === null ? null : new Date(state.lastUserAt),
          model: message.model,
          thinking: null,
          text: null,
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          durationMs: null,
          attributionSkill: null,
        };
        out.rows.set(message.id, row);
      }
      for (const block of message.content) {
        if (block.type === 'text')
          row.text = row.text == null ? block.text : `${row.text}\n\n${block.text}`;
        if (block.type === 'thinking')
          row.thinking =
            row.thinking == null ? block.thinking : `${row.thinking}\n\n${block.thinking}`;
        if (block.type === 'tool_use') {
          row.toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
            result: null,
            resultChars: 0,
            isError: false,
            spillPath: null,
            subagentId: ctx.subagentByToolUse.get(block.id) ?? null,
          });
          state.pending[block.id] = message.id;
        }
      }
      // Every record of a message carries usage, later ones with more complete output_tokens; keep only the last
      const usage = fromApiUsage(message.usage);
      row.model = message.model;
      row.inputTokens = usage.inputTokens;
      row.outputTokens = usage.outputTokens;
      row.cacheReadTokens = usage.cacheReadTokens;
      row.cacheCreationTokens = usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
      row.costUsd = costUsd(usage, message.model);
      row.durationMs = row.triggerAt == null ? null : at - row.triggerAt.getTime();
      row.attributionSkill ??= record.attributionSkill ?? null;
    }

    if (any.type === 'user') {
      const record = UserRecord.parse(raw);
      const at = Date.parse(record.timestamp);
      // Peer messages are isMeta but still returned as notices; they start a new round, and the duration_ms of the
      // first request after them counts from them
      const isInput =
        (record.isMeta !== true || isPeer(record)) && record.isCompactSummary !== true;
      const { content } = record.message;
      const texts: string[] = [];
      if (typeof content === 'string') texts.push(content);
      else
        for (const block of content) {
          if (block.type === 'text') texts.push(block.text);
          if (block.type === 'tool_result') {
            // The Agent call that forks belongs to the parent; the fork's own conversation starts after its result
            if (block.tool_use_id === state.forkToolUseId) delete state.forkToolUseId;
            else attachResult(ctx, block, touch);
            state.lastUserAt = at;
          }
        }
      if (isInput && texts.length > 0) {
        const text = texts.join('\n');
        out.userMessages.push({
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          uuid: record.uuid,
          kind: isNotice(record, text) ? 'notice' : 'user',
          timestamp: new Date(at),
          text,
        });
        state.lastUserAt = at;
      }
      if (record.isMeta === true && !isPeer(record)) {
        const loads = texts.filter((t) => SKILL_PREFIX.test(t));
        if (loads.length > 1) throw new Error(`Record ${record.uuid} has several skill bodies`);
        const [load] = loads;
        if (load !== undefined) out.skillLoads.push(skillLoad(ctx, out, record, load, at));
      }
    }
  }
  return out;
}

// isMeta records that load a skill (Contracts 15.1): arguments come from input.args of the Skill call sourceToolUseID
// points at, or <command-args> in the slash command message parentUuid points at
function skillLoad(
  ctx: ParseContext,
  out: ParseOutput,
  record: UserRecord,
  text: string,
  at: number,
): SkillLoadRow {
  const match = SKILL_PREFIX.exec(text);
  if (match?.[1] === undefined) throw new Error(`Record ${record.uuid} is not a skill body`);
  const baseDir = match[1];
  const name = path.basename(baseDir);
  let args: string;
  if (record.sourceToolUseID !== undefined) {
    const call = findToolCall(ctx, out, record.sourceToolUseID);
    if (call === undefined) {
      throw new Error(
        `The tool call ${record.sourceToolUseID} that the body of skill ${name} (record ${record.uuid}) points at does not exist`,
      );
    }
    const raw = inputString(call.input, 'args');
    args = raw ?? '';
  } else {
    const parent = record.parentUuid ?? null;
    const command =
      parent === null
        ? undefined
        : (out.userMessages.find((m) => m.uuid === parent) ??
          ctx.db
            .select({ text: userMessages.text })
            .from(userMessages)
            .where(and(eq(userMessages.sessionId, ctx.sessionId), eq(userMessages.uuid, parent)))
            .get());
    const parsed = command === undefined ? null : commandArgs(command.text);
    if (parsed === null) {
      throw new Error(
        `The body of skill ${name} (record ${record.uuid}) points at no Skill call, and the previous record ${String(parent)} is not a slash command`,
      );
    }
    args = parsed;
  }
  return {
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    uuid: record.uuid,
    name,
    baseDir,
    text: text.slice(match[0].length),
    args,
    timestamp: new Date(at),
  };
}

function findToolCall(ctx: ParseContext, out: ParseOutput, id: string): ToolCall | undefined {
  for (const row of out.rows.values()) {
    const call = row.toolCalls.find((c) => c.id === id);
    if (call !== undefined) return call;
  }
  const found = ctx.db.$client
    .prepare<[string, string], { value: string }>(
      `select j.value as value from requests r, json_each(r.tool_calls) j
       where r.session_id = ? and json_extract(j.value, '$.id') = ?`,
    )
    .get(ctx.sessionId, id);
  return found === undefined ? undefined : (JSON.parse(found.value) as ToolCall);
}

export function writeSkillLoads(db: Db, rows: SkillLoadRow[]) {
  for (const row of rows) db.insert(sessionSkills).values(row).onConflictDoNothing().run();
}

function attachResult(
  ctx: ParseContext,
  block: UserRecordToolResult,
  touch: (messageId: string) => RequestRow | undefined,
) {
  const messageId = ctx.state.pending[block.tool_use_id];
  if (messageId === undefined)
    throw new Error(
      `tool_result ${block.tool_use_id} has no matching tool_use (session ${ctx.sessionId})`,
    );
  const row = touch(messageId);
  const call = row?.toolCalls.find((c) => c.id === block.tool_use_id);
  if (call === undefined)
    throw new Error(`Message ${messageId} has no tool_use ${block.tool_use_id}`);
  const text = resultText(block.content);
  call.result = truncateResult(text);
  call.resultChars = text.length;
  call.isError = block.is_error === true;
  call.spillPath = spillPath(ctx, text);
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete ctx.state.pending[block.tool_use_id];
}

// Spill files live in <sessionId>/tool-results/ (subagents use the parent session's directory); the jsonl records the
// absolute path at write time, located in the local copy by file name. Spills Claude Code writes are always under this
// session's own <sessionId>/tool-results/ (true of all 100 real spills on this machine); the same opening text pointing
// elsewhere is another session's spill notice quoted in tool output (e.g. jq reading another session's records), not a
// spill
function ownSpill(spillDir: string, text: string): string | null {
  if (!text.startsWith('<persisted-output>')) return null;
  const match = persisted.exec(text);
  if (match?.[1] === undefined)
    throw new Error(`Unrecognised spilled output path: ${text.slice(0, 200)}`);
  const target = match[1];
  const own =
    path.basename(path.dirname(target)) === 'tool-results' &&
    path.basename(path.dirname(path.dirname(target))) === path.basename(path.dirname(spillDir));
  return own ? path.join(spillDir, path.basename(target)) : null;
}

function spillPath(ctx: ParseContext, text: string): string | null {
  const local = ownSpill(ctx.spillDir, text);
  if (local !== null && !existsSync(local)) throw new Error(`Spill file does not exist: ${local}`);
  return local;
}

// A spill file a line references but that is not local yet (stopBefore of readCompleteLines): like a subagent whose
// meta.json is not written yet, the line waits for the next import. When a remote session syncs to this machine, the
// jsonl and subagent records may arrive before the spill files they reference
const missingSpill = (spillDir: string) => (line: string) => {
  if (!line.includes('<persisted-output>')) return null;
  const raw: unknown = JSON.parse(line);
  if (AnyRecord.parse(raw).type !== 'user') return null;
  const { content } = UserRecord.parse(raw).message;
  if (typeof content === 'string') return null;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const local = ownSpill(spillDir, resultText(block.content));
    if (local !== null && !existsSync(local)) return local;
  }
  return null;
};

export function writeRows(db: Db, rows: Iterable<RequestRow>) {
  for (const row of rows) {
    const { id, ...values } = row;
    if (id === undefined) db.insert(requests).values(values).run();
    else db.update(requests).set(values).where(eq(requests.id, id)).run();
  }
}

export function writeUserMessages(db: Db, rows: UserMessageRow[]) {
  for (const row of rows) db.insert(userMessages).values(row).onConflictDoNothing().run();
}

function flagsOf(rows: Iterable<RequestRow>, messages: UserMessageRow[]): WorkflowFlags {
  const flags = { lfg: false, ic: false };
  const merge = (f: WorkflowFlags) => {
    flags.lfg ||= f.lfg;
    flags.ic ||= f.ic;
  };
  for (const row of rows) for (const call of row.toolCalls) merge(detectFromToolCall(call));
  for (const m of messages) if (m.kind === 'user') merge(detectFromUserText(m.text));
  return flags;
}

function runIdFor(db: Db, sessionId: string): string | null {
  return (
    db.select({ id: runs.id }).from(runs).where(eq(runs.sessionId, sessionId)).get()?.id ?? null
  );
}

// The Live item this session belongs to (Contracts 14.1, claude_session_id is unique)
export function liveIdFor(db: Db, sessionId: string): string | null {
  return (
    db
      .select({ id: liveSessions.id })
      .from(liveSessions)
      .where(eq(liveSessions.claudeSessionId, sessionId))
      .get()?.id ?? null
  );
}

// On resume the session was copied into another configuration directory and that copy is imported from then on
// (Contracts 14.5); the original file is no longer imported
function resumedElsewhere(db: Db, sessionId: string): boolean {
  return (
    db
      .select({ id: liveProcesses.id })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(and(eq(liveSessions.claudeSessionId, sessionId), eq(liveProcesses.kind, 'resume')))
      .get() !== undefined
  );
}

// Mark the ToolCall pointed at by toolUseId with the subagent; when the parent call is not parsed yet, parseLines marks
// it on reaching it
function linkSubagent(db: Db, sessionId: string, toolUseId: string, agentId: string) {
  const found = db.$client
    .prepare<[string, string], { id: number }>(
      `select r.id as id from requests r, json_each(r.tool_calls) j
       where r.session_id = ? and json_extract(j.value, '$.id') = ?`,
    )
    .get(sessionId, toolUseId);
  if (found === undefined) return;
  const row = db.select().from(requests).where(eq(requests.id, found.id)).get();
  if (row === undefined) throw new Error(`Request ${String(found.id)} does not exist`);
  const toolCalls: ToolCall[] = row.toolCalls.map((c) =>
    c.id === toolUseId ? { ...c, subagentId: agentId } : c,
  );
  db.update(requests).set({ toolCalls }).where(eq(requests.id, row.id)).run();
}

function subagentMap(db: Db, sessionId: string): Map<string, string> {
  const rows = db
    .select({ parent: subagents.parentToolUseId, agentId: subagents.agentId })
    .from(subagents)
    .where(eq(subagents.sessionId, sessionId))
    .all();
  return new Map(rows.map((r) => [r.parent, r.agentId]));
}

// The tool_use_id of the calls that started these agents, from the parsed part of the parent session: the user record
// answering such a call has toolUseResult.agentId naming the agent. An agent whose call has not finished is absent
function agentToolUses(
  file: string,
  parsedEnd: number,
  agentIds: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of readCompleteLines(file, 0, parsedEnd).lines) {
    if (!line.includes('"toolUseResult"')) continue;
    const agentId = agentIds.find((id) => line.includes(`"${id}"`));
    if (agentId === undefined) continue;
    const record: unknown = JSON.parse(line);
    if (AnyRecord.parse(record).type !== 'user') continue;
    const { toolUseResult, message } = AgentResultRecord.parse(record);
    if (
      typeof toolUseResult !== 'object' ||
      toolUseResult === null ||
      !('agentId' in toolUseResult) ||
      toolUseResult.agentId !== agentId
    )
      continue;
    const results = Array.isArray(message.content)
      ? message.content.filter((b) => b.type === 'tool_result')
      : [];
    const [result] = results;
    if (result === undefined || results.length > 1)
      throw new Error(
        `The record naming subagent ${agentId} in ${file} has ${String(results.length)} tool_result blocks, expected 1`,
      );
    found.set(agentId, result.tool_use_id);
  }
  return found;
}

// Register new agent-<id>.jsonl files; subagents whose meta.json is not written yet, or whose meta.json has no
// toolUseId while the parent call has not finished, wait for the next time
function registerSubagents(
  db: Db,
  sessionId: string,
  dir: string,
  parentFile: string,
  parsedEnd: number,
): boolean {
  if (!existsSync(dir)) return false;
  const pending: { agentId: string; filePath: string; meta: SubagentMeta }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (match?.[1] === undefined) continue;
    const agentId = match[1];
    const filePath = path.join(dir, name);
    const known = db
      .select({ id: subagents.agentId })
      .from(subagents)
      .where(eq(subagents.filePath, filePath))
      .get();
    if (known !== undefined) continue;
    const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
    if (!existsSync(metaPath)) continue;
    pending.push({
      agentId,
      filePath,
      meta: SubagentMeta.parse(JSON.parse(readFileSync(metaPath, 'utf8'))),
    });
  }
  const unnamed = pending.filter((p) => p.meta.toolUseId === undefined).map((p) => p.agentId);
  const fromParent =
    unnamed.length === 0
      ? new Map<string, string>()
      : agentToolUses(parentFile, parsedEnd, unnamed);
  let added = false;
  for (const { agentId, filePath, meta } of pending) {
    const toolUseId = meta.toolUseId ?? fromParent.get(agentId);
    if (toolUseId === undefined) continue;
    db.insert(subagents)
      .values({
        sessionId,
        agentId,
        filePath,
        parentToolUseId: toolUseId,
        agentType: meta.agentType,
        description: meta.description ?? null,
        parseState:
          meta.isFork === true
            ? { ...initialParseState(), forkToolUseId: toolUseId }
            : initialParseState(),
      })
      .run();
    linkSubagent(db, sessionId, toolUseId, agentId);
    added = true;
  }
  return added;
}

export interface IngestResult {
  sessionId: string;
  // Whether this pass wrote new requests, user messages or subagents
  changed: boolean;
  // With limit: the main jsonl still has unread content; call again to continue
  more: boolean;
}

// Incrementally parse a main session jsonl and its subagents/, then send session.updated.
// limit: at most this many bytes of the main jsonl per call; large sessions are read in chunks, one transaction each,
// so the server can handle other requests in between
export function ingestFile(db: Db, file: string, limit = Infinity): IngestResult {
  const absolute = path.resolve(file);
  if (!absolute.endsWith('.jsonl')) throw new Error(`Not a jsonl file: ${absolute}`);
  const sessionId = path.basename(absolute, '.jsonl');
  const sessionDir = path.join(path.dirname(absolute), sessionId);
  const spillDir = path.join(sessionDir, 'tool-results');

  const result = db.$client.transaction(() => {
    const unchanged = {
      changed: false,
      stageChanges: [] as StageChange[],
      skillsAdded: false,
      created: false,
      more: false,
      waiting: null as string | null,
    };
    const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (existing?.engine === 'codex' || (existing !== undefined && 'kind' in existing.parseState))
      throw new Error(`Session ${sessionId} is a Codex rollout, imported by ingestCodexFile`);
    if (existing !== undefined && existing.filePath !== absolute) {
      if (resumedElsewhere(db, sessionId)) return unchanged;
      throw new Error(
        `Session ${sessionId} was imported from ${existing.filePath} and cannot be imported from ${absolute}`,
      );
    }
    const offset = existing?.parseOffset ?? 0;
    const state = existing?.parseState ?? initialParseState();
    const { lines, end, more, stopped } = readCompleteLines(
      absolute,
      offset,
      limit,
      missingSpill(spillDir),
    );
    let changed = false;
    let skillsAdded = false;

    if (lines.length > 0) {
      const ctx: ParseContext = {
        db,
        sessionId,
        agentId: null,
        spillDir,
        subagentByToolUse: subagentMap(db, sessionId),
        state,
      };
      const out = parseLines(ctx, lines);
      // No session is created before any timed record; next time it is read from the start
      if (existing === undefined && out.firstAt === null) return { ...unchanged, waiting: stopped };
      const startedAt = existing?.startedAt.getTime() ?? out.firstAt;
      const endedAt = out.lastAt ?? existing?.endedAt.getTime();
      if (startedAt == null || endedAt === undefined)
        throw new Error(`${absolute} lacks record times`);
      const flags = flagsOf(out.rows.values(), out.userMessages);
      const firstUser = out.userMessages.find((m) => m.kind === 'user');
      const runId = existing?.runId ?? runIdFor(db, sessionId);
      const values = {
        cwd: existing?.cwd ?? out.cwd,
        // The title for search, with the same rules as the list title (slash commands are name plus arguments)
        title: existing?.title ?? (firstUser === undefined ? null : sessionTitle(firstUser.text)),
        endedAt: new Date(endedAt),
        hasLfg: (existing?.hasLfg ?? false) || flags.lfg,
        hasIc: (existing?.hasIc ?? false) || flags.ic,
        runId,
        liveId: existing?.liveId ?? liveIdFor(db, sessionId),
        parseOffset: end,
        parseState: state,
        // A run's session is bound to the run's variant (Contracts 15.1)
        ...(runId !== null && existing?.variantBinding !== 'run'
          ? { variantId: runVariantId(db, runId), variantBinding: 'run' as const }
          : {}),
      };
      if (existing === undefined) {
        db.insert(sessions)
          .values({
            id: sessionId,
            filePath: absolute,
            startedAt: new Date(startedAt),
            ...values,
          })
          .run();
        db.insert(sessionSkillScans).values({ sessionId }).run();
        markImported(db, sessionId, 'claude', absolute);
      } else db.update(sessions).set(values).where(eq(sessions.id, sessionId)).run();
      writeRows(db, out.rows.values());
      writeUserMessages(db, out.userMessages);
      writeSkillLoads(db, out.skillLoads);
      changed = out.rows.size > 0 || out.userMessages.length > 0;
      skillsAdded = out.skillLoads.length > 0;
    } else if (existing === undefined) return { ...unchanged, waiting: stopped };

    if (registerSubagents(db, sessionId, path.join(sessionDir, 'subagents'), absolute, end))
      changed = true;
    const sub = ingestSubagents(db, sessionId, spillDir);
    if (sub.changed) changed = true;
    if (sub.skillsAdded) skillsAdded = true;
    // Stage partition updates incrementally with import (Contracts section 5)
    return {
      changed,
      stageChanges: changed ? updateStages(db, sessionId) : [],
      skillsAdded,
      created: existing === undefined,
      more,
      waiting: stopped ?? sub.waiting,
    };
  })();
  const { changed, stageChanges, skillsAdded, created, more, waiting } = result;

  // Import succeeded: clear an earlier recorded error; record waiting when stopped before a spill file that has not
  // appeared (shown in Sessions)
  const recovered = clearImportFailure(sessionId);
  const waitChanged = setSpillWait(sessionId, waiting);
  // A newly imported session (bound to the variant of its variant configuration) and newly loaded skills may change
  // automatic bindings
  if (skillsAdded || created) rebindSession(db, config.dataDir, sessionId);
  // Also sent for newly created sessions: a page opened before there were requests read a 404 and needs this event to
  // read again
  if (changed || created || recovered || waitChanged)
    events.publish({ type: 'session.updated', sessionId });
  publishStageChanges(sessionId, stageChanges);
  return { sessionId, changed, more };
}

function runVariantId(db: Db, runId: string): string {
  const run = db.select({ variantId: runs.variantId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`Run not found: ${runId}`);
  return run.variantId;
}

// Sessions imported but without extracted skill bodies (imported before this feature): read the main jsonl and
// subagents up to the parsed offset and extract only skill loads; returns the sessions extracted
export function backfillSkillLoads(db: Db): string[] {
  const pending = db
    .select({ id: sessions.id, filePath: sessions.filePath, parseOffset: sessions.parseOffset })
    .from(sessions)
    .where(
      sql`not exists (select 1 from ${sessionSkillScans} s where s.session_id = ${sessions.id})`,
    )
    .all();
  const filled: string[] = [];
  for (const session of pending) {
    const files = [
      { agentId: null, filePath: session.filePath, offset: session.parseOffset },
      ...db
        .select()
        .from(subagents)
        .where(eq(subagents.sessionId, session.id))
        .all()
        .map((s) => ({ agentId: s.agentId, filePath: s.filePath, offset: s.parseOffset })),
    ];
    db.$client.transaction(() => {
      let added = false;
      // A deleted jsonl (e.g. old sessions Claude Code cleaned up per cleanupPeriodDays) has nothing to extract
      for (const file of files.filter((f) => existsSync(f.filePath))) {
        const loads = scanSkillLoads(db, session.id, file.agentId, file.filePath, file.offset);
        writeSkillLoads(db, loads);
        if (loads.length > 0) added = true;
      }
      db.insert(sessionSkillScans).values({ sessionId: session.id }).run();
      if (added) filled.push(session.id);
    })();
  }
  return filled;
}

function scanSkillLoads(
  db: Db,
  sessionId: string,
  agentId: string | null,
  file: string,
  offset: number,
): SkillLoadRow[] {
  const out: ParseOutput = {
    rows: new Map(),
    userMessages: [],
    skillLoads: [],
    firstAt: null,
    lastAt: null,
    cwd: null,
  };
  const ctx: ParseContext = {
    db,
    sessionId,
    agentId,
    spillDir: '',
    subagentByToolUse: new Map(),
    state: initialParseState(),
  };
  const content = readFileSync(file).subarray(0, offset).toString('utf8');
  for (const line of content.split('\n')) {
    if (!line.includes('Base directory for this skill: ')) continue;
    const raw: unknown = JSON.parse(line);
    if (AnyRecord.parse(raw).type !== 'user') continue;
    const record = UserRecord.parse(raw);
    if (record.isMeta !== true || isPeer(record)) continue;
    const { content: c } = record.message;
    const texts =
      typeof c === 'string' ? [c] : c.flatMap((b) => (b.type === 'text' ? [b.text] : []));
    const loads = texts.filter((t) => SKILL_PREFIX.test(t));
    if (loads.length > 1) throw new Error(`Record ${record.uuid} has several skill bodies`);
    const [load] = loads;
    if (load !== undefined) {
      out.skillLoads.push(skillLoad(ctx, out, record, load, Date.parse(record.timestamp)));
    }
  }
  return out.skillLoads;
}

function ingestSubagents(
  db: Db,
  sessionId: string,
  spillDir: string,
): { changed: boolean; skillsAdded: boolean; waiting: string | null } {
  const all = db.select().from(subagents).where(eq(subagents.sessionId, sessionId)).all();
  const byToolUse = new Map(all.map((s) => [s.parentToolUseId, s.agentId]));
  let changed = false;
  let skillsAdded = false;
  let waiting: string | null = null;
  for (const sub of all) {
    const { lines, end, stopped } = readCompleteLines(
      sub.filePath,
      sub.parseOffset,
      Infinity,
      missingSpill(spillDir),
    );
    waiting ??= stopped;
    if (lines.length === 0) continue;
    const ctx: ParseContext = {
      db,
      sessionId,
      agentId: sub.agentId,
      spillDir,
      subagentByToolUse: byToolUse,
      state: sub.parseState,
    };
    const out = parseLines(ctx, lines);
    writeRows(db, out.rows.values());
    writeUserMessages(db, out.userMessages);
    writeSkillLoads(db, out.skillLoads);
    if (out.skillLoads.length > 0) skillsAdded = true;
    if (out.lastAt !== null)
      db.update(sessions)
        .set({ endedAt: sql`max(${sessions.endedAt}, ${out.lastAt})` })
        .where(eq(sessions.id, sessionId))
        .run();
    db.update(subagents)
      .set({ parseOffset: end, parseState: ctx.state })
      .where(and(eq(subagents.sessionId, sessionId), eq(subagents.agentId, sub.agentId)))
      .run();
    if (out.rows.size > 0 || out.userMessages.length > 0) changed = true;
  }
  return { changed, skillsAdded, waiting };
}
