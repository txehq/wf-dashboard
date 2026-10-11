import type { List, ListItem, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { toString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';

const TITLE = /acceptance criteria|验收标准/i;

// 章节标题：heading，或只有一段加粗文字的段落（工单中常见的 **Acceptance criteria** 写法）
function sectionTitle(node: RootContent): { text: string; depth: number } | null {
  if (node.type === 'heading') return { text: toString(node), depth: node.depth };
  if (
    node.type === 'paragraph' &&
    node.children.length === 1 &&
    node.children[0]?.type === 'strong'
  ) {
    // 加粗段落低于任何 heading：它的一节到下一个 heading 或下一个加粗段落为止
    return { text: toString(node), depth: 7 };
  }
  return null;
}

// 一节的结束：同级或更高的 heading；加粗段落开始的一节，也在下一个以加粗文字开头的段落（"**Out of scope:** …"）结束
function endsSection(node: RootContent, depth: number): boolean {
  if (node.type === 'heading') return node.depth <= depth;
  return depth === 7 && node.type === 'paragraph' && node.children[0]?.type === 'strong';
}

// 列表项的 markdown 原文（保留行内代码、链接与嵌套列表），去掉 GFM 任务列表的勾选框
function itemText(item: ListItem): string {
  const root: Root = { type: 'root', children: item.children };
  return toMarkdown(root, { extensions: [gfmToMarkdown()] }).trim();
}

// 正文中标题为"验收标准 / Acceptance criteria"的第一节中，各个列表的顶层列表项；没有这一节时为空
export function extractAcceptanceCriteria(markdown: string): string[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const nodes = tree.children;
  let start = -1;
  let depth = 0;
  for (const [i, node] of nodes.entries()) {
    const title = sectionTitle(node);
    if (title !== null && TITLE.test(title.text)) {
      start = i;
      depth = title.depth;
      break;
    }
  }
  if (start === -1) return [];
  const lists: List[] = [];
  for (const node of nodes.slice(start + 1)) {
    if (endsSection(node, depth)) break;
    if (node.type === 'list') lists.push(node);
  }
  return lists.flatMap((list) => list.children.map(itemText)).filter((t) => t !== '');
}
