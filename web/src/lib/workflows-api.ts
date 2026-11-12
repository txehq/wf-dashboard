import { queryOptions } from '@tanstack/react-query';
import {
  type EvalKind,
  evalKinds,
  type NewWorkflowBody,
  type UpdateWorkflowBody,
  WorkflowView,
} from '@wf-dashboard/server/workflows/schema';
import { z } from 'zod';
import { requestJson } from '@/lib/http';
import { isBuilt, type Variant } from '@/pages/variants-api';

export type WorkflowRecord = WorkflowView;

async function fetchWorkflows(): Promise<WorkflowRecord[]> {
  return z.array(WorkflowView).parse(await requestJson('GET', '/api/workflows'));
}

// Contracts 16.1: the workflow list (built-in lfg and ic first)
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

// The workflow's eval kind; null before the list has loaded or when the workflow has no eval kind
export function evalKindOf(
  workflows: WorkflowRecord[] | undefined,
  workflowId: string,
): EvalKind | null {
  return workflows?.find((w) => w.id === workflowId)?.evalKind ?? null;
}

export const evalKindLabel = (kind: EvalKind | null) => kind ?? 'Not evaluated';

// The default variant of lfg and ic (Contracts 29.1): the variant auto-imported from the latest release, when built; otherwise null
export function latestReleaseVariant<V extends Variant>(
  workflows: WorkflowRecord[] | undefined,
  variants: V[] | undefined,
  workflowId: string,
): V | null {
  const id = workflows?.find((w) => w.id === workflowId)?.release?.variantId ?? null;
  const variant = variants?.find((v) => v.id === id);
  return variant !== undefined && isBuilt(variant) ? variant : null;
}

// Variants checked by default for a new batch (Contracts 29.1): the latest-release variants of lfg and ic; with tasks
// selected, only those of the same eval kind, so the batch can start
export function defaultBatchVariants(
  workflows: WorkflowRecord[] | undefined,
  variants: Variant[] | undefined,
  taskKinds: EvalKind[],
): string[] {
  return evalKinds
    .filter((kind) => taskKinds.length === 0 || taskKinds.includes(kind))
    .flatMap((kind) => latestReleaseVariant(workflows, variants, kind)?.id ?? []);
}

// The variant a new Live interaction uses while its config is unchanged (Contracts 29.1, 29.2): the default entry command
// is lfg, so the latest-release lfg variant; if it is not built, the first built lfg variant, then any built variant;
// null (local config) when there is none. built holds the built variants
export function defaultLiveVariant<V extends Variant>(
  workflows: WorkflowRecord[] | undefined,
  built: V[],
): V | null {
  return (
    latestReleaseVariant(workflows, built, 'lfg') ??
    built.find((v) => v.workflowId === 'lfg') ??
    built[0] ??
    null
  );
}
