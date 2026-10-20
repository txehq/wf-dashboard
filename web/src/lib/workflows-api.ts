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

// lfg、ic 默认选的 variant（Contracts 29.1）：最新版自动导入的 variant，构建成功时；否则为 null
export function latestReleaseVariant<V extends Variant>(
  workflows: WorkflowRecord[] | undefined,
  variants: V[] | undefined,
  workflowId: string,
): V | null {
  const id = workflows?.find((w) => w.id === workflowId)?.release?.variantId ?? null;
  const variant = variants?.find((v) => v.id === id);
  return variant !== undefined && isBuilt(variant) ? variant : null;
}

// 发起 batch 时默认勾选的 variant（Contracts 29.1）：lfg、ic 最新版的 variant；选了 task 后只取与它们评测类型
// 相同的，batch 才能发起
export function defaultBatchVariants(
  workflows: WorkflowRecord[] | undefined,
  variants: Variant[] | undefined,
  taskKinds: EvalKind[],
): string[] {
  return evalKinds
    .filter((kind) => taskKinds.length === 0 || taskKinds.includes(kind))
    .flatMap((kind) => latestReleaseVariant(workflows, variants, kind)?.id ?? []);
}

// Live 的新建交互在配置还没有改过时用的 variant（Contracts 29.1、29.2）：默认的入口命令是 lfg，用 lfg 最新版的
// variant；它还没有构建成功时为 lfg 的第一个构建成功的 variant，再没有时为任何构建成功的 variant；都没有时为 null
// （本机配置）。built 是构建成功的 variant
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
