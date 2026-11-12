import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Workflows } from '../workflows/index.js';
import { WorkflowView } from '../workflows/schema.js';

const IdParams = z.object({ id: z.string().min(1) });
const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'Only lowercase letters, digits and hyphens, starting with a letter');
const Name = z.string().trim().min(1).max(100);
// Basic description (Contracts 18.3), may be empty
const Description = z.string().max(2000);
// The workflows module validates the definition with WorkflowDefinition, returning zod's message on error
const Definition = z.record(z.string(), z.unknown());

// Contracts 16.1
export const workflowRoutes: FastifyPluginCallbackZod<{ workflows: Workflows }> = (
  app,
  { workflows },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/workflows', { schema: { response: { 200: z.array(WorkflowView) } } }, () =>
    workflows.list(),
  );

  app.get(
    '/api/workflows/:id',
    { schema: { params: IdParams, response: { 200: WorkflowView } } },
    (request) => workflows.get(request.params.id),
  );

  // Create from blank (Contracts 18.5), also creating the first draft variant
  app.post(
    '/api/workflows',
    {
      schema: {
        body: z.strictObject({
          id: Slug,
          name: Name,
          description: Description,
          definition: Definition,
        }),
        response: { 201: WorkflowView },
      },
    },
    (request, reply) => {
      void reply.code(201);
      return workflows.create(request.body);
    },
  );

  // The built-in lfg and ic only allow description changes; 409 when the name or definition changes
  app.put(
    '/api/workflows/:id',
    {
      schema: {
        params: IdParams,
        body: z.strictObject({ name: Name, description: Description, definition: Definition }),
        response: { 200: WorkflowView },
      },
    },
    (request) => workflows.update(request.params.id, request.body),
  );

  done();
};
