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
  sources,
  subagents,
  type ToolCall,
  userMessages,
} from '../db/schema.js';
import { events } from '../events.js';
import { costUsd, fromApiUsage } from '../llm/pricing.js';
import { config } from '../config.js';
import { commandArgs } from '../api/user-text.js';
import { rebindSession, SKILL_PREFIX } from '../bindings/index.js';
import { publishStageChanges, type StageChange, updateStages } from '../stages/report.js';
import { inputString } from '../stages/rows.js';
import { AnyRecord, AssistantRecord, SubagentMeta, UserRecord } from './records.js';
import { detectFromToolCall, detectFromUserText, type WorkflowFlags } from './workflows.js';

type RequestRow = typeof requests.$inferInsert;
type UserMessageRow = typeof userMessages.$inferInsert;
type SkillLoadRow = typeof sessionSkills.$inferInsert;

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
// 从 offset 读到最后一个换行为止的完整行。给了 limit 时最多读 limit 字节（一行比 limit 长时读完这一行所在的剩余部分），
// more 表示 limit 之后还有没读的内容
function readCompleteLines(
  file: string,
  offset: number,
  limit = Infinity,
): { lines: string[]; end: number; more: boolean } {
  const fd = openSync(file, 'r');
  const size = fstatSync(fd).size;
  if (size < offset)
    throw new Error(`${file} 的大小 ${String(size)} 小于已解析的偏移量 ${String(offset)}`);
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
  if (lastNewline === -1) return { lines: [], end: offset, more: false };
  const lines = buffer
    .toString('utf8', 0, lastNewline)
    .split('\n')
    .filter((l) => l.length > 0);
  return { lines, end: offset + lastNewline + 1, more };
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

// Claude Code 自己生成的 user 记录：后台任务通知、本地命令输出；以及其他 agent 会话发来的消息（Contracts 第 2 节）
function isNotice(record: UserRecord, text: string): boolean {
  return (
    record.origin?.kind === 'task-notification' ||
    isPeer(record) ||
    text.startsWith('<local-command-stdout>')
  );
}

// 其他 Claude session 发来的消息（Orca orchestration）：origin.kind 为 peer、isMeta，正文为
// "Another Claude session sent a message:" 加上带发送方的 <cross-session-message> 元素
function isPeer(record: UserRecord): boolean {
  return record.origin?.kind === 'peer';
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
      // peer 消息虽然是 isMeta，也作为 notice 返回；它开始新的一轮，之后第一条请求的 duration_ms 从它算起
      const isInput =
        (record.isMeta !== true || isPeer(record)) && record.isCompactSummary !== true;
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
      if (record.isMeta === true && !isPeer(record)) {
        const loads = texts.filter((t) => SKILL_PREFIX.test(t));
        if (loads.length > 1) throw new Error(`记录 ${record.uuid} 中有多段 skill 正文`);
        const [load] = loads;
        if (load !== undefined) out.skillLoads.push(skillLoad(ctx, out, record, load, at));
      }
    }
  }
  return out;
}

// 加载 skill 的 isMeta 记录（Contracts 15.1）：参数来自 sourceToolUseID 指向的 Skill 调用的 input.args，
// 或 parentUuid 指向的 slash 命令消息中的 <command-args>
function skillLoad(
  ctx: ParseContext,
  out: ParseOutput,
  record: UserRecord,
  text: string,
  at: number,
): SkillLoadRow {
  const match = SKILL_PREFIX.exec(text);
  if (match?.[1] === undefined) throw new Error(`记录 ${record.uuid} 不是 skill 正文`);
  const baseDir = match[1];
  const name = path.basename(baseDir);
  let args: string;
  if (record.sourceToolUseID !== undefined) {
    const call = findToolCall(ctx, out, record.sourceToolUseID);
    if (call === undefined) {
      throw new Error(
        `skill ${name} 的正文（记录 ${record.uuid}）指向的 tool 调用 ${record.sourceToolUseID} 不存在`,
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
        `skill ${name} 的正文（记录 ${record.uuid}）既没有指向 Skill 调用，上一条记录 ${String(parent)} 也不是 slash 命令`,
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

function writeSkillLoads(db: Db, rows: SkillLoadRow[]) {
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

// 交互区中这个 session 所属的项（Contracts 14.1，claude_session_id 唯一）
function liveIdFor(db: Db, sessionId: string): string | null {
  return (
    db
      .select({ id: liveSessions.id })
      .from(liveSessions)
      .where(eq(liveSessions.claudeSessionId, sessionId))
      .get()?.id ?? null
  );
}

// resume 时 session 复制进了另一个配置目录，之后导入那一份（Contracts 14.5）；原文件不再导入
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
  // 给了 limit 时：主 jsonl 中还有没读的内容，再调用一次接着读
  more: boolean;
}

// 增量解析一个主 session jsonl 及其 subagents/；写入后发 session.updated。
// limit：本次最多读主 jsonl 的多少字节；导入大的 session 时分段读，每段一个事务，段与段之间服务端可以处理其他请求
export function ingestFile(db: Db, file: string, limit = Infinity): IngestResult {
  const absolute = path.resolve(file);
  if (!absolute.endsWith('.jsonl')) throw new Error(`不是 jsonl 文件：${absolute}`);
  const sessionId = path.basename(absolute, '.jsonl');
  const sessionDir = path.join(path.dirname(absolute), sessionId);
  const spillDir = path.join(sessionDir, 'tool-results');

  const { changed, stageChanges, skillsAdded, more } = db.$client.transaction(() => {
    const unchanged = {
      changed: false,
      stageChanges: [] as StageChange[],
      skillsAdded: false,
      more: false,
    };
    const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (existing !== undefined && existing.filePath !== absolute) {
      if (resumedElsewhere(db, sessionId)) return unchanged;
      throw new Error(
        `session ${sessionId} 已从 ${existing.filePath} 导入，不能再从 ${absolute} 导入`,
      );
    }
    const offset = existing?.parseOffset ?? 0;
    const state = existing?.parseState ?? initialParseState();
    const { lines, end, more } = readCompleteLines(absolute, offset, limit);
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
      // 还没有任何带时间的记录时不建 session，下次从头再读
      if (existing === undefined && out.firstAt === null) return unchanged;
      const startedAt = existing?.startedAt.getTime() ?? out.firstAt;
      const endedAt = out.lastAt ?? existing?.endedAt.getTime();
      if (startedAt == null || endedAt === undefined) throw new Error(`${absolute} 缺少记录时间`);
      const flags = flagsOf(out.rows.values(), out.userMessages);
      const firstUser = out.userMessages.find((m) => m.kind === 'user');
      const runId = existing?.runId ?? runIdFor(db, sessionId);
      const values = {
        cwd: existing?.cwd ?? out.cwd,
        title: existing?.title ?? (firstUser === undefined ? null : titleOf(firstUser.text)),
        endedAt: new Date(endedAt),
        hasLfg: (existing?.hasLfg ?? false) || flags.lfg,
        hasIc: (existing?.hasIc ?? false) || flags.ic,
        runId,
        liveId: existing?.liveId ?? liveIdFor(db, sessionId),
        parseOffset: end,
        parseState: state,
        // run 的 session 绑定 run 所用的 variant（Contracts 15.1）
        ...(runId !== null && existing?.variantBinding !== 'run'
          ? { variantId: runVariantId(db, runId), variantBinding: 'run' as const }
          : {}),
      };
      if (existing === undefined) {
        db.insert(sessions)
          .values({
            id: sessionId,
            filePath: absolute,
            sourceId: sourceIdFor(db, path.dirname(absolute)),
            startedAt: new Date(startedAt),
            ...values,
          })
          .run();
        db.insert(sessionSkillScans).values({ sessionId }).run();
      } else db.update(sessions).set(values).where(eq(sessions.id, sessionId)).run();
      writeRows(db, out.rows.values());
      writeUserMessages(db, out.userMessages);
      writeSkillLoads(db, out.skillLoads);
      changed = out.rows.size > 0 || out.userMessages.length > 0;
      skillsAdded = out.skillLoads.length > 0;
    } else if (existing === undefined) return unchanged;

    if (registerSubagents(db, sessionId, path.join(sessionDir, 'subagents'))) changed = true;
    const sub = ingestSubagents(db, sessionId, spillDir);
    if (sub.changed) changed = true;
    if (sub.skillsAdded) skillsAdded = true;
    // 阶段划分随导入增量更新（Contracts 第 5 节）
    return {
      changed,
      stageChanges: changed ? updateStages(db, sessionId) : [],
      skillsAdded,
      more,
    };
  })();

  // 新加载的 skill 可能改变自动绑定
  if (skillsAdded) rebindSession(db, config.dataDir, sessionId);
  if (changed) events.publish({ type: 'session.updated', sessionId });
  publishStageChanges(sessionId, stageChanges);
  return { sessionId, changed, more };
}

function runVariantId(db: Db, runId: string): string {
  const run = db.select({ variantId: runs.variantId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`run ${runId} 不存在`);
  return run.variantId;
}

// 已导入、但还没有提取过 skill 正文的 session（本功能之前导入的）：读主 jsonl 与子代理到已解析的偏移量，只提取 skill 加载；
// 返回补提取了的 session
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
      // 已被删除的 jsonl（例如 Claude Code 按 cleanupPeriodDays 清理的旧 session）没有可以提取的内容
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
    if (loads.length > 1) throw new Error(`记录 ${record.uuid} 中有多段 skill 正文`);
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
): { changed: boolean; skillsAdded: boolean } {
  const all = db.select().from(subagents).where(eq(subagents.sessionId, sessionId)).all();
  const byToolUse = new Map(all.map((s) => [s.parentToolUseId, s.agentId]));
  let changed = false;
  let skillsAdded = false;
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
  return { changed, skillsAdded };
}
