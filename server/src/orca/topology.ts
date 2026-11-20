import { z } from 'zod';

// Orca's collaboration topology (Contracts 35.3): turns the --json output of orca terminal list, orchestration run-list, worker-list,
// task-list, inbox, worktree ps, worktree list and repo list into the Runs, main agents, workers and messages the page needs. Conversion only, no orca calls;
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
  // The git branch of the terminal's worktree (refs/heads/<name>); absent on a detached head or a folder workspace
  branch: z.string().nullable().optional(),
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
        // Orca's accounting of the worker's terminal resource: active, retained, reclaimable or released; null when
        // the worker has no terminal resource left (its handle is null then too)
        terminalState: z.string().nullable(),
        // The worktree Orca gave the worker (<repo id>::<path>), kept after its terminal is gone
        resource: z.object({ worktreeId: z.string().nullable() }).nullable().optional(),
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

// Repos registered in Orca (orca repo list): the projects the topology page groups sessions by (Contracts 40.2)
export const RepoList = z.object({
  repos: z.array(z.object({ id: z.string(), displayName: z.string(), path: z.string() })),
});
export type RepoList = z.infer<typeof RepoList>;

// Worktrees Orca manages (orca worktree list): each one's repo, current branch and name, and whether it is the repo's
// own directory (Contracts 40.1, 40.2)
export const WorktreeList = z.object({
  worktrees: z.array(
    z.object({
      id: z.string(),
      repoId: z.string(),
      path: z.string(),
      branch: z.string().nullable(),
      displayName: z.string(),
      isMainWorktree: z.boolean(),
    }),
  ),
});
export type WorktreeList = z.infer<typeof WorktreeList>;

export interface OrcaInputs {
  terminals: z.infer<typeof TerminalList>;
  runs: z.infer<typeof RunList>['runs'];
  // Workers and tasks of the Runs that were read (keyed by Run id)
  workers: Record<string, WorkerList['workers']>;
  tasks: Record<string, TaskList['tasks']>;
  inbox: Inbox;
  ps: WorktreePs;
  repos: RepoList;
  worktrees: WorktreeList;
}

// The worktree a session works in (Contracts 40.2): its directory, its name (Orca's for a worktree it made, the
// directory's own name otherwise) and whether it is the repo's own directory
export interface OrcaWorktree {
  path: string;
  name: string;
  main: boolean;
}

// Where a session works (Contracts 40.1): its working directory, the worktree and branch it is in and the Orca repo it
// belongs to; each is null when Orca does not know it
export interface OrcaLocation {
  cwd: string | null;
  worktree: OrcaWorktree | null;
  branch: string | null;
  project: { id: string; name: string } | null;
}

const branchName = (ref: string | null | undefined): string | null =>
  ref == null || ref === '' ? null : ref.replace(/^refs\/heads\//, '');

const within = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

const baseName = (dir: string) =>
  dir
    .split('/')
    .filter((s) => s !== '')
    .at(-1) ?? dir;

// The location of a session from what Orca says about it: the worktree id it was given (<repo id>::<path>), its
// working directory, and the branch its terminal reports. The worktree is found by id, then by the deepest worktree
// holding the directory; its repo names the project. A worktree Orca no longer lists (it was deleted) is the one the
// id names, or else the working directory itself
export function locate(
  inputs: Pick<OrcaInputs, 'repos' | 'worktrees'>,
  at: { worktreeId?: string | null; cwd?: string | null; branch?: string | null },
): OrcaLocation {
  const idPath = at.worktreeId == null ? null : (at.worktreeId.split('::')[1] ?? null);
  const cwd = at.cwd ?? idPath ?? null;
  const byId = inputs.worktrees.worktrees.find((w) => w.id === at.worktreeId);
  const byPath =
    cwd === null
      ? undefined
      : inputs.worktrees.worktrees
          .filter((w) => within(cwd, w.path))
          .sort((a, b) => b.path.length - a.path.length)[0];
  const worktree = byId ?? byPath;
  const idRepo = at.worktreeId == null ? undefined : at.worktreeId.split('::')[0];
  const repoId =
    worktree?.repoId ??
    idRepo ??
    (cwd === null ? null : (inputs.repos.repos.find((r) => within(cwd, r.path))?.id ?? null));
  const repo = inputs.repos.repos.find((r) => r.id === repoId);
  const listed: OrcaWorktree | null =
    worktree === undefined
      ? null
      : {
          path: worktree.path,
          name: worktree.isMainWorktree ? baseName(worktree.path) : worktree.displayName,
          main: worktree.isMainWorktree,
        };
  const gonePath = idPath ?? cwd;
  return {
    cwd,
    worktree:
      listed ??
      (gonePath === null
        ? null
        : { path: gonePath, name: baseName(gonePath), main: gonePath === repo?.path }),
    branch: branchName(worktree?.branch ?? at.branch),
    project: repoId === null ? null : { id: repoId, name: repo?.displayName ?? repoId },
  };
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
  // Orca lists its terminal right now (whatever state its agent is in): the desktop Orca can switch to it
  terminalOpen: boolean;
  location: OrcaLocation;
}

export interface OrcaRunView {
  id: string;
  objective: string;
  createdAt: number;
  coordinator: {
    handle: string | null;
    agent: string | null;
    state: OrcaState;
    terminalOpen: boolean;
    location: OrcaLocation;
  };
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

// The state of the agent in every terminal Orca lists, by handle
export function terminalStates(
  inputs: Pick<OrcaInputs, 'terminals' | 'ps'>,
): Map<string, OrcaState> {
  const agents = new Map<string, string>();
  for (const w of inputs.ps.worktrees) {
    for (const a of w.agents ?? []) agents.set(a.paneKey, a.state);
  }
  return new Map(inputs.terminals.terminals.map((t) => [t.handle, terminalState(t, agents)]));
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

// Every Run read, alive or not (the topology page shows the sessions of all of them, Contracts 40.1): a Run's main
// agent and workers carry their state, and where they work
export function buildTopology(inputs: OrcaInputs): OrcaRunView[] {
  const terminals = new Map(inputs.terminals.terminals.map((t) => [t.handle, t]));
  const agents = new Map<string, string>();
  for (const w of inputs.ps.worktrees) {
    for (const a of w.agents ?? []) agents.set(a.paneKey, a.state);
  }
  // A listed terminal says where it is; otherwise the worktree Orca gave the worker
  const locationOf = (terminal: OrcaTerminal | undefined, worktreeId: string | null) =>
    terminal === undefined
      ? locate(inputs, { worktreeId })
      : locate(inputs, {
          worktreeId: terminal.worktreeId,
          cwd: terminal.worktreePath,
          branch: terminal.branch ?? null,
        });
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
        terminalOpen: terminal !== undefined,
        location: locationOf(terminal, w.resource?.worktreeId ?? null),
      };
    });
    views.push({
      id: run.id,
      objective: run.objective,
      createdAt: orcaTime(run.created_at),
      coordinator: {
        handle: run.coordinator_handle,
        agent: coordinatorTerminal?.agentIdentity ?? null,
        state: terminalState(coordinatorTerminal, agents),
        terminalOpen: coordinatorTerminal !== undefined,
        location: locationOf(coordinatorTerminal, null),
      },
      workers: workerViews,
      messages,
    });
  }
  return views;
}
