// Calendar days (yyyy-mm-dd) of the Linear stats page; the server decides which day a time falls on (Contracts 37.1)

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`Not a day: ${day}`);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// days counts back from today; offset moves the whole range back (Yesterday is one day ending a day ago)
export const presets = [
  { id: 'today', label: 'Today', days: 1, offset: 0 },
  { id: 'yesterday', label: 'Yesterday', days: 1, offset: 1 },
  { id: '7', label: '7 days', days: 7, offset: 0 },
  { id: '30', label: '30 days', days: 30, offset: 0 },
  { id: '90', label: '90 days', days: 90, offset: 0 },
  { id: 'all', label: 'All', days: null, offset: 0 },
  { id: 'custom', label: 'Custom', days: null, offset: 0 },
] as const;
export type RangeId = (typeof presets)[number]['id'];

export const isRangeId = (s: string | null): s is RangeId => presets.some((p) => p.id === s);

// From and to of a range, once today and the first day are known (from the last stats response)
export function resolveRange(
  range: RangeId,
  custom: { from: string | null; to: string | null },
  bounds: { today: string; firstDay: string | null } | null,
): { from: string | null; to: string | null } {
  if (range === 'custom') return custom;
  if (bounds === null) return { from: null, to: null };
  if (range === 'all') return { from: bounds.firstDay ?? bounds.today, to: bounds.today };
  const preset = presets.find((p) => p.id === range);
  if (preset?.days == null) throw new Error(`No fixed length for range ${range}`);
  const to = addDays(bounds.today, -preset.offset);
  return { from: addDays(to, 1 - preset.days), to };
}

// "Nov 4" in the stats timezone
export function shortDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(
    new Date(ms),
  );
}

export function dateTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(ms));
}

// "Nov 4" for a yyyy-mm-dd day
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
