import { z } from 'zod';
import { claudeSettingsEnv } from '../llm/client.js';
import { type ModelAlias, modelAliases } from './model-names.js';

export { type Effort, efforts, type ModelAlias, modelAliases } from './model-names.js';

const envKey: Record<ModelAlias, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

// claude's --model accepts aliases, resolved to gateway model names by ANTHROPIC_DEFAULT_*_MODEL in settings.json env
export function modelChoices(): { alias: ModelAlias; model: string }[] {
  const env = claudeSettingsEnv();
  return modelAliases.map((alias) => ({ alias, model: z.string().parse(env[envKey[alias]]) }));
}
