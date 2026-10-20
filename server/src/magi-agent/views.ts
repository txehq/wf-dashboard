import { z } from 'zod';
import { liveEngines, magiDeployStatuses, magiDeployStepStatuses } from '../db/schema.js';

// Magi Agent 的接口（Contracts 第 23 节）

// 打开（Contracts 23.6）：config 为 local 或 variant id；liveId 为继续的会话，为空时新建
export const MagiOpenBody = z.object({
  engine: z.enum(liveEngines),
  config: z.string().min(1),
  liveId: z.string().min(1).nullable(),
});
export type MagiOpenBody = z.infer<typeof MagiOpenBody>;

export const MagiSessionView = z.object({
  id: z.string(),
  title: z.string(),
  engine: z.enum(liveEngines),
  config: z.string(),
  updatedAt: z.number(),
  running: z.boolean(),
});
export type MagiSessionView = z.infer<typeof MagiSessionView>;

// worktree 第一次打开时的准备：git worktree add 与 pnpm install（Contracts 23.2）
export const WorktreeStep = z.object({
  id: z.enum(['worktree', 'install']),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  // 命令的输出原文
  output: z.string().nullable(),
});
export type WorktreeStep = z.infer<typeof WorktreeStep>;

export const MagiDeployStepView = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(magiDeployStepStatuses),
  output: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});

export const MagiDeployView = z.object({
  id: z.number(),
  liveId: z.string(),
  engine: z.enum(liveEngines),
  status: z.enum(magiDeployStatuses),
  steps: z.array(MagiDeployStepView),
  error: z.string().nullable(),
  commit: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type MagiDeployView = z.infer<typeof MagiDeployView>;

export const MagiAgentView = z.object({
  worktree: z.object({
    path: z.string(),
    branch: z.string(),
    // missing 还没有建；preparing 正在建或安装；ready 可以启动；failed 某一步失败（再次打开时从头重试）
    state: z.enum(['missing', 'preparing', 'ready', 'failed']),
    steps: z.array(WorktreeStep),
    // 相对 main 领先与落后的 commit 数、未提交的文件数；worktree 还没有准备好时为空
    ahead: z.number().nullable(),
    behind: z.number().nullable(),
    uncommitted: z.number().nullable(),
    // worktree 准备完成后在后台启动失败的原文
    startError: z.string().nullable(),
  }),
  // 全部 Magi Agent 的会话（包括已关闭的），最近的在前
  sessions: z.array(MagiSessionView),
  // 最近一次部署
  deploy: MagiDeployView.nullable(),
});
export type MagiAgentView = z.infer<typeof MagiAgentView>;

export const DeployBody = z.object({ liveId: z.string().min(1) });
