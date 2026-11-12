import { asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, runs, subagents } from '../db/schema.js';
import type { CrossRunRef } from '../grading/schema.js';
import type { RequestRow } from '../stages/rows.js';

// Contracts 7.11: references to other eval runs in ToolCall inputs of the run's requests (subagents included)

export const LINEAR_TOOL = /^mcp__.*linear.*__/i;
const EXCERPT_CHARS = 80;

// Longest first, so a literal that is a prefix of another does not win
export function alternation(literals: string[]): string {
  return [...literals]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// All strings in input (Bash command, Write content, each MCP argument) with their field paths
export function strings(value: unknown, at = '', out: { at: string; text: string }[] = []) {
  if (typeof value === 'string') out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${String(i)}]`, out));
  else if (typeof value === 'object' && value !== null)
    for (const [k, v] of Object.entries(value)) strings(v, at === '' ? k : `${at}.${k}`, out);
  return out;
}

// The excerpt is prefixed with the field path, e.g. command: …, removeRelatedTo[1]: TXE-3761
export function excerpt(at: string, text: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_CHARS);
  const to = Math.min(text.length, end + EXCERPT_CHARS);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${at === '' ? '' : `${at}: `}${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

const WORD = /[A-Za-z0-9-]/;

interface Field {
  at: string;
  text: string;
}

interface Hit {
  runId: string;
  kind: CrossRunRef['kind'];
  excerpt: string;
}

// Run ids in one field: wfe-<id> is repo, Features/<id> is vault, anything else is other
function idHits({ at, text }: Field, ids: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(ids)) {
    const prefix = m[1];
    const runId = m[2];
    if (runId === undefined) throw new Error('Run id regex has no capture group');
    const before = m.index === 0 ? '' : (text[m.index - 1] ?? '');
    if (prefix !== 'Features/' && WORD.test(before)) continue;
    hits.push({
      runId,
      kind: prefix === 'wfe-' ? 'repo' : prefix === 'Features/' ? 'vault' : 'other',
      excerpt: excerpt(at, text, m.index, m.index + m[0].length),
    });
  }
  return hits;
}

// Ticket identifiers of another run in Linear tool inputs
function ticketHits({ at, text }: Field, tickets: RegExp, byTicket: Map<string, string>): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(tickets)) {
    const before = m.index === 0 ? '' : (text[m.index - 1] ?? '');
    if (WORD.test(before)) continue;
    const runId = byTicket.get(m[1] ?? '');
    if (runId === undefined) throw new Error(`Matched unknown ticket ${m[0]}`);
    hits.push({
      runId,
      kind: 'ticket',
      excerpt: excerpt(at, text, m.index, m.index + m[0].length),
    });
  }
  return hits;
}

// A subagent's requests belong to the main-session request that started it; subagents can nest
export function mainSeqResolver(db: Db, sessionId: string, rows: RequestRow[]) {
  const rowByToolCall = new Map<string, RequestRow>();
  for (const row of rows) for (const call of row.toolCalls) rowByToolCall.set(call.id, row);
  const parentToolUse = new Map(
    db
      .select({ agentId: subagents.agentId, parent: subagents.parentToolUseId })
      .from(subagents)
      .where(eq(subagents.sessionId, sessionId))
      .all()
      .map((s) => [s.agentId, s.parent]),
  );
  const resolve = (row: RequestRow): number => {
    if (row.agentId === null) return row.seq;
    const toolUseId = parentToolUse.get(row.agentId);
    if (toolUseId === undefined) throw new Error(`Subagent ${row.agentId} is not registered`);
    const parent = rowByToolCall.get(toolUseId);
    if (parent === undefined) {
      throw new Error(
        `Parent call ${toolUseId} of subagent ${row.agentId} is not in session ${sessionId}`,
      );
    }
    return resolve(parent);
  };
  return resolve;
}

// One entry per (tool call, referenced run, kind), excerpt at the first occurrence; sorted by main session seq
export function scanCrossRunRefs(db: Db, runId: string): CrossRunRef[] {
  const run = db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`Run ${runId} does not exist`);
  const others = db
    .select({ id: runs.id, ticket: runs.linearIssueIdentifier })
    .from(runs)
    .where(ne(runs.id, runId))
    .all();
  if (others.length === 0) return [];
  const rows = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, run.sessionId))
    .orderBy(asc(requests.timestamp), asc(requests.id))
    .all();
  if (rows.length === 0) return [];

  const ids = new RegExp(
    `(wfe-|Features/)?(${alternation(others.map((o) => o.id))})(?![A-Za-z0-9-])`,
    'g',
  );
  const byTicket = new Map(
    others.flatMap((o) => (o.ticket === null ? [] : [[o.ticket, o.id] as const])),
  );
  const tickets =
    byTicket.size === 0
      ? null
      : new RegExp(`(${alternation([...byTicket.keys()])})(?![A-Za-z0-9])`, 'g');

  const mainSeq = mainSeqResolver(db, run.sessionId, rows);
  const refs: CrossRunRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const call of row.toolCalls) {
      for (const field of strings(call.input)) {
        const hits = idHits(field, ids);
        if (tickets !== null && LINEAR_TOOL.test(call.name)) {
          hits.push(...ticketHits(field, tickets, byTicket));
        }
        for (const hit of hits) {
          const key = `${call.id}\0${hit.runId}\0${hit.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({
            runId: hit.runId,
            kind: hit.kind,
            requestSeq: mainSeq(row),
            toolCallId: call.id,
            excerpt: hit.excerpt,
          });
        }
      }
    }
  }
  return refs.sort((a, b) => a.requestSeq - b.requestSeq);
}
