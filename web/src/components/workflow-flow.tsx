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
import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { useSize } from '@/lib/use-size';
import { cn } from '@/lib/utils';
import { ARC, fitZoom, flowLayout, NODE_HEIGHT, VIEWPORT_X } from './workflow-flow-size';
import './workflow-flow.css';

// Contracts 18.4: the stage flow chart on the workflow page. The entry node connects to each stage in order; a repeatable
// stage gets an edge back to itself; allowInside: [x] draws a dashed edge from the stage to x and back, labeled
// "not a stage switch". Follows the definition (form or YAML) as it changes

// Panel of design and optimize sessions (Contracts 26.2): a node shows whether its skill is added, modified, unchanged or
// missing in the draft; clicking a node opens it
export type StageMark = 'added' | 'modified' | 'unchanged' | 'missing';

const markLabel: Record<StageMark, string | null> = {
  added: 'Added',
  modified: 'Modified',
  unchanged: null,
  missing: 'Missing',
};

interface FlowNodeData extends Record<string, unknown> {
  id: string;
  entry: boolean;
  repeatable: boolean;
  mark: StageMark | null;
  selected: boolean;
  onSelect: ((id: string) => void) | null;
  width: number;
}
type FlowNode = Node<FlowNodeData, 'stage'>;

const hiddenHandle = '!size-1 !min-w-0 !min-h-0 !border-0 !bg-transparent';

function FlowNodeView({ data }: NodeProps<FlowNode>) {
  const label = data.mark === null ? null : markLabel[data.mark];
  const className = cn(
    'relative flex size-full items-center justify-center rounded-md border px-2 text-center font-mono text-xs whitespace-nowrap',
    data.entry ? 'border-foreground bg-foreground text-background' : 'border-foreground/30 bg-card',
    data.mark === 'missing' && 'border-2 border-destructive text-destructive',
    data.mark === 'missing' && data.entry && 'bg-card',
    data.selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
    data.onSelect !== null && 'cursor-pointer hover:border-foreground',
  );
  const content = (
    <>
      {data.entry ? `/${data.id}` : data.id}
      {label !== null && (
        <span
          className={cn(
            'absolute -top-2 -right-2 rounded px-1 font-sans text-[10px] leading-4',
            `ws-mark-badge-${data.mark ?? ''}`,
          )}
          data-testid="flow-node-mark"
        >
          {label}
        </span>
      )}
    </>
  );
  return (
    <div style={{ width: data.width, height: NODE_HEIGHT }}>
      <Handle type="target" position={Position.Left} id="in" className={hiddenHandle} />
      <Handle type="source" position={Position.Right} id="out" className={hiddenHandle} />
      <Handle type="source" position={Position.Bottom} id="below-out" className={hiddenHandle} />
      <Handle type="target" position={Position.Bottom} id="below-in" className={hiddenHandle} />
      {data.repeatable && (
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
      {data.onSelect === null ? (
        <div
          data-testid={`flow-node-${data.id}`}
          data-entry={data.entry}
          data-mark={data.mark ?? undefined}
          className={className}
        >
          {content}
        </div>
      ) : (
        <button
          type="button"
          data-testid={`flow-node-${data.id}`}
          data-entry={data.entry}
          data-mark={data.mark ?? undefined}
          aria-pressed={data.selected}
          title={`Open skills/${data.id}/SKILL.md`}
          className={cn(className, 'nodrag nopan')}
          onClick={() => {
            data.onSelect?.(data.id);
          }}
        >
          {content}
        </button>
      )}
    </div>
  );
}

const color = 'var(--foreground)';
const marker = { type: MarkerType.ArrowClosed, color, width: 14, height: 14 };

// repeatable: an arc from the top right of the box back to its top left
function LoopEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const lift = 30;
  const path = `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + 16)} ${String(sourceY - lift)}, ${String(targetX - 16)} ${String(targetY - lift)}, ${String(targetX)} ${String(targetY)}`;
  return (
    <BaseEdge path={path} {...(markerEnd === undefined ? {} : { markerEnd })} style={style ?? {}} />
  );
}

// allowInside: a dashed arc from the bottom of this stage to the bottom of x, then back from x (the deeper arc),
// labeled "not a stage switch" in the middle
function InsideEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps) {
  const there = `M ${String(sourceX - 8)} ${String(sourceY)} C ${String(sourceX - 8)} ${String(sourceY + ARC)}, ${String(targetX + 8)} ${String(targetY + ARC)}, ${String(targetX + 8)} ${String(targetY)}`;
  const back = `M ${String(targetX - 8)} ${String(targetY)} C ${String(targetX - 8)} ${String(targetY + ARC * 2)}, ${String(sourceX + 8)} ${String(sourceY + ARC * 2)}, ${String(sourceX + 8)} ${String(sourceY)}`;
  // Ids inside url(#...) use only letters, digits and hyphens
  const markerId = `inside-arrow-${id.replace(/[^a-z0-9-]/gi, '_')}`;
  return (
    <g data-testid={`flow-inside-${id}`}>
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      </defs>
      {[there, back].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          style={{ ...style, strokeDasharray: '5 4' }}
          markerEnd={`url(#${markerId})`}
        />
      ))}
      {/* The deeper arc bottoms out about 1.5 x ARC below the boxes; the label sits below it, outlined in the background color so it does not sit on the line */}
      <text
        x={(sourceX + targetX) / 2}
        y={Math.max(sourceY, targetY) + ARC * 1.5 + 14}
        textAnchor="middle"
        className="fill-muted-foreground text-[11px]"
        style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 4 }}
      >
        not a stage switch
      </text>
    </g>
  );
}

const nodeTypes = { stage: FlowNodeView };
const edgeTypes = { loop: LoopEdge, inside: InsideEdge };
const edgeStyle = { stroke: color, strokeWidth: 1.5 };

export function StageFlow({
  definition,
  marks,
  selected = null,
  onSelect,
  fitHeight = null,
  compact = false,
}: {
  definition: WorkflowDefinition;
  // Mark for each node (by entry or stage id); no marks when omitted
  marks?: Record<string, StageMark> | undefined;
  selected?: string | null;
  onSelect?: ((id: string) => void) | undefined;
  // Fit the whole chart to the frame width (Contracts 26.2, 28.4), and to this height when given; scroll sideways below the minimum zoom
  fitHeight?: number | null;
  // Narrower nodes and gaps (workflow-flow-size.ts)
  compact?: boolean;
}) {
  const [frame, frameSize] = useSize();
  const layout = flowLayout(definition, compact);
  const ids = layout.nodes.map((n) => n.id);
  const nodes: FlowNode[] = layout.nodes.map(({ id, x, width }, i) => ({
    id,
    type: 'stage',
    position: { x, y: layout.nodeY },
    data: {
      id,
      entry: i === 0,
      repeatable: definition.stages.find((s) => s.id === id)?.repeatable === true,
      mark: marks?.[id] ?? null,
      selected: selected === id,
      onSelect: onSelect ?? null,
      width,
    },
    draggable: false,
    selectable: false,
    // React Flow gives unselectable, undraggable nodes pointer-events: none; restore it when a click opens the skill
    ...(onSelect === undefined ? {} : { style: { pointerEvents: 'all' } }),
  }));
  const edges: Edge[] = [];
  for (let i = 1; i < ids.length; i++) {
    const from = ids[i - 1] ?? '';
    const to = ids[i] ?? '';
    edges.push({
      id: `seq:${from}->${to}`,
      source: from,
      sourceHandle: 'out',
      target: to,
      targetHandle: 'in',
      style: edgeStyle,
      markerEnd: marker,
    });
  }
  for (const stage of definition.stages) {
    if (stage.repeatable === true) {
      edges.push({
        id: `loop:${stage.id}`,
        type: 'loop',
        source: stage.id,
        sourceHandle: 'loop-out',
        target: stage.id,
        targetHandle: 'loop-in',
        style: edgeStyle,
        markerEnd: marker,
      });
    }
    for (const inside of stage.allowInside ?? []) {
      edges.push({
        id: `inside:${stage.id}->${inside}`,
        type: 'inside',
        source: stage.id,
        sourceHandle: 'below-out',
        target: inside,
        targetHandle: 'below-in',
        style: { stroke: color, strokeWidth: 1.25 },
      });
    }
  }
  const { width, height } = layout;
  // The frame width is measured on the next frame; stay hidden until then so the chart is not drawn full size and then shrunk
  const measured = frameSize.width > 0;
  const zoom = fitZoom(layout, {
    width: frameSize.width,
    height: fitHeight === null ? null : fitHeight - 2,
  });
  return (
    <div
      ref={frame}
      className={cn(
        'overflow-x-auto rounded-lg border [contain:inline-size]',
        !measured && 'invisible',
      )}
      data-testid="stage-flow"
      data-zoom={measured ? zoom : undefined}
      role="group"
      aria-label={`Stage flow of /${definition.id}`}
    >
      <div style={{ width: width * zoom, height: height * zoom }}>
        <ReactFlow
          // Rebuild with the new defaultViewport when the zoom changes
          key={zoom}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: VIEWPORT_X * zoom, y: 0, zoom }}
          // React Flow's MIT license allows removing the attribution (THIRD_PARTY_NOTICES.md)
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
    </div>
  );
}
