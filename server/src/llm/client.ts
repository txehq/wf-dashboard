import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { costUsd, fromApiUsage, type TokenUsage } from './pricing.js';

// 本机 Claude Code 经 gateway 认证，地址、凭据与模型别名都在 ~/.claude/settings.json 的 env 中
const Settings = z.object({
  env: z
    .object({
      ANTHROPIC_BASE_URL: z.string(),
      ANTHROPIC_AUTH_TOKEN: z.string(),
      ANTHROPIC_DEFAULT_OPUS_MODEL: z.string(),
      ANTHROPIC_DEFAULT_SONNET_MODEL: z.string(),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: z.string(),
    })
    .loose(),
});

export function claudeSettingsEnv(): z.infer<typeof Settings>['env'] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
  return Settings.parse(raw).env;
}

const env = claudeSettingsEnv();

// 别名中的 [1m] 是 Claude Code 的上下文标记，Messages API 不接受
const stripContextTag = (model: string) => model.replace(/\[[^\]]*\]$/, '');

export const models = {
  simulatedUser: stripContextTag(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
  judge: stripContextTag(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
  stageCheck: stripContextTag(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
} as const;

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  client ??= new Anthropic({ baseURL: env.ANTHROPIC_BASE_URL, authToken: env.ANTHROPIC_AUTH_TOKEN, apiKey: null });
  return client;
}

export interface StructuredResult<T> {
  value: T;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}

export async function parseStructured<T>(args: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}): Promise<StructuredResult<T>> {
  const response = await anthropic().messages.parse({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
    output_config: { format: zodOutputFormat(args.schema) },
  });
  if (response.parsed_output === null) {
    throw new Error(`结构化输出解析失败（stop_reason=${String(response.stop_reason)}）：${JSON.stringify(response.content)}`);
  }
  const usage = fromApiUsage(response.usage);
  return { value: response.parsed_output, usage, costUsd: costUsd(usage, args.model), model: args.model };
}
