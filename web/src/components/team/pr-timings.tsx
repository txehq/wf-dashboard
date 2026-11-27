import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  Line,
  LineChart,
  type MouseHandlerDataParam,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Pager } from '@/components/pager';
import { ChartLegend } from '@/components/team/chart-legend';
import { type CellRef, DayGrid, type GridRow } from '@/components/team/daily';
import { PAGE_SIZE } from '@/components/team/issue-lists';
import { Section } from '@/components/team/section';
import { MeanMedian, StatTiles, TileNote } from '@/components/team/stat-tiles';
import { Button } from '@/components/ui/button';
import { formatInteger, formatNoun } from '@/lib/format';
import {
  type PrTimingDay,
  type PrTimingRow,
  type StatsQuery,
  teamPrsQuery,
  type TeamPrTimings,
  teamSyncQuery,
} from '@/lib/team-api';
import { axisTick, chartMargin, Y_AXIS_WIDTH } from '@/lib/team-chart';
import { dateTime, dayLabel } from '@/lib/team-days';
import { duration, HOUR, spreadTitle } from '@/lib/team-durations';
import { cn } from '@/lib/utils';

// txe PRs (Contracts 37.6): the numbers over the range, the PRs merged per day (slow CI the darker part) with the daily
// medians of the three durations (for a one-day range, a grid of the day's authors instead), and the PRs of a clicked
// day, cell or of the range. The count and the durations have
// different scales, so they are two charts on one shared day axis (dataviz: never two y-scales); hovering one shows
// the day in both

// CI from this long is slow (SLOW_CI_MS on the server)
const SLOW_CI = '25m';

// A duration in the PR list; null when GitHub's recorded times are reversed, a dash with both times in the hover
function DurationCell({
  value,
  title,
  reversed,
  className,
}: {
  value: number | null;
  title: string;
  reversed: string;
  className?: string;
}) {
  return (
    <td
      className={cn('px-3 py-1.5 text-right whitespace-nowrap tabular-nums', className)}
      title={value === null ? `${reversed}. Left out of the averages and medians` : title}
    >
      {value === null ? '—' : duration(value)}
    </td>
  );
}

const measures = [
  {
    key: 'openToMerge',
    label: 'Open → merge',
    color: 'var(--series-1)',
    title:
      'From opening the PR (as a draft too) to its merge. PRs GitHub records as opened after their merge are not counted',
  },
  {
    key: 'readyToMerge',
    label: 'Ready → merge',
    color: 'var(--series-2)',
    title:
      'From the last time the PR was marked ready for review to its merge; the same as open → merge for a PR that never was a draft. PRs whose recorded times are reversed are not counted',
  },
  {
    key: 'ci',
    label: 'CI',
    color: 'var(--series-3)',
    title:
      'GitHub Actions on the PR’s last commit: from the first run’s start to the last run’s end, re-runs included. Runs started after the merge are left out; PRs without runs, with a run still going, or with reversed recorded times are not counted',
  },
] as const;
type MeasureKey = (typeof measures)[number]['key'];

const COUNT_COLOR = 'var(--series-4)';
const SLOW_COLOR = 'var(--viz-slow-ci)';

const countLegend = [
  { key: 'slow', label: `Slow CI (${SLOW_CI}+)`, color: SLOW_COLOR },
  { key: 'other', label: 'Other PRs merged', color: COUNT_COLOR },
];
const durationLegend = measures.map((m) => ({ ...m, label: `${m.label} median` }));

const share = (part: number, whole: number) =>
  whole === 0 ? '' : `${String(Math.round((100 * part) / whole))}%`;

function Summary({ data }: { data: TeamPrTimings }) {
  const { prs, slowCi } = data.summary;
  return (
    <StatTiles
      className="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
      testId="prs-summary"
      tiles={[
        {
          key: 'prs',
          label: 'PRs merged',
          value: formatInteger(prs),
          title: `PRs of ${data.repo} merged in the range, on the day they merged (${data.timezone})`,
        },
        {
          key: 'slowCi',
          label: `Slow CI (${SLOW_CI}+)`,
          value: (
            <>
              {formatInteger(slowCi)}
              {prs > 0 && <TileNote> · {share(slowCi, prs)} of PRs</TileNote>}
            </>
          ),
          title: `PRs whose CI took ${SLOW_CI} or longer: ${formatInteger(slowCi)} of ${formatNoun(prs, 'PR')}`,
        },
        ...measures.map((m) => ({
          key: m.key,
          label: m.label,
          value: <MeanMedian s={data.summary[m.key]} />,
          title: spreadTitle(m.title, data.summary[m.key], 'PR'),
        })),
      ]}
    />
  );
}

// The y ticks of the duration chart in whole hours once the medians pass two hours
const hourTick = (ms: number) =>
  ms === 0 ? '0' : ms >= 2 * HOUR ? `${String(Math.round(ms / HOUR))}h` : duration(ms);

function DayTooltip({
  active,
  label,
  days,
}: {
  active: boolean | undefined;
  label: string | number | undefined;
  days: Map<string, PrTimingDay>;
}) {
  if (active !== true || label === undefined) return null;
  const d = days.get(String(label));
  if (d === undefined) return null;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">
        {dayLabel(d.day)} · {formatNoun(d.prs, 'PR')}
      </p>
      <p className="mb-1 flex items-center gap-2">
        <span className="size-2.5 rounded-sm" style={{ background: SLOW_COLOR }} />
        <span className="text-muted-foreground">Slow CI ({SLOW_CI}+)</span>
        <span className="ml-auto pl-3 tabular-nums">
          {formatInteger(d.slowCi)}
          {d.prs > 0 && ` · ${share(d.slowCi, d.prs)}`}
        </span>
      </p>
      {measures.map((m) => {
        const s = d[m.key];
        return (
          <p key={m.key} className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full" style={{ background: m.color }} />
            <span className="text-muted-foreground">{m.label}</span>
            <span className="ml-auto pl-3 tabular-nums">
              {s === null
                ? '—'
                : `avg ${duration(s.mean)} · median ${duration(s.median)} · P90 ${duration(s.p90)}`}
            </span>
          </p>
        );
      })}
    </div>
  );
}

// Chart rows: the day's PRs without and with slow CI, and its medians, null where no PR has the duration (the line
// breaks there)
type ChartRow = { day: string; other: number; slow: number } & Record<MeasureKey, number | null>;

// The 2px surface gap between a day's two bar segments (dataviz): the upper one gives up its lowest 2px
const GAP = 2;

function DailyPrCharts({
  data,
  selected,
  onSelect,
}: {
  data: TeamPrTimings;
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const days = new Map(data.daily.map((d) => [d.day, d]));
  const rows: ChartRow[] = data.daily.map((d) => ({
    day: d.day,
    other: d.prs - d.slowCi,
    slow: d.slowCi,
    openToMerge: d.openToMerge?.median ?? null,
    readyToMerge: d.readyToMerge?.median ?? null,
    ci: d.ci?.median ?? null,
  }));
  // Days other than the clicked one fade
  const opacity = (row: ChartRow) => (selected !== null && row.day !== selected ? 0.35 : 1);
  const click = (state: MouseHandlerDataParam) => {
    const day = state.activeLabel;
    if (day === undefined) return;
    onSelect(String(day) === selected ? null : String(day));
  };
  // A band scale in both charts, so a day's line point sits over its bar
  const xAxis = (
    <XAxis
      dataKey="day"
      scale="band"
      tickLine={false}
      axisLine={{ stroke: 'var(--viz-axis)' }}
      tick={axisTick}
      tickFormatter={(d: string) => dayLabel(d)}
      minTickGap={24}
    />
  );
  const tooltip = (
    <Tooltip
      cursor={{ fill: 'var(--muted)', opacity: 0.6, stroke: 'var(--viz-axis)' }}
      content={({ active, label }) => <DayTooltip active={active} label={label} days={days} />}
    />
  );
  return (
    <Section
      title="Daily"
      testId="prs-daily"
      action={<span className="text-sm text-muted-foreground">Click a day for its PRs.</span>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <ChartLegend items={countLegend} />
          <div className="h-32 cursor-pointer" data-testid="prs-count-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} syncId="team-prs" margin={chartMargin} onClick={click}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                {xAxis}
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={Y_AXIS_WIDTH}
                  tick={axisTick}
                  allowDecimals={false}
                />
                {tooltip}
                {/* Slow CI at the baseline; the day's other PRs above it, rounded at the top end */}
                <Bar
                  dataKey="slow"
                  name="Slow CI"
                  stackId="prs"
                  maxBarSize={16}
                  isAnimationActive={false}
                  fill={SLOW_COLOR}
                  shape={(props: BarShapeProps) => {
                    const row = props.payload as ChartRow;
                    return (
                      <Rectangle
                        {...props}
                        radius={row.other === 0 ? [4, 4, 0, 0] : 0}
                        fillOpacity={opacity(row)}
                      />
                    );
                  }}
                />
                <Bar
                  dataKey="other"
                  name="Other PRs"
                  stackId="prs"
                  maxBarSize={16}
                  isAnimationActive={false}
                  fill={COUNT_COLOR}
                  shape={(props: BarShapeProps) => {
                    const row = props.payload as ChartRow;
                    const height = row.slow > 0 ? Math.max(0, props.height - GAP) : props.height;
                    return (
                      <Rectangle
                        {...props}
                        height={height}
                        radius={[4, 4, 0, 0]}
                        fillOpacity={opacity(row)}
                      />
                    );
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <ChartLegend items={durationLegend} mark="line" />
          <div className="h-56 cursor-pointer" data-testid="prs-duration-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} syncId="team-prs" margin={chartMargin} onClick={click}>
                <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
                {xAxis}
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={Y_AXIS_WIDTH}
                  tick={axisTick}
                  tickFormatter={hourTick}
                />
                {tooltip}
                {measures.map((m) => (
                  <Line
                    key={m.key}
                    dataKey={m.key}
                    name={m.label}
                    stroke={m.color}
                    strokeWidth={2}
                    dot={rows.length <= 31 ? { r: 2.5, fill: m.color, strokeWidth: 0 } : false}
                    activeDot={{ r: 4, stroke: 'var(--viz-surface)', strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </Section>
  );
}

// A one-day range (37.6): the day's PRs by author in the Linear view's day grid; the day's cell shaded by the PRs
// merged, the durations by the author's median
const gridColumns = [
  { key: 'prs', label: 'PRs merged' },
  { key: 'slowCi', label: `Slow CI (${SLOW_CI}+)` },
  ...measures.map((m) => ({ key: m.key, label: m.label })),
];

function PrDayGrid({
  data,
  day,
  selected,
  onSelect,
}: {
  data: TeamPrTimings;
  day: string;
  selected: CellRef | null;
  onSelect: (cell: CellRef | null) => void;
}) {
  const rows = data.people.map((a): GridRow => {
    const all = [
      `PRs merged ${formatInteger(a.prs)}`,
      `Slow CI ${formatInteger(a.slowCi)}`,
      ...measures.map((m) => {
        const s = a[m.key];
        return `${m.label} ${s === null ? '—' : `median ${duration(s.median)}`}`;
      }),
    ].join(' · ');
    return {
      key: a.key,
      name: a.name,
      summary: { value: a.prs, text: '', hover: all },
      cells: [
        { value: a.prs, text: formatInteger(a.prs), hover: all },
        { value: a.slowCi, text: formatInteger(a.slowCi), hover: all },
        ...measures.map((m) => {
          const s = a[m.key];
          return {
            value: s?.median ?? 0,
            text: s === null ? '—' : duration(s.median),
            hover: spreadTitle(m.label, s, 'PR'),
          };
        }),
      ],
    };
  });
  return (
    <Section
      title="Daily"
      testId="prs-daily"
      action={<span className="text-sm text-muted-foreground">Click a cell for its PRs.</span>}
    >
      <DayGrid
        day={day}
        columns={gridColumns}
        rows={rows}
        legend="PRs merged"
        selected={selected}
        onSelect={onSelect}
      />
    </Section>
  );
}

const columns = [
  { id: 'number', label: 'PR', value: (p: PrTimingRow) => p.number },
  { id: 'author', label: 'Author', value: (p: PrTimingRow) => p.person ?? p.author ?? '' },
  { id: 'mergedAt', label: 'Merged', value: (p: PrTimingRow) => p.mergedAt },
  { id: 'openToMerge', label: 'Open → merge', value: (p: PrTimingRow) => p.openToMerge },
  { id: 'readyToMerge', label: 'Ready → merge', value: (p: PrTimingRow) => p.readyToMerge },
  { id: 'ci', label: 'CI', value: (p: PrTimingRow) => p.ci },
  { id: 'ciRuns', label: 'Runs', value: (p: PrTimingRow) => p.ciRuns },
] as const;
type ColumnId = (typeof columns)[number]['id'];

const columnTitles: Partial<Record<ColumnId, string>> = {
  openToMerge: measures[0].title,
  readyToMerge: measures[1].title,
  ci: measures[2].title,
  ciRuns:
    'Workflow runs on the last commit, started before the merge, and whether each workflow passed in the end',
};

interface Sort {
  id: ColumnId;
  desc: boolean;
}

function sortPrs(prs: PrTimingRow[], sort: Sort) {
  const column = columns.find((c) => c.id === sort.id) ?? columns[3];
  return [...prs].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    // PRs without the value go last either way
    if (x === null || y === null) return x === y ? b.number - a.number : x === null ? 1 : -1;
    const order =
      typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y);
    return (sort.desc ? -order : order) || b.number - a.number;
  });
}

function PrTable({
  rows,
  sort,
  onSort,
  timeZone,
}: {
  // One page, already sorted
  rows: PrTimingRow[];
  sort: Sort;
  onSort: (sort: Sort) => void;
  timeZone: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="prs-table">
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                aria-sort={sort.id === c.id ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                className={cn(
                  'px-3 py-2 font-medium whitespace-nowrap',
                  c.id === 'number' || c.id === 'author' ? 'text-left' : 'text-right',
                )}
              >
                <button
                  type="button"
                  title={columnTitles[c.id]}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => {
                    onSort(
                      sort.id === c.id
                        ? { id: c.id, desc: !sort.desc }
                        : { id: c.id, desc: c.id !== 'author' },
                    );
                  }}
                >
                  {c.label}
                  {sort.id === c.id &&
                    (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr
              key={p.url}
              className={cn(
                'border-b last:border-0',
                p.slowCi ? 'bg-(--slow-ci-row)' : 'hover:bg-muted/50',
              )}
            >
              <td className="max-w-[36rem] px-3 py-1.5">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 gap-2 hover:underline"
                  title={p.title}
                >
                  <span className="shrink-0 tabular-nums text-muted-foreground">#{p.number}</span>
                  <span className="truncate">{p.title}</span>
                </a>
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap" title={p.author ?? 'Deleted account'}>
                {p.person ?? p.author ?? '—'}
              </td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                {dateTime(p.mergedAt, timeZone)}
              </td>
              <DurationCell
                value={p.openToMerge}
                title={`Opened ${dateTime(p.createdAt, timeZone)}`}
                reversed={`GitHub records the PR opened ${dateTime(p.createdAt, timeZone)}, after its merge ${dateTime(p.mergedAt, timeZone)}`}
              />
              <DurationCell
                value={p.readyToMerge}
                title={
                  p.readyAt === null
                    ? 'Never a draft'
                    : `Last marked ready ${dateTime(p.readyAt, timeZone)}`
                }
                reversed={`GitHub records the PR ${p.readyAt === null ? 'opened' : 'last marked ready'} ${dateTime(p.readyAt ?? p.createdAt, timeZone)}, after its merge ${dateTime(p.mergedAt, timeZone)}`}
              />
              {p.ciStartedAt !== null && p.ciEndedAt !== null ? (
                <DurationCell
                  value={p.ci}
                  className={cn(p.slowCi && 'bg-(--slow-ci-cell) font-medium')}
                  title={[
                    `${dateTime(p.ciStartedAt, timeZone)} – ${dateTime(p.ciEndedAt, timeZone)}`,
                    p.slowCi && `Slow CI (${SLOW_CI}+)`,
                    p.slowest !== null &&
                      `Slowest workflow: ${p.slowest.workflow}, ${duration(p.slowest.duration)}, ended ${p.slowest.afterMerge ? 'after' : 'before'} the merge`,
                  ]
                    .filter((t) => t !== false)
                    .join('\n')}
                  reversed={`GitHub records the first run starting ${dateTime(p.ciStartedAt, timeZone)}, after the last run ended ${dateTime(p.ciEndedAt, timeZone)}`}
                />
              ) : (
                <td className="px-3 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                  {p.ciRunning ? 'running' : 'no runs'}
                </td>
              )}
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                <span className="inline-flex items-center gap-1">
                  {formatInteger(p.ciRuns)}
                  {p.ciAllSucceeded === true && (
                    <Check
                      className="size-3.5 text-(--viz-status-good-text)"
                      aria-label="All passed"
                    >
                      <title>Every workflow passed in the end</title>
                    </Check>
                  )}
                  {p.ciAllSucceeded === false && (
                    <X className="size-3.5 text-destructive" aria-label="Not all passed">
                      <title>A workflow did not pass in the end</title>
                    </X>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The PR list, paged like the Issues list; a new sort, selection, range or People filter starts again at page 1
function PrList({
  prs,
  error,
  query,
  selection,
  scope,
  onClear,
  timeZone,
}: {
  // undefined while the clicked day's PRs load
  prs: PrTimingRow[] | undefined;
  error: Error | null;
  query: StatsQuery;
  // The clicked day or cell; null for the range
  selection: CellRef | { day: string } | null;
  scope: string;
  onClear: () => void;
  timeZone: string;
}) {
  const [sort, setSort] = useState<Sort>({ id: 'openToMerge', desc: true });
  const [page, setPage] = useState(1);
  const key = JSON.stringify({ query, selection, sort });
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setPage(1);
  }
  const total = prs?.length ?? 0;
  return (
    <Section
      testId="prs-list"
      title={`PRs · ${scope}`}
      action={
        <>
          {selection !== null && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              <X />
              Clear
            </Button>
          )}
          <span className="ml-auto">
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              unit={total === 1 ? 'PR' : 'PRs'}
              label="PR pages"
              onPage={setPage}
              testId="prs-pager"
            />
          </span>
        </>
      }
    >
      {error !== null && <p className="text-sm text-destructive">{error.message}</p>}
      {prs === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : prs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No PR merged on this day.</p>
      ) : (
        <PrTable
          rows={sortPrs(prs, sort).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
          sort={sort}
          onSort={setSort}
          timeZone={timeZone}
        />
      )}
    </Section>
  );
}

// While the sync is still reading the range's PRs (newest first): instead of the numbers when none is in yet, else
// under them
function Fetching({ data }: { data: TeamPrTimings }) {
  const text =
    data.summary.prs === 0
      ? `Fetching ${data.repo} PRs, newest first…`
      : data.fetchedFrom === null
        ? `Fetching older ${data.repo} PRs…`
        : `Fetching older ${data.repo} PRs: those merged before ${dateTime(data.fetchedFrom, data.timezone)} are not in yet…`;
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
      data-testid="prs-fetching"
    >
      <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
      {text}
    </p>
  );
}

// The txe PRs view: day is the clicked day, and person the author of a clicked cell of the one-day grid (both in the
// address); scope names the people and the range or day
export function PrTimings({
  query,
  scope,
  day,
  person,
  onSelect,
}: {
  query: StatsQuery;
  scope: string;
  day: string | null;
  person: string | null;
  onSelect: (selection: { day: string; person: string | null } | null) => void;
}) {
  // The range's summary and chart come with every answer; a clicked day only narrows the list
  const range = useQuery(teamPrsQuery({ ...query, day: null }));
  const list = useQuery({ ...teamPrsQuery({ ...query, day }), enabled: day !== null });
  const sync = useQuery(teamSyncQuery);
  const data = range.data;
  if (range.isError) return <p className="text-sm text-destructive">{range.error.message}</p>;
  if (data === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const cell = day !== null && person !== null ? { person, day } : null;
  const dayPrs = day === null ? data.prs : list.data?.prs;
  const author = data.people.find((a) => a.key === person);
  const fetching = sync.data?.latest?.status === 'running' && !data.fetched;
  if (fetching && data.summary.prs === 0) {
    return (
      <div className="flex flex-col gap-6" data-testid="prs-view">
        <Fetching data={data} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="prs-view">
      <Summary data={data} />
      {fetching && <Fetching data={data} />}
      {data.summary.prs === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {data.repo} PR merged in this range
          {data.fetched ? '.' : ' yet. The next sync reads them.'}
        </p>
      ) : (
        <>
          {data.days.length === 1 && data.days[0] !== undefined ? (
            <PrDayGrid data={data} day={data.days[0]} selected={cell} onSelect={onSelect} />
          ) : (
            <DailyPrCharts
              data={data}
              selected={day}
              onSelect={(d) => {
                onSelect(d === null ? null : { day: d, person: null });
              }}
            />
          )}
          <PrList
            prs={cell === null ? dayPrs : dayPrs?.filter((p) => p.authorKey === cell.person)}
            error={list.error}
            query={query}
            selection={cell ?? (day === null ? null : { day })}
            scope={
              cell === null || author === undefined
                ? scope
                : `${author.name} · ${dayLabel(cell.day)}`
            }
            onClear={() => {
              onSelect(null);
            }}
            timeZone={data.timezone}
          />
        </>
      )}
    </div>
  );
}
