import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Live } from '../live/index.js';
import { OrcaGraph, OrcaGraphMessage, OrcaOpenLiveBody, OrcaSwitchBody } from '../live/views.js';

// The Orca topology page (Contracts 40): the graph of the topology sync, the messages behind one edge, and switching
// the desktop Orca to a session's terminal
export const orcaRoutes: FastifyPluginCallbackZod<{ live: Live }> = (app, { live }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The latest sync's graph; sync=true syncs once first (when the page opens)
  app.get(
    '/api/orca/graph',
    {
      schema: {
        querystring: z.object({ sync: z.enum(['true', 'false']).default('false') }),
        response: { 200: OrcaGraph },
      },
    },
    async (request) => {
      if (request.query.sync === 'true') await live.syncOrca();
      return live.orcaGraph();
    },
  );

  // Messages between the nodes in a and the nodes in b (comma-separated node ids; more than one when an edge joins
  // collapsed nodes), oldest first
  app.get(
    '/api/orca/messages',
    {
      schema: {
        querystring: z.object({ a: z.string().min(1), b: z.string().min(1) }),
        response: { 200: z.array(OrcaGraphMessage) },
      },
    },
    (request) => live.orcaMessages(request.query.a.split(','), request.query.b.split(',')),
  );

  app.post(
    '/api/orca/switch',
    { schema: { body: OrcaSwitchBody, response: { 200: z.object({}) } } },
    async (request) => {
      await live.orcaSwitch(request.body.handle, request.body.hostId);
      return {};
    },
  );

  // "Open in Live": the node's Live item, imported from its session record when it has none yet
  app.post(
    '/api/orca/open-live',
    { schema: { body: OrcaOpenLiveBody, response: { 200: z.object({ liveId: z.string() }) } } },
    async (request) => ({ liveId: await live.orcaOpenLive(request.body.nodeId) }),
  );

  done();
};
