import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { Db } from '../db/index.js';
import {
  teamIssuePrs,
  teamIssueStates,
  teamIssues,
  teamPrs,
  teamSync,
  type TeamSyncProgress,
  type TeamSyncStatus,
  teamUsers,
} from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import { type PrRead, type PrRef, prRef, readPr } from './github.js';
import { listTeamIssues, listTeamUsers, readTeamIssue, type TeamIssue } from './linear.js';
import { type TeamSyncView, teamSyncView } from './views.js';

// The Linear stats sync (Contracts 37.2). The listing gives each issue's updatedAt; an issue whose saved updatedAt is the
// same is not read again, so a sync stopped halfway continues where it stopped: each issue is saved with its PRs in one
// transaction once its get_issue and PR reads are done. Merged and closed PRs are read once; open ones (and ones that
// failed with 404 or 403) on every sync

const CONCURRENCY = 4;
// Progress is written and pushed at most this often
const PROGRESS_MS = 500;

export interface TeamSyncOptions {
  db: Db;
  team: string;
  // Tests fix the clock: a sync's start time is the next sync's updatedAt filter, which recorded listings must match
  now?: () => Date;
  // The first sync lists only issues updated after this (the real-tier test reads one day); null lists every issue
  firstUpdatedAfter?: Date | null;
  // Extra list_issues filters; tests list one epic's children (parentId)
  scope?: Record<string, unknown>;
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
    authorLogin: pr.user.login,
    createdAt: new Date(pr.created_at),
    readAt: at,
    readError: null,
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

  // progress is the sync's own object: finish writes its final state, however the sync ended
  async function run(
    id: number,
    updatedAfter: Date | null,
    progress: TeamSyncProgress,
    signal: AbortSignal,
    stop: (reason: unknown) => void,
  ) {
    let lastReport = 0;
    const report = (force = false) => {
      if (!force && Date.now() - lastReport < PROGRESS_MS) return;
      lastReport = Date.now();
      db.update(teamSync).set({ progress, issues: progress.read }).where(eq(teamSync.id, id)).run();
      events.publish({ type: 'team.sync', syncId: id, status: 'running', progress });
    };

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

    // Merged and closed PRs read without an error are not read again
    const kept = new Set(
      db
        .select({ url: teamPrs.url })
        .from(teamPrs)
        .where(and(eq(teamPrs.state, 'closed'), isNull(teamPrs.readError)))
        .all()
        .map((p) => p.url),
    );
    const linear = pLimit(CONCURRENCY);
    const github = pLimit(CONCURRENCY);
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
    const progress: TeamSyncProgress = { listed: 0, toRead: 0, read: 0, prsRead: 0 };
    const { id } = db
      .insert(teamSync)
      .values({ startedAt: now(), status: 'running', updatedAfter, progress, issues: 0 })
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
    const done = run(id, updatedAfter, progress, controller.signal, stop).then(
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
