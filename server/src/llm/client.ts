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

// 结构化输出（Contracts 4）：一个 strict tool respond，tool_choice 为 auto，system prompt 末尾要求必须调用它；
// 从 tool_use.input 读出结构。gateway 上 output_config 的约束解码经常返回空字符串或占位词
const OUTPUT_TOOL = 'respond';
const OUTPUT_RULE = `\n\n## 提交结果\n最终结果必须通过调用 ${OUTPUT_TOOL} tool 提交，结果的全部内容都写在它的参数里；不要只用文字回答。`;

export async function parseStructured<T>(args: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}): Promise<StructuredResult<T>> {
  const response = await anthropic().messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: `${args.system}${OUTPUT_RULE}`,
    messages: [{ role: 'user', content: args.user }],
    tools: [
      {
        name: OUTPUT_TOOL,
        description: '提交最终结果。',
        // zodOutputFormat 由 z.toJSONSchema 生成并转成 strict 支持的子集（整数范围、字符串长度等移入 description），
        // 这些约束由下面的 schema.parse 校验
        input_schema: ToolInputSchema.parse(zodOutputFormat(args.schema).schema),
        strict: true,
      },
    ],
    tool_choice: { type: 'auto' },
  });
  const call = response.content.find((block) => block.type === 'tool_use');
  if (call?.type !== 'tool_use') {
    throw new Error(
      `结构化输出没有调用 ${OUTPUT_TOOL}（stop_reason=${String(response.stop_reason)}）：${JSON.stringify(response.content)}`,
    );
  }
  const usage = fromApiUsage(response.usage);
  return {
    value: args.schema.parse(call.input),
    usage,
    costUsd: costUsd(usage, args.model),
    model: args.model,
  };
}

const ToolInputSchema = z.looseObject({ type: z.literal('object') });
