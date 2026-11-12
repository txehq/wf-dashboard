import type { Tokens } from '@/lib/sessions-api';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return n < 10_000 ? integer.format(n) : compact.format(n);
}

export function formatInteger(n: number): string {
  return integer.format(n);
}

// A count with its noun: 1 run, 3 runs
export function formatNoun(n: number, noun: string, plural = `${noun}s`): string {
  return `${integer.format(n)} ${n === 1 ? noun : plural}`;
}

const byteUnits = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

// File size: steps of 1024, one decimal place
export function formatBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'unit',
    unit: byteUnits[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${integer.format(Math.round(n))}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ${String(m % 60)}m`;
  return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
}

const dateTime = new Intl.DateTimeFormat('en-US', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

export function durationBetween(startIso: string, endIso: string): number {
  return new Date(endIso).getTime() - new Date(startIso).getTime();
}
