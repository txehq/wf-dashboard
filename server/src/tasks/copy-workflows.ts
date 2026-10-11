import { isMap, isScalar, isSeq, type Node, parseDocument } from 'yaml';
import type { WorkflowFile } from './workflow-checks.js';
import { isWorkflowPath } from './workflow-checks.js';

// Contracts 第 13 节"CI 与终点"：副本仓库中只运行由 pull_request 触发的 workflow。
// 用 yaml 的 Document API 找到 on 中要去掉的事件在原文中的位置，只删除这些行（flow 写法只改写 on 的值），
// 其余字节原样保留（重新序列化整个文件会改变多行字符串等写法）；改完再解析一次，确认 on 只剩保留的事件。
// 没有 pull_request 触发的文件删除。workflow_call 也保留：它只能被同仓库的 workflow 调用，
// 删掉它会让调用它的 pull_request workflow 失效

const KEEP = new Set(['pull_request', 'workflow_call']);

export type WorkflowChange =
  | { kind: 'kept'; path: string }
  | { kind: 'rewritten'; path: string; content: string; removed: string[] }
  | { kind: 'deleted'; path: string; removed: string[] };

const eventName = (node: unknown): string => {
  if (!isScalar(node) || typeof node.value !== 'string') {
    throw new Error(`workflow 的事件名不是字符串：${JSON.stringify(node)}`);
  }
  return node.value;
};

function rangeOf(node: unknown, what: string): [number, number, number] {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined) throw new Error(`yaml 没有给出 ${what} 在原文中的位置`);
  return range;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
const lineEnd = (text: string, offset: number) => {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
};

// 原文中被删掉的一段：[start, end)
interface Cut {
  start: number;
  end: number;
  text: string;
}

function eventsOf(content: string): string[] | null {
  const doc = parseDocument(content, { version: '1.2' });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const on = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'on')?.value;
  if (on === undefined || on === null) return null;
  if (isScalar(on)) return [eventName(on)];
  if (isSeq(on)) return on.items.map(eventName);
  if (isMap(on)) return on.items.map((p) => eventName(p.key));
  throw new Error('workflow 的 on 不是事件名、列表或映射');
}

// 一个 workflow 文件在副本中的样子；YAML 不合法或没有 on 的文件 GitHub 不会运行，保持原样
export function copyWorkflow(file: WorkflowFile): WorkflowChange {
  const { content } = file;
  const doc = parseDocument(content, { version: '1.2' });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { kind: 'kept', path: file.path };
  const on = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'on')?.value;
  if (on === undefined || on === null) return { kind: 'kept', path: file.path };
  const events = eventsOf(content) ?? [];
  const removed = events.filter((e) => !KEEP.has(e));
  if (removed.length === 0) return { kind: 'kept', path: file.path };
  const kept = events.filter((e) => KEEP.has(e));
  if (kept.length === 0) return { kind: 'deleted', path: file.path, removed };

  const cuts: Cut[] = [];
  const onNode = on as Node;
  if ((isSeq(on) || isMap(on)) && on.flow === true) {
    // flow 写法（[push, pull_request]、{ pull_request: …, push: … }）：按保留项的原文重写 on 的值
    const [start, end] = rangeOf(onNode, 'on');
    const items = isSeq(on)
      ? on.items.filter((i) => KEEP.has(eventName(i))).map((i) => {
          const [s, e] = rangeOf(i, '事件名');
          return content.slice(s, e);
        })
      : on.items
          .filter((p) => KEEP.has(eventName(p.key)))
          .map((p) => {
            const [s] = rangeOf(p.key, '事件名');
            const e = p.value === null ? rangeOf(p.key, '事件名')[1] : rangeOf(p.value, '事件的配置')[1];
            return content.slice(s, e);
          });
    cuts.push({
      start,
      end,
      text: isSeq(on) ? `[${items.join(', ')}]` : `{ ${items.join(', ')} }`,
    });
  } else if (isSeq(on)) {
    for (const item of on.items) {
      if (KEEP.has(eventName(item))) continue;
      const [s, e] = rangeOf(item, '事件名');
      cuts.push({ start: lineStart(content, s), end: lineEnd(content, e - 1), text: '' });
    }
  } else if (isMap(on)) {
    for (const pair of on.items) {
      if (KEEP.has(eventName(pair.key))) continue;
      const [s, keyEnd] = rangeOf(pair.key, '事件名');
      // 值为空（workflow_dispatch:）时到这一行末尾；否则到值的最后一个字符所在的行末
      const valueEnd =
        pair.value === null || isScalar(pair.value) && pair.value.value === null
          ? keyEnd
          : rangeOf(pair.value, '事件的配置')[1];
      cuts.push({ start: lineStart(content, s), end: lineEnd(content, Math.max(keyEnd, valueEnd) - 1), text: '' });
    }
  }
  let out = content;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, cut.start) + cut.text + out.slice(cut.end);
  }
  const after = eventsOf(out);
  if (after?.join(',') !== kept.join(',')) {
    throw new Error(
      `${file.path} 改写后 on 为 ${JSON.stringify(after)}，应为 ${JSON.stringify(kept)}`,
    );
  }
  return { kind: 'rewritten', path: file.path, content: out, removed };
}

// 起始 commit 中的全部 workflow 文件在副本中的变化；没有变化时为空数组
export function copyWorkflows(files: WorkflowFile[]): Exclude<WorkflowChange, { kind: 'kept' }>[] {
  return files
    .filter((f) => isWorkflowPath(f.path))
    .map(copyWorkflow)
    .filter((c): c is Exclude<WorkflowChange, { kind: 'kept' }> => c.kind !== 'kept');
}

// 副本 commit 的正文：删除的文件与去掉的触发方式
export function copyCommitBody(changes: Exclude<WorkflowChange, { kind: 'kept' }>[]): string {
  return changes
    .map((c) =>
      c.kind === 'deleted'
        ? `- 删除 ${c.path}（触发方式：${c.removed.join('、')}）`
        : `- ${c.path}：去掉 ${c.removed.join('、')}`,
    )
    .join('\n');
}
