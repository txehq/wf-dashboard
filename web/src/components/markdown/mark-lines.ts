import type { Element, Root } from 'hast';

// 渲染后的对比（Contracts 21.3）：源文件中改动的行所在的段落加上标记。lines 是 1 起的闭区间
export interface LineMarks {
  kind: 'added' | 'removed';
  lines: [number, number][];
}

// 容器：改动落在某个子块中时只标那个子块，例如列表中的一项、表格中的一行
const containers = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'details']);
// 容器中可以单独标出的子块；行内的元素（code、a、input 等）不单独标
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
