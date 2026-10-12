import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Workflows } from '../workflows/index.js';
import { WorkflowView } from '../workflows/schema.js';

const IdParams = z.object({ id: z.string().min(1) });
const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, '只能包含小写字母、数字与连字符，以字母开头');
const Name = z.string().trim().min(1).max(100);
// 定义的结构由 workflows 模块用 WorkflowDefinition 校验，错误以 zod 的原文返回
const Definition = z.record(z.string(), z.unknown());

// Contracts 16.1
export const workflowRoutes: FastifyPluginCallbackZod<{ workflows: Workflows }> = (
  app,
  { workflows },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/workflows', { schema: { response: { 200: z.array(WorkflowView) } } }, () =>
    workflows.list(),
  );

  app.get(
    '/api/workflows/:id',
    { schema: { params: IdParams, response: { 200: WorkflowView } } },
    (request) => workflows.get(request.params.id),
  );

  // 复制 fromVariantId 的基线导出与 src/skills 作为新 workflow 的第一个 variant
  app.post(
    '/api/workflows',
    {
      schema: {
        body: z.strictObject({
          id: Slug,
          name: Name,
          fromVariantId: z.string().min(1),
          keepEvalKind: z.boolean(),
          definition: Definition,
        }),
        response: { 201: WorkflowView },
      },
    },
    (request, reply) => {
      void reply.code(201);
      return workflows.create(request.body);
    },
  );

  // 内置的 lfg、ic 返回 409
  app.put(
    '/api/workflows/:id',
    {
      schema: {
        params: IdParams,
        body: z.strictObject({ name: Name, definition: Definition }),
        response: { 200: WorkflowView },
      },
    },
    (request) => workflows.update(request.params.id, request.body),
  );

  done();
};
