import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AskQuestion } from '../../src/db/schema.js';
import { readMenu } from '../../src/live/keys.js';

// 第一步实测时 Claude Code 选项菜单的真实屏幕（@xterm/headless 读出的可见行）
const screen = (name: string) =>
  fs
    .readFileSync(path.join(import.meta.dirname, '../fixtures/live/screens', `${name}.txt`), 'utf8')
    .split('\n');

const color: AskQuestion = {
  question: '选一个颜色',
  header: '颜色',
  options: [{ label: '红' }, { label: '绿' }, { label: '蓝' }],
  multiSelect: false,
};
const fruits4: AskQuestion = {
  question: '选几种水果',
  header: '水果',
  options: [{ label: '苹果' }, { label: '香蕉' }, { label: '橙子' }, { label: '葡萄' }],
  multiSelect: true,
};
const fruits3: AskQuestion = { ...fruits4, options: fruits4.options.slice(0, 3) };

describe('读取选项菜单', () => {
  test('单选：光标在第 1 项，最后是 Type something', () => {
    const menu = readMenu(screen('single-q1-of-3'), color);
    expect(menu).toEqual({
      cursor: 0,
      rows: [
        { number: 1, label: '红', checked: null },
        { number: 2, label: '绿', checked: null },
        { number: 3, label: '蓝', checked: null },
        { number: 4, label: 'Type something.', checked: null },
      ],
    });
  });

  test('单选："其他"中已经写了文字', () => {
    const menu = readMenu(screen('single-other-typed'), color);
    expect(menu?.cursor).toBe(3);
    expect(menu?.rows[3]).toEqual({ number: 4, label: '紫色，带一点灰', checked: null });
  });

  test('多选：勾选状态与 Next 行', () => {
    const menu = readMenu(screen('multi-checked-1-3'), fruits4);
    expect(menu?.cursor).toBe(0);
    expect(menu?.rows.map((r) => [r.number, r.checked])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, false],
      [5, false],
      [null, null],
    ]);
    expect(menu?.rows.at(-1)?.label).toBe('Next');
  });

  test('多选：光标在 Next 行，"其他"写了文字并勾选', () => {
    const menu = readMenu(screen('multi-other-cursor-next'), fruits3);
    expect(menu?.cursor).toBe(4);
    expect(menu?.rows[3]).toEqual({ number: 4, label: '还有西瓜', checked: true });
  });

  test('屏幕上没有这个问题时为空', () => {
    expect(readMenu(screen('review'), color)).toBeNull();
    expect(readMenu(screen('single-q1-of-3'), { ...color, question: '选一个城市' })).toBeNull();
  });
});
