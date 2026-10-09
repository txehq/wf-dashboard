import createError from '@fastify/error';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { tasks, variants } from '../db/schema.js';
import { compareRuns } from '../grading/compare.js';
import { CompareResult } from '../grading/schema.js';

const NotFound = createError<[string, string]>('COMPARE_NOT_FOUND', '没有 %s：%s', 404);

// 逗号分隔的 id 列表，去重并保持顺序
const IdList = z
  .string()
  .transform((s) => [...new Set(s.split(',').map((x) => x.trim()))])
  .pipe(z.array(z.string().min(1)).min(1));

const Query = z.object({
  variants: IdList,
  tasks: IdList,
  includeIntervened: z.enum(['true', 'false']).default('false'),
});

export function compareRoutes({ db }: { db: Db }) {
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
        });
      },
    );
    done();
  };
}
