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
  // Session of the local machine configuration (Contracts 25.4)
  local: z.boolean(),
  engine: z.enum(sessionEngines),
  // Configuration it is in (Contracts 27); null when in none
  config: Config.nullable(),
  // Project: the name of the working directory
  project: z.string().nullable(),
  // Already in the dashboard; when false it is read in when the analysis starts, without entering the management table
  inDashboard: z.boolean(),
});

const Scope = z.object({
  sessions: z.array(ScopeSession),
  // One engine and one configuration (Contracts 25.4, 27); null otherwise
  engine: z.enum(sessionEngines).nullable(),
  config: Config.nullable(),
  variant: Named.nullable(),
  // All sessions are of the local machine configuration: the analysis has no variant
  local: z.boolean(),
  problem: z.string().nullable(),
});

// Sessions picked from disk in a new analysis (Contracts 27): files listed under one configuration of this engine
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

// key is a stage of the chosen session-analysis variant (Contracts 19.2)
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
  // Analyses of local machine configuration sessions have no variant; the page shows "local machine" (Contracts 25.4)
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  // The session-analysis variant that drives the analysis; null for analyses before W45
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

// output/report.json (Contracts 19.2)
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
  // The analysed or driving variant was deleted (Contracts 24.3): show the name, no link to the variant page
  variantDeleted: z.boolean(),
  analysisVariantDeleted: z.boolean(),
  sessions: z.array(ScopeSession),
  report: Report.nullable(),
  // Drafts handed to Codex for optimization and their Live items (Contracts 19.3)
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
// ?sessions=a,b or ?batch=<id>
const ScopeQuery = z.object({
  sessions: z
    .string()
    .min(1)
    .transform((s) => s.split(','))
    .optional(),
  batch: z.string().min(1).optional(),
});

// Contracts 15.2, 15.3
export const analysisRoutes: FastifyPluginCallbackZod<{ insights: Insights }> = (
  app,
  { insights },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Default model and default session-analysis variant (the baseline), plus the selectable variants (built from current content)
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
  // Same scope with ids in the body: selecting all in the Sessions table can exceed the header limit (Contracts 25.5);
  // disk is the files picked from disk in a new analysis (Contracts 27)
  app.post(
    '/api/analyses/scope',
    {
      schema: {
        body: z
          .strictObject({ ids: z.array(z.string().min(1)).optional(), disk: Disk.optional() })
          .refine((b) => (b.ids?.length ?? 0) > 0 || b.disk !== undefined, {
            message: 'Give at least one of ids and disk',
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
            // Picked from disk in a new analysis (Contracts 27): read in first if not in the dashboard, not entering the management table
            disk: Disk.optional(),
            engine: z.enum(analysisEngines),
            model: z.string().trim().min(1).optional(),
            // Which session-analysis variant analyses it (Contracts 19.2), the baseline by default
            analysisVariantId: z.string().min(1).optional(),
          })
          .refine(
            (b) =>
              b.batchId === undefined
                ? b.sessionIds !== undefined || b.disk !== undefined
                : b.sessionIds === undefined && b.disk === undefined,
            { message: 'Give exactly one of batchId and sessionIds/disk' },
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
        // Name and description are required (Contracts 19.3), validated by the server, 400 with the message
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
