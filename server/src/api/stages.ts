import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { models } from '../llm/client.js';
import {
  AnalysisProgress,
  AnalysisState,
  analysisState,
  readReport,
  StageReport,
  startAnalysis,
} from '../stages/report.js';

const Params = z.object({ id: z.string().min(1) });

const AnalyzeResponse = z.union([
  StageReport,
  z.object({ status: z.literal('running'), progress: AnalysisProgress.nullable() }),
]);

export function registerStageRoutes(app: FastifyInstance, db: Db) {
  const exists = (id: string) => db.select().from(sessions).where(eq(sessions.id, id)).get();

  // 已判定过返回 StageReport；否则在后台判定，立即返回当前进度（Contracts 第 9 节）
  app.post('/api/sessions/:id/analyze', async (request, reply) => {
    const { id } = Params.parse(request.params);
    if (!exists(id)) return reply.code(404).send({ error: `session ${id} 不存在` });
    return AnalyzeResponse.parse(startAnalysis(db, id, models.stageCheck));
  });

  app.get('/api/sessions/:id/analysis', async (request, reply) => {
    const { id } = Params.parse(request.params);
    if (!exists(id)) return reply.code(404).send({ error: `session ${id} 不存在` });
    return AnalysisState.parse(analysisState(db, id));
  });

  app.get('/api/sessions/:id/stages', async (request, reply) => {
    const { id } = Params.parse(request.params);
    const report = readReport(db, id);
    if (!report) return reply.code(404).send({ error: `session ${id} 尚未判定` });
    return StageReport.parse(report);
  });
}
