import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { configSourceDirs, isLocalSession } from '../ingest/session-config.js';
import { readReport, StageReport } from '../stages/report.js';

const Params = z.object({ id: z.string().min(1) });

export function registerStageRoutes(app: FastifyInstance, db: Db) {
  // 阶段在导入时划分，已导入的 session 总是有结果。本机配置的 session 不显示阶段（Contracts 25.4），404 并说明
  app.get('/api/sessions/:id/stages', async (request, reply) => {
    const { id } = Params.parse(request.params);
    const row = db
      .select({ engine: sessions.engine, filePath: sessions.filePath })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (row !== undefined && isLocalSession(configSourceDirs, row.engine, row.filePath))
      return reply.code(404).send({ error: `session ${id} 属于本机配置，不划分阶段` });
    const report = readReport(db, id);
    if (report === null) return reply.code(404).send({ error: `session ${id} 不存在` });
    return StageReport.parse(report);
  });
}
