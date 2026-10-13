import type { Element, ElementContent } from 'hast';
import type { Root, RootContent } from 'mdast';
import { isMap, parseDocument } from 'yaml';

// 开头的 YAML frontmatter 显示为表格（GitHub 对 SKILL.md 的显示方式）：键是表头，值在下面一行；
// 值是列表或对象时在单元格中再放一张表。YAML 有错或不是键值对时显示为 yaml 代码块

const el = (tagName: string, children: ElementContent[]): Element => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});

const row = (cell: string, cells: ElementContent[][]) =>
  el(
    'tr',
    cells.map((children) => el(cell, children)),
  );

function cellOf(value: unknown): ElementContent[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return [el('table', [el('tbody', [row('td', value.map(cellOf))])])];
  }
  if (typeof value === 'object') return [tableOf(value as Record<string, unknown>)];
  return [{ type: 'text', value: typeof value === 'string' ? value : JSON.stringify(value) }];
}

function tableOf(record: Record<string, unknown>): Element {
  const keys = Object.keys(record);
  return el('table', [
    el('thead', [
      row(
        'th',
        keys.map((key) => [{ type: 'text', value: key }]),
      ),
    ]),
    el('tbody', [
      row(
        'td',
        keys.map((key) => cellOf(record[key])),
      ),
    ]),
  ]);
}

export function remarkFrontmatterTable() {
  return (tree: Root) => {
    const first = tree.children[0];
    if (first?.type !== 'yaml') return;
    const document = parseDocument(first.value);
    if (document.errors.length > 0 || !isMap(document.contents)) {
      tree.children[0] = { type: 'code', lang: 'yaml', value: first.value };
      if (first.position !== undefined) tree.children[0].position = first.position;
      return;
    }
    const table = tableOf(document.toJS() as Record<string, unknown>);
    // mdast 中没有的节点类型：转成 hast 时按 hName、hProperties、hChildren 生成元素
    tree.children[0] = {
      type: 'frontmatterTable',
      position: first.position,
      data: {
        hName: 'table',
        hProperties: { className: ['frontmatter'] },
        hChildren: table.children,
      },
    } as unknown as RootContent;
  };
}
