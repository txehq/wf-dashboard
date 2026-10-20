import { useQuery } from '@tanstack/react-query';
import {
  type Effort,
  efforts,
  type ModelAlias,
  modelAliases,
} from '@wf-dashboard/server/variants/model-names';
import { z } from 'zod';
import { settingsQuery } from '@/lib/runs-api';

export interface ModelEffort {
  model: ModelAlias;
  effort: Effort;
}

// 新建交互与 resume 时选的模型与 effort（Contracts 16.5）：没有选时取设置的 agentModel 与 agentEffort；
// 设置还没有读到时为 null，调用方不能提交
export function useModelEffort(choice: {
  model: string | null;
  effort: string | null;
}): ModelEffort | null {
  const settings = useQuery(settingsQuery);
  const model = choice.model ?? settings.data?.agentModel ?? null;
  const effort = choice.effort ?? settings.data?.agentEffort ?? null;
  return model === null || effort === null
    ? null
    : { model: z.enum(modelAliases).parse(model), effort: z.enum(efforts).parse(effort) };
}
