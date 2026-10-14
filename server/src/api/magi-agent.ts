import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LiveDetail } from '../live/views.js';
import type { MagiAgent } from '../magi-agent/index.js';
import { DeployBody, MagiAgentView, MagiDeployView, MagiEngineBody } from '../magi-agent/views.js';

// Magi Agent（Contracts 第 23 节）
export const magiAgentRoutes: FastifyPluginCallbackZod<{ magi: MagiAgent }> = (
  app,
  { magi },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/magi-agent', { schema: { response: { 200: MagiAgentView } } }, () => magi.view());

  // 打开这种引擎的当前会话（23.1）：没有时新建，没有运行中的进程时 resume
  app.post(
    '/api/magi-agent/open',
    { schema: { body: MagiEngineBody, response: { 200: LiveDetail } } },
    (request) => magi.open(request.body.engine),
  );
  app.post(
    '/api/magi-agent/new',
    { schema: { body: MagiEngineBody, response: { 200: LiveDetail } } },
    (request) => magi.newSession(request.body.engine),
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

  // 部署（23.5）：六步都成功时响应发出之后服务以退出码 75 结束；任何一步失败时 409 原文
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

  // 部署第 3 步的完整输出
  app.get(
    '/api/magi-agent/deploys/:id/log',
    { schema: { params: z.object({ id: z.coerce.number().int().min(1) }) } },
    (request, reply) =>
      reply.type('text/plain; charset=utf-8').send(magi.deployLog(request.params.id)),
  );

  done();
};
