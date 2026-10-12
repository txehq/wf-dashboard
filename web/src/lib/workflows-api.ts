import { queryOptions } from '@tanstack/react-query';
import {
  type BigStageDefinition,
  WorkflowDefinition,
  WorkflowView,
} from '@wf-dashboard/server/workflows/schema';
import { z } from 'zod';
import { requestJson } from '@/lib/http';

async function fetchWorkflows() {
  return z
    .array(WorkflowView)
    .parse(await requestJson('GET', '/api/workflows'))
    .map((w) => ({ ...w, definition: WorkflowDefinition.parse(w.definition) }));
}

export type WorkflowRecord = Awaited<ReturnType<typeof fetchWorkflows>>[number];

// Contracts 16.1：workflow 的列表；定义按 WorkflowDefinition 解析
export const workflowsQuery = queryOptions({ queryKey: ['workflows'], queryFn: fetchWorkflows });

// task 所在的大阶段；workflow 列表还没有读到时为 null
export function bigStageIn(
  workflows: WorkflowRecord[] | undefined,
  workflowId: string,
  bigStage: string,
): BigStageDefinition | null {
  const workflow = workflows?.find((w) => w.id === workflowId);
  return workflow?.definition.bigStages.find((s) => s.id === bigStage) ?? null;
}
