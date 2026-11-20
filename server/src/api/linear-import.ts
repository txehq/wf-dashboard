import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ImportPreview, ImportPreviewRequest } from '../tasks/import-schema.js';
import { previewLinearImport } from '../tasks/linear-import.js';
import type { RequireChecks } from '../environment.js';
import type { SettingsStore } from '../runs/settings.js';

// Contracts section 13: the user pastes a ticket URL or identifier, imported as an ic task. The ticket and source repo are only read
export function linearImportRoutes({
  settings,
  requireChecks,
}: {
  settings: SettingsStore;
  requireChecks: RequireChecks;
}) {
  return (fastify: FastifyInstance, _options: unknown, done: () => void) => {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    // Preview only, nothing saved: saving goes through POST /api/tasks (a task with source gets its bundle on save).
    // The judge drafts the acceptance criteria, so its environment check comes first (Contracts 8)
    app.post(
      '/api/tasks/from-linear',
      { schema: { body: ImportPreviewRequest, response: { 200: ImportPreview } } },
      async (request) => {
        if (request.body.criteria) await requireChecks(['model-judge']);
        return previewLinearImport(request.body, settings.get().copyRunnerLabels);
      },
    );
    done();
  };
}
