import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type CodexParseState,
  requests,
  sessions,
  sessionSkills,
  sessionSkillScans,
  stageStates,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { events } from '../events.js';
import { sessionTitle } from '../api/user-text.js';
import { costUsd, hasPrice } from '../llm/pricing.js';
import { rebindSession, skillFileBody } from '../bindings/index.js';
import { publishStageChanges, type StageChange, updateStages } from '../stages/report.js';
import {
  CodexLine,
  CompletedItem,
  ItemCompleted,
  knownItemTypes,
  ResponseItem,
  SessionMeta,
  TokenUsageRecord,
  TurnContext,
} from './codex-records.js';
import { catSkill, injectedSkill, resolveSkillPath } from './codex-skill.js';
import { clearImportFailure } from './import-problems.js';
import { markImported } from './imports.js';
import {
  type IngestResult,
  liveIdFor,
  readCompleteLines,
  truncateResult,
  writeRows,
  writeSkillLoads,
  writeUserMessages,
} from './ingest.js';
import { detectFromSkill, detectFromToolCall } from './workflows.js';

type RequestRow = typeof requests.$inferInsert;
type UserMessageRow = typeof userMessages.$inferInsert;
type SkillLoadRow = typeof sessionSkills.$inferInsert;

// Codex rollout file name: rollout-<time>-<session id>.jsonl
export const isRollout = (file: string) => {
  const name = path.basename(file);
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
};

// The CODEX_HOME holding a rollout: <CODEX_HOME>/sessions/YYYY/MM/DD/<rollout> or <CODEX_HOME>/archived_sessions/<rollout>
export function codexHomeOf(filePath: string): string {
  const parts = filePath.split(path.sep);
  const at = parts.lastIndexOf('archived_sessions');
  if (at > 0 && at === parts.length - 2) return parts.slice(0, at).join(path.sep);
  const s = parts.lastIndexOf('sessions');
  if (s > 0 && s === parts.length - 5) return parts.slice(0, s).join(path.sep);
  throw new Error(`${filePath} is not in sessions/ or archived_sessions/ of a CODEX_HOME`);
}

export function initialCodexState(): CodexParseState {
  return {
    kind: 'codex',
    nextSeq: 0,
    lastUserAt: null,
    model: null,
    open: { text: null, thinking: null, toolCalls: [] },
    pending: {},
  };
}

// The rollout's first line (session_meta): base_instructions is tens of KB, so read in chunks up to the first newline
export function readSessionMeta(file: string): { id: string; cwd: string; startedAt: Date } | null {
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const n = readSync(fd, chunk, 0, chunk.length, offset);
    if (n === 0) break;
    const at = chunk.subarray(0, n).indexOf(0x0a);
    if (at !== -1) {
      parts.push(Buffer.from(chunk.subarray(0, at)));
      break;
    }
    parts.push(Buffer.from(chunk.subarray(0, n)));
    offset += n;
  }
  closeSync(fd);
  const line = Buffer.concat(parts).toString('utf8');
  // No session_meta while the first line is not fully written
  if (!line.endsWith('}')) return null;
  const record = CodexLine.parse(JSON.parse(line));
  if (record.type !== 'session_meta')
    throw new Error(`The first line of ${file} is not session_meta`);
  const meta = SessionMeta.parse(record.payload);
  return { id: meta.id, cwd: meta.cwd, startedAt: new Date(meta.timestamp) };
}

// CommandExecution cwd is a file:// URL
const pathOfCwd = (cwd: string) => (cwd.startsWith('file://') ? fileURLToPath(cwd) : cwd);

const textOf = (parts: { text?: string | undefined }[]) =>
  parts.flatMap((p) => (p.text === undefined ? [] : [p.text])).join('\n');

function call(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    name,
    input,
    result: null,
    resultChars: 0,
    isError: false,
    spillPath: null,
    subagentId: null,
  };
}

function setResult(target: ToolCall, text: string, isError: boolean) {
  target.result = truncateResult(text);
  target.resultChars = text.length;
  target.isError = isError;
}

// Raw call output: a string, or the text of input_text and similar parts
export const outputText = (output: string | { text?: string | undefined }[]) =>
  typeof output === 'string' ? output : textOf(output);

// Raw result of an executed item; searches have none
export function executedResult(item: CompletedItem): { text: string; isError: boolean } | null {
  switch (item.type) {
    case 'CommandExecution':
      return { text: item.aggregated_output ?? '', isError: item.exit_code !== 0 };
    case 'McpToolCall':
      return { text: JSON.stringify(item.result ?? null), isError: item.status === 'failed' };
    case 'FileChange':
      return { text: item.stdout ?? '', isError: item.status !== 'completed' };
    default:
      return null;
  }
}

// Items executed inside an exec script (commands, MCP tools, patches, searches) are recorded as tool calls after that call; when the model calls exec_command
// or an MCP function directly the executed item is that call itself and is not recorded twice
function executedCall(item: CompletedItem): ToolCall | null {
  const c = (() => {
    switch (item.type) {
      case 'CommandExecution':
        return call(item.id, 'exec_command', {
          cmd: item.command.at(-1) ?? '',
          cwd: pathOfCwd(item.cwd),
        });
      case 'McpToolCall':
        return call(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? null);
      case 'FileChange':
        return call(item.id, 'apply_patch', null);
      case 'WebSearch':
        return call(item.id, 'web_search', { query: item.query ?? null });
      default:
        return null;
    }
  })();
  const result = executedResult(item);
  if (c !== null && result !== null) setResult(c, result.text, result.isError);
  return c;
}

// Whether a CommandExecution loaded a skill: a single successful cat of SKILL.md whose output is the full text; records the body (without frontmatter)
// for a byte-for-byte comparison with the variant's SKILL.md (Contracts 15.1)
function skillLoadOf(sessionId: string, item: CompletedItem, at: number): SkillLoadRow | null {
  if (item.type !== 'CommandExecution' || item.exit_code !== 0) return null;
  const output = item.aggregated_output;
  const read = catSkill(item.command.at(-1) ?? '');
  if (read === null || output == null) return null;
  const file = resolveSkillPath(read.path, pathOfCwd(item.cwd));
  return {
    sessionId,
    agentId: null,
    uuid: item.id,
    name: read.name,
    baseDir: path.dirname(file),
    text: skillFileBody(output),
    args: '',
    timestamp: new Date(at),
  };
}

// 0.163.0's <skill> injection in a role user message (Contracts 16.6): recorded as a skill load, body without frontmatter,
// compared byte for byte with the variant's SKILL.md (15.1)
function injectedLoads(sessionId: string, item: ResponseItem, at: number): SkillLoadRow[] {
  if (item.type !== 'message' || item.role !== 'user') return [];
  return item.content.flatMap((part) => {
    const injected = injectedSkill(part.text ?? '');
    if (injected === null) return [];
    if (item.id === undefined)
      throw new Error(`Skill injection message in session ${sessionId} has no id`);
    return [
      {
        sessionId,
        agentId: null,
        uuid: item.id,
        name: injected.name,
        baseDir: path.dirname(injected.path),
        text: skillFileBody(injected.body),
        args: '',
        injected: true,
        timestamp: new Date(at),
      },
    ];
  });
}

interface Parsed {
  rows: Map<string, RequestRow>;
  userMessages: UserMessageRow[];
  skillLoads: SkillLoadRow[];
  meta: { id: string; cwd: string } | null;
  firstAt: number | null;
  lastAt: number | null;
}

function loadRequest(db: Db, sessionId: string, messageId: string): RequestRow | undefined {
  return db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.sessionId, sessionId),
        isNull(requests.agentId),
        eq(requests.messageId, messageId),
      ),
    )
    .get();
}

// Head of some rollout lines (Contracts 25.1, for listing sessions on disk): the start time (as in import, the session_meta
// timestamp) and the text of the first user message (UserMessage), taken as parseLines does; null when absent
export function codexHead(lines: string[]): {
  firstAt: number | null;
  firstUserText: string | null;
} {
  let firstAt: number | null = null;
  for (const line of lines) {
    const record = CodexLine.parse(JSON.parse(line));
    if (record.type === 'session_meta')
      firstAt ??= Date.parse(SessionMeta.parse(record.payload).timestamp);
    if (record.type !== 'event_msg') continue;
    const completed = ItemCompleted.safeParse(record.payload);
    if (!completed.success) continue;
    if (completed.data.item.type !== 'UserMessage') continue;
    const item = CompletedItem.parse(completed.data.item);
    if (item.type !== 'UserMessage') continue;
    const text = textOf(item.content);
    if (text !== '') return { firstAt, firstUserText: text };
  }
  return { firstAt, firstUserText: null };
}

function parseLines(db: Db, sessionId: string, state: CodexParseState, lines: string[]): Parsed {
  const out: Parsed = {
    rows: new Map(),
    userMessages: [],
    skillLoads: [],
    meta: null,
    firstAt: null,
    lastAt: null,
  };
  const touch = (messageId: string) => {
    const row = out.rows.get(messageId) ?? loadRequest(db, sessionId, messageId);
    if (row === undefined) throw new Error(`Session ${sessionId} has no request ${messageId}`);
    out.rows.set(messageId, row);
    return row;
  };
  // The tool call owning a call_id: in the request still being built, or in a written request
  const callOf = (callId: string): ToolCall => {
    const owner = state.pending[callId];
    if (owner === undefined)
      throw new Error(`Session ${sessionId} has no call ${callId} waiting for output`);
    const list = owner === '' ? state.open.toolCalls : touch(owner).toolCalls;
    const found = list.find((c) => c.id === callId);
    if (found === undefined) throw new Error(`Request ${owner} has no call ${callId}`);
    return found;
  };
  const addCall = (c: ToolCall, waitsForOutput: boolean) => {
    state.open.toolCalls.push(c);
    if (waitsForOutput) state.pending[c.id] = '';
  };

  for (const line of lines) {
    const record = CodexLine.parse(JSON.parse(line));
    const at = Date.parse(record.timestamp);
    out.firstAt ??= at;
    out.lastAt = at;
    switch (record.type) {
      case 'session_meta': {
        const meta = SessionMeta.parse(record.payload);
        out.meta ??= { id: meta.id, cwd: meta.cwd };
        break;
      }
      case 'turn_context':
        state.model = TurnContext.parse(record.payload).model;
        break;
      case 'response_item': {
        const item = ResponseItem.parse(record.payload);
        out.skillLoads.push(...injectedLoads(sessionId, item, at));
        if (item.type === 'message' && item.role === 'assistant') {
          const text = textOf(item.content);
          state.open.text = state.open.text === null ? text : `${state.open.text}\n\n${text}`;
        }
        if (item.type === 'reasoning') {
          const text = textOf(item.summary ?? []);
          if (text !== '')
            state.open.thinking =
              state.open.thinking === null ? text : `${state.open.thinking}\n\n${text}`;
        }
        if (item.type === 'custom_tool_call')
          addCall(call(item.call_id, item.name, item.input), true);
        if (item.type === 'function_call') {
          const name = item.namespace === undefined ? item.name : `${item.namespace}.${item.name}`;
          addCall(call(item.call_id, name, JSON.parse(item.arguments) as unknown), true);
        }
        if (
          item.type === 'web_search_call' ||
          item.type === 'tool_search_call' ||
          item.type === 'local_shell_call'
        ) {
          const id = item.call_id ?? item.id;
          if (id === undefined) throw new Error(`${item.type} has no id`);
          addCall(call(id, item.type, null), false);
        }
        if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
          setResult(callOf(item.call_id), outputText(item.output), false);
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete state.pending[item.call_id];
          state.lastUserAt = at;
        }
        break;
      }
      case 'event_msg': {
        const completed = ItemCompleted.safeParse(record.payload);
        if (!completed.success) break;
        const kind = completed.data.item.type;
        if (!(knownItemTypes as readonly string[]).includes(kind)) break;
        const item = CompletedItem.parse(completed.data.item);
        if (item.type === 'UserMessage') {
          const text = textOf(item.content);
          if (text === '') break;
          out.userMessages.push({
            sessionId,
            agentId: null,
            uuid: item.id,
            kind: 'user',
            timestamp: new Date(at),
            text,
          });
          state.lastUserAt = at;
          break;
        }
        const load = skillLoadOf(sessionId, item, at);
        if (load !== null) out.skillLoads.push(load);
        // An executed item belongs to the last call still waiting for output; only items run inside an exec script are recorded separately
        const owner = Object.keys(state.pending).at(-1);
        if (owner === undefined) break;
        const executed = executedCall(item);
        if (executed === null || callOf(owner).name !== 'exec') break;
        const ownerRequest = state.pending[owner];
        if (ownerRequest === '' || ownerRequest === undefined) state.open.toolCalls.push(executed);
        else touch(ownerRequest).toolCalls.push(executed);
        break;
      }
      case 'token_usage_record': {
        const usage = TokenUsageRecord.parse(record.payload);
        const model = state.model;
        if (model === null)
          throw new Error(
            `No turn_context before request ${usage.response_id} in session ${sessionId}`,
          );
        const u = usage.usage;
        const cacheWrite = u.cache_write_input_tokens ?? 0;
        const tokens = {
          inputTokens: u.input_tokens - u.cached_input_tokens - cacheWrite,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cached_input_tokens,
          cacheWrite5mTokens: cacheWrite,
          cacheWrite1hTokens: 0,
        };
        const triggerAt = state.lastUserAt;
        const row: RequestRow = {
          sessionId,
          messageId: usage.response_id,
          seq: state.nextSeq++,
          agentId: null,
          timestamp: new Date(at),
          triggerAt: triggerAt === null ? null : new Date(triggerAt),
          model,
          thinking: state.open.thinking,
          text: state.open.text,
          toolCalls: state.open.toolCalls,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cacheReadTokens: tokens.cacheReadTokens,
          cacheCreationTokens: cacheWrite,
          // Models missing from the price table record only tokens (Contracts 25.2)
          costUsd: hasPrice(model) ? costUsd(tokens, model) : 0,
          durationMs: triggerAt === null ? null : at - triggerAt,
          attributionSkill: null,
        };
        out.rows.set(usage.response_id, row);
        for (const [id, owner] of Object.entries(state.pending))
          if (owner === '') state.pending[id] = usage.response_id;
        state.open = { text: null, thinking: null, toolCalls: [] };
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// Incrementally parse a Codex rollout (Contracts 25.2): writes the session, requests, user messages and skill loads as ingestFile does,
// updates stages and binding, publishes session.updated. limit: maximum bytes to read this time
export function ingestCodexFile(db: Db, file: string, limit = Infinity): IngestResult {
  const absolute = path.resolve(file);
  if (!isRollout(absolute)) throw new Error(`Not a Codex rollout: ${absolute}`);
  const meta = readSessionMeta(absolute);
  if (meta === null) return { sessionId: '', changed: false, more: false };
  const sessionId = meta.id;

  const { changed, created, stageChanges, skillsAdded, more } = db.$client.transaction(() => {
    const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (existing !== undefined && existing.engine !== 'codex')
      throw new Error(`Session ${sessionId} was already imported as a Claude Code session`);
    // codex archive / unarchive moved the rollout (Contracts 25.3): continue reading from the new location
    const state = existing?.parseState ?? initialCodexState();
    if (!('kind' in state))
      throw new Error(`Parse state of session ${sessionId} is not a Codex one`);
    const offset = existing?.parseOffset ?? 0;
    const { lines, end, more } = readCompleteLines(absolute, offset, limit);
    // A rollout in archived_sessions/ is archived (also when archived or restored outside the dashboard, Contracts 25.3)
    const archived = path.basename(path.dirname(absolute)) === 'archived_sessions';
    const archivedAt = archived ? (existing?.archivedAt ?? new Date()) : null;
    if (lines.length === 0) {
      // Nothing new but the rollout moved (codex archive / unarchive): record the new location
      if (existing !== undefined && existing.filePath !== absolute)
        db.update(sessions)
          .set({ filePath: absolute, archivedAt })
          .where(eq(sessions.id, sessionId))
          .run();
      return {
        changed: false,
        created: false,
        stageChanges: [] as StageChange[],
        skillsAdded: false,
        more,
      };
    }
    const out = parseLines(db, sessionId, state, lines);
    const startedAt = existing?.startedAt ?? meta.startedAt;
    const endedAt = out.lastAt ?? existing?.endedAt.getTime() ?? startedAt.getTime();
    const flags = { lfg: false, ic: false };
    for (const row of out.rows.values())
      for (const c of row.toolCalls) {
        const f = detectFromToolCall(c);
        flags.lfg ||= f.lfg;
        flags.ic ||= f.ic;
      }
    for (const load of out.skillLoads)
      if (load.injected === true) {
        const f = detectFromSkill(load.name);
        flags.lfg ||= f.lfg;
        flags.ic ||= f.ic;
      }
    const firstUser = out.userMessages[0];
    const values = {
      filePath: absolute,
      archivedAt,
      cwd: existing?.cwd ?? meta.cwd,
      title: existing?.title ?? (firstUser === undefined ? null : sessionTitle(firstUser.text)),
      endedAt: new Date(endedAt),
      hasLfg: (existing?.hasLfg ?? false) || flags.lfg,
      hasIc: (existing?.hasIc ?? false) || flags.ic,
      liveId: existing?.liveId ?? liveIdFor(db, sessionId),
      parseOffset: end,
      parseState: state,
    };
    if (existing === undefined) {
      db.insert(sessions)
        .values({
          id: sessionId,
          engine: 'codex',
          startedAt,
          ...values,
        })
        .run();
      db.insert(sessionSkillScans).values({ sessionId, injectionsScanned: true }).run();
      markImported(db, sessionId, 'codex', absolute);
    } else db.update(sessions).set(values).where(eq(sessions.id, sessionId)).run();
    writeRows(db, out.rows.values());
    writeUserMessages(db, out.userMessages);
    writeSkillLoads(db, out.skillLoads);
    const changed = out.rows.size > 0 || out.userMessages.length > 0;
    return {
      changed,
      created: existing === undefined,
      stageChanges: changed ? updateStages(db, sessionId) : [],
      skillsAdded: out.skillLoads.length > 0,
      more,
    };
  })();

  // Import succeeded: clear any failure recorded before
  const recovered = clearImportFailure(sessionId);
  if (skillsAdded) rebindSession(db, config.dataDir, sessionId);
  // Also publish for a newly created session: a page already open read 404 before there were requests (e.g. only session_meta and the first input)
  // and relies on this event to read again
  if (changed || created || recovered) events.publish({ type: 'session.updated', sessionId });
  publishStageChanges(sessionId, stageChanges);
  return { sessionId, changed, more };
}

// Re-read Codex sessions imported before <skill> injection support (called once at server start, Contracts 16.6): read the rollout from the start up to the parsed offset,
// add the injected skill loads and the rough lfg / ic check, redo the binding, and split stages from the start (injections fall before already folded requests).
// Deleted rollouts have nothing to re-read. Returns the sessions that got injections added
export function backfillCodexInjections(db: Db): string[] {
  const pending = db
    .select({ id: sessions.id, filePath: sessions.filePath, parseOffset: sessions.parseOffset })
    .from(sessions)
    .innerJoin(sessionSkillScans, eq(sessionSkillScans.sessionId, sessions.id))
    .where(and(eq(sessions.engine, 'codex'), eq(sessionSkillScans.injectionsScanned, false)))
    .all();
  const filled: string[] = [];
  for (const session of pending) {
    const lines = existsSync(session.filePath)
      ? readCompleteLines(session.filePath, 0, session.parseOffset).lines
      : [];
    const loads = lines.flatMap((line) => {
      const record = CodexLine.parse(JSON.parse(line));
      if (record.type !== 'response_item') return [];
      return injectedLoads(
        session.id,
        ResponseItem.parse(record.payload),
        Date.parse(record.timestamp),
      );
    });
    const flags = loads.map((l) => detectFromSkill(l.name));
    db.$client.transaction(() => {
      writeSkillLoads(db, loads);
      if (flags.some((f) => f.lfg))
        db.update(sessions).set({ hasLfg: true }).where(eq(sessions.id, session.id)).run();
      if (flags.some((f) => f.ic))
        db.update(sessions).set({ hasIc: true }).where(eq(sessions.id, session.id)).run();
      db.update(sessionSkillScans)
        .set({ injectionsScanned: true })
        .where(eq(sessionSkillScans.sessionId, session.id))
        .run();
    })();
    if (loads.length === 0) continue;
    rebindSession(db, config.dataDir, session.id);
    db.delete(stageStates).where(eq(stageStates.sessionId, session.id)).run();
    publishStageChanges(session.id, updateStages(db, session.id));
    filled.push(session.id);
  }
  return filled;
}
