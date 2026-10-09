import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';
import { costUsd, fromApiUsage, type TokenUsage } from './pricing.js';

// 本机 Claude Code 经 gateway 认证，地址、凭据与模型别名都在 settings.json 的 env 中（config.claudeSettingsPath）
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

export function claudeSettingsEnv(
  file: string = config.claudeSettingsPath,
): z.infer<typeof Settings>['env'] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Settings.parse(raw).env;
}

const env = claudeSettingsEnv();

// 别名中的 [1m] 是 Claude Code 的上下文标记，Messages API 不接受
const stripContextTag = (model: string) => model.replace(/\[[^\]]*\]$/, '');

export interface Models {
  simulatedUser: string;
  judge: string;
  stageCheck: string;
}

// 默认值：模拟用户与 judge 取 settings env 中 sonnet / opus 的别名；
// 阶段判定取环境变量 WFD_STAGE_CHECK_MODEL，未设置时取 haiku 别名。数据库中的设置优先于这些默认值
export function defaultModels(): Models {
  const current = claudeSettingsEnv();
  return {
    simulatedUser: stripContextTag(current.ANTHROPIC_DEFAULT_SONNET_MODEL),
    judge: stripContextTag(current.ANTHROPIC_DEFAULT_OPUS_MODEL),
    stageCheck: stripContextTag(
      process.env.WFD_STAGE_CHECK_MODEL ?? current.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ),
  };
}

// 当前生效的模型；调用处在调用时读取，PUT /api/settings 经 setModels 立即改写
export const models: Models = defaultModels();

export function setModels(next: Models) {
  Object.assign(models, next);
}

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  client ??= new Anthropic({
    baseURL: env.ANTHROPIC_BASE_URL,
    authToken: env.ANTHROPIC_AUTH_TOKEN,
    apiKey: null,
  });
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
    throw new Error(
      `结构化输出解析失败（stop_reason=${String(response.stop_reason)}）：${JSON.stringify(response.content)}`,
    );
  }
  const usage = fromApiUsage(response.usage);
  return {
    value: response.parsed_output,
    usage,
    costUsd: costUsd(usage, args.model),
    model: args.model,
  };
}
