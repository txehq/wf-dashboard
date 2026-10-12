import { queryOptions } from '@tanstack/react-query';
import {
  type EvalKind,
  type NewWorkflowBody,
  type UpdateWorkflowBody,
  WorkflowView,
} from '@wf-dashboard/server/workflows/schema';
import { z } from 'zod';
import { requestJson } from '@/lib/http';

export type WorkflowRecord = WorkflowView;

async function fetchWorkflows(): Promise<WorkflowRecord[]> {
  return z.array(WorkflowView).parse(await requestJson('GET', '/api/workflows'));
}

// Contracts 16.1：workflow 的列表（内置的 lfg、ic 在前）
export const workflowsQuery = queryOptions({ queryKey: ['workflows'], queryFn: fetchWorkflows });

export const workflowQuery = (id: string) =>
  queryOptions({
    queryKey: ['workflows', id],
    queryFn: async () => WorkflowView.parse(await requestJson('GET', `/api/workflows/${id}`)),
  });

export async function createWorkflow(body: NewWorkflowBody): Promise<WorkflowRecord> {
  return WorkflowView.parse(await requestJson('POST', '/api/workflows', body));
}

export async function updateWorkflow(
  id: string,
  body: UpdateWorkflowBody,
): Promise<WorkflowRecord> {
  return WorkflowView.parse(await requestJson('PUT', `/api/workflows/${id}`, body));
}

// workflow 的评测类型；列表还没有读到或 workflow 没有评测类型时为 null
export function evalKindOf(
  workflows: WorkflowRecord[] | undefined,
  workflowId: string,
): EvalKind | null {
  return workflows?.find((w) => w.id === workflowId)?.evalKind ?? null;
}

export const evalKindLabel = (kind: EvalKind | null) => kind ?? '无（不评测）';
