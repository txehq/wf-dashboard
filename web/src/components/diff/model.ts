import { parsePatch } from 'diff';
import type { ChangeData, HunkData } from 'react-diff-view';

// Data for the shared diff display (Contracts 21.3): the changes to one file, line numbers from 1

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

// A unified diff line: the first character is the marker, the rest is the content
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
    // Anything else is "\ No newline at end of file", not a content line
  }
  return changes;
}

export const hunkTitle = (h: Pick<HunkData, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>) =>
  `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`;

export const countChanges = (hunks: HunkData[]) => ({
  additions: hunks.reduce((n, h) => n + h.changes.filter((c) => c.type === 'insert').length, 0),
  deletions: hunks.reduce((n, h) => n + h.changes.filter((c) => c.type === 'delete').length, 0),
});

// Unified diff text (possibly several files) parsed by jsdiff, then turned into react-diff-view hunks
export function parseUnifiedDiff(text: string): DiffFile[] {
  return parsePatch(text)
    .filter((file) => file.hunks.length > 0)
    .map((file) => {
      const added = isMissing(file.oldFileName);
      const removed = isMissing(file.newFileName);
      const name = removed ? file.oldFileName : file.newFileName;
      if (name === undefined || name === '/dev/null') {
        throw new Error('A file in the unified diff has no path');
      }
      // For a hunk with no lines on one side, jsdiff already set the start line to the insertion point
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

// One change in the original: from line start (0-based) remove `remove` and insert `insert`; lines may keep their newline
export interface ChangeBlock {
  start: number;
  remove: string[];
  insert: string[];
}

export const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const chomp = (line: string) => (line.endsWith('\n') ? line.slice(0, -1) : line);

// Each change becomes its own hunk with up to `context` unchanged lines on each side; when the lines between two
// changes run short, the earlier change takes them first. The hunks match blocks one to one, in the same order
export function hunksOfBlocks(original: string, blocks: ChangeBlock[], context = 3): HunkData[] {
  const lines = splitLines(original).map(chomp);
  const hunks: HunkData[] = [];
  // Difference between new and old line numbers
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

// Lines not shown between two adjacent hunks (previous null: from the file start to the first hunk; next null: from the
// last hunk to the file end): the range [from, to) in the original (0-based) and its start line in the new file
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
