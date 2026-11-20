import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LocalDirs } from '../dirs/local.js';
import { DirList, NewDir, NewDirBody } from '../dirs/views.js';

// Browsing directories and creating folders on the local machine (Contracts 34.1)
export const localDirRoutes: FastifyPluginCallbackZod<{ dirs: LocalDirs }> = (
  app,
  { dirs },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/local/dirs',
    {
      schema: {
        querystring: z.object({ path: z.string().default('') }),
        response: { 200: DirList },
      },
    },
    (request) => dirs.list(request.query.path),
  );

  app.post(
    '/api/local/dirs',
    { schema: { body: NewDirBody, response: { 201: NewDir } } },
    async (request, reply) => {
      const created = await dirs.mkdir(request.body.parent, request.body.name);
      void reply.code(201);
      return created;
    },
  );

  done();
};
