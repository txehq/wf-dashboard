import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execa } from 'execa';
import treeKill from 'tree-kill';
import { z } from 'zod';
import { events } from '../events.js';
import type { Hosts, RemoteHost } from '../remote/hosts.js';
import { closeMaster } from '../remote/ssh.js';
import { HttpError } from '../variants/errors.js';
import { isolatedBaseEnv } from '../variants/claude-config.js';
import { ensurePackage } from './package.js';
import { removeLanguagePack, removeLanguagePackData, type ServerCli } from './language.js';
import { serverArgs } from './server-args.js';
import { latestRelease, localPlatform } from './release.js';
import {
  cancelForward,
  forward,
  freePort,
  listening,
  type RemoteServerInfo,
  removeRemoteLanguagePack,
  runningRemote,
  startRemote,
  stopRemote,
  uploadPackage,
} from './remote.js';
import {
  LOCAL_SERVER_ID,
  platformOfUname,
  remoteServerId,
  type VscodeOpenResult,
  type VscodePhase,
  type VscodePlatform,
  type VscodeServerView,
} from './views.js';

export interface VscodeDeps {
  // data/vscode: the connection token, extensions and settings (server-data/), the local server's port and pid, the
  // local ports used to forward to each host, logs
  dir: string;
  // The server package cache (Contracts 32.1); test processes share one under .work/
  serversDir: string;
  // A Live item's working directory and SSH host (null for this machine); Contracts 32.4 accepts only items the
  // dashboard knows
  itemOf: (liveId: string) => { cwd: string; hostId: string | null };
  hosts: Hosts;
  // How long to wait when stopping a server before SIGKILL
  stopGraceMs: number;
}

interface ServerState {
  id: string;
  machine: string;
  status: VscodeServerView['status'];
  phase: VscodePhase | null;
  received: number | null;
  total: number | null;
  version: string | null;
  commit: string | null;
  port: number | null;
  pid: number | null;
  startedAt: Date | null;
  error: string | null;
  child: ServerProcess | null;
  // A server on an SSH host: port is the forwarded local port, remotePort the port it listens on remotely
  remote: { host: RemoteHost; remotePort: number } | null;
}

// A server process: exited resolves once the process has exited
interface ServerProcess {
  pid: number;
  alive: () => boolean;
  exited: Promise<void>;
}

// The port the local server used: VS Code in the browser stores its settings, layout and recent items per address
// (port included), so a restart reuses it. The local ports forwarded to each SSH host are reused the same way
// (hosts/<hostId>.json)
const LocalState = z.object({ port: z.number().int().min(1).max(65535) });

const BOUND = /^Server bound to 127\.0\.0\.1:(\d+) /;
const READY = 'Extension host agent started.';

// Download progress is published at most once every 500 ms
const PROGRESS_EVENT_MS = 500;

export function createVscode(deps: VscodeDeps) {
  const servers = new Map<string, ServerState>();
  const serverDataDir = path.join(deps.dir, 'server-data');
  // The Chinese language pack cache from before Contracts 36.1, removed when the local server starts
  const languagePacksDir = path.join(deps.dir, 'language-packs');
  // The download log: resumes, bytes downloaded, sha256 mismatches and completed downloads, also printed to the
  // dashboard's output
  const downloadLog = (line: string) => {
    fs.mkdirSync(deps.dir, { recursive: true });
    fs.appendFileSync(
      path.join(deps.dir, 'download.log'),
      `[${new Date().toISOString()}] ${line}\n`,
    );
    console.log(`[vscode] ${line}`);
  };
  const tokenFile = path.join(deps.dir, 'token');
  const stateFile = path.join(deps.dir, 'local.json');
  const pidFile = path.join(deps.dir, 'local.pid');
  let lastProgressEvent = 0;

  const publish = () => {
    lastProgressEvent = Date.now();
    events.publish({ type: 'vscode.servers' });
  };

  // The connection token (Contracts 32.1): generated on first use, then unchanged, readable only by the local user
  const token = (): string => {
    if (!fs.existsSync(tokenFile)) {
      fs.mkdirSync(deps.dir, { recursive: true });
      fs.writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
    }
    return fs.readFileSync(tokenFile, 'utf8');
  };

  const view = (s: ServerState): VscodeServerView => ({
    id: s.id,
    machine: s.machine,
    status: s.status,
    phase: s.phase,
    received: s.received,
    total: s.total,
    version: s.version,
    commit: s.commit,
    port: s.port,
    pid: s.pid,
    startedAt: s.startedAt?.toISOString() ?? null,
    error: s.error,
  });

  const urlOf = (s: ServerState, folder: string) => {
    if (s.port === null) throw new Error(`VS Code server ${s.id} has no port`);
    const query = new URLSearchParams({ tkn: token(), folder });
    return `http://127.0.0.1:${String(s.port)}/?${query.toString()}`;
  };

  // A local server left behind when the dashboard last exited abnormally (pid in local.pid, the local server-data
  // directory on its command line)
  const killLeftover = async () => {
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const ps = await execa('ps', ['-o', 'command=', '-p', String(pid)], { reject: false });
    if (ps.exitCode === 0 && ps.stdout.includes(serverDataDir)) await killTree(pid, 'SIGKILL');
    fs.rmSync(pidFile, { force: true });
  };

  // Put the latest stable server package into the local cache (updating the progress while downloading and
  // extracting); returns the package directory
  const fetchPackage = async (s: ServerState, platform: VscodePlatform) => {
    s.phase = 'checking';
    publish();
    const release = await latestRelease(platform);
    s.version = release.productVersion;
    s.commit = release.version;
    const pkg = await ensurePackage({
      serversDir: deps.serversDir,
      release,
      platform,
      onProgress: (p) => {
        s.phase = p.phase;
        s.received = p.received;
        s.total = p.total;
        if (p.phase !== 'downloading' || Date.now() - lastProgressEvent >= PROGRESS_EVENT_MS) {
          publish();
        }
      },
      log: downloadLog,
    });
    s.received = null;
    s.total = null;
    return pkg;
  };

  // The local server's command line: manages the extensions in the local server-data
  const localCli =
    (pkg: string): ServerCli =>
    async (args) => {
      const result = await execa(
        path.join(pkg, 'node'),
        [
          path.join(pkg, 'out', 'server-main.js'),
          ...args,
          '--server-data-dir',
          serverDataDir,
          '--accept-server-license-terms',
        ],
        { cwd: os.homedir(), env: isolatedBaseEnv(), extendEnv: false, stdin: 'ignore' },
      );
      return result.stdout;
    };

  // The local port used to forward to this host: a free port the first time, reused afterwards
  const hostPort = async (hostId: string) => {
    const file = path.join(deps.dir, 'hosts', `${hostId}.json`);
    if (fs.existsSync(file))
      return LocalState.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).port;
    const port = await freePort();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port }));
    return port;
  };

  // SSH host (Contracts 32.3): when the remote wfd-vscode session is still there (after a disconnect or a dashboard
  // restart), only rebuild the port forward; otherwise put the package on the remote and start it
  const startOnHost = (hostId: string) => async (s: ServerState) => {
    await deps.hosts.check(hostId);
    const host = deps.hosts.known(hostId);
    host.tool('tmux');
    host.tool('rsync');
    const platform = platformOfUname(host.check.platform ?? '');
    if (platform === null) {
      throw new Error(
        `No VS Code for the Web server package for ${host.label} (${String(host.check.platform)})`,
      );
    }
    let info = await runningRemote(host);
    // A server started without --locale en (before 36.1): stop it and start the latest stable in English
    if (info !== null && info.locale !== 'en') {
      await stopRemote(host);
      info = null;
    }
    if (info === null) {
      const pkg = await fetchPackage(s, platform);
      s.phase = 'uploading';
      publish();
      const { commit } = release(s);
      await uploadPackage(host, pkg, commit);
      await removeRemoteLanguagePack(host, commit);
      s.phase = 'starting';
      publish();
      info = await startRemote(host, release(s), token());
    }
    s.phase = 'forwarding';
    publish();
    await attach(s, host, info);
  };

  // Connect to the server running on the remote: forward a local port to it and mark it running
  const attach = async (s: ServerState, host: RemoteHost, info: RemoteServerInfo) => {
    const port = await hostPort(host.id);
    await forward(host, port, info.port);
    s.version = info.version;
    s.commit = info.commit;
    s.remote = { host, remotePort: info.port };
    s.port = port;
    s.status = 'running';
    s.phase = null;
    s.error = null;
    s.startedAt = new Date(info.startedAt);
    publish();
  };

  // At dashboard startup (Contracts 32.3): check every saved host for the wfd-vscode session, list it and rebuild the
  // forward when it is there; an unreachable host is recorded as unreachable with the ssh output. Hosts are checked
  // at the same time; opening an item on a host waits until its check is done
  const restoring = new Map<string, Promise<void>>();
  const restoreHost = async (hostId: string, label: string) => {
    const id = remoteServerId(hostId);
    const checked = await deps.hosts.check(hostId);
    const c = checked.check;
    if (c?.connected !== true) {
      servers.set(id, { ...emptyState(id, label), status: 'unreachable', error: c?.error ?? null });
      publish();
      return;
    }
    const host = deps.hosts.known(hostId);
    if (!c.tools?.tmux.found) return;
    const info = await runningRemote(host);
    if (info === null) return;
    const s = emptyState(id, label);
    s.phase = 'forwarding';
    servers.set(id, s);
    publish();
    await attach(s, host, info);
  };

  const release = (s: ServerState) => {
    if (s.commit === null || s.version === null) {
      throw new Error(`The version for ${s.machine} is not known yet`);
    }
    return { commit: s.commit, version: s.version };
  };

  // Before opening, confirm a running remote server is still there: when its tmux session is gone (the server exited)
  // drop it from the list and prepare again; a server started without --locale en (before 36.1) is dropped the same
  // way and replaced while preparing. Rebuild the forward when it is gone (the ControlMaster exits after 10 idle
  // minutes, a disconnect)
  const stillRunning = async (s: ServerState): Promise<boolean> => {
    if (s.remote === null || s.port === null) return true;
    const info = await runningRemote(s.remote.host);
    if (info?.port !== s.remote.remotePort || info.locale !== 'en') {
      await cancelForward(s.remote.host, s.port, s.remote.remotePort);
      servers.delete(s.id);
      return false;
    }
    if (!(await listening(s.port))) await forward(s.remote.host, s.port, s.remote.remotePort);
    return true;
  };

  const startLocal = async (s: ServerState) => {
    const pkg = await fetchPackage(s, localPlatform());
    s.phase = 'starting';
    publish();
    fs.mkdirSync(serverDataDir, { recursive: true });
    await removeLanguagePack(localCli(pkg));
    removeLanguagePackData(serverDataDir);
    fs.rmSync(languagePacksDir, { recursive: true, force: true });
    await killLeftover();
    token();
    const saved = fs.existsSync(stateFile)
      ? LocalState.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).port
      : 0;
    const log = fs.createWriteStream(path.join(deps.dir, 'local.log'), { flags: 'a' });
    // Run out/server-main.js with the package's own node (bin/code-server is a bash wrapper; stopping it does not
    // stop the server)
    const child = execa(
      path.join(pkg, 'node'),
      [
        path.join(pkg, 'out', 'server-main.js'),
        ...serverArgs({ port: saved, tokenFile, serverDataDir }),
      ],
      {
        cwd: os.homedir(),
        env: isolatedBaseEnv(),
        extendEnv: false,
        reject: false,
        stdin: 'ignore',
        buffer: false,
      },
    );
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`VS Code server did not start: ${String((await child).originalMessage)}`);
    }
    let exitedYet = false;
    const handle: ServerProcess = {
      pid,
      alive: () => !exitedYet,
      exited: child.then(() => {
        exitedYet = true;
      }),
    };
    s.child = handle;
    s.pid = pid;
    fs.writeFileSync(pidFile, String(pid));
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => {
      log.write(chunk);
      output = (output + chunk.toString('utf8')).slice(-4_000);
    });
    // The port comes from "Server bound to"; "Extension host agent started." is printed only after startup (reading
    // the connection token and so on) has completed
    const ready = new Promise<number>((resolve, reject) => {
      let port: number | null = null;
      void (async () => {
        for await (const line of readline.createInterface({ input: child.stdout })) {
          log.write(`${line}\n`);
          output = (output + line + '\n').slice(-4_000);
          const match = BOUND.exec(line);
          if (match?.[1] !== undefined) port = Number(match[1]);
          if (line.includes(READY) && port !== null) resolve(port);
        }
        log.end();
      })();
      void child.then((result) => {
        reject(
          new Error(
            `VS Code server did not start (exit code ${String(result.exitCode)}, signal ${String(result.signal)}):\n${output}`,
          ),
        );
      });
    });
    void handle.exited.then(() => {
      fs.rmSync(pidFile, { force: true });
      // A running server exited (stopped or on its own): drop it from the list; one still starting fails through
      // ready
      if (servers.get(s.id) === s && s.status === 'running') {
        servers.delete(s.id);
        publish();
      }
    });
    const port = await ready;
    fs.writeFileSync(stateFile, JSON.stringify({ port }));
    s.port = port;
    s.status = 'running';
    s.phase = null;
    s.startedAt = new Date();
    publish();
  };

  // Start preparing a machine's server; a failure leaves failed with the error, and the next open prepares again
  const prepare = (id: string, machine: string, start: (s: ServerState) => Promise<void>) => {
    const s = emptyState(id, machine);
    servers.set(id, s);
    void start(s).then(undefined, async (error: unknown) => {
      if (s.child?.alive() === true) await killTree(s.child.pid, 'SIGKILL');
      fail(s, error);
    });
    return s;
  };

  const fail = (s: ServerState, error: unknown) => {
    s.status = 'failed';
    s.phase = null;
    s.child = null;
    s.pid = null;
    s.error = error instanceof Error ? error.message : String(error);
    publish();
  };

  const stopServer = async (s: ServerState) => {
    if (s.remote !== null && s.port !== null) {
      await cancelForward(s.remote.host, s.port, s.remote.remotePort);
      await stopRemote(s.remote.host);
      return;
    }
    const child = s.child;
    if (child?.alive() !== true) return;
    await killTree(child.pid, 'SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, deps.stopGraceMs);
    });
    const exited = await Promise.race([child.exited.then(() => true), late]);
    if (!exited && child.alive()) await killTree(child.pid, 'SIGKILL');
    clearTimeout(timer);
    await child.exited;
  };

  return {
    // POST /api/vscode/open (Contracts 32.4): returns the address when the server on the item's machine is running;
    // starts preparing it when there is none yet or the last attempt failed
    async open(liveId: string): Promise<VscodeOpenResult> {
      const { cwd, hostId } = deps.itemOf(liveId);
      if (hostId === null && !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(404, `Working directory does not exist: ${cwd}`);
      }
      const id = hostId === null ? LOCAL_SERVER_ID : remoteServerId(hostId);
      if (hostId !== null) await restoring.get(hostId);
      const current = servers.get(id);
      if (current?.status === 'running' && (await stillRunning(current))) {
        return { url: urlOf(current, cwd) };
      }
      const now = servers.get(id);
      if (now?.status === 'preparing') return { progress: view(now) };
      if (hostId === null) return { progress: view(prepare(id, 'This machine', startLocal)) };
      const label = deps.hosts.brief(hostId)?.label ?? hostId;
      return { progress: view(prepare(id, label, startOnHost(hostId))) };
    },
    list(): VscodeServerView[] {
      return [...servers.values()].map(view);
    },
    // Called once the service listens (app.ts onListen): list the servers still running on each SSH host and rebuild
    // their forwards; a host with an error is recorded as failed
    restoreRemote(): Promise<void> {
      const all = deps.hosts.list().hosts.map((h) => {
        const work = restoreHost(h.id, h.label).then(undefined, (error: unknown) => {
          const id = remoteServerId(h.id);
          const s = servers.get(id) ?? emptyState(id, h.label);
          servers.set(id, s);
          fail(s, error);
        });
        restoring.set(h.id, work);
        return work.then(() => {
          restoring.delete(h.id);
        });
      });
      return Promise.all(all).then(() => undefined);
    },
    // DELETE /api/vscode/servers/:id: stop a running server (closing the tmux session on an SSH host), or clear a
    // failed record
    async stop(id: string): Promise<void> {
      const s = servers.get(id);
      if (s === undefined) throw new HttpError(404, `No such VS Code server: ${id}`);
      if (s.status === 'preparing') {
        throw new HttpError(
          409,
          `VS Code server on ${s.machine} is being prepared; stop it once preparation finishes`,
        );
      }
      servers.delete(id);
      await stopServer(s);
      publish();
    },
    // When the dashboard exits, the local server stops with it (Contracts 32.2); servers on SSH hosts keep running in
    // tmux, only the forwards are cancelled (32.3)
    async shutdown() {
      // Wait for the startup checks that have not finished (one may have just created a forward), then cancel the
      // forward and close the host's ControlMaster
      await Promise.all(restoring.values());
      await Promise.all(
        [...servers.values()].map(async (s) => {
          if (s.remote === null || s.port === null) {
            await stopServer(s);
            return;
          }
          await cancelForward(s.remote.host, s.port, s.remote.remotePort);
          await closeMaster(s.remote.host.target);
        }),
      );
      servers.clear();
    },
  };
}

export type Vscode = ReturnType<typeof createVscode>;

// A machine's server that has just started preparing and knows nothing yet
function emptyState(id: string, machine: string): ServerState {
  return {
    id,
    machine,
    status: 'preparing',
    phase: null,
    received: null,
    total: null,
    version: null,
    commit: null,
    port: null,
    pid: null,
    startedAt: null,
    error: null,
    child: null,
    remote: null,
  };
}

function killTree(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
