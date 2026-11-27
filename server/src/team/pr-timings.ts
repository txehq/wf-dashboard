import { and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { teamPrTimings, teamPrTimingWindows } from '../db/schema.js';
import { between, spread } from './durations.js';
import { DayRange, type Selection, type TeamData } from './stats.js';
import { joinWindows } from './sync.js';
import {
  type Person,
  type PrTimingAuthor,
  type PrTimingDay,
  type PrTimingRow,
  SLOW_CI_MS,
  type TeamPrTimings,
} from './views.js';

// txe PR timings (Contracts 37.6): the timed repo's PRs merged in the range, each on the day it merged in the timezone
// setting, with the mean, median and P90 of each duration and the PRs with slow CI by day, by author and over the
// range. With people, only PRs whose author is the GitHub account of one of them (37.3)

const spreads = (rows: PrTimingRow[]) => ({
  slowCi: rows.filter((r) => r.slowCi).length,
  openToMerge: spread(rows.map((r) => r.openToMerge)),
  readyToMerge: spread(rows.map((r) => r.readyToMerge)),
  ci: spread(rows.map((r) => r.ci)),
});

// Where the newest-first timings search has reached: the start of the joined saved windows that end latest
export function timingsFetchedFrom(db: Db, repo: string): number | null {
  const windows = db
    .select()
    .from(teamPrTimingWindows)
    .where(eq(teamPrTimingWindows.repo, repo))
    .all()
    .map((w): [number, number] => [w.from.getTime(), w.to.getTime()]);
  return joinWindows(windows).at(-1)?.[0] ?? null;
}

export function prTimingsView(
  db: Db,
  data: TeamData,
  repo: string,
  { zone, from, to, people }: Selection,
  day: string | null,
): TeamPrTimings {
  const range = new DayRange(zone, from, to);
  const fetchedFrom = timingsFetchedFrom(db, repo);
  const logins = new Set(
    people.flatMap((key) => {
      const login = data.accounts.get(key)?.login;
      return login == null ? [] : [login.toLowerCase()];
    }),
  );
  const saved = db
    .select()
    .from(teamPrTimings)
    .where(
      and(
        eq(teamPrTimings.repo, repo),
        gte(teamPrTimings.mergedAt, new Date(range.start)),
        lt(teamPrTimings.mergedAt, new Date(range.end)),
      ),
    )
    .all();
  const authors = new Map<string, Person>();
  const rows = saved.flatMap((p): PrTimingRow[] => {
    const login = p.authorLogin?.toLowerCase() ?? null;
    if (people.length > 0 && (login === null || !logins.has(login))) return [];
    const mergedDay = range.of(p.mergedAt.getTime());
    if (mergedDay === null) throw new Error(`${p.url} merged outside ${from}..${to}`);
    const mergedAt = p.mergedAt.getTime();
    const createdAt = p.createdAt.getTime();
    const readyAt = p.readyAt?.getTime() ?? null;
    const ciStartedAt = p.ciStartedAt?.getTime() ?? null;
    const ciEndedAt = p.ciEndedAt?.getTime() ?? null;
    const ci = ciStartedAt === null || ciEndedAt === null ? null : between(ciStartedAt, ciEndedAt);
    const person = login === null ? undefined : data.authors.get(login);
    const author = person ?? {
      key: `github:${p.authorLogin ?? ''}`,
      name: p.authorLogin ?? 'Deleted account',
    };
    authors.set(author.key, author);
    return [
      {
        url: p.url,
        number: p.number,
        title: p.title,
        author: p.authorLogin,
        person: person?.name ?? null,
        authorKey: author.key,
        day: mergedDay,
        createdAt,
        readyAt,
        mergedAt,
        openToMerge: between(createdAt, mergedAt),
        readyToMerge: between(readyAt ?? createdAt, mergedAt),
        ci,
        ciStartedAt,
        ciEndedAt,
        ciRunning: ciStartedAt !== null && ciEndedAt === null,
        ciRuns: p.ciRuns,
        ciAllSucceeded: p.ciAllSucceeded,
        slowCi: ci !== null && ci >= SLOW_CI_MS,
        slowest:
          p.slowestWorkflow === null || p.slowestMs === null || p.slowestAfterMerge === null
            ? null
            : {
                workflow: p.slowestWorkflow,
                duration: p.slowestMs,
                afterMerge: p.slowestAfterMerge,
              },
      },
    ];
  });
  const byDay = new Map<string, PrTimingRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const daily = range.days.map((d): PrTimingDay => {
    const of = byDay.get(d) ?? [];
    return { day: d, prs: of.length, ...spreads(of) };
  });
  const byAuthor = new Map<string, PrTimingRow[]>();
  for (const r of rows) byAuthor.set(r.authorKey, [...(byAuthor.get(r.authorKey) ?? []), r]);
  const authorStats = [...authors.values()]
    .map((a): PrTimingAuthor => {
      const of = byAuthor.get(a.key) ?? [];
      return { ...a, prs: of.length, ...spreads(of) };
    })
    .sort((a, b) => b.prs - a.prs || a.name.localeCompare(b.name));
  return {
    repo,
    timezone: zone,
    from,
    to,
    days: range.days,
    summary: { prs: rows.length, ...spreads(rows) },
    daily,
    people: authorStats,
    // PRs without the duration last
    prs: (day === null ? rows : (byDay.get(day) ?? [])).sort(
      (a, b) => (b.openToMerge ?? -Infinity) - (a.openToMerge ?? -Infinity) || b.number - a.number,
    ),
    fetchedFrom,
    fetched: fetchedFrom !== null && fetchedFrom <= range.start,
  };
}
