import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';

// Layout sizes of the stage flow chart (workflow-flow.tsx). compact is for the panel of design and optimize sessions
// (Contracts 26.2): narrower nodes and gaps. Node width follows its text, which never wraps (28.4)
export const NODE_HEIGHT = 40;
// Room above the nodes for self-loops and below for allowInside arcs; without those edges only a small margin, so the
// chart can be larger in a narrow panel
const LOOP_SPACE = 44;
const INSIDE_ARC_SPACE = 92;
const EDGE_SPACE = 12;
export const ARC = 28;
export const VIEWPORT_X = 4;
// Node text is a 12 px monospace font (about 0.6em per character); 7.5 px leaves a margin. Workflow and stage ids are ASCII only
const CHAR_PX = 7.5;
// px-2 on both sides plus the border
const NODE_PAD = 20;
// Lowest zoom when fitting the chart into the frame: below it node text is unreadable, so the chart scrolls sideways
export const MIN_FLOW_ZOOM = 0.6;

const spacing = (compact: boolean) =>
  compact ? { minWidth: 48, gap: 24 } : { minWidth: 132, gap: 56 };

// Position and width of each node (entry, then stages in order), the node y, and the chart size at zoom 1
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

// Zoom that fits the whole chart into available (never above 1); with many nodes it stops at the minimum and the chart
// scrolls sideways. Rounded to 0.05 so resizing does not rebuild repeatedly. A null height fits the width only
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
