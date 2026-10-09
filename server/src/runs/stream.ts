import { z } from 'zod';

// claude -p --output-format stream-json 的 stdout 事件；只声明 Runner 读取的字段，其余原样保留

export const AskQuestionSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
});

export const AskUserQuestionInput = z.looseObject({ questions: z.array(AskQuestionSchema).min(1) });

const ContentBlock = z.looseObject({ type: z.string() });

export const SystemEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.string(),
  tasks: z.array(z.unknown()).optional(),
});

export const AssistantEvent = z.looseObject({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable(),
  message: z.looseObject({ id: z.string(), content: z.array(ContentBlock) }),
});

export const UserEvent = z.looseObject({
  type: z.literal('user'),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const ResultEvent = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  total_cost_usd: z.number(),
  terminal_reason: z.string().optional(),
});

export const ControlRequestEvent = z.looseObject({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: z.looseObject({
    subtype: z.string(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    decision_reason: z.string().optional(),
  }),
});

export const ControlResponseEvent = z.looseObject({
  type: z.literal('control_response'),
  response: z.looseObject({ subtype: z.string(), request_id: z.string() }),
});

export type SystemEvent = z.infer<typeof SystemEvent>;
export type AssistantEvent = z.infer<typeof AssistantEvent>;
export type UserEvent = z.infer<typeof UserEvent>;
export type ResultEvent = z.infer<typeof ResultEvent>;
export type ControlRequestEvent = z.infer<typeof ControlRequestEvent>;
export type ControlResponseEvent = z.infer<typeof ControlResponseEvent>;
// 其他类型（如 rate_limit_event）只写入事件日志
export type OtherEvent = { type: string } & Record<string, unknown>;

export type StreamEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | OtherEvent;

const byType = {
  system: SystemEvent,
  assistant: AssistantEvent,
  user: UserEvent,
  result: ResultEvent,
  control_request: ControlRequestEvent,
  control_response: ControlResponseEvent,
} as const;

const AnyEvent = z.looseObject({ type: z.string() });

// stdout 的一行 JSON；已知类型按各自的 schema 校验
export function parseStreamEvent(raw: unknown): StreamEvent {
  const base = AnyEvent.parse(raw);
  if (!Object.hasOwn(byType, base.type)) return base;
  return byType[base.type as keyof typeof byType].parse(raw);
}

export const isType = <K extends keyof typeof byType>(
  event: StreamEvent,
  type: K,
): event is z.infer<(typeof byType)[K]> => event.type === type;
