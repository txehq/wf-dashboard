import fs from 'node:fs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import type { Db } from '../db/index.js';
import { requests, sessions, userMessages } from '../db/schema.js';
import { UserRecord } from './records.js';

// Contracts section 11: build the conversation from the session's main agent records

export const AskQuestion = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

const AskInput = z.looseObject({ questions: z.array(AskQuestion) });

// An answered AskUserQuestion: the paired user record carries a structured toolUseResult; when rejected it is the error text
const Answered = z.looseObject({ answers: z.record(z.string(), z.string()) });
const ToolResultRecord = UserRecord.extend({ toolUseResult: z.unknown().optional() });

export const ConversationItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['user', 'notice']),
    text: z.string(),
    timestamp: z.iso.datetime(),
    // The first request after this message; null when no request follows the session's last message
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
    // Keyed by the question text; null when unanswered (rejected or still waiting)
    answers: z.record(z.string(), z.string()).nullable(),
    timestamp: z.iso.datetime(),
    seq: z.number().int(),
  }),
]);
export type ConversationItem = z.infer<typeof ConversationItem>;

// Read the structured answers to these tool_use calls from the jsonl
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
  // A turn: the requests between two user messages; take the last reply text among them
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
