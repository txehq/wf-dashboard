import { and, asc, count, desc, eq, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  requests,
  sessions,
  sources,
  stageAnalyses,
  subagents,
  userMessages,
  workflows,
} from '../db/schema.js';
import {
  homeSourceDirs,
  importCheckedSources,
  listSources,
  setCheckedSources,
  type SourceDirs,
} from '../ingest/sources.js';

const ErrorBody = z.object({ error: z.string() });

const Source = z.object({
  path: z.string(),
  variant: z.string().nullable(),
  sessionCount: z.number().int(),
  lastModified: z.iso.datetime().nullable(),
  checked: z.boolean(),
});

const Tokens = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheCreation: z.number().int(),
});

const SessionSummary = z.object({
  id: z.string(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  // 来源目录；dashboard 发起的运行不属于勾选来源时为空
  source: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  // 以下统计含子代理的请求
  requestCount: z.number().int(),
  tokens: Tokens,
  costUsd: z.number(),
  workflows: z.array(z.enum(workflows)),
  analyzed: z.boolean(),
  runId: z.string().nullable(),
});
type SessionSummary = z.infer<typeof SessionSummary>;

const SessionDetail = SessionSummary.extend({
  subagentCount: z.number().int(),
  toolCallCount: z.number().int(),
  toolCounts: z.record(z.string(), z.number().int()),
  subagents: z.array(
    z.object({
      agentId: z.string(),
      agentType: z.string(),
      description: z.string().nullable(),
      parentToolUseId: z.string(),
      requestCount: z.number().int(),
    }),
  ),
});

const ToolCallBody = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  result: z.string().nullable(),
  resultChars: z.number().int(),
  isError: z.boolean(),
  spillPath: z.string().nullable(),
  subagentId: z.string().nullable(),
});

const RequestItem = z.object({
  kind: z.literal('request'),
  seq: z.number().int(),
  messageId: z.string(),
  agentId: z.string().nullable(),
  timestamp: z.iso.datetime(),
  model: z.string(),
  thinking: z.string().nullable(),
  text: z.string().nullable(),
  toolCalls: z.array(ToolCallBody),
  tokens: Tokens,
  costUsd: z.number(),
  durationMs: z.number().int().nullable(),
  attributionSkill: z.string().nullable(),
});

// 用户消息，或 Claude Code 生成的系统事件（后台任务通知、本地命令输出）
const UserItem = z.object({
  kind: z.enum(['user', 'notice']),
  text: z.string(),
  timestamp: z.iso.datetime(),
});

const Cursor = z.object({ startedAt: z.number().int(), id: z.string() });

function encodeCursor(c: z.infer<typeof Cursor>) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(s: string) {
  return Cursor.parse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')));
}

const summaryColumns = {
  id: sessions.id,
  cwd: sessions.cwd,
  title: sessions.title,
  source: sources.path,
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
  hasLfg: sessions.hasLfg,
  hasIc: sessions.hasIc,
  runId: sessions.runId,
};

interface SummaryRow {
  id: string;
  cwd: string | null;
  title: string | null;
  source: string | null;
  startedAt: Date;
  endedAt: Date;
  hasLfg: boolean;
  hasIc: boolean;
  runId: string | null;
}

function summaries(db: Db, rows: SummaryRow[]): SessionSummary[] {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const totals = new Map(
    db
      .select({
        sessionId: requests.sessionId,
        count: count(),
        input: sql<number>`sum(${requests.inputTokens})`,
        output: sql<number>`sum(${requests.outputTokens})`,
        cacheRead: sql<number>`sum(${requests.cacheReadTokens})`,
        cacheCreation: sql<number>`sum(${requests.cacheCreationTokens})`,
        costUsd: sql<number>`sum(${requests.costUsd})`,
      })
      .from(requests)
      .where(inArray(requests.sessionId, ids))
      .groupBy(requests.sessionId)
      .all()
      .map((t) => [t.sessionId, t]),
  );
  // 判定完成时 stages 模块写 stage_analyses，不含 lfg 与 ic 的 session 也有一行
  const analyzed = new Set(
    db
      .select({ id: stageAnalyses.sessionId })
      .from(stageAnalyses)
      .where(inArray(stageAnalyses.sessionId, ids))
      .all()
      .map((r) => r.id),
  );
  return rows.map((r) => {
    const t = totals.get(r.id);
    return {
      id: r.id,
      cwd: r.cwd,
      title: r.title,
      source: r.source,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt.toISOString(),
      requestCount: t?.count ?? 0,
      tokens: {
        input: t?.input ?? 0,
        output: t?.output ?? 0,
        cacheRead: t?.cacheRead ?? 0,
        cacheCreation: t?.cacheCreation ?? 0,
      },
      costUsd: t?.costUsd ?? 0,
      workflows: workflows.filter((w) => (w === 'lfg' ? r.hasLfg : r.hasIc)),
      analyzed: analyzed.has(r.id),
      runId: r.runId,
    };
  });
}

// 未勾选来源的 session 不出现；不属于任何来源的（dashboard 发起的运行）总是出现
const visible = or(isNull(sessions.sourceId), eq(sources.enabled, true));

export interface SessionsRoutesOptions {
  db: Db;
  dirs: SourceDirs;
}

export const sessionsRoutes: FastifyPluginCallbackZod<SessionsRoutesOptions> = (
  app,
  { db, dirs },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const sourcesBody = () =>
    listSources(db, dirs).map((s) => ({
      ...s,
      lastModified: s.lastModified === null ? null : s.lastModified.toISOString(),
    }));

  app.get('/sources', { schema: { response: { 200: z.array(Source) } } }, () => sourcesBody());

  app.put(
    '/sources',
    {
      schema: {
        body: z.object({ paths: z.array(z.string()) }),
        response: {
          200: z.object({
            sources: z.array(Source),
            imported: z.object({
              files: z.number().int(),
              changedSessions: z.number().int(),
              durationMs: z.number().int(),
            }),
          }),
          400: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const known = new Set(homeSourceDirs(dirs));
      const unknown = request.body.paths.filter((p) => !known.has(p));
      if (unknown.length > 0)
        return reply
          .code(400)
          .send({ error: `不是 ${dirs.projectsDir} 下的目录：${unknown.join(', ')}` });
      setCheckedSources(db, dirs, request.body.paths);
      const imported = importCheckedSources(db);
      return { sources: sourcesBody(), imported };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        querystring: z.object({
          source: z.string().optional(),
          q: z.string().min(1).optional(),
          workflow: z.enum(workflows).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({ sessions: z.array(SessionSummary), nextCursor: z.string().nullable() }),
        },
      },
    },
    (request) => {
      const { source, q, workflow, limit, cursor } = request.query;
      const conditions = [visible];
      if (source !== undefined) conditions.push(eq(sources.path, source));
      if (q !== undefined) {
        const pattern = `%${q}%`;
        conditions.push(
          or(
            like(sessions.title, pattern),
            like(sessions.cwd, pattern),
            like(sessions.id, pattern),
          ),
        );
      }
      if (workflow === 'lfg') conditions.push(eq(sessions.hasLfg, true));
      if (workflow === 'ic') conditions.push(eq(sessions.hasIc, true));
      if (cursor !== undefined) {
        const c = decodeCursor(cursor);
        const at = new Date(c.startedAt);
        conditions.push(
          or(lt(sessions.startedAt, at), and(eq(sessions.startedAt, at), lt(sessions.id, c.id))),
        );
      }
      const rows = db
        .select(summaryColumns)
        .from(sessions)
        .leftJoin(sources, eq(sessions.sourceId, sources.id))
        .where(and(...conditions))
        .orderBy(desc(sessions.startedAt), desc(sessions.id))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        sessions: summaries(db, page),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ startedAt: last.startedAt.getTime(), id: last.id })
            : null,
      };
    },
  );

  app.get(
    '/sessions/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: SessionDetail, 404: ErrorBody },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const row = db
        .select(summaryColumns)
        .from(sessions)
        .leftJoin(sources, eq(sessions.sourceId, sources.id))
        .where(eq(sessions.id, id))
        .get();
      if (row === undefined) return reply.code(404).send({ error: `session ${id} 不存在` });
      const [summary] = summaries(db, [row]);
      if (summary === undefined) throw new Error(`session ${id} 的汇总为空`);
      const toolRows = db.$client
        .prepare<[string], { name: string; n: number }>(
          `select json_extract(j.value, '$.name') as name, count(*) as n
           from requests r, json_each(r.tool_calls) j
           where r.session_id = ? group by name order by n desc, name`,
        )
        .all(id);
      const agentRequests = new Map(
        db
          .select({ agentId: requests.agentId, n: count() })
          .from(requests)
          .where(eq(requests.sessionId, id))
          .groupBy(requests.agentId)
          .all()
          .map((r) => [r.agentId, r.n]),
      );
      const subs = db
        .select()
        .from(subagents)
        .where(eq(subagents.sessionId, id))
        .orderBy(asc(subagents.agentId))
        .all();
      return {
        ...summary,
        subagentCount: subs.length,
        toolCallCount: toolRows.reduce((s, r) => s + r.n, 0),
        toolCounts: Object.fromEntries(toolRows.map((r) => [r.name, r.n])),
        subagents: subs.map((s) => ({
          agentId: s.agentId,
          agentType: s.agentType,
          description: s.description,
          parentToolUseId: s.parentToolUseId,
          requestCount: agentRequests.get(s.agentId) ?? 0,
        })),
      };
    },
  );

  app.get(
    '/sessions/:id/requests',
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({
          agent: z.string().optional(),
          fromSeq: z.coerce.number().int().min(0).optional(),
          toSeq: z.coerce.number().int().min(0).optional(),
        }),
        response: {
          200: z.object({ items: z.array(z.discriminatedUnion('kind', [RequestItem, UserItem])) }),
          404: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { agent, fromSeq, toSeq } = request.query;
      const session = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      if (session === undefined) return reply.code(404).send({ error: `session ${id} 不存在` });
      if (agent !== undefined) {
        const sub = db
          .select({ agentId: subagents.agentId })
          .from(subagents)
          .where(and(eq(subagents.sessionId, id), eq(subagents.agentId, agent)))
          .get();
        if (sub === undefined)
          return reply.code(404).send({ error: `session ${id} 中没有子代理 ${agent}` });
      }
      const ofAgent = (column: typeof requests.agentId | typeof userMessages.agentId) =>
        agent === undefined ? isNull(column) : eq(column, agent);
      const seqAt = (seq: number) =>
        db
          .select({ timestamp: requests.timestamp })
          .from(requests)
          .where(and(eq(requests.sessionId, id), ofAgent(requests.agentId), eq(requests.seq, seq)))
          .get()?.timestamp;

      const requestConditions = [eq(requests.sessionId, id), ofAgent(requests.agentId)];
      if (fromSeq !== undefined) requestConditions.push(sql`${requests.seq} >= ${fromSeq}`);
      if (toSeq !== undefined) requestConditions.push(sql`${requests.seq} <= ${toSeq}`);
      const rows = db
        .select()
        .from(requests)
        .where(and(...requestConditions))
        .orderBy(asc(requests.seq))
        .all();

      // 用户消息取 (fromSeq-1 的时间, toSeq 的时间]：触发 fromSeq 的消息在内，toSeq 之后的消息属于下一段
      const messageConditions = [eq(userMessages.sessionId, id), ofAgent(userMessages.agentId)];
      const lower = fromSeq === undefined || fromSeq === 0 ? undefined : seqAt(fromSeq - 1);
      const upper = toSeq === undefined ? undefined : seqAt(toSeq);
      if (lower !== undefined)
        messageConditions.push(sql`${userMessages.timestamp} > ${lower.getTime()}`);
      if (upper !== undefined)
        messageConditions.push(sql`${userMessages.timestamp} <= ${upper.getTime()}`);
      const messages = db
        .select()
        .from(userMessages)
        .where(and(...messageConditions))
        .orderBy(asc(userMessages.timestamp), asc(userMessages.id))
        .all();

      // 按时间合并；同一时间的用户消息与系统事件排在请求之前
      const items = [
        ...messages.map((message) => ({
          at: message.timestamp.getTime(),
          order: 0,
          item: {
            kind: message.kind,
            text: message.text,
            timestamp: message.timestamp.toISOString(),
          },
        })),
        ...rows.map((r) => ({
          at: r.timestamp.getTime(),
          order: 1 + r.seq,
          item: {
            kind: 'request' as const,
            seq: r.seq,
            messageId: r.messageId,
            agentId: r.agentId,
            timestamp: r.timestamp.toISOString(),
            model: r.model,
            thinking: r.thinking,
            text: r.text,
            toolCalls: r.toolCalls,
            tokens: {
              input: r.inputTokens,
              output: r.outputTokens,
              cacheRead: r.cacheReadTokens,
              cacheCreation: r.cacheCreationTokens,
            },
            costUsd: r.costUsd,
            durationMs: r.durationMs,
            attributionSkill: r.attributionSkill,
          },
        })),
      ]
        .sort((a, b) => a.at - b.at || a.order - b.order)
        .map((e) => e.item);
      return { items };
    },
  );

  done();
};
