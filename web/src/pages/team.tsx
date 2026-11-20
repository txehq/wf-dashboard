import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { type CellRef, DailyCharts, Heatmap, IssueDayGrid } from '@/components/team/daily';
import {
  DoneNotClosedSection,
  IssuesSection,
  PrProblemsSection,
} from '@/components/team/issue-lists';
import { CloseTimesSummary, PeopleTable, PerDaySwitch } from '@/components/team/people-table';
import { PrTimings } from '@/components/team/pr-timings';
import { Section } from '@/components/team/section';
import {
  PeopleFilter,
  RangePicker,
  SyncFailure,
  SyncStatus,
  ViewSwitch,
} from '@/components/team/team-header';
import { teamStatsQuery, useTeamSyncEvents } from '@/lib/team-api';
import { dateTime, dayLabel, isRangeId, resolveRange } from '@/lib/team-days';
import { cn } from '@/lib/utils';

// Linear stats (Contracts 37.4) and txe PRs (37.6). The selection lives in the address: view (prs: txe PRs), range (and
// from, to for a custom range), people (the filter), person (a row of the People table), day (with person, a heatmap
// cell; in txe PRs, the clicked day, with person a cell of the one-day grid) and avg (day: the People table per day)
export function TeamPage() {
  useTeamSyncEvents();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'prs' ? 'prs' : 'linear';
  const rangeParam = params.get('range');
  const range = isRangeId(rangeParam) ? rangeParam : '30';
  const people = (params.get('people') ?? '').split(',').filter((k) => k !== '');
  // In txe PRs a person is only selected with a day: a cell of the one-day grid
  const person = view === 'prs' && params.get('day') === null ? null : params.get('person');
  const day = view === 'prs' || person !== null ? params.get('day') : null;
  // People table numbers per day of the range (avg=day), or totals
  const perDay = params.get('avg') === 'day';
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
  // In txe PRs a clicked day outside the range is dropped
  const listDay =
    view === 'prs' && data !== undefined && day !== null && (day < data.from || day > data.to)
      ? null
      : day;
  const scope = [
    selectedName ?? (people.length === 0 ? 'Everyone' : `${String(people.length)} people`),
    listDay === null ? rangeText : dayLabel(listDay),
  ].join(' · ');
  return (
    <div className="flex flex-col gap-6" data-testid="team-page">
      <div className="flex flex-col gap-2">
        {/* Top-aligned: with Custom the range picker is two rows tall and the rest stays on the first */}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          {/* Both titles share one grid cell, the other one invisible: the title keeps the longer one's width, so
              switching views moves nothing after it */}
          <h1 className="inline-grid text-2xl font-semibold whitespace-nowrap">
            {(['linear', 'prs'] as const).map((v) => (
              <span
                key={v}
                className={cn('col-start-1 row-start-1', v !== view && 'invisible')}
                aria-hidden={v !== view}
              >
                {`${v === 'prs' ? 'PR' : 'Linear'} ${data?.team ?? 'TXE'}`}
              </span>
            ))}
          </h1>
          <ViewSwitch
            view={view}
            onChange={(next) => {
              update({ view: next === 'prs' ? 'prs' : null, person: null, day: null });
            }}
          />
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
      {data?.firstDay != null && view === 'prs' && (
        <PrTimings
          query={{ from: data.from, to: data.to, people }}
          scope={scope}
          day={listDay}
          person={listDay === null ? null : person}
          onSelect={(next) => {
            update({ day: next?.day ?? null, person: next?.person ?? null });
          }}
        />
      )}
      {data?.firstDay != null && view === 'linear' && (
        <>
          <CloseTimesSummary times={data.closeTimes} />
          <Section
            title="People"
            action={
              data.days.length > 1 &&
              shown.length > 0 && (
                <span className="ml-auto">
                  <PerDaySwitch
                    perDay={perDay}
                    onChange={(next) => {
                      update({ avg: next ? 'day' : null });
                    }}
                  />
                </span>
              )
            }
          >
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity in this range.</p>
            ) : (
              <PeopleTable
                people={shown}
                days={data.days.length}
                perDay={perDay && data.days.length > 1}
                selected={person}
                onSelect={(key) => {
                  update({ person: key, day: null });
                }}
              />
            )}
          </Section>
          <Section title="Daily" testId="daily">
            {shown.length > 0 &&
              (data.days.length === 1 && data.days[0] !== undefined ? (
                <IssueDayGrid
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
          </Section>
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
