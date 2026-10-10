import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert';

describe('convert', () => {
  it('converts between length units', () => {
    expect(convert(1, 'm', 'cm')).toBe(100);
    expect(convert(2, 'km', 'm')).toBe(2000);
    expect(convert(1, 'mi', 'ft')).toBeCloseTo(5280);
  });

  it('converts between weight units', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(16, 'oz', 'lb')).toBeCloseTo(1);
  });

  it('converts between temperature units', () => {
    expect(convert(100, 'c', 'f')).toBeCloseTo(212);
    expect(convert(-40, 'f', 'c')).toBeCloseTo(-40);
    expect(convert(0, 'k', 'c')).toBeCloseTo(-273.15);
    expect(convert(32, 'f', 'k')).toBeCloseTo(273.15);
  });

  it('returns the value unchanged for the same unit', () => {
    expect(convert(42, 'ft', 'ft')).toBe(42);
    expect(convert(25, 'c', 'c')).toBe(25);
  });

  it('refuses to convert across categories', () => {
    expect(() => convert(1, 'm', 'kg')).toThrow('cannot convert m to kg');
    expect(() => convert(1, 'c', 'm')).toThrow('cannot convert c to m');
  });

  it('rejects unknown units', () => {
    expect(() => convert(1, 'yd', 'm')).toThrow('unknown unit: yd');
  });
});
