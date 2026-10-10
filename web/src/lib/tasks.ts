import { queryOptions } from '@tanstack/react-query';
import {
  RubricDraft,
  type RubricDraftRequest,
  type TaskDefinition,
  TaskRecord,
} from '@wf-dashboard/server/tasks/schema';
import { z } from 'zod';
import { requestJson as request } from '@/lib/http';

export const tasksQuery = queryOptions({
  queryKey: ['tasks'],
  queryFn: async () => z.array(TaskRecord).parse(await request('GET', '/api/tasks')),
});

export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: ['tasks', id],
    queryFn: async () => TaskRecord.parse(await request('GET', `/api/tasks/${id}`)),
  });

export async function saveTask(task: TaskDefinition) {
  return TaskRecord.parse(await request('PUT', `/api/tasks/${task.id}`, task));
}

export async function createTask(task: TaskDefinition) {
  return TaskRecord.parse(await request('POST', '/api/tasks', task));
}

export async function draftRubric(form: RubricDraftRequest) {
  return RubricDraft.parse(await request('POST', '/api/tasks/rubric-draft', form));
}
