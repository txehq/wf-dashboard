import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DirList, NewDir, NewDirBody } from '../dirs/views.js';
import type { Hosts } from '../remote/hosts.js';
import {
  AddHostBody,
  CheckHostBody,
  RenameHostBody,
  SshHostList,
  SshHostView,
} from '../remote/views.js';

const IdParams = z.object({ id: z.string().min(1) });

// SSH hosts (Contracts 31.1)
export const sshHostRoutes: FastifyPluginCallbackZod<{ hosts: Hosts }> = (app, { hosts }, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get('/api/ssh-hosts', { schema: { response: { 200: SshHostList } } }, () => hosts.list());

  app.post(
    '/api/ssh-hosts',
    { schema: { body: AddHostBody, response: { 201: SshHostView } } },
    async (request, reply) => {
      const added = await hosts.add(request.body.target);
      void reply.code(201);
      return added;
    },
  );

  app.patch(
    '/api/ssh-hosts/:id',
    { schema: { params: IdParams, body: RenameHostBody, response: { 200: SshHostView } } },
    (request) => hosts.rename(request.params.id, request.body.label),
  );

  app.post(
    '/api/ssh-hosts/:id/check',
    { schema: { params: IdParams, body: CheckHostBody, response: { 200: SshHostView } } },
    (request) => hosts.check(request.params.id, request.body.reuse === true),
  );

  app.delete(
    '/api/ssh-hosts/:id',
    { schema: { params: IdParams, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (request) => {
      await hosts.remove(request.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    '/api/ssh-hosts/:id/dirs',
    {
      schema: {
        params: IdParams,
        querystring: z.object({ path: z.string().default('') }),
        response: { 200: DirList },
      },
    },
    (request) => hosts.dirs(request.params.id, request.query.path),
  );

  // Create a folder (Contracts 34.1)
  app.post(
    '/api/ssh-hosts/:id/dirs',
    { schema: { params: IdParams, body: NewDirBody, response: { 201: NewDir } } },
    async (request, reply) => {
      const created = await hosts.mkdir(request.params.id, request.body.parent, request.body.name);
      void reply.code(201);
      return created;
    },
  );

  done();
};
