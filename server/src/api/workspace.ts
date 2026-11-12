import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  WorkspaceAgainst,
  WorkspaceDiffView,
  WorkspaceFileView,
  WorkspaceView,
} from '../drafts/views.js';
import type { Workspace } from '../drafts/workspace.js';

const IdParams = z.object({ id: z.string().min(1) });
const PathQuery = z.object({ path: z.string().min(1) });
// What to diff against (28.4), the base when omitted
const DiffQuery = PathQuery.extend({ against: WorkspaceAgainst.default('base') });

// Contracts 26.4: the workflow panel of design and optimize sessions, reading only src/skills and workflow.yaml in the item's working directory
export const workspaceRoutes: FastifyPluginCallbackZod<{ workspace: Workspace }> = (
  app,
  { workspace },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/live/:id/workspace',
    { schema: { params: IdParams, response: { 200: WorkspaceView } } },
    (request) => workspace.tree(request.params.id),
  );

  app.get(
    '/api/live/:id/workspace/file',
    { schema: { params: IdParams, querystring: PathQuery, response: { 200: WorkspaceFileView } } },
    (request) => workspace.file(request.params.id, request.query.path),
  );

  app.get(
    '/api/live/:id/workspace/diff',
    {
      schema: { params: IdParams, querystring: DiffQuery, response: { 200: WorkspaceDiffView } },
    },
    (request) => workspace.diff(request.params.id, request.query.path, request.query.against),
  );

  // File changes are pushed within 1 second; sends closed and ends when the item is closed or deleted. Items without a draft get 404 before SSE starts
  app.get(
    '/api/live/:id/workspace/events',
    { sse: 'only', schema: { params: IdParams } },
    async (request, reply) => {
      const release = workspace.watch(request.params.id, {
        send: (event) => {
          void reply.sse.send({ event: event.type, data: event });
        },
        end: () => {
          reply.sse.close();
        },
      });
      reply.sse.keepAlive();
      reply.sse.onClose(release);
      await reply.sse.send({ event: 'ready', data: {} });
    },
  );

  done();
};
