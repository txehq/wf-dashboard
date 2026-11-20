import type { OrcaLocation, OrcaState } from '../orca/topology.js';
import { isPaneHandle } from '../orca/topology.js';
import type { PeerMessage } from './orca-peers.js';
import type { OrcaGraphEdge, OrcaGraphMessage, OrcaGraphNode, OrcaTopology } from './views.js';

// The graph of the Orca topology page (Contracts 40): sessions as nodes, dispatch and message edges, from the
// topology sync's latest Runs and the cross-session messages its sessions received. Conversion only

// A cross-session message with its sender as the sync found it: a Live item, else a session record (null for both
// when neither is known)
export type OrcaPeer = PeerMessage & {
  fromSession: { id: string; engine: 'claude' | 'codex'; cwd: string | null } | null;
};

// What the page shows of a session that is a Live item
export interface GraphItem {
  title: string;
  engine: string;
  state: OrcaState | null;
  cwd: string;
  host: { id: string; label: string | null } | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
}

export interface GraphInputs {
  topology: OrcaTopology;
  peers: OrcaPeer[];
  item: (liveId: string) => GraphItem | null;
  locate: (hostId: string | null, cwd: string) => OrcaLocation;
  // The Live item that already holds a session record, if any
  itemOfSession: (sessionId: string) => string | null;
  // Whether a directory on this machine exists, by its latest check; null while that is unknown (W139). Directories
  // on SSH hosts are not checked
  exists: (dir: string) => boolean | null;
  // Where this machine's session records are looked for
  sessionDirs: string[];
}

type Session = OrcaTopology['runs'][number]['coordinator']['session'];
// A node before its working directory is checked and before it knows why each way to open it does or does not work
type Draft = Omit<OrcaGraphNode, 'open' | 'location'> & { location: OrcaLocation };

const PREVIEW = 200;

const firstLine = (text: string) => (text.split('\n')[0] ?? text).slice(0, 120);

const preview = (subject: string, body: string) =>
  Array.from(subject === '' ? body : `${subject}\n${body}`)
    .slice(0, PREVIEW)
    .join('');

// The edge key of two sessions talking, the same in both directions
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// A session whose repo Orca no longer knows (its terminal is closed and no Live item says where it worked) belongs to
// the project of the sessions it dispatched, the one most of them are in; a worker without one to its main agent's.
// Only the project is filled in: its directory and branch stay unknown
function placeUnlocated(nodes: Map<string, Draft>, dispatches: OrcaGraphEdge[]): void {
  for (const node of nodes.values()) {
    if (node.location.project !== null || node.kind !== 'coordinator') continue;
    const counts = new Map<string, { project: { id: string; name: string }; n: number }>();
    for (const e of dispatches) {
      if (e.source !== node.id) continue;
      const project = nodes.get(e.target)?.location.project;
      if (project == null) continue;
      const known = counts.get(project.id) ?? { project, n: 0 };
      known.n += 1;
      counts.set(project.id, known);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (best !== undefined) node.location = { ...node.location, project: best.project };
  }
  for (const node of nodes.values()) {
    if (node.location.project !== null) continue;
    const from = dispatches.find((e) => e.target === node.id);
    const project = from === undefined ? null : (nodes.get(from.source)?.location.project ?? null);
    if (project !== null) node.location = { ...node.location, project };
  }
}

export function buildOrcaGraph(inputs: GraphInputs): {
  nodes: OrcaGraphNode[];
  edges: OrcaGraphEdge[];
  messages: OrcaGraphMessage[];
} {
  const nodes = new Map<string, Draft>();
  const dispatches = new Map<string, OrcaGraphEdge & { startedAt: number | null; spec: string }>();
  const talks = new Map<string, OrcaGraphEdge>();
  const messages: OrcaGraphMessage[] = [];
  // Node of each terminal handle on each place, and Orca's names for each Run's sessions
  const byHandle = new Map<string, string>();
  const runNames = new Map<string, Map<string, string>>();

  // A session of a Run; the first Run that names it (Orca lists the newest first) decides its state and location
  const nodeOf = (
    run: OrcaTopology['runs'][number],
    kind: 'coordinator' | 'worker',
    session: {
      handle: string | null;
      agent: string | null;
      state: OrcaState;
      liveId: string | null;
      openTerminal: string | null;
      session: Session;
      location: OrcaLocation;
    },
    fallback: { key: string; title: string },
  ): string => {
    const place = run.host?.id ?? 'local';
    // A node is a session: its Live item, else its session record, else its terminal (one terminal can hold several
    // sessions over time, and one main agent can hold several Runs under handles Orca issued again on restart)
    const id =
      session.liveId !== null
        ? `live:${session.liveId}`
        : session.session !== null
          ? `${place}/session:${session.session.id}`
          : session.handle !== null
            ? `${place}/terminal:${session.handle}`
            : `${place}/${fallback.key}`;
    const known = nodes.get(id);
    if (known !== undefined) {
      if (!known.runIds.includes(run.id)) known.runIds.push(run.id);
      if (kind === 'coordinator') known.kind = 'coordinator';
      // The newest Run and Dispatch come first: a later one only fills in what is still missing
      known.session ??= session.session;
      known.openTerminal ??= session.openTerminal;
      return id;
    }
    const item = session.liveId === null ? null : inputs.item(session.liveId);
    nodes.set(id, {
      id,
      kind,
      title: item?.title ?? firstLine(fallback.title),
      agent: session.agent ?? item?.engine ?? session.session?.engine ?? null,
      state: session.state,
      location: session.location,
      host: run.host,
      handle: session.handle,
      pane: session.handle !== null && isPaneHandle(session.handle),
      openTerminal: session.openTerminal,
      liveId: session.liveId,
      session: session.session,
      runIds: [run.id],
      model: item?.model ?? null,
      effort: item?.effort ?? null,
      costUsd: item?.costUsd ?? null,
    });
    return id;
  };

  const talk = (from: string, to: string, at: number, text: string) => {
    const key = pairKey(from, to);
    const edge = talks.get(key) ?? {
      id: `message:${key}`,
      kind: 'message' as const,
      source: from,
      target: to,
      label: null,
      count: 0,
      last: null,
    };
    edge.count += 1;
    if (edge.last === null || edge.last.at <= at) edge.last = { at, text };
    talks.set(key, edge);
  };

  for (const run of inputs.topology.runs) {
    const place = run.host?.id ?? 'local';
    // Orca's names for the sessions of this Run: run:<id> is its main agent, dispatch:<id> a worker, and each
    // terminal handle the session in it
    const names = new Map<string, string>();
    const coordinator = nodeOf(run, 'coordinator', run.coordinator, {
      key: `run:${run.id}`,
      title: run.objective,
    });
    names.set(`run:${run.id}`, coordinator);
    if (run.coordinator.handle !== null) {
      names.set(run.coordinator.handle, coordinator);
      byHandle.set(`${place}/${run.coordinator.handle}`, coordinator);
    }
    for (const worker of run.workers) {
      const id = nodeOf(run, 'worker', worker, {
        key: `dispatch:${worker.dispatchId}`,
        title: worker.title,
      });
      names.set(`dispatch:${worker.dispatchId}`, id);
      if (worker.handle !== null) {
        names.set(worker.handle, id);
        byHandle.set(`${place}/${worker.handle}`, id);
      }
      if (id === coordinator) continue;
      const key = `${coordinator}|${id}`;
      const edge = dispatches.get(key) ?? {
        id: `dispatch:${key}`,
        kind: 'dispatch' as const,
        source: coordinator,
        target: id,
        label: worker.title,
        count: 0,
        last: null,
        startedAt: worker.startedAt,
        spec: worker.spec,
      };
      edge.count += 1;
      if (worker.startedAt !== null && (edge.startedAt ?? 0) < worker.startedAt) {
        edge.label = worker.title;
        edge.startedAt = worker.startedAt;
        edge.spec = worker.spec;
      }
      dispatches.set(key, edge);
    }
    runNames.set(run.id, names);
  }
  // Messages once every session has its node: one may name a terminal of another Run
  placeUnlocated(nodes, [...dispatches.values()]);
  for (const run of inputs.topology.runs) {
    const place = run.host?.id ?? 'local';
    const names = runNames.get(run.id) ?? new Map<string, string>();
    for (const m of run.messages) {
      const from = names.get(m.from) ?? byHandle.get(`${place}/${m.from}`);
      const to = names.get(m.to) ?? byHandle.get(`${place}/${m.to}`);
      if (from === undefined || to === undefined || from === to) continue;
      talk(from, to, m.at, preview(m.subject, m.body));
      messages.push({
        id: m.id,
        source: 'orca',
        type: m.type,
        from,
        to,
        subject: m.subject,
        body: m.body,
        at: m.at,
        answered: m.answered,
      });
    }
  }

  // A cross-session message names its sender by session name: a sender with a Live item outside the Runs becomes a
  // peer node of its own, one found by its session record a node of that session (the one the Runs gave it, when
  // they did)
  const itemNode = (liveId: string, item: GraphItem): string => {
    const id = `live:${liveId}`;
    if (nodes.has(id)) return id;
    nodes.set(id, {
      id,
      kind: 'peer',
      title: item.title,
      agent: item.engine,
      state: item.state,
      location: inputs.locate(item.host?.id ?? null, item.cwd),
      host: item.host,
      handle: null,
      pane: false,
      openTerminal: null,
      liveId,
      session: null,
      runIds: [],
      model: item.model,
      effort: item.effort,
      costUsd: item.costUsd,
    });
    return id;
  };
  // The node of each receiver's Live item: keyed by the item, or by its session record when the Runs found the
  // session before it became an item
  const receivers = new Map<string, string>();
  for (const node of nodes.values()) {
    const liveId =
      node.liveId ?? (node.session === null ? null : inputs.itemOfSession(node.session.id));
    if (liveId !== null && !receivers.has(liveId)) receivers.set(liveId, node.id);
  }
  for (const p of inputs.peers) {
    const to = receivers.get(p.receiverLiveId);
    const receiver = to === undefined ? undefined : nodes.get(to);
    if (to === undefined || receiver === undefined) continue;
    const hostId = receiver.host?.id ?? null;
    const place = hostId ?? 'local';
    let from: string;
    const item = p.fromLiveId === null ? null : inputs.item(p.fromLiveId);
    const sender = p.fromSession;
    if (p.fromLiveId !== null && item !== null) {
      from = itemNode(p.fromLiveId, item);
    } else if (sender !== null) {
      from = `${place}/session:${sender.id}`;
      const held = inputs.itemOfSession(sender.id);
      const heldItem = held === null ? null : inputs.item(held);
      if (!nodes.has(from) && held !== null && heldItem !== null) {
        from = itemNode(held, heldItem);
      } else if (!nodes.has(from)) {
        nodes.set(from, {
          id: from,
          kind: 'peer',
          title: p.fromName,
          agent: sender.engine,
          state: null,
          location:
            sender.cwd === null
              ? { cwd: null, worktree: null, branch: null, project: null }
              : inputs.locate(hostId, sender.cwd),
          host: receiver.host,
          handle: null,
          pane: false,
          openTerminal: null,
          liveId: null,
          session: { id: sender.id, engine: sender.engine },
          runIds: [],
          model: null,
          effort: null,
          costUsd: null,
        });
      }
    } else {
      // Known only by its name: no source gives its working directory, so it is not on the page (Contracts 40.2)
      continue;
    }
    if (from === to) continue;
    talk(from, to, p.at, preview('', p.body));
    messages.push({
      id: `peer:${p.id}`,
      source: 'peer',
      type: 'message',
      from,
      to,
      subject: '',
      body: p.body,
      at: p.at,
      answered: null,
    });
  }

  const edges: OrcaGraphEdge[] = [
    ...[...dispatches.values()].map(({ startedAt, spec, ...edge }) => ({
      ...edge,
      last:
        talks.get(pairKey(edge.source, edge.target))?.last ??
        (startedAt === null
          ? null
          : { at: startedAt, text: Array.from(spec).slice(0, PREVIEW).join('') }),
    })),
    ...talks.values(),
  ];
  // Every session on the page sits in a worktree box (Contracts 40.2): one for which no source gives a working
  // directory is left out with its edges and messages, and so is one on this machine whose working directory is not
  // known to exist (its worktree was deleted, or the check has not finished), unless its terminal is still open
  const shown = [...nodes.values()]
    .filter((node) => {
      const cwd = node.location.cwd;
      if (cwd === null) return false;
      return node.openTerminal !== null || node.host !== null || inputs.exists(cwd) === true;
    })
    .map((node) => finish(inputs, node));
  const ids = new Set(shown.map((node) => node.id));
  const between = (from: string, to: string) => ids.has(from) && ids.has(to);
  return {
    nodes: shown,
    edges: edges.filter((e) => between(e.source, e.target)),
    messages: messages.filter((m) => between(m.from, m.to)).sort((a, b) => a.at - b.at),
  };
}

// A node's last details: its worktree, the Live item already holding its session record, and why each way to open it
// does not work (Contracts 40.2)
function finish(inputs: GraphInputs, draft: Draft): OrcaGraphNode {
  const { cwd, worktree } = draft.location;
  // A directory always lies in a worktree: Orca's, or the directory itself (topology locate)
  if (cwd === null || worktree === null) {
    throw new Error(`Orca page node ${draft.id} has no worktree for ${cwd ?? 'no directory'}`);
  }
  const node = { ...draft, location: { ...draft.location, cwd, worktree } };
  if (node.liveId === null && node.session !== null) {
    node.liveId = inputs.itemOfSession(node.session.id);
    const item = node.liveId === null ? null : inputs.item(node.liveId);
    if (item !== null) {
      node.model = item.model;
      node.effort = item.effort;
      node.costUsd = item.costUsd;
    }
  }
  const hostId = node.host?.id ?? null;
  const cwdExists = hostId === null ? inputs.exists(cwd) : null;
  let live: string | null = null;
  if (node.liveId === null) {
    if (node.host !== null) {
      live = `Its session record is on ${node.host.label ?? node.host.id}; only this machine's records are imported`;
    } else if (node.session === null) {
      live = `No session record in ${inputs.sessionDirs.join(' or ')} names its Orca ${node.kind === 'coordinator' ? 'Run' : 'task'}`;
    }
  }
  const orca =
    node.openTerminal !== null
      ? null
      : node.handle === null
        ? 'Orca has no terminal for it'
        : !node.pane
          ? 'It runs in Orca without a terminal'
          : 'Orca has closed its terminal';
  const vscode = cwdExists === false ? `${cwd} no longer exists` : null;
  return { ...node, open: { live, orca, vscode } };
}
