import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// 内置的两个 workflow，也是两种评测类型：Sessions 列表的粗判用它（可配置的 workflow 见 workflowTable）
export const workflows = ['lfg', 'ic'] as const;
export type Workflow = (typeof workflows)[number];
const evalKinds = workflows;

export interface ToolCall {
  // tool_use.id
  id: string;
  name: string;
  input: unknown;
  // 配对 tool_result 的文本，截断到 20000 字符；尚未返回时为 null
  result: string | null;
  // 截断前的字符数
  resultChars: number;
  isError: boolean;
  // 结果溢出到 <sessionId>/tool-results/ 时的文件路径
  spillPath: string | null;
  // Agent/Task 调用对应的子代理 agent_id
  subagentId: string | null;
}

// 增量解析跨两次读取需要保留的状态，每个 jsonl 文件一份
export interface ParseState {
  // 同一 (session, agent) 内下一行 request 的 seq
  nextSeq: number;
  // 上一条用户消息或 tool_result 的时间，用于计算 duration
  lastUserAt: number | null;
  // 尚未收到结果的 tool_use.id → message.id
  pending: Record<string, string>;
  // fork 子代理：jsonl 以父代理对话的副本开头，直到派生它的 Agent 调用（父代理的 tool_use.id）的 tool_result
  // 为止都属于父代理，解析时跳过；读到该 tool_result 后删除
  forkToolUseId?: string;
}

// rubric 按产物分组，定义在 task schema 中
import type { ArtifactRubric, IcTaskSource } from '../tasks/schema.js';
export type { ArtifactRubric, RubricItem } from '../tasks/schema.js';
import type { CrossRunRef, IcCriteriaDetail, IcDetail, SourceRef } from '../grading/schema.js';
import type { WorkflowDefinition } from '../workflows/schema.js';

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);

// 用户勾选的 ~/.claude/projects/<slug> 目录，以及各 variant 的 home/claude/projects/<slug>（总是勾选）
export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // variant 目录下的来源记录 variant id
  variant: text('variant'),
  createdAt: createdAt(),
});

// workflow（Contracts 16.1）：入口命令与小阶段的定义；内置的 lfg、ic 由服务启动时从 YAML 写入
export const workflowTable = sqliteTable('workflows', {
  // 也是入口命令 /<id>
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 评测类型（16.2）：只有内置的 lfg、ic 有；为空时不能评测，只用于 Live、阶段划分与分析
  evalKind: text('eval_kind', { enum: evalKinds }),
  // 经 WorkflowDefinition 校验后的定义
  definition: text('definition', { mode: 'json' }).$type<WorkflowDefinition>().notNull(),
  // 基本描述（Contracts 18.3）；内置的 lfg、ic 第一次写入时取各自 yaml 中的 description
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// tasks/<id>/task.yaml 的镜像，启动时由 tasks/loader.ts 同步；评测类型不需要的字段为空
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    // task 的评测类型（Contracts 16.3）
    kind: text('kind', { enum: evalKinds }).notNull(),
    title: text('title').notNull(),
    persona: text('persona').notNull(),
    hiddenRequirements: text('hidden_requirements').notNull(),
    input: text('input'),
    rubric: text('rubric', { mode: 'json' }).$type<ArtifactRubric[]>(),
    ticketTitle: text('ticket_title'),
    ticketBody: text('ticket_body'),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>(),
    // 相对 task 目录
    repoPath: text('repo_path'),
    repoCommit: text('repo_commit'),
    // 从 Linear 导入的 ic task 的来源工单与源仓库
    source: text('source', { mode: 'json' }).$type<IcTaskSource>(),
    requiredChecks: text('required_checks', { mode: 'json' }).$type<string[]>(),
    // 没有隐藏测试的 ic task 以下为空
    hiddenTestsDir: text('hidden_tests_dir'),
    hiddenTestsConfig: text('hidden_tests_config'),
    testCommand: text('test_command'),
    hiddenTestsTimeoutSeconds: integer('hidden_tests_timeout_seconds'),
    hiddenTestsManifest: text('hidden_tests_manifest', { mode: 'json' }).$type<
      Record<string, string[]>
    >(),
    // task 目录的绝对路径
    dir: text('dir').notNull(),
    // task.yaml 内容的 sha256，内容不变时同步不改写行
    contentHash: text('content_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('tasks_kind_idx').on(t.kind)],
);

export const variants = sqliteTable(
  'variants',
  {
    id: text('id').primaryKey(),
    // 在同一 workflow 内唯一
    name: text('name').notNull(),
    // 基本描述（Contracts 18.3），在 variant 页面中编辑
    description: text('description'),
    // 所属 workflow（Contracts 16.4）；是否存在由 variants 模块校验
    workflowId: text('workflow_id').notNull(),
    // 存放 src、构建产物与隔离 home 的目录 data/variants/<storage_id>，为空时是自己的 id。迁移拆出的 lfg 与 ic
    // 两个 variant 共用一份（16.4），其中一个被编辑或构建时复制出自己的一份，改为空
    storageId: text('storage_id'),
    // 另存为新 variant 时指向来源
    parentId: text('parent_id').references((): AnySQLiteColumn => variants.id, {
      onDelete: 'set null',
    }),
    // 导出的 txe-workflow commit；任意 workflow 的 variant 只有一组 skill（18.6），为空字符串
    baseCommit: text('base_commit').notNull(),
    // skills/ 树的 sha256
    skillsHash: text('skills_hash').notNull(),
    // 内置 lfg、ic：<base>-eval.<hash8>；任意 workflow：skills.<hash8>
    version: text('version').notNull(),
    status: text('status', { enum: ['draft', 'frozen'] })
      .notNull()
      .default('draft'),
    installDir: text('install_dir'),
    buildStatus: text('build_status', { enum: ['none', 'building', 'built', 'failed'] })
      .notNull()
      .default('none'),
    // 最近一次成功构建时的 skills hash；与 skills_hash 不同说明构建已过期
    builtHash: text('built_hash'),
    buildError: text('build_error'),
    builtAt: integer('built_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    frozenAt: integer('frozen_at', { mode: 'timestamp_ms' }),
    // 由分析的"另存为 variant"建出时指向那次分析（Contracts 15.3）
    analysisId: text('analysis_id').references((): AnySQLiteColumn => analyses.id, {
      onDelete: 'set null',
    }),
    // 按 session 的 skill 新建时指向那个 session（Contracts 15.1）；session 可能尚未导入，不加外键
    sourceSessionId: text('source_session_id'),
    // 由 Codex 草稿保存出时指向那个草稿（Contracts 17.4）
    draftId: text('draft_id').references((): AnySQLiteColumn => workflowDrafts.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('variants_skills_hash_idx').on(t.skillsHash),
    uniqueIndex('variants_workflow_name_idx').on(t.workflowId, t.name),
  ],
);

export const batches = sqliteTable('batches', {
  id: text('id').primaryKey(),
  repeats: integer('repeats').notNull(),
  createdAt: createdAt(),
});

export const batchVariants = sqliteTable(
  'batch_variants',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.variantId] }),
    index('batch_variants_variant_idx').on(t.variantId),
  ],
);

export const batchTasks = sqliteTable(
  'batch_tasks',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.taskId] }),
    index('batch_tasks_task_idx').on(t.taskId),
  ],
);

// GET / PUT /api/settings 的内容；只有 id = 1 一行，没有这一行时用默认值
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const runStatuses = [
  'queued',
  'preparing',
  'running',
  'grading',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof runStatuses)[number];
export const terminalRunStatuses: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

// 评分流程的状态（Contracts 7.6）：none 不会评分，running 正在评分，done 已评分，failed 评分出错
export const gradingStatuses = ['none', 'running', 'done', 'failed'] as const;
export type GradingStatus = (typeof gradingStatuses)[number];

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'restrict' }),
    // 同一 batch 内同一 (task, variant) 的第几次重复，从 0 开始
    repeatIndex: integer('repeat_index').notNull(),
    // claude 的 --model（别名）与 --effort：发起 batch 时选（Contracts 16.5）
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    status: text('status', { enum: runStatuses }).notNull().default('queued'),
    humanIntervened: integer('human_intervened', { mode: 'boolean' }).notNull().default(false),
    // dashboard 生成并通过 --session-id 传给 claude；sessions 行由 Ingester 稍后写入，因此这里不加外键
    sessionId: text('session_id').notNull().unique(),
    workspacePath: text('workspace_path').notNull(),
    linearIssueId: text('linear_issue_id'),
    linearIssueIdentifier: text('linear_issue_identifier'),
    githubRepo: text('github_repo'),
    prUrl: text('pr_url'),
    costUsd: real('cost_usd').notNull().default(0),
    crossRunRefs: text('cross_run_refs', { mode: 'json' })
      .$type<CrossRunRef[]>()
      .notNull()
      .default(sql`'[]'`),
    // 读取了来源工单、来源仓库或来源 PR（Contracts 第 13 节）；compare 默认排除
    sourceRefs: text('source_refs', { mode: 'json' })
      .$type<SourceRef[]>()
      .notNull()
      .default(sql`'[]'`),
    // 评估环境本身出错、不能代表 variant 的 run 由用户标为无效（Contracts 7.12）；compare 总是排除
    invalidReason: text('invalid_reason'),
    gradingStatus: text('grading_status', { enum: gradingStatuses }).notNull().default('none'),
    gradingError: text('grading_error'),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('runs_batch_task_variant_repeat_idx').on(
      t.batchId,
      t.taskId,
      t.variantId,
      t.repeatIndex,
    ),
    index('runs_task_variant_idx').on(t.taskId, t.variantId),
    index('runs_status_idx').on(t.status),
  ],
);

export const liveEnvironments = ['isolated', 'real'] as const;
export type LiveEnvironment = (typeof liveEnvironments)[number];
export const liveDrivers = ['human', 'simulated'] as const;
export type LiveDriver = (typeof liveDrivers)[number];
export const liveStatuses = ['running', 'exited'] as const;
export type LiveStatus = (typeof liveStatuses)[number];
// 交互项终端中运行的程序：Claude Code，或用 Codex 生成 workflow 的会话（Contracts 17.3，只有人驾驶）
export const liveEngines = ['claude', 'codex'] as const;
export type LiveEngine = (typeof liveEngines)[number];

// 交互（Contracts 14.1）：交互区的一项对应一个 Claude Code session，不评分、不进入对比。
// 一项可以先后有多个进程（第一次启动、之后的每次 resume），见 live_processes。
// 外键不级联删除：迁移重建这张表时，引用它的行要原样保留
export const liveSessions = sqliteTable(
  'live_sessions',
  {
    // l-<yyyymmdd>-<6 位>：也是副本仓库、工单副本与 vault 目录的名字
    id: text('id').primaryKey(),
    // engine 为 codex 时是 Codex 的会话 id（CODEX_HOME/sessions 下 rollout 的 session_meta.payload.id）；Codex 草稿的项
    // 在草稿准备完、Codex 第一次写出会话记录之前为空（Contracts 17.1）
    claudeSessionId: text('claude_session_id').unique(),
    engine: text('engine', { enum: liveEngines }).notNull().default('claude'),
    // 用户可改（Contracts 14.3）；默认取输入的前 40 个字，从已有 session 开始的项取该 session 的标题
    title: text('title').notNull(),
    environment: text('environment', { enum: liveEnvironments }).notNull(),
    // 新建时选的 workflow 的 id（Contracts 16.7）；从已有 session 开始的项为空
    workflow: text('workflow'),
    input: text('input'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    cwd: text('cwd').notNull(),
    createdAt: createdAt(),
    // 新建、每个进程的开始与结束、改名时更新；列表按它倒序
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    // 用户在交互区关闭（"×"）的时间：只从列表隐藏，不删除任何东西（Contracts 14.5）；resume 或再次导入时清空
    hiddenAt: integer('hidden_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('live_sessions_updated_at_idx').on(t.updatedAt)],
);

export const liveProcessKinds = ['start', 'resume'] as const;
export type LiveProcessKind = (typeof liveProcessKinds)[number];

// 一项的每次运行；同一项同一时间最多一个 running 的进程
export const liveProcesses = sqliteTable(
  'live_processes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    liveId: text('live_id')
      .notNull()
      .references(() => liveSessions.id),
    kind: text('kind', { enum: liveProcessKinds }).notNull(),
    // 空表示"本机配置"（用户自己的 ~/.claude）
    variantId: text('variant_id').references(() => variants.id, { onDelete: 'restrict' }),
    // 实际传给 claude 的 --model 与 --effort（Contracts 16.5）；本机配置不传，为空
    model: text('model'),
    effort: text('effort'),
    pid: integer('pid'),
    status: text('status', { enum: liveStatuses }).notNull().default('running'),
    exitCode: integer('exit_code'),
    error: text('error'),
    driver: text('driver', { enum: liveDrivers }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('live_processes_live_idx').on(t.liveId, t.id),
    index('live_processes_status_idx').on(t.status),
  ],
);

export const liveEventKinds = [
  'start',
  'resume',
  'driver',
  'hook',
  'simulated_reply',
  'exit',
  'rename',
  'import',
  'hide',
  'unhide',
  'trust',
] as const;
export type LiveEventKind = (typeof liveEventKinds)[number];

// 驾驶者的每次切换、每次 hook、模拟用户的每次回答（含花费）、每次改名与导入；改名与导入不属于某个进程，process_id 为空
export const liveEvents = sqliteTable(
  'live_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    liveId: text('live_id')
      .notNull()
      .references(() => liveSessions.id),
    processId: integer('process_id').references(() => liveProcesses.id),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind', { enum: liveEventKinds }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('live_events_live_idx').on(t.liveId, t.id)],
);

// variant 的历史（Contracts 16.4、17.4）：一张表承载两种记录，kind 区分——改名（rename）记旧名与新名；
// 覆盖与恢复（overwrite、restore）前把原来的 src/ 存进 data/variant-history/<variantId>/<snapshot>/，
// payload 记快照目录名与来源。kind 与 payload 在 SQLite 中都是 text，新增的 kind 不需要迁移
export const variantEventKinds = ['rename', 'overwrite', 'restore'] as const;
export type VariantEventKind = (typeof variantEventKinds)[number];
export type VariantEventPayload =
  | { from: string; to: string }
  | { snapshot: string; draftId: string; analysisId: string | null }
  | { snapshot: string; restoredEventId: number };
export const variantEvents = sqliteTable(
  'variant_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind', { enum: variantEventKinds }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<VariantEventPayload>().notNull(),
  },
  (t) => [index('variant_events_variant_idx').on(t.variantId, t.id)],
);

// optimize：分析报告交给 Codex 优化（Contracts 19.3），目录是分析目录，保存时按 optimize/workflow.yaml 是否改动
// 决定保存为原 workflow 的新 variant 还是新 workflow
export const draftModes = ['workflow', 'variant', 'optimize'] as const;
export type DraftMode = (typeof draftModes)[number];
// preparing：后台准备草稿目录；open：可以与 Codex 对话、保存；failed：准备的某一步失败，可以从那一步重试（Contracts 17.1）
export const draftStatuses = ['preparing', 'open', 'saved', 'failed'] as const;
export type DraftStatus = (typeof draftStatuses)[number];

// 草稿准备的一步：复制 src、写说明与例子、安装每个 skill、启动 Codex
export interface DraftStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  // 失败那一步的原文
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

// 发起时装进草稿目录的一个 skill 的版本（Contracts 17.3）
export interface DraftSkillVersion {
  name: string;
  source: string;
  // skills-lock.json 的 computedHash
  computedHash: string;
  // 安装时 git ls-remote <source> HEAD
  commit: string;
}

// 用 Codex 生成 workflow 或 variant 的草稿（Contracts 17.1）：目录 data/workflow-drafts/<id>/
export const workflowDrafts = sqliteTable('workflow_drafts', {
  // d-<yyyymmdd>-<6 位>
  id: text('id').primaryKey(),
  mode: text('mode', { enum: draftModes }).notNull(),
  // mode 为 workflow 时是要新建的 workflow 的 id；为 variant 时是所属 workflow
  workflowId: text('workflow_id').notNull(),
  // mode 为 workflow 时新 workflow 的名字（准备草稿时写进 workflow.yaml）；mode 为 variant 时为空
  name: text('name'),
  // mode 为 workflow 时新 workflow 的描述（保存时写进 workflows.description，Contracts 18.3）
  description: text('description'),
  // mode 为 variant 时的底子 variant；mode 为 workflow 时为空，草稿从空白骨架开始（Contracts 18.5）
  baseVariantId: text('base_variant_id').references(() => variants.id, { onDelete: 'restrict' }),
  requirement: text('requirement').notNull(),
  // Live 中的 Codex 会话；删除交互项时置空，草稿保留。不加外键：迁移重建 live_sessions 时不能连带改动这里
  liveId: text('live_id'),
  // 新建的草稿以 preparing 写入；列的默认值保留 W42 时的 open
  status: text('status', { enum: draftStatuses }).notNull().default('open'),
  // 准备失败那一步的原文；其余为空
  error: text('error'),
  // 准备的各步与进度
  steps: text('steps', { mode: 'json' })
    .$type<DraftStep[]>()
    .notNull()
    .default(sql`'[]'`),
  savedWorkflowId: text('saved_workflow_id'),
  // 最近一次保存出的 variant；每次保存出的 variant 都以 variants.draft_id 指回草稿
  savedVariantId: text('saved_variant_id'),
  skills: text('skills', { mode: 'json' })
    .$type<DraftSkillVersion[]>()
    .notNull()
    .default(sql`'[]'`),
  // mode 为 optimize 时被优化的分析（Contracts 19.3）：草稿目录即 data/analyses/<id>/
  analysisId: text('analysis_id').references((): AnySQLiteColumn => analyses.id, {
    onDelete: 'restrict',
  }),
  createdAt: createdAt(),
});

// run：run 与交互的 session 用的 variant；auto：导入时 skill 正文与 variant 逐字节一致；manual：用户选择或解除
export const variantBindings = ['run', 'auto', 'manual'] as const;
export type VariantBinding = (typeof variantBindings)[number];

export const sessions = sqliteTable(
  'sessions',
  {
    // Claude Code 的 sessionId
    id: text('id').primaryKey(),
    // dashboard 发起的运行不属于任何勾选的来源，为空
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    // 交互产生（或被交互 resume）的 session 指向最近一次交互
    liveId: text('live_id').references(() => liveSessions.id, { onDelete: 'set null' }),
    filePath: text('file_path').notNull().unique(),
    cwd: text('cwd'),
    // 首条用户消息的前 80 字
    title: text('title'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
    // 粗判：出现 lfg / ic 阶段的标志（System Design 第 5 节最后一条）
    hasLfg: integer('has_lfg', { mode: 'boolean' }).notNull().default(false),
    hasIc: integer('has_ic', { mode: 'boolean' }).notNull().default(false),
    // 主 jsonl 已解析到的字节偏移量
    parseOffset: integer('parse_offset').notNull().default(0),
    parseState: text('parse_state', { mode: 'json' }).$type<ParseState>().notNull(),
    // 绑定的 variant（Contracts 15.1）；manual 且 variant_id 为空表示用户手动解除
    variantId: text('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    variantBinding: text('variant_binding', { enum: variantBindings }),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_source_idx').on(t.sourceId),
    index('sessions_variant_idx').on(t.variantId),
    index('sessions_run_idx').on(t.runId),
    index('sessions_started_at_idx').on(t.startedAt, t.id),
  ],
);

// <sessionId>/subagents/agent-<id>.jsonl，各自有解析偏移量
export const subagents = sqliteTable(
  'subagents',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    filePath: text('file_path').notNull().unique(),
    // agent-<id>.meta.json 的 toolUseId，指回父 session 中的 tool 调用
    parentToolUseId: text('parent_tool_use_id').notNull(),
    agentType: text('agent_type').notNull(),
    description: text('description'),
    parseOffset: integer('parse_offset').notNull().default(0),
    parseState: text('parse_state', { mode: 'json' }).$type<ParseState>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.agentId] }),
    index('subagents_parent_tool_use_idx').on(t.sessionId, t.parentToolUseId),
  ],
);

// 每次模型请求一行，按 message.id 去重
export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    seq: integer('seq').notNull(),
    // 主 agent 为空
    agentId: text('agent_id'),
    // 该 message 首条记录的时间
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    // 触发它的上一条用户消息或 tool_result 的时间；增量合并时用来重算 duration
    triggerAt: integer('trigger_at', { mode: 'timestamp_ms' }),
    model: text('model').notNull(),
    thinking: text('thinking'),
    text: text('text'),
    toolCalls: text('tool_calls', { mode: 'json' }).$type<ToolCall[]>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheCreationTokens: integer('cache_creation_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    durationMs: integer('duration_ms'),
    attributionSkill: text('attribution_skill'),
  },
  (t) => [
    // fork 子代理的 jsonl 以父代理对话的副本开头，同一 message.id 可能出现在不同 agent 中；主 agent 的 agent_id 为空，
    // 唯一约束按空字符串比较
    uniqueIndex('requests_session_agent_message_idx').on(
      t.sessionId,
      sql`(case when ${t.agentId} is null then '' else ${t.agentId} end)`,
      t.messageId,
    ),
    index('requests_session_agent_seq_idx').on(t.sessionId, t.agentId, t.seq),
  ],
);

// jsonl 中非 tool_result、非 isMeta 的 user 记录：用户消息（含模拟用户与人的回答），
// 以及 Claude Code 自己生成的系统事件（后台任务通知、本地命令输出）
export const userMessages = sqliteTable(
  'user_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // 主 agent 为空
    agentId: text('agent_id'),
    uuid: text('uuid').notNull(),
    kind: text('kind', { enum: ['user', 'notice'] }).notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    uniqueIndex('user_messages_session_uuid_idx').on(t.sessionId, t.uuid),
    index('user_messages_session_agent_time_idx').on(t.sessionId, t.agentId, t.timestamp),
  ],
);

export const stageStatuses = ['done', 'active', 'skipped', 'not-reached'] as const;
export type StageStatus = (typeof stageStatuses)[number];

// 进入阶段的那次调用：Skill 调用或用户输入的 slash 命令
export interface StageEvidence {
  seq: number;
  kind: 'skill' | 'command';
  text: string;
}

// 阶段划分的折叠状态（stages/partition 的 StageState）：已折叠到 folded_seq 为止的主请求。
// state 中记录划分所用的 workflow 与各自定义的 hash（Contracts 16.6），绑定或定义改变时从头重算
export const stageStates = sqliteTable('stage_states', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).notNull(),
  foldedSeq: integer('folded_seq').notNull(),
  // folded_seq 那条请求的时间：之后的用户消息还没有折叠
  foldedAt: integer('folded_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// 一个 workflow 的一轮：同一 session 可以有多轮
export const stageCycles = sqliteTable(
  'stage_cycles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // workflow id
    workflow: text('workflow').notNull(),
    // 从 1 开始
    cycle: integer('cycle').notNull(),
    label: text('label').notNull(),
    startSeq: integer('start_seq').notNull(),
    // 下一轮开始之前，或 session 的最后一条请求
    endSeq: integer('end_seq').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stage_cycles_session_workflow_cycle_idx').on(t.sessionId, t.workflow, t.cycle),
  ],
);

export const stageSpans = sqliteTable(
  'stage_spans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    workflow: text('workflow').notNull(),
    // 所属轮次，对应 stage_cycles.cycle
    cycle: integer('cycle').notNull(),
    stage: text('stage').notNull(),
    status: text('status', { enum: stageStatuses }).notNull(),
    // 主 session 的 seq，含端点；skipped 为 [s, s-1]，not-reached 为空
    startSeq: integer('start_seq'),
    endSeq: integer('end_seq'),
    // 这个阶段被调用的次数（fix-pr 的修复轮数）；skipped 与 not-reached 为 0
    entries: integer('entries').notNull().default(0),
    evidence: text('evidence', { mode: 'json' }).$type<StageEvidence | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stage_spans_session_workflow_cycle_stage_idx').on(
      t.sessionId,
      t.workflow,
      t.cycle,
      t.stage,
    ),
  ],
);

export const runMessageRoles = ['agent', 'simulated_user', 'human', 'system'] as const;
export type RunMessageRole = (typeof runMessageRoles)[number];

// AskUserQuestion 的一个问题，与 Claude Code 的 tool input 相同
export interface AskQuestion {
  question: string;
  header?: string | undefined;
  options: { label: string; description?: string | undefined }[];
  multiSelect?: boolean | undefined;
}

// run_messages.payload：AskUserQuestion 的问题与回答，或系统事件的结构化内容
export type RunMessagePayload =
  | { kind: 'question'; requestId: string; questions: AskQuestion[] }
  | {
      kind: 'answers';
      requestId: string;
      questions: AskQuestion[];
      answers: Record<string, string>;
    }
  | { kind: 'reply'; done: boolean }
  | { kind: 'initial' }
  | { kind: 'denied'; toolName: string; input: unknown; reason: string | null }
  | { kind: 'event'; event: string };

// agent 的提问、模拟用户或人的回答，以及拒绝的 tool 请求与运行中的系统事件
export const runMessages = sqliteTable(
  'run_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: runMessageRoles }).notNull(),
    content: text('content').notNull(),
    // 模拟用户调用的花费
    costUsd: real('cost_usd').notNull().default(0),
    payload: text('payload', { mode: 'json' }).$type<RunMessagePayload>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_messages_run_seq_idx').on(t.runId, t.seq)],
);

// rubric 评分的产物以 rubric 分组 id（评测类型 rubric 积木中 artifacts 的 id，例如 brief、research）为 kind；
// 其余为固定的种类：ticket 为 Linear 工单 identifier；friction 为被测 agent 在 txehq/txe-workflow 提的 issue 或评论，
// 每个 run 可以有多条，其余种类每个 run 一条；acceptance 为发布到 engapp.dev 的验收报告；
// pr_snapshot 为进入 grading 时 PR 的 reviews、评论与 checks（json，Contracts 15.2），location 为仓库地址
export const fixedArtifactKinds = [
  'pr',
  'repo',
  'ticket',
  'friction',
  'acceptance',
  'pr_snapshot',
] as const;
export type ArtifactKind = string;

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    // 文件路径或 URL
    location: text('location').notNull(),
    snapshot: text('snapshot'),
    createdAt: createdAt(),
    // 内容快照最近一次改写的时间
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
  },
  (t) => [uniqueIndex('artifacts_run_kind_location_idx').on(t.runId, t.kind, t.location)],
);

// rubric：每个 rubric 产物一行（一次 judge 调用，产物不存在时没有调用）；有隐藏测试时为测试结果（kind ic），
// 按验收标准评分时为 judge 的一次调用（kind ic_criteria，逐条得分在 grade_items）；两者都没有而选了 pr-endpoint 时为
// 终点判定（kind endpoint）。reached_end 为空表示评测类型没有 pr-endpoint（Contracts 16.2）
export const gradeKinds = ['rubric', 'ic', 'ic_criteria', 'endpoint'] as const;

export const grades = sqliteTable(
  'grades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: gradeKinds }).notNull(),
    // rubric 的产物组（rubric 分组 id）；其余为空
    artifact: text('artifact'),
    // 评分时产物不存在则为空
    artifactId: integer('artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
    judgeModel: text('judge_model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    testsPassed: integer('tests_passed'),
    testsDeclared: integer('tests_declared'),
    reachedEnd: integer('reached_end', { mode: 'boolean' }),
    icDetail: text('ic_detail', { mode: 'json' }).$type<IcDetail>(),
    // ic_criteria 的 PR、终点判定与 judge 看到的 check 结果
    criteriaDetail: text('criteria_detail', { mode: 'json' }).$type<IcCriteriaDetail>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('grades_run_idx').on(t.runId),
    uniqueIndex('grades_run_artifact_idx').on(t.runId, t.artifact),
  ],
);

// rubric 条目的得分；criterion 与 max_score 是评分时 rubric 的快照
export const gradeItems = sqliteTable(
  'grade_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gradeId: integer('grade_id')
      .notNull()
      .references(() => grades.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    criterion: text('criterion').notNull(),
    score: integer('score').notNull(),
    maxScore: integer('max_score').notNull(),
    reasoning: text('reasoning').notNull(),
  },
  (t) => [uniqueIndex('grade_items_grade_item_idx').on(t.gradeId, t.itemId)],
);

// session 中每次加载 skill 时 Claude Code 写入的正文（Contracts 15.1）：Skill 调用或 slash 命令之后 isMeta 的 user 记录。
// text 为 "Base directory for this skill: <dir>\n\n" 之后的原文：SKILL.md 去掉 frontmatter 与开头换行后的正文，
// 有参数时正文含 $ARGUMENTS 则替换它，否则末尾加 "\n\nARGUMENTS: <args>"
export const sessionSkills = sqliteTable(
  'session_skills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // 主 agent 为空
    agentId: text('agent_id'),
    uuid: text('uuid').notNull(),
    // Base directory 的最后一段
    name: text('name').notNull(),
    baseDir: text('base_dir').notNull(),
    text: text('text').notNull(),
    // Skill 调用的 input.args 或 slash 命令的 <command-args>；没有参数时为空字符串
    args: text('args').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('session_skills_session_uuid_idx').on(t.sessionId, t.uuid)],
);

// 已经提取过 skill 正文的 session：本表出现之前导入的 session 在服务启动时补提取一次
export const sessionSkillScans = sqliteTable('session_skill_scans', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
});

export const analysisEngines = ['claude', 'codex'] as const;
export type AnalysisEngine = (typeof analysisEngines)[number];

export const analysisStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AnalysisStatus = (typeof analysisStatuses)[number];

// 分析的方面与步骤是所选 session-analysis variant 的小阶段（Contracts 19.2）：每个方面一步，
// 最后一个小阶段 synthesize 综合出报告与修改建议。W45 之前的分析是 process、efficiency、interaction、quality 与 synthesis

export interface AnalysisTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Codex 的 reasoning_output_tokens（已含在 output 中）；Claude Code 为 0
  reasoning: number;
}

export interface AnalysisStep {
  // 小阶段 id（W45 之前为 process、efficiency、interaction、quality、synthesis）
  key: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number | null;
  endedAt: number | null;
  tokens: AnalysisTokens;
  // Codex 没有价格时为空
  costUsd: number | null;
  // 引擎输出的事件数，运行中表示进度
  events: number;
  error: string | null;
}

export const analyses = sqliteTable('analyses', {
  // a-<yyyymmdd>-<6 位小写字母数字>
  id: text('id').primaryKey(),
  engine: text('engine', { enum: analysisEngines }).notNull(),
  model: text('model').notNull(),
  variantId: text('variant_id')
    .notNull()
    .references((): AnySQLiteColumn => variants.id, { onDelete: 'restrict' }),
  sessionIds: text('session_ids', { mode: 'json' }).$type<string[]>().notNull(),
  status: text('status', { enum: analysisStatuses }).notNull().default('queued'),
  error: text('error'),
  steps: text('steps', { mode: 'json' }).$type<AnalysisStep[]>().notNull(),
  costUsd: real('cost_usd'),
  // 驱动这次分析的 session-analysis variant（Contracts 19.2）；W45 之前的分析为空
  analysisVariantId: text('analysis_variant_id').references((): AnySQLiteColumn => variants.id, {
    onDelete: 'restrict',
  }),
  // synthesize 写出的 output/report.json（校验后）；W45 之前的分析与没有成功的分析为空
  report: text('report', { mode: 'json' }).$type<AnalysisReport>(),
  createdAt: createdAt(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
});

export const analysisOutcomes = [
  'achieved',
  'partially_achieved',
  'not_achieved',
  'unclear',
] as const;

// output/report.json（Contracts 19.2）：patches.json 中的修改都属于"改 variant"，workflowChanges 是"需要新建 workflow"的建议
export interface AnalysisReport {
  summary: string;
  goal: string;
  outcome: (typeof analysisOutcomes)[number];
  topIssues: { title: string; findingIds: string[]; impact: string }[];
  workflowChanges: { findingIds: string[]; rationale: string; change: string }[];
}

export interface FindingEvidence {
  sessionId: string;
  // 主 agent 的 seq；子代理的请求按启动它的那条主请求引用
  seq: number;
  quote: string;
}

export const findingSeverities = ['high', 'medium', 'low'] as const;

export const analysisFindings = sqliteTable(
  'analysis_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    analysisId: text('analysis_id')
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    // <方面>-<序号>，序号为发现在该方面输出文件中的位置，从 1 开始；修改建议的 findingIds 引用它
    findingId: text('finding_id').notNull(),
    // 所选 session-analysis variant 的小阶段 id（W45 之前为 process、efficiency、interaction、quality）
    aspect: text('aspect').notNull(),
    title: text('title').notNull(),
    stage: text('stage'),
    skill: text('skill'),
    severity: text('severity', { enum: findingSeverities }).notNull(),
    detail: text('detail').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<FindingEvidence[]>().notNull(),
  },
  (t) => [uniqueIndex('analysis_findings_analysis_finding_idx').on(t.analysisId, t.findingId)],
);

export const analysisPatches = sqliteTable(
  'analysis_patches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    analysisId: text('analysis_id')
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    // 相对 skills/ 的路径，例如 ic/SKILL.md
    file: text('file').notNull(),
    findingIds: text('finding_ids', { mode: 'json' }).$type<string[]>().notNull(),
    rationale: text('rationale').notNull(),
    // 相对 input/skills/ 的 unified diff
    patch: text('patch').notNull(),
  },
  (t) => [index('analysis_patches_analysis_idx').on(t.analysisId)],
);
