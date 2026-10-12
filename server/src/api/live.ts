import fs from 'node:fs';
import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { liveDrivers } from '../db/schema.js';
import { HookPayload } from '../live/controller.js';
import type { Live } from '../live/index.js';
import {
  CreateLiveBody,
  LiveDetail,
  LiveSummary,
  ResumeDefaults,
  ResumeLiveBody,
} from '../live/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// 已退出的 session 只回放 pty.log 的最后这么多字节（与运行中保留的输出相同）
const REPLAY_BYTES = 4 * 1024 * 1024;

// WebSocket 中客户端发来的消息（Contracts 14.3）
const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

function logTail(file: string): string {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const length = Math.min(size, REPLAY_BYTES);
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, size - length);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

// Contracts 14
export const liveRoutes: FastifyPluginCallbackZod<{ live: Live }> = (app, { live }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/live', { schema: { response: { 200: z.array(LiveSummary) } } }, () => live.list());

  app.get(
    '/api/live/:id',
    { schema: { params: IdParams, response: { 200: LiveDetail } } },
    (request) => live.get(request.params.id),
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

  app.post(
    '/api/live/resume',
    { schema: { body: ResumeLiveBody, response: { 201: LiveDetail } } },
    (request, reply) => {
      const created = live.resume(request.body);
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

  // hook 命令 POST 的 stdin JSON
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

  // 驾驶者开关；driver 为 simulated 即"交还给模拟用户"
  app.post(
    '/api/live/:id/driver',
    {
      schema: {
        params: IdParams,
        body: z.strictObject({ driver: z.enum(liveDrivers) }),
        response: { 200: LiveDetail },
      },
    },
    (request) => live.setDriver(request.params.id, request.body.driver),
  );

  app.post(
    '/api/live/:id/stop',
    { schema: { params: IdParams, response: { 200: LiveDetail } } },
    (request) => live.stop(request.params.id),
  );

  // 终端：连接时先发保留的输出，之后实时转发；关掉页面不影响进程
  app.get('/api/live/:id/pty', { websocket: true }, (socket, request) => {
    const { id } = IdParams.parse(request.params);
    const controller = live.controller(id);
    const send = (message: unknown) => {
      socket.send(JSON.stringify(message));
    };
    if (controller === null) {
      send({ type: 'output', data: logTail(live.logFile(id)) });
      send({ type: 'exit' });
      return;
    }
    send({ type: 'output', data: controller.pty.backlog() });
    const unsubscribe = controller.pty.onData((data) => {
      send({ type: 'output', data });
    });
    void controller.exited.then(() => {
      send({ type: 'exit' });
    });
    socket.on('message', (raw: Buffer) => {
      // 不合约定的消息与已退出的进程：把原因发给这个客户端并关闭连接，进程与其他连接不受影响
      // （close 的 reason 最多 123 字节，原因放在之前的 error 消息里）
      const text = raw.toString('utf8');
      const parsed = ClientMessage.safeParse(JSON.parse(text));
      if (!parsed.success) {
        send({
          type: 'error',
          message: `无法识别的消息 ${text.slice(0, 200)}：${parsed.error.message}`,
        });
        socket.close(1008, 'invalid message');
        return;
      }
      if (!controller.pty.alive) {
        send({ type: 'error', message: '进程已退出' });
        socket.close(1011, 'process exited');
        return;
      }
      const message = parsed.data;
      if (message.type === 'input') controller.input(message.data);
      else controller.pty.resize(message.cols, message.rows);
    });
    socket.on('close', unsubscribe);
  });

  done();
};
