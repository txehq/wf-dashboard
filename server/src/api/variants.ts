import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Variants } from '../variants/index.js';
import { efforts, modelAliases, modelChoices } from '../variants/models.js';

const ModelAlias = z.enum(modelAliases);
const Effort = z.enum(efforts);

const Variant = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  baseCommit: z.string(),
  skillsHash: z.string(),
  version: z.string(),
  model: z.string(),
  effort: z.string(),
  status: z.enum(['draft', 'frozen']),
  installDir: z.string().nullable(),
  buildStatus: z.enum(['none', 'building', 'built', 'failed']),
  builtHash: z.string().nullable(),
  buildError: z.string().nullable(),
  builtAt: z.date().nullable(),
  createdAt: z.date(),
  frozenAt: z.date().nullable(),
});

const IdParams = z.object({ id: z.string() });
const FileQuery = z.object({ path: z.string().min(1) });
const Name = z.string().trim().min(1).max(100);

const FileDiff = z.object({
  path: z.string(),
  status: z.enum(['added', 'removed', 'modified']),
  oldContent: z.string(),
  newContent: z.string(),
  patch: z.string(),
});

export const variantRoutes: FastifyPluginCallbackZod<{ variants: Variants }> = (
  app,
  { variants },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/variants/options',
    {
      schema: {
        response: {
          200: z.object({
            models: z.array(z.object({ alias: ModelAlias, model: z.string() })),
            efforts: z.array(Effort),
          }),
        },
      },
    },
    () => ({ models: modelChoices(), efforts: [...efforts] }),
  );

  app.get('/api/variants', { schema: { response: { 200: z.array(Variant) } } }, () =>
    variants.list(),
  );

  // 从 txe-workflow 的 commit（默认 HEAD）导入基线
  app.post(
    '/api/variants',
    {
      schema: {
        body: z.object({
          name: Name,
          commit: z.string().min(1).optional(),
          model: ModelAlias.default('opus'),
          effort: Effort.default('high'),
        }),
        response: { 201: Variant },
      },
    },
    async (request, reply) => {
      const variant = await variants.createBaseline(request.body);
      return reply.code(201).send(variant);
    },
  );

  app.get(
    '/api/variants/:id',
    { schema: { params: IdParams, response: { 200: Variant } } },
    (request) => variants.get(request.params.id),
  );

  app.patch(
    '/api/variants/:id',
    {
      schema: {
        params: IdParams,
        body: z.object({ model: ModelAlias.optional(), effort: Effort.optional() }),
        response: { 200: Variant },
      },
    },
    (request) => variants.setSettings(request.params.id, request.body),
  );

  app.post(
    '/api/variants/:id/derive',
    {
      schema: { params: IdParams, body: z.object({ name: Name }), response: { 201: Variant } },
    },
    async (request, reply) =>
      reply.code(201).send(variants.derive(request.params.id, request.body)),
  );

  app.get(
    '/api/variants/:id/files',
    {
      schema: {
        params: IdParams,
        response: { 200: z.array(z.object({ path: z.string(), size: z.number() })) },
      },
    },
    (request) => variants.listFiles(request.params.id),
  );

  app.get(
    '/api/variants/:id/file',
    {
      schema: {
        params: IdParams,
        querystring: FileQuery,
        response: { 200: z.object({ path: z.string(), content: z.string() }) },
      },
    },
    (request) => ({
      path: request.query.path,
      content: variants.readFile(request.params.id, request.query.path),
    }),
  );

  app.put(
    '/api/variants/:id/file',
    {
      schema: {
        params: IdParams,
        body: z.object({ path: z.string().min(1), content: z.string() }),
        response: { 200: Variant },
      },
    },
    (request) => variants.writeFile(request.params.id, request.body.path, request.body.content),
  );

  app.delete(
    '/api/variants/:id/file',
    { schema: { params: IdParams, querystring: FileQuery, response: { 200: Variant } } },
    (request) => variants.deleteFile(request.params.id, request.query.path),
  );

  app.get(
    '/api/variants/:id/diff',
    {
      schema: {
        params: IdParams,
        querystring: z.object({ against: z.enum(['parent', 'base']).default('base') }),
        response: {
          200: z.object({
            against: z.object({
              kind: z.enum(['parent', 'base']),
              variantId: z.string().nullable(),
              commit: z.string(),
            }),
            files: z.array(FileDiff),
          }),
        },
      },
    },
    (request) => variants.diff(request.params.id, request.query.against),
  );

  // 同步完成构建与安装；进度通过事件与 build-log 查看
  app.post(
    '/api/variants/:id/build',
    { schema: { params: IdParams, response: { 200: Variant } } },
    (request) => variants.build(request.params.id),
  );

  app.get(
    '/api/variants/:id/build-log',
    { schema: { params: IdParams, response: { 200: z.string() } } },
    async (request, reply) =>
      reply.type('text/plain; charset=utf-8').send(variants.buildLog(request.params.id)),
  );

  done();
};
