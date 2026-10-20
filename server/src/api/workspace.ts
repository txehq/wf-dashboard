import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  WorkspaceAgainst,
  WorkspaceDiffView,
  WorkspaceFileView,
  WorkspaceView,
} from '../drafts/views.js';
import type { Workspace } from '../drafts/workspace.js';

const IdParams = z.object({ id: z.string().min(1) });
const PathQuery = z.object({ path: z.string().min(1) });
// 对比的对象（28.4），不传为底子
const DiffQuery = PathQuery.extend({ against: WorkspaceAgainst.default('base') });

// Contracts 26.4：设计与优化会话的 workflow 面板，只读这一项工作目录中的 src/skills 与 workflow.yaml
export const workspaceRoutes: FastifyPluginCallbackZod<{ workspace: Workspace }> = (
  app,
  { workspace },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/live/:id/workspace',
    { schema: { params: IdParams, response: { 200: WorkspaceView } } },
    (request) => workspace.tree(request.params.id),
  );

  app.get(
    '/api/live/:id/workspace/file',
    { schema: { params: IdParams, querystring: PathQuery, response: { 200: WorkspaceFileView } } },
    (request) => workspace.file(request.params.id, request.query.path),
  );

  app.get(
    '/api/live/:id/workspace/diff',
    {
      schema: { params: IdParams, querystring: DiffQuery, response: { 200: WorkspaceDiffView } },
    },
    (request) => workspace.diff(request.params.id, request.query.path, request.query.against),
  );

  // 文件变化在 1 秒内推送；项被关闭或删除时发 closed 后结束。没有草稿的项在 SSE 开始前 404
  app.get(
    '/api/live/:id/workspace/events',
    { sse: 'only', schema: { params: IdParams } },
    async (request, reply) => {
      const release = workspace.watch(request.params.id, {
        send: (event) => {
          void reply.sse.send({ event: event.type, data: event });
        },
        end: () => {
          reply.sse.close();
        },
      });
      reply.sse.keepAlive();
      reply.sse.onClose(release);
      await reply.sse.send({ event: 'ready', data: {} });
    },
  );

  done();
};
