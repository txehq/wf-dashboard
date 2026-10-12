import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Drafts } from '../drafts/index.js';
import { CreateDraftBody, DraftView } from '../drafts/views.js';
import { LiveDetail } from '../live/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// Contracts 第 17 节：用 Codex 生成 workflow 或 variant
export const draftRoutes: FastifyPluginCallbackZod<{ drafts: Drafts }> = (
  app,
  { drafts },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 发起：立即建草稿与 Live 项并返回；草稿目录的准备（复制 src、说明与例子、安装 skill）与启动 Codex 在后台进行
  app.post(
    '/api/workflow-drafts',
    {
      schema: {
        body: CreateDraftBody,
        response: { 201: z.object({ draft: DraftView, live: LiveDetail }) },
      },
    },
    (request, reply) => {
      const created = drafts.create(request.body);
      void reply.code(201);
      return created;
    },
  );

  app.get(
    '/api/workflow-drafts/:id',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.get(request.params.id),
  );

  // 重试准备：从失败的那一步接着做；不是 failed 时 409
  app.post(
    '/api/workflow-drafts/:id/retry',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.retry(request.params.id),
  );

  // 保存为 workflow / variant：校验与构建失败时 400 原文，草稿保留
  app.post(
    '/api/workflow-drafts/:id/save',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.save(request.params.id),
  );

  done();
};
