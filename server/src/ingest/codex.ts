import { closeSync, openSync, readSync } from 'node:fs';
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
import { catSkill, resolveSkillPath } from './codex-skill.js';
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
import { detectFromToolCall } from './workflows.js';

type RequestRow = typeof requests.$inferInsert;
type UserMessageRow = typeof userMessages.$inferInsert;
type SkillLoadRow = typeof sessionSkills.$inferInsert;

// Codex rollout 的文件名：rollout-<时间>-<session id>.jsonl
export const isRollout = (file: string) => {
  const name = path.basename(file);
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
};

// Codex rollout 所在的 CODEX_HOME：<CODEX_HOME>/sessions/YYYY/MM/DD/<rollout> 或 <CODEX_HOME>/archived_sessions/<rollout>
export function codexHomeOf(filePath: string): string {
  const parts = filePath.split(path.sep);
  const at = parts.lastIndexOf('archived_sessions');
  if (at > 0 && at === parts.length - 2) return parts.slice(0, at).join(path.sep);
  const s = parts.lastIndexOf('sessions');
  if (s > 0 && s === parts.length - 5) return parts.slice(0, s).join(path.sep);
  throw new Error(`${filePath} 不在 CODEX_HOME 的 sessions/ 或 archived_sessions/ 中`);
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

// rollout 的第一行（session_meta）：base_instructions 有几十 KB，按段读到第一个换行
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
  // 第一行还没有写完整时没有 session_meta
  if (!line.endsWith('}')) return null;
  const record = CodexLine.parse(JSON.parse(line));
  if (record.type !== 'session_meta') throw new Error(`${file} 的第一行不是 session_meta`);
  const meta = SessionMeta.parse(record.payload);
  return { id: meta.id, cwd: meta.cwd, startedAt: new Date(meta.timestamp) };
}

// CommandExecution 的 cwd 是 file:// 地址
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

// 调用输出的原文：字符串，或 input_text 等部分的文字
export const outputText = (output: string | { text?: string | undefined }[]) =>
  typeof output === 'string' ? output : textOf(output);

// 执行的项的结果原文；搜索没有结果
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

// exec 脚本中执行的项（命令、MCP 工具、补丁、搜索）记成这次调用之后的 tool 调用；模型直接调用 exec_command、
// MCP 函数时执行的项就是这次调用本身，不重复记
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

// 一次 CommandExecution 是否加载了 skill：一次 cat 读取 SKILL.md、成功，输出就是全文；记下正文（去掉 frontmatter），
// 与 variant 的 SKILL.md 逐字节比较（Contracts 15.1）
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

// 一段 rollout 行的开头信息（Contracts 25.1，列出磁盘上的 session 用）：开始时间（与导入相同，取 session_meta 的
// timestamp），与 parseLines 相同地取的第一条用户消息（UserMessage）的正文；没有时为 null
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
    if (row === undefined) throw new Error(`session ${sessionId} 中没有请求 ${messageId}`);
    out.rows.set(messageId, row);
    return row;
  };
  // call_id 所在的 tool 调用：还在形成中的请求，或已写入的请求
  const callOf = (callId: string): ToolCall => {
    const owner = state.pending[callId];
    if (owner === undefined) throw new Error(`session ${sessionId} 中没有等待输出的调用 ${callId}`);
    const list = owner === '' ? state.open.toolCalls : touch(owner).toolCalls;
    const found = list.find((c) => c.id === callId);
    if (found === undefined) throw new Error(`请求 ${owner} 中没有调用 ${callId}`);
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
          if (id === undefined) throw new Error(`${item.type} 没有 id`);
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
        // 执行的项属于最后一个还在等输出的调用；只有 exec 脚本中执行的才另记
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
          throw new Error(`session ${sessionId} 的请求 ${usage.response_id} 之前没有 turn_context`);
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
          // 价格表中没有的模型只记 token（Contracts 25.2）
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

// 增量解析一个 Codex rollout（Contracts 25.2）：与 ingestFile 相同地写入 session、请求、用户消息与 skill 加载，
// 更新阶段与绑定，发 session.updated。limit：本次最多读多少字节
export function ingestCodexFile(db: Db, file: string, limit = Infinity): IngestResult {
  const absolute = path.resolve(file);
  if (!isRollout(absolute)) throw new Error(`不是 Codex 的 rollout：${absolute}`);
  const meta = readSessionMeta(absolute);
  if (meta === null) return { sessionId: '', changed: false, more: false };
  const sessionId = meta.id;

  const { changed, created, stageChanges, skillsAdded, more } = db.$client.transaction(() => {
    const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (existing !== undefined && existing.engine !== 'codex')
      throw new Error(`session ${sessionId} 已作为 Claude Code 的 session 导入`);
    // codex archive / unarchive 移动了 rollout（Contracts 25.3）：接着从新的位置读
    const state = existing?.parseState ?? initialCodexState();
    if (!('kind' in state)) throw new Error(`session ${sessionId} 的解析状态不是 Codex 的`);
    const offset = existing?.parseOffset ?? 0;
    const { lines, end, more } = readCompleteLines(absolute, offset, limit);
    // archived_sessions/ 中的 rollout 是已归档的（在 dashboard 之外归档或恢复的也一样，Contracts 25.3）
    const archived = path.basename(path.dirname(absolute)) === 'archived_sessions';
    const archivedAt = archived ? (existing?.archivedAt ?? new Date()) : null;
    if (lines.length === 0) {
      // 没有新内容但 rollout 被移动了（codex archive / unarchive）：记下新的位置
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
      db.insert(sessionSkillScans).values({ sessionId }).run();
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

  if (skillsAdded) rebindSession(db, config.dataDir, sessionId);
  // 新建出的 session 也发：还没有请求时（例如只有 session_meta 与第一条输入）已经打开的页面先前读到的是 404，
  // 要靠这个事件重新读取
  if (changed || created) events.publish({ type: 'session.updated', sessionId });
  publishStageChanges(sessionId, stageChanges);
  return { sessionId, changed, more };
}
