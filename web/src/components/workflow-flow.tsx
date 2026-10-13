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

// Contracts 18.4：workflow 页面的小阶段流程图。入口节点之后按顺序连到各小阶段；repeatable 的小阶段画一条回到
// 自己的边；allowInside: [x] 画一条从本阶段到 x 再回来的虚线边，标注"不算切换"。随定义（表单或 YAML）同步更新

const NODE_WIDTH = 132;
const NODE_HEIGHT = 40;
const NODE_GAP = 56;
// 节点上方留出自环的位置，下方留出 allowInside 的往返弧线
const NODE_Y = 44;
const ARC = 28;
const VIEWPORT_X = 4;

interface FlowNodeData extends Record<string, unknown> {
  id: string;
  entry: boolean;
  repeatable: boolean;
}
type FlowNode = Node<FlowNodeData, 'stage'>;

const hiddenHandle = '!size-1 !min-w-0 !min-h-0 !border-0 !bg-transparent';

function FlowNodeView({ data }: NodeProps<FlowNode>) {
  return (
    <div style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}>
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
      <div
        data-testid={`flow-node-${data.id}`}
        data-entry={data.entry}
        className={`flex size-full items-center justify-center rounded-md border px-2 text-center font-mono text-xs leading-tight break-all ${data.entry ? 'border-foreground bg-foreground text-background' : 'border-foreground/30 bg-card'}`}
      >
        {data.entry ? `/${data.id}` : data.id}
      </div>
    </div>
  );
}

const color = 'var(--foreground)';
const marker = { type: MarkerType.ArrowClosed, color, width: 14, height: 14 };

// repeatable：从框顶右侧出发，弧线回到框顶左侧
function LoopEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const lift = 30;
  const path = `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + 16)} ${String(sourceY - lift)}, ${String(targetX - 16)} ${String(targetY - lift)}, ${String(targetX)} ${String(targetY)}`;
  return (
    <BaseEdge path={path} {...(markerEnd === undefined ? {} : { markerEnd })} style={style ?? {}} />
  );
}

// allowInside：从本阶段框底到 x 框底的虚线弧线，再从 x 回到本阶段（更深的一条），中间标注"不算切换"
function InsideEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps) {
  const there = `M ${String(sourceX - 8)} ${String(sourceY)} C ${String(sourceX - 8)} ${String(sourceY + ARC)}, ${String(targetX + 8)} ${String(targetY + ARC)}, ${String(targetX + 8)} ${String(targetY)}`;
  const back = `M ${String(targetX - 8)} ${String(targetY)} C ${String(targetX - 8)} ${String(targetY + ARC * 2)}, ${String(sourceX + 8)} ${String(sourceY + ARC * 2)}, ${String(sourceX + 8)} ${String(sourceY)}`;
  // url(#…) 中的 id 只用字母、数字与连字符
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
      {/* 深的一条弧线最低处约在框底之下 1.5 × ARC，标注放在它下面，描一圈背景色免得压在线上 */}
      <text
        x={(sourceX + targetX) / 2}
        y={Math.max(sourceY, targetY) + ARC * 1.5 + 14}
        textAnchor="middle"
        className="fill-muted-foreground text-[11px]"
        style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 4 }}
      >
        不算切换
      </text>
    </g>
  );
}

const nodeTypes = { stage: FlowNodeView };
const edgeTypes = { loop: LoopEdge, inside: InsideEdge };
const edgeStyle = { stroke: color, strokeWidth: 1.5 };

export function StageFlow({ definition }: { definition: WorkflowDefinition }) {
  const ids = [definition.id, ...definition.stages.map((s) => s.id)];
  const nodes: FlowNode[] = ids.map((id, i) => ({
    id,
    type: 'stage',
    position: { x: i * (NODE_WIDTH + NODE_GAP), y: NODE_Y },
    data: {
      id,
      entry: i === 0,
      repeatable: definition.stages.find((s) => s.id === id)?.repeatable === true,
    },
    draggable: false,
    selectable: false,
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
  const width = ids.length * (NODE_WIDTH + NODE_GAP) - NODE_GAP + VIEWPORT_X * 2;
  const height = NODE_Y + NODE_HEIGHT + ARC * 2 + 36;
  return (
    <div
      className="overflow-x-auto rounded-lg border [contain:inline-size]"
      data-testid="stage-flow"
      role="group"
      aria-label={`/${definition.id} 的小阶段流程图`}
    >
      <div style={{ width, height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: VIEWPORT_X, y: 0, zoom: 1 }}
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
