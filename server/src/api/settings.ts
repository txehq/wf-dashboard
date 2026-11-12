import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { Settings, type SettingsStore } from '../runs/settings.js';

// Changes take effect at once: raising the concurrency starts queued runs immediately
export const settingsRoutes: FastifyPluginCallbackZod<{ settings: SettingsStore }> = (
  app,
  { settings },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/settings', { schema: { response: { 200: Settings } } }, () => settings.get());

  app.put('/api/settings', { schema: { body: Settings, response: { 200: Settings } } }, (request) =>
    settings.set(request.body),
  );

  done();
};
