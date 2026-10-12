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

// 跳过：虚线边框加斜纹；未到达：点线边框、淡色文字
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
// 阶段框最高时（调用次数加子代理行）约 190px
const NODE_HEIGHT = 200;
// 一行的高度：上方留出 fix-pr 自环的位置
const ROW_HEIGHT = NODE_Y + NODE_HEIGHT;
const VIEWPORT_X = 4;

// 容器宽度放不下一行时换成多行，各行的列数尽量相等；节点大小不变
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
    if (el === null) throw new Error('阶段图容器尚未挂载');
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

// @xyflow/react 要求节点数据可索引
interface StageNodeData extends Record<string, unknown> {
  view: StageView;
  selected: boolean;
  // 实时运行中：进行中的阶段带脉动标记与"当前"字样
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
      {/* 换行时：行末的框从底部指向下一行行首的框顶部 */}
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
                当前
              </span>
            )}
          </span>
        </span>
        {empty ? (
          <span className="py-3 text-xs text-muted-foreground">
            {view.status === 'skipped' ? '没有请求，直接进入下一阶段' : '没有进入这个阶段'}
          </span>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt className="text-muted-foreground">{view.stage === 'fix-pr' ? '修复' : '调用'}</dt>
            <dd className="text-right tabular-nums" data-testid="stage-entries">
              {formatInteger(view.entries)} {view.stage === 'fix-pr' ? '轮' : '次'}
            </dd>
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
      </button>
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
  // 大阶段 id（Contracts 16.6）
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
  // 同一行内从右侧指向下一个框的左侧；换行处从行末框的底部指向下一行行首框的顶部
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
    // contain: inline-size 让容器宽度只取决于页面，不被图的宽度撑开，窗口变窄时才能重新换行
    <div
      ref={containerRef}
      className="overflow-x-auto [contain:inline-size]"
      data-testid={`stage-graph-${workflow}`}
      data-rows={rows}
      role="group"
      aria-label={`/${workflow} 阶段图`}
    >
      {containerWidth !== null && (
        <div style={{ width, height: rows * ROW_HEIGHT }}>
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
      )}
    </div>
  );
}
