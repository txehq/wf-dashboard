import { expect, test } from 'vitest';
import { outcomeRows } from './compare';

// W15 Low 21：ic 并排以前只列左边 run 的测试，只在右边出现的测试看不到
test('ic 并排列出两个 run 的测试并集，左边的清单在前', () => {
  const t = (file: string, name: string, outcome: 'passed' | 'failed') => ({ file, name, outcome });
  const rows = outcomeRows(
    [t('test/hidden/a.test.js', 'one', 'passed'), t('test/hidden/a.test.js', 'two', 'failed')],
    [t('test/hidden/a.test.js', 'two', 'passed'), t('test/hidden/b.test.js', 'three', 'failed')],
  );
  expect(rows.map((r) => [r.name, r.left?.outcome ?? null, r.right?.outcome ?? null])).toEqual([
    ['one', 'passed', null],
    ['two', 'failed', 'passed'],
    ['three', null, 'failed'],
  ]);
});
