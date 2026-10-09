import { expect, test } from 'vitest';
import { multiply } from '../../src/math.js';

// PR 中没有 multiply 导出：文件能加载，两个测试都失败
test('multiply(2, 3) returns 6', () => {
  expect(multiply(2, 3)).toBe(6);
});

test('multiply by zero', () => {
  expect(multiply(7, 0)).toBe(0);
});
