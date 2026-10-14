import { z } from 'zod';

// 删除 variant 与 workflow 的 API 形状（Contracts 第 24 节）；web 直接引用

// 关联的 session（24.2）：一起删除，或改绑到另一个 variant（null 为本机配置，不绑定）
export const SessionsChoice = z.union([
  z.literal('delete'),
  z.strictObject({ rebindTo: z.string().min(1).nullable() }),
]);
export type SessionsChoice = z.infer<typeof SessionsChoice>;

export const DeleteBody = z.strictObject({ sessions: SessionsChoice });
export type DeleteBody = z.infer<typeof DeleteBody>;

// 阻止删除的一项（24.1）：内置 workflow、最后一个 variant、运行中的使用者、被改过的本机安装
export const DeletionBlocker = z.object({
  kind: z.enum(['builtin', 'last-variant', 'run', 'live', 'analysis', 'draft', 'install']),
  id: z.string(),
  label: z.string(),
});
export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

// 删除对话框的内容（24.6）
export const DeletionPlan = z.object({
  target: z.object({
    kind: z.enum(['variant', 'workflow']),
    id: z.string(),
    name: z.string(),
    workflowId: z.string(),
  }),
  variants: z.array(z.object({ id: z.string(), name: z.string() })),
  blockers: z.array(DeletionBlocker),
  // 要删除的目录（variant 的目录与覆盖前的存档、草稿目录或分析目录中优化用的部分）
  dirs: z.array(z.string()),
  // 装在本机、删除前先按清单卸载的
  installs: z.array(z.object({ variantId: z.string(), dirs: z.array(z.string()) })),
  // 关联的 session（run 的 session 不算，随 run 保留）：选一起删除时还删除这些文件与 Live 项。
  // agent：其中属于 Magi Agent 的 session 数（Contracts 23.1），它们与它们的 Live 项都不删除，选一起删除时改为本机配置
  sessions: z.object({
    count: z.number(),
    files: z.array(z.string()),
    liveItems: z.array(z.object({ id: z.string(), title: z.string() })),
    agent: z.number(),
  }),
  // 保留的记录，显示"<名字>（已删除）"
  retained: z.object({
    runs: z.number(),
    runSessions: z.number(),
    analyses: z.number(),
    liveItems: z.number(),
    children: z.array(z.object({ id: z.string(), name: z.string() })),
    drafts: z.number(),
  }),
  // 删除 workflow 时一并删除的草稿（24.5）
  drafts: z.array(z.object({ id: z.string(), liveId: z.string().nullable() })),
});
export type DeletionPlan = z.infer<typeof DeletionPlan>;
