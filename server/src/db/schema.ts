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

export const workflows = ['lfg', 'ic'] as const;
export type Workflow = (typeof workflows)[number];

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
}

// lfg 的 rubric 按产物分组，定义在 task schema 中
import { type ArtifactRubric, rubricArtifacts } from '../tasks/schema.js';
export type { ArtifactRubric, RubricItem } from '../tasks/schema.js';
import type { CrossRunRef, IcDetail } from '../grading/schema.js';

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

// tasks/<id>/task.yaml 的镜像，启动时由 tasks/loader.ts 同步；lfg 与 ic 各自的字段在另一种 kind 下为空
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: workflows }).notNull(),
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
    hiddenTestsDir: text('hidden_tests_dir'),
    testCommand: text('test_command'),
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
    name: text('name').notNull().unique(),
    // 另存为新 variant 时指向来源
    parentId: text('parent_id').references((): AnySQLiteColumn => variants.id, {
      onDelete: 'set null',
    }),
    baseCommit: text('base_commit').notNull(),
    // skills/ 树的 sha256
    skillsHash: text('skills_hash').notNull(),
    // <base>-eval.<hash8>
    version: text('version').notNull(),
    model: text('model').notNull(),
    effort: text('effort').notNull(),
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
  },
  (t) => [index('variants_skills_hash_idx').on(t.skillsHash)],
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

export const sessions = sqliteTable(
  'sessions',
  {
    // Claude Code 的 sessionId
    id: text('id').primaryKey(),
    // dashboard 发起的运行不属于任何勾选的来源，为空
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
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
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_source_idx').on(t.sourceId),
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
    uniqueIndex('requests_session_message_idx').on(t.sessionId, t.messageId),
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

// interrupted：另一轮流程开始时，被结束的那一轮中正在进行的阶段
export const stageStatuses = ['done', 'active', 'skipped', 'not-reached', 'interrupted'] as const;
export type StageStatus = (typeof stageStatuses)[number];

// 判定模型的版本；stage_analyses.version 与它不同的结果视为未分析
export const STAGE_ANALYSIS_VERSION = 3;

// 一个 session 完成离线阶段判定的记录；不含 lfg 与 ic 的 session 也有一行
export const stageAnalyses = sqliteTable('stage_analyses', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  hasLfg: integer('has_lfg', { mode: 'boolean' }).notNull(),
  hasIc: integer('has_ic', { mode: 'boolean' }).notNull(),
  createdAt: createdAt(),
});

// 一轮流程：同一 session 可以有多轮 /lfg 与 /ic
export const stageCycles = sqliteTable(
  'stage_cycles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    workflow: text('workflow', { enum: workflows }).notNull(),
    // 从 1 开始
    cycle: integer('cycle').notNull(),
    label: text('label').notNull(),
    startSeq: integer('start_seq').notNull(),
    // 流程还没结束时为空
    endSeq: integer('end_seq'),
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
    workflow: text('workflow', { enum: workflows }).notNull(),
    // 所属轮次，对应 stage_cycles.cycle
    cycle: integer('cycle').notNull(),
    stage: text('stage').notNull(),
    status: text('status', { enum: stageStatuses }).notNull(),
    // 主 session 的 seq，含端点；skipped 为 [s, s-1]，not-reached 为空
    startSeq: integer('start_seq'),
    endSeq: integer('end_seq'),
    method: text('method', { enum: ['artifact', 'llm'] }).notNull(),
    evidence: text('evidence', { mode: 'json' }),
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

// 每次 LLM 阶段判定的记录
export const stageChecks = sqliteTable(
  'stage_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    workflow: text('workflow', { enum: workflows }).notNull(),
    // 判定时的 STAGE_ANALYSIS_VERSION；StageReport 的 checks 只统计当前版本
    version: integer('version').notNull().default(STAGE_ANALYSIS_VERSION),
    // 判定时的状态：阶段名，或流程外 outside
    currentStage: text('current_stage').notNull(),
    // 问题所问的去向：下一阶段、进入流程 enter、离开流程 outside
    nextStage: text('next_stage').notNull(),
    // 这批新增行为的 seq 范围
    fromSeq: integer('from_seq').notNull(),
    toSeq: integer('to_seq').notNull(),
    inputChars: integer('input_chars').notNull(),
    entered: integer('entered', { mode: 'boolean' }).notNull(),
    // 回答"是"时模型指出的第一条行为
    enteredAtSeq: integer('entered_at_seq'),
    answer: text('answer').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('stage_checks_session_idx').on(t.sessionId, t.workflow)],
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

// ticket 为 ic 的 Linear 工单 identifier；friction 为被测 agent 在 txehq/txe-workflow 提的 issue 或评论，
// 每个 run 可以有多条，其余种类每个 run 一条
export const artifactKinds = [
  'brief',
  'research',
  'plan',
  'tickets',
  'pr',
  'repo',
  'ticket',
  'friction',
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: artifactKinds }).notNull(),
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

// lfg：每个 rubric 产物一行（一次 judge 调用，产物不存在时没有调用）；ic：每个 run 一行测试结果与终点判定
export const grades = sqliteTable(
  'grades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['rubric', 'ic'] }).notNull(),
    // rubric 的产物组；ic 为空
    artifact: text('artifact', { enum: rubricArtifacts }),
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
