import createError from '@fastify/error';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { RequireChecks } from '../environment.js';
import { ensureImportedBundle } from '../tasks/linear-import.js';
import { getTaskRecord, listTaskRecords, saveTask } from '../tasks/loader.js';
import { draftRubric } from '../tasks/rubric-draft.js';
import {
  RubricDraft,
  RubricDraftRequest,
  TaskDefinition,
  taskFieldIssues,
  TaskRecord,
} from '../tasks/schema.js';

const TaskNotFound = createError<[string]>('TASK_NOT_FOUND', 'No task %s', 404);
const TaskExists = createError<[string]>('TASK_EXISTS', 'Task %s already exists', 409);
const BadTaskRequest = createError<[string]>('BAD_TASK_REQUEST', '%s', 400);

const IdParams = z.object({ id: z.string() });

export function taskRoutes({
  db,
  tasksDir,
  requireChecks,
}: {
  db: Db;
  tasksDir: string;
  requireChecks: RequireChecks;
}) {
  const requireTask = (id: string) => {
    const record = getTaskRecord(db, id);
    if (!record) throw new TaskNotFound(id);
    return record;
  };
  const checkTaskRequest = (definition: TaskDefinition) => {
    const issues = taskFieldIssues(definition);
    if (issues.length > 0) throw new BadTaskRequest(issues.join('; '));
  };

  return (fastify: FastifyInstance, _options: unknown, done: () => void) => {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get('/api/tasks', { schema: { response: { 200: z.array(TaskRecord) } } }, () =>
      listTaskRecords(db),
    );

    app.get(
      '/api/tasks/:id',
      { schema: { params: IdParams, response: { 200: TaskRecord } } },
      (request) => requireTask(request.params.id),
    );

    app.post(
      '/api/tasks',
      { schema: { body: TaskDefinition, response: { 201: TaskRecord } } },
      async (request, reply) => {
        if (getTaskRecord(db, request.body.id)) throw new TaskExists(request.body.id);
        // Fields are validated by the blocks of the task kind (Contracts 16.3), 400 with the message otherwise
        checkTaskRequest(request.body);
        // Task imported from Linear: first build the starting repo bundle at repo.commit (Contracts section 13)
        await ensureImportedBundle(request.body, tasksDir);
        void reply.code(201);
        return saveTask(db, tasksDir, request.body);
      },
    );

    app.put(
      '/api/tasks/:id',
      { schema: { params: IdParams, body: TaskDefinition, response: { 200: TaskRecord } } },
      async (request) => {
        const { id } = request.params;
        if (request.body.id !== id) {
          throw new BadTaskRequest(`Body id ${request.body.id} does not match path ${id}`);
        }
        const existing = requireTask(id).task;
        if (existing.kind !== request.body.kind) {
          throw new BadTaskRequest(`The kind of task ${id} cannot change`);
        }
        checkTaskRequest(request.body);
        await ensureImportedBundle(request.body, tasksDir);
        return saveTask(db, tasksDir, request.body);
      },
    );

    // The judge drafts the rubric, so its environment check comes first (Contracts 8)
    app.post(
      '/api/tasks/rubric-draft',
      { schema: { body: RubricDraftRequest, response: { 200: RubricDraft } } },
      async (request) => {
        await requireChecks(['model-judge']);
        return draftRubric(request.body);
      },
    );
    done();
  };
}
