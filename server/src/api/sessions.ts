import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  liveSessions,
  requests,
  type SessionEngine,
  sessionEngines,
  sessions,
  subagents,
  userMessages,
  type VariantBinding,
  variantBindings,
  variants as variantsTable,
  workflows,
} from '../db/schema.js';
import { boundVariantNames } from '../bindings/index.js';
import { hasPrice } from '../llm/pricing.js';
import {
  configOwners,
  ownerOf,
  type SessionConfig,
  sessionConfigOf,
} from '../ingest/session-config.js';
import { importFiles, type SourceDirs } from '../ingest/sources.js';
import {
  configCondition,
  diskSessions,
  importableFiles,
  importConfigs,
  importedIds,
  importProjects,
} from '../ingest/session-import.js';
import { managed } from '../ingest/imports.js';
import { ConversationItem, sessionConversation } from '../ingest/conversation.js';
import { displayUserText } from './user-text.js';
import { sessionTitles } from './session-titles.js';
import { SessionLinks, sessionLinks } from './session-links.js';
import { config } from '../config.js';

const ErrorBody = z.object({ error: z.string() });

const Engine = z.enum(sessionEngines).default('claude');
// 第二、三列的分页（Contracts 25.5）
const ColumnPage = {
  q: z.string().default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};

const Tokens = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheCreation: z.number().int(),
});

const SessionSummary = z.object({
  id: z.string(),
  // Contracts 25.2、25.5
  engine: z.enum(sessionEngines),
  // 所属的配置（25.1）：local、variant:<id>、design；不在这些目录中时为空
  config: z.string().nullable(),
  // 设计与优化下的 session 的用途（25.4）
  purpose: z.enum(['design', 'optimize']).nullable(),
  archivedAt: z.iso.datetime().nullable(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  // 以下统计含子代理的请求
  requestCount: z.number().int(),
  tokens: Tokens,
  costUsd: z.number(),
  // 全部请求的模型都在价格表中；false 时页面不显示花费（25.5）
  priced: z.boolean(),
  // dashboard 记录的 workflow 配置（25.4）：variant 配置下与 run 的 session 为它所属 variant 的 workflow；本机配置与设计与优化下为空
  workflows: z.array(z.string()),
  runId: z.string().nullable(),
  // 交互产生或被交互 resume 的 session（Contracts 14.1），列表中标为"交互"
  liveId: z.string().nullable(),
  // 所属的交互项已关闭（Contracts 14.5）：导入选择框中这类 session 可选，选了即恢复显示
  liveHidden: z.boolean(),
  // 绑定的 variant 与方式（Contracts 15.1）；deleted：已删除（Contracts 24.3），名字后有"（已删除）"，不能点进 variant 页面
  variant: z.object({ id: z.string(), name: z.string(), deleted: z.boolean() }).nullable(),
  variantBinding: z.enum(variantBindings).nullable(),
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
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
  hasLfg: sessions.hasLfg,
  hasIc: sessions.hasIc,
  runId: sessions.runId,
  liveId: sessions.liveId,
  variantId: sessions.variantId,
  variantBinding: sessions.variantBinding,
  engine: sessions.engine,
  filePath: sessions.filePath,
  archivedAt: sessions.archivedAt,
};

interface SummaryRow {
  id: string;
  cwd: string | null;
  title: string | null;
  startedAt: Date;
  endedAt: Date;
  hasLfg: boolean;
  hasIc: boolean;
  runId: string | null;
  liveId: string | null;
  variantId: string | null;
  variantBinding: VariantBinding | null;
  engine: SessionEngine;
  filePath: string;
  archivedAt: Date | null;
}

function summaries(db: Db, dirs: SourceDirs, rows: SummaryRow[]): SessionSummary[] {
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
  const titles = sessionTitles(db, ids);
  // 属于交互区某一项的 session 带这一项是否已关闭
  const liveIds = rows.flatMap((r) => (r.liveId === null ? [] : [r.liveId]));
  const liveItems = new Map(
    liveIds.length === 0
      ? []
      : db
          .select({ id: liveSessions.id, hiddenAt: liveSessions.hiddenAt })
          .from(liveSessions)
          .where(inArray(liveSessions.id, liveIds))
          .all()
          .map((l) => [l.id, l]),
  );
  const variantNames = boundVariantNames(
    db,
    rows.flatMap((r) => (r.variantId === null ? [] : [r.variantId])),
  );
  // 每个 session 用过的模型：全部在价格表中才显示花费（Contracts 25.5）
  const models = new Map<string, string[]>();
  for (const m of db
    .selectDistinct({ sessionId: requests.sessionId, model: requests.model })
    .from(requests)
    .where(inArray(requests.sessionId, ids))
    .all()) {
    models.set(m.sessionId, [...(models.get(m.sessionId) ?? []), m.model]);
  }
  // 配置与 workflow 列（Contracts 25.1、25.4）：variant 配置目录中的 session 归入 ownerOf 给出的 variant（共用目录的
  // 迁移拆出的 lfg、ic 取其中绑定的那个，否则最早建的），取它的 workflow；不在任何配置中的（run 与交互的旧记录）取绑定的
  // variant 的 workflow
  const owners = new Map<string, ReturnType<typeof configOwners>>();
  const placeOf = (
    r: SummaryRow,
    c: SessionConfig | null,
  ): { config: string | null; workflow: string | undefined } => {
    if (c?.id === 'local' || c?.id === 'design') return { config: c.id, workflow: undefined };
    if (c?.id === 'variant') {
      const found = owners.get(c.storageId) ?? configOwners(db, c.storageId);
      owners.set(c.storageId, found);
      const owner = ownerOf(found, r.variantId);
      if (owner !== undefined) return { config: `variant:${owner.id}`, workflow: owner.workflowId };
    }
    return {
      config: null,
      workflow: r.variantId === null ? undefined : workflowOf.get(r.variantId),
    };
  };
  const workflowOf = new Map(
    db
      .select({ id: variantsTable.id, workflowId: variantsTable.workflowId })
      .from(variantsTable)
      .all()
      .map((v) => [v.id, v.workflowId]),
  );
  return rows.map((r) => {
    const t = totals.get(r.id);
    const variantName = r.variantId === null ? undefined : variantNames.get(r.variantId);
    if (r.variantId !== null && variantName === undefined) {
      throw new Error(`session ${r.id} 绑定的 variant ${r.variantId} 不存在`);
    }
    const item = r.liveId === null ? undefined : liveItems.get(r.liveId);
    const c = sessionConfigOf(dirs, r.engine, r.filePath);
    const { config: configId, workflow } = placeOf(r, c);
    return {
      id: r.id,
      engine: r.engine,
      config: configId,
      purpose: c?.id === 'design' ? c.purpose : null,
      archivedAt: r.archivedAt === null ? null : r.archivedAt.toISOString(),
      cwd: r.cwd,
      title: titles.get(r.id) ?? null,
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
      priced: (models.get(r.id) ?? []).every(hasPrice),
      workflows: workflow === undefined ? [] : [workflow],
      runId: r.runId,
      liveId: r.liveId,
      liveHidden: item !== undefined && item.hiddenAt !== null,
      variant:
        r.variantId === null || variantName === undefined
          ? null
          : { id: r.variantId, ...variantName },
      variantBinding: r.variantBinding,
    };
  });
}

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

  // 上面的三列（Contracts 25.1、25.5）：列出磁盘上的配置、项目与 session，只读元数据
  app.get(
    '/session-import/configs',
    {
      schema: {
        querystring: z.object({ engine: Engine }),
        response: {
          200: z.object({
            configs: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                workflow: z.object({ id: z.string(), name: z.string() }).nullable(),
                sessionCount: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    (request) => ({ configs: importConfigs(db, dirs, request.query.engine) }),
  );

  app.get(
    '/session-import/projects',
    {
      schema: {
        querystring: z.object({ engine: Engine, config: z.string().min(1), ...ColumnPage }),
        response: {
          200: z.object({
            projects: z.array(
              z.object({
                cwd: z.string(),
                name: z.string(),
                sessionCount: z.number().int(),
                importedCount: z.number().int(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
        },
      },
    },
    (request) => {
      const { engine, config: configId, q, page, pageSize } = request.query;
      const found = importProjects(db, dirs, engine, {
        config: configId,
        q: q.trim(),
        page,
        pageSize,
      });
      return { projects: found.items, total: found.total, page, pageSize };
    },
  );

  app.get(
    '/session-import/sessions',
    {
      schema: {
        querystring: z.object({
          engine: Engine,
          config: z.string().min(1),
          cwd: z.string().min(1),
          ...ColumnPage,
        }),
        response: {
          200: z.object({
            sessions: z.array(
              z.object({
                id: z.string(),
                file: z.string(),
                title: z.string().nullable(),
                startedAt: z.iso.datetime(),
                size: z.number().int(),
                imported: z.boolean(),
                liveId: z.string().nullable(),
                liveHidden: z.boolean(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
        },
      },
    },
    (request) => {
      const { engine, config: configId, cwd, q, page, pageSize } = request.query;
      const found = diskSessions(db, dirs, engine, {
        config: configId,
        cwd,
        q: q.trim(),
        page,
        pageSize,
      });
      // dashboard 中有记录的（含清除了的）取 dashboard 中的标题与所属的交互项；在管理表格中的才算已导入
      const ids = found.items.map((s) => s.id);
      const rows = db
        .select(summaryColumns)
        .from(sessions)
        .where(and(eq(sessions.engine, engine), inArray(sessions.id, ids)))
        .all();
      const recorded = new Map(summaries(db, dirs, rows).map((s) => [s.id, s]));
      const managedIds = importedIds(db, engine, ids);
      return {
        sessions: found.items.map((s) => {
          const known = recorded.get(s.id);
          return {
            id: s.id,
            file: s.file,
            title: known?.title ?? s.title,
            startedAt: s.startedAt.toISOString(),
            size: s.size,
            imported: managedIds.has(s.id),
            liveId: known?.liveId ?? null,
            liveHidden: known?.liveHidden ?? false,
          };
        }),
        total: found.total,
        page,
        pageSize,
      };
    },
  );

  // "导入 N 个"（Contracts 25.1、25.5）
  app.post(
    '/session-import',
    {
      schema: {
        body: z.strictObject({
          engine: Engine,
          files: z.array(z.string().min(1)).min(1),
        }),
        response: {
          200: z.object({
            sessions: z.array(z.object({ id: z.string(), file: z.string() })),
            durationMs: z.number().int(),
          }),
        },
      },
    },
    async (request) => {
      const started = performance.now();
      const { engine, files } = request.body;
      const entries = importableFiles(db, dirs, engine, files).map((e) => ({
        id: e.id,
        file: e.file,
      }));
      await importFiles(db, engine, entries);
      return { sessions: entries, durationMs: Math.round(performance.now() - started) };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        querystring: z.object({
          source: z.string().optional(),
          // Contracts 25.5：引擎（默认 claude）、配置、项目（cwd）、已归档的
          engine: z.enum(sessionEngines).default('claude'),
          config: z.string().min(1).optional(),
          archived: z.enum(['true', 'false']).default('false'),
          q: z.string().min(1).optional(),
          workflow: z.enum(workflows).optional(),
          // limit 与 pageSize 默认 50；可选是为了判定 idsOnly 时有没有传
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
          // 分页（Contracts 25.5）：page 从 1 开始，每页 pageSize 个；与 cursor 不同时使用
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(500).optional(),
          // 只返回范围与搜索内全部的 id（表格的"选择全部 N 个"），与分页参数不同时使用
          idsOnly: z.enum(['true', 'false']).default('false'),
        }),
        response: {
          200: z.union([
            z.object({
              sessions: z.array(SessionSummary),
              nextCursor: z.string().nullable(),
              // 范围与搜索内的 session 总数
              total: z.number().int(),
            }),
            z.object({ ids: z.array(z.string()), total: z.number().int() }),
          ]),
          400: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const {
        engine,
        config: configId,
        archived,
        q,
        workflow,
        cursor,
        page: pageNumber,
        idsOnly,
      } = request.query;
      const limit = request.query.limit ?? 50;
      const pageSize = request.query.pageSize ?? 50;
      if (cursor !== undefined && pageNumber !== undefined)
        return reply.code(400).send({ error: 'cursor 与 page 不能同时使用' });
      if (
        idsOnly === 'true' &&
        [cursor, pageNumber, request.query.limit, request.query.pageSize].some(
          (v) => v !== undefined,
        )
      )
        return reply.code(400).send({ error: 'idsOnly 与分页参数不能同时使用' });
      // 列出的是管理表格中的 session：已导入、没有清除（Contracts 25.1）
      const conditions: (SQL | undefined)[] = [eq(sessions.engine, engine), managed];
      conditions.push(
        archived === 'true' ? isNotNull(sessions.archivedAt) : isNull(sessions.archivedAt),
      );
      if (configId !== undefined) conditions.push(configCondition(db, dirs, engine, configId));
      if (q !== undefined) {
        // q 按字面匹配：% 与 _ 不是通配符
        const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const contains = (column: SQLiteColumn) => sql`${column} like ${pattern} escape '\\'`;
        conditions.push(
          or(contains(sessions.title), contains(sessions.cwd), contains(sessions.id)),
        );
      }
      if (workflow === 'lfg') conditions.push(eq(sessions.hasLfg, true));
      if (workflow === 'ic') conditions.push(eq(sessions.hasIc, true));
      if (idsOnly === 'true') {
        const ids = db
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(...conditions))
          .orderBy(desc(sessions.startedAt), desc(sessions.id))
          .all()
          .map((r) => r.id);
        return { ids, total: ids.length };
      }
      const total =
        db
          .select({ n: count() })
          .from(sessions)
          .where(and(...conditions))
          .get()?.n ?? 0;
      if (pageNumber !== undefined) {
        const rows = db
          .select(summaryColumns)
          .from(sessions)
          .where(and(...conditions))
          .orderBy(desc(sessions.startedAt), desc(sessions.id))
          .limit(pageSize)
          .offset((pageNumber - 1) * pageSize)
          .all();
        return { sessions: summaries(db, dirs, rows), nextCursor: null, total };
      }
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
        .where(and(...conditions))
        .orderBy(desc(sessions.startedAt), desc(sessions.id))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        sessions: summaries(db, dirs, page),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ startedAt: last.startedAt.getTime(), id: last.id })
            : null,
        total,
      };
    },
  );

  // "绑定的对象"（Contracts 18.2）
  app.get(
    '/sessions/:id/bindings',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: SessionLinks, 404: ErrorBody },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const row = db
        .select({ id: sessions.id, runId: sessions.runId, liveId: sessions.liveId })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      if (row === undefined) return reply.code(404).send({ error: `session ${id} 不存在` });
      return sessionLinks(db, row, { dir: config.vaultDir, product: config.evalProduct });
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
      const row = db.select(summaryColumns).from(sessions).where(eq(sessions.id, id)).get();
      if (row === undefined) return reply.code(404).send({ error: `session ${id} 不存在` });
      const [summary] = summaries(db, dirs, [row]);
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
      // 区间端点必须是存在的请求：不存在时去掉这一侧的界限会返回范围之外的用户消息
      if (fromSeq !== undefined && fromSeq > 0 && lower === undefined) {
        return reply.code(404).send({ error: `session ${id} 中没有请求 #${String(fromSeq - 1)}` });
      }
      if (toSeq !== undefined && upper === undefined) {
        return reply.code(404).send({ error: `session ${id} 中没有请求 #${String(toSeq)}` });
      }
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
            text: message.kind === 'user' ? displayUserText(message.text) : message.text,
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

  // Contracts 第 11 节
  app.get(
    '/sessions/:id/conversation',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ items: z.array(ConversationItem) }), 404: ErrorBody },
      },
    },
    async (request, reply) => {
      const items = sessionConversation(db, request.params.id);
      if (items === null)
        return reply.code(404).send({ error: `session ${request.params.id} 不存在` });
      return { items };
    },
  );

  done();
};
