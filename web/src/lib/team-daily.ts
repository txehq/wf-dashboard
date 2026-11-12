import type { DayCell } from '@/lib/team-api';

// One row per day for the per-day charts (Contracts 37.4): the selected people's cells of that day added up, with the
// deletions mirrored below zero. Days with no cell stay at zero, so the time axis has no gaps
export interface DailyRow {
  day: string;
  created: number;
  completed: number;
  handled: number;
  additions: number;
  deletions: number;
  deletionsBelow: number;
}

export function dailyRows(days: string[], cells: DayCell[]): DailyRow[] {
  const rows = new Map<string, DailyRow>(
    days.map((day) => [
      day,
      { day, created: 0, completed: 0, handled: 0, additions: 0, deletions: 0, deletionsBelow: 0 },
    ]),
  );
  for (const cell of cells) {
    const row = rows.get(cell.day);
    // A cell outside the range (the server counts only the range, so this does not happen) is left out
    if (row === undefined) continue;
    row.created += cell.created;
    row.completed += cell.completed;
    row.handled += cell.handled;
    row.additions += cell.additions;
    row.deletions += cell.deletions;
  }
  for (const row of rows.values()) {
    if (row.deletions > 0) row.deletionsBelow = -row.deletions;
  }
  return [...rows.values()];
}

export const hasLines = (rows: DailyRow[]) => rows.some((r) => r.additions > 0 || r.deletions > 0);
