import { expect, test } from '@playwright/test';
import { convert } from '../../src/convert';
import { formatNumber } from '../../src/format';

// 单元层面的边界情况：不打开页面，直接调用 src 中的函数

test.describe('convert temperature', () => {
  test('°C to °F', () => {
    expect(convert(100, 'c', 'f')).toBeCloseTo(212, 10);
    expect(convert(-40, 'c', 'f')).toBeCloseTo(-40, 10);
  });

  test('°F to °C', () => {
    expect(convert(212, 'f', 'c')).toBeCloseTo(100, 10);
    expect(convert(98.6, 'f', 'c')).toBeCloseTo(37, 10);
  });

  test('°C to K and back', () => {
    expect(convert(0, 'c', 'k')).toBeCloseTo(273.15, 10);
    expect(convert(0, 'k', 'c')).toBeCloseTo(-273.15, 10);
  });

  test('°F to K and K to °F', () => {
    expect(convert(32, 'f', 'k')).toBeCloseTo(273.15, 10);
    expect(convert(0, 'k', 'f')).toBeCloseTo(-459.67, 10);
  });

  test('same temperature unit returns the value', () => {
    expect(convert(25, 'c', 'c')).toBe(25);
    expect(convert(-12.5, 'f', 'f')).toBe(-12.5);
  });

  test('round trip °C → °F → °C', () => {
    expect(convert(convert(23.7, 'c', 'f'), 'f', 'c')).toBeCloseTo(23.7, 10);
  });
});

test.describe('convert keeps existing behaviour', () => {
  test('length and weight ratios', () => {
    expect(convert(1, 'in', 'cm')).toBeCloseTo(2.54, 10);
    expect(convert(1, 'lb', 'kg')).toBeCloseTo(0.45359237, 10);
    expect(convert(1, 'm', 'cm')).toBe(100);
  });

  test('temperature cannot be converted to length', () => {
    expect(() => convert(1, 'c', 'm')).toThrow();
    expect(() => convert(1, 'kg', 'k')).toThrow();
  });
});

test.describe('formatNumber', () => {
  test('floating point noise is removed', () => {
    expect(formatNumber(2.5399999999999996)).toBe('2.54');
    expect(formatNumber(0.9144000000000001)).toBe('0.9144');
    expect(formatNumber(98.60000000000001)).toBe('98.6');
  });

  test('at most four decimals', () => {
    expect(formatNumber(1.23456)).toBe('1.2346');
    expect(formatNumber(-17.22222222)).toBe('-17.2222');
    expect(formatNumber(28.349523125)).toBe('28.3495');
  });

  test('no trailing zeros', () => {
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(1609.344)).toBe('1609.344');
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(63360)).toBe('63360');
  });

  test('values that round to zero print as 0, never -0', () => {
    expect(formatNumber(0.00004)).toBe('0');
    expect(formatNumber(-0.00004)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
  });

  test('negative values keep their sign', () => {
    expect(formatNumber(-459.67)).toBe('-459.67');
    expect(formatNumber(-40)).toBe('-40');
  });
});
