import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Live } from '../live/index.js';
import { HttpError } from '../variants/errors.js';
import { openInVscode } from '../vscode/index.js';

// "Open in VS Code" on a Live item (Contracts section 32): opens its working directory in the user's VS Code
export const vscodeRoutes: FastifyPluginCallbackZod<{ live: Live }> = (app, { live }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.post(
    '/api/vscode/open',
    {
      schema: {
        body: z.object({ liveId: z.string().min(1) }),
        response: { 200: z.object({}) },
      },
    },
    async (request) => {
      const item = live.get(request.body.liveId);
      if (item.host !== null && item.host.target === null) {
        throw new HttpError(400, `The SSH host of Live item ${item.id} was deleted`);
      }
      await openInVscode({ cwd: item.cwd, hostTarget: item.host?.target ?? null });
      return {};
    },
  );

  done();
};
