import createError from '@fastify/error';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, runs, tasks, variants } from '../db/schema.js';
import { compareRuns } from '../grading/compare.js';
import { CompareResult, CompareRun, RunArtifacts, SkillDiff } from '../grading/schema.js';
import type { Variants } from '../variants/index.js';

const NotFound = createError<[string, string]>('COMPARE_NOT_FOUND', '没有 %s：%s', 404);
const NotGraded = createError<[string]>('COMPARE_RUN_NOT_GRADED', 'run %s 尚未评分', 404);

// 逗号分隔的 id 列表，去重并保持顺序
const IdList = z
  .string()
  .transform((s) => [...new Set(s.split(',').map((x) => x.trim()))])
  .pipe(z.array(z.string().min(1)).min(1));

const Query = z.object({
  variants: IdList,
  tasks: IdList,
  includeIntervened: z.enum(['true', 'false']).default('false'),
  includeCrossRef: z.enum(['true', 'false']).default('false'),
});

export function compareRoutes({ db, variants: variantsModule }: { db: Db; variants: Variants }) {
  return (fastify: FastifyInstance, _options: unknown, done: () => void) => {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/compare',
      { schema: { querystring: Query, response: { 200: CompareResult } } },
      (request) => {
        const query = request.query;
        const knownVariants = new Set(
          db
            .select({ id: variants.id })
            .from(variants)
            .where(inArray(variants.id, query.variants))
            .all()
            .map((r) => r.id),
        );
        const missingVariants = query.variants.filter((id) => !knownVariants.has(id));
        if (missingVariants.length > 0) throw new NotFound('variant', missingVariants.join(', '));
        const knownTasks = new Set(
          db
            .select({ id: tasks.id })
            .from(tasks)
            .where(inArray(tasks.id, query.tasks))
            .all()
            .map((r) => r.id),
        );
        const missingTasks = query.tasks.filter((id) => !knownTasks.has(id));
        if (missingTasks.length > 0) throw new NotFound('task', missingTasks.join(', '));
        return compareRuns(db, {
          variants: query.variants,
          tasks: query.tasks,
          includeIntervened: query.includeIntervened === 'true',
          includeCrossRef: query.includeCrossRef === 'true',
        });
      },
    );

    // 全部已评分的 run，页面据此决定默认选择、空状态与产物并排的候选
    app.get('/api/compare/runs', { schema: { response: { 200: z.array(CompareRun) } } }, () =>
      db
        .select({
          id: runs.id,
          variantId: runs.variantId,
          taskId: runs.taskId,
          humanIntervened: runs.humanIntervened,
          crossRunRefs: runs.crossRunRefs,
          createdAt: runs.createdAt,
        })
        .from(runs)
        .where(eq(runs.status, 'succeeded'))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all()
        .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    );

    // 一个已评分 run 的产物快照与 PR，供产物并排
    app.get(
      '/api/compare/runs/:id/artifacts',
      { schema: { params: z.object({ id: z.string() }), response: { 200: RunArtifacts } } },
      (request) => {
        const { id } = request.params;
        const run = db
          .select({
            id: runs.id,
            status: runs.status,
            prUrl: runs.prUrl,
            githubRepo: runs.githubRepo,
          })
          .from(runs)
          .where(eq(runs.id, id))
          .get();
        if (run === undefined) throw new NotFound('run', id);
        if (run.status !== 'succeeded') throw new NotGraded(id);
        return {
          runId: run.id,
          prUrl: run.prUrl,
          githubRepo: run.githubRepo,
          artifacts: db
            .select({
              kind: artifacts.kind,
              location: artifacts.location,
              snapshot: artifacts.snapshot,
            })
            .from(artifacts)
            .where(eq(artifacts.runId, id))
            .orderBy(asc(artifacts.id))
            .all(),
        };
      },
    );

    // 两个 variant 之间 skills/ 的逐文件 diff
    app.get(
      '/api/compare/skill-diff',
      {
        schema: {
          querystring: z.object({ from: z.string().min(1), to: z.string().min(1) }),
          response: { 200: SkillDiff },
        },
      },
      (request) => {
        const { from, to } = request.query;
        return { from, to, files: variantsModule.diffBetween(from, to) };
      },
    );
    done();
  };
}
