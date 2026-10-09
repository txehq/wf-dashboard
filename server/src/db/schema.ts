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
  id: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export interface RubricItem {
  id: string;
  criterion: string;
  maxScore: number;
}

// lfg 的 rubric 按产物分组
export interface ArtifactRubric {
  artifact: 'brief' | 'research' | 'plan' | 'tickets';
  items: RubricItem[];
}

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);

// 用户勾选的 ~/.claude/projects/<slug> 目录
export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: workflows }).notNull(),
    title: text('title').notNull(),
    // lfg 的想法；ic 为空
    input: text('input'),
    persona: text('persona').notNull(),
    hiddenRequirements: text('hidden_requirements').notNull(),
    rubric: text('rubric', { mode: 'json' }).$type<ArtifactRubric[]>(),
    ticketTitle: text('ticket_title'),
    ticketBody: text('ticket_body'),
    acceptanceCriteria: text('acceptance_criteria'),
    repoPath: text('repo_path'),
    repoCommit: text('repo_commit'),
    hiddenTestsPath: text('hidden_tests_path'),
    testCommand: text('test_command'),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
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
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    humanIntervened: integer('human_intervened', { mode: 'boolean' }).notNull().default(false),
    // dashboard 生成并通过 --session-id 传给 claude；sessions 行由 Ingester 稍后写入，因此这里不加外键
    sessionId: text('session_id').notNull().unique(),
    workspacePath: text('workspace_path').notNull(),
    linearIssueId: text('linear_issue_id'),
    linearIssueIdentifier: text('linear_issue_identifier'),
    githubRepo: text('github_repo'),
    prUrl: text('pr_url'),
    costUsd: real('cost_usd').notNull().default(0),
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
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    // 主 jsonl 已解析到的字节偏移量
    parseOffset: integer('parse_offset').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_source_idx').on(t.sourceId),
    index('sessions_run_idx').on(t.runId),
    index('sessions_started_at_idx').on(t.startedAt),
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
    parentToolUseId: text('parent_tool_use_id'),
    agentType: text('agent_type'),
    parseOffset: integer('parse_offset').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.agentId] })],
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
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
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
    index('requests_session_seq_idx').on(t.sessionId, t.seq),
    index('requests_session_agent_idx').on(t.sessionId, t.agentId),
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
    stage: text('stage').notNull(),
    startSeq: integer('start_seq').notNull(),
    // 实时运行中仍在进行的阶段为空
    endSeq: integer('end_seq'),
    method: text('method', { enum: ['artifact', 'llm'] }).notNull(),
    evidence: text('evidence', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stage_spans_session_workflow_stage_idx').on(t.sessionId, t.workflow, t.stage),
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
    currentStage: text('current_stage').notNull(),
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

// agent 的提问与模拟用户或人的回答
export const runMessages = sqliteTable(
  'run_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['agent', 'simulated_user', 'human'] }).notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_messages_run_seq_idx').on(t.runId, t.seq)],
);

export const artifactKinds = ['brief', 'research', 'plan', 'tickets', 'pr', 'repo'] as const;

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
  },
  (t) => [uniqueIndex('artifacts_run_kind_idx').on(t.runId, t.kind)],
);

// lfg：每个产物的每个 rubric 条目一行；ic：每个 run 一行测试结果与终点判定
export const grades = sqliteTable(
  'grades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['rubric', 'ic_tests'] }).notNull(),
    artifactId: integer('artifact_id').references(() => artifacts.id, { onDelete: 'cascade' }),
    rubricItemId: text('rubric_item_id'),
    score: real('score'),
    maxScore: real('max_score'),
    reasoning: text('reasoning'),
    judgeModel: text('judge_model'),
    testsPassed: integer('tests_passed'),
    testsTotal: integer('tests_total'),
    reachedEnd: integer('reached_end', { mode: 'boolean' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('grades_run_idx').on(t.runId),
    uniqueIndex('grades_artifact_item_idx').on(t.artifactId, t.rubricItemId),
  ],
);
