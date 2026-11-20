import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatInteger } from '@/lib/format';
import { type Person, startTeamSync, teamSyncQuery, type TeamSyncView } from '@/lib/team-api';
import { presets, type RangeId } from '@/lib/team-days';
import { cn } from '@/lib/utils';

export type TeamView = 'linear' | 'prs';

// Linear | txe PRs (Contracts 37.6), next to the range picker
export function ViewSwitch({
  view,
  onChange,
}: {
  view: TeamView;
  onChange: (view: TeamView) => void;
}) {
  return (
    <div role="radiogroup" aria-label="View" className="inline-flex rounded-md border p-0.5">
      {(
        [
          ['linear', 'Linear'],
          ['prs', 'txe PRs'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={view === id}
          data-testid={`view-${id}`}
          className={cn(
            'rounded px-2.5 py-1 text-sm whitespace-nowrap text-muted-foreground',
            view === id && 'bg-secondary font-medium text-foreground',
          )}
          onClick={() => {
            onChange(id);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function RangePicker({
  range,
  from,
  to,
  onRange,
  onCustom,
}: {
  range: RangeId;
  from: string | null;
  to: string | null;
  onRange: (range: RangeId) => void;
  onCustom: (from: string, to: string) => void;
}) {
  // The Custom dates sit under the buttons, so the picker is no wider with them and the header row still fits
  return (
    <div className="flex flex-col items-start gap-2">
      <div
        role="radiogroup"
        aria-label="Date range"
        className="inline-flex rounded-md border p-0.5"
      >
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={range === p.id}
            data-testid={`range-${p.id}`}
            className={cn(
              'rounded px-2.5 py-1 text-sm whitespace-nowrap text-muted-foreground',
              range === p.id && 'bg-secondary font-medium text-foreground',
            )}
            onClick={() => {
              onRange(p.id);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {range === 'custom' && (
        <span className="flex items-center gap-1 text-sm">
          <Input
            type="date"
            aria-label="From"
            className="h-8 w-32"
            value={from ?? ''}
            max={to ?? undefined}
            onChange={(e) => {
              if (e.target.value !== '' && to !== null) onCustom(e.target.value, to);
            }}
          />
          –
          <Input
            type="date"
            aria-label="To"
            className="h-8 w-32"
            value={to ?? ''}
            min={from ?? undefined}
            onChange={(e) => {
              if (e.target.value !== '' && from !== null) onCustom(from, e.target.value);
            }}
          />
        </span>
      )}
    </div>
  );
}

export function PeopleFilter({
  everyone,
  selected,
  onChange,
}: {
  everyone: Person[];
  selected: string[];
  onChange: (people: string[]) => void;
}) {
  const label =
    selected.length === 0
      ? 'Everyone'
      : selected.length === 1
        ? (everyone.find((p) => p.key === selected[0])?.name ?? '1 person')
        : `${String(selected.length)} people`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" data-testid="people-filter">
          {label}
          <ChevronDown />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 flex max-h-96 w-64 flex-col gap-1 overflow-y-auto rounded-md border bg-background p-2 shadow-md"
          data-testid="people-filter-list"
        >
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:text-muted-foreground"
            disabled={selected.length === 0}
            onClick={() => {
              onChange([]);
            }}
          >
            Everyone
          </button>
          {everyone.map((p) => (
            <label
              key={p.key}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.includes(p.key)}
                onChange={(e) => {
                  onChange(
                    e.target.checked ? [...selected, p.key] : selected.filter((k) => k !== p.key),
                  );
                }}
              />
              {p.name}
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function syncText(
  latest: TeamSyncView | null,
  lastSucceeded: TeamSyncView | null,
  time: (ms: number) => string,
) {
  if (latest?.status === 'running') {
    const p = latest.progress;
    if (
      p.toRead === 0 &&
      p.read === 0 &&
      p.prsSearched === 0 &&
      p.commitsToRead === 0 &&
      p.timingsRead === 0
    ) {
      return p.listed === 0 ? 'Syncing…' : `Syncing… listed ${formatInteger(p.listed)} issues`;
    }
    const searched = p.prsSearched > 0 ? ` · ${formatInteger(p.prsSearched)} merged PRs found` : '';
    const commits =
      p.commitsToRead > 0
        ? ` · commits of ${formatInteger(p.commitsRead)} of ${formatInteger(p.commitsToRead)} PRs`
        : '';
    const timed = p.timingsRead > 0 ? ` · ${formatInteger(p.timingsRead)} txe PRs timed` : '';
    return `Syncing… ${formatInteger(p.read)} of ${formatInteger(p.toRead)} issues · ${formatInteger(p.prsRead)} PRs${searched}${commits}${timed}`;
  }
  if (lastSucceeded === null) return 'Not synced yet';
  return `Synced ${time(lastSucceeded.endedAt ?? lastSucceeded.startedAt)}`;
}

export function SyncStatus({ time }: { time: (ms: number) => string }) {
  const client = useQueryClient();
  const state = useQuery(teamSyncQuery);
  const sync = useMutation({
    mutationFn: startTeamSync,
    onSuccess: () => client.invalidateQueries({ queryKey: teamSyncQuery.queryKey }),
  });
  const latest = state.data?.latest ?? null;
  const running = latest?.status === 'running';
  return (
    <div className="ml-auto flex min-w-0 items-center gap-3">
      <span
        className="truncate text-sm text-muted-foreground tabular-nums"
        data-testid="sync-status"
        role="status"
      >
        {state.isError
          ? state.error.message
          : syncText(latest, state.data?.lastSucceeded ?? null, time)}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={running || sync.isPending}
        data-testid="sync-now"
        onClick={() => {
          sync.mutate();
        }}
      >
        <RefreshCw className={cn(running && 'animate-spin')} />
        Sync now
      </Button>
      {sync.isError && (
        <p role="alert" className="text-sm text-destructive">
          {sync.error.message}
        </p>
      )}
    </div>
  );
}

// The last sync's failure, in full, under the header
export function SyncFailure({ time }: { time: (ms: number) => string }) {
  const state = useQuery(teamSyncQuery);
  const latest = state.data?.latest ?? null;
  if (latest === null || (latest.status !== 'failed' && latest.status !== 'interrupted'))
    return null;
  return (
    <div
      className="rounded-md border border-destructive/40 px-3 py-2 text-sm"
      data-testid="sync-failure"
    >
      <span className="font-medium">
        {latest.status === 'failed' ? 'Last sync failed' : 'Last sync was interrupted'} ·{' '}
        {time(latest.endedAt ?? latest.startedAt)} · {formatInteger(latest.issues)} issues saved.
        The next sync continues from there.
      </span>
      {latest.error !== null && (
        <pre className="mt-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {latest.error}
        </pre>
      )}
    </div>
  );
}
