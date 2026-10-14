import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { liveDrivers } from '../db/schema.js';
import { HookPayload } from '../live/controller.js';
import type { Live } from '../live/index.js';
import { readLogTail } from '../live/pty.js';
import {
  CreateLiveBody,
  DeleteLiveBody,
  ImportLiveBody,
  LiveDetail,
  LiveSummary,
  RenameLiveBody,
  ResumeDefaults,
  ResumePlan,
  ResumeLiveBody,
} from '../live/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// WebSocket 中客户端发来的消息（Contracts 14.3）
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

  // 已关闭的项只在 includeHidden=true 时列出（Contracts 14.5）
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

  // 关闭、恢复显示与删除（Contracts 14.5）：运行中 409，删除时名字不符 400
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

  // 改名（Contracts 14.3）：空白与超过 200 字由 live.rename 以原文报错
  app.patch(
    '/api/live/:id',
    { schema: { params: IdParams, body: RenameLiveBody, response: { 200: LiveDetail } } },
    (request) => live.rename(request.params.id, request.body.title),
  );

  // 导入到交互区（Contracts 14.5）：已有项 409、不存在 404
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

  // resume 的预检（Contracts 14.5）：variantId 为空字符串时为"本机配置"
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

  // 设计与分析优化会话的 resume（Contracts 17.3、22.2）：在同一项上 codex resume <会话 id> 或 claude --resume
  app.post(
    '/api/live/:id/draft-resume',
    { schema: { params: IdParams, response: { 201: LiveDetail } } },
    async (request, reply) => {
      const resumed = await live.resumeDraft(request.params.id);
      void reply.code(201);
      return resumed;
    },
  );

  // 终端：连接时先发保留的输出，之后实时转发；关掉页面不影响进程
  app.get('/api/live/:id/pty', { websocket: true }, (socket, request) => {
    const { id } = IdParams.parse(request.params);
    const controller = live.controller(id);
    // 页面的连接（自动结束，Contracts 14.3）：从打开到关闭都算
    socket.on('close', live.connect());
    const send = (message: unknown) => {
      socket.send(JSON.stringify(message));
    };
    if (controller === null) {
      send({ type: 'output', data: readLogTail(live.logFile(id)) });
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
