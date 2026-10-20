import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  analysisEngines,
  analysisOutcomes,
  analysisStatuses,
  findingSeverities,
  sessionEngines,
  variantBindings,
} from '../db/schema.js';
import type { Insights } from '../insights/index.js';

const Named = z.object({ id: z.string(), name: z.string() });

const Config = z.object({ id: z.string(), label: z.string() });

const ScopeSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startedAt: z.string(),
  runId: z.string().nullable(),
  variant: Named.nullable(),
  binding: z.enum(variantBindings).nullable(),
  // 本机配置的 session（Contracts 25.4）
  local: z.boolean(),
  engine: z.enum(sessionEngines),
  // 所在的配置（Contracts 27）；不在任何配置中时为空
  config: Config.nullable(),
  // 项目：工作目录的目录名
  project: z.string().nullable(),
  // 已在 dashboard 中；为 false 时开始分析时读入，不进入管理表格
  inDashboard: z.boolean(),
});

const Scope = z.object({
  sessions: z.array(ScopeSession),
  // 同一种引擎、同一个配置（Contracts 25.4、27）；不是时为空
  engine: z.enum(sessionEngines).nullable(),
  config: Config.nullable(),
  variant: Named.nullable(),
  // 全部是本机配置的 session：分析没有 variant
  local: z.boolean(),
  problem: z.string().nullable(),
});

// 新建分析中从磁盘选的 session（Contracts 27）：这个引擎某个配置下列出的文件
const Disk = z.strictObject({
  engine: z.enum(sessionEngines),
  files: z.array(z.string().min(1)).min(1),
});

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
});

// key 是所选 session-analysis variant 的小阶段（Contracts 19.2）
const Step = z.object({
  key: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  tokens: Tokens,
  costUsd: z.number().nullable(),
  events: z.number(),
  error: z.string().nullable(),
});

const Summary = z.object({
  id: z.string(),
  engine: z.enum(analysisEngines),
  model: z.string(),
  // 本机配置的 session 的分析没有 variant，页面显示"本机配置"（Contracts 25.4）
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  // 驱动分析的 session-analysis variant；W45 之前的分析为空
  analysisVariantId: z.string().nullable(),
  analysisVariantName: z.string().nullable(),
  sessionIds: z.array(z.string()),
  status: z.enum(analysisStatuses),
  error: z.string().nullable(),
  steps: z.array(Step),
  costUsd: z.number().nullable(),
  createdAt: z.date(),
  endedAt: z.date().nullable(),
});

const Finding = z.object({
  findingId: z.string(),
  aspect: z.string(),
  title: z.string(),
  stage: z.string().nullable(),
  skill: z.string().nullable(),
  severity: z.enum(findingSeverities),
  detail: z.string(),
  evidence: z.array(z.object({ sessionId: z.string(), seq: z.number(), quote: z.string() })),
});

const Ids = z.array(z.string());

// output/report.json（Contracts 19.2）
const Report = z.object({
  summary: z.string(),
  goal: z.string(),
  outcome: z.enum(analysisOutcomes),
  topIssues: z.array(z.object({ title: z.string(), findingIds: Ids, impact: z.string() })),
  workflowChanges: z.array(
    z.object({ findingIds: Ids, rationale: z.string(), change: z.string() }),
  ),
});

const Detail = Summary.extend({
  // 被分析的与驱动分析的 variant 已删除（Contracts 24.3）：显示名字，不能点进 variant 页面
  variantDeleted: z.boolean(),
  analysisVariantDeleted: z.boolean(),
  sessions: z.array(ScopeSession),
  report: Report.nullable(),
  // 交给 Codex 优化的草稿与它在 Live 中的项（Contracts 19.3）
  optimizeDrafts: z.array(z.object({ id: z.string(), liveId: z.string().nullable() })),
  findings: z.array(Finding),
  patches: z.array(
    z.object({
      file: z.string(),
      findingIds: z.array(z.string()),
      rationale: z.string(),
      patch: z.string(),
    }),
  ),
  files: z.array(
    z.object({
      path: z.string(),
      original: z.string(),
      proposed: z.string(),
      hunks: z.array(
        z.object({
          index: z.number(),
          start: z.number(),
          remove: z.array(z.string()),
          insert: z.array(z.string()),
          findingIds: z.array(z.string()),
        }),
      ),
    }),
  ),
});

const Params = z.object({ id: z.string() });
// ?sessions=a,b 或 ?batch=<id>
const ScopeQuery = z.object({
  sessions: z
    .string()
    .min(1)
    .transform((s) => s.split(','))
    .optional(),
  batch: z.string().min(1).optional(),
});

// Contracts 15.2、15.3
export const analysisRoutes: FastifyPluginCallbackZod<{ insights: Insights }> = (
  app,
  { insights },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 默认模型与默认的 session-analysis variant（基线），以及可选的 variant（按当前内容构建通过的）
  app.get(
    '/api/analyses/options',
    {
      schema: {
        response: {
          200: z.object({
            defaults: z.object({
              claude: z.string(),
              codex: z.string(),
              analysisVariantId: z.string().nullable(),
            }),
            analysisVariants: z.array(Named),
          }),
        },
      },
    },
    () => ({
      defaults: insights.defaults(),
      analysisVariants: insights.analysisVariants().map((v) => ({ id: v.id, name: v.name })),
    }),
  );

  app.get(
    '/api/analyses/scope',
    { schema: { querystring: ScopeQuery, response: { 200: Scope } } },
    (request) =>
      insights.scope({ sessionIds: request.query.sessions, batchId: request.query.batch }),
  );
  // 同样的范围，ids 放在请求体中：Sessions 表格选中全部时 id 很多，查询字符串会超过请求头的上限（Contracts 25.5）；
  // disk 为新建分析中从磁盘选的文件（Contracts 27）
  app.post(
    '/api/analyses/scope',
    {
      schema: {
        body: z
          .strictObject({ ids: z.array(z.string().min(1)).optional(), disk: Disk.optional() })
          .refine((b) => (b.ids?.length ?? 0) > 0 || b.disk !== undefined, {
            message: 'ids 与 disk 至少给出一个',
          }),
        response: { 200: Scope },
      },
    },
    (request) => insights.scope({ sessionIds: request.body.ids, disk: request.body.disk }),
  );

  app.get('/api/analyses', { schema: { response: { 200: z.array(Summary) } } }, () =>
    insights.list(),
  );

  app.post(
    '/api/analyses',
    {
      schema: {
        body: z
          .object({
            sessionIds: z.array(z.string().min(1)).min(1).optional(),
            batchId: z.string().min(1).optional(),
            // 新建分析中从磁盘选的（Contracts 27）：还不在 dashboard 中的先读入，不进入管理表格
            disk: Disk.optional(),
            engine: z.enum(analysisEngines),
            model: z.string().trim().min(1).optional(),
            // 用哪个 session-analysis variant 分析（Contracts 19.2），默认基线
            analysisVariantId: z.string().min(1).optional(),
          })
          .refine(
            (b) =>
              b.batchId === undefined
                ? b.sessionIds !== undefined || b.disk !== undefined
                : b.sessionIds === undefined && b.disk === undefined,
            { message: 'batchId 与 sessionIds、disk 必须恰好给出一种' },
          ),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (request, reply) => {
      const created = await insights.create(request.body);
      return reply.code(201).send({ id: created.id });
    },
  );

  app.get(
    '/api/analyses/:id',
    { schema: { params: Params, response: { 200: Detail } } },
    (request) => insights.detail(request.params.id),
  );

  app.post(
    '/api/analyses/:id/cancel',
    { schema: { params: Params, response: { 200: z.object({ id: z.string() }) } } },
    (request) => ({ id: insights.cancel(request.params.id).id }),
  );

  app.post(
    '/api/analyses/:id/variant',
    {
      schema: {
        params: Params,
        // 名字与描述必填（Contracts 19.3），由服务端校验，以原文 400
        body: z.object({
          name: z.string(),
          description: z.string(),
          files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
        }),
        response: { 201: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    async (request, reply) => {
      const created = insights.saveVariant(request.params.id, request.body);
      return reply.code(201).send({ id: created.id, name: created.name });
    },
  );

  done();
};
