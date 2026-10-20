import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';

// 小阶段流程图（workflow-flow.tsx）的布局尺寸。compact 用于设计与优化会话的面板（Contracts 26.2）：节点与间隔更窄。
// 节点的宽度按文字算，文字不折行（28.4）
export const NODE_HEIGHT = 40;
// 节点上方留出自环的位置，下方留出 allowInside 的往返弧线；没有这两种边时上下只留一点边距，窄的面板中整张图可以大一些
const LOOP_SPACE = 44;
const INSIDE_ARC_SPACE = 92;
const EDGE_SPACE = 12;
export const ARC = 28;
export const VIEWPORT_X = 4;
// 节点文字是 12 px 的等宽字体（每个字符约 0.6em），按 7.5 px 算留出余量；workflow 与小阶段的 id 只有 ASCII
const CHAR_PX = 7.5;
// 左右的 px-2 与边框
const NODE_PAD = 20;
// 整张图缩放到框内可见时的下限：再小节点上的字看不清，之后横向滚动
export const MIN_FLOW_ZOOM = 0.6;

const spacing = (compact: boolean) =>
  compact ? { minWidth: 48, gap: 24 } : { minWidth: 132, gap: 56 };

// 每个节点（入口与各小阶段，按顺序）的位置与宽度、节点的 y，以及 zoom 为 1 时整张图的尺寸
export function flowLayout(definition: WorkflowDefinition, compact: boolean) {
  const { minWidth, gap } = spacing(compact);
  const labels = [`/${definition.id}`, ...definition.stages.map((s) => s.id)];
  let x = 0;
  const nodes = labels.map((label, i) => {
    const width = Math.max(minWidth, Math.ceil(label.length * CHAR_PX) + NODE_PAD);
    const node = { id: i === 0 ? definition.id : label, x, width };
    x += width + gap;
    return node;
  });
  const nodeY = definition.stages.some((s) => s.repeatable === true) ? LOOP_SPACE : EDGE_SPACE;
  const below = definition.stages.some((s) => (s.allowInside ?? []).length > 0)
    ? INSIDE_ARC_SPACE
    : EDGE_SPACE;
  return {
    nodes,
    nodeY,
    width: x - gap + VIEWPORT_X * 2,
    height: nodeY + NODE_HEIGHT + below,
  };
}

// 整张图缩放到 available 中可见（不放大）；节点很多时到下限为止，之后横向滚动。按 0.05 取整，拖动时不反复重建。
// available 的高度为 null 时只按宽度
export function fitZoom(
  size: { width: number; height: number },
  available: { width: number; height: number | null },
): number {
  const fit = Math.min(
    available.width / size.width,
    available.height === null ? 1 : available.height / size.height,
  );
  return Math.min(1, Math.max(MIN_FLOW_ZOOM, Math.floor(fit * 20) / 20));
}
