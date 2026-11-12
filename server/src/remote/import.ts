import path from 'node:path';
import { asc } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type SessionEngine, sshHosts } from '../db/schema.js';
import { sessionTitle } from '../api/user-text.js';
import { codexHead } from '../ingest/codex.js';
import { importFiles } from '../ingest/sources.js';
import { claudeHead } from '../ingest/ingest.js';
import { HttpError } from '../variants/errors.js';
import type { Hosts, RemoteHost } from './hosts.js';
import { listRemoteRollouts } from './rollouts.js';
import { sshExec, sshScript } from './ssh.js';
import { markRemoteSession, pullSession } from './sync.js';

// One config per SSH host in the Sessions import (Contracts 31.6, 25.5): config id ssh:<hostId>; Claude Code uses the remote
// ~/.claude/projects, Codex the remote ~/.codex sessions and archived_sessions; the project and session columns read metadata over ssh,
// and import copies the chosen sessions' files back to this machine before importing. The third column's file is ssh:<hostId>:<remote path>

export const SSH_CONFIG = /^ssh:([^:]+)$/;
const SSH_FILE = /^ssh:([^:]+):(\/.*)$/;

export const remoteFileId = (hostId: string, remotePath: string) => `ssh:${hostId}:${remotePath}`;

export function parseRemoteFile(file: string): { hostId: string; remotePath: string } | null {
  const m = SSH_FILE.exec(file);
  return m === null ? null : { hostId: m[1] ?? '', remotePath: m[2] ?? '' };
}

// Bytes read from the head: same as locally (long hook output and skill text may precede the first user message)
const HEAD_BYTES = 256 * 1024;

interface Head {
  firstAt: number | null;
  cwd: string | null;
  title: string | null;
}

// Head info cached by remote path, size and mtime
const headCache = new Map<string, { size: number; mtime: number; head: Head }>();

interface RemoteFile {
  path: string;
  size: number;
  mtime: number;
}

function parseHead(engine: SessionEngine, bytes: Buffer): Head {
  const end = bytes.lastIndexOf(0x0a);
  const lines =
    end < 0
      ? []
      : bytes
          .subarray(0, end)
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim() !== '');
  const h = engine === 'claude' ? claudeHead(lines) : { ...codexHead(lines), cwd: null };
  return {
    firstAt: h.firstAt,
    cwd: h.cwd,
    title: h.firstUserText === null ? null : sessionTitle(h.firstUserText),
  };
}

async function stats(host: RemoteHost, args: string[]): Promise<RemoteFile[]> {
  const out = await sshScript(host.target, 'stats.sh', args);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [size = '', mtime = '', ...rest] = l.split(' ');
      return { path: rest.join(' '), size: Number(size), mtime: Number(mtime) };
    });
}

// Head info of these files; files missing from the cache or changed are read over ssh
async function heads(
  host: RemoteHost,
  engine: SessionEngine,
  files: RemoteFile[],
): Promise<Map<string, Head>> {
  const key = (f: RemoteFile) => `${host.id}:${f.path}`;
  const stale = files.filter((f) => {
    const cached = headCache.get(key(f));
    return cached?.size !== f.size || cached.mtime !== f.mtime;
  });
  if (stale.length > 0) {
    const out = await sshScript(host.target, 'heads.sh', [
      String(HEAD_BYTES),
      ...stale.map((f) => f.path),
    ]);
    const lines = out.split('\n');
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const file = (lines[i] ?? '').replace(/^@@wfd /, '');
      const f = stale.find((s) => s.path === file);
      if (f === undefined)
        throw new Error(`heads.sh output contains a file that was not requested: ${file}`);
      headCache.set(key(f), {
        size: f.size,
        mtime: f.mtime,
        head: parseHead(engine, Buffer.from(lines[i + 1] ?? '', 'base64')),
      });
    }
  }
  return new Map(
    files.map((f) => [
      f.path,
      headCache.get(key(f))?.head ?? { firstAt: null, cwd: null, title: null },
    ]),
  );
}

export interface RemoteProject {
  cwd: string;
  sessions: string[];
}

// All projects of this engine on a host: Claude Code by the directories under projects (working directory read from the newest
// session), Codex by the cwd in the rollout's first line
async function projectsOf(host: RemoteHost, engine: SessionEngine): Promise<RemoteProject[]> {
  if (engine === 'codex') {
    const rollouts = await listRemoteRollouts(host, codexDirs(host));
    const byCwd = new Map<string, string[]>();
    for (const r of rollouts) byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r.file]);
    return [...byCwd].map(([cwd, sessions]) => ({ cwd, sessions }));
  }
  const out = await sshScript(host.target, 'projects.sh', [`${host.home}/.claude/projects`]);
  const lines = out.split('\n');
  const dirs: { dir: string; newest: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const m = /^@@wfd \d+ (.+)$/.exec(lines[i] ?? '');
    if (m === null) continue;
    dirs.push({ dir: m[1] ?? '', newest: lines[i + 1] ?? '' });
  }
  const newest = await stats(host, ['--', ...dirs.map((d) => d.newest)]);
  const newestHeads = await heads(host, 'claude', newest);
  const projects = new Map<string, string[]>();
  for (const d of dirs) {
    const cwd = newestHeads.get(d.newest)?.cwd ?? d.dir;
    projects.set(cwd, [...(projects.get(cwd) ?? []), d.dir]);
  }
  return [...projects].map(([cwd, sessions]) => ({ cwd, sessions }));
}

const codexDirs = (host: RemoteHost) => [
  `${host.home}/.codex/sessions`,
  `${host.home}/.codex/archived_sessions`,
];

export interface RemoteConfig {
  id: string;
  label: string;
  hostId: string;
  sessionCount: number;
  // Output when unreachable or the check failed; the item is greyed out in the first column
  error: string | null;
}

// First column: one item per host. An unreachable host has sessionCount 0 and error is ssh's output
export async function remoteConfigs(
  db: Db,
  hosts: Hosts,
  engine: SessionEngine,
): Promise<RemoteConfig[]> {
  const rows = db.select().from(sshHosts).orderBy(asc(sshHosts.createdAt)).all();
  return Promise.all(
    rows.map(async (r): Promise<RemoteConfig> => {
      const base = { id: `ssh:${r.id}`, label: `${r.label} config`, hostId: r.id };
      const probe = await sshExec(r.target, 'true');
      if (probe.exitCode !== 0) {
        return {
          ...base,
          sessionCount: 0,
          error: probe.stderr.trim() || `Cannot reach ${r.target}`,
        };
      }
      if (r.check?.home == null) {
        return { ...base, sessionCount: 0, error: 'This host has not passed a check yet' };
      }
      const host = hosts.known(r.id);
      const count =
        engine === 'codex'
          ? (await listRemoteRollouts(host, codexDirs(host))).length
          : (await claudeCounts(host)).total;
      return { ...base, sessionCount: count, error: null };
    }),
  );
}

async function claudeCounts(host: RemoteHost): Promise<{ total: number }> {
  const out = await sshScript(host.target, 'projects.sh', [`${host.home}/.claude/projects`]);
  let total = 0;
  for (const line of out.split('\n')) {
    const m = /^@@wfd (\d+) /.exec(line);
    if (m !== null) total += Number(m[1]);
  }
  return { total };
}

function hostOfConfig(hosts: Hosts, config: string): RemoteHost {
  const m = SSH_CONFIG.exec(config);
  if (m === null) throw new HttpError(400, `Not an SSH host config: ${config}`);
  return hosts.known(m[1] ?? '');
}

// Second column
export async function remoteProjects(
  hosts: Hosts,
  engine: SessionEngine,
  config: string,
  importedOf: (ids: string[]) => Set<string>,
): Promise<{ cwd: string; name: string; sessionCount: number; importedCount: number }[]> {
  const host = hostOfConfig(hosts, config);
  const projects = await projectsOf(host, engine);
  const result = [];
  for (const p of projects) {
    const files = engine === 'codex' ? p.sessions : await claudeFiles(host, p.sessions);
    const ids = files.map((f) => sessionIdOf(engine, f));
    result.push({
      cwd: p.cwd,
      name: path.posix.basename(p.cwd) || p.cwd,
      sessionCount: files.length,
      importedCount: importedOf(ids).size,
    });
  }
  return result;
}

async function claudeFiles(host: RemoteHost, dirs: string[]): Promise<string[]> {
  const all = await Promise.all(dirs.map((d) => stats(host, [d])));
  return all.flat().map((f) => f.path);
}

// session id: the file name for Claude Code, the uuid at the end of the rollout file name for Codex
export function sessionIdOf(engine: SessionEngine, file: string): string {
  const base = path.posix.basename(file, '.jsonl');
  if (engine === 'claude') return base;
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(base);
  if (m === null) throw new Error(`No session id in the rollout file name: ${file}`);
  return m[1] ?? '';
}

export interface RemoteDiskSession {
  id: string;
  file: string;
  title: string | null;
  startedAt: Date;
  size: number;
}

// Third column: all sessions of a project (title and start time read from the head)
export async function remoteSessions(
  hosts: Hosts,
  engine: SessionEngine,
  config: string,
  cwd: string,
): Promise<RemoteDiskSession[]> {
  const host = hostOfConfig(hosts, config);
  const project = (await projectsOf(host, engine)).find((p) => p.cwd === cwd);
  if (project === undefined) return [];
  const files =
    engine === 'codex'
      ? await stats(host, ['--', ...project.sessions])
      : (await Promise.all(project.sessions.map((d) => stats(host, [d])))).flat();
  const read = await heads(host, engine, files);
  return files.map((f) => {
    const head = read.get(f.path);
    return {
      id: sessionIdOf(engine, f.path),
      file: remoteFileId(host.id, f.path),
      title: head?.title ?? null,
      startedAt: new Date(head?.firstAt ?? f.mtime * 1000),
      size: f.size,
    };
  });
}

// Remote sessions in "Import N": copied back to data/remote/<hostId>/ on this machine, imported as usual, origin recorded
export async function importRemote(
  db: Db,
  hosts: Hosts,
  remoteDir: string,
  engine: SessionEngine,
  files: string[],
): Promise<{ id: string; file: string }[]> {
  const done: { id: string; file: string }[] = [];
  for (const file of files) {
    const parsed = parseRemoteFile(file);
    if (parsed === null) throw new HttpError(400, `Not a session file on an SSH host: ${file}`);
    const host = hosts.known(parsed.hostId);
    const { local, error } = await pullSession(host, remoteDir, parsed.remotePath);
    if (error !== null)
      throw new HttpError(502, `Copy ${host.label}:${parsed.remotePath} failed: ${error}`);
    const id = sessionIdOf(engine, parsed.remotePath);
    await importFiles(db, engine, [{ id, file: local }]);
    markRemoteSession(db, host.id, local, parsed.remotePath);
    done.push({ id, file });
  }
  return done;
}
