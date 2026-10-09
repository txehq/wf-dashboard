import { z } from 'zod';

// Claude Code jsonl 中 ingest 需要的记录字段；未列出的记录类型与字段一律忽略

const Usage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullable().exactOptional(),
  cache_creation_input_tokens: z.number().nullable().exactOptional(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().exactOptional(),
      ephemeral_1h_input_tokens: z.number().exactOptional(),
    })
    .nullable()
    .exactOptional(),
});

// 已知类型以外的 block 归为 other，字段不校验
function otherBlock(known: string[]) {
  return z
    .object({ type: z.string().refine((t) => !known.includes(t)) })
    .transform(() => ({ type: 'other' as const }));
}

const AssistantBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  otherBlock(['text', 'thinking', 'tool_use']),
]);

export const AssistantRecord = z.object({
  type: z.literal('assistant'),
  uuid: z.string(),
  timestamp: z.iso.datetime(),
  attributionSkill: z.string().optional(),
  message: z.object({
    id: z.string(),
    model: z.string(),
    content: z.array(AssistantBlock),
    usage: Usage,
  }),
});
export type AssistantRecord = z.infer<typeof AssistantRecord>;

const ToolResultPart = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  otherBlock(['text']),
]);

const UserBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(ToolResultPart)]).optional(),
    is_error: z.boolean().optional(),
  }),
  otherBlock(['text', 'tool_result']),
]);

export const UserRecord = z.object({
  type: z.literal('user'),
  uuid: z.string(),
  timestamp: z.iso.datetime(),
  isMeta: z.boolean().optional(),
  // 上下文压缩后由 Claude Code 生成的摘要，不是用户输入
  isCompactSummary: z.boolean().optional(),
  // 例如 human、task-notification、peer
  origin: z.object({ kind: z.string() }).nullish(),
  message: z.object({
    content: z.union([z.string(), z.array(UserBlock)]),
  }),
});
export type UserRecord = z.infer<typeof UserRecord>;

// 所有记录共有的字段：会话起止时间与 cwd 取自这里
export const AnyRecord = z.object({
  type: z.string(),
  timestamp: z.iso.datetime().optional(),
  cwd: z.string().optional(),
});

export const SubagentMeta = z.object({
  agentType: z.string(),
  description: z.string().optional(),
  toolUseId: z.string(),
});
