import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
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
export const stripContextTag = (model: string) => model.replace(/\[[^\]]*\]$/, '');

export interface Models {
  simulatedUser: string;
  judge: string;
}

// 默认值：模拟用户与 judge 都取 settings env 中 opus 的别名（sonnet 对 done 的判断不可靠，见 Reports/W21）。
// 数据库中的设置优先于这些默认值
export function defaultModels(): Models {
  const current = claudeSettingsEnv();
  return {
    simulatedUser: stripContextTag(current.ANTHROPIC_DEFAULT_OPUS_MODEL),
    judge: stripContextTag(current.ANTHROPIC_DEFAULT_OPUS_MODEL),
  };
}

// 当前生效的模型；调用处在调用时读取，PUT /api/settings 经 setModels 立即改写
export const models: Models = defaultModels();

export function setModels(next: Models) {
  Object.assign(models, next);
}

let client: Anthropic | undefined;

export function gatewayClient(baseURL: string, authToken: string): Anthropic {
  return new Anthropic({
    baseURL,
    authToken,
    apiKey: null,
    // 不自动重试：gateway 的 429 / 5xx / 连接错误直接交给调用方
    maxRetries: 0,
    // 挂起的请求在 10 分钟后以超时错误失败（Contracts 4）：确定一张长工单的验收标准实测要 84–132 秒
    timeout: 600_000,
  });
}

export function anthropic(): Anthropic {
  client ??= gatewayClient(env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN);
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
const ToolInputSchema = z.looseObject({ type: z.literal('object') });

export interface StructuredRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

// 结构化输出的请求：parseStructured 与环境检查共用，环境检查发的就是真实判定、评分与模拟用户的同一种请求
// （gateway 把模型路由到不接受 strict tool 的渠道时，环境检查同样失败）
export function structuredRequest<T>(args: StructuredRequest<T>): MessageCreateParamsNonStreaming {
  return {
    model: args.model,
    max_tokens: args.maxTokens,
    system: `${args.system}${OUTPUT_RULE}`,
    messages: [{ role: 'user', content: args.user }],
    tools: [
      {
        name: OUTPUT_TOOL,
        description: '提交最终结果。',
        // zodOutputFormat 由 z.toJSONSchema 生成并转成 strict 支持的子集（整数范围、字符串长度等移入 description），
        // 这些约束由 parseStructuredResponse 中的 schema.parse 校验
        input_schema: ToolInputSchema.parse(zodOutputFormat(args.schema).schema),
        strict: true,
      },
    ],
    tool_choice: { type: 'auto' },
  };
}

// 从响应的 respond 调用读出结构；被上游拒绝、没有调用或不符合 schema 时抛错
export function parseStructuredResponse<T>(
  response: Message,
  schema: z.ZodType<T>,
  model: string,
): StructuredResult<T> {
  // 拒绝分类器可能在 respond 调用开始后拦下，那时 tool_use 的 input 为空（Reports/W31b）：先看 stop_reason
  if (response.stop_reason === 'refusal') {
    const details = response.stop_details;
    throw new Error(
      `结构化输出被上游拒绝（stop_reason=refusal）：category=${String(details?.category ?? null)}，explanation=${String(details?.explanation ?? null)}`,
    );
  }
  const call = response.content.find((block) => block.type === 'tool_use');
  if (call?.type !== 'tool_use') {
    throw new Error(
      `结构化输出没有调用 ${OUTPUT_TOOL}（stop_reason=${String(response.stop_reason)}）：${JSON.stringify(response.content)}`,
    );
  }
  const usage = fromApiUsage(response.usage);
  return { value: schema.parse(call.input), usage, costUsd: costUsd(usage, model), model };
}

export async function parseStructured<T>(
  args: StructuredRequest<T> & {
    // 取消评分时中止进行中的请求
    signal?: AbortSignal;
  },
): Promise<StructuredResult<T>> {
  const response = await anthropic().messages.create(
    structuredRequest(args),
    args.signal === undefined ? {} : { signal: args.signal },
  );
  return parseStructuredResponse(response, args.schema, args.model);
}
