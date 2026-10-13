import { z } from 'zod';
import { draftModes, draftStatuses } from '../db/schema.js';

// 用 Codex 生成 workflow 或 variant 的 API 形状（Contracts 第 17 节）；web 直接引用

const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, '只能包含小写字母、数字与连字符，以字母开头');

export const CreateDraftBody = z.discriminatedUnion('mode', [
  // Workflows 列表的"用 Codex 生成 workflow"：新 workflow 的 id、名字、描述与需求，草稿从空白骨架开始（18.5）
  z.strictObject({
    mode: z.literal('workflow'),
    workflowId: Slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    requirement: z.string().trim().min(1),
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

// 草稿准备的一步（Contracts 17.1）
export const DraftStepView = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type DraftStepView = z.infer<typeof DraftStepView>;

export const DraftView = z.object({
  id: z.string(),
  mode: z.enum(draftModes),
  workflowId: z.string(),
  // mode 为 workflow 时新 workflow 的名字与描述
  name: z.string().nullable(),
  description: z.string().nullable(),
  // mode 为 variant 时的底子 variant；mode 为 workflow 时为空
  baseVariantId: z.string().nullable(),
  requirement: z.string(),
  liveId: z.string().nullable(),
  // preparing 时后台在准备草稿目录；failed 时 error 为失败那一步的原文，可以重试
  status: z.enum(draftStatuses),
  error: z.string().nullable(),
  steps: z.array(DraftStepView),
  savedWorkflowId: z.string().nullable(),
  savedVariantId: z.string().nullable(),
  // 每次保存出的 variant，按保存的先后
  savedVariants: z.array(z.object({ id: z.string(), name: z.string(), workflowId: z.string() })),
  skills: z.array(DraftSkillView),
  dir: z.string(),
  createdAt: z.number(),
});
export type DraftView = z.infer<typeof DraftView>;
