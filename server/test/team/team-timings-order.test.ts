import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import type { SearchSpec, TimedPr } from '../../src/team/github.js';
import type { TeamIssue } from '../../src/team/linear.js';

// The txe PR timings (Contracts 37.6) are searched newest first and beside the Linear issue reads, not after them: a
// first sync of thousands of issues showed "0 PRs merged" until every issue was read. Linear and GitHub are stand-ins

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const REPO = 'txehq/txe';
const FIRST_ISSUE = Date.parse('2026-10-01T08:00:00Z');

// The search calls the sync makes, in order, and the moment the issue reads finished
const searches: { spec: 'timings' | 'merged'; from: number; to: number; issuesRead: boolean }[] =
  [];
let issuesRead = false;
// Repos the gh account cannot see (an account outside txehq)
const hidden = new Set<string>();
// The last issue read waits until the first timings window is read, so the test sees the search beside the issue reads
let releaseIssue: () => void = () => undefined;
const issueGate = new Promise<void>((resolve) => {
  releaseIssue = resolve;
});

const iso = (ms: number) => new Date(ms).toISOString();
const issue = (id: string, createdAt: number): TeamIssue => ({
  id,
  uuid: `uuid-${id}`,
  title: id,
  url: `https://linear.app/txe/issue/${id}`,
  status: 'Todo',
  statusType: 'unstarted',
  assignee: null,
  assigneeId: null,
  createdBy: null,
  createdById: null,
  createdAt: iso(createdAt),
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  updatedAt: iso(NOW - DAY),
  archivedAt: null,
  stateHistory: [],
  attachments: [],
});
const timedPr = (number: number, mergedAt: number): TimedPr => ({
  url: `https://github.com/${REPO}/pull/${String(number)}`,
  number,
  title: `PR ${String(number)}`,
  createdAt: iso(mergedAt - 3_600_000),
  mergedAt: iso(mergedAt),
  author: { login: 'someone' },
  timelineItems: { nodes: [] },
  commits: { nodes: [{ commit: { checkSuites: { totalCount: 0, nodes: [] } } }] },
});

vi.mock('../../src/team/linear.js', () => ({
  listTeamUsers: () => Promise.resolve([]),
  listTeamIssues: () =>
    Promise.resolve([
      { id: 'TXE-2', updatedAt: iso(NOW - DAY) },
      { id: 'TXE-1', updatedAt: iso(NOW - DAY) },
    ]),
  readTeamIssue: async (id: string) => {
    if (id === 'TXE-2') return issue(id, NOW - 3 * DAY);
    await issueGate;
    issuesRead = true;
    return issue(id, FIRST_ISSUE);
  },
  listUserDiffs: () => Promise.resolve([]),
}));

vi.mock('../../src/team/github.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/team/github.js')>();
  return {
    ...real,
    readRepoName: (name: string) => Promise.resolve(hidden.has(name) ? null : name),
    readCommits: () => Promise.resolve([]),
    readTimings: () => Promise.resolve([]),
    searchMergedPrs: async <T>(
      spec: SearchSpec<T>,
      _repo: string,
      from: number,
      to: number,
      limit: <R>(task: () => Promise<R>) => Promise<R>,
      onPage: (prs: T[]) => void,
      _signal: AbortSignal,
      onWindow: (from: number, to: number) => void = () => undefined,
    ) => {
      const timings = spec === real.PR_TIMINGS;
      await limit(() => Promise.resolve());
      searches.push({ spec: timings ? 'timings' : 'merged', from, to, issuesRead });
      // The first timings window lets the last issue be read
      releaseIssue();
      // One PR merged in the middle of each timings window
      if (timings) onPage([timedPr(searches.length, Math.floor((from + to) / 2))] as T[]);
      onWindow(from, to);
    },
  };
});

const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { createTeamSync } = await import('../../src/team/sync.js');
const { prTimingsView, timingsFetchedFrom } = await import('../../src/team/pr-timings.js');
const { loadTeamData } = await import('../../src/team/stats.js');

const dir = path.join(config.dataDir, 'team-timings-order');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
afterAll(() => {
  db.$client.close();
});

test(
  'timings are searched newest first, beside the issue reads, back to the day before the first issue',
  { timeout: 20_000 },
  async () => {
    const sync = createTeamSync({ db, team: 'TXE', now: () => new Date(NOW), timedRepo: REPO });
    const view = await sync.begin().done;
    expect(view.error).toBeNull();
    expect(view.status).toBe('succeeded');

    const timings = searches.filter((s) => s.spec === 'timings');
    // Started while the last issue was still being read
    expect(timings[0]?.issuesRead).toBe(false);
    // Week by week, each window ending a second before the next newer one starts
    expect(timings[0]?.to).toBe(NOW - 10 * 60_000);
    for (let i = 1; i < timings.length; i++) {
      const newer = timings[i - 1];
      const older = timings[i];
      if (newer === undefined || older === undefined) throw new Error('missing window');
      expect(older.to).toBe(newer.from - 1_000);
      expect(newer.to - newer.from).toBeLessThan(7 * DAY);
    }
    // The search went past the floor the first issue read (3 days ago) to the one the last issue moved it to
    expect(timings.at(-1)?.from).toBe(Math.floor((FIRST_ISSUE - DAY) / 1_000) * 1_000);
    expect(timingsFetchedFrom(db, REPO)).toBe(timings.at(-1)?.from);
    expect(view.progress.timingsRead).toBe(timings.length);
  },
);

test('the PR view says whether the range is fetched: covered from the first day, or not yet', () => {
  const data = loadTeamData(db, NOW);
  const view = (from: string) =>
    prTimingsView(db, data, REPO, { zone: 'UTC', from, to: '2026-11-20', people: [] }, null);
  expect(view('2026-10-01')).toMatchObject({ fetched: true });
  expect(view('2026-10-01').summary.prs).toBeGreaterThan(0);
  // Before the first issue's day nothing is searched
  expect(view('2026-09-01')).toMatchObject({ fetched: false });
  // A repo no search has read yet
  expect(
    prTimingsView(
      db,
      data,
      'txehq/other',
      { zone: 'UTC', from: '2026-10-01', to: '2026-11-20', people: [] },
      null,
    ),
  ).toMatchObject({ fetchedFrom: null, fetched: false });
});

test('a later sync searches only the new part, newest first', async () => {
  const before = searches.length;
  const later = NOW + 2 * DAY;
  const sync = createTeamSync({ db, team: 'TXE', now: () => new Date(later), timedRepo: REPO });
  const view = await sync.begin().done;
  expect(view.status).toBe('succeeded');
  const timings = searches.slice(before).filter((s) => s.spec === 'timings');
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ from: NOW - 10 * 60_000 + 1_000, to: later - 10 * 60_000 });
});

test('a gh account that cannot see the timed repo fails the sync instead of marking PRs Not Found', async () => {
  const before = searches.length;
  hidden.add(REPO);
  const sync = createTeamSync({
    db,
    team: 'TXE',
    now: () => new Date(NOW + 3 * DAY),
    timedRepo: REPO,
  });
  const view = await sync.begin().done;
  hidden.delete(REPO);
  expect(view.status).toBe('failed');
  expect(view.error).toMatch(/^The active gh account cannot see txehq\/txe/);
  expect(searches).toHaveLength(before);
});
