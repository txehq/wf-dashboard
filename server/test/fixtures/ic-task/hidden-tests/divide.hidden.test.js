import { expect, test } from 'vitest';
import { divide } from '../../src/divide.js';

// PR 中没有 src/divide.js：整份文件无法加载，JUnit 中只有一条文件级 testcase
test('divide(6, 3) returns 2', () => {
  expect(divide(6, 3)).toBe(2);
});

test('divide by one', () => {
  expect(divide(7, 1)).toBe(7);
});
