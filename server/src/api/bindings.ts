import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  bindingView,
  defaultBaseVariant,
  deriveFromSession,
  setManualBinding,
} from '../bindings/index.js';
import type { Db } from '../db/index.js';
import { variantBindings } from '../db/schema.js';
import type { Variants } from '../variants/index.js';

const Named = z.object({ id: z.string(), name: z.string() });

const Binding = z.object({
  // deleted：绑定的 variant 已删除（Contracts 24.3）
  variant: Named.extend({ deleted: z.boolean() }).nullable(),
  binding: z.enum(variantBindings).nullable(),
  matching: z.array(Named),
  skills: z.array(z.object({ name: z.string(), loads: z.number().int() })),
  // "按 session 的 skill 新建 variant" 的默认底子
  defaultBase: Named.nullable(),
});

const Params = z.object({ id: z.string() });

// Contracts 15.1：session 的 variant 绑定
export const bindingRoutes: FastifyPluginCallbackZod<{
  db: Db;
  variants: Variants;
  dataDir: string;
}> = (app, { db, variants, dataDir }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const view = (id: string) => {
    const base = defaultBaseVariant(db);
    return {
      ...bindingView(db, dataDir, id),
      defaultBase: base === null ? null : { id: base.id, name: base.name },
    };
  };

  app.get(
    '/api/sessions/:id/binding',
    { schema: { params: Params, response: { 200: Binding } } },
    (request) => view(request.params.id),
  );

  // 手动改选（variantId 为空表示解除），或 { auto: true } 恢复自动判定
  app.put(
    '/api/sessions/:id/binding',
    {
      schema: {
        params: Params,
        body: z.union([
          z.object({ variantId: z.string().nullable() }),
          z.object({ auto: z.literal(true) }),
        ]),
        response: { 200: Binding },
      },
    },
    (request) => {
      const body = request.body;
      setManualBinding(db, dataDir, request.params.id, 'auto' in body ? 'auto' : body);
      return view(request.params.id);
    },
  );

  app.post(
    '/api/sessions/:id/derive-variant',
    {
      schema: {
        params: Params,
        body: z.object({
          baseVariantId: z.string().min(1),
          name: z.string().trim().min(1).max(100),
        }),
        response: { 201: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    async (request, reply) => {
      const created = deriveFromSession(db, variants, dataDir, request.params.id, request.body);
      return reply.code(201).send({ id: created.id, name: created.name });
    },
  );

  done();
};
