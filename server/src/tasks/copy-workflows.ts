import { isMap, isScalar, isSeq, type Node, parseDocument } from 'yaml';
import type { WorkflowFile } from './workflow-checks.js';
import { isWorkflowPath } from './workflow-checks.js';

// Contracts section 13 "CI and the end point": copied repos run only workflows triggered by pull_request.
// yaml's Document API finds where the events to remove from on sit in the original text and only those lines are
// deleted (flow style rewrites only the value of on); every other byte is kept (reserialising the whole file would
// change multi-line strings and the like). The result is parsed again to confirm on keeps only the kept events.
// Files without a pull_request trigger are deleted. workflow_call is kept too: only workflows in the same repo can
// call it, and removing it would break the pull_request workflows calling it

const KEEP = new Set(['pull_request', 'workflow_call']);

export type WorkflowChange =
  | { kind: 'kept'; path: string }
  | { kind: 'rewritten'; path: string; content: string; removed: string[] }
  | { kind: 'deleted'; path: string; removed: string[] };

const eventName = (node: unknown): string => {
  if (!isScalar(node) || typeof node.value !== 'string') {
    throw new Error(`Workflow event name is not a string: ${JSON.stringify(node)}`);
  }
  return node.value;
};

function rangeOf(node: unknown, what: string): [number, number, number] {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined) throw new Error(`yaml gave no position in the original text for the ${what}`);
  return range;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
const lineEnd = (text: string, offset: number) => {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
};

// A span deleted from the original text: [start, end)
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
  throw new Error('The workflow on is not an event name, a list or a mapping');
}

// What a workflow file looks like in the copy; files with invalid YAML or no on are never run by GitHub and stay as
// they are
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
    // Flow style ([push, pull_request], { pull_request: …, push: … }): rewrite the value of on from the kept items'
    // original text
    const [start, end] = rangeOf(onNode, 'on');
    const items = isSeq(on)
      ? on.items.filter((i) => KEEP.has(eventName(i))).map((i) => {
          const [s, e] = rangeOf(i, 'event name');
          return content.slice(s, e);
        })
      : on.items
          .filter((p) => KEEP.has(eventName(p.key)))
          .map((p) => {
            const [s] = rangeOf(p.key, 'event name');
            const e = p.value === null ? rangeOf(p.key, 'event name')[1] : rangeOf(p.value, 'event configuration')[1];
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
      const [s, e] = rangeOf(item, 'event name');
      cuts.push({ start: lineStart(content, s), end: lineEnd(content, e - 1), text: '' });
    }
  } else if (isMap(on)) {
    for (const pair of on.items) {
      if (KEEP.has(eventName(pair.key))) continue;
      const [s, keyEnd] = rangeOf(pair.key, 'event name');
      // An empty value (workflow_dispatch:) runs to the end of this line; otherwise to the end of the line holding the
      // value's last character
      const valueEnd =
        pair.value === null || isScalar(pair.value) && pair.value.value === null
          ? keyEnd
          : rangeOf(pair.value, 'event configuration')[1];
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
      `${file.path}: on is ${JSON.stringify(after)} after rewriting, expected ${JSON.stringify(kept)}`,
    );
  }
  return { kind: 'rewritten', path: file.path, content: out, removed };
}

// How every workflow file of the starting commit changes in the copy; an empty array when nothing changes
export function copyWorkflows(files: WorkflowFile[]): Exclude<WorkflowChange, { kind: 'kept' }>[] {
  return files
    .filter((f) => isWorkflowPath(f.path))
    .map(copyWorkflow)
    .filter((c): c is Exclude<WorkflowChange, { kind: 'kept' }> => c.kind !== 'kept');
}

// The body of the copy commit: deleted files and removed triggers
export function copyCommitBody(changes: Exclude<WorkflowChange, { kind: 'kept' }>[]): string {
  return changes
    .map((c) =>
      c.kind === 'deleted'
        ? `- delete ${c.path} (triggers: ${c.removed.join(', ')})`
        : `- ${c.path}: remove ${c.removed.join(', ')}`,
    )
    .join('\n');
}
