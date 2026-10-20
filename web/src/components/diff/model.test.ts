import { expect, test } from 'vitest';
import patches from './fixtures/patches.json';
import { gapBetween, hunksOfBlocks, parseUnifiedDiff } from './model';

// fixtures/patches.json：一次真实分析（a-20261013-qdvnk8，Claude Code 引擎）的 synthesize 写出的修改建议

test('真实的 unified diff 解析出文件、增删行数与两侧行号', () => {
  const files = patches.flatMap((p) => parseUnifiedDiff(p.patch));
  expect(
    files.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  ).toEqual([
    { path: 'ic/SKILL.md', status: 'modified', additions: 4, deletions: 1 },
    { path: 'open-pr/SKILL.md', status: 'modified', additions: 4, deletions: 1 },
  ]);
  const [hunk] = files[0]?.hunks ?? [];
  expect(hunk).toMatchObject({ oldStart: 61, oldLines: 7, newStart: 61, newLines: 10 });
  expect(
    hunk?.changes.map((c) =>
      c.type === 'normal' ? `${String(c.oldLineNumber)} ${String(c.newLineNumber)}` : c.type[0],
    ),
  ).toEqual(['61 61', '62 62', '63 63', 'd', 'i', 'i', 'i', 'i', '65 68', '66 69', '67 70']);
  const deleted = hunk?.changes.find((c) => c.type === 'delete');
  expect(deleted).toMatchObject({
    lineNumber: 64,
    content:
      '  implementation review in `/implement` that did not run is noted, and the run goes on.',
  });
  expect(hunk?.changes.filter((c) => c.type === 'insert').map((c) => c.lineNumber)).toEqual([
    64, 65, 66, 67,
  ]);
});

test('新增与删除的文件按 /dev/null 判断', () => {
  const [added, removed] = parseUnifiedDiff(
    [
      '--- /dev/null',
      '+++ b/skills/new/SKILL.md',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '--- a/skills/old/SKILL.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '',
    ].join('\n'),
  );
  expect(added).toMatchObject({ path: 'skills/new/SKILL.md', status: 'added', additions: 2 });
  expect(added?.hunks[0]?.changes.map((c) => (c.type === 'insert' ? c.lineNumber : 0))).toEqual([
    1, 2,
  ]);
  expect(removed).toMatchObject({ path: 'skills/old/SKILL.md', status: 'removed', deletions: 1 });
});

const original = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}\n`).join('');

test('逐处改动各成一个 hunk：上下文、两侧行号、相邻改动之间的行不重复', () => {
  const hunks = hunksOfBlocks(original, [
    { start: 4, remove: ['line 5\n'], insert: ['five\n', 'five and a half\n'] },
    // 与上一处只隔 2 行
    { start: 7, remove: [], insert: ['inserted\n'] },
    { start: 20, remove: ['line 21\n', 'line 22\n'], insert: [] },
  ]);
  expect(hunks.map((h) => h.content)).toEqual([
    '@@ -2,6 +2,7 @@',
    '@@ -8,3 +9,4 @@',
    '@@ -18,8 +20,6 @@',
  ]);
  expect(
    hunks[1]?.changes.map((c) =>
      c.type === 'normal'
        ? `${String(c.oldLineNumber)} ${String(c.newLineNumber)}`
        : `${c.type} ${String(c.lineNumber)}`,
    ),
  ).toEqual(['insert 9', '8 10', '9 11', '10 12']);
  expect(hunks[2]?.changes.at(-1)).toMatchObject({
    content: 'line 25',
    oldLineNumber: 25,
    newLineNumber: 25,
  });
});

test('hunk 之间没有显示的行', () => {
  const hunks = hunksOfBlocks(original, [
    { start: 4, remove: ['line 5\n'], insert: ['five\n', 'five and a half\n'] },
    { start: 20, remove: ['line 21\n', 'line 22\n'], insert: [] },
  ]);
  const [first, second] = hunks;
  if (first === undefined || second === undefined) throw new Error('应有两个 hunk');
  expect(gapBetween(null, first, 30)).toEqual({ from: 0, to: 1, newFrom: 0 });
  expect(gapBetween(first, second, 30)).toEqual({ from: 8, to: 17, newFrom: 9 });
  expect(gapBetween(second, null, 30)).toEqual({ from: 25, to: 30, newFrom: 24 });
});
