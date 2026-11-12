import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { InstallView, RunningWorkView } from '../install/views.js';

// The installed version and its self-update (Contracts 39.4); a git checkout answers installed false. The app asks
// what is running before it quits (39.2a)
export const installRoutes: FastifyPluginCallbackZod<{
  view: () => InstallView;
  running: () => string[];
}> = (app, { view, running }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get('/api/install', { schema: { response: { 200: InstallView } } }, () => view());
  app.get('/api/install/running', { schema: { response: { 200: RunningWorkView } } }, () => ({
    running: running(),
  }));
  done();
};
