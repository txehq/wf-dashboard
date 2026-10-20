import fs from 'node:fs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import type { Db } from '../db/index.js';
import { requests, sessions, userMessages } from '../db/schema.js';
import { UserRecord } from './records.js';

// Contracts 第 11 节：从 session 的主 agent 记录整理出对话

export const AskQuestion = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

const AskInput = z.looseObject({ questions: z.array(AskQuestion) });

// 回答了的 AskUserQuestion，配对的 user 记录带结构化的 toolUseResult；被拒绝时 toolUseResult 是错误文字
const Answered = z.looseObject({ answers: z.record(z.string(), z.string()) });
const ToolResultRecord = UserRecord.extend({ toolUseResult: z.unknown().optional() });

export const ConversationItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['user', 'notice']),
    text: z.string(),
    timestamp: z.iso.datetime(),
    // 这条消息之后的第一次请求；session 最后一条消息之后没有请求时为空
    seq: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal('agent'),
    text: z.string(),
    timestamp: z.iso.datetime(),
    seq: z.number().int(),
  }),
  z.object({
    kind: z.literal('question'),
    toolCallId: z.string(),
    questions: z.array(AskQuestion),
    // 键为问题原文；没有回答（被拒绝或还在等待）时为空
    answers: z.record(z.string(), z.string()).nullable(),
    timestamp: z.iso.datetime(),
    seq: z.number().int(),
  }),
]);
export type ConversationItem = z.infer<typeof ConversationItem>;

// 从 jsonl 中取出这些 tool_use 的结构化回答
function readAnswers(file: string, ids: ReadonlySet<string>): Map<string, Record<string, string>> {
  const answers = new Map<string, Record<string, string>>();
  if (ids.size === 0) return answers;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"toolUseResult"')) continue;
    const id = [...ids].find((candidate) => line.includes(candidate));
    if (id === undefined) continue;
    const record = ToolResultRecord.parse(JSON.parse(line));
    const content = record.message.content;
    const paired =
      Array.isArray(content) &&
      content.some((block) => block.type === 'tool_result' && block.tool_use_id === id);
    if (!paired || typeof record.toolUseResult !== 'object' || record.toolUseResult === null) {
      continue;
    }
    answers.set(id, Answered.parse(record.toolUseResult).answers);
  }
  return answers;
}

export function sessionConversation(db: Db, sessionId: string): ConversationItem[] | null {
  const session = db
    .select({ filePath: sessions.filePath })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (session === undefined) return null;
  const rows = db
    .select({
      seq: requests.seq,
      timestamp: requests.timestamp,
      text: requests.text,
      toolCalls: requests.toolCalls,
    })
    .from(requests)
    .where(and(eq(requests.sessionId, sessionId), isNull(requests.agentId)))
    .orderBy(asc(requests.seq))
    .all();
  const messages = db
    .select()
    .from(userMessages)
    .where(and(eq(userMessages.sessionId, sessionId), isNull(userMessages.agentId)))
    .orderBy(asc(userMessages.timestamp), asc(userMessages.id))
    .all();

  const asks = rows.flatMap((r) =>
    r.toolCalls.filter((c) => c.name === 'AskUserQuestion').map((call) => ({ row: r, call })),
  );
  const answers = readAnswers(session.filePath, new Set(asks.map((a) => a.call.id)));

  const entries: { at: number; order: number; item: ConversationItem }[] = [];
  const nextSeq = (at: number) => rows.find((r) => r.timestamp.getTime() >= at)?.seq ?? null;
  for (const m of messages) {
    const at = m.timestamp.getTime();
    entries.push({
      at,
      order: 0,
      item: {
        kind: m.kind,
        text: m.kind === 'user' ? displayUserText(m.text) : m.text,
        timestamp: m.timestamp.toISOString(),
        seq: nextSeq(at),
      },
    });
  }
  for (const { row, call } of asks) {
    entries.push({
      at: row.timestamp.getTime(),
      order: 1,
      item: {
        kind: 'question',
        toolCallId: call.id,
        questions: AskInput.parse(call.input).questions,
        answers: answers.get(call.id) ?? null,
        timestamp: row.timestamp.toISOString(),
        seq: row.seq,
      },
    });
  }
  // 一轮：两条用户消息之间的请求；取其中最后一段回复文字
  const turnEnds = messages
    .filter((m) => m.kind === 'user')
    .map((m) => m.timestamp.getTime())
    .concat(Number.POSITIVE_INFINITY);
  let turn = 0;
  let last: (typeof rows)[number] | undefined;
  const flush = () => {
    if (last === undefined) return;
    entries.push({
      at: last.timestamp.getTime(),
      order: 2,
      item: {
        kind: 'agent',
        text: last.text ?? '',
        timestamp: last.timestamp.toISOString(),
        seq: last.seq,
      },
    });
    last = undefined;
  };
  for (const r of rows) {
    const at = r.timestamp.getTime();
    while (at >= (turnEnds[turn] ?? Number.POSITIVE_INFINITY)) {
      flush();
      turn += 1;
    }
    if (r.text !== null && r.text.trim() !== '') last = r;
  }
  flush();

  return entries.sort((a, b) => a.at - b.at || a.order - b.order).map((e) => e.item);
}
