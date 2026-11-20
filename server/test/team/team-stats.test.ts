import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { TEAM_NOW, teamReplay } from '../helpers/team-replay.js';

// The counting rules of Contracts 37.3 on recorded real Linear and GitHub responses (test/fixtures/team/*). Expected
// numbers were derived from the fixture JSON independently of the implementation (.work/w114/expected.ts in W114)
const replay = teamReplay();
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { closeLinearClient } = await import('../../src/external/linear.js');
const { createTeamSync } = await import('../../src/team/sync.js');
const { loadTeamData, teamIssueRows, teamStats } = await import('../../src/team/stats.js');
const { UNASSIGNED } = await import('../../src/team/views.js');

afterAll(async () => {
  await closeLinearClient();
});

const NOW = TEAM_NOW;
const dir = path.join(config.dataDir, 'team-stats');
fs.rmSync(dir, { recursive: true, force: true });

// Syncs one fixture into its own database once, then counts over it
const synced = new Map<string, ReturnType<typeof loadTeamData>>();
async function data(name: string) {
  const loaded = synced.get(name);
  if (loaded !== undefined) return loaded;
  replay.use(name);
  const db = openDatabase(path.join(dir, `${name}.sqlite`), config.migrationsDir);
  const meta = replay.meta(name);
  const sync = createTeamSync({ db, team: 'TXE', scope: meta.scope, now: () => new Date(NOW) });
  const view = await sync.begin().done;
  if (view.status !== 'succeeded')
    throw new Error(`${name} sync ${view.status}: ${String(view.error)}`);
  const fresh = loadTeamData(db, NOW);
  synced.set(name, fresh);
  return fresh;
}

const stats = async (
  name: string,
  from: string,
  to: string,
  zone = 'Asia/Shanghai',
  people: string[] = [],
) => teamStats(await data(name), 'TXE', { zone, from, to, people }, NOW);

const issues = async (
  name: string,
  selection: {
    from: string;
    to: string;
    zone?: string;
    people?: string[];
    day?: string | null;
    doneNotClosed?: boolean;
  },
) =>
  teamIssueRows(await data(name), {
    zone: 'Asia/Shanghai',
    people: [],
    day: null,
    doneNotClosed: false,
    ...selection,
  });

const person = (report: Awaited<ReturnType<typeof stats>>, name: string) => {
  const row = report.people.find((p) => p.name === name);
  if (row === undefined)
    throw new Error(`${name} is not in ${report.people.map((p) => p.name).join(', ')}`);
  return row;
};
const cell = (report: Awaited<ReturnType<typeof stats>>, name: string, day: string) =>
  report.daily.find((c) => c.person === person(report, name).key && c.day === day);

// A person's key (a Linear user id), as the people filter takes
const keyOf = async (name: string, fixture: string, from: string, to: string) =>
  person(await stats(fixture, from, to), name).key;

describe('team stats', { timeout: 60_000 }, () => {
  test('Created, Completed and Handled are counted per person and day, Handled once per issue and day', async () => {
    const report = await stats('unassigned', '2026-11-02', '2026-11-04');
    expect(report.days).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(person(report, 'Ding')).toMatchObject({
      created: 8,
      completed: 6,
      // TXE-5713, TXE-5714, TXE-5716 to TXE-5719 each count on two days
      handled: 12,
      handledPerDay: 4,
      canceled: 0,
      doneNotClosed: 0,
      openInProgress: 0,
      prsMerged: 0,
    });
    // TXE-5713 and TXE-5714 were created on Nov 2 and completed Nov 3; four more were created Nov 3 and completed Nov 4,
    // and TXE-5766, created Nov 4 by Ding, is unassigned
    expect(cell(report, 'Ding', '2026-11-02')).toMatchObject({
      created: 2,
      completed: 0,
      handled: 2,
    });
    expect(cell(report, 'Ding', '2026-11-03')).toMatchObject({
      created: 5,
      completed: 2,
      handled: 6,
    });
    expect(cell(report, 'Ding', '2026-11-04')).toMatchObject({
      created: 1,
      completed: 4,
      handled: 4,
    });
  });

  test('time to complete runs from the first started state, and from the creation, to the completion (37.7)', async () => {
    const report = await stats('unassigned', '2026-11-02', '2026-11-04');
    // From the recorded get_issue answers of Ding's six issues completed Nov 2 to 4 (.work/w144/expected-close-times.jq);
    // P90 lies halfway between the two longest, TXE-5713 and TXE-5714
    expect(person(report, 'Ding').timeToComplete).toEqual({
      started: { count: 6, mean: 61211166.833333336, median: 53871817.5, p90: 87296871 },
      created: { count: 6, mean: 61968326.666666664, median: 54991627.5, p90: 87296871 },
    });
    // With TXE-5734 and TXE-5766 of Unassigned; nothing was canceled
    expect(report.closeTimes).toMatchObject({ completed: 8, canceled: 0, createdToCanceled: null });
    const row = (await issues('unassigned', { from: '2026-11-02', to: '2026-11-04' })).find(
      (i) => i.identifier === 'TXE-5719',
    );
    expect(row).toMatchObject({ createdToClosed: 46267072, startedToClosed: 43253022 });
  });

  test('an issue with no assignee counts as Unassigned, and its creator still counts for Created', async () => {
    const report = await stats('unassigned', '2026-11-02', '2026-11-04');
    const unassigned = report.people.find((p) => p.key === UNASSIGNED);
    // TXE-5734 completed Nov 3, TXE-5766 Nov 4; both were created by Ding
    expect(unassigned).toMatchObject({ name: 'Unassigned', completed: 2, handled: 2, created: 0 });
    expect(person(report, 'Ding').created).toBe(8);
    expect(report.everyone.map((p) => p.name)).toEqual(['Ding', 'Unassigned']);
  });

  test('the day boundary follows the timezone: the same data counts differently in UTC', async () => {
    const shanghai = await stats('unassigned', '2026-11-02', '2026-11-04');
    const utc = await stats('unassigned', '2026-11-02', '2026-11-04', 'UTC');
    // TXE-5716 to TXE-5719 ran past 16:00 UTC into Nov 4 in Shanghai and completed there; in UTC all of it is Nov 3
    expect(person(shanghai, 'Ding').handled).toBe(12);
    expect(person(utc, 'Ding').handled).toBe(8);
    expect(cell(shanghai, 'Ding', '2026-11-04')).toMatchObject({ completed: 4, handled: 4 });
    expect(cell(utc, 'Ding', '2026-11-04')).toBeUndefined();
    expect(cell(utc, 'Ding', '2026-11-03')).toMatchObject({ completed: 6, handled: 6 });
    expect(utc.timezone).toBe('UTC');
  });

  test('an issue canceled that day counts as Canceled, not Completed', async () => {
    const report = await stats('canceled', '2026-11-02', '2026-11-02');
    expect(person(report, 'Connor Wang')).toMatchObject({ canceled: 1, completed: 0, handled: 1 });
    const [issue] = await issues('canceled', { from: '2026-11-02', to: '2026-11-02' });
    expect(issue).toMatchObject({
      identifier: 'TXE-5635',
      status: 'Canceled',
      statusType: 'canceled',
      canceled: true,
      completed: false,
      completedAt: null,
      doneNotClosed: false,
    });
  });

  test('an open issue whose PRs merged with none open is done but not closed, completed when its latest PR merged', async () => {
    const report = await stats('epic', '2026-11-03', '2026-11-04');
    expect(person(report, 'eluo@txehq.com')).toMatchObject({ completed: 12, doneNotClosed: 1 });
    const notClosed = await issues('epic', {
      from: '2026-11-03',
      to: '2026-11-04',
      doneNotClosed: true,
    });
    expect(notClosed.map((i) => i.identifier)).toEqual(['TXE-5512']);
    const [issue] = notClosed;
    expect(issue).toMatchObject({
      status: 'In Progress',
      statusType: 'started',
      doneNotClosed: true,
      // The later of its two merged PRs, txe#4329 at 13:50:40Z
      completedAt: Date.parse('2026-11-03T13:50:40Z'),
    });
    expect(issue?.prs.map((p) => [p.number, p.state, p.mergedAt])).toEqual([
      [4329, 'closed', Date.parse('2026-11-03T13:50:40Z')],
      [4503, 'closed', Date.parse('2026-11-02T07:39:19Z')],
    ]);
    // It counts as completed on the day that PR merged
    expect(cell(report, 'eluo@txehq.com', '2026-11-03')?.completed).toBe(12);
  });

  test('an issue with an open PR is not done but not closed, and counts as in progress now', async () => {
    const report = await stats('epic', '2026-11-03', '2026-11-04');
    const all = await issues('epic', { from: '2026-10-01', to: '2026-11-04' });
    const open = all.filter((i) => i.prs.some((p) => p.state === 'open'));
    expect(open.map((i) => i.identifier).sort()).toEqual([
      'TXE-4882',
      'TXE-5087',
      'TXE-5480',
      'TXE-5656',
    ]);
    expect(open.every((i) => !i.doneNotClosed && i.completedAt === null)).toBe(true);
    // Started now and not done but not closed: TXE-5512 is started too but is counted as completed
    expect(person(report, 'eluo@txehq.com').openInProgress).toBe(4);
    expect(
      all
        .filter((i) => i.statusType === 'started')
        .map((i) => i.identifier)
        .sort(),
    ).toEqual(['TXE-4862', 'TXE-5480', 'TXE-5512', 'TXE-5656', 'TXE-5668']);
  });

  test('an issue whose only PR was closed without merging is not done but not closed', async () => {
    const report = await stats('unmerged', '2026-09-01', '2026-11-04');
    expect(person(report, 'Ding')).toMatchObject({
      doneNotClosed: 0,
      completed: 0,
      openInProgress: 1,
    });
    const [issue] = await issues('unmerged', {
      from: '2026-09-01',
      to: '2026-11-04',
      people: [await keyOf('Ding', 'unmerged', '2026-09-01', '2026-11-04')],
    });
    expect(issue).toMatchObject({
      identifier: 'TXE-1889',
      statusType: 'started',
      doneNotClosed: false,
    });
    expect(issue?.prs.map((p) => [p.number, p.state, p.mergedAt])).toEqual([
      [2131, 'closed', null],
    ]);
    expect(
      await issues('unmerged', { from: '2026-09-01', to: '2026-11-04', doneNotClosed: true }),
    ).toEqual([]);
  });

  test('a merged PR linked to two issues counts once, with its lines, on the day it merged', async () => {
    const report = await stats('epic', '2026-11-03', '2026-11-04');
    // txe#4329 is linked from TXE-4879 and TXE-5512; 12 issue-PR links merged on Nov 3, 11 distinct PRs
    const linked = (await issues('epic', { from: '2026-11-03', to: '2026-11-03' })).flatMap((i) =>
      i.prs.filter((p) => p.mergedAt !== null).map((p) => `${i.identifier} ${String(p.number)}`),
    );
    expect(linked.filter((l) => l.endsWith(' 4329')).sort()).toEqual([
      'TXE-4879 4329',
      'TXE-5512 4329',
    ]);
    expect(cell(report, 'eluo@txehq.com', '2026-11-03')).toMatchObject({
      prsMerged: 11,
      additions: 18_584,
      deletions: 651,
    });
    expect(person(report, 'eluo@txehq.com')).toMatchObject({
      prsMerged: 11,
      additions: 18_584,
      deletions: 651,
    });
    // Nothing merged on Nov 4
    expect(cell(report, 'eluo@txehq.com', '2026-11-04')?.prsMerged).toBe(0);
  });

  test('every merged PR a person authored counts on the day it merged, linked to an issue or not', async () => {
    const report = await stats('epic', '2026-11-03', '2026-11-04');
    // From the recorded search pages and PR reads: on Nov 3 and 4 (Shanghai) connorwang authored 43 merged PRs and
    // elowenluo 13, of which 19 and 12 on Nov 3. Linear attributes PRs of connorwang to Connor Wang; it attributes none
    // to eluo, whose linked merged PRs are mostly by elowenluo
    expect(person(report, 'Connor Wang')).toMatchObject({
      prsAuthored: 43,
      github: { login: 'connorwang', source: 'linear' },
    });
    expect(person(report, 'eluo@txehq.com')).toMatchObject({
      prsMerged: 11,
      prsAuthored: 13,
      // Commits of the same PRs: the 11 linked hold 96, the 13 authored 122
      commits: 96,
      commitsAuthored: 122,
      commitsUnread: 0,
      commitsAuthoredUnread: 0,
      github: { login: 'elowenluo', source: 'prs' },
    });
    expect(cell(report, 'Connor Wang', '2026-11-03')?.prsAuthored).toBe(19);
    expect(cell(report, 'eluo@txehq.com', '2026-11-03')?.prsAuthored).toBe(12);
    // Issues without an assignee have no author: the second number is unknown, with the reason
    const unassigned = await stats('unassigned', '2026-11-02', '2026-11-04');
    expect(unassigned.people.find((p) => p.key === UNASSIGNED)).toMatchObject({
      prsAuthored: null,
      github: { login: null, reason: 'Issues without an assignee have no author' },
    });
  });

  test('a PR that could not be read is listed under PR problems and counts for nothing', async () => {
    const report = await stats('unreadable', '2026-10-29', '2026-10-31');
    expect(report.prProblems.map((p) => [p.repo, p.number, p.issues])).toEqual([
      ['txehq/action-runner-ops', 113, ['TXE-5358']],
      ['txehq/action-runner-ops', 114, ['TXE-5358']],
    ]);
    expect(report.prProblems[0]?.error).toContain('gh: Not Found (HTTP 404)');
    expect(person(report, 'Connor Wang')).toMatchObject({
      completed: 1,
      handled: 2,
      prsMerged: 0,
      additions: 0,
      deletions: 0,
      doneNotClosed: 0,
    });
    const [issue] = await issues('unreadable', {
      from: '2026-10-29',
      to: '2026-10-31',
      people: [await keyOf('Connor Wang', 'unreadable', '2026-10-29', '2026-10-31')],
    });
    expect(issue?.prs.every((p) => p.error !== null && p.state === null)).toBe(true);
  });

  test('the issues list follows the selection: a person on one day, or every issue of the range', async () => {
    const day = await issues('unassigned', {
      from: '2026-11-02',
      to: '2026-11-04',
      day: '2026-11-02',
      people: [await keyOf('Ding', 'unassigned', '2026-11-02', '2026-11-04')],
    });
    expect(day.map((i) => i.identifier)).toEqual(['TXE-5714', 'TXE-5713']);
    expect(day.every((i) => i.handled && i.created && !i.completed)).toBe(true);
    const range = await issues('unassigned', { from: '2026-11-02', to: '2026-11-04' });
    expect(range).toHaveLength(8);
    // Newest first
    expect(range.map((i) => i.number)).toEqual(
      [...range.map((i) => i.number)].sort((a, b) => b - a),
    );
  });

  test('the range and the first day come from the data', async () => {
    const report = await stats('unassigned', '2026-11-03', '2026-11-04');
    expect(report).toMatchObject({
      team: 'TXE',
      from: '2026-11-03',
      to: '2026-11-04',
      today: '2026-11-04',
      firstDay: '2026-11-02',
      timezone: 'Asia/Shanghai',
    });
    // Nov 2's created issues fall outside the range
    expect(person(report, 'Ding').created).toBe(6);
  });

  test('a people filter keeps only those people, and their creations', async () => {
    const report = await stats('unassigned', '2026-11-02', '2026-11-04', 'Asia/Shanghai', [
      UNASSIGNED,
    ]);
    expect(report.people.map((p) => p.key)).toEqual([UNASSIGNED]);
    expect(report.people[0]).toMatchObject({ completed: 2, handled: 2, created: 0 });
    // Everyone still lists all the people, so the filter can be changed
    expect(report.everyone.map((p) => p.name)).toEqual(['Ding', 'Unassigned']);
  });
});
