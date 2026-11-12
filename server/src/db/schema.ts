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

// The two built-in workflows, which are also the two eval kinds: the rough classification of the Sessions list uses
// them (configurable workflows are in workflowTable)
export const workflows = ['lfg', 'ic'] as const;
export type Workflow = (typeof workflows)[number];
const evalKinds = workflows;

export interface ToolCall {
  // tool_use.id
  id: string;
  name: string;
  input: unknown;
  // Text of the paired tool_result, truncated to 20000 characters; null until it returns
  result: string | null;
  // Character count before truncation
  resultChars: number;
  isError: boolean;
  // File path when the result spilled to <sessionId>/tool-results/
  spillPath: string | null;
  // agent_id of the subagent an Agent/Task call corresponds to
  subagentId: string | null;
}

// State incremental parsing keeps between two reads, one per jsonl file
export interface ParseState {
  // seq of the next request row within the same (session, agent)
  nextSeq: number;
  // Time of the last user message or tool_result, for computing duration
  lastUserAt: number | null;
  // tool_use.id -> message.id of calls without a result yet
  pending: Record<string, string>;
  // Forked subagents: the jsonl starts with a copy of the parent's conversation, which belongs to the parent up to the
  // tool_result of the Agent call that forked it (the parent's tool_use.id) and is skipped; removed once that
  // tool_result is read
  forkToolUseId?: string;
}

// A model request in a Codex rollout waiting to be written (Contracts 25.2): replies, reasoning and tool calls after
// the last token_usage_record and before the next
export interface CodexPendingRequest {
  text: string | null;
  thinking: string | null;
  toolCalls: ToolCall[];
}

// Incremental parsing state of a Codex rollout (Contracts 25.2)
export interface CodexParseState {
  kind: 'codex';
  nextSeq: number;
  // Time of the last user input or tool output: a request's duration counts from it
  lastUserAt: number | null;
  // The current turn's model (turn_context.model)
  model: string | null;
  // The request being formed
  open: CodexPendingRequest;
  // Tool calls without output yet: call_id -> response_id of their request; an empty string while still in open
  pending: Record<string, string>;
}

export type SessionParseState = ParseState | CodexParseState;

export const sessionEngines = ['claude', 'codex'] as const;
export type SessionEngine = (typeof sessionEngines)[number];

// Rubrics grouped by artifact, defined in the task schema
import type { ArtifactRubric, IcTaskSource } from '../tasks/schema.js';
export type { ArtifactRubric, RubricItem } from '../tasks/schema.js';
import type { CrossRunRef, IcCriteriaDetail, IcDetail, SourceRef } from '../grading/schema.js';
import type { WorkflowDefinition } from '../workflows/schema.js';
import type { HostCheck } from '../remote/views.js';

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);

// Whether each session is in the management table (Contracts 25.1): importing records the import time and clears the
// cleared time; clearing deletes the sessions record and leaves the cleared time in this row, so incremental imports
// skip it. Does not reference sessions: after clearing, sessions has no such row
export const sessionImports = sqliteTable('session_imports', {
  sessionId: text('session_id').primaryKey(),
  engine: text('engine', { enum: sessionEngines }).notNull(),
  filePath: text('file_path').notNull(),
  importedAt: integer('imported_at', { mode: 'timestamp_ms' }).notNull(),
  clearedAt: integer('cleared_at', { mode: 'timestamp_ms' }),
});

// Workflows (Contracts 16.1): the entry command and substage definitions; the built-in lfg and ic are written from
// YAML at service start
export const workflowTable = sqliteTable('workflows', {
  // Also the entry command /<id>
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Eval kind (16.2): only the built-in lfg and ic have one; without it a workflow cannot be evaluated and serves only
  // Live, stage partition and analysis
  evalKind: text('eval_kind', { enum: evalKinds }),
  // The definition after WorkflowDefinition validation
  definition: text('definition', { mode: 'json' }).$type<WorkflowDefinition>().notNull(),
  // Basic description (Contracts 18.3); the built-in lfg and ic take the description from their yaml when first
  // written
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  // A deleted workflow keeps a row only to show its name (Contracts 24.5); it no longer appears in lists and pickers,
  // and its id cannot be reused
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
});

// The latest check of lfg and ic for the newest txe-workflow release (Contracts 29.1), one row per workflow
export const workflowReleases = sqliteTable('workflow_releases', {
  workflowId: text('workflow_id')
    .primaryKey()
    .references(() => workflowTable.id),
  // The Latest release read last time; empty until one has been read
  tag: text('tag'),
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull(),
  // The error of the latest failed check, import or build; empty after a success
  error: text('error'),
});

// SSH hosts (Contracts 31.1): Live items can run on them. After deletion, host_id in live_sessions and sessions keeps
// its value (it does not reference this table) and pages show a deleted host
export const sshHosts = sqliteTable('ssh_hosts', {
  // h-<yyyymmdd>-<6 characters>
  id: text('id').primaryKey(),
  // user@host, or a Host name from ~/.ssh/config
  target: text('target').notNull().unique(),
  // target by default, editable
  label: text('label').notNull(),
  createdAt: createdAt(),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
  // The latest check result (Contracts 31.2)
  check: text('check', { mode: 'json' }).$type<HostCheck>(),
});

// A mirror of tasks/<id>/task.yaml, synced at startup by tasks/loader.ts; fields the eval kind does not need are empty
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    // The task's eval kind (Contracts 16.3)
    kind: text('kind', { enum: evalKinds }).notNull(),
    title: text('title').notNull(),
    persona: text('persona').notNull(),
    hiddenRequirements: text('hidden_requirements').notNull(),
    input: text('input'),
    rubric: text('rubric', { mode: 'json' }).$type<ArtifactRubric[]>(),
    ticketTitle: text('ticket_title'),
    ticketBody: text('ticket_body'),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>(),
    // Relative to the task directory
    repoPath: text('repo_path'),
    repoCommit: text('repo_commit'),
    // Source ticket and source repo of an ic task imported from Linear
    source: text('source', { mode: 'json' }).$type<IcTaskSource>(),
    requiredChecks: text('required_checks', { mode: 'json' }).$type<string[]>(),
    // Empty below for ic tasks without hidden tests
    hiddenTestsDir: text('hidden_tests_dir'),
    hiddenTestsConfig: text('hidden_tests_config'),
    testCommand: text('test_command'),
    hiddenTestsTimeoutSeconds: integer('hidden_tests_timeout_seconds'),
    hiddenTestsManifest: text('hidden_tests_manifest', { mode: 'json' }).$type<
      Record<string, string[]>
    >(),
    // Absolute path of the task directory
    dir: text('dir').notNull(),
    // sha256 of task.yaml; the row is not rewritten when the content is unchanged
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
    // Unique within the workflow
    name: text('name').notNull(),
    // Basic description (Contracts 18.3), edited on the variant page
    description: text('description'),
    // The workflow it belongs to (Contracts 16.4); the variants module checks it exists
    workflowId: text('workflow_id').notNull(),
    // The directory data/variants/<storage_id> holding src, build output and the isolated home; its own id when empty.
    // The migrated lfg and ic variants share one (16.4); editing or building either copies out its own and clears this
    storageId: text('storage_id'),
    // Points at the source when saved as a new variant
    parentId: text('parent_id').references((): AnySQLiteColumn => variants.id, {
      onDelete: 'set null',
    }),
    // The exported txe-workflow commit; variants of any workflow have one skill set (18.6) and an empty string
    baseCommit: text('base_commit').notNull(),
    // sha256 of the skills/ tree
    skillsHash: text('skills_hash').notNull(),
    // Built-in lfg and ic: <base>-eval.<hash8>; any workflow: skills.<hash8>
    version: text('version').notNull(),
    status: text('status', { enum: ['draft', 'frozen'] })
      .notNull()
      .default('draft'),
    installDir: text('install_dir'),
    buildStatus: text('build_status', { enum: ['none', 'building', 'built', 'failed'] })
      .notNull()
      .default('none'),
    // The skills hash of the latest successful build; differing from skills_hash means the build is stale
    builtHash: text('built_hash'),
    buildError: text('build_error'),
    builtAt: integer('built_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    frozenAt: integer('frozen_at', { mode: 'timestamp_ms' }),
    // Points at the analysis when created by its "Save as variant" (Contracts 15.3)
    analysisId: text('analysis_id').references((): AnySQLiteColumn => analyses.id, {
      onDelete: 'set null',
    }),
    // Points at the session when created from a session's skills (Contracts 15.1); the session may not be imported yet,
    // so no foreign key
    sourceSessionId: text('source_session_id'),
    // Points at the draft when saved from a Codex draft (Contracts 17.4)
    draftId: text('draft_id').references((): AnySQLiteColumn => workflowDrafts.id, {
      onDelete: 'set null',
    }),
    // A deleted variant keeps a row (Contracts 24.3): runs, analyses, Live items, child variants and drafts get its
    // name by id and show "<name> (deleted)"; it no longer appears in lists and pickers
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    // The tag of an automatically imported txe-workflow release (Contracts 29.1); empty for manual imports and other
    // sources
    releaseTag: text('release_tag'),
    // "Include Orca's skills" (Contracts 35.5): the build puts Orca's own orchestration and orca-cli skills into the
    // install; orca_version is the Orca version the latest successful build put in, empty when none
    orcaSkills: integer('orca_skills', { mode: 'boolean' }).notNull().default(false),
    orcaVersion: text('orca_version'),
  },
  (t) => [
    index('variants_skills_hash_idx').on(t.skillsHash),
    // Names are unique only among variants not deleted: a new variant can reuse a deleted one's name
    uniqueIndex('variants_workflow_name_idx')
      .on(t.workflowId, t.name)
      .where(sql`${t.deletedAt} is null`),
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

// The content of GET / PUT /api/settings; a single row with id = 1, defaults when it is missing
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

// Grading status (Contracts 7.6): none is never graded, running is grading, done is graded, failed hit an error
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
    // Which repetition of the same (task, variant) within the batch, from 0
    repeatIndex: integer('repeat_index').notNull(),
    // claude's --model (alias) and --effort, chosen when starting the batch (Contracts 16.5)
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    status: text('status', { enum: runStatuses }).notNull().default('queued'),
    humanIntervened: integer('human_intervened', { mode: 'boolean' }).notNull().default(false),
    // Generated by the dashboard and passed to claude with --session-id; the Ingester writes the sessions row later, so
    // no foreign key here
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
    // Read the source ticket, repo or PR (Contracts section 13); compare excludes these by default
    sourceRefs: text('source_refs', { mode: 'json' })
      .$type<SourceRef[]>()
      .notNull()
      .default(sql`'[]'`),
    // Runs where the eval environment itself failed and that do not represent the variant are marked invalid by the
    // user (Contracts 7.12); compare always excludes them
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
// The program running in a Live item's terminal: Claude Code or Codex (Contracts 17.3)
export const liveEngines = ['claude', 'codex'] as const;
export type LiveEngine = (typeof liveEngines)[number];
// A Live item's purpose (Contracts 14.3): interaction does work with a workflow (new, imported, resumed); design is a
// Codex draft of section 17; optimize a Codex optimize session of 19.3; agent a Magi Agent session of section 23;
// orca an item the dashboard created for an Orca collaboration (Contracts 35.3), i.e. not a main agent or worker the
// dashboard started
export const livePurposes = ['interaction', 'design', 'optimize', 'agent', 'orca'] as const;
export type LivePurpose = (typeof livePurposes)[number];

// Live (Contracts 14.1): a Live item corresponds to one Claude Code session, is not graded and not compared.
// An item can have several processes over time (the first start, then each resume), see live_processes.
// Foreign keys do not cascade: when a migration rebuilds this table, referencing rows must stay as they are
export const liveSessions = sqliteTable(
  'live_sessions',
  {
    // l-<yyyymmdd>-<6 characters>: also the name of the copied repo, the ticket copy and the vault directory
    id: text('id').primaryKey(),
    // With engine codex, the Codex session id (session_meta.payload.id of the rollout under CODEX_HOME/sessions); a
    // Codex draft's item has none until the draft is prepared and Codex first writes its session record (Contracts
    // 17.1)
    claudeSessionId: text('claude_session_id').unique(),
    engine: text('engine', { enum: liveEngines }).notNull().default('claude'),
    purpose: text('purpose', { enum: livePurposes }).notNull().default('interaction'),
    // Editable by the user (Contracts 14.3); defaults to the first 40 characters of the input, or the session's title
    // for items started from an existing session
    title: text('title').notNull(),
    environment: text('environment', { enum: liveEnvironments }).notNull(),
    // The workflow id chosen when created (Contracts 16.7); empty for items started from an existing session
    workflow: text('workflow'),
    input: text('input'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    cwd: text('cwd').notNull(),
    createdAt: createdAt(),
    // Updated on creation, each process start and end, and renames; the list sorts by it descending
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    // When the user closed it in Live ("×"): only hidden from the list, nothing deleted (Contracts 14.5); cleared on
    // resume or another import
    hiddenAt: integer('hidden_at', { mode: 'timestamp_ms' }),
    // The configuration of a Magi Agent session (Contracts 23.1): local or a variant id; empty for other purposes
    agentConfig: text('agent_config'),
    // The SSH host it runs on (Contracts 31.3); empty for this machine
    hostId: text('host_id'),
    // The goal handed to the simulated user (Contracts 34.2): written the first time an item with no task is handed
    // over, editable later; items with a task use its persona and hidden requirements and leave this empty
    simulatedGoal: text('simulated_goal'),
    // This item's Orca terminal (Contracts 35.2, 35.3): for items the dashboard started, its identity terminal (of the
    // latest process; empty without an Orca identity); for main agents and workers in Orca, the terminal they run in
    orcaTerminalHandle: text('orca_terminal_handle'),
    // The Run of an Orca worker and the item of the main agent that dispatched it; empty otherwise
    orcaRunId: text('orca_run_id'),
    orcaParentLiveId: text('orca_parent_live_id'),
  },
  (t) => [index('live_sessions_updated_at_idx').on(t.updatedAt)],
);

export const liveProcessKinds = ['start', 'resume'] as const;
export type LiveProcessKind = (typeof liveProcessKinds)[number];

// Each run of an item; an item has at most one running process at a time
export const liveProcesses = sqliteTable(
  'live_processes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    liveId: text('live_id')
      .notNull()
      .references(() => liveSessions.id),
    kind: text('kind', { enum: liveProcessKinds }).notNull(),
    // Empty means the local configuration (the user's own ~/.claude)
    variantId: text('variant_id').references(() => variants.id, { onDelete: 'restrict' }),
    // The --model and --effort actually passed to claude (Contracts 16.5); empty for the local configuration, which
    // passes none
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
  // Auto-stop after every page closes (Contracts 14.3); payload records when the last connection dropped
  'auto-stop',
  // "Stop process" (Contracts 14.3, 31.4); payload source names where it came from: page for the page button, api for
  // a direct API call
  'stop',
  // Resuming the Magi Agent session when the service restarts after a deploy (Contracts 23.5); payload is the deploy
  // id and the merge commit
  'deploy',
  // Processes on SSH hosts (Contracts 31.4): the connection between this machine and the remote drops and comes back;
  // meanwhile the remote process keeps running in tmux
  'disconnect',
  'reconnect',
  // The Orca identity terminal the dashboard created for this item when the process started (Contracts 35.2); payload
  // handle is the terminal handle, or empty with reason stating why when there is no Orca identity. The topology maps
  // a Run's main agent to this item by it
  'orca-identity',
  // An agent in an Orca pane whose terminal Orca no longer lists while its pid is still running (W116); payload is the
  // handle, the pid and the reason. The process is left running and is not stopped; one event per process
  'orca-pane-gone',
  // Input typed in a worker Orca runs without a pane (Contracts 35.4): it is sent as a message to the worker's
  // Dispatch; payload is the text, the Dispatch and what Orca did with it
  'orca-worker-input',
] as const;
export type LiveEventKind = (typeof liveEventKinds)[number];

// Every driver switch, hook, simulated user answer (with cost), rename and import; renames and imports belong to no
// process and have an empty process_id
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

// Variant history (Contracts 16.4, 17.4): one table holds two kinds of record, told apart by kind. A rename records
// the old and new names; before an overwrite or restore, the previous src/ is saved to
// data/variant-history/<variantId>/<snapshot>/ and payload records the snapshot directory and the source. kind and
// payload are both text in SQLite, so new kinds need no migration
export const variantEventKinds = ['rename', 'overwrite', 'restore'] as const;
export type VariantEventKind = (typeof variantEventKinds)[number];
export type VariantEventPayload =
  | { from: string; to: string }
  // draftEngine: the draft's engine (Contracts 28.4); earlier overwrites did not record it
  | { snapshot: string; draftId: string; draftEngine?: LiveEngine; analysisId: string | null }
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

// optimize: an analysis report handed to Codex for optimizing (Contracts 19.3); the directory is the analysis
// directory, and saving makes a new variant of the original workflow or a new workflow depending on whether
// optimize/workflow.yaml changed
export const draftModes = ['workflow', 'variant', 'optimize'] as const;
export type DraftMode = (typeof draftModes)[number];
// preparing: the draft directory is being prepared in the background; open: chat with Codex and save; failed: a
// preparation step failed and can be retried from that step (Contracts 17.1)
export const draftStatuses = ['preparing', 'open', 'saved', 'failed'] as const;
export type DraftStatus = (typeof draftStatuses)[number];

// One step of draft preparation: copy src, write instructions and examples, install each skill, start Codex
export interface DraftStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  // The error of the failed step
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

// The version of a skill installed into the draft directory when started (Contracts 17.3)
export interface DraftSkillVersion {
  name: string;
  source: string;
  // computedHash from skills-lock.json
  computedHash: string;
  // git ls-remote <source> HEAD at install time
  commit: string;
}

// Drafts of a workflow or variant generated with Codex (Contracts 17.1): directory data/workflow-drafts/<id>/
export const workflowDrafts = sqliteTable('workflow_drafts', {
  // d-<yyyymmdd>-<6 characters>
  id: text('id').primaryKey(),
  mode: text('mode', { enum: draftModes }).notNull(),
  // With mode workflow, the id of the workflow to create; with mode variant, the workflow it belongs to
  workflowId: text('workflow_id').notNull(),
  // With mode workflow, the new workflow's name (written into workflow.yaml while preparing); empty with mode variant
  name: text('name'),
  // With mode workflow, the new workflow's description (written to workflows.description on save, Contracts 18.3)
  description: text('description'),
  // With mode variant, the base variant; empty with mode workflow, where the draft starts from a blank skeleton
  // (Contracts 18.5)
  baseVariantId: text('base_variant_id').references(() => variants.id, { onDelete: 'restrict' }),
  requirement: text('requirement').notNull(),
  // The Codex session in Live; cleared when the Live item is deleted, the draft stays. No foreign key: a migration
  // rebuilding live_sessions must not change this along
  liveId: text('live_id'),
  // New drafts are written as preparing; the column default keeps open from W42
  status: text('status', { enum: draftStatuses }).notNull().default('open'),
  // The error of the failed preparation step; empty otherwise
  error: text('error'),
  // The preparation steps and their progress
  steps: text('steps', { mode: 'json' })
    .$type<DraftStep[]>()
    .notNull()
    .default(sql`'[]'`),
  savedWorkflowId: text('saved_workflow_id'),
  // The latest variant saved; every variant saved points back to the draft through variants.draft_id
  savedVariantId: text('saved_variant_id'),
  skills: text('skills', { mode: 'json' })
    .$type<DraftSkillVersion[]>()
    .notNull()
    .default(sql`'[]'`),
  // With mode optimize, the analysis being optimized (Contracts 19.3): the draft directory is data/analyses/<id>/
  analysisId: text('analysis_id').references((): AnySQLiteColumn => analyses.id, {
    onDelete: 'restrict',
  }),
  // The session's engine (Contracts 22.1): chosen when started, the Live item's engine follows it; existing drafts are
  // all Codex
  engine: text('engine', { enum: liveEngines }).notNull().default('codex'),
  // The workflow-design (mode workflow, variant) or workflow-optimize (mode optimize) variant the session uses
  // (Contracts 33.2): skills come from it and the session is bound to it. Drafts before migration 0027 are recorded as
  // the matching baseline at service start
  designVariantId: text('design_variant_id').references(() => variants.id, {
    onDelete: 'restrict',
  }),
  createdAt: createdAt(),
});

// run: the variant used by run and Live sessions; auto: the skill bodies matched a variant byte for byte at import;
// manual: chosen or unbound by the user
export const variantBindings = ['run', 'auto', 'manual'] as const;
export type VariantBinding = (typeof variantBindings)[number];

export const sessions = sqliteTable(
  'sessions',
  {
    // Claude Code's sessionId; for Codex, session_meta.payload.id of the rollout
    id: text('id').primaryKey(),
    // Contracts 25.2: Claude Code's jsonl or Codex's rollout
    engine: text('engine', { enum: sessionEngines }).notNull().default('claude'),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    // A session created (or resumed) by Live points at the latest Live item
    liveId: text('live_id').references(() => liveSessions.id, { onDelete: 'set null' }),
    filePath: text('file_path').notNull().unique(),
    cwd: text('cwd'),
    // The first 80 characters of the first user message
    title: text('title'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
    // Rough classification: markers of lfg / ic stages appear (last item of System Design section 5)
    hasLfg: integer('has_lfg', { mode: 'boolean' }).notNull().default(false),
    hasIc: integer('has_ic', { mode: 'boolean' }).notNull().default(false),
    // The byte offset the main jsonl has been parsed to
    parseOffset: integer('parse_offset').notNull().default(0),
    parseState: text('parse_state', { mode: 'json' }).$type<SessionParseState>().notNull(),
    // The bound variant (Contracts 15.1); manual with an empty variant_id means the user unbound it
    variantId: text('variant_id').references(() => variants.id, { onDelete: 'set null' }),
    variantBinding: text('variant_binding', { enum: variantBindings }),
    // When codex archive archived a Codex session (Contracts 25.3); not shown in the list by default
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    // A session from an SSH host (Contracts 31.6): file_path is the copy under data/remote/<hostId>/, remote_path the
    // remote original
    hostId: text('host_id'),
    remotePath: text('remote_path'),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_variant_idx').on(t.variantId),
    index('sessions_run_idx').on(t.runId),
    index('sessions_started_at_idx').on(t.startedAt, t.id),
  ],
);

// <sessionId>/subagents/agent-<id>.jsonl, each with its own parse offset
export const subagents = sqliteTable(
  'subagents',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    filePath: text('file_path').notNull().unique(),
    // toolUseId from agent-<id>.meta.json, pointing back at the tool call in the parent session
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

// One row per model request, deduplicated by message.id
export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    seq: integer('seq').notNull(),
    // Empty for the main agent
    agentId: text('agent_id'),
    // Time of the message's first record
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    // Time of the user message or tool_result that triggered it; used to recompute duration when merging increments
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
    // A forked subagent's jsonl starts with a copy of the parent's conversation, so the same message.id can appear in
    // different agents; the main agent's agent_id is empty and the unique constraint compares it as an empty string
    uniqueIndex('requests_session_agent_message_idx').on(
      t.sessionId,
      sql`(case when ${t.agentId} is null then '' else ${t.agentId} end)`,
      t.messageId,
    ),
    index('requests_session_agent_seq_idx').on(t.sessionId, t.agentId, t.seq),
  ],
);

// user records in the jsonl that are neither tool_result nor isMeta: user messages (including simulated user and
// human answers) and system events Claude Code generates itself (background task notifications, local command output)
export const userMessages = sqliteTable(
  'user_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Empty for the main agent
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

// The call that entered a stage: a Skill call or a slash command the user typed
export interface StageEvidence {
  seq: number;
  kind: 'skill' | 'command';
  text: string;
}

// Folding state of the stage partition (StageState of stages/partition): main requests folded up to folded_seq.
// state records the workflows used and the hash of each definition (Contracts 16.6); a changed binding or definition
// recomputes from the start
export const stageStates = sqliteTable('stage_states', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).notNull(),
  foldedSeq: integer('folded_seq').notNull(),
  // Time of the folded_seq request: user messages after it are not folded yet
  foldedAt: integer('folded_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// One round of a workflow: a session can have several rounds
export const stageCycles = sqliteTable(
  'stage_cycles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // workflow id
    workflow: text('workflow').notNull(),
    // From 1
    cycle: integer('cycle').notNull(),
    label: text('label').notNull(),
    startSeq: integer('start_seq').notNull(),
    // Up to the start of the next round, or the session's last request
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
    // The round it belongs to, matching stage_cycles.cycle
    cycle: integer('cycle').notNull(),
    stage: text('stage').notNull(),
    status: text('status', { enum: stageStatuses }).notNull(),
    // Main session seq, ends inclusive; skipped is [s, s-1], not-reached is empty
    startSeq: integer('start_seq'),
    endSeq: integer('end_seq'),
    // How many times this stage was called (fix-pr's fix rounds); 0 for skipped and not-reached
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

// One AskUserQuestion question, as in Claude Code's tool input
export interface AskQuestion {
  question: string;
  header?: string | undefined;
  options: { label: string; description?: string | undefined }[];
  multiSelect?: boolean | undefined;
}

// run_messages.payload: AskUserQuestion questions and answers, or the structured content of a system event
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

// The agent's questions, the simulated user's or a human's answers, refused tool requests and system events during
// the run
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
    // Cost of the simulated user call
    costUsd: real('cost_usd').notNull().default(0),
    payload: text('payload', { mode: 'json' }).$type<RunMessagePayload>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_messages_run_seq_idx').on(t.runId, t.seq)],
);

// Artifacts graded by rubric use the rubric group id as kind (the id of artifacts in the eval kind's rubric block,
// e.g. brief, research). The other kinds are fixed: ticket is the Linear ticket identifier; friction is an issue or
// comment the agent under test filed on txehq/txe-workflow, possibly several per run, while other kinds have one per
// run; acceptance is the acceptance report published to engapp.dev; pr_snapshot holds the PR's reviews, comments and
// checks when grading starts (json, Contracts 15.2), with location the repo address
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
    // File path or URL
    location: text('location').notNull(),
    snapshot: text('snapshot'),
    createdAt: createdAt(),
    // When the content snapshot was last rewritten
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
  },
  (t) => [uniqueIndex('artifacts_run_kind_location_idx').on(t.runId, t.kind, t.location)],
);

// rubric: one row per rubric artifact (one judge call; no call when the artifact is missing); with hidden tests, the
// test result (kind ic); when grading by acceptance criteria, one judge call (kind ic_criteria, item scores in
// grade_items); with neither and pr-endpoint chosen, the end point check (kind endpoint). An empty reached_end means
// the eval kind has no pr-endpoint (Contracts 16.2)
export const gradeKinds = ['rubric', 'ic', 'ic_criteria', 'endpoint'] as const;

export const grades = sqliteTable(
  'grades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: gradeKinds }).notNull(),
    // The rubric's artifact group (rubric group id); empty otherwise
    artifact: text('artifact'),
    // Empty when the artifact did not exist at grading
    artifactId: integer('artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
    judgeModel: text('judge_model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    testsPassed: integer('tests_passed'),
    testsDeclared: integer('tests_declared'),
    reachedEnd: integer('reached_end', { mode: 'boolean' }),
    icDetail: text('ic_detail', { mode: 'json' }).$type<IcDetail>(),
    // The PR of ic_criteria, the end point check and the check results the judge saw
    criteriaDetail: text('criteria_detail', { mode: 'json' }).$type<IcCriteriaDetail>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('grades_run_idx').on(t.runId),
    uniqueIndex('grades_run_artifact_idx').on(t.runId, t.artifact),
  ],
);

// Scores of rubric items; criterion and max_score are a snapshot of the rubric at grading
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

// The body Claude Code writes into a session each time a skill loads (Contracts 15.1): the isMeta user record after a
// Skill call or slash command. text is everything after "Base directory for this skill: <dir>\n\n": the SKILL.md body
// without frontmatter and leading newlines; with arguments, $ARGUMENTS in the body is replaced, otherwise
// "\n\nARGUMENTS: <args>" is appended
export const sessionSkills = sqliteTable(
  'session_skills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Empty for the main agent
    agentId: text('agent_id'),
    uuid: text('uuid').notNull(),
    // The last segment of Base directory
    name: text('name').notNull(),
    baseDir: text('base_dir').notNull(),
    text: text('text').notNull(),
    // input.args of the Skill call or <command-args> of the slash command; an empty string without arguments
    args: text('args').notNull(),
    // A skill Codex injected with a <skill> message (the user mentioned it as $<skill>, Contracts 16.6): the stage
    // partition treats it as this round's entry
    injected: integer('injected', { mode: 'boolean' }).notNull().default(false),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('session_skills_session_uuid_idx').on(t.sessionId, t.uuid)],
);

// Sessions whose skill bodies were already extracted: sessions imported before this table get one extraction at
// service start
export const sessionSkillScans = sqliteTable('session_skill_scans', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  // The Codex session's rollout has been read from the start for <skill> injections (Contracts 16.6); earlier imports
  // are read once more at service start
  injectionsScanned: integer('injections_scanned', { mode: 'boolean' }).notNull().default(false),
});

export const analysisEngines = ['claude', 'codex'] as const;
export type AnalysisEngine = (typeof analysisEngines)[number];

export const analysisStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AnalysisStatus = (typeof analysisStatuses)[number];

// The aspects and steps of an analysis are the substages of the chosen session-analysis variant (Contracts 19.2): one
// step per aspect, and the last substage synthesize produces the report and change suggestions. Analyses before W45
// had process, efficiency, interaction, quality and synthesis

export interface AnalysisTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Codex's reasoning_output_tokens (already included in output); 0 for Claude Code
  reasoning: number;
}

export interface AnalysisStep {
  // Substage id (process, efficiency, interaction, quality, synthesis before W45)
  key: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number | null;
  endedAt: number | null;
  tokens: AnalysisTokens;
  // Empty when Codex has no price
  costUsd: number | null;
  // Number of events the engine produced; shows progress while running
  events: number;
  error: string | null;
}

export const analyses = sqliteTable('analyses', {
  // a-<yyyymmdd>-<6 lowercase letters or digits>
  id: text('id').primaryKey(),
  engine: text('engine', { enum: analysisEngines }).notNull(),
  model: text('model').notNull(),
  // The analysed variant; empty for analyses of local configuration sessions (Contracts 25.4)
  variantId: text('variant_id').references((): AnySQLiteColumn => variants.id, {
    onDelete: 'restrict',
  }),
  sessionIds: text('session_ids', { mode: 'json' }).$type<string[]>().notNull(),
  status: text('status', { enum: analysisStatuses }).notNull().default('queued'),
  error: text('error'),
  steps: text('steps', { mode: 'json' }).$type<AnalysisStep[]>().notNull(),
  costUsd: real('cost_usd'),
  // The session-analysis variant driving this analysis (Contracts 19.2); empty for analyses before W45
  analysisVariantId: text('analysis_variant_id').references((): AnySQLiteColumn => variants.id, {
    onDelete: 'restrict',
  }),
  // output/report.json written by synthesize (validated); empty for analyses before W45 and unsuccessful ones
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

// output/report.json (Contracts 19.2): the changes in patches.json all "change the variant"; workflowChanges are
// suggestions that "need a new workflow"
export interface AnalysisReport {
  summary: string;
  goal: string;
  outcome: (typeof analysisOutcomes)[number];
  topIssues: { title: string; findingIds: string[]; impact: string }[];
  workflowChanges: { findingIds: string[]; rationale: string; change: string }[];
}

export interface FindingEvidence {
  sessionId: string;
  // The main agent's seq; subagent requests are referenced by the main request that started them
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
    // <aspect>-<n>, n being the finding's position in that aspect's output file, from 1; findingIds of change
    // suggestions reference it
    findingId: text('finding_id').notNull(),
    // Substage id of the chosen session-analysis variant (process, efficiency, interaction, quality before W45)
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
    // Path relative to skills/, e.g. ic/SKILL.md
    file: text('file').notNull(),
    findingIds: text('finding_ids', { mode: 'json' }).$type<string[]>().notNull(),
    rationale: text('rationale').notNull(),
    // A unified diff relative to input/skills/
    patch: text('patch').notNull(),
  },
  (t) => [index('analysis_patches_analysis_idx').on(t.analysisId)],
);

// Deploy status (Contracts 23.5): running runs a step; failed had a step fail; restarting is merged and the service
// exited with code 75, waiting to resume after restart; done has resumed after restart
export const magiDeployStatuses = ['running', 'failed', 'restarting', 'done'] as const;
export type MagiDeployStatus = (typeof magiDeployStatuses)[number];

export const magiDeployStepStatuses = ['pending', 'running', 'done', 'failed'] as const;
export interface MagiDeployStep {
  id: string;
  label: string;
  status: (typeof magiDeployStepStatuses)[number];
  // The error on failure; on success the step's result (e.g. the merge commit)
  output: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export const magiDeploys = sqliteTable('magi_deploys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // The Magi Agent session that started the deploy, resumed after it
  liveId: text('live_id')
    .notNull()
    .references(() => liveSessions.id),
  engine: text('engine', { enum: liveEngines }).notNull(),
  status: text('status', { enum: magiDeployStatuses }).notNull(),
  steps: text('steps', { mode: 'json' }).$type<MagiDeployStep[]>().notNull(),
  // The error of the failed step
  error: text('error'),
  // Output of pnpm check, data/magi-agent/deploy-<time>.log
  logFile: text('log_file').notNull(),
  // The merge commit in the main repo and the database backup
  commit: text('commit'),
  backupFile: text('backup_file'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
});

// Linear stats (Contracts section 37): the team's issues as read by the last sync that saved them (37.2)
export const teamIssues = sqliteTable(
  'team_issues',
  {
    // Linear's issue UUID
    id: text('id').primaryKey(),
    // TXE-123 and 123
    identifier: text('identifier').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    status: text('status').notNull(),
    // Linear's state type: triage, backlog, unstarted, started, completed, canceled, duplicate
    statusType: text('status_type').notNull(),
    // Names as the issue reported them; team_users names take precedence (37.3)
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    creatorId: text('creator_id'),
    creatorName: text('creator_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    canceledAt: integer('canceled_at', { mode: 'timestamp_ms' }),
    // Compared with the listing's updatedAt: an unchanged issue is not read again
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('team_issues_identifier_idx').on(t.identifier)],
);

// An issue's state history in order (get_issue stateHistory); endedAt is null for the current state
export const teamIssueStates = sqliteTable(
  'team_issue_states',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => teamIssues.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.seq] })],
);

// PRs an issue links to: its attachments of the form https://github.com/<owner>/<repo>/pull/<n>
export const teamIssuePrs = sqliteTable(
  'team_issue_prs',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => teamIssues.id, { onDelete: 'cascade' }),
    prUrl: text('pr_url')
      .notNull()
      .references(() => teamPrs.url),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.prUrl] }),
    index('team_issue_prs_pr_idx').on(t.prUrl),
  ],
);

export const teamPrStates = ['open', 'closed'] as const;

// A PR as gh api repos/<owner>/<repo>/pulls/<n> returned it. readError holds gh's text for a 404 or 403, and the PR
// is then left out of the counts (37.2). githubId identifies the same PR linked by two URLs (a renamed org or repo)
export const teamPrs = sqliteTable('team_prs', {
  url: text('url').primaryKey(),
  repo: text('repo').notNull(),
  number: integer('number').notNull(),
  githubId: integer('github_id'),
  state: text('state', { enum: teamPrStates }),
  draft: integer('draft', { mode: 'boolean' }),
  mergedAt: integer('merged_at', { mode: 'timestamp_ms' }),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  additions: integer('additions'),
  deletions: integer('deletions'),
  authorLogin: text('author_login'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  readAt: integer('read_at', { mode: 'timestamp_ms' }).notNull(),
  readError: text('read_error'),
});

export const teamUsers = sqliteTable('team_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  active: integer('active', { mode: 'boolean' }).notNull(),
});

// running is in progress; interrupted was stopped by a server shutdown (or found running at startup); failed holds the
// original error text. Only one sync runs at a time (37.2)
export const teamSyncStatuses = ['running', 'succeeded', 'failed', 'interrupted'] as const;
export type TeamSyncStatus = (typeof teamSyncStatuses)[number];

export interface TeamSyncProgress {
  // Issues in the listing, issues among them to read (new or updated since saved), issues read and saved
  listed: number;
  toRead: number;
  read: number;
  // PRs read from GitHub
  prsRead: number;
}

export const teamSync = sqliteTable('team_sync', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: teamSyncStatuses }).notNull(),
  // Issues listed after this time (the start of the last succeeded sync); null for a full sync
  updatedAfter: integer('updated_after', { mode: 'timestamp_ms' }),
  progress: text('progress', { mode: 'json' }).$type<TeamSyncProgress>().notNull(),
  error: text('error'),
  // Issues read and saved by this sync
  issues: integer('issues').notNull(),
});
