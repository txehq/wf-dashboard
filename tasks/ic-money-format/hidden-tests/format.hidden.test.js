import { describe, expect, test } from 'vitest';
import { CURRENCIES, formatMoney } from '../../src/index.js';

describe('minor-unit digits come from the currency table', () => {
  test('JPY has no fraction', () => {
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
  });

  test('KRW has no fraction and still groups thousands', () => {
    expect(formatMoney(50000000, 'KRW')).toBe('₩50,000,000');
  });

  test('KWD has three fraction digits', () => {
    expect(formatMoney(1234567, 'KWD')).toBe('KD1,234.567');
  });

  test('KWD pads small amounts to three digits', () => {
    expect(formatMoney(5, 'KWD')).toBe('KD0.005');
  });

  test('two-digit currencies are unchanged', () => {
    expect(formatMoney(123456789, 'USD')).toBe('$1,234,567.89');
    expect(formatMoney(7, 'GBP')).toBe('£0.07');
    expect(formatMoney(0, 'CNY')).toBe('¥0.00');
  });

  test('zero in a zero-decimal currency', () => {
    expect(formatMoney(0, 'JPY')).toBe('¥0');
  });

  test('a currency added to the table is formatted with its own digits', () => {
    CURRENCIES.BHD = { symbol: 'BD', decimals: 3 };
    try {
      expect(formatMoney(1500, 'BHD')).toBe('BD1.500');
    } finally {
      delete CURRENCIES.BHD;
    }
  });
});

describe('negative amounts', () => {
  test('minus sign goes before the symbol', () => {
    expect(formatMoney(-1999, 'USD')).toBe('-$19.99');
  });

  test('negative amount below one major unit', () => {
    expect(formatMoney(-5, 'EUR')).toBe('-€0.05');
  });

  test('negative zero-decimal amount with grouping', () => {
    expect(formatMoney(-1234567, 'JPY')).toBe('-¥1,234,567');
  });

  test('negative zero is formatted as zero', () => {
    expect(formatMoney(-0, 'USD')).toBe('$0.00');
  });
});

describe('large amounts are exact', () => {
  test('largest safe integer in a two-digit currency', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91');
  });

  test('amount that floating-point division rounds wrongly', () => {
    expect(formatMoney(900719925474099, 'USD')).toBe('$9,007,199,254,740.99');
  });

  test('largest safe integer in a three-digit currency', () => {
    expect(formatMoney(-Number.MAX_SAFE_INTEGER, 'KWD')).toBe('-KD9,007,199,254,740.991');
  });
});

describe('invalid input', () => {
  test('unknown currency throws RangeError naming the code', () => {
    expect(() => formatMoney(100, 'XYZ')).toThrow(RangeError);
    expect(() => formatMoney(100, 'XYZ')).toThrow(/XYZ/);
  });

  test('inherited object keys are not currencies', () => {
    expect(() => formatMoney(100, 'toString')).toThrow(RangeError);
  });

  test('fractional minor units throw TypeError', () => {
    expect(() => formatMoney(12.5, 'USD')).toThrow(TypeError);
  });

  test('non-numbers throw TypeError', () => {
    expect(() => formatMoney('100', 'USD')).toThrow(TypeError);
    expect(() => formatMoney(Number.NaN, 'USD')).toThrow(TypeError);
  });

  test('unsafe integers throw TypeError', () => {
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(TypeError);
  });
});
