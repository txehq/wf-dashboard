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
  type ParseState,
  requests,
  runs,
  sessions,
  sources,
  subagents,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { events } from '../events.js';
import { costUsd, fromApiUsage } from '../llm/pricing.js';
import { config } from '../config.js';
import { AnyRecord, AssistantRecord, SubagentMeta, UserRecord } from './records.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from './workflows.js';

type RequestRow = typeof requests.$inferInsert;
type UserMessageRow = typeof userMessages.$inferInsert;

const resultLimit = 20_000;

// tool 结果截断到 20000 个 UTF-16 单元（Contracts 2）；截断点落在代理对中间时少保留一个，不留下半个字符
export function truncateResult(text: string): string {
  if (text.length <= resultLimit) return text;
  const code = text.charCodeAt(resultLimit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? resultLimit - 1 : resultLimit;
  return text.slice(0, cut);
}
const titleLength = 80;
// Claude Code 在本地生成的 API 错误、中断提示，不是模型请求
const syntheticModel = '<synthetic>';
const persisted = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: (.+)$/m;

export function initialParseState(): ParseState {
  return { nextSeq: 0, lastUserAt: null, pending: {} };
}

// 读取 offset 之后的全部完整行；末尾没有换行的半行留到下一次
function readCompleteLines(file: string, offset: number): { lines: string[]; end: number } {
  const fd = openSync(file, 'r');
  const size = fstatSync(fd).size;
  if (size < offset)
    throw new Error(`${file} 的大小 ${String(size)} 小于已解析的偏移量 ${String(offset)}`);
  const buffer = Buffer.alloc(size - offset);
  let read = 0;
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  closeSync(fd);
  const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], end: offset };
  const lines = buffer
    .toString('utf8', 0, lastNewline)
    .split('\n')
    .filter((l) => l.length > 0);
  return { lines, end: offset + lastNewline + 1 };
}

function resultText(content: UserRecordToolResult['content']): string {
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

// fork 子代理继承的父代理对话：派生它的 Agent 调用的 tool_result 之前的记录都跳过
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

// Claude Code 自己生成的 user 记录：后台任务通知、本地命令输出（Contracts 第 2 节）
function isNotice(record: UserRecord, text: string): boolean {
  return record.origin?.kind === 'task-notification' || text.startsWith('<local-command-stdout>');
}

function parseLines(ctx: ParseContext, lines: string[]): ParseOutput {
  const out: ParseOutput = {
    rows: new Map(),
    userMessages: [],
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
      // 同一 message 的每条记录都带 usage，后面的记录 output_tokens 更完整；只保留最后一份
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
      const isInput = record.isMeta !== true && record.isCompactSummary !== true;
      const { content } = record.message;
      const texts: string[] = [];
      if (typeof content === 'string') texts.push(content);
      else
        for (const block of content) {
          if (block.type === 'text') texts.push(block.text);
          if (block.type === 'tool_result') {
            // 派生 fork 的 Agent 调用属于父代理，它的结果之后才是 fork 自己的对话
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
      // 其他 Claude session 发来的消息（Orca orchestration，isMeta）同样开始新的一轮：之后第一条请求的
      // duration_ms 从它算起。它不作为用户消息返回（归类待 Contracts 2 约定）
      if (record.origin?.kind === 'peer') state.lastUserAt = at;
    }
  }
  return out;
}

function attachResult(
  ctx: ParseContext,
  block: UserRecordToolResult,
  touch: (messageId: string) => RequestRow | undefined,
) {
  const messageId = ctx.state.pending[block.tool_use_id];
  if (messageId === undefined)
    throw new Error(
      `tool_result ${block.tool_use_id} 没有对应的 tool_use（session ${ctx.sessionId}）`,
    );
  const row = touch(messageId);
  const call = row?.toolCalls.find((c) => c.id === block.tool_use_id);
  if (call === undefined)
    throw new Error(`message ${messageId} 中没有 tool_use ${block.tool_use_id}`);
  const text = resultText(block.content);
  call.result = truncateResult(text);
  call.resultChars = text.length;
  call.isError = block.is_error === true;
  call.spillPath = spillPath(ctx, text);
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete ctx.state.pending[block.tool_use_id];
}

// 溢出文件位于 <sessionId>/tool-results/；jsonl 中记录的是写入时的绝对路径，按文件名定位到本地副本
function spillPath(ctx: ParseContext, text: string): string | null {
  if (!text.startsWith('<persisted-output>')) return null;
  const match = persisted.exec(text);
  if (match?.[1] === undefined) throw new Error(`无法识别溢出输出的路径：${text.slice(0, 200)}`);
  const local = path.join(ctx.spillDir, path.basename(match[1]));
  if (!existsSync(local)) throw new Error(`溢出文件不存在：${local}`);
  return local;
}

function writeRows(db: Db, rows: Iterable<RequestRow>) {
  for (const row of rows) {
    const { id, ...values } = row;
    if (id === undefined) db.insert(requests).values(values).run();
    else db.update(requests).set(values).where(eq(requests.id, id)).run();
  }
}

function writeUserMessages(db: Db, rows: UserMessageRow[]) {
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

// data/variants/<variant>/home/claude/projects/<slug>
function variantOfDir(dir: string): string | null {
  const relative = path.relative(config.variantsDir, dir);
  const parts = relative.split(path.sep);
  if (parts.length === 5 && parts[1] === 'home' && parts[2] === 'claude' && parts[3] === 'projects')
    return parts[0] ?? null;
  return null;
}

function sourceIdFor(db: Db, dir: string): number | null {
  const existing = db.select({ id: sources.id }).from(sources).where(eq(sources.path, dir)).get();
  if (existing !== undefined) return existing.id;
  const variant = variantOfDir(dir);
  if (variant === null) return null;
  return db
    .insert(sources)
    .values({ path: dir, enabled: true, variant })
    .returning({ id: sources.id })
    .get().id;
}

function runIdFor(db: Db, sessionId: string): string | null {
  return (
    db.select({ id: runs.id }).from(runs).where(eq(runs.sessionId, sessionId)).get()?.id ?? null
  );
}

function titleOf(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, titleLength).join('');
}

// 把指向 toolUseId 的 ToolCall 标上子代理；父调用尚未解析时由 parseLines 在解析到它时标上
function linkSubagent(db: Db, sessionId: string, toolUseId: string, agentId: string) {
  const found = db.$client
    .prepare<[string, string], { id: number }>(
      `select r.id as id from requests r, json_each(r.tool_calls) j
       where r.session_id = ? and json_extract(j.value, '$.id') = ?`,
    )
    .get(sessionId, toolUseId);
  if (found === undefined) return;
  const row = db.select().from(requests).where(eq(requests.id, found.id)).get();
  if (row === undefined) throw new Error(`request ${String(found.id)} 不存在`);
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

// 登记新出现的 agent-<id>.jsonl；meta.json 尚未写出的子代理留到下一次
function registerSubagents(db: Db, sessionId: string, dir: string): boolean {
  if (!existsSync(dir)) return false;
  let added = false;
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
    const meta = SubagentMeta.parse(JSON.parse(readFileSync(metaPath, 'utf8')));
    db.insert(subagents)
      .values({
        sessionId,
        agentId,
        filePath,
        parentToolUseId: meta.toolUseId,
        agentType: meta.agentType,
        description: meta.description ?? null,
        parseState:
          meta.isFork === true
            ? { ...initialParseState(), forkToolUseId: meta.toolUseId }
            : initialParseState(),
      })
      .run();
    linkSubagent(db, sessionId, meta.toolUseId, agentId);
    added = true;
  }
  return added;
}

export interface IngestResult {
  sessionId: string;
  // 本次是否写入了新的请求、用户消息或子代理
  changed: boolean;
}

// 增量解析一个主 session jsonl 及其 subagents/；写入后发 session.updated
export function ingestFile(db: Db, file: string): IngestResult {
  const absolute = path.resolve(file);
  if (!absolute.endsWith('.jsonl')) throw new Error(`不是 jsonl 文件：${absolute}`);
  const sessionId = path.basename(absolute, '.jsonl');
  const sessionDir = path.join(path.dirname(absolute), sessionId);
  const spillDir = path.join(sessionDir, 'tool-results');

  const changed = db.$client.transaction(() => {
    const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (existing !== undefined && existing.filePath !== absolute)
      throw new Error(
        `session ${sessionId} 已从 ${existing.filePath} 导入，不能再从 ${absolute} 导入`,
      );
    const offset = existing?.parseOffset ?? 0;
    const state = existing?.parseState ?? initialParseState();
    const { lines, end } = readCompleteLines(absolute, offset);
    let changed = false;

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
      // 还没有任何带时间的记录时不建 session，下次从头再读
      if (existing === undefined && out.firstAt === null) return false;
      const startedAt = existing?.startedAt.getTime() ?? out.firstAt;
      const endedAt = out.lastAt ?? existing?.endedAt.getTime();
      if (startedAt == null || endedAt === undefined) throw new Error(`${absolute} 缺少记录时间`);
      const flags = flagsOf(out.rows.values(), out.userMessages);
      const firstUser = out.userMessages.find((m) => m.kind === 'user');
      const values = {
        cwd: existing?.cwd ?? out.cwd,
        title: existing?.title ?? (firstUser === undefined ? null : titleOf(firstUser.text)),
        endedAt: new Date(endedAt),
        hasLfg: (existing?.hasLfg ?? false) || flags.lfg,
        hasIc: (existing?.hasIc ?? false) || flags.ic,
        runId: existing?.runId ?? runIdFor(db, sessionId),
        parseOffset: end,
        parseState: state,
      };
      if (existing === undefined)
        db.insert(sessions)
          .values({
            id: sessionId,
            filePath: absolute,
            sourceId: sourceIdFor(db, path.dirname(absolute)),
            startedAt: new Date(startedAt),
            ...values,
          })
          .run();
      else db.update(sessions).set(values).where(eq(sessions.id, sessionId)).run();
      writeRows(db, out.rows.values());
      writeUserMessages(db, out.userMessages);
      changed = out.rows.size > 0 || out.userMessages.length > 0;
    } else if (existing === undefined) return false;

    if (registerSubagents(db, sessionId, path.join(sessionDir, 'subagents'))) changed = true;
    if (ingestSubagents(db, sessionId, spillDir)) changed = true;
    return changed;
  })();

  if (changed) events.publish({ type: 'session.updated', sessionId });
  return { sessionId, changed };
}

function ingestSubagents(db: Db, sessionId: string, spillDir: string): boolean {
  const all = db.select().from(subagents).where(eq(subagents.sessionId, sessionId)).all();
  const byToolUse = new Map(all.map((s) => [s.parentToolUseId, s.agentId]));
  let changed = false;
  for (const sub of all) {
    const { lines, end } = readCompleteLines(sub.filePath, sub.parseOffset);
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
  return changed;
}
