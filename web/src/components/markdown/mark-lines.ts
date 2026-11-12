import type { Element, Root } from 'hast';

// Rendered comparison (Contracts 21.3): marks the paragraphs that contain changed source lines. lines are 1-based closed ranges
export interface LineMarks {
  kind: 'added' | 'removed';
  lines: [number, number][];
}

// Containers: when a change falls in a child block, only that block is marked, for example a list item or a table row
const containers = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'details']);
// Child blocks of a container that can be marked on their own; inline elements (code, a, input and so on) are not
const blocks = new Set([
  ...containers,
  'p',
  'pre',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'div',
  'dl',
]);

export function rehypeMarkLines(marks: LineMarks | undefined) {
  return (tree: Root) => {
    if (marks === undefined || marks.lines.length === 0) return;
    const touched = (node: Element) => {
      const position = node.position;
      if (position === undefined) return false;
      return marks.lines.some(
        ([from, to]) => position.start.line <= to && position.end.line >= from,
      );
    };
    const mark = (node: Element): boolean => {
      if (!touched(node)) return false;
      const children = node.children.filter(
        (child): child is Element => child.type === 'element' && blocks.has(child.tagName),
      );
      const inner = containers.has(node.tagName) && children.map(mark).some(Boolean);
      if (!inner) {
        const existing = node.properties.className;
        node.properties.className = [
          ...(Array.isArray(existing) ? existing : []),
          `md-mark-${marks.kind}`,
        ];
      }
      return true;
    };
    for (const child of tree.children) if (child.type === 'element') mark(child);
  };
}
