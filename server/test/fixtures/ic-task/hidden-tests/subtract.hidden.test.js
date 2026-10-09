import { expect, test } from 'vitest';
import { add, subtract } from '../../src/math.js';

test('subtract(5, 3) returns 2', () => {
  expect(subtract(5, 3)).toBe(2);
});

test('subtract handles negatives', () => {
  expect(subtract(-1, -4)).toBe(3);
});

test('add still works', () => {
  expect(add(1, 1)).toBe(2);
});

// 有意失败：隐藏需求要求精确的十进制结果，PR 的实现没有满足
test('subtract(0.3, 0.1) returns exactly 0.2', () => {
  expect(subtract(0.3, 0.1)).toBe(0.2);
});
