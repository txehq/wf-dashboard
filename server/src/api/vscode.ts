import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Vscode } from '../vscode/index.js';
import { VscodeOpenResult, VscodeServerView } from '../vscode/views.js';

// Open the working directory of a Live item in web VS Code (Contracts 32.4)
export const vscodeRoutes: FastifyPluginCallbackZod<{ vscode: Vscode }> = (
  app,
  { vscode },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.post(
    '/api/vscode/open',
    {
      schema: {
        body: z.object({ liveId: z.string().min(1) }),
        response: { 200: VscodeOpenResult },
      },
    },
    (request) => vscode.open(request.body.liveId),
  );

  app.get('/api/vscode/servers', { schema: { response: { 200: z.array(VscodeServerView) } } }, () =>
    vscode.list(),
  );

  app.delete(
    '/api/vscode/servers/:id',
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request, reply) => {
      await vscode.stop(request.params.id);
      return reply.code(204).send();
    },
  );

  done();
};
