import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { readReport, StageReport } from '../stages/report.js';

const Params = z.object({ id: z.string().min(1) });

export function registerStageRoutes(app: FastifyInstance, db: Db) {
  // 阶段在导入时划分，已导入的 session 总是有结果
  app.get('/api/sessions/:id/stages', async (request, reply) => {
    const { id } = Params.parse(request.params);
    const report = readReport(db, id);
    if (report === null) return reply.code(404).send({ error: `session ${id} 不存在` });
    return StageReport.parse(report);
  });
}
