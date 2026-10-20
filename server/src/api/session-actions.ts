import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SessionActions } from '../deletion/sessions.js';
import { SessionActionBody, SessionActionPlan, sessionActions } from '../deletion/session-views.js';

// Contracts 25.3、25.5：Sessions 页面的删除、归档与恢复。action-plan 是确认对话框的内容；拒绝时 409，原文列出原因；
// Codex 的命令失败时 500，原文显示
export const sessionActionRoutes: FastifyPluginCallbackZod<{ actions: SessionActions }> = (
  app,
  { actions },
  done,
) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/api/sessions/action-plan',
    {
      schema: {
        querystring: z.object({
          action: z.enum(sessionActions),
          ids: z
            .string()
            .min(1)
            .transform((s) => s.split(',')),
        }),
        response: { 200: SessionActionPlan },
      },
    },
    (request) => actions.plan(request.query.action, request.query.ids),
  );
  // 同样的内容，ids 放在请求体中：选中全部时 id 很多，查询字符串会超过请求头的上限
  app.post(
    '/api/sessions/action-plan',
    {
      schema: {
        body: SessionActionBody.extend({ action: z.enum(sessionActions) }),
        response: { 200: SessionActionPlan },
      },
    },
    (request) => actions.plan(request.body.action, request.body.ids),
  );

  for (const action of sessionActions) {
    app.post(
      `/api/sessions/${action}`,
      { schema: { body: SessionActionBody, response: { 200: SessionActionPlan } } },
      (request) => actions.execute(action, request.body.ids),
    );
  }

  done();
};
