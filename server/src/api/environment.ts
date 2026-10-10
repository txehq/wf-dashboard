import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Environment, EnvironmentReport } from '../environment.js';

// Contracts 第 8 节：结果缓存 10 分钟，?refresh=1 重新检查
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
