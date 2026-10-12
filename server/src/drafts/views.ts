import { z } from 'zod';
import { draftModes, draftStatuses } from '../db/schema.js';

// 用 Codex 生成 workflow 或 variant 的 API 形状（Contracts 第 17 节）；web 直接引用

const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, '只能包含小写字母、数字与连字符，以字母开头');

export const CreateDraftBody = z.discriminatedUnion('mode', [
  // Workflows 列表的"用 Codex 生成 workflow"：新 workflow 的 id、名字、需求与底子 variant
  z.strictObject({
    mode: z.literal('workflow'),
    workflowId: Slug,
    name: z.string().trim().min(1).max(100),
    requirement: z.string().trim().min(1),
    baseVariantId: z.string().min(1),
  }),
  // Workflow 页面的"用 Codex 生成 variant"：只改 skill 内容，不改入口与小阶段
  z.strictObject({
    mode: z.literal('variant'),
    workflowId: z.string().min(1),
    requirement: z.string().trim().min(1),
    baseVariantId: z.string().min(1),
  }),
]);
export type CreateDraftBody = z.infer<typeof CreateDraftBody>;

export const DraftSkillView = z.object({
  name: z.string(),
  source: z.string(),
  computedHash: z.string(),
  commit: z.string(),
});

export const DraftView = z.object({
  id: z.string(),
  mode: z.enum(draftModes),
  workflowId: z.string(),
  baseVariantId: z.string(),
  requirement: z.string(),
  liveId: z.string().nullable(),
  status: z.enum(draftStatuses),
  savedWorkflowId: z.string().nullable(),
  savedVariantId: z.string().nullable(),
  // 每次保存出的 variant，按保存的先后
  savedVariants: z.array(z.object({ id: z.string(), name: z.string(), workflowId: z.string() })),
  skills: z.array(DraftSkillView),
  dir: z.string(),
  createdAt: z.number(),
});
export type DraftView = z.infer<typeof DraftView>;
