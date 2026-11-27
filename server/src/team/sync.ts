import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { setTimeout as sleep } from 'node:timers/promises';
import pLimit from 'p-limit';
import type { Db } from '../db/index.js';
import {
  teamIssuePrs,
  teamIssueStates,
  teamIssues,
  teamPrs,
  teamPrTimings,
  teamPrTimingWindows,
  teamRepoSearches,
  teamSync,
  type TeamSyncProgress,
  type TeamSyncStatus,
  teamUsers,
} from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import {
  MERGED_PRS,
  PR_BATCH,
  PR_TIMINGS,
  type PrRead,
  type PrRef,
  prRef,
  prTiming,
  readCommits,
  readPr,
  readRepoName,
  readTimings,
  type SearchedPr,
  searchMergedPrs,
  type TimedPr,
  TIMINGS_BATCH,
} from './github.js';
import {
  listTeamIssues,
  listTeamUsers,
  listUserDiffs,
  readTeamIssue,
  type TeamIssue,
} from './linear.js';
import { mostCommon } from './stats.js';
import { type TeamSyncView, teamSyncView } from './views.js';

// The Linear stats sync (Contracts 37.2). The listing gives each issue's updatedAt; an issue whose saved updatedAt is the
// same is not read again, so a sync stopped halfway continues where it stopped: each issue is saved with its PRs in one
// transaction once its get_issue and PR reads are done. Merged and closed PRs are read once; open ones (and ones that
// failed with 404 or 403) on every sync. Then every merged PR of the team's repos is searched for, each repo from where
// its last search ended to this sync's start; the PRs saved without a commit count get theirs, and Linear users get
// the GitHub login Linear attributes PRs to (37.3). The timed repo's merged PRs get their timings (37.6) newest first,
// side by side with the issue reads, and those whose CI still ran are read again at the end

const CONCURRENCY = 4;
// The timings search walks back from the sync's start a week at a time, saving each week's window once read
const TIMINGS_STEP_MS = 7 * 86_400_000;
// While no issue is saved yet (a first sync still listing), the timings search does not know how far back to go: it
// looks again this often
const FLOOR_POLL_MS = 1_000;
// Progress is written and pushed at most this often
const PROGRESS_MS = 500;
// The earliest day the page can show is the day of the first issue in the timezone setting, which starts at most a day
// before that issue in any timezone: the first search of a repo goes back that far
const DAY_MS = 86_400_000;

export interface TeamSyncOptions {
  db: Db;
  team: string;
  // Tests fix the clock: a sync's start time is the next sync's updatedAt filter, which recorded listings must match
  now?: () => Date;
  // The first sync lists only issues updated after this (the real-tier test reads one day); null lists every issue
  firstUpdatedAfter?: Date | null;
  // Extra list_issues filters; tests list one epic's children (parentId)
  scope?: Record<string, unknown>;
  // The repo whose merged PRs' timings the sync reads (37.6, owner/name); null reads none (the counting tests replay
  // one epic's recorded responses)
  timedRepo?: string | null;
}

const date = (iso: string | null) => (iso === null ? null : new Date(iso));

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function savePr(tx: Db | Tx, ref: PrRef, read: PrRead, at: Date) {
  const key = { url: ref.url, repo: ref.repo, number: ref.number };
  if (!read.ok) {
    // The last good read stays, marked by the error; the error leaves the PR out of the counts
    tx.insert(teamPrs)
      .values({ ...key, readAt: at, readError: read.error })
      .onConflictDoUpdate({ target: teamPrs.url, set: { readAt: at, readError: read.error } })
      .run();
    return;
  }
  const { pr } = read;
  const row = {
    ...key,
    githubId: pr.id,
    state: pr.state,
    draft: pr.draft,
    mergedAt: date(pr.merged_at),
    closedAt: date(pr.closed_at),
    additions: pr.additions,
    deletions: pr.deletions,
    commits: pr.commits,
    authorLogin: pr.user.login,
    createdAt: new Date(pr.created_at),
    readAt: at,
    readError: null,
    readBy: 'pull' as const,
  };
  tx.insert(teamPrs).values(row).onConflictDoUpdate({ target: teamPrs.url, set: row }).run();
}

function saveIssue(db: Db, issue: TeamIssue, refs: PrRef[], reads: [PrRef, PrRead][], at: Date) {
  db.transaction((tx) => {
    for (const [ref, read] of reads) savePr(tx, ref, read, at);
    const row = {
      id: issue.uuid,
      identifier: issue.id,
      number: Number(issue.id.slice(issue.id.lastIndexOf('-') + 1)),
      title: issue.title,
      url: issue.url,
      status: issue.status,
      statusType: issue.statusType,
      assigneeId: issue.assigneeId,
      assigneeName: issue.assignee,
      creatorId: issue.createdById,
      creatorName: issue.createdBy,
      createdAt: new Date(issue.createdAt),
      startedAt: date(issue.startedAt),
      completedAt: date(issue.completedAt),
      canceledAt: date(issue.canceledAt),
      updatedAt: new Date(issue.updatedAt),
      archivedAt: date(issue.archivedAt),
      syncedAt: at,
    };
    tx.insert(teamIssues).values(row).onConflictDoUpdate({ target: teamIssues.id, set: row }).run();
    tx.delete(teamIssueStates).where(eq(teamIssueStates.issueId, issue.uuid)).run();
    if (issue.stateHistory.length > 0) {
      tx.insert(teamIssueStates)
        .values(
          issue.stateHistory.map((s, seq) => ({
            issueId: issue.uuid,
            seq,
            name: s.state.name,
            type: s.state.type,
            startedAt: new Date(s.startedAt),
            endedAt: date(s.endedAt),
          })),
        )
        .run();
    }
    tx.delete(teamIssuePrs).where(eq(teamIssuePrs.issueId, issue.uuid)).run();
    if (refs.length > 0) {
      tx.insert(teamIssuePrs)
        .values(refs.map((r) => ({ issueId: issue.uuid, prUrl: r.url })))
        .run();
    }
  });
}

// The timings search stops this long before the sync's start: GitHub's search index lists a merged PR a little after
// the merge, and a window once read is not searched again (37.6)
const SEARCH_LAG_MS = 10 * 60_000;
const SECOND = 1_000;

function timingRow(repo: string, pr: TimedPr, at: Date) {
  const t = prTiming(pr);
  const ms = (v: number | null) => (v === null ? null : new Date(v));
  return {
    url: pr.url,
    repo,
    number: pr.number,
    title: pr.title,
    authorLogin: pr.author?.login ?? null,
    createdAt: new Date(pr.createdAt),
    readyAt: ms(t.readyAt),
    mergedAt: new Date(pr.mergedAt),
    ciStartedAt: ms(t.ciStartedAt),
    ciEndedAt: ms(t.ciEndedAt),
    ciRuns: t.ciRuns,
    ciAllSucceeded: t.ciAllSucceeded,
    slowestWorkflow: t.slowest?.workflow ?? null,
    slowestMs: t.slowest?.ms ?? null,
    slowestAfterMerge: t.slowest?.afterMerge ?? null,
    readAt: at,
    readError: null,
  };
}

// Windows to the second with both ends included, joined where they meet or overlap
export function joinWindows(windows: [number, number][]): [number, number][] {
  const joined: [number, number][] = [];
  for (const [from, to] of [...windows].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1);
    if (last !== undefined && from <= last[1] + SECOND) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

// The parts of from..to (ms, both included) no saved window of repo covers
function timingGaps(db: Db, repo: string, from: number, to: number): [number, number][] {
  const end = Math.floor(to / SECOND) * SECOND;
  let cursor = Math.floor(from / SECOND) * SECOND;
  const gaps: [number, number][] = [];
  const saved = db
    .select()
    .from(teamPrTimingWindows)
    .where(eq(teamPrTimingWindows.repo, repo))
    .all()
    .map((w): [number, number] => [w.from.getTime(), w.to.getTime()]);
  for (const [start, stop] of joinWindows(saved)) {
    if (cursor > end) break;
    if (start > cursor) gaps.push([cursor, Math.min(start - SECOND, end)]);
    cursor = Math.max(cursor, stop + SECOND);
  }
  if (cursor <= end) gaps.push([cursor, end]);
  return gaps;
}

function saveTimingWindow(db: Db, repo: string, from: number, to: number) {
  db.transaction((tx) => {
    const saved = tx
      .select()
      .from(teamPrTimingWindows)
      .where(eq(teamPrTimingWindows.repo, repo))
      .all()
      .map((w): [number, number] => [w.from.getTime(), w.to.getTime()]);
    tx.delete(teamPrTimingWindows).where(eq(teamPrTimingWindows.repo, repo)).run();
    tx.insert(teamPrTimingWindows)
      .values(
        joinWindows([...saved, [from, to]]).map(([f, t]) => ({
          repo,
          from: new Date(f),
          to: new Date(t),
        })),
      )
      .run();
  });
}

// The distinct PRs an issue's attachments link to
function issuePrs(issue: TeamIssue): PrRef[] {
  const refs = new Map<string, PrRef>();
  for (const a of issue.attachments) {
    const ref = prRef(a.url);
    if (ref !== null) refs.set(ref.url, ref);
  }
  return [...refs.values()];
}

// A sync stopped by a server shutdown
class Shutdown extends Error {
  constructor() {
    super('The server shut down during the sync');
  }
}

// The timings search of a sync: issuesRead tells it every issue is saved (the floor is final); done settles when it ends
interface Timings {
  issuesRead: boolean;
  done: Promise<void>;
}

interface Running {
  id: number;
  stop: (reason: unknown) => void;
  done: Promise<TeamSyncView>;
}

export function createTeamSync({
  db,
  team,
  now = () => new Date(),
  firstUpdatedAfter = null,
  scope = {},
  timedRepo = null,
}: TeamSyncOptions) {
  // A sync left running by a process that ended without shutting down
  db.update(teamSync)
    .set({ status: 'interrupted', error: 'The server stopped during the sync' })
    .where(eq(teamSync.status, 'running'))
    .run();

  let running: Running | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Saves made by this process: readers keep what they loaded until it changes
  let saves = 0;

  const row = (id: number) => {
    const r = db.select().from(teamSync).where(eq(teamSync.id, id)).get();
    if (r === undefined) throw new Error(`Sync ${String(id)} does not exist`);
    return r;
  };

  // progress is the sync's own object: finish writes its final state, however the sync ended. until is the sync's
  // start: the search reads PRs merged up to then. The timings search runs beside the other steps: whichever fails
  // first stops the other, and the sync ends only once both have
  async function run(
    id: number,
    updatedAfter: Date | null,
    until: number,
    progress: TeamSyncProgress,
    signal: AbortSignal,
    stop: (reason: unknown) => void,
  ) {
    const timings: Timings = { issuesRead: false, done: Promise.resolve() };
    try {
      await steps(id, updatedAfter, until, progress, signal, stop, timings);
    } catch (error) {
      stop(error);
      throw error;
    } finally {
      timings.issuesRead = true;
      await timings.done.catch(() => undefined);
    }
  }

  async function steps(
    id: number,
    updatedAfter: Date | null,
    until: number,
    progress: TeamSyncProgress,
    signal: AbortSignal,
    stop: (reason: unknown) => void,
    timings: Timings,
  ) {
    let lastReport = 0;
    const report = (force = false) => {
      if (!force && Date.now() - lastReport < PROGRESS_MS) return;
      lastReport = Date.now();
      db.update(teamSync).set({ progress, issues: progress.read }).where(eq(teamSync.id, id)).run();
      events.publish({ type: 'team.sync', syncId: id, status: 'running', progress });
    };
    // A gh account outside the team's org reads every private PR as Not Found (HTTP 404), which the sync records as a
    // PR GitHub cannot find and leaves out of the counts: the timed repo must be visible, or the sync fails saying why
    if (timedRepo !== null && (await readRepoName(timedRepo)) === null) {
      throw new Error(
        `The active gh account cannot see ${timedRepo}, so every private PR would read as Not Found. Check it with gh auth status and switch to an account with access: gh auth switch --hostname github.com --user <login>`,
      );
    }
    const linear = pLimit(CONCURRENCY);
    const github = pLimit(CONCURRENCY);

    // The earliest day the page can show starts at most a day before the first saved issue
    const floor = () => {
      const first = db
        .select({ at: sql<number | null>`min(${teamIssues.createdAt})` })
        .from(teamIssues)
        .get()?.at;
      return first == null ? null : first - DAY_MS;
    };
    const saveTiming = (repo: string, tx: Tx, pr: TimedPr, at: Date) => {
      const row = timingRow(repo, pr, at);
      tx.insert(teamPrTimings)
        .values(row)
        .onConflictDoUpdate({ target: teamPrTimings.url, set: row })
        .run();
    };

    // Timings of the timed repo's merged PRs (37.6), newest first: from a little before this sync's start back to the
    // earliest day the page can show, a week at a time, only the parts no saved window covers. Each page is saved as it
    // is read and each window once all its PRs are. While issues are still being read the first saved issue can move
    // earlier, so the search waits for it at the end instead of stopping
    const searchTimings = async (repo: string) => {
      let end = until - SEARCH_LAG_MS;
      for (;;) {
        signal.throwIfAborted();
        // Read before the floor: once every issue is saved, the floor read after it is final
        const issuesRead = timings.issuesRead;
        const from = floor();
        if (from === null || end < from) {
          if (issuesRead) return;
          await sleep(FLOOR_POLL_MS, undefined, { signal });
          continue;
        }
        const start = Math.max(end - TIMINGS_STEP_MS + SECOND, from);
        for (const [gapFrom, gapTo] of timingGaps(db, repo, start, end).reverse()) {
          await searchMergedPrs(
            PR_TIMINGS,
            repo,
            gapFrom,
            gapTo,
            github,
            (prs) => {
              if (prs.length === 0) return;
              const at = now();
              db.transaction((tx) => {
                for (const pr of prs) saveTiming(repo, tx, pr, at);
              });
              saves += 1;
              progress.timingsRead += prs.length;
              report();
            },
            signal,
            (windowFrom, windowTo) => {
              saveTimingWindow(db, repo, windowFrom, windowTo);
            },
          );
        }
        end = start - SECOND;
      }
    };
    if (timedRepo !== null) {
      timings.done = searchTimings(timedRepo).catch((error: unknown) => {
        stop(error);
        throw error;
      });
      // Handled here as well: a failure stops the other steps through stop, and is thrown where done is awaited
      timings.done.catch(() => undefined);
    }

    const users = await listTeamUsers();
    db.transaction((tx) => {
      for (const u of users) {
        const user = { id: u.id, name: u.name, email: u.email, active: u.isActive };
        tx.insert(teamUsers)
          .values(user)
          .onConflictDoUpdate({ target: teamUsers.id, set: user })
          .run();
      }
    });

    const listed = await listTeamIssues(
      team,
      scope,
      updatedAfter,
      (n) => {
        progress.listed = n;
        report();
      },
      signal,
    );
    const saved = new Map(
      db
        .select({ identifier: teamIssues.identifier, updatedAt: teamIssues.updatedAt })
        .from(teamIssues)
        .all()
        .map((i) => [i.identifier, i.updatedAt.getTime()]),
    );
    const toRead = listed.filter((i) => saved.get(i.id) !== Date.parse(i.updatedAt));
    progress.toRead = toRead.length;
    report(true);

    // Merged and closed PRs read whole without an error are not read again
    const kept = new Set(
      db
        .select({ url: teamPrs.url })
        .from(teamPrs)
        .where(
          and(eq(teamPrs.state, 'closed'), isNull(teamPrs.readError), eq(teamPrs.readBy, 'pull')),
        )
        .all()
        .map((p) => p.url),
    );
    // One read per PR per sync, shared by the issues linking to it
    const prReads = new Map<string, Promise<PrRead>>();
    const readOnce = (ref: PrRef) => {
      const existing = prReads.get(ref.url);
      if (existing !== undefined) return existing;
      const read = github(async () => {
        signal.throwIfAborted();
        const result = await readPr(ref);
        progress.prsRead += 1;
        report();
        return result;
      });
      prReads.set(ref.url, read);
      return read;
    };
    // The first failure stops the tasks not started yet; the sync ends once the started ones settle
    const settle = async (tasks: Promise<void>[]) => {
      const results = await Promise.allSettled(
        tasks.map((t) =>
          t.catch((error: unknown) => {
            stop(error);
            throw error;
          }),
        ),
      );
      signal.throwIfAborted();
      for (const r of results) if (r.status === 'rejected') throw r.reason;
    };

    // Only the get_issue call holds a Linear slot: an issue waiting for its PRs does not keep the next issue from being read
    await settle(
      toRead.map(async (item) => {
        const issue = await linear(() => {
          signal.throwIfAborted();
          return readTeamIssue(item.id);
        });
        const refs = issuePrs(issue);
        const reads = await Promise.all(
          refs
            .filter((r) => !kept.has(r.url))
            .map(async (r): Promise<[PrRef, PrRead]> => [r, await readOnce(r)]),
        );
        signal.throwIfAborted();
        saveIssue(db, issue, refs, reads, now());
        saves += 1;
        progress.read += 1;
        report();
      }),
    );
    // Every issue is saved: the timings search now knows how far back to go
    timings.issuesRead = true;

    // Open and failed PRs of the issues that did not change
    const again = db
      .select({ url: teamPrs.url, repo: teamPrs.repo, number: teamPrs.number })
      .from(teamPrs)
      .where(or(eq(teamPrs.state, 'open'), isNotNull(teamPrs.readError)))
      .all()
      .filter((p) => !prReads.has(p.url));
    await settle(
      again.map(async (ref) => {
        const read = await readOnce(ref);
        signal.throwIfAborted();
        savePr(db, ref, read, now());
        saves += 1;
      }),
    );

    // Every merged PR of the team's repos: the repos of the PRs read without an error, under their current names
    const names = db
      .selectDistinct({ repo: teamPrs.repo })
      .from(teamPrs)
      .where(isNull(teamPrs.readError))
      .all()
      .map((r) => r.repo);
    const repos = new Set<string>();
    await settle(
      names.map(async (name) => {
        const current = await github(() => {
          signal.throwIfAborted();
          return readRepoName(name);
        });
        if (current !== null) repos.add(current);
      }),
    );
    const searched = new Map(
      db
        .select()
        .from(teamRepoSearches)
        .all()
        .map((r) => [r.repo, r.searchedUntil.getTime()]),
    );
    const first = db
      .select({ at: sql<number | null>`min(${teamIssues.createdAt})` })
      .from(teamIssues)
      .get()?.at;
    // A PR saved under another URL (a renamed repo) is the same PR by its GitHub id
    const savedPrs = db
      .select({ url: teamPrs.url, githubId: teamPrs.githubId })
      .from(teamPrs)
      .all();
    const savedUrls = new Set(savedPrs.map((p) => p.url));
    const savedIds = new Set(savedPrs.map((p) => p.githubId));
    const saveSearched = (repo: string, prs: SearchedPr[]) => {
      const fresh = prs.filter((p) => !savedUrls.has(p.url) && !savedIds.has(p.databaseId));
      if (fresh.length === 0) return;
      const at = now();
      db.transaction((tx) => {
        for (const p of fresh) {
          tx.insert(teamPrs)
            .values({
              url: p.url,
              repo,
              number: p.number,
              githubId: p.databaseId,
              state: 'closed',
              draft: false,
              mergedAt: new Date(p.mergedAt),
              closedAt: new Date(p.closedAt),
              commits: p.commits.totalCount,
              authorLogin: p.author?.login ?? null,
              createdAt: new Date(p.createdAt),
              readAt: at,
              readError: null,
              readBy: 'search',
            })
            .run();
          savedUrls.add(p.url);
          savedIds.add(p.databaseId);
        }
      });
      saves += 1;
      progress.prsSearched += fresh.length;
      report();
    };
    await settle(
      [...repos].map(async (repo) => {
        const from = searched.get(repo) ?? (first == null ? null : first - DAY_MS);
        if (from === null) throw new Error(`${repo} has saved PRs but no issue is saved`);
        await searchMergedPrs(
          MERGED_PRS,
          repo,
          from,
          until,
          github,
          (prs) => {
            saveSearched(repo, prs);
          },
          signal,
        );
        signal.throwIfAborted();
        const row = { repo, searchedUntil: new Date(until) };
        db.insert(teamRepoSearches)
          .values(row)
          .onConflictDoUpdate({ target: teamRepoSearches.repo, set: row })
          .run();
      }),
    );

    // Saved PRs read again by number, size to a request; each batch is saved in one transaction as it is read, so a sync
    // that fails halfway leaves the rest to the next. read fails the sync on anything but a PR GitHub cannot find or
    // show, which save records as that PR's read error (37.2)
    const reread = async <R>(
      refs: PrRef[],
      size: number,
      read: (refs: PrRef[]) => Promise<[PrRef, R][]>,
      save: (tx: Tx, ref: PrRef, read: R) => void,
      onBatch: (refs: PrRef[]) => void,
    ) => {
      const batches: PrRef[][] = [];
      for (let i = 0; i < refs.length; i += size) batches.push(refs.slice(i, i + size));
      await settle(
        batches.map(async (batch) => {
          const reads = await github(() => {
            signal.throwIfAborted();
            return read(batch);
          });
          signal.throwIfAborted();
          db.transaction((tx) => {
            for (const [ref, r] of reads) save(tx, ref, r);
          });
          saves += 1;
          onBatch(batch);
          report();
        }),
      );
    };

    // Commit counts of the PRs saved before team_prs held them
    const uncounted = db
      .select({ url: teamPrs.url, repo: teamPrs.repo, number: teamPrs.number })
      .from(teamPrs)
      .where(and(isNull(teamPrs.commits), isNull(teamPrs.readError)))
      .orderBy(teamPrs.repo, teamPrs.number)
      .all();
    progress.commitsToRead = uncounted.length;
    report(true);
    await reread(
      uncounted,
      PR_BATCH,
      readCommits,
      (tx, ref, read) => {
        tx.update(teamPrs)
          .set(read.ok ? { commits: read.commits } : { readAt: now(), readError: read.error })
          .where(eq(teamPrs.url, ref.url))
          .run();
      },
      (refs) => {
        progress.commitsRead += refs.length;
      },
    );

    // Once the newest-first timings search is done, the timed repo's saved PRs whose CI still ran when they were read or
    // that were saved before the slowest run was kept are read again by number, newest first (37.6)
    await timings.done;
    if (timedRepo !== null) {
      const again = db
        .select({ url: teamPrTimings.url, repo: teamPrTimings.repo, number: teamPrTimings.number })
        .from(teamPrTimings)
        .where(
          and(
            eq(teamPrTimings.repo, timedRepo),
            gt(teamPrTimings.ciRuns, 0),
            isNull(teamPrTimings.readError),
            or(isNull(teamPrTimings.ciEndedAt), isNull(teamPrTimings.slowestWorkflow)),
          ),
        )
        .orderBy(desc(teamPrTimings.number))
        .all();
      await reread(
        again,
        TIMINGS_BATCH,
        readTimings,
        (tx, ref, read) => {
          if (read.ok) saveTiming(timedRepo, tx, read.pr, now());
          else {
            tx.update(teamPrTimings)
              .set({ readAt: now(), readError: read.error })
              .where(eq(teamPrTimings.url, ref.url))
              .run();
          }
        },
        (refs) => {
          progress.timingsRead += refs.length;
        },
      );
    }

    // The GitHub login of each Linear user Linear attributes merged PRs to: their author, as saved or read from GitHub
    const unlinked = db
      .select({ id: teamUsers.id })
      .from(teamUsers)
      .where(isNull(teamUsers.githubLogin))
      .all();
    const authorOf = (url: string) =>
      db
        .select({ login: teamPrs.authorLogin })
        .from(teamPrs)
        .where(and(eq(teamPrs.url, url), isNull(teamPrs.readError)))
        .get()?.login ?? null;
    await settle(
      unlinked.map(async ({ id }) => {
        const urls = await linear(() => {
          signal.throwIfAborted();
          return listUserDiffs(id);
        });
        let login = mostCommon(urls.flatMap((u) => authorOf(u) ?? []));
        const ref = urls.map(prRef).find((r) => r !== null);
        if (login === null && ref !== undefined) {
          const read = await readOnce(ref);
          if (read.ok) login = read.pr.user.login;
        }
        signal.throwIfAborted();
        if (login === null) return;
        db.update(teamUsers).set({ githubLogin: login }).where(eq(teamUsers.id, id)).run();
        saves += 1;
      }),
    );
  }

  function finish(
    id: number,
    status: TeamSyncStatus,
    error: string | null,
    progress: TeamSyncProgress,
  ) {
    db.update(teamSync)
      .set({ status, error, progress, issues: progress.read, endedAt: now() })
      .where(eq(teamSync.id, id))
      .run();
    events.publish({ type: 'team.sync', syncId: id, status, progress });
    return teamSyncView(row(id));
  }

  // Starts a sync in the background; done settles with its final state (a failure is recorded, not thrown)
  function begin(): { view: TeamSyncView; done: Promise<TeamSyncView> } {
    if (running !== null) {
      throw new HttpError(
        409,
        `A sync is already running (started ${row(running.id).startedAt.toISOString()})`,
      );
    }
    const last = db
      .select({ startedAt: teamSync.startedAt })
      .from(teamSync)
      .where(eq(teamSync.status, 'succeeded'))
      .orderBy(desc(teamSync.id))
      .limit(1)
      .get();
    const updatedAfter = last?.startedAt ?? firstUpdatedAfter;
    const progress: TeamSyncProgress = {
      listed: 0,
      toRead: 0,
      read: 0,
      prsRead: 0,
      prsSearched: 0,
      commitsToRead: 0,
      commitsRead: 0,
      timingsRead: 0,
    };
    const startedAt = now();
    const { id } = db
      .insert(teamSync)
      .values({ startedAt, status: 'running', updatedAfter, progress, issues: 0 })
      .returning({ id: teamSync.id })
      .get();
    const controller = new AbortController();
    // The first failure (or the shutdown) is the sync's error; later ones follow from it
    let cause: unknown;
    const stop = (reason: unknown) => {
      cause ??= reason;
      controller.abort(reason);
    };
    events.publish({ type: 'team.sync', syncId: id, status: 'running', progress });
    const done = run(id, updatedAfter, startedAt.getTime(), progress, controller.signal, stop).then(
      () => finish(id, 'succeeded', null, progress),
      (error: unknown) => {
        const reason = cause ?? error;
        return finish(
          id,
          reason instanceof Shutdown ? 'interrupted' : 'failed',
          reason instanceof Error ? reason.message : String(reason),
          progress,
        );
      },
    );
    const current: Running = { id, stop, done };
    running = current;
    void done.then(() => {
      if (running === current) running = null;
    });
    return { view: teamSyncView(row(id)), done };
  }

  const lastWith = (status: TeamSyncStatus | null) => {
    const r = db
      .select()
      .from(teamSync)
      .where(status === null ? undefined : eq(teamSync.status, status))
      .orderBy(desc(teamSync.id))
      .limit(1)
      .get();
    return r === undefined ? null : teamSyncView(r);
  };

  return {
    begin,
    saves: () => saves,
    latest: () => lastWith(null),
    lastSucceeded: () => lastWith('succeeded'),
    // At startup and every intervalMs; a scheduled sync is skipped while one runs
    schedule(intervalMs: number) {
      const tick = () => {
        if (running === null) begin();
      };
      tick();
      timer = setInterval(tick, intervalMs);
    },
    async shutdown() {
      clearInterval(timer);
      const current = running;
      if (current === null) return;
      current.stop(new Shutdown());
      await current.done;
    },
  };
}

export type TeamSync = ReturnType<typeof createTeamSync>;
