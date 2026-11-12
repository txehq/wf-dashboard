import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { configSourceDirs, isLocalSession } from '../ingest/session-config.js';
import { readReport, StageReport } from '../stages/report.js';

const Params = z.object({ id: z.string().min(1) });

export function registerStageRoutes(app: FastifyInstance, db: Db) {
  // Stages are split on import, so an imported session always has a result. Local machine configuration sessions show no stages (Contracts 25.4): 404 with the reason
  app.get('/api/sessions/:id/stages', async (request, reply) => {
    const { id } = Params.parse(request.params);
    const row = db
      .select({ engine: sessions.engine, filePath: sessions.filePath })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (row !== undefined && isLocalSession(configSourceDirs, row.engine, row.filePath))
      return reply.code(404).send({
        error: `Session ${id} belongs to the local machine configuration and has no stages`,
      });
    const report = readReport(db, id);
    if (report === null) return reply.code(404).send({ error: `Session ${id} not found` });
    return StageReport.parse(report);
  });
}
