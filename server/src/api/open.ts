import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import {
  type FastifyPluginCallbackZod,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { Live } from '../live/index.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';

// "在访达中打开"的目标（Contracts 16.7、18.2）：只接受 dashboard 已知的目录，不接受任意路径
export const OpenTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('variant'), id: z.string().min(1) }),
  z.object({ kind: z.literal('live-cwd'), id: z.string().min(1) }),
  z.object({ kind: z.literal('live-config'), id: z.string().min(1) }),
  z.object({ kind: z.literal('session-cwd'), id: z.string().min(1) }),
]);
export type OpenTarget = z.infer<typeof OpenTarget>;

export interface OpenDeps {
  db: Db;
  variants: Variants;
  live: Live;
}

// session 记录的工作目录
function sessionCwd(db: Db, id: string): string {
  const row = db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, id)).get();
  if (row === undefined) throw new HttpError(404, `session 不存在：${id}`);
  if (row.cwd === null) throw new HttpError(404, `session ${id} 没有记录工作目录`);
  return row.cwd;
}

// 目标对应的目录；目录不存在时 404 原文
export function openTargetDir(target: OpenTarget, deps: OpenDeps): string {
  const dir =
    target.kind === 'variant'
      ? deps.variants.layout(target.id).dir
      : target.kind === 'live-cwd'
        ? deps.live.dirs(target.id).cwd
        : target.kind === 'live-config'
          ? deps.live.dirs(target.id).configDir
          : sessionCwd(deps.db, target.id);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new HttpError(404, `目录不存在：${dir}`);
  }
  return dir;
}

export const openRoutes: FastifyPluginCallbackZod<OpenDeps> = (app, deps, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // macOS 的 open <目录>：在访达中打开
  app.post(
    '/api/open',
    {
      schema: {
        body: z.object({ target: OpenTarget }),
        response: { 200: z.object({ dir: z.string() }) },
      },
    },
    async (request) => {
      const dir = openTargetDir(request.body.target, deps);
      await execa('open', [dir]);
      return { dir };
    },
  );

  done();
};
