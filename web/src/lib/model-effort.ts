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

// The model and effort chosen for a new interaction or resume (Contracts 16.5): the settings' agentModel and
// agentEffort when nothing is chosen; null while settings are not loaded yet, and the caller cannot submit
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
