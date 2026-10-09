import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { analyzeSession, readReport, StageReport } from '../stages/report.js';

const Params = z.object({ id: z.string().min(1) });

export function registerStageRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/sessions/:id/analyze', async (request, reply) => {
    const { id } = Params.parse(request.params);
    if (!db.select().from(sessions).where(eq(sessions.id, id)).get()) {
      return reply.code(404).send({ error: `session ${id} 不存在` });
    }
    return StageReport.parse(await analyzeSession(db, id));
  });

  app.get('/api/sessions/:id/stages', async (request, reply) => {
    const { id } = Params.parse(request.params);
    const report = readReport(db, id);
    if (!report) return reply.code(404).send({ error: `session ${id} 尚未判定` });
    return StageReport.parse(report);
  });
}
