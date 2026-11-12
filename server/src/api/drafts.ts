import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Drafts } from '../drafts/index.js';
import {
  CreateDraftBody,
  DraftDiffView,
  DraftView,
  OptimizeBody,
  SaveDraftBody,
  SavePlanView,
  SessionVariantsView,
} from '../drafts/views.js';
import { LiveDetail } from '../live/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// Contracts section 17: generate a workflow or variant with Codex
export const draftRoutes: FastifyPluginCallbackZod<{ drafts: Drafts }> = (
  app,
  { drafts },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Start: create the draft and Live item and return at once; preparing the draft directory (copy src, instructions and examples, install skills) and starting Codex happen in the background
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

  // Change preview before saving (Contracts 17.4, 21.3): diff of the draft's src/ against the target (against is the
  // overwritten variant, the base when omitted); 409 while still preparing
  app.get(
    '/api/workflow-drafts/:id/diff',
    {
      schema: {
        params: IdParams,
        querystring: z.object({ against: z.string().min(1).optional() }),
        response: { 200: DraftDiffView },
      },
    },
    (request) => drafts.diff(request.params.id, request.query.against),
  );

  // Save dialog contents: prefill for a new workflow, or the variants of the same workflow that can be overwritten; 400 with the message when workflow.yaml is invalid
  app.get(
    '/api/workflow-drafts/:id/save-plan',
    { schema: { params: IdParams, response: { 200: SavePlanView } } },
    (request) => drafts.savePlan(request.params.id),
  );

  // Retry preparation from the failed step; 409 when not failed
  app.post(
    '/api/workflow-drafts/:id/retry',
    { schema: { params: IdParams, response: { 200: DraftView } } },
    (request) => drafts.retry(request.params.id),
  );

  // Save (Contracts 17.4): create a variant or overwrite an existing one, without building; validation failures return the message and keep the draft
  app.post(
    '/api/workflow-drafts/:id/save',
    { schema: { params: IdParams, body: SaveDraftBody, response: { 200: DraftView } } },
    (request) => drafts.save(request.params.id, request.body),
  );

  // Hand to an agent for optimization (Contracts 19.3, 33.2): create the optimize draft in the analysis directory and its Live item; preparation runs in the background
  app.post(
    '/api/analyses/:id/optimize',
    {
      schema: {
        params: IdParams,
        body: OptimizeBody,
        response: { 201: z.object({ draft: DraftView, live: LiveDetail }) },
      },
    },
    (request, reply) => {
      const created = drafts.optimize(request.params.id, request.body);
      void reply.code(201);
      return created;
    },
  );

  // Variants selectable in the three start dialogs (Contracts 33.2): the successfully built workflow-design and workflow-optimize variants, baseline by default
  app.get(
    '/api/workflow-drafts/session-variants',
    { schema: { response: { 200: SessionVariantsView } } },
    () => drafts.sessionVariants(),
  );

  done();
};
