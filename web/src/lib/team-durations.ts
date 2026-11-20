import { formatNoun } from '@/lib/format';
import type { Spread } from '@/lib/team-api';

// Durations of the Team page (Contracts 37.6, 37.7): txe PRs and closed issues

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 45m, 3h 20m, 2d 4h
export function duration(ms: number): string {
  if (ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))}m`;
  if (ms < DAY) {
    const m = Math.floor((ms % HOUR) / MINUTE);
    return `${String(Math.floor(ms / HOUR))}h${m === 0 ? '' : ` ${String(m)}m`}`;
  }
  const h = Math.floor((ms % DAY) / HOUR);
  return `${String(Math.floor(ms / DAY))}d${h === 0 ? '' : ` ${String(h)}h`}`;
}

// The hover of a spread: what it measures, then its numbers over the PRs or issues (noun) that have it
export const spreadTitle = (title: string, s: Spread, noun: string) =>
  s === null
    ? `${title}. None has it`
    : `${title}. Average ${duration(s.mean)}, median ${duration(s.median)}, P90 ${duration(s.p90)}, over ${formatNoun(s.count, noun)}`;
