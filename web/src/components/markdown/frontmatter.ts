import type { Element, ElementContent } from 'hast';
import type { Root, RootContent } from 'mdast';
import { isMap, parseDocument } from 'yaml';

// Leading YAML frontmatter shown as a table (how GitHub shows SKILL.md): keys are the header, values in the row below;
// list or object values get a nested table in their cell. In narrow places (design and optimize session panels, Contracts 26.3) it becomes
// a vertical "key: value" list (layout list): one dl row per key, lists itemised, objects as a nested list.
// Invalid YAML or anything other than key-value pairs shows as a yaml code block
export type FrontmatterLayout = 'table' | 'list';

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

const text = (value: unknown): ElementContent => ({
  type: 'text',
  value: typeof value === 'string' ? value : JSON.stringify(value),
});

function listValueOf(value: unknown): ElementContent[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const items = value.map((item) => el('li', listValueOf(item)));
    return [el('ul', items)];
  }
  if (typeof value === 'object') return [listOf(value as Record<string, unknown>)];
  return [text(value)];
}

function listOf(record: Record<string, unknown>): Element {
  return el(
    'dl',
    Object.entries(record).flatMap(([key, value]) => [
      el('dt', [text(key)]),
      el('dd', listValueOf(value)),
    ]),
  );
}

export function remarkFrontmatterTable(options?: { layout?: FrontmatterLayout }) {
  const layout = options?.layout ?? 'table';
  return (tree: Root) => {
    const first = tree.children[0];
    if (first?.type !== 'yaml') return;
    const document = parseDocument(first.value);
    if (document.errors.length > 0 || !isMap(document.contents)) {
      tree.children[0] = { type: 'code', lang: 'yaml', value: first.value };
      if (first.position !== undefined) tree.children[0].position = first.position;
      return;
    }
    const record = document.toJS() as Record<string, unknown>;
    const element = layout === 'list' ? listOf(record) : tableOf(record);
    // A node type mdast does not have: converting to hast builds the element from hName, hProperties and hChildren
    tree.children[0] = {
      type: 'frontmatterTable',
      position: first.position,
      data: {
        hName: element.tagName,
        hProperties: { className: ['frontmatter'] },
        hChildren: element.children,
      },
    } as unknown as RootContent;
  };
}
