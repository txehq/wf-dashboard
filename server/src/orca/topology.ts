import { z } from 'zod';

// Orca's collaboration topology (Contracts 35.3): turns the --json output of orca terminal list, orchestration run-list, worker-list,
// task-list, inbox and worktree ps into the Runs, main agents, workers and messages the page needs. Conversion only, no orca calls;
// the live module maps main agents and workers to Live items by terminal handle. The orchestration commands are read as full records
// (orca/cli.ts), and the schemas take either generation's field names so one internal shape comes out of both

// States on the page (Contracts 35.4): working, idle, waiting for an answer, succeeded, failed, exited
export const orcaStates = ['working', 'idle', 'waiting', 'succeeded', 'failed', 'exited'] as const;
export type OrcaState = (typeof orcaStates)[number];

export const OrcaTerminal = z.object({
  handle: z.string(),
  tabId: z.string(),
  leafId: z.string(),
  worktreeId: z.string(),
  worktreePath: z.string(),
  title: z.string().nullable().optional(),
  connected: z.boolean(),
  // The agent Orca recognised (claude, codex, etc.); absent for terminals not running an agent
  agentIdentity: z.string().optional(),
});
export type OrcaTerminal = z.infer<typeof OrcaTerminal>;
export const TerminalList = z.object({ terminals: z.array(OrcaTerminal) });
export type TerminalList = z.infer<typeof TerminalList>;

// Orca renames fields between generations (Contracts 35.3): the concise rows 1.4.246 prints by default carry other
// names than the full record. Every row is read under either name and the schemas below name only one of them, so one
// internal shape comes out and a field neither generation carries fails with zod's own message about that name
function alias(names: Record<string, string>) {
  return (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    const out = { ...row };
    for (const [from, to] of Object.entries(names)) {
      if (!(to in out) && from in row) out[to] = row[from];
    }
    return out;
  };
}

export const RunList = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      objective: z.string(),
      coordinator_handle: z.string().nullable(),
      legacy: z.number(),
      created_at: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const WorkerList = z.object({
  workers: z.array(
    z.preprocess(
      alias({ state: 'workerState', outcome: 'dispatchStatus', terminal: 'agentTerminalHandle' }),
      z.object({
        dispatchId: z.string(),
        taskId: z.string(),
        runId: z.string(),
        workerState: z.string(),
        dispatchStatus: z.string(),
        agentTerminalHandle: z.string().nullable(),
        // Orca's accounting of the worker's terminal resource: active, retained, reclaimable or released
        terminalState: z.string(),
        projection: z.object({ provider: z.object({ id: z.string() }).nullable().optional() }),
      }),
    ),
  ),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});
export type WorkerList = z.infer<typeof WorkerList>;
export type OrcaWorker = WorkerList['workers'][number];

export const TaskList = z.object({
  tasks: z.array(
    z.preprocess(
      alias({ title: 'task_title' }),
      z.object({
        id: z.string(),
        task_title: z.string().nullable(),
        display_name: z.string().nullable(),
        spec: z.string(),
        status: z.string(),
        created_at: z.string(),
      }),
    ),
  ),
});
export type TaskList = z.infer<typeof TaskList>;

export const Inbox = z.object({
  messages: z.array(
    z.preprocess(
      alias({ from: 'from_handle', to: 'to_handle' }),
      z.object({
        id: z.string(),
        run_id: z.string().nullable(),
        from_handle: z.string(),
        to_handle: z.string(),
        subject: z.string(),
        body: z.string(),
        type: z.string(),
        thread_id: z.string().nullable(),
        created_at: z.string(),
        payload: z.string().nullable(),
      }),
    ),
  ),
});
export type Inbox = z.infer<typeof Inbox>;

export const WorktreePs = z.object({
  worktrees: z.array(
    z.object({
      agents: z
        .array(z.object({ paneKey: z.string(), state: z.string(), agentType: z.string() }))
        .optional(),
    }),
  ),
});
export type WorktreePs = z.infer<typeof WorktreePs>;

export interface OrcaInputs {
  terminals: z.infer<typeof TerminalList>;
  runs: z.infer<typeof RunList>['runs'];
  // Workers and tasks of the Runs that were read (keyed by Run id)
  workers: Record<string, WorkerList['workers']>;
  tasks: Record<string, TaskList['tasks']>;
  inbox: Inbox;
  ps: WorktreePs;
}

export interface OrcaMessageView {
  id: string;
  type: string;
  // Sender and receiver as shown: run:<id> is the main agent, dispatch:<id> and terminal handles are workers
  from: string;
  to: string;
  subject: string;
  body: string;
  at: number;
  threadId: string | null;
  // Whether a question has an answer; null for other types
  answered: boolean | null;
}

export interface OrcaWorkerView {
  dispatchId: string;
  taskId: string;
  title: string;
  spec: string;
  handle: string | null;
  agent: string | null;
  workerState: string;
  dispatchStatus: string;
  state: OrcaState;
  // When its task was created, which is when the Run dispatched it; null when the task was not read
  startedAt: number | null;
  lastMessage: OrcaMessageView | null;
}

export interface OrcaRunView {
  id: string;
  objective: string;
  createdAt: number;
  coordinator: { handle: string | null; agent: string | null; state: OrcaState };
  workers: OrcaWorkerView[];
  messages: OrcaMessageView[];
}

// Orca writes times two ways: ISO (with Z) and SQLite's "YYYY-MM-DD HH:MM:SS" (UTC)
export function orcaTime(text: string): number {
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new Error(`Unrecognized Orca time: ${text}`);
  return at;
}

const agentStateOf: Record<string, OrcaState> = {
  working: 'working',
  blocked: 'waiting',
  waiting: 'waiting',
  done: 'idle',
};

// State of the agent in a terminal (worktree ps agents, matched by pane); idle until Orca reports one
function terminalState(terminal: OrcaTerminal | undefined, agents: Map<string, string>): OrcaState {
  if (terminal?.connected !== true) return 'exited';
  const reported = agents.get(`${terminal.tabId}:${terminal.leafId}`);
  if (reported === undefined) return 'idle';
  const state = agentStateOf[reported];
  if (state === undefined)
    throw new Error(`Orca reported an unrecognized agent state: ${reported}`);
  return state;
}

// Handles orca terminal list carries: Orca issues them for panes. Since 1.4.246 a worker can also run as a structured
// agent session, whose structworker_ handle no terminal verb accepts and no terminal list holds
export const isPaneHandle = (handle: string): boolean => handle.startsWith('term_');

const settled = new Set(['succeeded', 'failed', 'abandoned', 'stopped']);

// State of a worker Orca runs without a pane: there is no terminal to read, so Orca's own accounting says whether the
// worker is still running. succeeded and failed are applied by the caller, as they are for a worker in a pane
function sessionState(worker: OrcaWorker): OrcaState {
  const gone = worker.terminalState === 'released' || worker.workerState === 'stopped';
  return gone ? 'exited' : 'working';
}

// Whether this worker still holds something of Orca's: a worker in a pane while that pane is listed, a worker without
// one while it has not settled and Orca has not released its terminal. Decides which Runs are worth reading
export function workerAlive(worker: OrcaWorker, listed: Set<string>): boolean {
  const handle = worker.agentTerminalHandle;
  if (handle === null) return false;
  if (isPaneHandle(handle)) return listed.has(handle);
  return !settled.has(worker.workerState) && worker.terminalState !== 'released';
}

// Runs the page shows: Runs whose main agent or any worker terminal still exists, plus those in keep (Runs that already have Live items)
export function buildTopology(inputs: OrcaInputs, keep: Set<string>): OrcaRunView[] {
  const terminals = new Map(inputs.terminals.terminals.map((t) => [t.handle, t]));
  const agents = new Map<string, string>();
  for (const w of inputs.ps.worktrees) {
    for (const a of w.agents ?? []) agents.set(a.paneKey, a.state);
  }
  const views: OrcaRunView[] = [];
  for (const run of inputs.runs) {
    if (run.legacy !== 0) continue;
    const workers = inputs.workers[run.id];
    if (workers === undefined) continue;
    const tasks = new Map((inputs.tasks[run.id] ?? []).map((t) => [t.id, t]));
    const messages = inputs.inbox.messages
      .filter((m) => m.run_id === run.id)
      .map((m) => ({
        id: m.id,
        type: m.type,
        from: m.from_handle,
        to: m.to_handle,
        subject: m.subject,
        body: m.body,
        at: orcaTime(m.created_at),
        threadId: m.thread_id,
        answered: null as boolean | null,
      }))
      .sort((a, b) => a.at - b.at);
    for (const m of messages) {
      // A question's own thread_id is its id; an answer is another message in the same thread
      if (m.type === 'question') {
        m.answered = messages.some((r) => r.threadId === m.id && r.id !== m.id);
      }
    }
    const coordinatorTerminal =
      run.coordinator_handle === null ? undefined : terminals.get(run.coordinator_handle);
    const workerViews = workers.map((w): OrcaWorkerView => {
      const task = tasks.get(w.taskId);
      const handle = w.agentTerminalHandle;
      const terminal = handle === null ? undefined : terminals.get(handle);
      const own = messages.filter(
        (m) => m.from === `dispatch:${w.dispatchId}` || m.from === handle,
      );
      const asking = own.some((m) => m.type === 'question' && m.answered === false);
      let state =
        handle !== null && !isPaneHandle(handle)
          ? sessionState(w)
          : terminalState(terminal, agents);
      if (state !== 'exited') {
        if (asking) state = 'waiting';
        else if (w.workerState === 'succeeded') state = 'succeeded';
        else if (w.workerState === 'failed' || w.workerState === 'abandoned') state = 'failed';
      }
      return {
        dispatchId: w.dispatchId,
        taskId: w.taskId,
        title: task?.display_name ?? task?.task_title ?? w.taskId,
        spec: task?.spec ?? '',
        handle,
        agent: terminal?.agentIdentity ?? w.projection.provider?.id ?? null,
        workerState: w.workerState,
        dispatchStatus: w.dispatchStatus,
        state,
        startedAt: task === undefined ? null : orcaTime(task.created_at),
        lastMessage: own.at(-1) ?? null,
      };
    });
    const alive =
      coordinatorTerminal?.connected === true || workerViews.some((w) => w.state !== 'exited');
    if (!alive && !keep.has(run.id)) continue;
    views.push({
      id: run.id,
      objective: run.objective,
      createdAt: orcaTime(run.created_at),
      coordinator: {
        handle: run.coordinator_handle,
        agent: coordinatorTerminal?.agentIdentity ?? null,
        state: terminalState(coordinatorTerminal, agents),
      },
      workers: workerViews,
      messages,
    });
  }
  return views;
}
