import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { RemoteHost } from './hosts.js';
import { rsyncResult } from './ssh.js';

// Remote sessions are synced back to this machine (Contracts 31.6) under data/remote/<hostId>/, laid out by remote path
export function localCopyOf(remoteDir: string, hostId: string, remotePath: string): string {
  return path.join(remoteDir, hostId, ...remotePath.split('/').filter((p) => p !== ''));
}

// Copy one remote session to its local copy: the jsonl is append-only, only new bytes are fetched (--append); Claude Code's
// same-named directory (subagents and tool-results) is copied too. Nothing is copied before the remote jsonl exists. Returns rsync's output on failure.
// Claude Code writes spill files and subagents before the jsonl records that reference them; the copy follows the same order in three
// passes: tool-results, the whole same-named directory (subagents and spill files that appeared meanwhile), then the jsonl. The local
// incremental import may read a half-copied copy at any time, so files referenced by jsonl records are already local; when a subagent
// record references a new spill file between passes, the import stops before that record until the next sync brings it (ingest's missingSpill)
export async function pullSession(
  host: RemoteHost,
  remoteDir: string,
  remotePath: string,
): Promise<{ local: string; error: string | null }> {
  const local = localCopyOf(remoteDir, host.id, remotePath);
  const rsync = `--rsync-path=${host.tool('rsync')}`;
  if (path.posix.basename(remotePath).startsWith('rollout-')) {
    // Codex rollout: a single file
    fs.mkdirSync(path.dirname(local), { recursive: true });
    return {
      local,
      error: await pull(host, [rsync, '--append', `${host.target}:${remotePath}`, local]),
    };
  }
  // Claude Code: <projects>/<project>/<id>.jsonl and <projects>/<project>/<id>/; include rules take only these from projects (missing parts are no error)
  const project = path.posix.dirname(remotePath);
  const projects = path.posix.dirname(project);
  const name = path.posix.basename(project);
  const id = path.posix.basename(remotePath, '.jsonl');
  const localProjects = path.dirname(path.dirname(local));
  fs.mkdirSync(localProjects, { recursive: true });
  const steps = [
    [`/${name}/${id}/`, `/${name}/${id}/tool-results/`, `/${name}/${id}/tool-results/**`],
    [`/${name}/${id}/`, `/${name}/${id}/**`],
    [`/${name}/${id}.jsonl`],
  ];
  for (const rules of steps) {
    const error = await pull(host, [
      rsync,
      '--append',
      ...[`/${name}/`, ...rules].map((r) => `--include=${r}`),
      '--exclude=*',
      `${host.target}:${projects}/`,
      `${localProjects}/`,
    ]);
    if (error !== null) return { local, error };
  }
  return { local, error: null };
}

async function pull(host: RemoteHost, args: string[]): Promise<string | null> {
  const result = await rsyncResult(host.target, args);
  return result.exitCode === 0 ? null : `${result.stderr}${result.stdout}`.trim();
}

// After the copy is imported, record its origin (sessions.host_id and remote_path, Contracts 31.6)
export function markRemoteSession(db: Db, hostId: string, local: string, remotePath: string) {
  db.update(sessions)
    .set({ hostId, remotePath })
    .where(and(eq(sessions.filePath, local), isNull(sessions.hostId)))
    .run();
}

// Output and time of the latest sync failure (Contracts 31.6): the state of this sync, cleared when the next sync succeeds
export interface SyncFailure {
  message: string;
  at: number;
}

// Sync of one interactive remote session: every intervalMs while connected, immediately on reconnect; one more sync when the process ends, then stop.
// Each finished sync passes its result to onResult (null on success); syncs interrupted by a disconnect or by server shutdown are not results
export class RemoteSessionSync {
  private remotePath: string | null = null;
  private busy: Promise<void> | null = null;
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  // Server shutdown: the remote process keeps running, the sync in progress ends with the server
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly host: RemoteHost,
    private readonly remoteDir: string,
    private readonly connected: () => boolean,
    private readonly onResult: (failure: SyncFailure | null) => void,
    intervalMs: number,
  ) {
    this.timer = setInterval(() => {
      void this.syncNow();
    }, intervalMs);
  }

  // Start syncing this remote session (the SessionStart hook's transcript_path, or a Codex rollout); returns the local copy's path
  follow(remotePath: string): string {
    this.remotePath = remotePath;
    void this.syncNow();
    return localCopyOf(this.remoteDir, this.host.id, remotePath);
  }

  get following(): string | null {
    return this.remotePath;
  }

  // Sync once; if a sync is running, wait for it. No sync while disconnected (force is the final sync after the process ends: the
  // terminal's connection ended with the tmux session, the host is still reachable)
  async syncNow(force = false): Promise<void> {
    if (this.busy !== null) {
      await this.busy;
      if (!force) return;
    }
    const remotePath = this.remotePath;
    if (remotePath === null || this.closed || (!force && !this.connected())) return;
    this.busy = pullSession(this.host, this.remoteDir, remotePath).then(({ local, error }) => {
      this.busy = null;
      if (error !== null) {
        // The connection dropped during the sync: sync again on reconnect
        if (this.stopping || (!force && !this.connected())) return;
        this.onResult({
          message: `Sync ${this.host.label}:${remotePath} failed: ${error}`,
          at: Date.now(),
        });
        return;
      }
      if (fs.existsSync(local)) this.mark();
      this.onResult(null);
    });
    return this.busy;
  }

  // Stop syncing: final means the process ended (sync one last time); on server shutdown the remote process keeps running, so stop
  // syncing and continue on the next connect
  async close(final: boolean): Promise<void> {
    clearInterval(this.timer);
    if (final) await this.syncNow(true);
    else {
      this.stopping = true;
      await this.busy;
    }
    this.closed = true;
  }

  // Record the origin once the copy is imported (the import follows the sync, done by the controller's incremental import)
  mark() {
    if (this.remotePath === null) return;
    markRemoteSession(
      this.db,
      this.host.id,
      localCopyOf(this.remoteDir, this.host.id, this.remotePath),
      this.remotePath,
    );
  }
}
