import { z } from 'zod';

// Records and fields of a Codex rollout (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl) that import needs (Contracts 25.2,
// measured on codex-cli 0.162, Reports/W62); unlisted record types and fields are ignored

export const CodexLine = z.looseObject({
  timestamp: z.iso.datetime(),
  type: z.string(),
  payload: z.unknown(),
});

// First line: the session id and working directory
export const SessionMeta = z.looseObject({
  id: z.string().min(1),
  cwd: z.string(),
  timestamp: z.iso.datetime(),
});

// At the start of each turn: the turn's model
export const TurnContext = z.looseObject({ model: z.string() });

const InputText = z.looseObject({ type: z.string(), text: z.string().optional() });

// response_item: the model's replies, reasoning and tool calls, and the tool outputs. Role user messages carry 0.163.0's <skill> injection
export const ResponseItem = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('message'),
    id: z.string().optional(),
    role: z.string(),
    content: z.array(InputText),
  }),
  z.looseObject({
    type: z.literal('reasoning'),
    summary: z.array(z.looseObject({ text: z.string().optional() })).optional(),
    encrypted_content: z.string().nullable().optional(),
  }),
  // Model tool calls: custom_tool_call input is raw text (exec JS, apply_patch patch), function_call arguments are JSON
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
  // web_search_call, tool_search_call and other calls without an output record
  z.looseObject({
    type: z.enum(['web_search_call', 'tool_search_call', 'local_shell_call']),
    id: z.string().optional(),
    call_id: z.string().optional(),
  }),
]);
export type ResponseItem = z.infer<typeof ResponseItem>;

// End of one model request: its tokens
export const TokenUsageRecord = z.looseObject({
  response_id: z.string().min(1),
  usage: z.looseObject({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    cache_write_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    // Reasoning tokens in the output, included in output_tokens
    reasoning_output_tokens: z.number().optional(),
  }),
});

// event_msg item_completed: a finished item. UserMessage is user input; CommandExecution is a shell command run,
// and a load of a skill when parsed_cmd is read of a SKILL.md (Contracts 25.2).
// Other items (AgentMessage, Reasoning, SubAgentActivity, ImageView, ContextCompaction etc.) duplicate response_item or are not calls;
// only their type is read
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
