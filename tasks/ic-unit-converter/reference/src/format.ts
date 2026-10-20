// At most four decimals, no trailing zeros, and never "-0".
export function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(4));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
