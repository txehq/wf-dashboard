import type { Spread } from './views.js';

// Durations of the Team page (Contracts 37.6, 37.7): txe PRs and closed issues, in ms

// Linear interpolation between the closest ranks of sorted values
function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const low = sorted[lo];
  if (low === undefined) throw new Error('No values');
  const high = sorted[Math.min(lo + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (at - lo);
}

// Over the values that are there; null with none
export function spread(values: (number | null)[]): Spread {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    count: sorted.length,
  };
}

// From start to end; null when the recorded times are reversed (on the day txe moved to txehq, 2026-11-01, GitHub
// records some PRs created after their merge), which leaves the duration out of every spread
export const between = (start: number, end: number) => (end < start ? null : end - start);
