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

  // 发起：建草稿目录、装 skill、在 Live 中建 Codex 会话
  app.post(
    '/api/workflow-drafts',
    {
      schema: {
        body: CreateDraftBody,
        response: { 201: z.object({ draft: DraftView, live: LiveDetail }) },
      },
    },
    async (request, reply) => {
      const created = await drafts.create(request.body);
      void reply.code(201);
      return created;
    },
  );

  app.get(
    '/api/workflow-drafts/:id',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.get(request.params.id),
  );

  // 保存为 workflow / variant：校验与构建失败时 400 原文，草稿保留
  app.post(
    '/api/workflow-drafts/:id/save',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.save(request.params.id),
  );

  done();
};
