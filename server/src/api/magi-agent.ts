import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LiveDetail } from '../live/views.js';
import type { MagiAgent } from '../magi-agent/index.js';
import { DeployBody, MagiAgentView, MagiDeployView, MagiOpenBody } from '../magi-agent/views.js';

// Magi Agent (Contracts section 23)
export const magiAgentRoutes: FastifyPluginCallbackZod<{ magi: MagiAgent }> = (
  app,
  { magi },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/magi-agent', { schema: { response: { 200: MagiAgentView } } }, () => magi.view());

  // Open (23.6): continue the chosen session (resuming it when no process runs) or create one
  app.post(
    '/api/magi-agent/open',
    { schema: { body: MagiOpenBody, response: { 200: LiveDetail } } },
    (request) => magi.open(request.body),
  );
  app.post(
    '/api/magi-agent/:liveId/resume',
    {
      schema: {
        params: z.object({ liveId: z.string().min(1) }),
        response: { 200: LiveDetail },
      },
    },
    (request) => magi.resume(request.params.liveId),
  );

  // Deploy (23.5): when all six steps succeed, the service exits with code 75 after sending the response; any failed
  // step is a 409 with its error
  app.post(
    '/api/magi-agent/deploy',
    { schema: { body: DeployBody, response: { 200: MagiDeployView } } },
    async (request, reply) => {
      const result = await magi.deploy(request.body.liveId);
      reply.raw.once('finish', () => {
        magi.restart();
      });
      return result;
    },
  );

  // The full output of deploy step 3
  app.get(
    '/api/magi-agent/deploys/:id/log',
    { schema: { params: z.object({ id: z.coerce.number().int().min(1) }) } },
    (request, reply) =>
      reply.type('text/plain; charset=utf-8').send(magi.deployLog(request.params.id)),
  );

  done();
};
