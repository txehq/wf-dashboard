import { useRef } from 'react';
import type { LineMarks } from './mark-lines';
import { Markdown } from './markdown';
import { useScrollSync } from './scroll-sync';

// 原文中的一处改动：从第 start 行（0 起）删除 remove 行、插入 insert 行
interface Change {
  start: number;
  remove: string[];
  insert: string[];
}

function marksOf(changes: Change[]): { removed: LineMarks; added: LineMarks } {
  const removed: [number, number][] = [];
  const added: [number, number][] = [];
  let shift = 0;
  for (const change of [...changes].sort((a, b) => a.start - b.start)) {
    if (change.remove.length > 0) {
      removed.push([change.start + 1, change.start + change.remove.length]);
    }
    if (change.insert.length > 0) {
      added.push([change.start + shift + 1, change.start + shift + change.insert.length]);
    }
    shift += change.insert.length - change.remove.length;
  }
  return { removed: { kind: 'removed', lines: removed }, added: { kind: 'added', lines: added } };
}

// 渲染后的对比（Contracts 21.3）：左右两份渲染的 Markdown，改动的段落标出，滚动同步
export function RenderedCompare({
  path,
  original,
  modified,
  changes,
  labels = ['原文', '修改后'],
}: {
  path: string;
  original: string;
  modified: string;
  changes: Change[];
  labels?: [string, string];
}) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  useScrollSync(left, right);
  const marks = marksOf(changes);
  const sides = [
    { ref: left, label: labels[0], content: original, marks: marks.removed, side: 'original' },
    { ref: right, label: labels[1], content: modified, marks: marks.added, side: 'modified' },
  ];
  return (
    <div className="grid h-full min-h-0 grid-cols-2 divide-x" data-testid="rendered-compare">
      {sides.map((s) => (
        <div key={s.side} className="flex min-h-0 min-w-0 flex-col">
          <div className="shrink-0 border-b bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
            {s.label}
          </div>
          <div ref={s.ref} className="min-h-0 flex-1 overflow-auto" data-side={s.side}>
            <Markdown content={s.content} filePath={path} marks={s.marks} className="px-6 py-4" />
          </div>
        </div>
      ))}
    </div>
  );
}
