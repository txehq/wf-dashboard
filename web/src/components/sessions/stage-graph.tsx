import {
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { StatusLabel } from '@/components/sessions/status-label';
import { formatCount, formatDuration, formatInteger, formatUsd } from '@/lib/format';
import type { StageStatus, StageView } from '@/lib/sessions-api';

// Skipped: dashed border with stripes; not reached: dotted border, faded text
const statusBox: Record<StageStatus, string> = {
  done: 'border-foreground/25 bg-card border-l-4 border-l-[var(--viz-status-good)]',
  active: 'border-2 border-[var(--viz-series-1)] bg-card',
  skipped:
    'border-dashed border-foreground/40 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--muted)_6px_12px)]',
  'not-reached': 'border-dotted border-foreground/25 bg-muted/30 text-muted-foreground',
};

const NODE_WIDTH = 158;
const NODE_GAP = 26;
const NODE_Y = 44;
// A stage box is about 190px at its tallest (call count plus the subagent row)
const NODE_HEIGHT = 200;
// Row height: leaves room above for the fix-pr self-loop
const ROW_HEIGHT = NODE_Y + NODE_HEIGHT;
const VIEWPORT_X = 4;

// Wrap into several rows when one row does not fit the container, with rows as even as possible; node size
// stays the same
function gridOf(columns: number, width: number): { perRow: number; rows: number } {
  const fit = Math.max(
    1,
    Math.floor((width - VIEWPORT_X * 2 + NODE_GAP) / (NODE_WIDTH + NODE_GAP)),
  );
  const rows = Math.ceil(columns / fit);
  return { perRow: Math.ceil(columns / rows), rows };
}

function useWidth(ref: RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error('Stage graph container is not mounted yet');
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

// @xyflow/react requires indexable node data
interface StageNodeData extends Record<string, unknown> {
  view: StageView;
  selected: boolean;
  // Live run: the in-progress stage gets a pulsing marker and "Current"
  live: boolean;
  onSelect: (stage: string) => void;
}
type StageNode = Node<StageNodeData, 'stage'>;

const hiddenHandle = '!size-1 !min-w-0 !min-h-0 !border-0 !bg-transparent';

function StageHandles({ loop }: { loop: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="in" className={hiddenHandle} />
      <Handle type="source" position={Position.Right} id="out" className={hiddenHandle} />
      {/* When wrapping: the last box of a row points from its bottom to the top of the next row's first box */}
      <Handle type="target" position={Position.Top} id="up" className={hiddenHandle} />
      <Handle type="source" position={Position.Bottom} id="down" className={hiddenHandle} />
      {loop && (
        <>
          <Handle
            type="source"
            position={Position.Top}
            id="loop-out"
            className={hiddenHandle}
            style={{ left: '72%' }}
          />
          <Handle
            type="target"
            position={Position.Top}
            id="loop-in"
            className={hiddenHandle}
            style={{ left: '28%' }}
          />
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  );
}

function StageNodeView({ data }: NodeProps<StageNode>) {
  const { view, selected } = data;
  const s = view.stats;
  const empty = view.status === 'skipped' || view.status === 'not-reached';
  return (
    <div style={{ width: NODE_WIDTH }}>
      <StageHandles loop={view.stage === 'fix-pr'} />
      <button
        type="button"
        data-testid={`stage-${view.stage}`}
        data-status={view.status}
        aria-pressed={selected}
        className={`nodrag flex w-full cursor-pointer flex-col gap-1.5 rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${statusBox[view.status]} ${selected ? 'ring-2 ring-foreground ring-offset-2' : 'hover:shadow-sm'}`}
        onClick={() => {
          data.onSelect(view.stage);
        }}
      >
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-sm leading-tight font-semibold break-words text-foreground">
            {view.stage}
          </span>
          <span className="flex items-center gap-2">
            <StatusLabel status={view.status} />
            {data.live && view.status === 'active' && (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium"
                data-testid="stage-live"
              >
                <span className="relative flex size-2" aria-hidden>
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--viz-series-1)] opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-[var(--viz-series-1)]" />
                </span>
                Current
              </span>
            )}
          </span>
        </span>
        {empty ? (
          <span className="py-3 text-xs text-muted-foreground">
            {view.status === 'skipped'
              ? 'No requests; went straight to the next stage'
              : 'Not reached'}
          </span>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt className="text-muted-foreground">{view.stage === 'fix-pr' ? 'Fixes' : 'Calls'}</dt>
            <dd className="text-right tabular-nums" data-testid="stage-entries">
              {formatInteger(view.entries)}{' '}
              {view.stage === 'fix-pr'
                ? view.entries === 1
                  ? 'round'
                  : 'rounds'
                : view.entries === 1
                  ? 'time'
                  : 'times'}
            </dd>
            <Stat label="Requests" value={formatInteger(s.requests)} />
            {s.subagents > 0 && <Stat label="Subagents" value={formatInteger(s.subagents)} />}
            <Stat
              label="Tools"
              value={formatInteger(Object.values(s.toolCalls).reduce((a, b) => a + b, 0))}
            />
            <Stat
              label="Tokens"
              value={formatCount(
                s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens,
              )}
            />
            <Stat label="Cost" value={formatUsd(s.costUsd)} />
            <Stat label="Duration" value={formatDuration(s.durationMs)} />
          </dl>
        )}
      </button>
    </div>
  );
}

// fix-pr's loop to itself: leaves from the top right of the box and arcs back to the top left
function LoopEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const lift = 34;
  const path = `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + 18)} ${String(sourceY - lift)}, ${String(targetX - 18)} ${String(targetY - lift)}, ${String(targetX)} ${String(targetY)}`;
  return (
    <BaseEdge path={path} {...(markerEnd === undefined ? {} : { markerEnd })} style={style ?? {}} />
  );
}

const nodeTypes = { stage: StageNodeView };
const edgeTypes = { loop: LoopEdge };

function edgeStyle(reached: boolean) {
  const color = reached ? 'var(--foreground)' : 'var(--viz-axis)';
  return {
    style: { stroke: color, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  };
}

export function StageGraph({
  workflow,
  views,
  selected,
  onSelect,
  live = false,
}: {
  // workflow id (Contracts 16.6)
  workflow: string;
  views: StageView[];
  selected: string | null;
  onSelect: (stage: string) => void;
  live?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useWidth(containerRef);
  const { perRow, rows } = gridOf(views.length, containerWidth ?? 0);
  const position = (i: number) => ({
    x: (i % perRow) * (NODE_WIDTH + NODE_GAP),
    y: Math.floor(i / perRow) * ROW_HEIGHT + NODE_Y,
  });
  // Within a row, right side to the next box's left side; at a wrap, from the bottom of the row's last box to
  // the top of the next row's first box
  const link = (i: number) =>
    i % perRow === 0
      ? { type: 'smoothstep', sourceHandle: 'down', targetHandle: 'up' }
      : { sourceHandle: 'out', targetHandle: 'in' };

  const nodes: StageNode[] = views.map((view, i) => ({
    id: view.stage,
    type: 'stage',
    position: position(i),
    data: { view, selected: selected === view.stage, live, onSelect },
    draggable: false,
    selectable: false,
    // Non-selectable nodes ignore pointer events by default; the button inside needs clicks
    style: { pointerEvents: 'all' },
  }));
  const edges: Edge[] = [];
  for (let i = 1; i < views.length; i++) {
    const from = views[i - 1];
    const to = views[i];
    if (from === undefined || to === undefined) continue;
    edges.push({
      id: `${from.stage}->${to.stage}`,
      source: from.stage,
      target: to.stage,
      ...link(i),
      ...edgeStyle(to.status !== 'not-reached'),
    });
  }
  const fixPr = views.find((v) => v.stage === 'fix-pr');
  if (fixPr !== undefined) {
    edges.push({
      id: 'fix-pr-loop',
      type: 'loop',
      source: 'fix-pr',
      sourceHandle: 'loop-out',
      target: 'fix-pr',
      targetHandle: 'loop-in',
      ...edgeStyle(fixPr.status !== 'not-reached'),
    });
  }
  const width = perRow * (NODE_WIDTH + NODE_GAP) - NODE_GAP + VIEWPORT_X * 2;
  return (
    // contain: inline-size makes the container width depend only on the page, not the graph, so it can rewrap
    // when the window narrows
    <div
      ref={containerRef}
      className="overflow-x-auto [contain:inline-size]"
      data-testid={`stage-graph-${workflow}`}
      data-rows={rows}
      role="group"
      aria-label={`/${workflow} stage graph`}
    >
      {containerWidth !== null && (
        <div style={{ width, height: rows * ROW_HEIGHT }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: VIEWPORT_X, y: 0, zoom: 1 }}
            // The MIT license of React Flow allows removing the attribution (THIRD_PARTY_NOTICES.md)
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
          />
        </div>
      )}
    </div>
  );
}
