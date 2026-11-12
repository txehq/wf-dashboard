import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deletion } from '../deletion/index.js';
import { DeleteBody, DeletionPlan } from '../deletion/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// Contracts section 24: deleting variants and workflows. delete-plan is the confirm dialog content; a refused DELETE is 409, listing what blocks the deletion
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
