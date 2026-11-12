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
  sshHosts,
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
import { importProblemOf } from '../ingest/import-problems.js';
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
import { createHosts } from '../remote/hosts.js';
import {
  importRemote,
  parseRemoteFile,
  type RemoteDiskSession,
  remoteConfigs,
  remoteProjects,
  remoteSessions,
  SSH_CONFIG,
} from '../remote/import.js';

const ErrorBody = z.object({ error: z.string() });

const Engine = z.enum(sessionEngines).default('claude');
// Pagination of the second and third columns (Contracts 25.5)
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
  // Contracts 25.2, 25.5
  engine: z.enum(sessionEngines),
  // The configuration it belongs to (25.1, 33.3): local, variant:<id>; empty when in none of these directories
  config: z.string().nullable(),
  // Purpose of a design or optimize session's session (25.4), the Live purpose label
  purpose: z.enum(['design', 'optimize']).nullable(),
  archivedAt: z.iso.datetime().nullable(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  // The statistics below include subagent requests
  requestCount: z.number().int(),
  tokens: Tokens,
  costUsd: z.number(),
  // Every request's model is in the price table; when false the page shows no cost (25.5)
  priced: z.boolean(),
  // The workflow recorded by the dashboard (25.4): under a variant configuration, and for design, optimize and run
  // sessions, the workflow of the variant it belongs to; empty under the local configuration
  workflows: z.array(z.string()),
  runId: z.string().nullable(),
  // A session created or resumed by Live (Contracts 14.1), marked "Live" in the list
  liveId: z.string().nullable(),
  // Its Live item is closed (Contracts 14.5): such sessions can be picked in the import dialog, which shows the item
  // again
  liveHidden: z.boolean(),
  // The bound variant and how (Contracts 15.1); deleted: deleted (Contracts 24.3), shown with "(deleted)" after the
  // name and not linking to the variant page
  variant: z.object({ id: z.string(), name: z.string(), deleted: z.boolean() }).nullable(),
  variantBinding: z.enum(variantBindings).nullable(),
  // A session from an SSH host (Contracts 31.6): the host and the remote original file; empty for local ones
  host: z
    .object({ id: z.string(), label: z.string().nullable(), remotePath: z.string().nullable() })
    .nullable(),
  // Incremental import problem (Requirements Log round 13, item 19): failed carries the error (retried at the next
  // incremental import), waiting means a referenced spill file has not appeared yet; empty with no problem
  importProblem: z
    .object({ kind: z.enum(['failed', 'waiting']), message: z.string(), at: z.iso.datetime() })
    .nullable(),
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

// User messages, or system events Claude Code generates (background task notifications, local command output)
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
  remotePath: sessions.remotePath,
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
  remotePath: string | null;
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
  // A session that belongs to a Live item carries whether that item is closed
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
  // Models each session used: cost is shown only when all are in the price table (Contracts 25.5)
  const models = new Map<string, string[]>();
  for (const m of db
    .selectDistinct({ sessionId: requests.sessionId, model: requests.model })
    .from(requests)
    .where(inArray(requests.sessionId, ids))
    .all()) {
    models.set(m.sessionId, [...(models.get(m.sessionId) ?? []), m.model]);
  }
  // Configuration and workflow columns (Contracts 25.1, 25.4): a session in a variant configuration directory goes to
  // the variant ownerOf gives (for directories shared by the migrated lfg and ic, the bound one, else the earliest) and
  // takes its workflow; sessions in no configuration (old run and Live records) take the bound variant's workflow
  const owners = new Map<string, ReturnType<typeof configOwners>>();
  const placeOf = (
    r: SummaryRow,
    c: SessionConfig | null,
  ): { config: string | null; workflow: string | undefined } => {
    if (c?.id === 'local') return { config: c.id, workflow: undefined };
    // A design or optimize session's session belongs to the workflow-design or workflow-optimize variant it is bound
    // to (Contracts 33.3)
    if (c?.id === 'design') {
      return {
        config: r.variantId === null ? null : `variant:${r.variantId}`,
        workflow: r.variantId === null ? undefined : workflowOf.get(r.variantId),
      };
    }
    if (c?.id === 'ssh') {
      return {
        config: `ssh:${c.hostId}`,
        workflow: r.variantId === null ? undefined : workflowOf.get(r.variantId),
      };
    }
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
  // Sessions from an SSH host show the host (Contracts 31.6); label is empty when the host was deleted
  const hostLabels = new Map(
    db
      .select({ id: sshHosts.id, label: sshHosts.label })
      .from(sshHosts)
      .all()
      .map((h) => [h.id, h.label]),
  );
  return rows.map((r) => {
    const t = totals.get(r.id);
    const variantName = r.variantId === null ? undefined : variantNames.get(r.variantId);
    if (r.variantId !== null && variantName === undefined) {
      throw new Error(`Variant ${r.variantId} bound to session ${r.id} does not exist`);
    }
    const item = r.liveId === null ? undefined : liveItems.get(r.liveId);
    const c = sessionConfigOf(dirs, r.engine, r.filePath);
    const { config: configId, workflow } = placeOf(r, c);
    const problem = importProblemOf(r.id);
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
      host:
        c?.id === 'ssh'
          ? { id: c.hostId, label: hostLabels.get(c.hostId) ?? null, remotePath: r.remotePath }
          : null,
      importProblem: problem === null ? null : { ...problem, at: problem.at.toISOString() },
    };
  });
}

export interface SessionsRoutesOptions {
  db: Db;
  dirs: SourceDirs;
}

// Search, sort and pagination of the third column (as diskSessions)
function pageRemote(all: RemoteDiskSession[], q: string, page: number, pageSize: number) {
  const needle = q.toLowerCase();
  const matched = all
    .filter(
      (s) => (s.title ?? '').toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id));
  return { items: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length };
}

export const sessionsRoutes: FastifyPluginCallbackZod<SessionsRoutesOptions> = (
  app,
  { db, dirs },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // SSH host configurations (Contracts 31.6): one entry per host in the first column; the project and session columns
  // are read over ssh
  const hosts = createHosts({ db, sshHostsFile: config.sshHostsFile });
  const importedOf = (engine: SessionEngine) => (ids: string[]) => importedIds(db, engine, ids);

  // The three columns above (Contracts 25.1, 25.5): configurations, projects and sessions on disk, metadata only
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
                // SSH host configurations: the error when unreachable (greyed out); empty otherwise
                hostId: z.string().nullable(),
                error: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const local = importConfigs(db, dirs, request.query.engine).map((c) => ({
        ...c,
        hostId: null,
        error: null,
      }));
      const remote = (await remoteConfigs(db, hosts, request.query.engine)).map((c) => ({
        id: c.id,
        label: c.label,
        workflow: null,
        sessionCount: c.sessionCount,
        hostId: c.hostId,
        error: c.error,
      }));
      // The local configuration first, then each host, then variants and design and optimize (Contracts 31.6)
      const [first, ...rest] = local;
      return { configs: first === undefined ? remote : [first, ...remote, ...rest] };
    },
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
    async (request) => {
      const { engine, config: configId, q, page, pageSize } = request.query;
      if (SSH_CONFIG.test(configId)) {
        const needle = q.trim().toLowerCase();
        const all = (await remoteProjects(hosts, engine, configId, importedOf(engine)))
          .filter(
            (p) => p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle),
          )
          .sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
        return {
          projects: all.slice((page - 1) * pageSize, page * pageSize),
          total: all.length,
          page,
          pageSize,
        };
      }
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
    async (request) => {
      const { engine, config: configId, cwd, q, page, pageSize } = request.query;
      const found = SSH_CONFIG.test(configId)
        ? pageRemote(await remoteSessions(hosts, engine, configId, cwd), q.trim(), page, pageSize)
        : diskSessions(db, dirs, engine, {
            config: configId,
            cwd,
            q: q.trim(),
            page,
            pageSize,
          });
      // Sessions recorded in the dashboard (cleared ones included) take the dashboard's title and Live item; only those
      // in the management table count as imported
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

  // "Import N" (Contracts 25.1, 25.5)
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
      // Sessions on an SSH host (ssh:<hostId>:<remote path>) are copied to this machine first (Contracts 31.6)
      const remote = files.filter((f) => parseRemoteFile(f) !== null);
      const local = files.filter((f) => parseRemoteFile(f) === null);
      const entries =
        local.length === 0
          ? []
          : importableFiles(db, dirs, engine, local).map((e) => ({ id: e.id, file: e.file }));
      await importFiles(db, engine, entries);
      const copied = await importRemote(db, hosts, dirs.remoteDir, engine, remote);
      return {
        sessions: [...entries, ...copied],
        durationMs: Math.round(performance.now() - started),
      };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        querystring: z.object({
          source: z.string().optional(),
          // Contracts 25.5: engine (claude by default), configuration, project (cwd), archived
          engine: z.enum(sessionEngines).default('claude'),
          config: z.string().min(1).optional(),
          archived: z.enum(['true', 'false']).default('false'),
          q: z.string().min(1).optional(),
          workflow: z.enum(workflows).optional(),
          // limit and pageSize default to 50; optional so idsOnly can tell whether they were passed
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
          // Pagination (Contracts 25.5): page starts at 1 with pageSize per page; not together with cursor
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(500).optional(),
          // Return only all ids within the scope and search (the table's "Select all N"); not together with pagination
          idsOnly: z.enum(['true', 'false']).default('false'),
        }),
        response: {
          200: z.union([
            z.object({
              sessions: z.array(SessionSummary),
              nextCursor: z.string().nullable(),
              // Total sessions within the scope and search
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
        return reply.code(400).send({ error: 'cursor and page cannot be used together' });
      if (
        idsOnly === 'true' &&
        [cursor, pageNumber, request.query.limit, request.query.pageSize].some(
          (v) => v !== undefined,
        )
      )
        return reply.code(400).send({ error: 'idsOnly cannot be used with pagination parameters' });
      // Sessions in the management table are listed: imported and not cleared (Contracts 25.1)
      const conditions: (SQL | undefined)[] = [eq(sessions.engine, engine), managed];
      conditions.push(
        archived === 'true' ? isNotNull(sessions.archivedAt) : isNull(sessions.archivedAt),
      );
      if (configId !== undefined) conditions.push(configCondition(db, dirs, engine, configId));
      if (q !== undefined) {
        // q matches literally: % and _ are not wildcards
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

  // "Bound objects" (Contracts 18.2)
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
      if (row === undefined) return reply.code(404).send({ error: `Session not found: ${id}` });
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
      if (row === undefined) return reply.code(404).send({ error: `Session not found: ${id}` });
      const [summary] = summaries(db, dirs, [row]);
      if (summary === undefined) throw new Error(`Session ${id} has an empty summary`);
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
      if (session === undefined) return reply.code(404).send({ error: `Session not found: ${id}` });
      if (agent !== undefined) {
        const sub = db
          .select({ agentId: subagents.agentId })
          .from(subagents)
          .where(and(eq(subagents.sessionId, id), eq(subagents.agentId, agent)))
          .get();
        if (sub === undefined)
          return reply.code(404).send({ error: `Session ${id} has no subagent ${agent}` });
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

      // User messages in (time of fromSeq-1, time of toSeq]: the message that triggered fromSeq is included, messages
      // after toSeq belong to the next segment
      const messageConditions = [eq(userMessages.sessionId, id), ofAgent(userMessages.agentId)];
      const lower = fromSeq === undefined || fromSeq === 0 ? undefined : seqAt(fromSeq - 1);
      const upper = toSeq === undefined ? undefined : seqAt(toSeq);
      // The interval ends must be existing requests: dropping a missing side's bound would return user messages
      // outside the range
      if (fromSeq !== undefined && fromSeq > 0 && lower === undefined) {
        return reply
          .code(404)
          .send({ error: `Session ${id} has no request #${String(fromSeq - 1)}` });
      }
      if (toSeq !== undefined && upper === undefined) {
        return reply.code(404).send({ error: `Session ${id} has no request #${String(toSeq)}` });
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

      // Merged by time; at the same time, user messages and system events come before requests
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

  // Contracts section 11
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
        return reply.code(404).send({ error: `Session not found: ${request.params.id}` });
      return { items };
    },
  );

  done();
};
