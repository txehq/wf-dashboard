import { parsePatch } from 'diff';
import type { ChangeData, HunkData } from 'react-diff-view';

// 共用的 diff 显示（Contracts 21.3）的数据：一个文件的若干处改动，行号从 1 起

export type DiffStatus = 'added' | 'removed' | 'modified';

export interface DiffFile {
  path: string;
  status: DiffStatus;
  hunks: HunkData[];
  additions: number;
  deletions: number;
}

const isMissing = (name: string | undefined) => name === undefined || name === '/dev/null';
const stripPrefix = (name: string) => name.replace(/^[ab]\//, '');

// unified diff 的一行：第一个字符是标记，其余是内容
function changesOf(lines: string[], oldStart: number, newStart: number): ChangeData[] {
  const changes: ChangeData[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  for (const line of lines) {
    const content = line.slice(1);
    if (line.startsWith('+')) {
      changes.push({ type: 'insert', isInsert: true, content, lineNumber: newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      changes.push({ type: 'delete', isDelete: true, content, lineNumber: oldLine });
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      changes.push({
        type: 'normal',
        isNormal: true,
        content,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
    // 其余是 "\ No newline at end of file"，不是内容行
  }
  return changes;
}

export const hunkTitle = (h: Pick<HunkData, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>) =>
  `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`;

export const countChanges = (hunks: HunkData[]) => ({
  additions: hunks.reduce((n, h) => n + h.changes.filter((c) => c.type === 'insert').length, 0),
  deletions: hunks.reduce((n, h) => n + h.changes.filter((c) => c.type === 'delete').length, 0),
});

// unified diff 文本（可以含多个文件）由 jsdiff 解析，再转成 react-diff-view 的 hunk
export function parseUnifiedDiff(text: string): DiffFile[] {
  return parsePatch(text)
    .filter((file) => file.hunks.length > 0)
    .map((file) => {
      const added = isMissing(file.oldFileName);
      const removed = isMissing(file.newFileName);
      const name = removed ? file.oldFileName : file.newFileName;
      if (name === undefined || name === '/dev/null') {
        throw new Error('unified diff 中的文件没有路径');
      }
      // 一侧没有行的 hunk，jsdiff 已把起始行号改为插入位置所在的行
      const hunks = file.hunks.map((h) => ({
        content: hunkTitle(h),
        oldStart: h.oldStart,
        newStart: h.newStart,
        oldLines: h.oldLines,
        newLines: h.newLines,
        changes: changesOf(h.lines, h.oldStart, h.newStart),
      }));
      return {
        path: stripPrefix(name),
        status: added ? 'added' : removed ? 'removed' : 'modified',
        hunks,
        ...countChanges(hunks),
      };
    });
}

// 原文中的一处改动：从第 start 行（0 起）删除 remove，插入 insert；行可以带换行符
export interface ChangeBlock {
  start: number;
  remove: string[];
  insert: string[];
}

export const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const chomp = (line: string) => (line.endsWith('\n') ? line.slice(0, -1) : line);

// 每处改动各成一个 hunk，前后各带至多 context 行未改动的内容；两处改动之间的行不够时前一处先取。
// 返回的 hunk 与 blocks 一一对应，顺序相同
export function hunksOfBlocks(original: string, blocks: ChangeBlock[], context = 3): HunkData[] {
  const lines = splitLines(original).map(chomp);
  const hunks: HunkData[] = [];
  // 新旧两侧行号之差
  let shift = 0;
  let previousEnd = 0;
  for (const [i, block] of blocks.entries()) {
    const end = block.start + block.remove.length;
    const before = Math.min(context, block.start - previousEnd);
    const next = blocks[i + 1];
    const after = Math.min(context, (next === undefined ? lines.length : next.start) - end);
    const from = block.start - before;
    const oldStart = from + 1;
    const newStart = from + shift + 1;
    const normal = (index: number, newIndex: number): ChangeData => ({
      type: 'normal',
      isNormal: true,
      content: lines[index] ?? '',
      oldLineNumber: index + 1,
      newLineNumber: newIndex + 1,
    });
    const changes: ChangeData[] = [];
    for (let l = from; l < block.start; l += 1) changes.push(normal(l, l + shift));
    block.remove.forEach((line, k) => {
      changes.push({
        type: 'delete',
        isDelete: true,
        content: chomp(line),
        lineNumber: block.start + k + 1,
      });
    });
    block.insert.forEach((line, k) => {
      changes.push({
        type: 'insert',
        isInsert: true,
        content: chomp(line),
        lineNumber: block.start + shift + k + 1,
      });
    });
    shift += block.insert.length - block.remove.length;
    for (let l = end; l < end + after; l += 1) changes.push(normal(l, l + shift));
    const hunk = {
      oldStart,
      newStart,
      oldLines: before + block.remove.length + after,
      newLines: before + block.insert.length + after,
      changes,
    };
    hunks.push({ ...hunk, content: hunkTitle(hunk) });
    previousEnd = end + after;
  }
  return hunks;
}

// 相邻两个 hunk 之间（previous 为空时是文件开头到第一个 hunk，next 为空时是最后一个 hunk 到文件结尾）没有显示的行：
// 原文中的范围 [from, to)（0 起）与它在新文件中的起始行
export function gapBetween(
  previous: HunkData | null,
  next: HunkData | null,
  totalLines: number,
): { from: number; to: number; newFrom: number } {
  const from = previous === null ? 0 : previous.oldStart - 1 + previous.oldLines;
  const newFrom = previous === null ? 0 : previous.newStart - 1 + previous.newLines;
  const to = next === null ? totalLines : next.oldStart - 1;
  return { from, to, newFrom };
}
