import { asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { requests, runs, subagents } from '../db/schema.js';
import type { CrossRunRef } from '../grading/schema.js';
import type { RequestRow } from '../stages/rows.js';

// Contracts 7.11：run 的 requests（含子代理）中 ToolCall 输入里指向其他评估 run 的引用

const LINEAR_TOOL = /^mcp__.*linear.*__/i;
const EXCERPT_CHARS = 80;

// 长的在前，避免一个是另一个的前缀时匹配到短的
function alternation(literals: string[]): string {
  return [...literals]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// input 中的全部字符串（Bash 的 command、Write 的 content、MCP 的各个参数）与它们的字段路径
function strings(value: unknown, at = '', out: { at: string; text: string }[] = []) {
  if (typeof value === 'string') out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${String(i)}]`, out));
  else if (typeof value === 'object' && value !== null)
    for (const [k, v] of Object.entries(value)) strings(v, at === '' ? k : `${at}.${k}`, out);
  return out;
}

// 摘录前缀为字段路径，例如 command: …、removeRelatedTo[1]: TXE-3761
function excerpt(at: string, text: string, start: number, end: number): string {
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

// 一个字段中的 run id：wfe-<id> 为 repo，Features/<id> 为 vault，其余位置为 other
function idHits({ at, text }: Field, ids: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(ids)) {
    const prefix = m[1];
    const runId = m[2];
    if (runId === undefined) throw new Error('run id 的正则没有捕获组');
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

// Linear 工具输入中另一个 run 的工单 identifier
function ticketHits({ at, text }: Field, tickets: RegExp, byTicket: Map<string, string>): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(tickets)) {
    const before = m.index === 0 ? '' : (text[m.index - 1] ?? '');
    if (WORD.test(before)) continue;
    const runId = byTicket.get(m[1] ?? '');
    if (runId === undefined) throw new Error(`匹配到未知的工单 ${m[0]}`);
    hits.push({
      runId,
      kind: 'ticket',
      excerpt: excerpt(at, text, m.index, m.index + m[0].length),
    });
  }
  return hits;
}

// 子代理的请求归到发起它的主 session 请求；子代理可以嵌套
function mainSeqResolver(db: Db, sessionId: string, rows: RequestRow[]) {
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
    if (toolUseId === undefined) throw new Error(`子代理 ${row.agentId} 没有登记`);
    const parent = rowByToolCall.get(toolUseId);
    if (parent === undefined) {
      throw new Error(`子代理 ${row.agentId} 的父调用 ${toolUseId} 不在 session ${sessionId} 中`);
    }
    return resolve(parent);
  };
  return resolve;
}

// 每个 (tool 调用, 被引用的 run, kind) 一条，摘录取第一次出现的位置；按主 session seq 排序
export function scanCrossRunRefs(db: Db, runId: string): CrossRunRef[] {
  const run = db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`run ${runId} 不存在`);
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
