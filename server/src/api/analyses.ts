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
  variantBindings,
} from '../db/schema.js';
import type { Insights } from '../insights/index.js';

const Named = z.object({ id: z.string(), name: z.string() });

const ScopeSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startedAt: z.string(),
  runId: z.string().nullable(),
  variant: Named.nullable(),
  binding: z.enum(variantBindings).nullable(),
});

const Scope = z.object({
  sessions: z.array(ScopeSession),
  variant: Named.nullable(),
  problem: z.string().nullable(),
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
  variantId: z.string(),
  variantName: z.string(),
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
            engine: z.enum(analysisEngines),
            model: z.string().trim().min(1).optional(),
            // 用哪个 session-analysis variant 分析（Contracts 19.2），默认基线
            analysisVariantId: z.string().min(1).optional(),
          })
          .refine((b) => (b.sessionIds === undefined) !== (b.batchId === undefined), {
            message: 'sessionIds 与 batchId 必须恰好给出一个',
          }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (request, reply) => {
      const created = insights.create(request.body);
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
