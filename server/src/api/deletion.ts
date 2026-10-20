import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deletion } from '../deletion/index.js';
import { DeleteBody, DeletionPlan } from '../deletion/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// Contracts 第 24 节：删除 variant 与 workflow。delete-plan 是确认对话框的内容；DELETE 拒绝时 409，原文列出阻止删除的项
export const deletionRoutes: FastifyPluginCallbackZod<{ deletion: Deletion }> = (
  app,
  { deletion },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/variants/:id/delete-plan',
    { schema: { params: IdParams, response: { 200: DeletionPlan } } },
    (request) => deletion.variantPlan(request.params.id),
  );

  app.delete(
    '/api/variants/:id',
    { schema: { params: IdParams, body: DeleteBody, response: { 200: DeletionPlan } } },
    (request) => deletion.deleteVariant(request.params.id, request.body),
  );

  app.get(
    '/api/workflows/:id/delete-plan',
    { schema: { params: IdParams, response: { 200: DeletionPlan } } },
    (request) => deletion.workflowPlan(request.params.id),
  );

  app.delete(
    '/api/workflows/:id',
    { schema: { params: IdParams, body: DeleteBody, response: { 200: DeletionPlan } } },
    (request) => deletion.deleteWorkflow(request.params.id, request.body),
  );

  done();
};
