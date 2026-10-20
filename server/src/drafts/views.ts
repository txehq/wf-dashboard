import { z } from 'zod';
import { draftModes, draftStatuses, liveEngines } from '../db/schema.js';
import { WorkflowDefinition } from '../workflows/schema.js';

// 生成 workflow、生成 variant 与分析优化的 API 形状（Contracts 第 17 节、19.3、22）；web 直接引用

const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, '只能包含小写字母、数字与连字符，以字母开头');

// 会话的引擎（Contracts 22.1）：Codex 或 Claude Code
export const DraftEngine = z.enum(liveEngines);
export type DraftEngine = z.infer<typeof DraftEngine>;

export const CreateDraftBody = z.discriminatedUnion('mode', [
  // Workflows 列表的"生成 workflow"：新 workflow 的 id、名字、描述与需求，草稿从空白骨架开始（18.5）
  z.strictObject({
    mode: z.literal('workflow'),
    engine: DraftEngine,
    workflowId: Slug,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    requirement: z.string().trim().min(1),
  }),
  // Workflow 页面的"生成 variant"：只改 skill 内容，不改入口与小阶段
  z.strictObject({
    mode: z.literal('variant'),
    engine: DraftEngine,
    workflowId: z.string().min(1),
    requirement: z.string().trim().min(1),
    baseVariantId: z.string().min(1),
  }),
]);
export type CreateDraftBody = z.infer<typeof CreateDraftBody>;

// 分析报告的"优化"（Contracts 19.3、22.1）
export const OptimizeBody = z.strictObject({ engine: DraftEngine });

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
  engine: DraftEngine,
  workflowId: z.string(),
  // mode 为 workflow 时新 workflow 的名字与描述
  name: z.string().nullable(),
  description: z.string().nullable(),
  // mode 为 variant 时的底子 variant；mode 为 optimize 时是被分析的 variant；mode 为 workflow 时为空
  baseVariantId: z.string().nullable(),
  // mode 为 optimize 时被优化的分析（Contracts 19.3）
  analysisId: z.string().nullable(),
  requirement: z.string(),
  liveId: z.string().nullable(),
  // preparing 时后台在准备草稿目录；failed 时 error 为失败那一步的原文，可以重试
  status: z.enum(draftStatuses),
  error: z.string().nullable(),
  steps: z.array(DraftStepView),
  savedWorkflowId: z.string().nullable(),
  savedVariantId: z.string().nullable(),
  // 每次保存出的 variant，按保存的先后
  savedVariants: z.array(
    z.object({ id: z.string(), name: z.string(), workflowId: z.string(), deleted: z.boolean() }),
  ),
  skills: z.array(DraftSkillView),
  dir: z.string(),
  createdAt: z.number(),
});
export type DraftView = z.infer<typeof DraftView>;

// 保存前的改动预览（Contracts 21.3）：草稿的 src/ 相对底子 variant 逐文件的差异
export const DraftDiffView = z.object({
  // 从空白开始的草稿没有底子，文件都是新增
  base: z.object({ id: z.string(), name: z.string() }).nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'removed', 'modified']),
      oldContent: z.string(),
      newContent: z.string(),
      // 统一 diff 文本
      patch: z.string(),
    }),
  ),
});
export type DraftDiffView = z.infer<typeof DraftDiffView>;

// 保存（Contracts 17.4）：新建 variant，或覆盖同一 workflow 中的某个 variant，名字与描述都必填；
// 第一次保存为新 workflow 时另带 workflow 的名字与描述。必填与长度由服务端校验，以原文 400
export const SaveTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), name: z.string(), description: z.string() }),
  z.strictObject({
    kind: z.literal('overwrite'),
    variantId: z.string().min(1),
    name: z.string(),
    description: z.string(),
  }),
]);
export type SaveTarget = z.infer<typeof SaveTarget>;

export const SaveDraftBody = z.strictObject({
  target: SaveTarget,
  workflow: z.strictObject({ name: z.string(), description: z.string() }).optional(),
});
export type SaveDraftBody = z.infer<typeof SaveDraftBody>;

// 保存对话框的内容：第一次保存为新 workflow，或保存到已有 workflow（列出它的 variant，不能覆盖的写明原因）
export const SavePlanView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new-workflow'),
    workflowId: z.string(),
    workflowName: z.string(),
    workflowDescription: z.string(),
    variantName: z.string(),
  }),
  z.object({
    kind: z.literal('variant'),
    workflowId: z.string(),
    workflowName: z.string(),
    // 新建时的 parent，diff 的参照
    parent: z.object({ id: z.string(), name: z.string() }).nullable(),
    variants: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        // 不能覆盖的原因（导入的、已冻结的、正在构建的）；可以覆盖时为 null
        reason: z.string().nullable(),
      }),
    ),
  }),
]);
export type SavePlanView = z.infer<typeof SavePlanView>;

// 设计与优化会话的 workflow 面板（Contracts 26.4）：工作目录中的 src/skills 相对底子的标记
export const WorkspaceFileStatus = z.enum(['added', 'modified', 'removed', 'unchanged']);
export type WorkspaceFileStatus = z.infer<typeof WorkspaceFileStatus>;
export const WorkspaceStageStatus = z.enum(['added', 'modified', 'unchanged', 'missing']);
export type WorkspaceStageStatus = z.infer<typeof WorkspaceStageStatus>;

export const WorkspaceView = z.object({
  draftId: z.string(),
  mode: z.enum(draftModes),
  analysisId: z.string().nullable(),
  // 相对工作目录，显示用
  root: z.string(),
  base: z.object({ id: z.string(), name: z.string() }).nullable(),
  workflow: z.union([
    z.object({
      definition: WorkflowDefinition,
      stages: z.array(
        z.object({ id: z.string(), entry: z.boolean(), status: WorkspaceStageStatus }),
      ),
    }),
    z.object({ error: z.string() }),
  ]),
  // 路径相对 src/（skills/<skill>/...）；只在底子中的为 removed，mtimeMs 为 null
  files: z.array(
    z.object({ path: z.string(), status: WorkspaceFileStatus, mtimeMs: z.number().nullable() }),
  ),
  // "对比"可以选的对象（28.4）：上次保存与上一版，at 为保存与记下快照的毫秒时间；没有时为 null
  against: z.object({
    saved: z.object({ at: z.number() }).nullable(),
    previous: z.object({ at: z.number() }).nullable(),
  }),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceAgainst = z.enum(['base', 'saved', 'previous']);
export type WorkspaceAgainst = z.infer<typeof WorkspaceAgainst>;

export const WorkspaceFileView = z.object({
  path: z.string(),
  // 工作目录与底子中都没有时为 null
  status: WorkspaceFileStatus.nullable(),
  // 工作目录中不存在或是二进制文件时为 null
  content: z.string().nullable(),
  binary: z.boolean(),
});
export type WorkspaceFileView = z.infer<typeof WorkspaceFileView>;

export const WorkspaceDiffView = z.object({
  path: z.string(),
  against: WorkspaceAgainst,
  status: WorkspaceFileStatus.nullable(),
  oldContent: z.string(),
  newContent: z.string(),
  patch: z.string(),
});
export type WorkspaceDiffView = z.infer<typeof WorkspaceDiffView>;

// GET /api/live/:id/workspace/events 推送的事件
export type WorkspaceEvent =
  | { type: 'changed'; paths: string[]; workflow: boolean }
  | { type: 'closed'; reason: 'hidden' | 'deleted' }
  // 监视出错（例如读目录失败）：原文，之后连接结束。不叫 error：EventSource 的 error 是连接出错
  | { type: 'failed'; message: string };
