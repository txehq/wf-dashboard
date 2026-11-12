import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { type LiveEngine, liveEvents, liveProcesses, liveSessions } from '../db/schema.js';
import { events } from '../events.js';
import { readSessionMeta } from '../ingest/codex.js';
import type { RemoteHost } from '../remote/hosts.js';
import { listRemoteRollouts } from '../remote/rollouts.js';
import { sshScript } from '../remote/ssh.js';
import { newId } from '../runs/index.js';
import { type OrcaPlace, orcaCall, orcaRead, orcaStatus } from '../orca/cli.js';
import {
  buildTopology,
  Inbox,
  isPaneHandle,
  type OrcaInputs,
  type OrcaRunView,
  type OrcaState,
  type OrcaTerminal,
  RunList,
  TaskList,
  TerminalList,
  WorkerList,
  workerAlive,
  WorktreePs,
} from '../orca/topology.js';
import { type StructuredWorker, workerShow } from '../orca/worker.js';
import {
  orcaPaneEvent,
  reconcileVanishedPanes,
  reconcileVanishedRemotePanes,
} from './orca-panes.js';
import type { OrcaTopology } from './views.js';

// Topology sync (Contracts 35.3): while a page is connected, every pollMs read Orca's Runs, tasks, workers and messages on this
// machine and each SSH host; coordinators and workers map to Live items by terminal handle, those without one get a new item
// (purpose orca), agents running in Orca terminals are attached by the live module (OrcaPaneTerminal); when an agent exits or
// its terminal closes the item's process ends. Changes reach pages via SSE (orca.updated)

const scriptsDir = fileURLToPath(new URL('../../remote-scripts/', import.meta.url));

// An agent running in an Orca terminal: its pid and session (Claude Code jsonl or Codex rollout; the remote path when remote)
export interface PaneAgent {
  pid: number;
  sessionId: string;
  transcript: string;
}

// An agent in an Orca terminal attached by the live module
export interface OrcaPaneSpec {
  liveId: string;
  place: OrcaPlace;
  host: RemoteHost | null;
  handle: string;
  engine: LiveEngine;
  agent: PaneAgent;
  // The worker's Dispatch; null for an Orca coordinator
  dispatchId: string | null;
  // A process already running before the dashboard restarted (keep using it); null for a new attach
  processId: number | null;
}

export interface AttachedPane {
  end(): void;
  // Agent state change reported by Orca: working, or stopped (idle, waiting for an answer)
  observe(state: 'working' | 'stopped'): void;
}

// A worker Orca runs without a pane, taken over by the live module (Contracts 35.4): there is no terminal to mirror,
// so the item only gets a process and its session import; the page reads the transcript through the Dispatch
export interface StructuredWorkerSpec {
  liveId: string;
  place: OrcaPlace;
  host: RemoteHost | null;
  worker: StructuredWorker;
  engine: LiveEngine;
  agent: PaneAgent;
  // A process already running before the dashboard restarted (keep using it); null for a new attach
  processId: number | null;
}

export interface AttachedWorker {
  // The worker left Orca (it settled, or Orca released its terminal): the item's process ends
  end(): void;
}

const ClaudeSessionFile = z.looseObject({
  sessionId: z.string(),
  cwd: z.string(),
  kind: z.string().optional(),
});

const SHOWS_PER_SYNC = 8;
const SHOW_CONCURRENCY = 4;

// Name of a created item: first 40 characters of the first line of the task name or Run objective (same as the 14.3 default)
function shortTitle(text: string): string {
  return Array.from(text.split('\n')[0] ?? text)
    .slice(0, 40)
    .join('');
}

const engineOf = (terminal: OrcaTerminal): LiveEngine =>
  terminal.agentIdentity === 'codex' ? 'codex' : 'claude';

// The agent process in an Orca terminal whose environment carries this handle (server/remote-scripts/orca-agent.sh); null if not started yet or exited
async function findPaneAgent(
  place: OrcaPlace,
  home: string,
  handle: string,
  engine: LiveEngine,
): Promise<PaneAgent | null> {
  const out =
    place.kind === 'local'
      ? (await execa('sh', [`${scriptsDir}orca-agent.sh`, handle, engine, home], { input: '' }))
          .stdout
      : await sshScript(place.host.target, 'orca-agent.sh', [handle, engine, home]);
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const pid = /^pid (\d+)$/.exec(lines[i] ?? '');
    if (pid === null) continue;
    const next = lines[i + 1] ?? '';
    if (engine === 'claude' && next === '@@session') {
      const session = ClaudeSessionFile.parse(JSON.parse(lines[i + 2] ?? ''));
      if (session.kind !== undefined && session.kind !== 'interactive') continue;
      // Local config project directory: every non-alphanumeric character of cwd becomes -
      const project = session.cwd.replace(/[^A-Za-z0-9]/g, '-');
      return {
        pid: Number(pid[1]),
        sessionId: session.sessionId,
        transcript: `${home}/.claude/projects/${project}/${session.sessionId}.jsonl`,
      };
    }
    const rollout = /^rollout (.+)$/.exec(next);
    if (engine === 'codex' && rollout !== null) {
      const file = rollout[1] ?? '';
      // A remote rollout is listed by the sessions directory it lives in
      const sessionsDir = file.replace(/\/sessions\/.*$/, '/sessions');
      const id =
        place.kind === 'local'
          ? readSessionMeta(file)?.id
          : (await listRemoteRollouts(place.host, [sessionsDir])).find((r) => r.file === file)?.id;
      if (id === undefined) continue;
      return { pid: Number(pid[1]), sessionId: id, transcript: file };
    }
  }
  return null;
}

// Everything one topology needs from one place, read the way the sync reads it: version is the Orca there, from
// orcaStatus, and wanted names the Runs to read even when nothing of theirs is open any more
export async function readOrcaInputs(
  place: OrcaPlace,
  version: string,
  terminals: TerminalList,
  wanted: (runs: OrcaInputs['runs']) => Set<string>,
) {
  const read = (args: string[]) => orcaRead(place, version, args);
  // run-list returns at most 100 Runs per page
  const runs: OrcaInputs['runs'] = [];
  let runCursor: string | null = null;
  do {
    const page = RunList.parse(
      await read([
        'orchestration',
        'run-list',
        '--limit',
        '100',
        ...(runCursor === null ? [] : ['--cursor', runCursor]),
      ]),
    );
    runs.push(...page.runs);
    runCursor = page.nextCursor;
  } while (runCursor !== null);
  const inbox = Inbox.parse(await read(['orchestration', 'inbox', '--limit', '2000']));
  const ps = WorktreePs.parse(await orcaCall(place, ['worktree', 'ps', '--limit', '10000']));
  // worker-list without a Run gives the workers of every Run on this machine (at most 100 per page, newest first)
  const allWorkers: WorkerList['workers'] = [];
  let workerCursor: string | null = null;
  do {
    const page = WorkerList.parse(
      await read([
        'orchestration',
        'worker-list',
        '--limit',
        '100',
        ...(workerCursor === null ? [] : ['--cursor', workerCursor]),
      ]),
    );
    allWorkers.push(...page.workers);
    workerCursor = page.page.hasMore ? page.page.nextCursor : null;
  } while (workerCursor !== null);
  const inputs: OrcaInputs = { terminals, runs, workers: {}, tasks: {}, inbox, ps };
  const live = new Set(terminals.terminals.filter((t) => t.connected).map((t) => t.handle));
  const want = wanted(runs);
  for (const run of runs) {
    if (run.legacy !== 0) continue;
    const workers = allWorkers.filter((w) => w.runId === run.id);
    // Runs whose coordinator or any worker still holds something of Orca's, plus those that already have Live items (want)
    const alive =
      (run.coordinator_handle !== null && live.has(run.coordinator_handle)) ||
      workers.some((w) => workerAlive(w, live));
    if (!alive && !want.has(run.id)) continue;
    inputs.workers[run.id] = workers;
    inputs.tasks[run.id] = TaskList.parse(
      await read(['orchestration', 'task-list', '--run', run.id]),
    ).tasks;
  }
  return inputs;
}

export interface OrcaSyncDeps {
  db: Db;
  local: OrcaPlace;
  // HOME of the local config (agents in Orca use its ~/.claude)
  localHome: string;
  // SSH hosts that were checked and have Orca running
  remoteHosts: () => RemoteHost[];
  pollMs: number;
  // A page is connected (SSE or a terminal WebSocket)
  hasViewers: () => boolean;
  attach: (spec: OrcaPaneSpec) => AttachedPane;
  attachWorker: (spec: StructuredWorkerSpec) => AttachedWorker;
  // The Live item has a running process already owned by a controller
  running: (liveId: string) => boolean;
}

type ItemRow = typeof liveSessions.$inferSelect;

export function createOrcaSync(deps: OrcaSyncDeps) {
  const { db } = deps;
  let timer: NodeJS.Timeout | null = null;
  let polling: Promise<void> | null = null;
  let topology: OrcaTopology = { local: { running: false, reason: 'Not read yet' }, runs: [] };
  // Attached Orca terminals: item, terminal and last state
  const panes = new Map<string, { liveId: string; pane: AttachedPane; state: OrcaState | null }>();
  // Attached workers Orca runs without a pane, by place and handle
  const workers = new Map<string, { liveId: string; dispatchId: string; worker: AttachedWorker }>();
  // worker-show of each structured worker, read once per Dispatch: its workspace and what Orca launched there do not
  // change while the Dispatch lives, and a Run can hold dozens of workers
  const shown = new Map<string, StructuredWorker>();
  // Version of the Orca at each place, from the latest sync: the reads ask it which flags that Orca takes
  const versions = new Map<string, string>();
  // Items attached since this server start: their processes are ended by their terminals, not "left over from before the restart"
  const everAttached = new Set<string>();
  // Items being stopped ("Stop process"): keep syncing regardless of pages until the agent exits
  let stopping = 0;

  const placeKey = (place: OrcaPlace) => (place.kind === 'local' ? 'local' : place.host.id);
  const paneKey = (place: OrcaPlace, handle: string) => `${placeKey(place)}/${handle}`;

  // Live item for each terminal handle: the item's current Orca terminal, plus earlier processes' identity terminals of dashboard-started items (orca-identity events)
  function handleMap(hostId: string | null): Map<string, string> {
    const map = new Map<string, string>();
    const items = db
      .select({
        id: liveSessions.id,
        handle: liveSessions.orcaTerminalHandle,
        hostId: liveSessions.hostId,
      })
      .from(liveSessions)
      .where(isNotNull(liveSessions.orcaTerminalHandle))
      .all();
    const identities = db
      .select({
        liveId: liveEvents.liveId,
        payload: liveEvents.payload,
        hostId: liveSessions.hostId,
      })
      .from(liveEvents)
      .innerJoin(liveSessions, eq(liveSessions.id, liveEvents.liveId))
      .where(eq(liveEvents.kind, 'orca-identity'))
      .all();
    for (const e of identities) {
      const handle = e.payload.handle;
      if (typeof handle === 'string' && e.hostId === hostId) map.set(handle, e.liveId);
    }
    for (const i of items) {
      if (i.handle !== null && i.hostId === hostId) map.set(i.handle, i.id);
    }
    return map;
  }

  // Runs of Orca items (purpose orca): read even when the coordinator terminal is gone
  function knownRuns(hostId: string | null): Set<string> {
    const rows = db
      .select({ runId: liveSessions.orcaRunId, hostId: liveSessions.hostId })
      .from(liveSessions)
      .innerJoin(liveProcesses, eq(liveProcesses.liveId, liveSessions.id))
      .where(and(isNotNull(liveSessions.orcaRunId), eq(liveProcesses.status, 'running')))
      .all();
    return new Set(
      rows.filter((r) => r.hostId === hostId).flatMap((r) => (r.runId === null ? [] : [r.runId])),
    );
  }

  function itemOfSession(sessionId: string): ItemRow | undefined {
    return db.select().from(liveSessions).where(eq(liveSessions.claudeSessionId, sessionId)).get();
  }

  // A coordinator, a pane worker or a structured worker that is not a Live item yet: once its agent and session are
  // found, record the terminal on the item that owns the session, or create an item (like the 14.5 import, purpose
  // orca). If the agent has not started, retry next time
  async function ensureItem(
    place: OrcaPlace,
    host: RemoteHost | null,
    agentTerminal: { handle: string; cwd: string; engine: LiveEngine },
    title: string,
    input: string | null,
  ): Promise<{ liveId: string; agent: PaneAgent } | null> {
    const { handle, engine } = agentTerminal;
    const home = host === null ? deps.localHome : host.home;
    const agent = await findPaneAgent(place, home, handle, engine);
    if (agent === null) return null;
    const existing = itemOfSession(agent.sessionId);
    if (existing !== undefined) {
      db.update(liveSessions)
        .set({ orcaTerminalHandle: handle })
        .where(eq(liveSessions.id, existing.id))
        .run();
      return { liveId: existing.id, agent };
    }
    const liveId = newId('l');
    const at = new Date();
    db.insert(liveSessions)
      .values({
        id: liveId,
        claudeSessionId: agent.sessionId,
        engine,
        purpose: 'orca',
        title: shortTitle(title),
        environment: 'real',
        workflow: null,
        input,
        taskId: null,
        cwd: agentTerminal.cwd,
        hostId: host?.id ?? null,
        orcaTerminalHandle: handle,
        updatedAt: at,
      })
      .run();
    db.insert(liveEvents)
      .values({
        liveId,
        processId: null,
        at,
        kind: 'import',
        payload: { orca: { handle, sessionId: agent.sessionId } },
      })
      .run();
    events.publish({ type: 'live.updated', liveId });
    return { liveId, agent };
  }

  const ORCA_ENGINES = new Set(['claude', 'codex']);

  // A process of this item attached to Orca and still recorded as running: it was attached before the dashboard
  // restarted, so the attach keeps using it instead of recording a second one
  function attachedProcessOf(liveId: string): number | null {
    const running = db
      .select({ id: liveProcesses.id })
      .from(liveProcesses)
      .where(
        and(
          eq(liveProcesses.liveId, liveId),
          eq(liveProcesses.status, 'running'),
          sql`exists (${orcaPaneEvent(sql`${liveProcesses.id}`)})`,
        ),
      )
      .get();
    return running?.id ?? null;
  }

  async function showOf(
    place: OrcaPlace,
    version: string,
    dispatchId: string,
  ): Promise<StructuredWorker> {
    const key = `${placeKey(place)}/${dispatchId}`;
    const known = shown.get(key);
    if (known !== undefined) return known;
    const show = await workerShow(place, version, dispatchId);
    shown.set(key, show);
    return show;
  }

  const shownOf = (place: OrcaPlace, dispatchId: string) =>
    shown.get(`${placeKey(place)}/${dispatchId}`) ?? null;

  // worker-show of the structured workers not read yet. A Run can hold a hundred workers and every read is one orca
  // process, so one sync reads at most SHOWS_PER_SYNC of them, SHOW_CONCURRENCY at a time, the workers Orca still
  // holds first (they become items, which needs their worktree); the rest follow on the next syncs
  async function readShows(
    place: OrcaPlace,
    version: string,
    pending: { dispatchId: string; alive: boolean }[],
  ): Promise<void> {
    const order = pending
      .filter((p) => shownOf(place, p.dispatchId) === null)
      .sort((a, b) => Number(b.alive) - Number(a.alive))
      .slice(0, SHOWS_PER_SYNC);
    for (let i = 0; i < order.length; i += SHOW_CONCURRENCY) {
      await Promise.all(
        order.slice(i, i + SHOW_CONCURRENCY).map((p) => showOf(place, version, p.dispatchId)),
      );
    }
  }

  // One sync of one place (this machine or one SSH host)
  async function syncPlace(
    place: OrcaPlace,
    host: RemoteHost | null,
    version: string,
    terminalList: TerminalList,
  ): Promise<OrcaRunView[]> {
    const hostId = host?.id ?? null;
    const known = knownRuns(hostId);
    const inputs = await readOrcaInputs(place, version, terminalList, () => known);
    const runs = buildTopology(inputs, known);
    const terminals = new Map(inputs.terminals.terminals.map((t) => [t.handle, t]));
    const handles = handleMap(hostId);
    // Attach the agent in an Orca terminal; an already attached one only updates its state
    const follow = async ({
      handle,
      state,
      title,
      input,
      dispatchId,
    }: {
      handle: string;
      state: OrcaState;
      title: string;
      input: string | null;
      dispatchId: string | null;
    }): Promise<string | null> => {
      const terminal = terminals.get(handle);
      const key = paneKey(place, handle);
      let liveId = handles.get(handle) ?? null;
      const attached = panes.get(key);
      if (attached !== undefined) {
        if (state !== attached.state) {
          if (state === 'working') attached.pane.observe('working');
          else if (state === 'idle' || state === 'waiting') attached.pane.observe('stopped');
          attached.state = state;
        }
        return attached.liveId;
      }
      const agentRunning =
        terminal !== undefined &&
        terminal.connected &&
        terminal.agentIdentity !== undefined &&
        ORCA_ENGINES.has(terminal.agentIdentity);
      if (!agentRunning) return liveId;
      // Items that already have a controller (started by the dashboard, or running in it after a resume) are not taken over here
      if (liveId !== null && deps.running(liveId)) return liveId;
      let agent: PaneAgent | null;
      if (liveId === null) {
        const ensured = await ensureItem(
          place,
          host,
          { handle, cwd: terminal.worktreePath, engine: engineOf(terminal) },
          title,
          input,
        );
        if (ensured === null) return null;
        liveId = ensured.liveId;
        agent = ensured.agent;
      } else {
        const home = host === null ? deps.localHome : host.home;
        agent = await findPaneAgent(place, home, handle, engineOf(terminal));
        if (agent === null) return liveId;
      }
      // A process attached before the dashboard restarted is still recorded as running: keep using it
      const running = attachedProcessOf(liveId);
      const pane = deps.attach({
        liveId,
        place,
        host,
        handle,
        engine: engineOf(terminal),
        agent,
        dispatchId,
        processId: running,
      });
      panes.set(key, { liveId, pane, state: null });
      everAttached.add(liveId);
      return liveId;
    };
    // A worker Orca runs without a pane (Contracts 35.3): its Dispatch holds what a terminal would have said, and its
    // agent process carries the same ORCA_TERMINAL_HANDLE, so the session is found the way a pane's is. alive says
    // whether Orca still holds the worker; an item is created and attached only while it does, once its worker-show
    // has been read
    const followWorker = async (
      worker: OrcaRunView['workers'][number],
      alive: boolean,
    ): Promise<string | null> => {
      const handle = worker.handle;
      if (handle === null) return null;
      const key = paneKey(place, handle);
      const attached = workers.get(key);
      if (attached !== undefined) return attached.liveId;
      let liveId = handles.get(handle) ?? null;
      const show = shownOf(place, worker.dispatchId);
      if (!alive || show === null) return liveId;
      if (liveId !== null && deps.running(liveId)) return liveId;
      const engine: LiveEngine = show.agent === 'codex' ? 'codex' : 'claude';
      let agent: PaneAgent | null;
      if (liveId === null) {
        const ensured = await ensureItem(
          place,
          host,
          { handle, cwd: show.cwd, engine },
          worker.title,
          worker.spec,
        );
        if (ensured === null) return null;
        liveId = ensured.liveId;
        agent = ensured.agent;
      } else {
        const home = host === null ? deps.localHome : host.home;
        agent = await findPaneAgent(place, home, handle, engine);
        if (agent === null) return liveId;
      }
      workers.set(key, {
        liveId,
        dispatchId: worker.dispatchId,
        worker: deps.attachWorker({
          liveId,
          place,
          host,
          worker: show,
          engine,
          agent,
          processId: attachedProcessOf(liveId),
        }),
      });
      everAttached.add(liveId);
      return liveId;
    };
    // The Run an item belongs to, and for a worker the item of the main agent that dispatched it
    const belongsTo = (liveId: string, runId: string, parent: string | null) => {
      const row = db.select().from(liveSessions).where(eq(liveSessions.id, liveId)).get();
      if (row === undefined) return;
      if (row.orcaRunId === runId && row.orcaParentLiveId === parent) return;
      db.update(liveSessions)
        .set({ orcaRunId: runId, orcaParentLiveId: parent })
        .where(eq(liveSessions.id, liveId))
        .run();
      events.publish({ type: 'live.updated', liveId });
    };
    // Workers Orca still holds, by Dispatch: the ones below are attached, the rest have left Orca
    const held = new Set<string>();
    const listed = new Set(
      inputs.terminals.terminals.filter((t) => t.connected).map((t) => t.handle),
    );
    const aliveOf = (runId: string, dispatchId: string) => {
      const row = (inputs.workers[runId] ?? []).find((w) => w.dispatchId === dispatchId);
      return row !== undefined && workerAlive(row, listed);
    };
    // The agent Orca launched for a structured worker is only in its worker-show (worker-list has no provider for it)
    await readShows(
      place,
      version,
      runs.flatMap((run) =>
        run.workers
          .filter((w) => w.handle !== null && !isPaneHandle(w.handle))
          .map((w) => ({ dispatchId: w.dispatchId, alive: aliveOf(run.id, w.dispatchId) })),
      ),
    );
    for (const run of runs) {
      for (const worker of run.workers) {
        worker.agent ??= shownOf(place, worker.dispatchId)?.agent ?? null;
      }
    }
    for (const run of runs) {
      const coordinatorId =
        run.coordinator.handle === null
          ? null
          : await follow({
              handle: run.coordinator.handle,
              state: run.coordinator.state,
              title: run.objective,
              input: null,
              dispatchId: null,
            });
      // The main agent's own item carries the Run too, so the page offers its topology even when none of the workers
      // became an item (a worker without a pane may not be attachable yet)
      if (coordinatorId !== null) belongsTo(coordinatorId, run.id, null);
      for (const worker of run.workers) {
        if (worker.handle === null) continue;
        const alive = aliveOf(run.id, worker.dispatchId);
        if (alive) held.add(worker.dispatchId);
        const workerId = isPaneHandle(worker.handle)
          ? await follow({
              handle: worker.handle,
              state: worker.state,
              title: worker.title,
              input: worker.spec,
              dispatchId: worker.dispatchId,
            })
          : await followWorker(worker, alive);
        if (workerId === null) continue;
        belongsTo(workerId, run.id, coordinatorId);
      }
    }
    // Attached terminals: end the item's process when the agent exits (Orca no longer sees an agent in it) or the terminal closes
    for (const [key, attached] of panes) {
      if (!key.startsWith(`${placeKey(place)}/`)) continue;
      const handle = key.slice(placeKey(place).length + 1);
      const terminal = terminals.get(handle);
      if (terminal?.connected === true && terminal.agentIdentity !== undefined) continue;
      attached.pane.end();
      panes.delete(key);
    }
    // Attached workers without a pane: end the item's process once Orca no longer holds the worker (it settled, or its
    // terminal was released), or its Run is no longer read
    for (const [key, attached] of workers) {
      if (!key.startsWith(`${placeKey(place)}/`)) continue;
      if (held.has(attached.dispatchId)) continue;
      attached.worker.end();
      workers.delete(key);
    }
    return runs;
  }

  // Map the coordinators and workers in the result to Live items
  function withItems(runs: OrcaRunView[], hostId: string | null, label: string | null) {
    const handles = handleMap(hostId);
    const itemOf = (handle: string | null) =>
      handle === null ? null : (handles.get(handle) ?? null);
    const engineOfItem = (liveId: string | null) =>
      liveId === null
        ? null
        : (db
            .select({ engine: liveSessions.engine })
            .from(liveSessions)
            .where(eq(liveSessions.id, liveId))
            .get()?.engine ?? null);
    return runs.map((run) => {
      const coordinatorId = itemOf(run.coordinator.handle);
      return {
        ...run,
        host: hostId === null ? null : { id: hostId, label },
        // A dashboard-started coordinator's identity terminal runs cat, which Orca does not recognize as an agent: use the item's engine
        coordinator: {
          ...run.coordinator,
          liveId: coordinatorId,
          agent: run.coordinator.agent ?? engineOfItem(coordinatorId),
        },
        workers: run.workers.map((w) => ({ ...w, liveId: itemOf(w.handle) })),
      };
    });
  }

  // Terminals Orca lists on this machine; null when its runtime is not reachable, so every pane is gone
  async function localTerminals(): Promise<{
    status: Awaited<ReturnType<typeof orcaStatus>>;
    terminals: TerminalList | null;
  }> {
    const status = await orcaStatus(deps.local);
    if (!status.running) return { status, terminals: null };
    return {
      status,
      terminals: TerminalList.parse(await orcaCall(deps.local, ['terminal', 'list'])),
    };
  }

  const handleSet = (terminals: TerminalList | null) =>
    terminals === null ? null : new Set(terminals.terminals.map((t) => t.handle));

  // Processes of agents in Orca panes on this machine that vanished while the dashboard was down (W116). It runs before
  // the Runs are read and needs nothing but terminal list: reading the Runs fails on its own whenever Orca changes their
  // shape, and a process whose pane and pid are both gone must not stay running because of that
  function endVanishedPanes(terminals: TerminalList | null): void {
    reconcileVanishedPanes(db, handleSet(terminals), (liveId) => deps.running(liveId));
  }

  // The same for the panes of one SSH host, with the pid checked on that host (W117). terminals null means Orca is
  // not running there, so every pane of it is gone
  async function endVanishedRemotePanes(
    host: RemoteHost,
    terminals: TerminalList | null,
  ): Promise<void> {
    await reconcileVanishedRemotePanes(db, host, handleSet(terminals), (liveId) =>
      deps.running(liveId),
    );
  }

  async function poll() {
    const { status, terminals } = await localTerminals();
    endVanishedPanes(terminals);
    const runs: OrcaTopology['runs'] = [];
    if (terminals !== null && status.running) {
      versions.set(placeKey(deps.local), status.version);
      runs.push(
        ...withItems(await syncPlace(deps.local, null, status.version, terminals), null, null),
      );
    }
    for (const host of deps.remoteHosts()) {
      const place: OrcaPlace = { kind: 'remote', host };
      const remote = await orcaStatus(place);
      // Orca not running on that host means every pane of it is gone, as it does for this machine
      if (!remote.running) {
        await endVanishedRemotePanes(host, null);
        continue;
      }
      versions.set(placeKey(place), remote.version);
      const list = TerminalList.parse(await orcaCall(place, ['terminal', 'list']));
      await endVanishedRemotePanes(host, list);
      runs.push(
        ...withItems(await syncPlace(place, host, remote.version, list), host.id, host.label),
      );
    }
    const local = status.running
      ? { running: true, reason: null }
      : { running: false, reason: status.reason };
    const next: OrcaTopology = { local, runs };
    if (JSON.stringify(next) !== JSON.stringify(topology)) {
      topology = next;
      events.publish({ type: 'orca.updated' });
    }
  }

  // One sync; waits for the previous one if it is still running
  function pollOnce(): Promise<void> {
    polling ??= poll().finally(() => {
      polling = null;
    });
    return polling;
  }

  // Sync failure: the original text goes into the topology (shown on the page), previous Runs are kept, retries continue as usual
  function failed(error: unknown) {
    topology = {
      local: {
        running: false,
        reason: `Reading Orca failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      runs: topology.runs,
    };
    events.publish({ type: 'orca.updated' });
  }

  let stopped = false;
  function after(run: Promise<void>) {
    void run.then(undefined, failed).then(() => {
      if (!stopped) schedule();
    });
  }

  function schedule() {
    timer = setTimeout(() => {
      timer = null;
      after(deps.hasViewers() || stopping > 0 ? pollOnce() : Promise.resolve());
    }, deps.pollMs);
  }

  return {
    // Sync once right after the server listens (pages or not): reattach items attached before the restart, then sync every pollMs while a page is connected
    start() {
      if (timer !== null || polling !== null) return;
      stopped = false;
      after(pollOnce());
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    pollOnce,
    topology: () => topology,
    // Terminal handles Orca lists for this machine or one SSH host right now; null when its runtime is not reachable,
    // so every pane is gone. "Stop process" reads it to tell a vanished pane from one the sync has not attached yet
    // (W116, W117)
    async paneHandles(host: RemoteHost | null): Promise<Set<string> | null> {
      if (host === null) return handleSet((await localTerminals()).terminals);
      const place: OrcaPlace = { kind: 'remote', host };
      const status = await orcaStatus(place);
      if (!status.running) return null;
      return handleSet(TerminalList.parse(await orcaCall(place, ['terminal', 'list'])));
    },
    // Keep syncing during "Stop process" (the agent's exit is found by the sync)
    async whileStopping<T>(work: () => Promise<T>): Promise<T> {
      stopping += 1;
      return work().finally(() => {
        stopping -= 1;
      });
    },
    // Dispatch of a running Orca item (for worker-stop): looked up by terminal handle in the latest topology
    dispatchOf(liveId: string): string | null {
      for (const run of topology.runs) {
        const worker = run.workers.find((w) => w.liveId === liveId);
        if (worker !== undefined) return worker.dispatchId;
      }
      return null;
    },
    // The Orca that holds one item's worker, for reading its transcript and sending it input (Contracts 35.4). The
    // version is the one of the latest sync of that place; without a sync there is nothing to read yet
    placeOf(host: RemoteHost | null): { place: OrcaPlace; version: string } | null {
      const place: OrcaPlace = host === null ? deps.local : { kind: 'remote', host };
      const version = versions.get(placeKey(place));
      return version === undefined ? null : { place, version };
    },
  };
}

export type OrcaSync = ReturnType<typeof createOrcaSync>;
