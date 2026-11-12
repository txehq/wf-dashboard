import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { execa } from 'execa';
import semver from 'semver';
import { z } from 'zod';
import type { Install } from '../config.js';
import type { Db } from '../db/index.js';
import { liveProcesses, liveSessions, runs } from '../db/schema.js';
import { events } from '../events.js';
import { bootTime, paneProcessAlive } from '../live/orca-panes.js';
import type { InstallView, UpdateView } from './views.js';

// Running as the server of WF Dashboard.app (Contracts 39.2a–39.5)

export const PACKAGE_REPO = 'txehq/wf-dashboard';
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
// While a downloaded version waits for running work to finish, how often it looks again
const IDLE_POLL_MS = 60_000;
export const APP_NAME = 'WF Dashboard.app';

export const appAsset = (version: string) => `WF-Dashboard-${version}-arm64.zip`;

// The server package inside an app bundle
export const packageDirOf = (appPath: string) =>
  path.join(appPath, 'Contents', 'Resources', 'server');

// Runs a command that must succeed; on failure the error carries the command and its output as written
async function must(file: string, args: string[]): Promise<string> {
  const result = await execa(file, args, { all: true, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} exited with code ${String(result.exitCode ?? result.signal)}:\n${result.all.trim()}`,
    );
  }
  return result.stdout;
}

const removeTree = (dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
};

// At startup: tasks shipped in the package that data/tasks/ does not have yet are copied there (ones already there keep
// the user's edits), and updates downloaded by an earlier run are deleted (a newer one is downloaded again)
export function prepareInstall(install: Install, tasks: { bundled: string; data: string }) {
  fs.mkdirSync(tasks.data, { recursive: true });
  for (const entry of fs.readdirSync(tasks.bundled, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(tasks.data, entry.name);
    if (fs.existsSync(target)) continue;
    fs.cpSync(path.join(tasks.bundled, entry.name), target, { recursive: true });
  }
  removeTree(path.join(install.root, 'updates'));
}

// The same conditions as restarting the user's instance (.work/restart-user.sh): runs that are queued, preparing,
// running or grading, and this machine's interactive processes that are still alive. Processes on SSH hosts run in tmux
// and reconnect after a restart (Contracts 31.4); agents in Orca terminals are reattached by the topology sync (35.3).
// Also what quitting the app asks about (39.2a)
export function runningWork(db: Db): string[] {
  const active = db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(inArray(runs.status, ['queued', 'preparing', 'running', 'grading']))
    .all();
  const boot = bootTime();
  const processes = db
    .select({
      liveId: liveSessions.id,
      title: liveSessions.title,
      pid: liveProcesses.pid,
      startedAt: liveProcesses.startedAt,
    })
    .from(liveProcesses)
    .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
    .where(
      and(
        eq(liveProcesses.status, 'running'),
        isNull(liveSessions.hostId),
        isNull(liveSessions.orcaTerminalHandle),
        isNotNull(liveProcesses.pid),
      ),
    )
    .all()
    .filter((p) => paneProcessAlive(p.pid, p.startedAt, boot));
  return [
    ...active.map((r) => `Run ${r.id} is ${r.status}`),
    ...processes.map((p) => `Live item "${p.title}" (${p.liveId}) has a running process`),
  ];
}

const ReleaseJson = z.object({ tagName: z.string().min(1) });
const PackageRelease = z.object({ version: z.string().min(1) });

export interface UpdaterOptions {
  db: Db;
  install: Install;
  // Passed to the relaunched app, so it serves the same port and data directory
  port: number;
  dataDir: string;
  // Ends the service once the app replacement is under way; the app quits when its server exits with this code
  restart: () => void;
}

export function createUpdater({ db, install, port, dataDir, restart }: UpdaterOptions) {
  const state: UpdateView = {
    step: null,
    checkedAt: null,
    latest: null,
    pending: null,
    waitingFor: [],
    error: null,
  };
  let running: Promise<void> | null = null;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let switched = false;
  const updatesDir = path.join(install.root, 'updates');

  const publish = () => {
    events.publish({ type: 'install.updated' });
  };
  const step = (value: UpdateView['step']) => {
    state.step = value;
    publish();
  };

  // Downloads the version's app zip into updates/<version>/, extracts it there and loads its native modules with its
  // own Node
  async function fetchVersion(version: string) {
    step('downloading');
    const dir = path.join(updatesDir, version);
    removeTree(dir);
    fs.mkdirSync(dir, { recursive: true });
    const asset = appAsset(version);
    await must('gh', [
      'release',
      'download',
      `v${version}`,
      '--repo',
      PACKAGE_REPO,
      '--pattern',
      asset,
      '--dir',
      dir,
    ]);
    await must('ditto', ['-x', '-k', path.join(dir, asset), dir]);
    fs.rmSync(path.join(dir, asset));
    step('verifying');
    const packageDir = packageDirOf(path.join(dir, APP_NAME));
    const release = PackageRelease.parse(
      JSON.parse(fs.readFileSync(path.join(packageDir, 'release.json'), 'utf8')),
    );
    if (release.version !== version) {
      throw new Error(`${asset} contains version ${release.version}, not ${version}`);
    }
    await must(path.join(packageDir, 'bin', 'node'), [
      path.join(packageDir, 'server', 'dist', 'install', 'check-native.js'),
    ]);
  }

  // Once nothing is running: a detached script waits for the app to quit, replaces it with the pending version and
  // opens it; the server exits so the app quits. Otherwise looks again every minute
  function trySwitch() {
    const version = state.pending;
    if (version === null || switched) return;
    state.waitingFor = runningWork(db);
    publish();
    if (state.waitingFor.length > 0) {
      idleTimer ??= setInterval(trySwitch, IDLE_POLL_MS);
      return;
    }
    clearInterval(idleTimer);
    idleTimer = undefined;
    // The script runs from updates/, which outlives the app it replaces
    const script = path.join(updatesDir, 'replace-app.sh');
    fs.copyFileSync(
      path.join(install.packageDir, 'server', 'src', 'install', 'replace-app.sh'),
      script,
    );
    const logs = path.join(install.root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const log = fs.openSync(path.join(logs, 'update.log'), 'a');
    const child = spawn(
      '/bin/bash',
      [
        script,
        String(install.appPid),
        install.appPath,
        path.join(updatesDir, version, APP_NAME),
        `WFD_PORT=${String(port)}`,
        `WFD_DATA_DIR=${dataDir}`,
      ],
      { detached: true, stdio: ['ignore', log, log] },
    );
    child.unref();
    fs.closeSync(log);
    switched = true;
    console.log(`[update] replacing ${install.appPath} with ${version} once the app quits`);
    restart();
  }

  async function run() {
    // A failed check is recorded as written and shown in the nav; the current version keeps running
    try {
      step('checking');
      const args = ['release', 'view', '--repo', PACKAGE_REPO, '--json', 'tagName'];
      const { tagName } = ReleaseJson.parse(JSON.parse(await must('gh', args)));
      const latest = semver.valid(semver.clean(tagName));
      if (latest === null) throw new Error(`The latest Release tag ${tagName} is not a version`);
      state.latest = latest;
      state.checkedAt = Date.now();
      if (semver.gt(latest, install.version) && latest !== state.pending) {
        await fetchVersion(latest);
        state.pending = latest;
      }
      state.error = null;
    } catch (error) {
      console.error('[update] Updating from the latest Release failed', error);
      state.checkedAt = Date.now();
      state.error = error instanceof Error ? error.message : String(error);
    }
    step(null);
    trySwitch();
  }

  return {
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },

    // Once the server listens: one check at once, then every 6 hours, in the background
    start() {
      void this.check();
      checkTimer = setInterval(() => {
        void this.check();
      }, UPDATE_CHECK_MS);
    },

    stop() {
      clearInterval(checkTimer);
      clearInterval(idleTimer);
    },

    view(): InstallView {
      return {
        installed: true,
        version: install.version,
        commit: install.commit,
        root: install.root,
        app: install.appPath,
        dataDir,
        update: { ...state, waitingFor: [...state.waitingFor] },
      };
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
