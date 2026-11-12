import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Install } from '../config.js';
import type { Db } from '../db/index.js';
import {
  type LiveEngine,
  liveEvents,
  liveProcesses,
  liveSessions,
  type MagiDeployStep,
  magiDeploys,
  runs,
} from '../db/schema.js';
import { events } from '../events.js';
import type { Live } from '../live/index.js';
import type { LiveDetail } from '../live/views.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import {
  aheadBehind,
  exec,
  initialWorktreeSteps,
  MAGI_BRANCH,
  MAIN_BRANCH,
  runWorktreeStep,
  uncommittedFiles,
  worktreeReady,
} from './git.js';
import type {
  MagiAgentView,
  MagiDeployView,
  MagiOpenBody,
  MagiSessionView,
  WorktreeStep,
} from './views.js';

export interface MagiAgentDeps {
  db: Db;
  live: Live;
  // A variant's configuration is usable only after a successful build (Contracts 23.3)
  variants: Variants;
  // The main repo: the directory of the running dashboard; MAGI.md is read from here and deploys merge into its main
  repoDir: string;
  worktree: string;
  // The check that deploy step 3 runs in the worktree
  check: readonly string[];
  // data/: deploy logs are in data/magi-agent/, database backups in data/backups/
  dataDir: string;
  // From an installed release package (Contracts 39.5): the worktree is the package's read-only sources and there is
  // no deploy; null for a git checkout
  install: Install | null;
  // The last deploy step: the service exits with code 75 and the pnpm start supervisor rebuilds and restarts it
  restart: () => void;
}

// Ports for deploy step 3 (Contracts 23.5), apart from those of the running dashboard and the workers
const CHECK_PORTS = { WFD_PORT: '7398', WFD_WEB_PORT: '5298' };

// Check output returned on failure: this many last lines of the log; the full output is in the log file
const CHECK_TAIL_LINES = 80;

// No deploy while runs have these statuses (Contracts 23.5 step 2)
const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'grading'] as const;

// Delay between sending the deploy response and ending the service (measured: when the service ends at once, Claude
// Code has no time to record curl's response in the session)
const RESTART_DELAY_MS = 3000;

function deployStep(id: string, label: string): MagiDeployStep {
  return { id, label, status: 'pending', output: null, startedAt: null, endedAt: null };
}

const stamp = (at: Date) =>
  at
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z');

// The worktree and child processes do not inherit the running dashboard's WFD_* settings (data dir, ports); each uses
// the defaults
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('WFD_'),
    ),
  );
}

export function createMagiAgent(deps: MagiAgentDeps) {
  const { db, live } = deps;
  let worktreeState: { state: 'preparing' | 'failed' | null; steps: WorktreeStep[] } = {
    state: null,
    steps: initialWorktreeSteps(),
  };
  let preparing: Promise<boolean> | null = null;
  // The error text when starting in the background after the worktree is ready fails
  let startError: string | null = null;
  let deploying = false;

  // The deploy that was running when the service last exited
  db.update(magiDeploys)
    .set({ status: 'failed', error: 'Interrupted by a service restart', endedAt: new Date() })
    .where(eq(magiDeploys.status, 'running'))
    .run();

  const publish = () => {
    events.publish({ type: 'magi.updated' });
  };

  // Read from the main repo at every start and resume (Contracts 23.4); an installed package adds what differs there
  const instructions = () => {
    const text = fs.readFileSync(path.join(deps.repoDir, 'agent/MAGI.md'), 'utf8');
    if (deps.install === null) return text;
    return `${text}\n\n## This installation\n\nThis dashboard runs from the release package ${deps.install.version} installed under ${deps.install.root}, not from a git checkout. Your working directory ${deps.worktree} holds the package's sources and is read-only: answer usage questions and discuss problems from them, and do not change or deploy the dashboard (POST /api/magi-agent/deploy refuses). The data directory is ${deps.dataDir}. The installation updates itself from the GitHub Releases of txehq/wf-dashboard; changes to the dashboard are made in its git repository.\n`;
  };
  // An installed package needs no worktree: its sources are ready as they are
  const ready = () => deps.install !== null || worktreeReady(deps.worktree);

  // All Magi Agent sessions (including closed ones), newest first (session choice in the Contracts 23.6 popover)
  function sessionsList(): MagiSessionView[] {
    return db
      .select({
        id: liveSessions.id,
        title: liveSessions.title,
        engine: liveSessions.engine,
        config: liveSessions.agentConfig,
        updatedAt: liveSessions.updatedAt,
      })
      .from(liveSessions)
      .where(eq(liveSessions.purpose, 'agent'))
      .orderBy(desc(liveSessions.updatedAt))
      .all()
      .map((s) => {
        if (s.config === null)
          throw new Error(`Magi Agent item ${s.id} has no recorded configuration`);
        return {
          ...s,
          config: s.config,
          updatedAt: s.updatedAt.getTime(),
          running: live.running(s.id),
        };
      });
  }

  // Codex has only the local machine configuration; a variant's configuration must build successfully from its current
  // content (Contracts 23.3, 23.6); otherwise reject with the message
  function checkConfig(engine: LiveEngine, config: string) {
    if (config === 'local') return;
    if (engine === 'codex') {
      throw new HttpError(400, 'The Codex Magi Agent has only the local machine configuration');
    }
    deps.variants.runtimeEnv(config);
  }

  // On first open, create the worktree and run pnpm install (Contracts 23.2), with progress in worktreeState; several
  // opens at once share one preparation
  function ensureWorktree(): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (preparing !== null) return preparing;
    preparing = prepareWorktree().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function prepareWorktree(): Promise<boolean> {
    worktreeState = { state: 'preparing', steps: initialWorktreeSteps() };
    publish();
    for (const step of worktreeState.steps) {
      step.status = 'running';
      publish();
      const result = await runWorktreeStep(step.id, deps.repoDir, deps.worktree);
      step.output = result.output;
      step.status = result.ok ? 'done' : 'failed';
      if (!result.ok) {
        worktreeState.state = 'failed';
        publish();
        return false;
      }
    }
    worktreeState = { state: null, steps: worktreeState.steps };
    publish();
    return true;
  }

  // Start or resume once the worktree is ready; while it is still preparing, return the item first and start in the
  // background when preparation is done. The error text of a failed background start goes into startError
  function startWhenReady(liveId: string, message: string | null): Promise<LiveDetail> {
    if (ready() && preparing === null) {
      return live.launchAgent(liveId, { instructions: instructions(), message });
    }
    startError = null;
    void ensureWorktree()
      .then(async (ok) => {
        if (ok && !live.running(liveId)) {
          await live.launchAgent(liveId, { instructions: instructions(), message });
        }
      })
      .then(
        () => undefined,
        (error: unknown) => {
          startError = `Starting ${liveId} failed: ${error instanceof Error ? error.message : String(error)}`;
          publish();
        },
      );
    return Promise.resolve(live.get(liveId));
  }

  function requireAgent(liveId: string): LiveDetail {
    const item = live.get(liveId);
    if (item.purpose !== 'agent') {
      throw new HttpError(400, `Live item ${liveId} is not a Magi Agent session`);
    }
    return item;
  }

  function createSession(engine: LiveEngine, config: string): Promise<LiveDetail> {
    checkConfig(engine, config);
    const item = live.createAgentItem({ engine, config, cwd: deps.worktree });
    publish();
    return startWhenReady(item.id, null);
  }

  function deployView(row: typeof magiDeploys.$inferSelect): MagiDeployView {
    return {
      id: row.id,
      liveId: row.liveId,
      engine: row.engine,
      status: row.status,
      steps: row.steps,
      error: row.error,
      commit: row.commit,
      startedAt: row.startedAt.getTime(),
      endedAt: row.endedAt === null ? null : row.endedAt.getTime(),
    };
  }

  function deployRow(id: number) {
    const row = db.select().from(magiDeploys).where(eq(magiDeploys.id, id)).get();
    if (row === undefined) throw new HttpError(404, `Deploy not found: ${String(id)}`);
    return row;
  }

  // Step 2: running interactive processes other than the Magi Agent itself, and runs that are queued, preparing,
  // running or grading
  function busy(): string[] {
    const items = db
      .select({ id: liveSessions.id, title: liveSessions.title })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(and(eq(liveProcesses.status, 'running'), ne(liveSessions.purpose, 'agent')))
      .all();
    const active = db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
      .all();
    return [
      ...items.map((i) => `Live item "${i.title}" (${i.id}) has a running process`),
      ...active.map((r) => `Run ${r.id} is ${r.status}`),
    ];
  }

  async function runCheck(logFile: string): Promise<{ ok: boolean; output: string }> {
    const [file, ...args] = deps.check;
    if (file === undefined) throw new Error('The deploy check command is empty');
    const result = await exec(deps.worktree, file, args, { ...cleanEnv(), ...CHECK_PORTS });
    fs.appendFileSync(logFile, `$ ${deps.check.join(' ')} (${deps.worktree})\n${result.output}\n`);
    const tail = result.output.split('\n').slice(-CHECK_TAIL_LINES).join('\n');
    return {
      ok: result.ok,
      output: result.ok
        ? `Passed, full output in ${logFile}`
        : `${deps.check.join(' ')} failed (full output in ${logFile}), last ${String(CHECK_TAIL_LINES)} lines:\n${tail}`,
    };
  }

  async function mergeCheck(): Promise<{ ok: boolean; output: string }> {
    const head = await exec(deps.repoDir, 'git', ['symbolic-ref', '--short', 'HEAD']);
    if (!head.ok || head.output.trim() !== MAIN_BRANCH) {
      return {
        ok: false,
        output: `The main repo ${deps.repoDir} is not on branch ${MAIN_BRANCH}: ${head.output.trim()}`,
      };
    }
    const dirty = await exec(deps.repoDir, 'git', [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    if (!dirty.ok || dirty.output.trim() !== '') {
      return {
        ok: false,
        output: `The main repo ${deps.repoDir} has uncommitted changes (untracked files excluded):\n${dirty.output}`,
      };
    }
    const tree = await exec(deps.repoDir, 'git', [
      'merge-tree',
      '--write-tree',
      '--name-only',
      MAIN_BRANCH,
      MAGI_BRANCH,
    ]);
    if (!tree.ok) {
      return {
        ok: false,
        output: `Merging into ${MAIN_BRANCH} has conflicts; first merge ${MAIN_BRANCH} into branch ${MAGI_BRANCH} and resolve them. Output of git merge-tree (the first line is the tree of the merge result, then the conflicting files):\n${tree.output}`,
      };
    }
    return { ok: true, output: 'No conflicts' };
  }

  // Deploy (Contracts 23.5): runs six steps in order, stops at the first failing step and returns its message; the
  // progress of each step is pushed through SSE magi.deploy
  async function deploy(liveId: string): Promise<MagiDeployView> {
    if (deps.install !== null) {
      throw new HttpError(
        409,
        `This dashboard runs from the release package ${deps.install.version} installed under ${deps.install.root}, which has no git repository to merge into: it cannot be modified and deployed, and it updates itself from the GitHub Releases of txehq/wf-dashboard. Modifying and deploying the dashboard needs a git checkout of wf-dashboard started with pnpm start.`,
      );
    }
    const item = requireAgent(liveId);
    if (deploying) throw new HttpError(409, 'A deploy is already in progress');
    deploying = true;
    const startedAt = new Date();
    const logFile = path.join(deps.dataDir, 'magi-agent', `deploy-${stamp(startedAt)}.log`);
    // The log exists from the start of the deploy: each step's result is appended, and step 3 adds the check's full output
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `Deploy ${item.title} (${liveId}), ${startedAt.toISOString()}\n`);
    const steps = [
      deployStep('clean', 'The worktree has no uncommitted changes'),
      deployStep('idle', 'No other running interactive processes or runs'),
      deployStep('check', `Run ${deps.check.join(' ')} in the worktree`),
      deployStep('merge-check', `Check whether merging into ${MAIN_BRANCH} has conflicts`),
      deployStep('merge', `git merge --no-ff ${MAGI_BRANCH} in the main repo`),
      deployStep('restart', 'Back up the database and restart'),
    ];
    const id = db
      .insert(magiDeploys)
      .values({
        liveId,
        engine: item.engine,
        status: 'running',
        steps,
        logFile,
        startedAt,
      })
      .returning({ id: magiDeploys.id })
      .get().id;
    const save = (values: Partial<typeof magiDeploys.$inferInsert>) => {
      db.update(magiDeploys)
        .set({ ...values, steps })
        .where(eq(magiDeploys.id, id))
        .run();
      events.publish({ type: 'magi.deploy', deployId: id, status: deployRow(id).status });
    };
    let commit: string | null = null;
    let backupFile: string | null = null;
    const run = async (stepId: string): Promise<{ ok: boolean; output: string }> => {
      if (stepId === 'clean') {
        const files = await uncommittedFiles(deps.worktree);
        return files.length === 0
          ? { ok: true, output: 'No uncommitted changes' }
          : {
              ok: false,
              output: `The worktree ${deps.worktree} has uncommitted changes:\n${files.join('\n')}`,
            };
      }
      if (stepId === 'idle') {
        const list = busy();
        return list.length === 0
          ? { ok: true, output: 'None' }
          : {
              ok: false,
              output: `Other processes or runs are running; deploy after they finish:\n${list.join('\n')}`,
            };
      }
      if (stepId === 'check') return runCheck(logFile);
      if (stepId === 'merge-check') return mergeCheck();
      if (stepId === 'merge') {
        const merged = await exec(deps.repoDir, 'git', [
          'merge',
          '--no-ff',
          MAGI_BRANCH,
          '-m',
          `Magi Agent deploy: merge ${MAGI_BRANCH}`,
        ]);
        if (!merged.ok) return merged;
        const head = await exec(deps.repoDir, 'git', ['rev-parse', 'HEAD']);
        if (!head.ok) return head;
        commit = head.output.trim();
        return { ok: true, output: commit };
      }
      // The database backup uses SQLite's backup (.backup); then the resume after deploy is recorded and the service exits
      // with code 75
      backupFile = path.join(deps.dataDir, 'backups', `db-${stamp(new Date())}.sqlite`);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      await db.$client.backup(backupFile);
      return { ok: true, output: `Database backed up to ${backupFile}` };
    };
    try {
      for (const step of steps) {
        step.status = 'running';
        step.startedAt = Date.now();
        save({});
        const result = await run(step.id);
        step.output = result.output;
        step.endedAt = Date.now();
        step.status = result.ok ? 'done' : 'failed';
        fs.appendFileSync(logFile, `[${step.status}] ${step.label}: ${result.output}\n`);
        if (!result.ok) {
          const error = `Step failed: ${step.label}: ${result.output}`;
          save({ status: 'failed', error, endedAt: new Date() });
          throw new HttpError(409, error);
        }
        save({ commit, backupFile });
      }
      save({ status: 'restarting' });
    } finally {
      deploying = false;
    }
    return deployView(deployRow(id));
  }

  return {
    view: async (): Promise<MagiAgentView> => {
      const packaged = deps.install !== null;
      const prepared = ready() && preparing === null;
      // The branch status exists only in a git worktree
      const git = prepared && !packaged;
      const counts = git ? await aheadBehind(deps.repoDir) : null;
      const files = git ? await uncommittedFiles(deps.worktree) : null;
      const latest = db.select().from(magiDeploys).orderBy(desc(magiDeploys.id)).get();
      return {
        worktree: {
          source: packaged ? 'package' : 'git',
          path: deps.worktree,
          branch: MAGI_BRANCH,
          state: prepared ? 'ready' : (worktreeState.state ?? 'missing'),
          steps: worktreeState.steps,
          ahead: counts?.ahead ?? null,
          behind: counts?.behind ?? null,
          uncommitted: files?.length ?? null,
          startError,
        },
        sessions: sessionsList(),
        deploy: latest === undefined ? null : deployView(latest),
      };
    },

    // Open (Contracts 23.6): a null liveId creates a new session; otherwise open the chosen session (engine and
    // configuration must match it), resuming it when it has no running process
    open(body: MagiOpenBody): Promise<LiveDetail> {
      if (body.liveId === null) return createSession(body.engine, body.config);
      const item = requireAgent(body.liveId);
      if (item.engine !== body.engine || item.agentConfig !== body.config) {
        throw new HttpError(
          400,
          `Session ${item.id} has engine and configuration ${item.engine}, ${String(item.agentConfig)}, not ${body.engine}, ${body.config}`,
        );
      }
      if (live.running(item.id)) return Promise.resolve(live.get(item.id));
      return startWhenReady(item.id, null);
    },

    // Resume a Magi Agent session, also injecting MAGI.md
    resume(liveId: string): Promise<LiveDetail> {
      requireAgent(liveId);
      return startWhenReady(liveId, null);
    },

    deploy,

    // Restart after a deploy: called after the deploy response is sent; waits a few seconds so the agent's terminal
    // records the response in the session first
    restart: () => {
      setTimeout(deps.restart, RESTART_DELAY_MS);
    },

    deployLog(id: number): string {
      return fs.readFileSync(deployRow(id).logFile, 'utf8');
    },

    // After the service starts (after listening, since hooks need the service address): on a "resume after deploy",
    // resume that session with the message "Deploy complete: <commit>"
    resumeAfterDeploy() {
      const pending = db
        .select()
        .from(magiDeploys)
        .where(eq(magiDeploys.status, 'restarting'))
        .orderBy(desc(magiDeploys.id))
        .all();
      for (const row of pending) {
        db.update(magiDeploys)
          .set({ status: 'done', endedAt: new Date() })
          .where(eq(magiDeploys.id, row.id))
          .run();
        db.insert(liveEvents)
          .values({
            liveId: row.liveId,
            processId: null,
            at: new Date(),
            kind: 'deploy',
            payload: { deployId: row.id, commit: row.commit, backupFile: row.backupFile },
          })
          .run();
        events.publish({ type: 'magi.deploy', deployId: row.id, status: 'done' });
      }
      const last = pending[0];
      if (last !== undefined) {
        startWhenReady(last.liveId, `Deploy complete: ${last.commit ?? ''}`).then(
          () => undefined,
          (error: unknown) => {
            startError = `Starting ${last.liveId} failed: ${error instanceof Error ? error.message : String(error)}`;
            publish();
          },
        );
      }
    },
  };
}

export type MagiAgent = ReturnType<typeof createMagiAgent>;
