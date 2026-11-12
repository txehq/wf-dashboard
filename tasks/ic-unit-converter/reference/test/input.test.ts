import { describe, expect, it } from 'vitest';
import { readValue } from '../src/input';

describe('readValue', () => {
  it('treats blank text as empty', () => {
    expect(readValue('', 'm')).toEqual({ kind: 'empty' });
    expect(readValue('   ', 'm')).toEqual({ kind: 'empty' });
  });

  it('accepts whole numbers only', () => {
    expect(readValue(' 12 ', 'm')).toEqual({ kind: 'valid', value: 12 });
    expect(readValue('-1.5', 'c')).toEqual({ kind: 'valid', value: -1.5 });
    for (const text of ['abc', '12abc', '1.2.3', '-', '.']) {
      expect(readValue(text, 'm')).toEqual({ kind: 'invalid', message: 'Enter a number' });
    }
  });

  it('rejects negative lengths and weights', () => {
    const message = 'Length and weight cannot be negative';
    expect(readValue('-5', 'cm')).toEqual({ kind: 'invalid', message });
    expect(readValue('-0.5', 'kg')).toEqual({ kind: 'invalid', message });
  });

  it('rejects temperatures below absolute zero', () => {
    const message = 'Temperature cannot be below absolute zero';
    expect(readValue('-300', 'c')).toEqual({ kind: 'invalid', message });
    expect(readValue('-460', 'f')).toEqual({ kind: 'invalid', message });
    expect(readValue('-1', 'k')).toEqual({ kind: 'invalid', message });
    expect(readValue('-273.15', 'c')).toEqual({ kind: 'valid', value: -273.15 });
    expect(readValue('-459.67', 'f')).toEqual({ kind: 'valid', value: -459.67 });
  });
});
