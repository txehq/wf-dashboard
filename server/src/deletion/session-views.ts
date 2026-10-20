import { z } from 'zod';
import { sessionEngines } from '../db/schema.js';

// Sessions 页面的清除、删除与归档的 API 形状（Contracts 25.1、25.3、25.5）；web 直接引用。
// 清除只从管理表格中去掉，磁盘上的文件不动
export const sessionActions = ['clear', 'delete', 'archive', 'unarchive'] as const;
export type SessionAction = (typeof sessionActions)[number];

export const SessionActionBody = z.strictObject({ ids: z.array(z.string().min(1)).min(1) });

// 确认对话框的内容：将要处理的 session 与每个文件的路径（Codex 的 rollout 由 codex delete 删除）、
// 随删除一起删除的 Live 项、拒绝的原因
export const SessionActionPlan = z.object({
  action: z.enum(sessionActions),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      engine: z.enum(sessionEngines),
      files: z.array(z.string()),
    }),
  ),
  liveItems: z.array(z.object({ id: z.string(), title: z.string() })),
  blockers: z.array(z.object({ sessionId: z.string(), label: z.string() })),
});
export type SessionActionPlan = z.infer<typeof SessionActionPlan>;
