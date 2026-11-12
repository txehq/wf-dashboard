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
  // Basic description (Contracts 18.3)
  description: z.string().nullable(),
  // The workflow it belongs to (Contracts 16.4); the page shows name (workflow)
  workflowId: z.string(),
  parentId: z.string().nullable(),
  baseCommit: z.string(),
  skillsHash: z.string(),
  version: z.string(),
  status: z.enum(['draft', 'frozen']),
  installDir: z.string().nullable(),
  // A directory shared with another variant (the migrated lfg and ic, Contracts 16.4); empty when it is its own
  storageId: z.string().nullable(),
  buildStatus: z.enum(['none', 'building', 'built', 'failed']),
  builtHash: z.string().nullable(),
  buildError: z.string().nullable(),
  builtAt: z.date().nullable(),
  createdAt: z.date(),
  frozenAt: z.date().nullable(),
  analysisId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  // The draft id when saved from a Codex draft (Contracts 17.4)
  draftId: z.string().nullable(),
  // When it was deleted (Contracts 24.3); empty when not deleted
  deletedAt: z.date().nullable(),
  // The tag of an automatically imported txe-workflow release (Contracts 29.1); empty otherwise
  releaseTag: z.string().nullable(),
  // "Include Orca's skills" (Contracts 35.5) and the Orca version the latest build put in
  orcaSkills: z.boolean(),
  orcaVersion: z.string().nullable(),
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
        // includeDeleted: list deleted ones too (Compare shows kept runs, Contracts 24.3)
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

  // Import a baseline from a txe-workflow commit (HEAD by default) into a built-in workflowId (lfg by default)
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

  // Deleted variants included: only to show names (kept records such as parent and runs, Contracts 24.3)
  app.get(
    '/api/variants/:id',
    { schema: { params: IdParams, response: { 200: Variant } } },
    (request) => variants.record(request.params.id),
  );

  // Derive only within the same workflow: a workflowId different from the source's is a 400
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

  // Adding, renaming and deleting skill directories (Contracts 16.4)
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

  // Build and install synchronously; progress via events and build-log
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

  // Basic description (Contracts 18.3), rename (16.4) and "Include Orca's skills" (35.5): change one or several at once
  app.patch(
    '/api/variants/:id',
    {
      schema: {
        params: IdParams,
        body: z
          .strictObject({
            description: z.string().max(2000).optional(),
            name: z.string().optional(),
            orcaSkills: z.boolean().optional(),
          })
          .refine(
            (b) =>
              b.description !== undefined || b.name !== undefined || b.orcaSkills !== undefined,
            { message: 'Change description, name or orcaSkills' },
          ),
        response: { 200: Variant },
      },
    },
    (request) => {
      const { id } = request.params;
      const { description, name, orcaSkills } = request.body;
      if (name !== undefined) variants.rename(id, name);
      if (orcaSkills !== undefined) variants.setOrcaSkills(id, orcaSkills);
      return description === undefined
        ? variants.get(id)
        : variants.setDescription(id, description);
    },
  );

  // The current Orca version (Contracts 35.5): the variant page compares it with the version from its build and
  // suggests rebuilding when they differ
  app.get(
    '/api/variants/orca-version',
    { schema: { response: { 200: z.object({ version: z.string().nullable() }) } } },
    async () => ({ version: await variants.orcaVersion() }),
  );

  // A variant's history (Contracts 16.4, 17.4): renames, overwrites by Codex drafts, restores, in time order
  app.get(
    '/api/variants/:id/history',
    { schema: { params: IdParams, response: { 200: z.array(VariantHistoryEntry) } } },
    (request) => variants.history(request.params.id),
  );

  const EventParams = IdParams.extend({ eventId: z.coerce.number().int().positive() });

  // View a src/ kept in history: the per-file changes if the current content were restored to it
  app.get(
    '/api/variants/:id/history/:eventId/diff',
    { schema: { params: EventParams, response: { 200: z.array(FileDiff) } } },
    (request) => variants.historyDiff(request.params.id, request.params.eventId),
  );

  // Restore a src/ kept in history: the src/ before restoring goes into history too; imported and frozen ones are
  // a 409
  app.post(
    '/api/variants/:id/history/:eventId/restore',
    { schema: { params: EventParams, response: { 200: Variant } } },
    (request) => variants.restore(request.params.id, request.params.eventId),
  );

  // Install on this machine (Contracts 18.6): installed is null when not installed
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

  // Variants of the same workflow already installed are uninstalled first; replaced lists them
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
