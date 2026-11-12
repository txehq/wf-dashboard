import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { InstallView } from '../install/views.js';

// The installed version and its self-update (Contracts 39.4); a git checkout answers installed false
export const installRoutes: FastifyPluginCallbackZod<{ view: () => InstallView }> = (
  app,
  { view },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get('/api/install', { schema: { response: { 200: InstallView } } }, () => view());
  done();
};
