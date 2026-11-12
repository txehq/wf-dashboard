import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { type CellRef, DailyCharts, DayGrid, Heatmap } from '@/components/team/daily';
import {
  DoneNotClosedSection,
  IssuesSection,
  PrProblemsSection,
} from '@/components/team/issue-lists';
import { PeopleTable } from '@/components/team/people-table';
import { PeopleFilter, RangePicker, SyncFailure, SyncStatus } from '@/components/team/team-header';
import { teamStatsQuery, useTeamSyncEvents } from '@/lib/team-api';
import { dateTime, dayLabel, isRangeId, resolveRange } from '@/lib/team-days';

// Linear stats (Contracts 37.4). The selection lives in the address: range (and from, to for a custom range), people
// (the filter), person (a row of the People table) and day (with person, a heatmap cell)
export function TeamPage() {
  useTeamSyncEvents();
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('range');
  const range = isRangeId(rangeParam) ? rangeParam : '30';
  const people = (params.get('people') ?? '').split(',').filter((k) => k !== '');
  const person = params.get('person');
  const day = person === null ? null : params.get('day');
  // The preset ranges need today and the first day of the data, which the last answer carries; the first request leaves
  // the range to the server (its own last 30 days)
  const [bounds, setBounds] = useState<{ today: string; firstDay: string | null } | null>(null);
  const { from, to } = resolveRange(
    range,
    { from: params.get('from'), to: params.get('to') },
    bounds,
  );
  const stats = useQuery({
    ...teamStatsQuery({ from, to, people }),
    placeholderData: keepPreviousData,
  });
  const answered =
    stats.data === undefined ? null : { today: stats.data.today, firstDay: stats.data.firstDay };
  if (
    answered !== null &&
    (bounds?.today !== answered.today || bounds.firstDay !== answered.firstDay)
  ) {
    setBounds(answered);
  }

  const update = (changes: Record<string, string | null>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };

  const data = stats.data;
  const timeZone = data?.timezone ?? 'UTC';
  const time = (ms: number) => dateTime(ms, timeZone);
  const shown = data?.people ?? [];
  const selectedName =
    shown.find((p) => p.key === person)?.name ?? data?.everyone.find((p) => p.key === person)?.name;
  const cell: CellRef | null = person !== null && day !== null ? { person, day } : null;
  const rangeText =
    data === undefined
      ? ''
      : data.from === data.to
        ? dayLabel(data.from)
        : `${dayLabel(data.from)} – ${dayLabel(data.to)}`;
  const scope = [
    selectedName ?? (people.length === 0 ? 'Everyone' : `${String(people.length)} people`),
    day === null ? rangeText : dayLabel(day),
  ].join(' · ');
  return (
    <div className="flex flex-col gap-6" data-testid="team-page">
      <div className="flex flex-col gap-2">
        {/* Top-aligned: with Custom the range picker is two rows tall and the rest stays on the first */}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <h1 className="text-2xl font-semibold whitespace-nowrap">
            Linear stats · {data?.team ?? 'TXE'}
          </h1>
          <RangePicker
            range={range}
            from={from}
            to={to}
            onRange={(next) => {
              update(
                next === 'custom'
                  ? {
                      range: next,
                      from: from ?? data?.from ?? null,
                      to: to ?? data?.to ?? null,
                      day: null,
                    }
                  : { range: next === '30' ? null : next, from: null, to: null, day: null },
              );
            }}
            onCustom={(f, t) => {
              update({ range: 'custom', from: f, to: t, day: null });
            }}
          />
          <PeopleFilter
            everyone={data?.everyone ?? []}
            selected={people}
            onChange={(next) => {
              update({ people: next.join(','), person: null, day: null });
            }}
          />
          <SyncStatus time={time} />
        </div>
        <SyncFailure time={time} />
      </div>
      {stats.isError && <p className="text-sm text-destructive">{stats.error.message}</p>}
      {data?.firstDay === null && (
        <p className="text-sm text-muted-foreground" data-testid="team-empty">
          No Linear issues yet. The first sync reads every TXE issue; this page fills in as it goes.
        </p>
      )}
      {data?.firstDay != null && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">People</h2>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity in this range.</p>
            ) : (
              <PeopleTable
                people={shown}
                perDay={data.days.length > 1}
                selected={person}
                onSelect={(key) => {
                  update({ person: key, day: null });
                }}
              />
            )}
          </section>
          <section className="flex flex-col gap-3" data-testid="daily">
            <h2 className="text-base font-semibold">Daily</h2>
            {shown.length > 0 &&
              (data.days.length === 1 && data.days[0] !== undefined ? (
                <DayGrid
                  people={shown}
                  day={data.days[0]}
                  daily={data.daily}
                  selected={cell}
                  onSelect={(c) => {
                    update(c === null ? { day: null } : { person: c.person, day: c.day });
                  }}
                />
              ) : (
                <Heatmap
                  people={shown}
                  days={data.days}
                  daily={data.daily}
                  selected={cell}
                  onSelect={(c) => {
                    update(c === null ? { day: null } : { person: c.person, day: c.day });
                  }}
                />
              ))}
            <h3 className="text-sm font-medium">
              {selectedName ?? (people.length === 0 ? 'Everyone' : 'Selected people')}
            </h3>
            <DailyCharts
              days={data.days}
              daily={person === null ? data.daily : data.daily.filter((c) => c.person === person)}
            />
          </section>
          <IssuesSection
            query={{ from: data.from, to: data.to, people, person, day, doneNotClosed: false }}
            scope={scope}
            onClear={
              person === null
                ? null
                : () => {
                    update({ person: null, day: null });
                  }
            }
            timeZone={timeZone}
          />
          <DoneNotClosedSection people={people} timeZone={timeZone} />
          <PrProblemsSection problems={data.prProblems} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
