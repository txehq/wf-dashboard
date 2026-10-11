import createError from '@fastify/error';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { ensureImportedBundle } from '../tasks/linear-import.js';
import { getTaskRecord, listTaskRecords, saveTask } from '../tasks/loader.js';
import { draftRubric } from '../tasks/rubric-draft.js';
import { RubricDraft, RubricDraftRequest, TaskDefinition, TaskRecord } from '../tasks/schema.js';

const TaskNotFound = createError<[string]>('TASK_NOT_FOUND', '没有 task %s', 404);
const TaskExists = createError<[string]>('TASK_EXISTS', 'task %s 已存在', 409);
const BadTaskRequest = createError<[string]>('BAD_TASK_REQUEST', '%s', 400);

const IdParams = z.object({ id: z.string() });

export function taskRoutes({ db, tasksDir }: { db: Db; tasksDir: string }) {
  const requireTask = (id: string) => {
    const record = getTaskRecord(db, id);
    if (!record) throw new TaskNotFound(id);
    return record;
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
        // 从 Linear 导入的 task：先在 repo.commit 处生成起始仓库 bundle（Contracts 第 13 节）
        if (request.body.kind === 'ic') await ensureImportedBundle(request.body, tasksDir);
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
          throw new BadTaskRequest(`body 的 id ${request.body.id} 与路径 ${id} 不一致`);
        }
        if (requireTask(id).task.kind !== request.body.kind) {
          throw new BadTaskRequest(`task ${id} 的 kind 不能改变`);
        }
        if (request.body.kind === 'ic') await ensureImportedBundle(request.body, tasksDir);
        return saveTask(db, tasksDir, request.body);
      },
    );

    app.post(
      '/api/tasks/rubric-draft',
      { schema: { body: RubricDraftRequest, response: { 200: RubricDraft } } },
      (request) => draftRubric(request.body),
    );
    done();
  };
}
