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

// Running from an installed release package (Contracts 39.3–39.5)

export const PACKAGE_REPO = 'txehq/wf-dashboard';
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
// While a downloaded version waits for running work to finish, how often it looks again
const IDLE_POLL_MS = 60_000;

export const packageAsset = (version: string) => `wf-dashboard-${version}-darwin-arm64.tar.gz`;

// The check run with a package's own Node after extracting it
export const nativeCheck = (packageDir: string) => ({
  node: path.join(packageDir, 'bin', 'node'),
  script: path.join(packageDir, 'server', 'dist', 'install', 'check-native.js'),
});

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
// the user's edits), and every other version under app/ and leftover downloads are deleted
export function prepareInstall(install: Install, tasks: { bundled: string; data: string }) {
  fs.mkdirSync(tasks.data, { recursive: true });
  for (const entry of fs.readdirSync(tasks.bundled, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(tasks.data, entry.name);
    if (fs.existsSync(target)) continue;
    fs.cpSync(path.join(tasks.bundled, entry.name), target, { recursive: true });
  }
  const appDir = path.join(install.root, 'app');
  for (const name of fs.readdirSync(appDir)) {
    const dir = path.join(appDir, name);
    if (dir !== install.packageDir) removeTree(dir);
  }
  removeTree(path.join(install.root, 'downloads'));
  fs.rmSync(path.join(install.root, 'current.next'), { force: true });
}

// The same conditions as restarting the user's instance (.work/restart-user.sh): runs that are queued, preparing,
// running or grading, and this machine's interactive processes that are still alive. Processes on SSH hosts run in tmux
// and reconnect after a restart (Contracts 31.4); agents in Orca terminals are reattached by the topology sync (35.3)
function runningWork(db: Db): string[] {
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
  // Ends the service after current is switched; launchd starts it again from the new version
  restart: () => void;
}

export function createUpdater({ db, install, restart }: UpdaterOptions) {
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

  const publish = () => {
    events.publish({ type: 'install.updated' });
  };
  const step = (value: UpdateView['step']) => {
    state.step = value;
    publish();
  };

  // Downloads the version's tarball, extracts it to app/<version>/ and loads its native modules with its own Node
  async function fetchVersion(version: string) {
    step('downloading');
    const downloads = path.join(install.root, 'downloads', version);
    removeTree(downloads);
    fs.mkdirSync(downloads, { recursive: true });
    const asset = packageAsset(version);
    await must('gh', [
      'release',
      'download',
      `v${version}`,
      '--repo',
      PACKAGE_REPO,
      '--pattern',
      asset,
      '--dir',
      downloads,
    ]);
    const staging = path.join(install.root, 'app', `.staging-${version}`);
    removeTree(staging);
    fs.mkdirSync(staging, { recursive: true });
    await must('tar', [
      '-xzf',
      path.join(downloads, asset),
      '-C',
      staging,
      '--strip-components',
      '1',
    ]);
    step('verifying');
    const release = PackageRelease.parse(
      JSON.parse(fs.readFileSync(path.join(staging, 'release.json'), 'utf8')),
    );
    if (release.version !== version) {
      throw new Error(`${asset} contains version ${release.version}, not ${version}`);
    }
    const check = nativeCheck(staging);
    await must(check.node, [check.script]);
    const target = path.join(install.root, 'app', version);
    removeTree(target);
    fs.renameSync(staging, target);
    removeTree(downloads);
  }

  // Switches current to the pending version once nothing is running, then restarts; otherwise looks again every minute
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
    const next = path.join(install.root, 'current.next');
    fs.rmSync(next, { force: true });
    fs.symlinkSync(path.join('app', version), next);
    fs.renameSync(next, path.join(install.root, 'current'));
    switched = true;
    console.log(`[update] current is now ${version}; restarting`);
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

    view(dataDir: string): InstallView {
      return {
        installed: true,
        version: install.version,
        commit: install.commit,
        root: install.root,
        dataDir,
        update: { ...state, waitingFor: [...state.waitingFor] },
      };
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
