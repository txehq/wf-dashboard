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
import { StatusLabel } from '@/components/sessions/status-label';
import { formatCount, formatDuration, formatInteger, formatUsd } from '@/lib/format';
import type { StageStatus, StageView, Workflow } from '@/lib/sessions-api';

// 跳过：虚线边框加斜纹；未到达：点线边框、淡色文字；中断：橙色粗虚线边框（与进行中的蓝色实线区分）
const statusBox: Record<StageStatus, string> = {
  done: 'border-foreground/25 bg-card border-l-4 border-l-[var(--viz-status-good)]',
  active: 'border-2 border-[var(--viz-series-1)] bg-card',
  skipped:
    'border-dashed border-foreground/40 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--muted)_6px_12px)]',
  'not-reached': 'border-dotted border-foreground/25 bg-muted/30 text-muted-foreground',
  interrupted: 'border-2 border-dashed border-[var(--viz-status-serious)] bg-card',
};

const NODE_WIDTH = 158;
const NODE_GAP = 26;
const NODE_Y = 44;

// @xyflow/react 要求节点数据可索引
interface StageNodeData extends Record<string, unknown> {
  view: StageView;
  selected: boolean;
  onSelect: (stage: string) => void;
}
interface GateNodeData extends Record<string, unknown> {
  reached: boolean;
}
type StageNode = Node<StageNodeData, 'stage'>;
type GateNode = Node<GateNodeData, 'gate'>;

const hiddenHandle = '!size-1 !min-w-0 !min-h-0 !border-0 !bg-transparent';

function StageHandles({ loop }: { loop: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="in" className={hiddenHandle} />
      <Handle type="source" position={Position.Right} id="out" className={hiddenHandle} />
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
          <StatusLabel status={view.status} />
        </span>
        {empty ? (
          <span className="py-3 text-xs text-muted-foreground">
            {view.status === 'skipped' ? '没有请求，直接进入下一阶段' : '没有进入这个阶段'}
          </span>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <Stat label="请求" value={formatInteger(s.requests)} />
            {s.subagents > 0 && <Stat label="子代理" value={formatInteger(s.subagents)} />}
            <Stat
              label="tool"
              value={formatInteger(Object.values(s.toolCalls).reduce((a, b) => a + b, 0))}
            />
            <Stat
              label="token"
              value={formatCount(
                s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens,
              )}
            />
            <Stat label="花费" value={formatUsd(s.costUsd)} />
            <Stat label="耗时" value={formatDuration(s.durationMs)} />
          </dl>
        )}
        {view.status === 'interrupted' && (
          <span className="text-xs text-muted-foreground">后来开始了另一轮流程</span>
        )}
      </button>
    </div>
  );
}

function GateNodeView({ data }: NodeProps<GateNode>) {
  return (
    <div
      style={{ width: NODE_WIDTH - 40 }}
      data-testid="stage-dispatch-gate"
      className={`flex flex-col items-center gap-1 rounded-md border-2 border-double px-3 py-3 text-center ${data.reached ? 'border-foreground/50 bg-card' : 'border-foreground/25 text-muted-foreground'}`}
    >
      <Handle type="target" position={Position.Left} id="in" className={hiddenHandle} />
      <span className="font-mono text-sm font-semibold">dispatch gate</span>
      <span className="text-xs">{data.reached ? '已停在这里' : '未到达'}</span>
    </div>
  );
}

// fix-pr 指向自己的环：从框顶右侧出发，弧线回到框顶左侧
function LoopEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const lift = 34;
  const path = `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + 18)} ${String(sourceY - lift)}, ${String(targetX - 18)} ${String(targetY - lift)}, ${String(targetX)} ${String(targetY)}`;
  return (
    <BaseEdge path={path} {...(markerEnd === undefined ? {} : { markerEnd })} style={style ?? {}} />
  );
}

const nodeTypes = { stage: StageNodeView, gate: GateNodeView };
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
}: {
  workflow: Workflow;
  views: StageView[];
  selected: string | null;
  onSelect: (stage: string) => void;
}) {
  const nodes: (StageNode | GateNode)[] = views.map((view, i) => ({
    id: view.stage,
    type: 'stage',
    position: { x: i * (NODE_WIDTH + NODE_GAP), y: NODE_Y },
    data: { view, selected: selected === view.stage, onSelect },
    draggable: false,
    selectable: false,
    // 不可选中的节点默认不接收指针事件，框内按钮需要点击
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
      sourceHandle: 'out',
      target: to.stage,
      targetHandle: 'in',
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
  const last = views[views.length - 1];
  if (workflow === 'lfg' && last !== undefined) {
    const reached = last.status === 'done';
    nodes.push({
      id: 'dispatch-gate',
      type: 'gate',
      position: { x: views.length * (NODE_WIDTH + NODE_GAP), y: NODE_Y + 36 },
      data: { reached },
      draggable: false,
      selectable: false,
    });
    edges.push({
      id: `${last.stage}->dispatch-gate`,
      source: last.stage,
      sourceHandle: 'out',
      target: 'dispatch-gate',
      targetHandle: 'in',
      ...edgeStyle(reached),
    });
  }
  const columns = views.length + (workflow === 'lfg' ? 1 : 0);
  const width = columns * (NODE_WIDTH + NODE_GAP);
  return (
    <div
      className="overflow-x-auto"
      data-testid={`stage-graph-${workflow}`}
      role="group"
      aria-label={`/${workflow} 阶段图`}
    >
      {/* 阶段框最高时（中断说明加子代理行）约 190px */}
      <div style={{ width, height: NODE_Y + 200 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: 4, y: 0, zoom: 1 }}
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
