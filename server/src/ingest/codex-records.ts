import { z } from 'zod';

// Codex rollout（<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl）中导入需要的记录与字段（Contracts 25.2，
// codex-cli 0.162 实测，Reports/W62）；未列出的记录类型与字段一律忽略

export const CodexLine = z.looseObject({
  timestamp: z.iso.datetime(),
  type: z.string(),
  payload: z.unknown(),
});

// 第一行：会话的 id、工作目录
export const SessionMeta = z.looseObject({
  id: z.string().min(1),
  cwd: z.string(),
  timestamp: z.iso.datetime(),
});

// 每一轮开始时：这一轮的模型
export const TurnContext = z.looseObject({ model: z.string() });

const InputText = z.looseObject({ type: z.string(), text: z.string().optional() });

// response_item：模型的回复、推理与工具调用，以及工具的输出
export const ResponseItem = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('message'),
    role: z.string(),
    content: z.array(InputText),
  }),
  z.looseObject({
    type: z.literal('reasoning'),
    summary: z.array(z.looseObject({ text: z.string().optional() })).optional(),
    encrypted_content: z.string().nullable().optional(),
  }),
  // 模型的工具调用：custom_tool_call 的 input 是原文（exec 的 JS、apply_patch 的补丁），function_call 的 arguments 是 JSON
  z.looseObject({
    type: z.literal('custom_tool_call'),
    call_id: z.string(),
    name: z.string(),
    input: z.string(),
  }),
  z.looseObject({
    type: z.literal('function_call'),
    call_id: z.string(),
    name: z.string(),
    namespace: z.string().optional(),
    arguments: z.string(),
  }),
  z.looseObject({
    type: z.enum(['custom_tool_call_output', 'function_call_output']),
    call_id: z.string(),
    output: z.union([z.string(), z.array(InputText)]),
  }),
  // web_search_call、tool_search_call 等没有输出记录的调用
  z.looseObject({
    type: z.enum(['web_search_call', 'tool_search_call', 'local_shell_call']),
    id: z.string().optional(),
    call_id: z.string().optional(),
  }),
]);
export type ResponseItem = z.infer<typeof ResponseItem>;

// 一次模型请求结束：这次请求的 token
export const TokenUsageRecord = z.looseObject({
  response_id: z.string().min(1),
  usage: z.looseObject({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    cache_write_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    // 输出中推理的 token，包含在 output_tokens 中
    reasoning_output_tokens: z.number().optional(),
  }),
});

// event_msg 的 item_completed：执行完的项。UserMessage 是用户的输入；CommandExecution 是执行的 shell 命令，
// parsed_cmd 为 read 且读的是 SKILL.md 时是加载 skill（Contracts 25.2）。
// 其余的项（AgentMessage、Reasoning、SubAgentActivity、ImageView、ContextCompaction 等）与 response_item 重复或不是调用，
// 只读 type，不解析
export const ItemCompleted = z.looseObject({
  type: z.literal('item_completed'),
  item: z.looseObject({ type: z.string() }),
});

export const knownItemTypes = [
  'UserMessage',
  'CommandExecution',
  'McpToolCall',
  'FileChange',
  'WebSearch',
] as const;

export const CompletedItem = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('UserMessage'),
    id: z.string(),
    content: z.array(InputText),
  }),
  z.looseObject({
    type: z.literal('CommandExecution'),
    id: z.string(),
    command: z.array(z.string()),
    cwd: z.string(),
    aggregated_output: z.string().nullable().optional(),
    exit_code: z.number().nullable().optional(),
  }),
  z.looseObject({
    type: z.literal('McpToolCall'),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    arguments: z.unknown().optional(),
    status: z.string().optional(),
    result: z.unknown().optional(),
  }),
  z.looseObject({
    type: z.literal('FileChange'),
    id: z.string(),
    status: z.string().optional(),
    stdout: z.string().optional(),
  }),
  z.looseObject({ type: z.literal('WebSearch'), id: z.string(), query: z.string().optional() }),
]);
export type CompletedItem = z.infer<typeof CompletedItem>;
