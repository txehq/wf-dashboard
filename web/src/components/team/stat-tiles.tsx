import type { ReactNode } from 'react';
import { duration } from '@/lib/team-durations';
import type { Spread } from '@/lib/team-api';
import { cn } from '@/lib/utils';

// A row of summary numbers over the selected range (Contracts 37.6, 37.7); each tile's hover says what it measures

export interface Tile {
  key: string;
  label: string;
  value: ReactNode;
  title: string;
}

// The muted words beside a tile's bold number
export function TileNote({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}

// The value of a duration tile on two lines: avg 3h 10m, then median 1h 32m
export function MeanMedian({ s }: { s: Spread }) {
  if (s === null) return <>—</>;
  return (
    <span className="flex flex-col">
      <span>
        <TileNote>avg</TileNote> {duration(s.mean)}
      </span>
      <span>
        <TileNote>median</TileNote> {duration(s.median)}
      </span>
    </span>
  );
}

export function StatTiles({
  tiles,
  className,
  testId,
}: {
  tiles: Tile[];
  // The grid's columns
  className: string;
  testId: string;
}) {
  // Grid items stretch, so the tiles of one row keep the height of the tallest
  return (
    <div className={cn('grid gap-3', className)} data-testid={testId}>
      {tiles.map((t) => (
        <div
          key={t.key}
          className="flex flex-col gap-1 rounded-lg border px-4 py-3"
          title={t.title}
        >
          <p className="text-xs text-muted-foreground">{t.label}</p>
          <div className="text-sm font-semibold tabular-nums">{t.value}</div>
        </div>
      ))}
    </div>
  );
}
