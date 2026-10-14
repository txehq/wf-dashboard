import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Variants, VariantHistoryEntry } from '../variants/index.js';
import { InstallView } from '../variants/local-install.js';
import { efforts, modelAliases, modelChoices } from '../variants/models.js';

const ModelAlias = z.enum(modelAliases);
const Effort = z.enum(efforts);

const Variant = z.object({
  id: z.string(),
  name: z.string(),
  // 基本描述（Contracts 18.3）
  description: z.string().nullable(),
  // 所属 workflow（Contracts 16.4）；页面显示为 名字 (workflow)
  workflowId: z.string(),
  parentId: z.string().nullable(),
  baseCommit: z.string(),
  skillsHash: z.string(),
  version: z.string(),
  status: z.enum(['draft', 'frozen']),
  installDir: z.string().nullable(),
  // 与另一个 variant 共用的目录（迁移拆出的 lfg 与 ic，Contracts 16.4）；为空时是自己的目录
  storageId: z.string().nullable(),
  buildStatus: z.enum(['none', 'building', 'built', 'failed']),
  builtHash: z.string().nullable(),
  buildError: z.string().nullable(),
  builtAt: z.date().nullable(),
  createdAt: z.date(),
  frozenAt: z.date().nullable(),
  analysisId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  // 由 Codex 草稿保存出时的草稿 id（Contracts 17.4）
  draftId: z.string().nullable(),
  // 删除的时间（Contracts 24.3）；没有删除时为空
  deletedAt: z.date().nullable(),
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

  app.get(
    '/api/variants',
    {
      schema: {
        // includeDeleted：也列出已删除的（Compare 显示保留的 run，Contracts 24.3）
        querystring: z.object({ includeDeleted: z.enum(['1']).optional() }),
        response: { 200: z.array(Variant.extend({ boundSessions: z.number() })) },
      },
    },
    (request) => {
      const bound = variants.boundSessions();
      return variants
        .list(request.query.includeDeleted === '1')
        .map((v) => ({ ...v, boundSessions: bound.get(v.id) ?? 0 }));
    },
  );

  // 从 txe-workflow 的 commit（默认 HEAD）导入基线，属于内置的 workflowId（默认 lfg）
  app.post(
    '/api/variants',
    {
      schema: {
        body: z.object({
          name: Name,
          commit: z.string().min(1).optional(),
          workflowId: z.string().min(1).optional(),
        }),
        response: { 201: Variant },
      },
    },
    async (request, reply) => {
      const variant = await variants.createBaseline(request.body);
      return reply.code(201).send(variant);
    },
  );

  // 包括已删除的 variant：只用于显示名字（parent、run 等保留的记录，Contracts 24.3）
  app.get(
    '/api/variants/:id',
    { schema: { params: IdParams, response: { 200: Variant } } },
    (request) => variants.record(request.params.id),
  );

  // 派生只能在同一 workflow 内：给出与来源不同的 workflowId 时 400
  app.post(
    '/api/variants/:id/derive',
    {
      schema: {
        params: IdParams,
        body: z.object({ name: Name, workflowId: z.string().min(1).optional() }),
        response: { 201: Variant },
      },
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

  // skill 目录的新增、重命名与删除（Contracts 16.4）
  app.post(
    '/api/variants/:id/skills',
    {
      schema: {
        params: IdParams,
        body: z.object({ name: z.string() }),
        response: { 200: Variant },
      },
    },
    (request) => variants.addSkill(request.params.id, request.body.name),
  );

  app.patch(
    '/api/variants/:id/skills/:name',
    {
      schema: {
        params: IdParams.extend({ name: z.string() }),
        body: z.object({ name: z.string() }),
        response: { 200: Variant },
      },
    },
    (request) => variants.renameSkill(request.params.id, request.params.name, request.body.name),
  );

  app.delete(
    '/api/variants/:id/skills/:name',
    {
      schema: { params: IdParams.extend({ name: z.string() }), response: { 200: Variant } },
    },
    (request) => variants.deleteSkill(request.params.id, request.params.name),
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

  // 基本描述（Contracts 18.3）与改名（16.4）：一次改其中一项或两项
  app.patch(
    '/api/variants/:id',
    {
      schema: {
        params: IdParams,
        body: z
          .strictObject({
            description: z.string().max(2000).optional(),
            name: z.string().optional(),
          })
          .refine((b) => b.description !== undefined || b.name !== undefined, {
            message: '要改 description 或 name',
          }),
        response: { 200: Variant },
      },
    },
    (request) => {
      const { id } = request.params;
      const { description, name } = request.body;
      if (name !== undefined) variants.rename(id, name);
      return description === undefined
        ? variants.get(id)
        : variants.setDescription(id, description);
    },
  );

  // variant 的历史（Contracts 16.4、17.4）：改名、被 Codex 草稿覆盖、恢复，按时间先后
  app.get(
    '/api/variants/:id/history',
    { schema: { params: IdParams, response: { 200: z.array(VariantHistoryEntry) } } },
    (request) => variants.history(request.params.id),
  );

  const EventParams = IdParams.extend({ eventId: z.coerce.number().int().positive() });

  // 查看历史中存下的 src/：现在的内容恢复成它时逐文件的改动
  app.get(
    '/api/variants/:id/history/:eventId/diff',
    { schema: { params: EventParams, response: { 200: z.array(FileDiff) } } },
    (request) => variants.historyDiff(request.params.id, request.params.eventId),
  );

  // 恢复历史中存下的 src/：恢复前的 src/ 同样存进历史；导入的与已冻结的 409
  app.post(
    '/api/variants/:id/history/:eventId/restore',
    { schema: { params: EventParams, response: { 200: Variant } } },
    (request) => variants.restore(request.params.id, request.params.eventId),
  );

  // 安装到本机（Contracts 18.6）：没有装时 installed 为 null
  app.get(
    '/api/variants/:id/install',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ installed: InstallView.nullable() }) },
      },
    },
    (request) => ({ installed: variants.localInstall(request.params.id) }),
  );

  // 同一 workflow 已装的 variant 先卸载，replaced 列出这些
  app.post(
    '/api/variants/:id/install',
    {
      schema: {
        params: IdParams,
        response: {
          200: z.object({ installed: InstallView, replaced: z.array(InstallView) }),
        },
      },
    },
    (request) => {
      const { manifest, replaced } = variants.installLocal(request.params.id);
      return { installed: manifest, replaced };
    },
  );

  app.delete(
    '/api/variants/:id/install',
    {
      schema: { params: IdParams, response: { 200: z.object({ uninstalled: InstallView }) } },
    },
    (request) => ({ uninstalled: variants.uninstallLocal(request.params.id) }),
  );

  done();
};
