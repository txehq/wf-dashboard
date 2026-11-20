import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { PrsMerged } from '@/components/team/prs-merged';
import { MeanMedian, StatTiles } from '@/components/team/stat-tiles';
import { formatInteger } from '@/lib/format';
import type { CloseTimes, PersonStats } from '@/lib/team-api';
import { duration, spreadTitle } from '@/lib/team-durations';
import { linkedAuthored, measureTitle } from '@/lib/team-prs';
import { type Scale, scale as scaleOf } from '@/lib/team-scale';
import { cn } from '@/lib/utils';

// total gives a column's number before Total | Per day; Open in progress is a count of now and Time to complete a
// duration, neither ever divided. null sorts last
const columns = [
  { id: 'name', label: 'Person', total: (p: PersonStats) => p.name },
  { id: 'handled', label: 'Handled', total: (p: PersonStats) => p.handled },
  { id: 'created', label: 'Created', total: (p: PersonStats) => p.created },
  { id: 'completed', label: 'Completed', total: (p: PersonStats) => p.completed },
  {
    id: 'timeToComplete',
    label: 'Time to complete',
    total: (p: PersonStats) => p.timeToComplete.started?.median ?? null,
  },
  { id: 'canceled', label: 'Canceled', total: (p: PersonStats) => p.canceled },
  { id: 'openInProgress', label: 'In progress now', total: (p: PersonStats) => p.openInProgress },
  { id: 'prsMerged', label: 'PRs merged', total: (p: PersonStats) => p.prsMerged },
  { id: 'commits', label: 'Commits', total: (p: PersonStats) => p.commits },
  { id: 'lines', label: 'Lines +/−', total: (p: PersonStats) => p.additions + p.deletions },
] as const;
type ColumnId = (typeof columns)[number]['id'];

const TIME_TO_COMPLETE =
  'Median time from first starting to completing, over the issues completed in the range. Never divided by days';

const titles: Partial<Record<ColumnId, string>> = {
  handled: 'Issue-days: each day an assigned issue was in a started state or completed',
  completed:
    'Completed in Linear, plus issues whose PRs merged while the issue is still open (done but not closed)',
  timeToComplete: TIME_TO_COMPLETE,
  openInProgress: 'Started now, not counting issues done but not closed. Never divided by days',
  prsMerged: measureTitle.prs,
  commits: measureTitle.commits,
};

function TimeToComplete({ p }: { p: PersonStats }) {
  const { started, created } = p.timeToComplete;
  const title = [
    spreadTitle('Started → completed', started, 'issue'),
    created === null
      ? null
      : `Created → completed: median ${duration(created.median)}, average ${duration(created.mean)}`,
  ]
    .filter((t) => t !== null)
    .join('\n');
  return (
    <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums" title={title}>
      {started === null ? '—' : duration(started.median)}
    </td>
  );
}

// The People table's Total | Per day switch (Contracts 37.4), next to the section title
export function PerDaySwitch({
  perDay,
  onChange,
}: {
  perDay: boolean;
  onChange: (perDay: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Total or per day"
      className="inline-flex overflow-hidden rounded-md border text-xs"
      data-testid="people-per-day"
    >
      {(
        [
          [false, 'Total'],
          [true, 'Per day'],
        ] as const
      ).map(([value, label]) => (
        <button
          key={label}
          type="button"
          aria-pressed={perDay === value}
          className="px-2.5 py-1 hover:bg-muted aria-pressed:bg-foreground aria-pressed:text-background"
          onClick={() => {
            onChange(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// The closed issues of the range above the People table (Contracts 37.7), for the people in the filter
export function CloseTimesSummary({ times }: { times: CloseTimes }) {
  return (
    <StatTiles
      className="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
      testId="close-times"
      tiles={[
        {
          key: 'completed',
          label: 'Completed',
          value: formatInteger(times.completed),
          title: 'Issues completed in the range, done but not closed included, on their assignee',
        },
        {
          key: 'started',
          label: 'Started → completed',
          value: <MeanMedian s={times.started} />,
          title: spreadTitle(
            'From first entering a started state to completion, for the issues completed in the range. Issues never started are not counted',
            times.started,
            'issue',
          ),
        },
        {
          key: 'created',
          label: 'Created → completed',
          value: <MeanMedian s={times.created} />,
          title: spreadTitle(
            'From creation to completion, for the issues completed in the range',
            times.created,
            'issue',
          ),
        },
        {
          key: 'canceled',
          label: 'Canceled',
          value: formatInteger(times.canceled),
          title: 'Issues canceled in the range, on their assignee',
        },
        {
          key: 'createdToCanceled',
          label: 'Created → canceled',
          value: <MeanMedian s={times.createdToCanceled} />,
          title: spreadTitle(
            'From creation to cancellation, for the issues canceled in the range',
            times.createdToCanceled,
            'issue',
          ),
        },
      ]}
    />
  );
}

function Num({ n, scale }: { n: number; scale: Scale }) {
  return <span title={scale.title(n) || undefined}>{scale.format(n)}</span>;
}

// People table (Contracts 37.4): one row per person, sortable by any column by the number shown; a click filters the
// page to that person. With perDay every cumulative number is divided by the range's days
export function PeopleTable({
  people,
  days,
  perDay,
  selected,
  onSelect,
}: {
  people: PersonStats[];
  // Calendar days of the range
  days: number;
  perDay: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [sort, setSort] = useState<{ id: ColumnId; desc: boolean }>({ id: 'handled', desc: true });
  const scale = scaleOf(days, perDay);
  const column = columns.find((c) => c.id === sort.id) ?? columns[1];
  const value = (p: PersonStats) => {
    const total = column.total(p);
    return total === null ||
      typeof total === 'string' ||
      column.id === 'openInProgress' ||
      column.id === 'timeToComplete'
      ? total
      : column.id === 'lines'
        ? scale.value(p.additions) + scale.value(p.deletions)
        : scale.value(total);
  };
  const rows = [...people].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // People without the value go last either way
    if (x === null || y === null)
      return x === y ? a.name.localeCompare(b.name) : x === null ? 1 : -1;
    const order =
      typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y);
    return (sort.desc ? -order : order) || a.name.localeCompare(b.name);
  });
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="people-table">
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                aria-sort={sort.id === c.id ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                className={cn(
                  'px-3 py-2 font-medium',
                  c.id === 'name' ? 'text-left' : 'text-right',
                )}
              >
                <button
                  type="button"
                  title={titles[c.id]}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  data-testid={`sort-${c.id}`}
                  onClick={() => {
                    setSort(
                      sort.id === c.id
                        ? { id: c.id, desc: !sort.desc }
                        : { id: c.id, desc: c.id !== 'name' },
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
              key={p.key}
              aria-selected={selected === p.key}
              data-testid={`person-${p.key}`}
              className={cn(
                'cursor-pointer border-b last:border-0 hover:bg-muted/50',
                selected === p.key && 'bg-secondary',
              )}
              onClick={() => {
                onSelect(selected === p.key ? null : p.key);
              }}
            >
              <td className="px-3 py-1.5 font-medium">{p.name}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                <Num n={p.handled} scale={scale} />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                <Num n={p.created} scale={scale} />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                <Num n={p.completed} scale={scale} />
                {p.doneNotClosed > 0 && (
                  <span
                    className="ml-1.5 rounded bg-warning px-1 text-xs text-warning-foreground"
                    title={['Done but not closed', scale.title(p.doneNotClosed)]
                      .filter((t) => t !== '')
                      .join('. ')}
                  >
                    {scale.format(p.doneNotClosed)} not closed
                  </span>
                )}
              </td>
              <TimeToComplete p={p} />
              <td className="px-3 py-1.5 text-right tabular-nums">
                <Num n={p.canceled} scale={scale} />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatInteger(p.openInProgress)}
              </td>
              <td className="px-3 py-1.5 text-right">
                <PrsMerged
                  measure="prs"
                  counts={linkedAuthored('prs', p)}
                  person={p}
                  scale={scale}
                />
              </td>
              <td className="px-3 py-1.5 text-right">
                <PrsMerged
                  measure="commits"
                  counts={linkedAuthored('commits', p)}
                  person={p}
                  scale={scale}
                />
              </td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                <span
                  className="text-(--viz-status-good-text)"
                  title={scale.title(p.additions) || undefined}
                >
                  +{scale.format(p.additions)}
                </span>{' '}
                <span className="text-destructive" title={scale.title(p.deletions) || undefined}>
                  −{scale.format(p.deletions)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
