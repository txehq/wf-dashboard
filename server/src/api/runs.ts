import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { runStatuses } from '../db/schema.js';
import type { Runs } from '../runs/index.js';
import type { SettingsStore } from '../runs/settings.js';
import { BatchDetail, BatchSummary, RunDetail, RunSummary } from '../runs/views.js';
import { efforts, modelAliases } from '../variants/models.js';

const IdParams = z.object({ id: z.string().min(1) });
const Ok = z.object({ ok: z.literal(true) });

// Contracts 7.6
export const runRoutes: FastifyPluginCallbackZod<{ runs: Runs; settings: SettingsStore }> = (
  app,
  { runs, settings },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.post(
    '/api/batches',
    {
      schema: {
        body: z.strictObject({
          variantIds: z.array(z.string().min(1)).min(1),
          taskIds: z.array(z.string().min(1)).min(1),
          repeats: z.int().min(1).max(50).optional(),
          // Applies to every run in the batch; defaults to the agentModel and agentEffort settings (Contracts 16.5)
          model: z.enum(modelAliases).optional(),
          effort: z.enum(efforts).optional(),
        }),
        response: { 201: BatchDetail },
      },
    },
    (request, reply) => {
      const { variantIds, taskIds, repeats, model, effort } = request.body;
      void reply.code(201);
      return runs.createBatch({
        variantIds: [...new Set(variantIds)],
        taskIds: [...new Set(taskIds)],
        repeats: repeats ?? settings.get().defaultRepeats,
        model: model ?? settings.get().agentModel,
        effort: effort ?? settings.get().agentEffort,
      });
    },
  );

  app.get('/api/batches', { schema: { response: { 200: z.array(BatchSummary) } } }, () =>
    runs.listBatches(),
  );

  app.get(
    '/api/batches/:id',
    { schema: { params: IdParams, response: { 200: BatchDetail } } },
    (request) => runs.getBatch(request.params.id),
  );

  app.get(
    '/api/runs',
    {
      schema: {
        querystring: z.object({
          batch: z.string().min(1).optional(),
          status: z.enum(runStatuses).optional(),
          task: z.string().min(1).optional(),
          variant: z.string().min(1).optional(),
        }),
        response: { 200: z.array(RunSummary) },
      },
    },
    (request) => runs.listRuns(request.query),
  );

  app.get(
    '/api/runs/:id',
    { schema: { params: IdParams, response: { 200: RunDetail } } },
    (request) => runs.getRun(request.params.id),
  );

  for (const action of ['takeover', 'release', 'finish'] as const) {
    app.post(
      `/api/runs/:id/${action}`,
      { schema: { params: IdParams, response: { 200: Ok } } },
      (request) => {
        runs[action](request.params.id);
        return { ok: true as const };
      },
    );
  }

  app.post(
    '/api/runs/:id/cancel',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (request) => {
      await runs.cancel(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/api/runs/:id/reply',
    {
      schema: {
        params: IdParams,
        body: z.strictObject({ text: z.string().trim().min(1) }),
        response: { 200: Ok },
      },
    },
    (request) => {
      runs.reply(request.params.id, request.body.text);
      return { ok: true as const };
    },
  );

  app.post(
    '/api/runs/:id/answer',
    {
      schema: {
        params: IdParams,
        // Key is the question text, value is the option label (multiple joined with ", ") or free text
        body: z.strictObject({ answers: z.record(z.string(), z.string().trim().min(1)) }),
        response: { 200: Ok },
      },
    },
    (request) => {
      runs.answer(request.params.id, request.body.answers);
      return { ok: true as const };
    },
  );

  // Contracts 7.12
  app.post(
    '/api/runs/:id/invalidate',
    {
      schema: {
        params: IdParams,
        body: z.strictObject({ reason: z.string().trim().min(1) }),
        response: { 200: Ok },
      },
    },
    (request) => {
      runs.setInvalid(request.params.id, request.body.reason);
      return { ok: true as const };
    },
  );

  app.post(
    '/api/runs/:id/revalidate',
    { schema: { params: IdParams, response: { 200: Ok } } },
    (request) => {
      runs.setInvalid(request.params.id, null);
      return { ok: true as const };
    },
  );

  // Contracts 10: summary of the new run (queued)
  app.post(
    '/api/runs/:id/rerun',
    { schema: { params: IdParams, response: { 201: RunSummary } } },
    (request, reply) => {
      void reply.code(201);
      return runs.rerun(request.params.id);
    },
  );

  done();
};
