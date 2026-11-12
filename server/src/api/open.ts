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

// Targets of "Open in Finder" (Contracts 16.7, 18.2): only directories the dashboard knows, never arbitrary paths
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

// Working directory recorded for the session
function sessionCwd(db: Db, id: string): string {
  const row = db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, id)).get();
  if (row === undefined) throw new HttpError(404, `Session not found: ${id}`);
  if (row.cwd === null) throw new HttpError(404, `Session ${id} has no recorded working directory`);
  return row.cwd;
}

// Directory of the target; 404 with the message when it does not exist
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
    throw new HttpError(404, `Directory not found: ${dir}`);
  }
  return dir;
}

export const openRoutes: FastifyPluginCallbackZod<OpenDeps> = (app, deps, done) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // macOS open <dir>: opens it in Finder
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
