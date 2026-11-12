import { z } from 'zod';

// Record fields of the Claude Code jsonl that ingest needs; unlisted record types and fields are ignored

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

// Blocks of unknown types become other, with no field validation
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
  // isMeta record that loads a skill: points back to the tool_use for a Skill call; for a slash command parentUuid points to the command's user message
  sourceToolUseID: z.string().optional(),
  parentUuid: z.string().nullish(),
  // Summary Claude Code writes after context compaction; not user input
  isCompactSummary: z.boolean().optional(),
  // e.g. human, task-notification, peer
  origin: z.object({ kind: z.string() }).nullish(),
  message: z.object({
    content: z.union([z.string(), z.array(UserBlock)]),
  }),
});
export type UserRecord = z.infer<typeof UserRecord>;

// Fields shared by all records: the session's start/end time and cwd come from here
export const AnyRecord = z.object({
  type: z.string(),
  timestamp: z.iso.datetime().optional(),
  cwd: z.string().optional(),
});

export const SubagentMeta = z.object({
  agentType: z.string(),
  description: z.string().optional(),
  toolUseId: z.string(),
  isFork: z.boolean().optional(),
});
