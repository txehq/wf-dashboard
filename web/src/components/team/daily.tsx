import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatInteger } from '@/lib/format';
import type { DayCell, PersonStats } from '@/lib/team-api';
import { dailyRows, type DailyRow, hasLines } from '@/lib/team-daily';
import { dayLabel } from '@/lib/team-days';
import { cn } from '@/lib/utils';

// Daily (Contracts 37.4): a heatmap of Handled per person and day (on a single day, the day's cell and a column per
// figure), and per-day
// charts of the selected person (or everyone in the filter). Colors: one hue for the heatmap's magnitude; Created,
// Completed, Handled take series 1-3 in that fixed order; Lines added and deleted are drawn above and below zero

export interface CellRef {
  person: string;
  day: string;
}

const counts = [
  { key: 'created', label: 'Created', color: 'var(--series-1)' },
  { key: 'completed', label: 'Completed', color: 'var(--series-2)' },
  { key: 'handled', label: 'Handled', color: 'var(--series-3)' },
] as const;

const lines = [
  { key: 'additions', label: 'Lines added', color: 'var(--series-3)' },
  { key: 'deletions', label: 'Lines deleted', color: 'var(--series-2)' },
] as const;

function cellText(c: DayCell | undefined) {
  if (c === undefined) return 'Nothing';
  return [
    `Handled ${formatInteger(c.handled)}`,
    `Created ${formatInteger(c.created)}`,
    `Completed ${formatInteger(c.completed)}`,
    `Canceled ${formatInteger(c.canceled)}`,
    `PRs merged ${formatInteger(c.prsMerged)}`,
    `Lines +${formatInteger(c.additions)} −${formatInteger(c.deletions)}`,
  ].join(' · ');
}

// Light to dark in one hue; an empty day keeps the plain surface
function heat(value: number, max: number) {
  if (value === 0 || max === 0) return 'var(--muted)';
  return `color-mix(in oklab, var(--series-1) ${String(Math.round(20 + (80 * value) / max))}%, var(--viz-surface))`;
}

// White or black text, whichever contrasts more with the background, worked out by the browser from the shade as it is
// rendered in the current theme. y in xyz-d65 is the WCAG relative luminance; at 0.179 white and black both give
// 4.58:1, so switching there keeps every shade at least that
function textOn(background: string) {
  const white = 'clamp(0, (0.179 - y) * 1000, 1)';
  return `color(from ${background} xyz-d65 calc(0.9505 * ${white}) ${white} calc(1.0888 * ${white}))`;
}

function HeatLegend({ max }: { max: number }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Handled per day: 0
      <span
        className="h-2.5 w-16 rounded-sm"
        style={{ background: `linear-gradient(to right, ${heat(1, 5)}, ${heat(5, 5)})` }}
      />
      {formatInteger(max)}
    </p>
  );
}

export function Heatmap({
  people,
  days,
  daily,
  selected,
  onSelect,
}: {
  people: PersonStats[];
  days: string[];
  daily: DayCell[];
  selected: CellRef | null;
  onSelect: (cell: CellRef | null) => void;
}) {
  const [hover, setHover] = useState<(CellRef & { x: number; y: number }) | null>(null);
  const byKey = new Map(daily.map((c) => [`${c.person}\n${c.day}`, c]));
  const max = Math.max(0, ...daily.map((c) => c.handled));
  // Labels every few days so they never collide
  const every = Math.max(1, Math.ceil(days.length / 12));
  const hovered = hover === null ? undefined : byKey.get(`${hover.person}\n${hover.day}`);
  return (
    <div className="relative flex flex-col gap-1" data-testid="heatmap">
      <div
        className="grid items-center gap-0.5"
        // A column is at most 4rem wide, so a range of a few days stays a row of cells
        style={{ gridTemplateColumns: `9rem repeat(${String(days.length)}, minmax(4px, 4rem))` }}
        onMouseLeave={() => {
          setHover(null);
        }}
      >
        {people.map((p) => (
          <div key={p.key} className="contents" role="row">
            <span className="truncate pr-2 text-xs" title={p.name}>
              {p.name}
            </span>
            {days.map((day) => {
              const c = byKey.get(`${p.key}\n${day}`);
              const isSelected = selected?.person === p.key && selected.day === day;
              return (
                <button
                  key={day}
                  type="button"
                  aria-label={`${p.name}, ${dayLabel(day)}: ${cellText(c)}`}
                  aria-pressed={isSelected}
                  data-testid={`cell-${p.key}-${day}`}
                  className={cn(
                    'h-5 rounded-[3px] outline-offset-1 hover:outline-2 hover:outline-foreground/40 focus-visible:outline-2',
                    isSelected && 'outline-2 outline-foreground',
                  )}
                  style={{ background: heat(c?.handled ?? 0, max) }}
                  onMouseEnter={(e) => {
                    const box = e.currentTarget;
                    setHover({ person: p.key, day, x: box.offsetLeft, y: box.offsetTop });
                  }}
                  onFocus={(e) => {
                    const box = e.currentTarget;
                    setHover({ person: p.key, day, x: box.offsetLeft, y: box.offsetTop });
                  }}
                  onBlur={() => {
                    setHover(null);
                  }}
                  onClick={() => {
                    onSelect(isSelected ? null : { person: p.key, day });
                  }}
                />
              );
            })}
          </div>
        ))}
        <span />
        {days.map((day, i) => (
          <span
            key={day}
            className="overflow-visible text-[10px] whitespace-nowrap text-(--viz-muted)"
            aria-hidden
          >
            {i % every === 0 ? dayLabel(day) : ''}
          </span>
        ))}
      </div>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-80 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-sm"
          style={{ left: hover.x + 8, top: hover.y + 24 }}
          data-testid="heatmap-tooltip"
        >
          <p className="mb-1 font-medium">
            {people.find((p) => p.key === hover.person)?.name} · {dayLabel(hover.day)}
          </p>
          <p className="text-muted-foreground">{cellText(hovered)}</p>
        </div>
      )}
      <HeatLegend max={max} />
    </div>
  );
}

// The figure columns of a single day: the value that shades a cell (against the column's maximum) and its text
const figures: readonly {
  key: string;
  label: string;
  value: (c: DayCell) => number;
  text: (c: DayCell | undefined, p: PersonStats) => string;
}[] = [
  {
    key: 'handled',
    label: 'Handled',
    value: (c) => c.handled,
    text: (c) => formatInteger(c?.handled ?? 0),
  },
  {
    key: 'created',
    label: 'Created',
    value: (c) => c.created,
    text: (c) => formatInteger(c?.created ?? 0),
  },
  {
    key: 'completed',
    label: 'Completed',
    value: (c) => c.completed,
    // The range is this one day, so the person's not closed count is the day's
    text: (c, p) =>
      formatInteger(c?.completed ?? 0) +
      (p.doneNotClosed > 0 ? ` · ${formatInteger(p.doneNotClosed)} not closed` : ''),
  },
  {
    key: 'canceled',
    label: 'Canceled',
    value: (c) => c.canceled,
    text: (c) => formatInteger(c?.canceled ?? 0),
  },
  {
    key: 'prs',
    label: 'PRs merged',
    value: (c) => c.prsMerged,
    text: (c) => formatInteger(c?.prsMerged ?? 0),
  },
  {
    key: 'lines',
    label: 'Lines +/−',
    value: (c) => c.additions + c.deletions,
    text: (c) => `+${formatInteger(c?.additions ?? 0)} −${formatInteger(c?.deletions ?? 0)}`,
  },
];

// One day (Contracts 37.4): the heatmap's rows of people with the day's cell first (shaded by Handled, as in the
// multi-day heatmap), then a column per figure with its number, shaded by that column's maximum. Every cell selects
// the person and day
export function DayGrid({
  people,
  day,
  daily,
  selected,
  onSelect,
}: {
  people: PersonStats[];
  day: string;
  daily: DayCell[];
  selected: CellRef | null;
  onSelect: (cell: CellRef | null) => void;
}) {
  const [hover, setHover] = useState<{ person: string; x: number; y: number } | null>(null);
  const byPerson = new Map(daily.filter((c) => c.day === day).map((c) => [c.person, c]));
  const cells = [...byPerson.values()];
  const max = Math.max(0, ...cells.map((c) => c.handled));
  const maxes = figures.map((f) => Math.max(0, ...cells.map(f.value)));
  const hovered = hover === null ? undefined : people.find((p) => p.key === hover.person);
  const show = (person: string, box: HTMLElement) => {
    setHover({ person, x: box.offsetLeft, y: box.offsetTop });
  };
  return (
    <div className="relative flex flex-col gap-1" data-testid="day-grid">
      <div
        className="grid items-center gap-0.5"
        style={{
          gridTemplateColumns: `9rem repeat(${String(figures.length + 1)}, minmax(0, 1fr))`,
        }}
        onMouseLeave={() => {
          setHover(null);
        }}
      >
        <span />
        {[dayLabel(day), ...figures.map((f) => f.label)].map((label) => (
          <span
            key={label}
            className="truncate text-[10px] whitespace-nowrap text-(--viz-muted)"
            aria-hidden
          >
            {label}
          </span>
        ))}
        {people.map((p) => {
          const c = byPerson.get(p.key);
          const isSelected = selected?.person === p.key && selected.day === day;
          const cell = (
            key: string,
            label: string,
            background: string,
            text: string,
            content: string,
          ) => (
            <button
              key={key}
              type="button"
              aria-label={`${p.name}, ${label}: ${text}`}
              aria-pressed={isSelected}
              data-testid={`cell-${p.key}-${key}`}
              className={cn(
                'h-5 truncate rounded-[3px] px-1.5 text-xs leading-5 tabular-nums outline-offset-1 hover:outline-2 hover:outline-foreground/40 focus-visible:outline-2',
                isSelected && 'outline-2 outline-foreground',
              )}
              style={{ background, color: textOn(background) }}
              onMouseEnter={(e) => {
                show(p.key, e.currentTarget);
              }}
              onFocus={(e) => {
                show(p.key, e.currentTarget);
              }}
              onBlur={() => {
                setHover(null);
              }}
              onClick={() => {
                onSelect(isSelected ? null : { person: p.key, day });
              }}
            >
              {content}
            </button>
          );
          return (
            <div key={p.key} className="contents" role="row">
              <span className="truncate pr-2 text-xs" title={p.name}>
                {p.name}
              </span>
              {cell(day, dayLabel(day), heat(c?.handled ?? 0, max), cellText(c), '')}
              {figures.map((f, i) => {
                const text = f.text(c, p);
                return cell(
                  f.key,
                  f.label,
                  heat(c === undefined ? 0 : f.value(c), maxes[i] ?? 0),
                  text,
                  text,
                );
              })}
            </div>
          );
        })}
      </div>
      {hover !== null && hovered !== undefined && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-80 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-sm"
          style={{ left: hover.x + 8, top: hover.y + 24 }}
          data-testid="heatmap-tooltip"
        >
          <p className="mb-1 font-medium">
            {hovered.name} · {dayLabel(day)}
          </p>
          <p className="text-muted-foreground">{cellText(byPerson.get(hover.person))}</p>
        </div>
      )}
      <HeatLegend max={max} />
    </div>
  );
}

function Legend({ items }: { items: readonly { key: string; label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

const axisTick = { fill: 'var(--viz-muted)', fontSize: 11 };

// 12K, 1.2M: axis ticks stay narrow
const compact = (n: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function ChartTooltip({
  active,
  label,
  rows,
  items,
}: {
  active: boolean | undefined;
  label: string | number | undefined;
  rows: DailyRow[];
  items: readonly { key: keyof DailyRow; label: string; color: string }[];
}) {
  if (active !== true || label === undefined) return null;
  const row = rows.find((r) => r.day === label);
  if (row === undefined) return null;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{dayLabel(String(label))}</p>
      {items.map((s) => (
        <p key={s.key} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          <span className="font-semibold tabular-nums">{formatInteger(Number(row[s.key]))}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </p>
      ))}
    </div>
  );
}

export function DailyCharts({ days, daily }: { days: string[]; daily: DayCell[] }) {
  const rows = dailyRows(days, daily);
  const xAxis = (
    <XAxis
      dataKey="day"
      tickLine={false}
      axisLine={{ stroke: 'var(--viz-axis)' }}
      tick={axisTick}
      tickFormatter={(d: string) => dayLabel(d)}
      minTickGap={24}
    />
  );
  return (
    <div className="flex flex-col gap-4" data-testid="daily-charts">
      <div className="flex flex-col gap-1">
        <Legend items={counts} />
        <div className="h-48" data-testid="counts-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              syncId="team-daily"
              barGap={2}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              {xAxis}
              <YAxis
                tickLine={false}
                axisLine={false}
                width={40}
                tick={axisTick}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
                content={({ active, label }) => (
                  <ChartTooltip active={active} label={label} rows={rows} items={counts} />
                )}
              />
              {counts.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={s.color}
                  maxBarSize={12}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Legend items={lines} />
        {hasLines(rows) ? (
          <div className="h-36" data-testid="lines-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                syncId="team-daily"
                stackOffset="sign"
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                {xAxis}
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={axisTick}
                  tickFormatter={(v: number) => compact(Math.abs(v))}
                />
                <ReferenceLine y={0} stroke="var(--viz-axis)" />
                <Tooltip
                  cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
                  content={({ active, label }) => (
                    <ChartTooltip active={active} label={label} rows={rows} items={lines} />
                  )}
                />
                <Bar
                  dataKey="additions"
                  stackId="lines"
                  fill={lines[0].color}
                  maxBarSize={16}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="deletionsBelow"
                  stackId="lines"
                  fill={lines[1].color}
                  maxBarSize={16}
                  radius={[0, 0, 4, 4]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="lines-empty">
            No PR merged in these days.
          </p>
        )}
      </div>
    </div>
  );
}
