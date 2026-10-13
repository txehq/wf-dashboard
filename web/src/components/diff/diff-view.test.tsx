import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { must } from '@/lib/must';
import { DiffFileCard, DiffView } from './diff-view';
import patches from './fixtures/patches.json';
import { type DiffFile, countChanges, hunksOfBlocks, parseUnifiedDiff } from './model';
import { DiffViewTypeToggle } from './view-type-toggle';
import { useDiffViewType } from './view-type';

// fixtures/patches.json：一次真实分析（a-20261013-qdvnk8）的修改建议，两个文件各删 1 行、增 4 行
const files = patches.flatMap((p) => parseUnifiedDiff(p.patch));

function Toggled({ shown }: { shown: DiffFile[] }) {
  const [viewType] = useDiffViewType();
  return (
    <div style={{ width: 1100 }}>
      <DiffViewTypeToggle />
      <DiffView files={shown} viewType={viewType} />
    </div>
  );
}

const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((e) => e.textContent);

test('真实的 unified diff：增删行数、行号、行首的标记与红绿底色', async () => {
  localStorage.clear();
  const screen = await render(<Toggled shown={files} />);
  const cards = screen.container.querySelectorAll('[data-testid="diff-file"]');
  expect([...cards].map((c) => c.getAttribute('data-path'))).toEqual([
    'ic/SKILL.md',
    'open-pr/SKILL.md',
  ]);
  expect(texts(screen.container, '[data-testid="diff-counts"]')).toEqual(['+4 −1', '+4 −1']);
  const ic = cards[0];
  if (ic === undefined) throw new Error('没有 ic/SKILL.md');
  expect(ic.querySelectorAll('td.diff-code-insert').length).toBe(4);
  expect(ic.querySelectorAll('td.diff-code-delete').length).toBe(1);
  expect(screen.container.querySelectorAll('td.diff-code-insert').length).toBe(8);
  expect(screen.container.querySelectorAll('td.diff-code-delete').length).toBe(2);

  // 统一视图每行两个行号：旧、新
  const rows = [...ic.querySelectorAll('tr.diff-line')].map((row) =>
    texts(row, 'td.diff-gutter').join('|'),
  );
  expect(rows).toEqual([
    '61|61',
    '62|62',
    '63|63',
    '64|',
    '|64',
    '|65',
    '|66',
    '|67',
    '65|68',
    '66|69',
    '67|70',
  ]);
  const inserted = ic.querySelector('td.diff-code-insert');
  const deleted = ic.querySelector('td.diff-code-delete');
  if (inserted === null || deleted === null) throw new Error('没有增删的行');
  expect(getComputedStyle(inserted, '::before').content).toBe('"+"');
  expect(getComputedStyle(deleted, '::before').content).toBe('"-"');
  expect(getComputedStyle(inserted).backgroundColor).toBe('rgb(230, 255, 236)');
  expect(getComputedStyle(deleted).backgroundColor).toBe('rgb(255, 235, 233)');
  // 行内改动的词加深：删除的那一行与新增的第一行只差结尾
  const edit = inserted.querySelector('.diff-code-edit');
  expect(edit?.textContent).toBe(' When it');
  expect(getComputedStyle(must(edit)).backgroundColor).toBe('rgb(171, 242, 188)');
});

test('统一与并排切换，选择记在 localStorage', async () => {
  localStorage.clear();
  const screen = await render(<Toggled shown={files.slice(0, 1)} />);
  const toggle = screen.getByTestId('diff-view-type');
  await expect.element(toggle).toHaveAttribute('data-view', 'unified');
  expect(screen.container.querySelector('table.diff-unified')).not.toBeNull();
  await screen.getByRole('button', { name: '并排' }).click();
  await expect.element(toggle).toHaveAttribute('data-view', 'split');
  expect(localStorage.getItem('wfd.diff.view')).toBe('split');
  const table = screen.container.querySelector('table.diff-split');
  if (table === null) throw new Error('没有并排的表格');
  // 并排：删除的行在左、新增的第一行在右，同一行
  const paired = [...table.querySelectorAll('tr.diff-line')].find(
    (row) => row.querySelector('td.diff-code-delete') !== null,
  );
  expect(texts(must(paired), 'td.diff-gutter')).toEqual(['64', '64']);
  expect(paired?.querySelector('td.diff-code-insert')).not.toBeNull();
  expect(table.querySelectorAll('td.diff-code-insert').length).toBe(4);
});

test('文件标题可以折叠；给出原文时没有改动的长段折叠，点击展开', async () => {
  localStorage.clear();
  const original = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}\n`).join('');
  const hunks = hunksOfBlocks(original, [
    { start: 4, remove: ['line 5\n'], insert: ['five\n'] },
    { start: 30, remove: [], insert: ['inserted\n'] },
  ]);
  const file: DiffFile = {
    path: 'skills/x/SKILL.md',
    status: 'modified',
    hunks,
    ...countChanges(hunks),
  };
  function Card() {
    const [headers] = useState(() => ['第一处', '第二处']);
    return (
      <div style={{ width: 900 }}>
        <DiffFileCard
          file={file}
          viewType="unified"
          source={original}
          renderHunkHeader={(_, i) => <div data-testid="hunk-header">{headers[i]}</div>}
        />
      </div>
    );
  }
  const screen = await render(<Card />);
  expect(texts(screen.container, '[data-testid="hunk-header"]')).toEqual(['第一处', '第二处']);
  expect(screen.container.querySelectorAll('tr.diff-line').length).toBe(8 + 7);
  expect(texts(screen.container, '[data-testid="diff-expand"]').map((t) => t.trim())).toEqual([
    '展开 1 行未改动',
    '展开 19 行未改动',
    '展开 7 行未改动',
  ]);
  await screen.getByText('展开 19 行未改动').click();
  expect(screen.container.querySelectorAll('tr.diff-line').length).toBe(8 + 19 + 7);
  const numbers = [...screen.container.querySelectorAll('tr.diff-line')].map((row) =>
    texts(row, 'td.diff-gutter').join('|'),
  );
  // 展开的行接在第一处之后：旧 9 到 27，新的一侧行号相同（第一处删 1 增 1）
  expect(numbers.slice(8, 10)).toEqual(['9|9', '10|10']);
  expect(numbers.at(8 + 18)).toBe('27|27');

  await screen.getByRole('button', { name: 'skills/x/SKILL.md' }).click();
  expect(screen.container.querySelector('table.diff')).toBeNull();
  await screen.getByRole('button', { name: 'skills/x/SKILL.md' }).click();
  expect(screen.container.querySelector('table.diff')).not.toBeNull();
});
