import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SessionActions } from '../deletion/sessions.js';
import { SessionActionBody, SessionActionPlan, sessionActions } from '../deletion/session-views.js';

// Contracts 25.3, 25.5: delete, archive and restore on the Sessions page. action-plan is the confirm dialog content; 409 listing the reasons when refused;
// 500 with the message when a Codex command fails
export const sessionActionRoutes: FastifyPluginCallbackZod<{ actions: SessionActions }> = (
  app,
  { actions },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/sessions/action-plan',
    {
      schema: {
        querystring: z.object({
          action: z.enum(sessionActions),
          ids: z
            .string()
            .min(1)
            .transform((s) => s.split(',')),
        }),
        response: { 200: SessionActionPlan },
      },
    },
    (request) => actions.plan(request.query.action, request.query.ids),
  );
  // Same content with ids in the body: selecting all gives many ids and the query string would exceed the header limit
  app.post(
    '/api/sessions/action-plan',
    {
      schema: {
        body: SessionActionBody.extend({ action: z.enum(sessionActions) }),
        response: { 200: SessionActionPlan },
      },
    },
    (request) => actions.plan(request.body.action, request.body.ids),
  );

  for (const action of sessionActions) {
    app.post(
      `/api/sessions/${action}`,
      { schema: { body: SessionActionBody, response: { 200: SessionActionPlan } } },
      (request) => actions.execute(action, request.body.ids),
    );
  }

  done();
};
