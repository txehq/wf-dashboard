import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { ChevronDown, ChevronRight, GitBranch, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EngineLogo } from '@/components/live/live-identity';
import { formatDateTime } from '@/lib/format';
import type { OrcaGraphNode } from '@/lib/orca-api';
import { engineOf, stateLabel, stateTone } from '@/lib/orca-states';
import type { ProjectBox, ShownEdge, ShownNode, WorktreeBox } from '@/lib/orca-view';
import { useSize } from '@/lib/use-size';
import { cn } from '@/lib/utils';

// The graph of the topology page (Contracts 40.2): React Flow draws it, ELK places it, with each project a box around
// its worktrees' boxes and each worktree box a layered layout of its sessions. Dispatch edges are solid arrows from a
// main agent to its workers labelled with the task, message edges dashed with the message count, and either may run
// between boxes; hovering an edge shows its latest message. A session whose terminal is still open in Orca stands out

const SESSION = { width: 248, height: 64 };
const FOLDED = { width: 168, height: 48 };
const COLLAPSED = { width: 248, height: 56 };
const WORKTREE_COLLAPSED = { width: 232, height: 44 };
// Room for a project's and a worktree's title rows
const HEADER = 40;
const WORKTREE_HEADER = 32;

const elk = new ELK();

interface SessionData extends Record<string, unknown> {
  node: OrcaGraphNode;
  selected: boolean;
}
interface FoldedData extends Record<string, unknown> {
  count: number;
}
interface ProjectData extends Record<string, unknown> {
  box: ProjectBox;
  onToggle: () => void;
}
interface WorktreeData extends Record<string, unknown> {
  box: WorktreeBox;
  onToggle: () => void;
}
interface EdgeData extends Record<string, unknown> {
  edge: ShownEdge;
  selected: boolean;
  // A message edge alongside a dispatch edge between the same nodes: its label sits below the task's
  twin: boolean;
  onHover: (edge: ShownEdge | null, at: { x: number; y: number } | null) => void;
  onSelect: (id: string) => void;
}

type SessionNode = Node<SessionData, 'session'>;
type FoldedNode = Node<FoldedData, 'folded'>;
type ProjectNode = Node<ProjectData, 'project'>;
type WorktreeNode = Node<WorktreeData, 'worktree'>;
type FlowNode = SessionNode | FoldedNode | ProjectNode | WorktreeNode;
type FlowEdge = Edge<EdgeData, 'orca'>;

const hiddenHandle = '!size-1 !min-w-0 !min-h-0 !border-0 !bg-transparent';

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className={hiddenHandle} />
      <Handle type="source" position={Position.Right} className={hiddenHandle} />
    </>
  );
}

const kindLabel: Record<OrcaGraphNode['kind'], string> = {
  coordinator: 'Main agent',
  worker: 'Worker',
  peer: 'Session',
};

function SessionView({ data }: NodeProps<SessionNode>) {
  const { node } = data;
  const engine = engineOf(node.agent);
  const open = node.openTerminal !== null;
  return (
    <div
      style={SESSION}
      className={cn(
        'relative flex cursor-pointer flex-col justify-center gap-1 rounded-md px-2.5 text-left hover:border-foreground',
        // A window still open in Orca is solid with a green edge; the rest are dimmed
        open
          ? 'bg-card shadow-sm before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full before:bg-[var(--viz-status-good)]'
          : 'bg-muted/40 text-muted-foreground',
        // Main agents and workers differ by border; a session outside the Runs has a dashed one
        node.kind === 'coordinator' && 'border-2 border-foreground/70',
        node.kind === 'worker' && 'border border-foreground/30',
        node.kind === 'peer' && 'border border-dashed border-foreground/40',
        data.selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
      )}
      title={`${kindLabel[node.kind]} · ${node.title}${open ? ' · terminal open in Orca' : ''}`}
      data-testid="orca-node"
      data-node={node.id}
      data-kind={node.kind}
      data-terminal-open={open}
    >
      <Handles />
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-sm font-medium',
          open && 'text-foreground',
        )}
      >
        {engine !== null && <EngineLogo engine={engine} className="size-3.5" />}
        <span className="min-w-0 truncate">{node.title}</span>
        {open && (
          <SquareTerminal
            className="ml-auto size-3.5 shrink-0 text-[var(--viz-status-good)]"
            aria-label="Terminal open in Orca"
          />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {node.state === null ? (
          <span className="shrink-0">Known by name only</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1" data-state={node.state}>
            <span className={cn('size-1.5 rounded-full', stateTone[node.state])} aria-hidden />
            {stateLabel[node.state]}
          </span>
        )}
        {node.location.branch !== null && (
          <span className="flex min-w-0 items-center gap-0.5 font-mono" data-testid="orca-branch">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{node.location.branch}</span>
          </span>
        )}
      </span>
    </div>
  );
}

function FoldedView({ data }: NodeProps<FoldedNode>) {
  return (
    <div
      style={FOLDED}
      className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-foreground/30 bg-muted/40 text-xs text-muted-foreground hover:border-foreground hover:text-foreground"
      title="Show them"
      data-testid="orca-folded"
    >
      <Handles />
      {data.count} exited
    </div>
  );
}

function ProjectView({ data, width, height }: NodeProps<ProjectNode>) {
  const { box } = data;
  return (
    <div
      style={{ width, height }}
      className={cn(
        'rounded-lg border bg-muted/20',
        box.collapsed && 'flex items-center bg-card hover:border-foreground',
      )}
      data-testid="orca-project"
      data-project={box.key}
    >
      <Handles />
      <button
        type="button"
        className="nodrag flex w-full min-w-0 items-center gap-1.5 px-3 text-left text-sm font-semibold"
        style={{ height: box.collapsed ? height : HEADER }}
        aria-expanded={!box.collapsed}
        onClick={data.onToggle}
      >
        {box.collapsed ? (
          <ChevronRight className="size-4 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{box.name}</span>
        {box.host !== null && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">on {box.host}</span>
        )}
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
          {box.sessions} · {box.working} working
        </span>
      </button>
    </div>
  );
}

// A worktree inside a project box: its name and branch
function WorktreeView({ data, width, height }: NodeProps<WorktreeNode>) {
  const { box } = data;
  return (
    <div
      style={{ width, height }}
      className={cn(
        'rounded-md border border-foreground/15 bg-background/60',
        box.collapsed && 'flex items-center hover:border-foreground',
      )}
      data-testid="orca-worktree"
      data-worktree={box.key}
    >
      <Handles />
      <button
        type="button"
        className="nodrag flex w-full min-w-0 items-center gap-1 px-2 text-left text-xs font-medium"
        style={{ height: box.collapsed ? height : WORKTREE_HEADER }}
        aria-expanded={!box.collapsed}
        onClick={data.onToggle}
      >
        {box.collapsed ? (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{box.name}</span>
        {box.branch !== null && box.branch !== box.name && (
          <span className="flex min-w-0 items-center gap-0.5 font-mono font-normal text-muted-foreground">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{box.branch}</span>
          </span>
        )}
        <span className="ml-auto shrink-0 pl-1 font-normal text-muted-foreground">
          {box.sessions}
        </span>
      </button>
    </div>
  );
}

function OrcaEdgeView(props: EdgeProps<FlowEdge>) {
  const { data } = props;
  const [path, labelX, labelY] = getBezierPath(props);
  if (data === undefined) throw new Error(`Edge ${props.id} has no data`);
  const { edge } = data;
  const message = edge.kind === 'message';
  const label =
    edge.kind === 'dispatch'
      ? `${edge.label ?? 'Task'}${edge.count > 1 ? ` · ${String(edge.count)} tasks` : ''}`
      : `${String(edge.count)} ${edge.count === 1 ? 'message' : 'messages'}`;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd === undefined ? {} : { markerEnd: props.markerEnd })}
        interactionWidth={16}
        style={{
          stroke: data.selected ? 'var(--ring)' : 'var(--muted-foreground)',
          strokeWidth: data.selected ? 2 : 1.25,
          strokeDasharray: message ? '5 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn(
            'nodrag nopan absolute max-w-40 truncate rounded border bg-background px-1 text-[10px] leading-4 text-muted-foreground hover:text-foreground',
            data.selected && 'border-ring text-foreground',
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY + (data.twin ? 18 : 0))}px)`,
            pointerEvents: 'all',
            // Above the edges (drawn at z-index 3), so a label stays clickable where edges cross it
            zIndex: 4,
          }}
          data-testid="orca-edge-label"
          data-kind={edge.kind}
          onMouseEnter={(e) => {
            data.onHover(edge, { x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => {
            data.onHover(null, null);
          }}
          onClick={() => {
            data.onSelect(edge.id);
          }}
        >
          {label}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = {
  session: SessionView,
  folded: FoldedView,
  project: ProjectView,
  worktree: WorktreeView,
};
const edgeTypes = { orca: OrcaEdgeView };

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ELK's layout of the shown graph: inside each worktree box a layered layout of its sessions (main agents left of
// their workers), the worktree boxes packed inside their project box, and the project boxes packed together in rows
// to fit the canvas's shape. Edges between boxes are left to React Flow, which draws every edge between its two nodes
// itself
async function layout(
  projects: ProjectBox[],
  nodes: ShownNode[],
  edges: ShownEdge[],
  aspectRatio: number,
): Promise<Map<string, Placed>> {
  const worktreeOf = new Map(nodes.map((n) => [n.id, n.worktree]));
  const worktreeNode = (w: WorktreeBox): ElkNode =>
    w.collapsed
      ? { id: `worktree:${w.key}`, ...WORKTREE_COLLAPSED }
      : {
          id: `worktree:${w.key}`,
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            // Room between a main agent and its workers for the task labels on the edges
            'elk.layered.spacing.nodeNodeBetweenLayers': '176',
            'elk.spacing.nodeNode': '16',
            'elk.spacing.componentComponent': '24',
            'elk.padding': `[top=${String(WORKTREE_HEADER + 8)},left=12,bottom=12,right=12]`,
            // Wide enough for the title row
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${String(WORKTREE_COLLAPSED.width)}, ${String(WORKTREE_HEADER)})`,
          },
          children: nodes
            .filter((n) => n.worktree === w.key)
            .map((n) => ({ id: n.id, ...(n.kind === 'session' ? SESSION : FOLDED) })),
          edges: edges
            .filter((e) => worktreeOf.get(e.source) === w.key && worktreeOf.get(e.target) === w.key)
            .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
        };
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.aspectRatio': String(aspectRatio),
      'elk.spacing.nodeNode': '32',
      'elk.padding': '[top=8,left=8,bottom=8,right=8]',
    },
    children: projects.map((p) =>
      p.collapsed
        ? { id: `project:${p.key}`, ...COLLAPSED }
        : {
            id: `project:${p.key}`,
            layoutOptions: {
              'elk.algorithm': 'rectpacking',
              'elk.aspectRatio': String(aspectRatio),
              'elk.spacing.nodeNode': '16',
              'elk.padding': `[top=${String(HEADER + 8)},left=16,bottom=16,right=16]`,
              'elk.nodeSize.constraints': 'MINIMUM_SIZE',
              'elk.nodeSize.minimum': `(${String(COLLAPSED.width)}, ${String(HEADER)})`,
            },
            children: p.worktrees.map(worktreeNode),
          },
    ),
  };
  const done = await elk.layout(root);
  const placed = new Map<string, Placed>();
  const visit = (n: ElkNode) => {
    placed.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 });
    for (const c of n.children ?? []) visit(c);
  };
  for (const c of done.children ?? []) visit(c);
  return placed;
}

export interface OrcaGraphViewProps {
  projects: ProjectBox[];
  nodes: ShownNode[];
  edges: ShownEdge[];
  selected: string | null;
  // The node to bring into view once laid out (the page opened with ?node=)
  focus: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  // Open or close a project box or a worktree box, by its key
  onToggleBox: (key: string) => void;
  // Show the exited sessions of a worktree one by one
  onUnfold: (worktreeKey: string) => void;
}

export function OrcaGraphView(props: OrcaGraphViewProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  projects,
  nodes,
  edges,
  selected,
  focus,
  onSelectNode,
  onSelectEdge,
  onToggleBox,
  onUnfold,
}: OrcaGraphViewProps) {
  const flow = useReactFlow();
  const [sizeRef, size] = useSize();
  // The boxes are packed to the canvas's shape, rounded so small resizes keep the layout
  const aspect = size.height === 0 ? 0 : Math.round((size.width / size.height) * 4) / 4;
  // The layout is computed again only when what is drawn changes, not when a state or title does
  const key = JSON.stringify([
    aspect,
    projects.map((p) => [p.key, p.collapsed, p.worktrees.map((w) => [w.key, w.collapsed])]),
    nodes.map((n) => [n.id, n.worktree]),
    edges.map((e) => e.id),
  ]);
  const [placed, setPlaced] = useState<{ key: string; at: Map<string, Placed> } | null>(null);
  // The latest message of the edge under the pointer, and where the pointer is
  const [hover, setHover] = useState<{
    last: NonNullable<ShownEdge['last']>;
    at: { x: number; y: number };
  } | null>(null);
  // What the latest layout was asked for, replaced only when the key changes (state adjusted while rendering)
  const [request, setRequest] = useState({ key, aspect, projects, nodes, edges });
  if (request.key !== key) setRequest({ key, aspect, projects, nodes, edges });
  useEffect(() => {
    if (request.aspect === 0) return;
    let current = true;
    void layout(request.projects, request.nodes, request.edges, request.aspect).then((at) => {
      if (current) setPlaced({ key: request.key, at });
    });
    return () => {
      current = false;
    };
  }, [request]);
  // Fit the whole graph each time it is laid out again; the first time, the node the page was opened for instead
  const focused = useRef(false);
  useEffect(() => {
    if (placed === null) return;
    const frame = requestAnimationFrame(() => {
      if (!focused.current && focus !== null && placed.at.has(focus)) {
        focused.current = true;
        void flow.fitView({ nodes: [{ id: focus }], maxZoom: 1.1, duration: 200 });
        return;
      }
      void flow.fitView({ padding: 0.08, maxZoom: 1.1, duration: 200 });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [placed, focus, flow]);

  const flowNodes = useMemo((): FlowNode[] => {
    if (placed === null) return [];
    const out: FlowNode[] = [];
    for (const box of projects) {
      const id = `project:${box.key}`;
      const at = placed.at.get(id);
      if (at === undefined) continue;
      out.push({
        id,
        type: 'project',
        position: { x: at.x, y: at.y },
        width: at.width,
        height: at.height,
        data: {
          box,
          onToggle: () => {
            onToggleBox(box.key);
          },
        },
        selectable: false,
        zIndex: 0,
      });
      for (const w of box.worktrees) {
        const wid = `worktree:${w.key}`;
        const wat = placed.at.get(wid);
        if (wat === undefined) continue;
        out.push({
          id: wid,
          type: 'worktree',
          parentId: id,
          position: { x: wat.x, y: wat.y },
          width: wat.width,
          height: wat.height,
          data: {
            box: w,
            onToggle: () => {
              onToggleBox(w.key);
            },
          },
          selectable: false,
          zIndex: 1,
        });
      }
    }
    for (const n of nodes) {
      const at = placed.at.get(n.id);
      const parent = `worktree:${n.worktree}`;
      if (at === undefined || !placed.at.has(parent)) continue;
      out.push(
        n.kind === 'session'
          ? {
              id: n.id,
              type: 'session',
              parentId: parent,
              position: { x: at.x, y: at.y },
              data: { node: n.node, selected: n.id === selected },
              zIndex: 2,
            }
          : {
              id: n.id,
              type: 'folded',
              parentId: parent,
              position: { x: at.x, y: at.y },
              data: { count: n.members.length },
              zIndex: 2,
            },
      );
    }
    return out;
  }, [placed, projects, nodes, selected, onToggleBox]);

  const flowEdges = useMemo((): FlowEdge[] => {
    const drawn = new Set(flowNodes.map((n) => n.id));
    const dispatched = new Set(
      edges.filter((e) => e.kind === 'dispatch').map((e) => `${e.source}|${e.target}`),
    );
    return edges
      .filter((e) => drawn.has(e.source) && drawn.has(e.target))
      .map((edge) => ({
        id: edge.id,
        type: 'orca',
        source: edge.source,
        target: edge.target,
        zIndex: 3,
        ...(edge.kind === 'dispatch'
          ? {
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 16,
                height: 16,
                color: 'var(--muted-foreground)',
              },
            }
          : {}),
        data: {
          edge,
          selected: edge.id === selected,
          twin: edge.kind === 'message' && dispatched.has(`${edge.source}|${edge.target}`),
          onHover: (e, at) => {
            setHover(e === null || at === null || e.last === null ? null : { last: e.last, at });
          },
          onSelect: onSelectEdge,
        },
      }));
  }, [edges, flowNodes, selected, onSelectEdge]);

  return (
    <div ref={sizeRef} className="relative size-full" data-testid="orca-graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // React Flow's MIT license allows removing the attribution (THIRD_PARTY_NOTICES.md)
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.1}
        maxZoom={2}
        onNodeClick={(_event, node) => {
          // A box opens and closes through its title button, which fills a collapsed box
          if (node.type === 'session') onSelectNode(node.id);
          else if (node.type === 'folded') onUnfold(node.id.slice('exited:'.length));
        }}
        onEdgeClick={(_event, edge) => {
          onSelectEdge(edge.id);
        }}
        onEdgeMouseEnter={(event, edge) => {
          const last = edge.data?.edge.last ?? null;
          setHover(last === null ? null : { last, at: { x: event.clientX, y: event.clientY } });
        }}
        onEdgeMouseLeave={() => {
          setHover(null);
        }}
      />
      {placed === null && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Laying out…
        </p>
      )}
      {hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-80 rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: hover.at.x + 12, top: hover.at.y + 12 }}
          data-testid="orca-edge-tooltip"
        >
          <span className="block text-muted-foreground">
            {formatDateTime(new Date(hover.last.at).toISOString())}
          </span>
          <span className="line-clamp-6 whitespace-pre-wrap">{hover.last.text}</span>
        </div>
      )}
    </div>
  );
}
