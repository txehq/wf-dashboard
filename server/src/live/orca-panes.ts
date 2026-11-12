import fs from 'node:fs';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { execaSync } from 'execa';
import type { Db } from '../db/index.js';
import { liveEvents, liveProcesses, liveSessions } from '../db/schema.js';
import { events } from '../events.js';
import type { RemoteHost } from '../remote/hosts.js';
import { isPaneHandle } from '../orca/topology.js';
import { sshScript } from '../remote/ssh.js';

// Processes of agents running in an Orca pane (Contracts 35.3): they keep running when the dashboard exits, so startup
// reconciliation leaves them alone and the topology sync reattaches or ends them. A pane that vanished while the server
// was down is found here (W116): Orca no longer lists its terminal handle and its pid is gone, so the process is
// recorded as exited. A handle that is gone while the pid is still alive only gets a warning; nothing is killed.
// Panes on an SSH host follow the same rule, with the pid checked on that host over ssh (W117)

// The process is an agent in an attached Orca terminal (its start or resume event has orca): it does not end with the
// dashboard and is reattached or ended by the sync. Processes run in the dashboard after a resume do not have it
export function orcaPaneEvent(processId: SQL) {
  return sql`select 1 from ${liveEvents} where ${liveEvents.processId} = ${processId} and ${liveEvents.kind} in ('start', 'resume') and json_extract(${liveEvents.payload}, '$.orca') is not null`;
}

// A running process bound to an Orca pane, with the handle recorded in its own start or resume event
export interface PaneProcess {
  processId: number;
  liveId: string;
  handle: string;
  pid: number | null;
  startedAt: Date;
}

// Running pane processes of items on this machine (hostId null) or on one SSH host
export function runningPaneProcesses(db: Db, hostId: string | null): PaneProcess[] {
  const rows = db
    .select({
      processId: liveProcesses.id,
      liveId: liveProcesses.liveId,
      pid: liveProcesses.pid,
      startedAt: liveProcesses.startedAt,
      hostId: liveSessions.hostId,
      handle: sql<
        string | null
      >`(select json_extract(${liveEvents.payload}, '$.orca.handle') from ${liveEvents} where ${liveEvents.processId} = ${liveProcesses.id} and ${liveEvents.kind} in ('start', 'resume') order by ${liveEvents.id} desc limit 1)`,
    })
    .from(liveProcesses)
    .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
    .where(
      and(
        eq(liveProcesses.status, 'running'),
        sql`exists (${orcaPaneEvent(sql`${liveProcesses.id}`)})`,
      ),
    )
    .all();
  return rows.flatMap((r) =>
    r.hostId === hostId && r.handle !== null
      ? [
          {
            processId: r.processId,
            liveId: r.liveId,
            handle: r.handle,
            pid: r.pid,
            startedAt: r.startedAt,
          },
        ]
      : [],
  );
}

// Time this machine last booted: a process recorded as started before it cannot still be running, whatever process
// holds its pid now
export function bootTime(): Date {
  if (process.platform === 'linux') {
    const line = fs
      .readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('btime '));
    if (line === undefined) throw new Error('/proc/stat has no btime line');
    return new Date(Number(line.slice('btime '.length).trim()) * 1000);
  }
  const out = execaSync('sysctl', ['-n', 'kern.boottime']).stdout;
  const seconds = /sec\s*=\s*(\d+)/.exec(out);
  if (seconds === null) throw new Error(`sysctl kern.boottime has no sec field: ${out}`);
  return new Date(Number(seconds[1]) * 1000);
}

// Whether the recorded process is still running. process.kill(pid, 0) reports this by throwing and is the only API for
// it, so ESRCH (no such process) and EPERM (someone else's process) are read as the answer and anything else is a real
// failure. A record older than the boot time is never alive: after a reboot that pid belongs to a different process
export function paneProcessAlive(pid: number | null, startedAt: Date, boot: Date): boolean {
  if (pid === null) return false;
  if (startedAt.getTime() < boot.getTime()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

const pidText = (pid: number | null) =>
  pid === null ? 'no recorded pid' : `process ${String(pid)}`;

// One pane process Orca no longer lists: with the pid gone it becomes exited with an exit event; with the pid still
// alive it keeps running and one warning event records that the pane is gone. Returns whether the process was ended
export function reconcilePaneProcess(db: Db, p: PaneProcess, alive: boolean): boolean {
  const gone = `The Orca pane ${p.handle} is gone`;
  if (alive) {
    const warned = db
      .select({ id: liveEvents.id })
      .from(liveEvents)
      .where(and(eq(liveEvents.processId, p.processId), eq(liveEvents.kind, 'orca-pane-gone')))
      .get();
    if (warned !== undefined) return false;
    db.insert(liveEvents)
      .values({
        liveId: p.liveId,
        processId: p.processId,
        at: new Date(),
        kind: 'orca-pane-gone',
        payload: {
          handle: p.handle,
          pid: p.pid,
          pidAlive: true,
          reason: `${gone}, ${pidText(p.pid)} is still running: the process is left running`,
        },
      })
      .run();
    events.publish({ type: 'live.updated', liveId: p.liveId });
    return false;
  }
  const endedAt = new Date();
  const error = `${gone} and ${pidText(p.pid)} is not running`;
  db.update(liveProcesses)
    .set({ status: 'exited', endedAt, error })
    .where(eq(liveProcesses.id, p.processId))
    .run();
  db.insert(liveEvents)
    .values({
      liveId: p.liveId,
      processId: p.processId,
      at: endedAt,
      kind: 'exit',
      payload: { exitCode: null, signal: null, error },
    })
    .run();
  events.publish({ type: 'live.updated', liveId: p.liveId });
  return true;
}

// Pane processes whose handle Orca no longer lists. handles null means Orca is not running, so every pane is gone;
// owned processes are held by a controller and end with their own terminal. A worker Orca runs without a pane is not
// in any terminal list to begin with (Contracts 35.3): its absence means nothing and the sync ends it from the Run
function vanished(
  db: Db,
  hostId: string | null,
  handles: Set<string> | null,
  owned: (liveId: string) => boolean,
): PaneProcess[] {
  return runningPaneProcesses(db, hostId).filter(
    (p) => isPaneHandle(p.handle) && !owned(p.liveId) && handles?.has(p.handle) !== true,
  );
}

// Every running pane process of this machine whose handle Orca no longer lists
export function reconcileVanishedPanes(
  db: Db,
  handles: Set<string> | null,
  owned: (liveId: string) => boolean,
): void {
  const pending = vanished(db, null, handles, owned);
  if (pending.length === 0) return;
  const boot = bootTime();
  for (const p of pending) reconcilePaneProcess(db, p, paneProcessAlive(p.pid, p.startedAt, boot));
}

// Boot time of an SSH host and the pids running on it, read in one command (server/remote-scripts/pane-pids.sh)
export async function remotePids(
  host: RemoteHost,
  pids: number[],
): Promise<{ boot: Date; alive: Set<number> }> {
  const out = await sshScript(
    host.target,
    'pane-pids.sh',
    pids.map((p) => String(p)),
  );
  const lines = out.split('\n');
  const boot = lines.find((l) => l.startsWith('boot '));
  if (boot === undefined) throw new Error(`${host.target} reported no boot time: ${out}`);
  return {
    boot: new Date(Number(boot.slice('boot '.length).trim()) * 1000),
    alive: new Set(
      lines.filter((l) => l.startsWith('alive ')).map((l) => Number(l.slice('alive '.length))),
    ),
  };
}

// Every running pane process of one SSH host whose handle the Orca on that host no longer lists: the rule of this
// machine (W116) with the pid checked over ssh
export async function reconcileVanishedRemotePanes(
  db: Db,
  host: RemoteHost,
  handles: Set<string> | null,
  owned: (liveId: string) => boolean,
): Promise<void> {
  const pending = vanished(db, host.id, handles, owned);
  if (pending.length === 0) return;
  const { boot, alive } = await remotePids(
    host,
    pending.flatMap((p) => (p.pid === null ? [] : [p.pid])),
  );
  for (const p of pending) {
    reconcilePaneProcess(db, p, remotePaneProcessAlive(p, boot, alive));
  }
}

// Whether a pane process recorded for an SSH host is still running there, by the rule of paneProcessAlive: a record
// older than the host's boot time is never alive, whatever process holds that pid now
export function remotePaneProcessAlive(p: PaneProcess, boot: Date, alive: Set<number>): boolean {
  if (p.pid === null) return false;
  if (p.startedAt.getTime() < boot.getTime()) return false;
  return alive.has(p.pid);
}
