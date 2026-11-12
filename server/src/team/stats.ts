import { DateTime } from 'luxon';
import type { Db } from '../db/index.js';
import { teamIssuePrs, teamIssueStates, teamIssues, teamPrs, teamUsers } from '../db/schema.js';
import {
  type DayCell,
  type Person,
  type PersonStats,
  type PrProblem,
  type TeamIssuePr,
  type TeamIssueRow,
  type TeamStats,
  UNASSIGNED,
} from './views.js';

// The counting rules of Contracts 37.3, computed from the synced tables on every request: changing the timezone
// recounts at once without a new sync (37.1)

// State types of an issue that is closed
const CLOSED = new Set(['completed', 'canceled', 'duplicate']);

type IssueRow = typeof teamIssues.$inferSelect;
type PrRow = typeof teamPrs.$inferSelect;

export interface Issue {
  row: IssueRow;
  assignee: Person;
  creator: Person;
  prs: PrRow[];
  doneNotClosed: boolean;
  // Completion time in ms (37.3), null when not completed
  completedAt: number | null;
  // Intervals in a started state, [start, end) in ms
  started: [number, number][];
}

export interface TeamData {
  issues: Issue[];
  prs: PrRow[];
  // Issue identifiers linking to each PR url
  linkedBy: Map<string, string[]>;
}

export function loadTeamData(db: Db, now: number): TeamData {
  // One read transaction: a sync saving issues meanwhile is seen whole or not at all
  const { userRows, prs, links, stateRows, rows } = db.transaction((tx) => ({
    userRows: tx.select().from(teamUsers).all(),
    prs: tx.select().from(teamPrs).all(),
    links: tx.select().from(teamIssuePrs).all(),
    stateRows: tx.select().from(teamIssueStates).orderBy(teamIssueStates.seq).all(),
    rows: tx.select().from(teamIssues).all(),
  }));
  const users = new Map(userRows.map((u) => [u.id, u.name]));
  const prByUrl = new Map(prs.map((p) => [p.url, p]));
  const statesByIssue = new Map<string, (typeof teamIssueStates.$inferSelect)[]>();
  for (const s of stateRows) {
    const list = statesByIssue.get(s.issueId) ?? [];
    list.push(s);
    statesByIssue.set(s.issueId, list);
  }
  const prsByIssue = new Map<string, PrRow[]>();
  for (const l of links) {
    const pr = prByUrl.get(l.prUrl);
    if (pr === undefined) throw new Error(`PR ${l.prUrl} of issue ${l.issueId} is not saved`);
    const list = prsByIssue.get(l.issueId) ?? [];
    list.push(pr);
    prsByIssue.set(l.issueId, list);
  }
  const person = (id: string | null, name: string | null): Person =>
    id === null
      ? { key: UNASSIGNED, name: 'Unassigned' }
      : { key: id, name: users.get(id) ?? name ?? id };
  const identifierOf = new Map(rows.map((r) => [r.id, r.identifier]));
  const linkedBy = new Map<string, string[]>();
  for (const l of links) {
    const identifier = identifierOf.get(l.issueId);
    if (identifier === undefined) throw new Error(`Issue ${l.issueId} is not saved`);
    linkedBy.set(l.prUrl, [...(linkedBy.get(l.prUrl) ?? []), identifier]);
  }
  const issues = rows.map((row): Issue => {
    const linked = prsByIssue.get(row.id) ?? [];
    // PRs that could not be read are not counted (37.2)
    const counted = linked.filter((p) => p.readError === null && p.state !== null);
    const merged = counted.filter((p) => p.mergedAt !== null);
    const doneNotClosed =
      !CLOSED.has(row.statusType) && merged.length > 0 && !counted.some((p) => p.state === 'open');
    const completedAt =
      row.statusType === 'completed'
        ? (row.completedAt?.getTime() ?? null)
        : doneNotClosed
          ? Math.max(...merged.map((p) => p.mergedAt?.getTime() ?? 0))
          : null;
    const states = statesByIssue.get(row.id) ?? [];
    const started: [number, number][] =
      states.length > 0
        ? states
            .filter((s) => s.type === 'started')
            .map((s) => [s.startedAt.getTime(), s.endedAt?.getTime() ?? now])
        : row.startedAt === null
          ? []
          : [[row.startedAt.getTime(), completedAt ?? row.canceledAt?.getTime() ?? now]];
    return {
      row,
      assignee: person(row.assigneeId, row.assigneeName),
      creator: person(row.creatorId, row.creatorName),
      prs: linked,
      doneNotClosed,
      completedAt,
      started,
    };
  });
  return { issues, prs, linkedBy };
}

// Days of one timezone as yyyy-mm-dd
export class Days {
  constructor(readonly zone: string) {}

  of(ms: number): string {
    const day = DateTime.fromMillis(ms, { zone: this.zone }).toISODate();
    if (day === null) throw new Error(`No day for ${String(ms)} in ${this.zone}`);
    return day;
  }

  start(day: string): number {
    const start = DateTime.fromISO(day, { zone: this.zone });
    if (!start.isValid) throw new Error(`Invalid day ${day} in ${this.zone}`);
    return start.toMillis();
  }

  add(day: string, n: number): string {
    const next = DateTime.fromISO(day, { zone: this.zone }).plus({ days: n }).toISODate();
    if (next === null) throw new Error(`Invalid day ${day}`);
    return next;
  }
}

// The days from from to to (both included) with the time each starts, computed once per request so that finding the
// day of a time is a binary search
export class DayRange {
  readonly days: string[] = [];
  // starts[i] is the start of days[i]; the last entry is the end of the range
  private readonly starts: number[] = [];

  constructor(zone: string, from: string, to: string) {
    let start = DateTime.fromISO(from, { zone });
    if (!start.isValid) throw new Error(`Invalid day ${from} in ${zone}`);
    for (let day = from; day <= to;) {
      this.days.push(day);
      this.starts.push(start.toMillis());
      start = start.plus({ days: 1 });
      day = start.toISODate();
    }
    this.starts.push(start.toMillis());
  }

  get start(): number {
    return this.starts[0] ?? 0;
  }

  get end(): number {
    return this.starts[this.starts.length - 1] ?? 0;
  }

  // The day a time falls on, or null outside the range
  of(ms: number): string | null {
    if (ms < this.start || ms >= this.end) return null;
    let lo = 0;
    let hi = this.days.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= ms) lo = mid;
      else hi = mid - 1;
    }
    return this.days[lo] ?? null;
  }

  // Days of the range the interval [start, end) touches; a zero-length interval touches the day it is on
  touched(start: number, end: number): string[] {
    if (end <= start) {
      const day = this.of(start);
      return day === null ? [] : [day];
    }
    const s = Math.max(start, this.start);
    const e = Math.min(end, this.end);
    if (s >= e) return [];
    const first = this.of(s);
    const last = this.of(e - 1);
    if (first === null || last === null) return [];
    return this.days.slice(this.days.indexOf(first), this.days.indexOf(last) + 1);
  }
}

// What one issue counts for on each day of the range (37.3)
export function issueDays(issue: Issue, range: DayRange) {
  const handled = new Set<string>();
  for (const [start, end] of issue.started)
    for (const d of range.touched(start, end)) handled.add(d);
  const completed = issue.completedAt === null ? null : range.of(issue.completedAt);
  if (completed !== null) handled.add(completed);
  return {
    handled,
    created: range.of(issue.row.createdAt.getTime()),
    completed,
    canceled: issue.row.canceledAt === null ? null : range.of(issue.row.canceledAt.getTime()),
  };
}

export interface MergedPr {
  pr: PrRow;
  issue: Issue;
  // null outside the range
  day: string | null;
}

// Merged PRs counted once each (by GitHub id, so two URLs of one PR count once), on the assignee of the earliest
// completed issue linking to them, on the day they merged (37.3)
export function mergedPrs(data: TeamData, range: DayRange): MergedPr[] {
  const issueOf = new Map(data.issues.map((i) => [i.row.identifier, i]));
  const byId = new Map<number, PrRow[]>();
  for (const pr of data.prs) {
    if (pr.readError !== null || pr.mergedAt === null || pr.githubId === null) continue;
    byId.set(pr.githubId, [...(byId.get(pr.githubId) ?? []), pr]);
  }
  const result: MergedPr[] = [];
  for (const urls of byId.values()) {
    const issues = urls
      .flatMap((p) => data.linkedBy.get(p.url) ?? [])
      .map((identifier) => {
        const issue = issueOf.get(identifier);
        if (issue === undefined) throw new Error(`Issue ${identifier} is not loaded`);
        return issue;
      })
      .sort(
        (a, b) =>
          (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity) || a.row.number - b.row.number,
      );
    const [issue] = issues;
    const [pr] = urls;
    if (issue === undefined || pr?.mergedAt == null) continue;
    result.push({ pr, issue, day: range.of(pr.mergedAt.getTime()) });
  }
  return result;
}

export interface Selection {
  zone: string;
  from: string;
  to: string;
  // Person keys; empty is everyone
  people: string[];
}

const zero = () => ({
  handled: 0,
  created: 0,
  completed: 0,
  canceled: 0,
  prsMerged: 0,
  additions: 0,
  deletions: 0,
});

export function teamStats(
  data: TeamData,
  team: string,
  { zone, from, to, people }: Selection,
  now: number,
): TeamStats {
  const days = new Days(zone);
  const range = new DayRange(zone, from, to);
  const dayList = range.days;
  const wanted = (key: string) => people.length === 0 || people.includes(key);
  const names = new Map<string, string>();
  const cells = new Map<string, DayCell>();
  const cell = (person: Person, day: string) => {
    names.set(person.key, person.name);
    const key = `${person.key}\n${day}`;
    let c = cells.get(key);
    if (c === undefined) {
      c = { person: person.key, day, ...zero() };
      cells.set(key, c);
    }
    return c;
  };
  const doneNotClosed = new Map<string, number>();
  const open = new Map<string, number>();
  const everyone = new Map<string, string>();
  for (const issue of data.issues) {
    everyone.set(issue.assignee.key, issue.assignee.name);
    everyone.set(issue.creator.key, issue.creator.name);
    if (issue.row.statusType === 'started' && !issue.doneNotClosed && wanted(issue.assignee.key)) {
      names.set(issue.assignee.key, issue.assignee.name);
      open.set(issue.assignee.key, (open.get(issue.assignee.key) ?? 0) + 1);
    }
    const counted = issueDays(issue, range);
    if (counted.created !== null && wanted(issue.creator.key))
      cell(issue.creator, counted.created).created += 1;
    if (!wanted(issue.assignee.key)) continue;
    for (const d of counted.handled) cell(issue.assignee, d).handled += 1;
    if (counted.completed !== null) {
      cell(issue.assignee, counted.completed).completed += 1;
      if (issue.doneNotClosed)
        doneNotClosed.set(issue.assignee.key, (doneNotClosed.get(issue.assignee.key) ?? 0) + 1);
    }
    if (counted.canceled !== null) cell(issue.assignee, counted.canceled).canceled += 1;
  }
  for (const { pr, issue, day } of mergedPrs(data, range)) {
    if (day === null || !wanted(issue.assignee.key)) continue;
    const c = cell(issue.assignee, day);
    c.prsMerged += 1;
    c.additions += pr.additions ?? 0;
    c.deletions += pr.deletions ?? 0;
  }
  const daily = [...cells.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.person.localeCompare(b.person),
  );
  const rows: PersonStats[] = [...names].map(([key, name]) => {
    const total = zero();
    for (const c of daily) {
      if (c.person !== key) continue;
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
    }
    return {
      key,
      name,
      ...total,
      handledPerDay: total.handled / dayList.length,
      doneNotClosed: doneNotClosed.get(key) ?? 0,
      openInProgress: open.get(key) ?? 0,
    };
  });
  rows.sort((a, b) => b.handled - a.handled || a.name.localeCompare(b.name));
  const first = Math.min(...data.issues.map((i) => i.row.createdAt.getTime()));
  return {
    team,
    timezone: zone,
    from,
    to,
    today: days.of(now),
    firstDay: data.issues.length === 0 ? null : days.of(first),
    days: dayList,
    everyone: [...everyone]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    people: rows,
    daily,
    prProblems: prProblems(data),
  };
}

function prProblems(data: TeamData): PrProblem[] {
  return data.prs
    .filter((p) => p.readError !== null)
    .map((p) => ({
      url: p.url,
      repo: p.repo,
      number: p.number,
      error: p.readError ?? '',
      readAt: p.readAt.getTime(),
      issues: data.linkedBy.get(p.url) ?? [],
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

export interface IssueSelection extends Selection {
  // One day inside [from, to] (a heatmap cell)
  day: string | null;
  doneNotClosed: boolean;
}

const prView = (p: PrRow): TeamIssuePr => ({
  url: p.url,
  repo: p.repo,
  number: p.number,
  state: p.state,
  draft: p.draft,
  mergedAt: p.mergedAt?.getTime() ?? null,
  closedAt: p.closedAt?.getTime() ?? null,
  additions: p.additions,
  deletions: p.deletions,
  error: p.readError,
});

// The Issues list (37.4): issues a selected person handled, created, completed or canceled in the selected days; with
// doneNotClosed, every issue done but not closed regardless of days
export function teamIssueRows(data: TeamData, selection: IssueSelection): TeamIssueRow[] {
  const range = new DayRange(
    selection.zone,
    selection.day ?? selection.from,
    selection.day ?? selection.to,
  );
  const wanted = (key: string) => selection.people.length === 0 || selection.people.includes(key);
  const rows: TeamIssueRow[] = [];
  for (const issue of data.issues) {
    if (selection.doneNotClosed && !issue.doneNotClosed) continue;
    const counted = issueDays(issue, range);
    const assigned = wanted(issue.assignee.key);
    const flags = {
      handled: assigned && counted.handled.size > 0,
      created: wanted(issue.creator.key) && counted.created !== null,
      completed: assigned && counted.completed !== null,
      canceled: assigned && counted.canceled !== null,
    };
    const included = selection.doneNotClosed
      ? assigned
      : flags.handled || flags.created || flags.completed || flags.canceled;
    if (!included) continue;
    rows.push({
      identifier: issue.row.identifier,
      number: issue.row.number,
      url: issue.row.url,
      title: issue.row.title,
      assignee: issue.assignee,
      creator: issue.creator,
      status: issue.row.status,
      statusType: issue.row.statusType,
      createdAt: issue.row.createdAt.getTime(),
      completedAt: issue.completedAt,
      canceledAt: issue.row.canceledAt?.getTime() ?? null,
      doneNotClosed: issue.doneNotClosed,
      prs: issue.prs.map(prView),
      ...flags,
    });
  }
  return rows.sort((a, b) => b.number - a.number);
}
