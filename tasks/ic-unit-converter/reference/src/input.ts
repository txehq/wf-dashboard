import { findUnit } from './units';

export type ValueState =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; value: number };

const NUMBER = /^-?(\d+(\.\d+)?|\.\d+)$/;

// Reads the text typed into the value field as a value of the given unit.
export function readValue(text: string, unitId: string): ValueState {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!NUMBER.test(trimmed)) return { kind: 'invalid', message: '请输入数字' };
  const value = Number(trimmed);
  const { category, unit } = findUnit(unitId);
  if (unit.toBase(value) < category.minBase) {
    return { kind: 'invalid', message: category.minMessage };
  }
  return { kind: 'valid', value };
}
