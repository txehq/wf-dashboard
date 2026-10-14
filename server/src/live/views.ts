import { z } from 'zod';
import {
  liveDrivers,
  liveEngines,
  liveEnvironments,
  liveEventKinds,
  liveProcessKinds,
  livePurposes,
  liveStatuses,
} from '../db/schema.js';
import { AskQuestionView } from '../runs/views.js';
import { efforts, modelAliases } from '../variants/model-names.js';

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

// 一项的一次运行（Contracts 14.1 的 live_processes）
export const LiveProcessView = z.object({
  id: z.number().int(),
  kind: z.enum(liveProcessKinds),
  variantId: z.string().nullable(),
  // "本机配置" 时为空
  variantName: z.string().nullable(),
  pid: z.number().int().nullable(),
  status: z.enum(liveStatuses),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  driver: z.enum(liveDrivers),
  // 实际传给 claude 的 --model 与 --effort；本机配置不传，为空
  model: z.string().nullable(),
  effort: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type LiveProcessView = z.infer<typeof LiveProcessView>;

// 交互区一项的状态：idle 为从本机导入、还没有任何进程（页面显示"未运行"，Contracts 14.5）
export const liveItemStatuses = ['running', 'exited', 'idle'] as const;
export type LiveItemStatus = (typeof liveItemStatuses)[number];

// 交互区的一项（一个 Claude Code session）；process 是最近的一个进程（导入后还没有运行过时为空），status 等字段取自它
export const LiveSummary = z.object({
  id: z.string(),
  title: z.string(),
  // Codex 草稿的项在草稿准备完、Codex 第一次启动之前为空（Contracts 17.1）
  claudeSessionId: z.string().nullable(),
  // codex：用 Codex 生成 workflow 或 variant 的会话（Contracts 17.3），claudeSessionId 是 Codex 的会话 id
  engine: z.enum(liveEngines),
  // 用途（Contracts 14.3）；design 时 designMode 为 workflow 或 variant，optimize 时 analysisId 为对应的分析
  purpose: z.enum(livePurposes),
  designMode: z.enum(['workflow', 'variant']).nullable(),
  analysisId: z.string().nullable(),
  // 这个 Codex 会话所属的草稿；其余为空
  draftId: z.string().nullable(),
  environment: z.enum(liveEnvironments),
  // 新建时选的 workflow 的 id；从已有 session 开始的项为空
  workflow: z.string().nullable(),
  input: z.string().nullable(),
  taskId: z.string().nullable(),
  cwd: z.string(),
  process: LiveProcessView.nullable(),
  // 下面几项取自最近的进程，供列表与终端上方显示；没有进程时 variant 为空、驾驶者为人
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  status: z.enum(liveItemStatuses),
  driver: z.enum(liveDrivers),
  error: z.string().nullable(),
  resumeCount: z.number().int(),
  // 收到第一个 SessionStart hook 之前：驾驶者固定为人，终端中的确认由人回答
  starting: z.boolean(),
  // isolated 环境建出的副本仓库与工单
  repo: z.string().nullable(),
  ticket: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // 在交互区关闭的时间；显示中为空
  hiddenAt: z.number().nullable(),
  // 最近的进程是所有页面关闭后自动结束的（Contracts 14.3）
  autoStopped: z.boolean(),
});
export type LiveSummary = z.infer<typeof LiveSummary>;

export const LiveEventView = z.object({
  id: z.number().int(),
  processId: z.number().int().nullable(),
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
  // 全部进程，按开始的先后
  processes: z.array(LiveProcessView),
  events: z.array(LiveEventView),
});
export type LiveDetail = z.infer<typeof LiveDetail>;

// 改名（Contracts 14.3）：去掉首尾空白后非空，最多 200 字；不满足时由服务端以原文报错
export const RenameLiveBody = z.strictObject({ title: z.string() });
export type RenameLiveBody = z.infer<typeof RenameLiveBody>;
export const TITLE_MAX = 200;

// 导入到交互区（Contracts 14.5）：为每个 session 建一项，不启动进程
export const ImportLiveBody = z.strictObject({ sessionIds: z.array(z.string().min(1)).min(1) });
export type ImportLiveBody = z.infer<typeof ImportLiveBody>;

// 删除一项：输入这一项的名字确认（Contracts 14.5）
export const DeleteLiveBody = z.strictObject({ confirmTitle: z.string() });
export type DeleteLiveBody = z.infer<typeof DeleteLiveBody>;

// Contracts 14.2：先选 workflow，再选它的 variant；问题作为初始消息 /<workflow id> <问题> 的内容
export const CreateLiveBody = z.strictObject({
  workflow: z.string().min(1),
  input: z.string().trim().min(1),
  variantId: z.string().min(1),
  environment: z.enum(liveEnvironments),
  // real 环境的真实目录；isolated 为空
  cwd: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
  // 没有选时取 /settings 的 agentModel 与 agentEffort（Contracts 16.5）
  model: z.enum(modelAliases).optional(),
  effort: z.enum(efforts).optional(),
});
export type CreateLiveBody = z.infer<typeof CreateLiveBody>;

export const ResumeLiveBody = z.strictObject({
  sessionId: z.string().min(1),
  // 空表示"本机配置"
  variantId: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
  model: z.enum(modelAliases).optional(),
  effort: z.enum(efforts).optional(),
  // 两份分叉时"以最新的为准继续"（Contracts 14.5）：目标中的那份改名保留后用最新的覆盖；不传时分叉不 resume
  onDiverged: z.literal('use-latest').optional(),
});
export type ResumeLiveBody = z.infer<typeof ResumeLiveBody>;

// resume 对话框的默认值：session 所用的 variant 与它记录的工作目录；session 所属的项有运行中的进程时不能 resume
export const ResumeDefaults = z.object({
  sessionId: z.string(),
  variantId: z.string().nullable(),
  cwd: z.string().nullable(),
  cwdExists: z.boolean(),
  // session 所属的项（Contracts 14.5）；还不属于任何一项时为空
  liveId: z.string().nullable(),
  running: z.boolean(),
});
export type ResumeDefaults = z.infer<typeof ResumeDefaults>;

// resume 的预检（Contracts 14.5）：对话框打开与改选配置时就说明将要做什么。
// resume：目标配置中已是最新内容，直接接着运行；copy：先把 session 复制进目标配置；sync：目标中有较早的一份，
// 先用最新的覆盖；diverged：两份分叉，要用户选择；blocked：不能 resume，problems 中写明原因与可做的操作
export const resumeActions = ['resume', 'copy', 'sync', 'diverged', 'blocked'] as const;
export type ResumeAction = (typeof resumeActions)[number];

export const resumeProblemCodes = [
  'no-cwd',
  'cwd-missing',
  'variant-not-built',
  'running',
  'file-missing',
] as const;

export const ResumeCopy = z.object({
  path: z.string(),
  bytes: z.number().int(),
  // 主 agent 最后一条有文字的消息
  lastAt: z.string().nullable(),
  lastRole: z.enum(['user', 'assistant']).nullable(),
  lastText: z.string().nullable(),
});
export type ResumeCopy = z.infer<typeof ResumeCopy>;

export const ResumePlan = z.object({
  sessionId: z.string(),
  // 这次预检的配置；本机配置为空
  variantId: z.string().nullable(),
  // 目标配置目录（variant 的 CLAUDE_CONFIG_DIR 或"本机配置"的 <HOME>/.claude）
  configDir: z.string(),
  liveId: z.string().nullable(),
  cwd: z.string().nullable(),
  // 选了 variant 时的默认 model 与 effort（设置的 agentModel、agentEffort）；本机配置不传，为空
  model: z.enum(modelAliases).nullable(),
  effort: z.enum(efforts).nullable(),
  action: z.enum(resumeActions),
  // 最新那份（sessions.file_path）与目标配置中已有的那份（没有时为空）
  latest: ResumeCopy.nullable(),
  target: ResumeCopy.nullable(),
  problems: z.array(z.object({ code: z.enum(resumeProblemCodes), message: z.string() })),
  // 不妨碍 resume、但要让用户知道的事（例如子代理目录不在）
  notes: z.array(z.string()),
});
export type ResumePlan = z.infer<typeof ResumePlan>;
