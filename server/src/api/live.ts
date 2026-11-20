import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HookPayload } from '../live/controller.js';
import type { Live } from '../live/index.js';
import { readLogTail } from '../live/pty.js';
import {
  CreateLiveBody,
  DeleteLiveBody,
  ImportLiveBody,
  LiveDetail,
  LiveDriverBody,
  LiveGoalBody,
  LiveSummary,
  LocalEntries,
  OrcaTopology,
  RenameLiveBody,
  ResumeDefaults,
  ResumePlan,
  ResumeLiveBody,
  StopLiveBody,
  WorkerSendBody,
  WorkerSendResult,
  WorkerTranscript,
} from '../live/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// Messages the client sends over the WebSocket (Contracts 14.3)
const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

// Contracts 14
export const liveRoutes: FastifyPluginCallbackZod<{ live: Live }> = (app, { live }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Closed items are listed only with includeHidden=true (Contracts 14.5)
  app.get(
    '/api/live',
    {
      schema: {
        querystring: z.object({ includeHidden: z.enum(['true', 'false']).default('false') }),
        response: { 200: z.array(LiveSummary) },
      },
    },
    (request) => live.list(request.query.includeHidden === 'true'),
  );

  // Close, show again and delete (Contracts 14.5): 409 while running, 400 when the name does not match on delete
  app.post(
    '/api/live/:id/hide',
    { schema: { params: IdParams, response: { 200: LiveDetail } } },
    (request) => live.hide(request.params.id),
  );
  app.post(
    '/api/live/:id/unhide',
    { schema: { params: IdParams, response: { 200: LiveDetail } } },
    (request) => live.unhide(request.params.id),
  );
  app.delete(
    '/api/live/:id',
    {
      schema: {
        params: IdParams,
        body: DeleteLiveBody,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    (request) => {
      live.remove(request.params.id, request.body.confirmTitle);
      return { ok: true as const };
    },
  );

  app.get(
    '/api/live/:id',
    { schema: { params: IdParams, response: { 200: LiveDetail } } },
    (request) => live.get(request.params.id),
  );

  // Rename (Contracts 14.3): live.rename rejects blank names and names over 200 characters with its error
  app.patch(
    '/api/live/:id',
    { schema: { params: IdParams, body: RenameLiveBody, response: { 200: LiveDetail } } },
    (request) => live.rename(request.params.id, request.body.title),
  );

  // Import to Live (Contracts 14.5): 409 for existing items, 404 when missing
  app.post(
    '/api/live/import',
    { schema: { body: ImportLiveBody, response: { 201: z.array(LiveSummary) } } },
    (request, reply) => {
      const created = live.importSessions(request.body.sessionIds);
      void reply.code(201);
      return created;
    },
  );

  app.post(
    '/api/live',
    { schema: { body: CreateLiveBody, response: { 201: LiveDetail } } },
    async (request, reply) => {
      const created = await live.create(request.body);
      void reply.code(201);
      return created;
    },
  );

  // Entry commands available with the local configuration when creating a Live item (Contracts 29.2)
  app.get('/api/live/local-entries', { schema: { response: { 200: LocalEntries } } }, () => ({
    workflows: live.localEntries(),
  }));

  // Orca's collaboration topology (Contracts 35.3): the latest sync result; sync=true syncs once first (when the
  // topology drawer opens)
  app.get(
    '/api/live/orca',
    {
      schema: {
        querystring: z.object({ sync: z.enum(['true', 'false']).default('false') }),
        response: { 200: OrcaTopology },
      },
    },
    async (request) => {
      if (request.query.sync === 'true') await live.syncOrca();
      return live.orcaTopology();
    },
  );

  // A worker Orca runs without a pane (Contracts 35.4): one page of its transcript, and input for it. cursor is the
  // one the previous page returned, so a poll brings back only what the worker wrote since
  app.get(
    '/api/live/:id/worker',
    {
      schema: {
        params: IdParams,
        querystring: z.object({ cursor: z.string().min(1).optional() }),
        response: { 200: WorkerTranscript },
      },
    },
    (request) => live.workerTranscript(request.params.id, request.query.cursor ?? null),
  );

  app.post(
    '/api/live/:id/worker/send',
    { schema: { params: IdParams, body: WorkerSendBody, response: { 200: WorkerSendResult } } },
    (request) => live.sendToWorker(request.params.id, request.body.text.trim()),
  );

  app.post(
    '/api/live/resume',
    { schema: { body: ResumeLiveBody, response: { 201: LiveDetail } } },
    async (request, reply) => {
      const created = await live.resume(request.body);
      void reply.code(201);
      return created;
    },
  );

  app.get(
    '/api/live/resume-defaults',
    {
      schema: {
        querystring: z.object({ sessionId: z.string().min(1) }),
        response: { 200: ResumeDefaults },
      },
    },
    (request) => live.resumeDefaults(request.query.sessionId),
  );

  // Resume preflight (Contracts 14.5): an empty variantId means the local configuration
  app.get(
    '/api/live/resume-plan',
    {
      schema: {
        querystring: z.object({ sessionId: z.string().min(1), variantId: z.string().default('') }),
        response: { 200: ResumePlan },
      },
    },
    (request) =>
      live.resumePlan(
        request.query.sessionId,
        request.query.variantId === '' ? null : request.query.variantId,
      ),
  );

  // The stdin JSON a hook command POSTs
  app.post(
    '/api/live/:id/hook',
    {
      schema: {
        params: IdParams,
        body: HookPayload,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    (request) => {
      live.hook(request.params.id, request.body);
      return { ok: true as const };
    },
  );

  // The driver switch (Human or Simulated user). An item with no task writes down its
  // goal the first time it is handed to the simulated user (Contracts 34.2)
  app.post(
    '/api/live/:id/driver',
    {
      schema: {
        params: IdParams,
        body: LiveDriverBody,
        response: { 200: LiveDetail },
      },
    },
    (request) => live.setDriver(request.params.id, request.body.driver, request.body.goal),
  );

  // View and change the simulated user's goal from the toolbar (Contracts 34.2)
  app.put(
    '/api/live/:id/goal',
    { schema: { params: IdParams, body: LiveGoalBody, response: { 200: LiveDetail } } },
    (request) => live.setGoal(request.params.id, request.body.goal),
  );

  app.post(
    '/api/live/:id/stop',
    {
      schema: {
        params: IdParams,
        body: StopLiveBody.nullish(),
        response: { 200: LiveDetail },
      },
    },
    (request) => live.stop(request.params.id, request.body?.source ?? 'api'),
  );

  // Resume of design and analysis-optimize sessions (Contracts 17.3, 22.2): codex resume <session id> or
  // claude --resume on the same item
  app.post(
    '/api/live/:id/draft-resume',
    { schema: { params: IdParams, response: { 201: LiveDetail } } },
    async (request, reply) => {
      const resumed = await live.resumeDraft(request.params.id);
      void reply.code(201);
      return resumed;
    },
  );

  // Terminal: on connect, send the kept output first, then forward live; closing the page does not affect the
  // process. When the process ends, exit is sent and the server closes the connection (1000), which no longer refers
  // to this item's PTY; finished items replay from pty.log
  app.get('/api/live/:id/pty', { websocket: true }, (socket, request) => {
    const { id } = IdParams.parse(request.params);
    const controller = live.controller(id);
    // A page's connection (auto-stop, Contracts 14.3): counts from open to close
    socket.on('close', live.connect());
    const send = (message: unknown) => {
      socket.send(JSON.stringify(message));
    };
    const replayEnded = () => {
      send({ type: 'output', data: readLogTail(live.logFile(id)) });
      send({ type: 'exit' });
      socket.close(1000, 'process exited');
    };
    if (controller === null) {
      replayEnded();
      return;
    }
    // The process is exiting (the controller is not removed yet): replay as well once pty.log is complete
    if (!controller.pty.alive) {
      void controller.exited.then(replayEnded);
      return;
    }
    send({ type: 'output', data: controller.pty.backlog() });
    const unsubscribe = controller.pty.onData((data) => {
      send({ type: 'output', data });
    });
    void controller.exited.then(() => {
      unsubscribe();
      send({ type: 'exit' });
      socket.close(1000, 'process exited');
    });
    socket.on('message', (raw: Buffer) => {
      // A message that breaks the protocol: send the reason to this client and close its connection; the process and
      // other connections are unaffected (a close reason is at most 123 bytes, so the reason goes in an error message
      // first)
      const text = raw.toString('utf8');
      const parsed = ClientMessage.safeParse(JSON.parse(text));
      if (!parsed.success) {
        send({
          type: 'error',
          message: `Unrecognised message ${text.slice(0, 200)}: ${parsed.error.message}`,
        });
        socket.close(1008, 'invalid message');
        return;
      }
      // The process is exiting (common while dragging the window or auto-fitting the terminal): stop forwarding to it;
      // exit is sent and the connection closed as usual once pty.log is complete
      if (!controller.pty.alive) return;
      const message = parsed.data;
      if (message.type === 'input') controller.input(message.data);
      else controller.pty.resize(message.cols, message.rows);
    });
    socket.on('close', unsubscribe);
  });

  done();
};
