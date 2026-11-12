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
import { orcaStates } from '../orca/topology.js';
import { WorkerTurn } from '../orca/worker.js';
import { efforts, modelAliases } from '../variants/model-names.js';

// Shapes of the Live API (Contracts 14)

// The input Claude Code is waiting for: the text at the end of a turn (Stop), or an unanswered AskUserQuestion
export const LiveWaiting = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('questions'),
    toolUseId: z.string(),
    questions: z.array(AskQuestionView),
  }),
]);
export type LiveWaiting = z.infer<typeof LiveWaiting>;

// One run of an item (live_processes in Contracts 14.1)
export const LiveProcessView = z.object({
  id: z.number().int(),
  kind: z.enum(liveProcessKinds),
  variantId: z.string().nullable(),
  // Null for the local machine's configuration
  variantName: z.string().nullable(),
  pid: z.number().int().nullable(),
  status: z.enum(liveStatuses),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  driver: z.enum(liveDrivers),
  // The --model and --effort actually passed to claude; null for the local machine's configuration
  model: z.string().nullable(),
  effort: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type LiveProcessView = z.infer<typeof LiveProcessView>;

// Status of a Live item: idle means imported from this machine with no process yet (the page shows "Not running", Contracts 14.5)
export const liveItemStatuses = ['running', 'exited', 'idle'] as const;
export type LiveItemStatus = (typeof liveItemStatuses)[number];

// A Live item (one Claude Code session); process is the latest process (null if never run since import), status etc. come from it
export const LiveSummary = z.object({
  id: z.string(),
  title: z.string(),
  // Null for a Codex draft item until the draft is prepared and Codex first starts (Contracts 17.1)
  claudeSessionId: z.string().nullable(),
  // codex: a session that generates a workflow or variant with Codex (Contracts 17.3); claudeSessionId is the Codex session id
  engine: z.enum(liveEngines),
  // Purpose (Contracts 14.3); for design, designMode is workflow or variant; for optimize, analysisId is the analysis
  purpose: z.enum(livePurposes),
  designMode: z.enum(['workflow', 'variant']).nullable(),
  analysisId: z.string().nullable(),
  // The draft this Codex session belongs to; null otherwise
  draftId: z.string().nullable(),
  // Configuration of a Magi Agent session (local or variant id) and its name (Contracts 23.1, 23.6); null for other purposes
  agentConfig: z.string().nullable(),
  agentConfigName: z.string().nullable(),
  environment: z.enum(liveEnvironments),
  // Id of the workflow chosen at creation; null for items started from an existing session
  workflow: z.string().nullable(),
  input: z.string().nullable(),
  taskId: z.string().nullable(),
  // Goal given to the simulated user (Contracts 34.2): null until written; items with a task use the task's persona instead
  simulatedGoal: z.string().nullable(),
  // Prefill for the goal box: this item's original user request
  simulatedGoalDefault: z.string(),
  cwd: z.string(),
  process: LiveProcessView.nullable(),
  // The fields below come from the latest process for the list and terminal header; without a process variant is null and the driver is human
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  status: z.enum(liveItemStatuses),
  driver: z.enum(liveDrivers),
  error: z.string().nullable(),
  // Message and time of a remote item's latest failed session sync (Contracts 31.6): cleared on the next success; process errors are in error
  syncFailure: z.object({ message: z.string(), at: z.number() }).nullable(),
  resumeCount: z.number().int(),
  // Before the first SessionStart hook: the driver is fixed to human, who answers prompts in the terminal
  starting: z.boolean(),
  // Repo copy and ticket created by the isolated environment
  repo: z.string().nullable(),
  ticket: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // When the item was hidden in Live; null while shown
  hiddenAt: z.number().nullable(),
  // SSH host it runs on (Contracts 31.3); null for this machine. label and target are null after the host is deleted
  host: z
    .object({ id: z.string(), label: z.string().nullable(), target: z.string().nullable() })
    .nullable(),
  // Whether a running remote process is connected; null for local items and when not running
  connected: z.boolean().nullable(),
  // Orca (Contracts 35.2–35.4)
  orca: z.object({
    // Hosted by Orca: the coordinator and workers in Orca (purpose orca); the terminal shows Orca's rendered screen
    hosted: z.boolean(),
    // This item's Orca terminal: the hosting terminal for hosted items, the latest process's identity terminal for dashboard-started items
    handle: z.string().nullable(),
    // Why the latest process of a dashboard-started item has no Orca identity (Orca not running, cwd outside an Orca workspace);
    // null with an identity or when never run
    identityReason: z.string().nullable(),
    // The worker's Run and the item of the coordinator that dispatched it
    runId: z.string().nullable(),
    parentLiveId: z.string().nullable(),
    // State in the list and topology; exited without a running process, null when never run
    state: z.enum(orcaStates).nullable(),
    // Why a still running process is no longer in Orca: its pane is gone while the process itself is alive, so it was
    // left running (Contracts 35.3). Null otherwise
    paneGone: z.string().nullable(),
    // A worker Orca runs without a pane (Contracts 35.4): the page shows its transcript and sends it input through
    // its Dispatch instead of a terminal
    structured: z.boolean(),
    // The Dispatch of a worker, from the latest process; null for a main agent and for dashboard-started items
    dispatchId: z.string().nullable(),
  }),
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
  // The input Claude Code is waiting for while running; null otherwise
  waiting: LiveWaiting.nullable(),
  // Why the driver last became human: input (a key in the terminal), done (the simulated user considers it finished), max-turns,
  // error, disconnected (the remote connection dropped, Contracts 31.4); null otherwise
  handedBack: z.enum(['input', 'done', 'max-turns', 'error', 'manual', 'disconnected']).nullable(),
  // The one-sentence reason the simulated user gave when it considered the work done (Contracts 34.2); null otherwise
  doneReason: z.string().nullable(),
  // All processes in start order
  processes: z.array(LiveProcessView),
  events: z.array(LiveEventView),
});
export type LiveDetail = z.infer<typeof LiveDetail>;

// Rename (Contracts 14.3): non-empty after trimming, at most 200 characters; otherwise the server reports the error
export const RenameLiveBody = z.strictObject({ title: z.string() });
export type RenameLiveBody = z.infer<typeof RenameLiveBody>;
export const TITLE_MAX = 200;

// Driver switch (Contracts 34.2): handing to the simulated user also writes the goal for items with no task and no goal yet
export const LiveDriverBody = z.strictObject({
  driver: z.enum(liveDrivers),
  goal: z.string().optional(),
});
export type LiveDriverBody = z.infer<typeof LiveDriverBody>;

// Editing the goal in the toolbar (Contracts 34.2)
export const LiveGoalBody = z.strictObject({ goal: z.string() });
export type LiveGoalBody = z.infer<typeof LiveGoalBody>;

// Source of "Stop process", recorded in the stop event: the page button sends { source: 'page' }; a direct API call without body or source is api
export const liveStopSources = ['page', 'api'] as const;
export type LiveStopSource = (typeof liveStopSources)[number];
export const StopLiveBody = z.strictObject({ source: z.enum(liveStopSources).optional() });

// Import into Live (Contracts 14.5): one item per session, no process started
export const ImportLiveBody = z.strictObject({ sessionIds: z.array(z.string().min(1)).min(1) });
export type ImportLiveBody = z.infer<typeof ImportLiveBody>;

// Delete an item: confirmed by typing its name (Contracts 14.5)
export const DeleteLiveBody = z.strictObject({ confirmTitle: z.string() });
export type DeleteLiveBody = z.infer<typeof DeleteLiveBody>;

// Contracts 29.2: configuration is a variant or the local machine's (variantId null); the initial command is the entry command of a
// workflow the configuration has, or none (workflow null, the input is the initial message). Location (31.3): this machine, or an SSH
// host (hostId), running the remote Claude Code or Codex in the remote real directory cwd, with the remote configuration when variantId is null
export const CreateLiveBody = z.strictObject({
  workflow: z.string().min(1).nullable(),
  input: z.string().trim().min(1),
  variantId: z.string().min(1).nullable(),
  environment: z.enum(liveEnvironments),
  // Real directory for the real environment (a remote directory on an SSH host); null for isolated
  cwd: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
  // Required when the initial driver is the simulated user (Contracts 34.2)
  goal: z.string().optional(),
  // Defaults to agentModel and agentEffort from /settings (Contracts 16.5); the local machine's configuration passes no --model or --effort
  model: z.enum(modelAliases).optional(),
  effort: z.enum(efforts).optional(),
  hostId: z.string().min(1).nullable().default(null),
  // Only Claude Code on this machine; an SSH host can also offer its Codex
  engine: z.enum(liveEngines).default('claude'),
});
export type CreateLiveBody = z.infer<typeof CreateLiveBody>;

// Entry commands available to the local machine's configuration (Contracts 29.2): workflows whose <HOME>/.claude/skills/<entry skill>/SKILL.md exists
export const LocalEntries = z.object({ workflows: z.array(z.string()) });
export type LocalEntries = z.infer<typeof LocalEntries>;

export const ResumeLiveBody = z.strictObject({
  sessionId: z.string().min(1),
  // Null means the local machine's configuration
  variantId: z.string().min(1).nullable(),
  driver: z.enum(liveDrivers),
  // Required when choosing the simulated user for an item with no goal yet (Contracts 34.2)
  goal: z.string().optional(),
  model: z.enum(modelAliases).optional(),
  effort: z.enum(efforts).optional(),
  // "Continue from the latest" when the copies diverged (Contracts 14.5): the target copy is kept under a new name, then overwritten; omitted means no resume
  onDiverged: z.literal('use-latest').optional(),
});
export type ResumeLiveBody = z.infer<typeof ResumeLiveBody>;

// Defaults for the resume dialog: the session's variant and recorded cwd; no resume while the session's item has a running process
export const ResumeDefaults = z.object({
  sessionId: z.string(),
  // A Codex session resumes in its own CODEX_HOME, with no configuration or driver choice (Contracts 25.2)
  engine: z.enum(liveEngines),
  variantId: z.string().nullable(),
  cwd: z.string().nullable(),
  cwdExists: z.boolean(),
  // The session's item (Contracts 14.5); null if it belongs to none yet
  liveId: z.string().nullable(),
  running: z.boolean(),
  // A session on an SSH host (Contracts 31.3, 31.6) resumes only on that host; null for this machine. The preflight checks the remote cwd over ssh
  hostId: z.string().nullable(),
  // Goal for the simulated user (Contracts 34.2): the item's existing goal and the goal box prefill; items with a task use the task's persona
  simulatedGoal: z.string().nullable(),
  simulatedGoalDefault: z.string(),
  hasTask: z.boolean(),
});
export type ResumeDefaults = z.infer<typeof ResumeDefaults>;

// Resume preflight (Contracts 14.5): says what will happen when the dialog opens or the configuration changes.
// resume: the target already has the latest copy, continue directly; copy: copy the session into the target first; sync: the target has
// an older copy, overwrite it with the latest; diverged: the copies diverged, the user chooses; blocked: cannot resume, problems say why and what to do
export const resumeActions = ['resume', 'copy', 'sync', 'diverged', 'blocked'] as const;
export type ResumeAction = (typeof resumeActions)[number];

export const resumeProblemCodes = [
  'no-cwd',
  'cwd-missing',
  'variant-not-built',
  'running',
  'file-missing',
  // The Codex session is archived (Contracts 25.3): restore it first
  'archived',
  // The SSH host is unreachable or missing commands (Contracts 31.2), or deleted
  'host',
] as const;

export const ResumeCopy = z.object({
  path: z.string(),
  bytes: z.number().int(),
  // The main agent's last message with text
  lastAt: z.string().nullable(),
  lastRole: z.enum(['user', 'assistant']).nullable(),
  lastText: z.string().nullable(),
});
export type ResumeCopy = z.infer<typeof ResumeCopy>;

export const ResumePlan = z.object({
  sessionId: z.string(),
  // Configuration of this preflight; null for the local machine's
  variantId: z.string().nullable(),
  // Target configuration directory (the variant's CLAUDE_CONFIG_DIR or the local machine's <HOME>/.claude); for a Codex session its
  // CODEX_HOME (Contracts 25.2)
  configDir: z.string(),
  liveId: z.string().nullable(),
  cwd: z.string().nullable(),
  // Default model and effort with a variant (settings agentModel, agentEffort); null for the local machine's configuration
  model: z.enum(modelAliases).nullable(),
  effort: z.enum(efforts).nullable(),
  action: z.enum(resumeActions),
  // The latest copy (sessions.file_path) and the copy already in the target (null if none)
  latest: ResumeCopy.nullable(),
  target: ResumeCopy.nullable(),
  problems: z.array(z.object({ code: z.enum(resumeProblemCodes), message: z.string() })),
  // Things that do not block resume but the user should know (e.g. the subagent directory is missing)
  notes: z.array(z.string()),
});
export type ResumePlan = z.infer<typeof ResumePlan>;

// Orca collaboration topology (Contracts 35.3, 35.4): GET /api/live/orca. liveId of the coordinator and workers is the matching Live
// item (null until matched); host is the Run's SSH host, null for this machine
export const OrcaMessageView = z.object({
  id: z.string(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  at: z.number(),
  threadId: z.string().nullable(),
  // Whether a question has been answered; null for other types
  answered: z.boolean().nullable(),
});

export const OrcaRunView = z.object({
  id: z.string(),
  objective: z.string(),
  createdAt: z.number(),
  host: z.object({ id: z.string(), label: z.string().nullable() }).nullable(),
  coordinator: z.object({
    handle: z.string().nullable(),
    agent: z.string().nullable(),
    state: z.enum(orcaStates),
    liveId: z.string().nullable(),
  }),
  workers: z.array(
    z.object({
      dispatchId: z.string(),
      taskId: z.string(),
      title: z.string(),
      spec: z.string(),
      handle: z.string().nullable(),
      agent: z.string().nullable(),
      workerState: z.string(),
      dispatchStatus: z.string(),
      state: z.enum(orcaStates),
      // When the Run dispatched it; null when its task was not read
      startedAt: z.number().nullable(),
      lastMessage: OrcaMessageView.nullable(),
      liveId: z.string().nullable(),
    }),
  ),
  messages: z.array(OrcaMessageView),
});
export type OrcaRunView = z.infer<typeof OrcaRunView>;

export const OrcaTopology = z.object({
  // Orca on this machine: when not running, the reason is given (Contracts 35.2) and there is no topology
  local: z.object({ running: z.boolean(), reason: z.string().nullable() }),
  runs: z.array(OrcaRunView),
});
export type OrcaTopology = z.infer<typeof OrcaTopology>;

// One page of a structured worker's transcript (Contracts 35.4): GET /api/live/:id/worker?cursor=. The cursor goes
// back unchanged on the next read, which then returns only what the worker wrote since
export const WorkerTranscript = z.object({
  turns: z.array(WorkerTurn),
  cursor: z.string().nullable(),
  // Orca has more past this page: read again at once to catch up
  more: z.boolean(),
  // Orca's own account of the worker: its state, its terminal and whether Orca can still see it running
  status: z.object({ worker: z.string(), terminal: z.string(), liveness: z.string() }),
});
export type WorkerTranscript = z.infer<typeof WorkerTranscript>;

// Input typed in a structured worker's item: it reaches the worker as a message to its Dispatch
export const WorkerSendBody = z.strictObject({ text: z.string().trim().min(1) });
export type WorkerSendBody = z.infer<typeof WorkerSendBody>;

// What Orca did with it: delivered reaches the running worker, reopened started a new Dispatch because the worker
// had already finished
export const WorkerSendResult = z.object({ delivery: z.string() });
export type WorkerSendResult = z.infer<typeof WorkerSendResult>;
