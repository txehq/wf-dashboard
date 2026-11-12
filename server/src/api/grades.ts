import createError from '@fastify/error';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';
import { readRunGrades } from '../grading/index.js';
import { RunGrades } from '../grading/schema.js';

const RunNotFound = createError<[string]>('RUN_NOT_FOUND', 'No run %s', 404);
const NotGraded = createError<[string]>('RUN_NOT_GRADED', 'Run %s is not graded yet', 404);

export function gradeRoutes({ db }: { db: Db }) {
  return (fastify: FastifyInstance, _options: unknown, done: () => void) => {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/runs/:id/grades',
      { schema: { params: z.object({ id: z.string() }), response: { 200: RunGrades } } },
      (request) => {
        const { id } = request.params;
        if (!db.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).get()) {
          throw new RunNotFound(id);
        }
        const grades = readRunGrades(db, id);
        if (grades === null) throw new NotGraded(id);
        return grades;
      },
    );
    done();
  };
}
