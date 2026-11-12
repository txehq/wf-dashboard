import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { formatInteger } from '@/lib/format';
import type { PersonStats } from '@/lib/team-api';
import { cn } from '@/lib/utils';

const columns = [
  { id: 'name', label: 'Person', value: (p: PersonStats) => p.name },
  { id: 'handled', label: 'Handled', value: (p: PersonStats) => p.handled },
  { id: 'created', label: 'Created', value: (p: PersonStats) => p.created },
  { id: 'completed', label: 'Completed', value: (p: PersonStats) => p.completed },
  { id: 'canceled', label: 'Canceled', value: (p: PersonStats) => p.canceled },
  { id: 'openInProgress', label: 'In progress now', value: (p: PersonStats) => p.openInProgress },
  { id: 'prsMerged', label: 'PRs merged', value: (p: PersonStats) => p.prsMerged },
  { id: 'lines', label: 'Lines +/−', value: (p: PersonStats) => p.additions + p.deletions },
] as const;
type ColumnId = (typeof columns)[number]['id'];

const titles: Partial<Record<ColumnId, string>> = {
  handled:
    'Issue-days: each day an assigned issue was in a started state or completed. Per day is the average over the range',
  completed:
    'Completed in Linear, plus issues whose PRs merged while the issue is still open (done but not closed)',
  openInProgress: 'Started now, not counting issues done but not closed',
  prsMerged: 'Counted on the day each PR merged, for the assignee of its issue',
};

// People table (Contracts 37.4): one row per person, sortable by any column; a click filters the page to that person
export function PeopleTable({
  people,
  perDay,
  selected,
  onSelect,
}: {
  people: PersonStats[];
  // Handled per day next to Handled; off for a one-day range, where the two are the same number
  perDay: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [sort, setSort] = useState<{ id: ColumnId; desc: boolean }>({ id: 'handled', desc: true });
  const column = columns.find((c) => c.id === sort.id) ?? columns[1];
  const rows = [...people].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
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
                {formatInteger(p.handled)}
                {perDay && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {p.handledPerDay.toFixed(1)}/day
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatInteger(p.created)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatInteger(p.completed)}
                {p.doneNotClosed > 0 && (
                  <span
                    className="ml-1.5 rounded bg-warning px-1 text-xs text-warning-foreground"
                    title="Done but not closed"
                  >
                    {formatInteger(p.doneNotClosed)} not closed
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatInteger(p.canceled)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatInteger(p.openInProgress)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatInteger(p.prsMerged)}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                <span className="text-(--viz-status-good-text)">+{formatInteger(p.additions)}</span>{' '}
                <span className="text-destructive">−{formatInteger(p.deletions)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
