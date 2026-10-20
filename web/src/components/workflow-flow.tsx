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

// Contracts 18.4：workflow 页面的小阶段流程图。入口节点之后按顺序连到各小阶段；repeatable 的小阶段画一条回到
// 自己的边；allowInside: [x] 画一条从本阶段到 x 再回来的虚线边，标注"不算切换"。随定义（表单或 YAML）同步更新

// 设计与优化会话的面板（Contracts 26.2）：节点标出它的 skill 在草稿中是新增、修改、未变还是缺少，点节点打开它
export type StageMark = 'added' | 'modified' | 'unchanged' | 'missing';

const markLabel: Record<StageMark, string | null> = {
  added: '新增',
  modified: '修改',
  unchanged: null,
  missing: '缺少',
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
          title={`打开 skills/${data.id}/SKILL.md`}
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

export function StageFlow({
  definition,
  marks,
  selected = null,
  onSelect,
  fitHeight = null,
  compact = false,
}: {
  definition: WorkflowDefinition;
  // 每个节点（入口与各小阶段的 id）的标记；不给时不标
  marks?: Record<string, StageMark> | undefined;
  selected?: string | null;
  onSelect?: ((id: string) => void) | undefined;
  // 整张图缩放到框的宽度内可见（Contracts 26.2、28.4），给了高度时同时缩放到这个高度内；到下限后横向滚动
  fitHeight?: number | null;
  // 更窄的节点与间隔（workflow-flow-size.ts）
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
    // 不可选、不可拖动的节点 React Flow 设为 pointer-events: none；可以点击打开 skill 时恢复
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
  // 外框的宽度在下一帧量出，量出之前不显示，免得先按原大画出再缩小
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
      aria-label={`/${definition.id} 的小阶段流程图`}
    >
      <div style={{ width: width * zoom, height: height * zoom }}>
        <ReactFlow
          // 缩放变化时按新的 defaultViewport 重建
          key={zoom}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: VIEWPORT_X * zoom, y: 0, zoom }}
          // 署名按 React Flow 的 MIT 许可可以去掉（THIRD_PARTY_NOTICES.md）
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
