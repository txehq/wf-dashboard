import type { OrcaGraph, OrcaGraphEdge, OrcaGraphNode } from '@/lib/orca-api';
import type { GroupKey } from '@/lib/orca-states';

// What the topology page draws of the graph (Contracts 40.2): one box per project (a repo on this machine or an SSH
// host) and inside it one box per worktree, filtered by project and state. Every box can collapse into its title, and
// a worktree with many sessions shows its exited ones as one "N exited" node until it is opened

// A worktree with more sessions than this starts with its exited ones collapsed
export const MANY_SESSIONS = 12;

export interface WorktreeBox {
  key: string;
  project: string;
  name: string;
  branch: string | null;
  // The repo's own directory
  main: boolean;
  sessions: number;
  working: number;
  collapsed: boolean;
  // Exited sessions folded into one node; null when they show one by one
  exitedFolded: number | null;
}

export interface ProjectBox {
  key: string;
  name: string;
  host: string | null;
  sessions: number;
  working: number;
  collapsed: boolean;
  // Its worktree boxes; empty while the project is collapsed
  worktrees: WorktreeBox[];
}

export type ShownNode =
  | { kind: 'session'; id: string; worktree: string; node: OrcaGraphNode }
  | { kind: 'exited'; id: string; worktree: string; members: string[] };

export interface ShownEdge {
  id: string;
  kind: OrcaGraphEdge['kind'];
  source: string;
  target: string;
  label: string | null;
  count: number;
  last: OrcaGraphEdge['last'];
  // The sessions on each end (several when an end is a folded node or a collapsed box)
  sourceMembers: string[];
  targetMembers: string[];
}

export interface Filters {
  // Project keys to show; empty shows them all
  projects: string[];
  states: GroupKey[];
}

export const defaultFilters = (states: GroupKey[]): Filters => ({
  projects: [],
  states,
});

export const stateGroupOf = (node: OrcaGraphNode): GroupKey | null => {
  if (node.state === null) return null;
  if (node.state === 'working') return 'working';
  if (node.state === 'waiting' || node.state === 'idle') return 'waiting';
  return 'exited';
};

export const projectKeyOf = (node: OrcaGraphNode): string =>
  `${node.host?.id ?? 'local'}/${node.location.project?.id ?? ''}`;

export const worktreeKeyOf = (node: OrcaGraphNode): string =>
  `${projectKeyOf(node)}|${node.location.worktree.path}`;

const OTHER = 'Other sessions';

// Every project in the graph, for the filter: sessions with no known repo share one per place
export function projectsOf(graph: OrcaGraph): { key: string; name: string; host: string | null }[] {
  const out = new Map<string, { key: string; name: string; host: string | null }>();
  for (const node of graph.nodes) {
    const key = projectKeyOf(node);
    if (out.has(key)) continue;
    out.set(key, {
      key,
      name: node.location.project?.name ?? OTHER,
      host: node.host === null ? null : (node.host.label ?? node.host.id),
    });
  }
  return [...out.values()].sort(
    (a, b) => Number(a.name === OTHER) - Number(b.name === OTHER) || a.name.localeCompare(b.name),
  );
}

// The repo's own directory first, then worktrees by name
const worktreeOrder = (a: WorktreeBox, b: WorktreeBox) =>
  Number(b.main) - Number(a.main) || a.name.localeCompare(b.name);

export function shownGraph(
  graph: OrcaGraph,
  filters: Filters,
  // toggled holds the project and worktree boxes the user collapsed
  view: { toggled: Set<string>; unfolded: Set<string>; selected: string | null },
): { projects: ProjectBox[]; nodes: ShownNode[]; edges: ShownEdge[] } {
  const wanted = new Set(filters.projects);
  const states = new Set(filters.states);
  // A session with no state of its own (a peer whose state nothing reports) shows with the sessions it talked to
  const neighbours = new Map<string, string[]>();
  for (const e of graph.edges) {
    neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target]);
    neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source]);
  }
  const passes = (node: OrcaGraphNode) => {
    if (node.id === view.selected) return true;
    if (wanted.size > 0 && !wanted.has(projectKeyOf(node))) return false;
    const group = stateGroupOf(node);
    return group === null || states.has(group);
  };
  const kept = new Set(graph.nodes.filter((n) => n.kind !== 'peer' && passes(n)).map((n) => n.id));
  for (const n of graph.nodes) {
    if (n.kind !== 'peer' || !passes(n)) continue;
    if (n.id === view.selected || (neighbours.get(n.id) ?? []).some((id) => kept.has(id))) {
      kept.add(n.id);
    }
  }
  const visible = graph.nodes.filter((n) => kept.has(n.id));

  const byProject = new Map<string, OrcaGraphNode[]>();
  for (const n of visible) {
    const key = projectKeyOf(n);
    byProject.set(key, [...(byProject.get(key) ?? []), n]);
  }
  const names = new Map(projectsOf(graph).map((p) => [p.key, p]));
  const projects: ProjectBox[] = [];
  const nodes: ShownNode[] = [];
  // Where each session is drawn: itself, its worktree's "N exited" node, or its collapsed worktree or project box
  const drawnAs = new Map<string, string>();
  for (const [key, members] of byProject) {
    const info = names.get(key);
    const holds = (list: OrcaGraphNode[]) => list.some((n) => n.id === view.selected);
    const collapsed = view.toggled.has(key) && !holds(members);
    const box: ProjectBox = {
      key,
      name: info?.name ?? key,
      host: info?.host ?? null,
      sessions: members.length,
      working: members.filter((n) => n.state === 'working').length,
      collapsed,
      worktrees: [],
    };
    projects.push(box);
    if (collapsed) {
      for (const n of members) drawnAs.set(n.id, `project:${key}`);
      continue;
    }
    const byWorktree = new Map<string, OrcaGraphNode[]>();
    for (const n of members) {
      const wkey = worktreeKeyOf(n);
      byWorktree.set(wkey, [...(byWorktree.get(wkey) ?? []), n]);
    }
    for (const [wkey, inside] of byWorktree) {
      const first = inside[0];
      if (first === undefined) continue;
      const shut = view.toggled.has(wkey) && !holds(inside);
      const exited = inside.filter((n) => stateGroupOf(n) === 'exited');
      const fold =
        !shut &&
        inside.length > MANY_SESSIONS &&
        exited.length > 1 &&
        !view.unfolded.has(wkey) &&
        !holds(exited);
      box.worktrees.push({
        key: wkey,
        project: key,
        name: first.location.worktree.name,
        branch: inside.find((n) => n.location.branch !== null)?.location.branch ?? null,
        main: first.location.worktree.main,
        sessions: inside.length,
        working: inside.filter((n) => n.state === 'working').length,
        collapsed: shut,
        exitedFolded: fold ? exited.length : null,
      });
      if (shut) {
        for (const n of inside) drawnAs.set(n.id, `worktree:${wkey}`);
        continue;
      }
      const folded = new Set(fold ? exited.map((n) => n.id) : []);
      for (const n of inside) {
        if (folded.has(n.id)) continue;
        nodes.push({ kind: 'session', id: n.id, worktree: wkey, node: n });
        drawnAs.set(n.id, n.id);
      }
      if (fold) {
        const id = `exited:${wkey}`;
        nodes.push({ kind: 'exited', id, worktree: wkey, members: [...folded] });
        for (const n of folded) drawnAs.set(n, id);
      }
    }
    box.worktrees.sort(worktreeOrder);
  }

  const edges = new Map<string, ShownEdge>();
  for (const e of graph.edges) {
    let source = drawnAs.get(e.source);
    let target = drawnAs.get(e.target);
    if (source === undefined || target === undefined || source === target) continue;
    let ends = [e.source, e.target];
    // Messages go both ways: one edge per pair of drawn nodes
    if (e.kind === 'message' && target < source) {
      [source, target] = [target, source];
      ends = [e.target, e.source];
    }
    const [from = e.source, to = e.target] = ends;
    const key = `${e.kind}|${source}|${target}`;
    const known = edges.get(key);
    if (known === undefined) {
      edges.set(key, {
        id: key,
        kind: e.kind,
        source,
        target,
        label: e.label,
        count: e.count,
        last: e.last,
        sourceMembers: [from],
        targetMembers: [to],
      });
      continue;
    }
    known.count += e.count;
    if (!known.sourceMembers.includes(from)) known.sourceMembers.push(from);
    if (!known.targetMembers.includes(to)) known.targetMembers.push(to);
    if (e.last !== null && (known.last === null || known.last.at < e.last.at)) {
      known.last = e.last;
      known.label = e.label;
    }
  }
  // A message edge runs the way the dispatch between the same two nodes does, so both leave the main agent's side
  const shownEdges = [...edges.values()];
  const dispatched = new Set(
    shownEdges.filter((e) => e.kind === 'dispatch').map((e) => `${e.source}|${e.target}`),
  );
  for (const e of shownEdges) {
    if (e.kind !== 'message' || !dispatched.has(`${e.target}|${e.source}`)) continue;
    [e.source, e.target] = [e.target, e.source];
    [e.sourceMembers, e.targetMembers] = [e.targetMembers, e.sourceMembers];
  }
  return {
    projects: projects.sort(
      (a, b) => Number(a.name === OTHER) - Number(b.name === OTHER) || a.name.localeCompare(b.name),
    ),
    nodes,
    edges: shownEdges,
  };
}
