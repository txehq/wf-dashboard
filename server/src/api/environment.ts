import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Environment, EnvironmentReport } from '../environment.js';

// Contracts section 8: free checks are cached for 10 minutes and paid checks are read from their records; ?refresh=1
// runs every check, paid ones included
export const environmentRoutes: FastifyPluginCallbackZod<{ environment: Environment }> = (
  app,
  { environment },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/environment',
    {
      schema: {
        querystring: z.strictObject({ refresh: z.literal('1').optional() }),
        response: { 200: EnvironmentReport },
      },
    },
    (request) => environment.get(request.query.refresh === '1'),
  );

  done();
};
