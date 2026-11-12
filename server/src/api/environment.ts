import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Environment, EnvironmentReport } from '../environment.js';

// Contracts section 8: results are cached for 10 minutes, ?refresh=1 checks again
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
