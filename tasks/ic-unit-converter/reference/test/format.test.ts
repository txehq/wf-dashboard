import { describe, expect, it } from 'vitest';
import { formatNumber } from '../src/format';

describe('formatNumber', () => {
  it('prints integers without decimals', () => {
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(-3)).toBe('-3');
  });

  it('prints short decimals as they are', () => {
    expect(formatNumber(0.001)).toBe('0.001');
  });

  it('removes floating point noise', () => {
    expect(formatNumber(2.5399999999999996)).toBe('2.54');
    expect(formatNumber(0.9144000000000001)).toBe('0.9144');
  });

  it('rounds to four decimals', () => {
    expect(formatNumber(28.349523125)).toBe('28.3495');
    expect(formatNumber(-17.22222)).toBe('-17.2222');
  });

  it('never prints -0', () => {
    expect(formatNumber(-0.00001)).toBe('0');
  });
});
