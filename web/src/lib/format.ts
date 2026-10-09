import type { Tokens } from '@/lib/sessions-api';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return n < 10_000 ? integer.format(n) : compact.format(n);
}

export function formatInteger(n: number): string {
  return integer.format(n);
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
  if (s < 60) return `${String(s)} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} 分 ${String(s % 60)} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} 小时 ${String(m % 60)} 分`;
  return `${String(Math.floor(h / 24))} 天 ${String(h % 24)} 小时`;
}

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const time = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
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
