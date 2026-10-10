import { findUnit } from './units';

export function convert(value: number, from: string, to: string): number {
  const source = findUnit(from);
  const target = findUnit(to);
  if (source.category.id !== target.category.id) {
    throw new Error(`cannot convert ${from} to ${to}`);
  }
  if (from === to) return value;
  return target.unit.fromBase(source.unit.toBase(value));
}
