import { z } from 'zod';
import {
  liveDrivers,
  liveEnvironments,
  liveEventKinds,
  liveStatuses,
  workflows,
} from '../db/schema.js';
import { AskQuestionView } from '../runs/views.js';

// 交互 API 的形状（Contracts 14）

// Claude Code 正在等的输入：一轮结束（Stop）的文字，或未回答的 AskUserQuestion
export const LiveWaiting = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('questions'),
    toolUseId: z.string(),
    questions: z.array(AskQuestionView),
  }),
]);
export type LiveWaiting = z.infer<typeof LiveWaiting>;

export const LiveSummary = z.object({
  id: z.string(),
  variantId: z.string().nullable(),
  // "本机配置" 时为空
  variantName: z.string().nullable(),
  environment: z.enum(liveEnvironments),
  workflow: z.enum(workflows).nullable(),
  input: z.string().nullable(),
  taskId: z.string().nullable(),
  cwd: z.string(),
  claudeSessionId: z.string(),
  resumedFrom: z.string().nullable(),
  pid: z.number().int().nullable(),
  status: z.enum(liveStatuses),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  driver: z.enum(liveDrivers),
  // 收到第一个 SessionStart hook 之前：驾驶者固定为人，终端中的确认由人回答
  starting: z.boolean(),
  // isolated 环境建出的副本仓库与工单
  repo: z.string().nullable(),
  ticket: z.string().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
});
export type LiveSummary = z.infer<typeof LiveSummary>;

export const LiveEventView = z.object({
  id: z.number().int(),
  at: z.number(),
  kind: z.enum(liveEventKinds),
  payload: z.record(z.string(), z.unknown()),
});
export type LiveEventView = z.infer<typeof LiveEventView>;

export const LiveDetail = LiveSummary.extend({
  // 运行中时 Claude Code 正在等的输入；没有时为空
  waiting: LiveWaiting.nullable(),
  // 驾驶者最近一次变为人的原因：input（终端中有按键）、done（模拟用户认为已结束）、max-turns、error；其余为空
  handedBack: z.enum(['input', 'done', 'max-turns', 'error', 'manual']).nullable(),
  events: z.array(LiveEventView),
});
export type LiveDetail = z.infer<typeof LiveDetail>;

export const CreateLiveBody = z.strictObject({
  workflow: z.enum(workflows),
  // 选了 task 时为空，输入取自 task
  input: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  variantId: z.string().min(1),
  environment: z.enum(liveEnvironments),
  // real 环境的真实目录；isolated 为空
  cwd: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
});
export type CreateLiveBody = z.infer<typeof CreateLiveBody>;

export const ResumeLiveBody = z.strictObject({
  sessionId: z.string().min(1),
  // 空表示"本机配置"
  variantId: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
});
export type ResumeLiveBody = z.infer<typeof ResumeLiveBody>;

// resume 对话框的默认值：session 所用的 variant 与它记录的工作目录
export const ResumeDefaults = z.object({
  sessionId: z.string(),
  variantId: z.string().nullable(),
  cwd: z.string().nullable(),
  cwdExists: z.boolean(),
});
export type ResumeDefaults = z.infer<typeof ResumeDefaults>;
