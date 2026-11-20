import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sessionTitles } from '../api/session-titles.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessionLayoutOf, syncSessionSkills } from '../drafts/session-config.js';
import {
  type LiveDriver,
  type LiveEngine,
  type LiveEnvironment,
  liveEvents,
  type LiveProcessKind,
  liveProcesses,
  type LivePurpose,
  liveSessions,
  magiDeploys,
  requests,
  runs,
  sessions,
  subagents,
  userMessages,
  variants as variantsTable,
  workflowDrafts,
  workflowTable,
} from '../db/schema.js';
import { events } from '../events.js';
import { createRunTicket } from '../external/linear.js';
import type { RunRepos } from '../external/run-repos.js';
import { ingestFile } from '../ingest/ingest.js';
import { sessionConversation } from '../ingest/conversation.js';
import { restoreCleared } from '../ingest/imports.js';
import { codexHomeOf } from '../ingest/codex.js';
import { importInChunks } from '../ingest/sources.js';
import { newId } from '../runs/index.js';
import type { SettingsStore } from '../runs/settings.js';
import type { EvalFacts, SimulatedGoal, SimulatedPersona } from '../runs/simulated-user.js';
import { ensureImportedBundle, previewLinearImport } from '../tasks/linear-import.js';
import { loadTask, withRepo, withTicket } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { type CodexSources, writeCodexHome } from '../variants/codex-home.js';
import { isolatedBaseEnv, writeSessionClaudeConfig } from '../variants/claude-config.js';
import type { RequireChecks } from '../environment.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { codexMcpServers, readMcpServers } from '../variants/mcp.js';
import { displayName } from '../variants/names.js';
import { sessionSandboxProfile } from '../variants/sandbox.js';
import { entryOf, evalSpec } from '../workflows/eval-kinds.js';
import { evalSpecOf, workflowOfVariant, workflowRow } from '../workflows/index.js';
import type { EvalSpec } from '../workflows/schema.js';
import {
  CodexRunner,
  codexAgentResumeArgs,
  codexAgentStartArgs,
  codexConfigExtra,
  codexDirsOf,
  codexRemoteArgs,
  codexRemoteResumeArgs,
  codexResumeArgs,
  codexStartArgs,
  newSessionId,
  firstUserMessage,
  rolloutFiles,
  waitForSession,
} from './codex.js';
import { type HookPayload, LiveController } from './controller.js';
import { type HandBackReason } from './simulated-driver.js';
import { claudeSessionDirsOf } from './claude-session.js';
import { LivePty, unreleasedPtys } from './pty.js';
import type { Hosts, RemoteHost } from '../remote/hosts.js';
import {
  applyRemoteResume,
  remoteHooks,
  remoteResumeAction,
  requireRemoteDir,
  runScript,
  writeRemoteLive,
} from '../remote/launch.js';
import { listRemoteRollouts } from '../remote/rollouts.js';
import { sshExec } from '../remote/ssh.js';
import { execa } from 'execa';
import { localCopyOf, RemoteSessionSync, type SyncFailure } from '../remote/sync.js';
import { RemoteTerminal, remoteLive, remoteRoot } from '../remote/terminal.js';
import { createRemoteVariants } from '../remote/variant.js';
import type { OrcaPlace } from '../orca/cli.js';
import { OrcaEnvironments, orcaCall, remoteOrcaUserData, showOrcaTerminal } from '../orca/cli.js';
import { OrcaPaneTerminal } from '../orca/terminal.js';
import { isPaneHandle } from '../orca/topology.js';
import { workerRead, workerSend } from '../orca/worker.js';
import { buildOrcaGraph, type GraphItem } from './orca-graph.js';
import { createDirChecks } from './dir-checks.js';
import { isDirectory, pathExists } from '../dirs/exists.js';
import { type AttachedPane, createOrcaSync, type OrcaPaneSpec } from './orca-sync.js';
import type { AttachedWorker, StructuredWorkerSpec } from './orca-sync.js';
import { watchSession } from '../ingest/watch.js';
import {
  bootTime,
  orcaPaneEvent,
  type PaneProcess,
  paneProcessAlive,
  reconcilePaneProcess,
  remotePaneProcessAlive,
  remotePids,
  runningPaneProcesses,
} from './orca-panes.js';
import {
  closeOrcaIdentity,
  createOrcaIdentity,
  identityEnv,
  type OrcaIdentity,
} from '../orca/identity.js';
import { quote } from 'shell-quote';
import {
  divergedName,
  lastMessage,
  relationOf,
  SUMMARY_CHARS,
  syncSessionDir,
} from './resume-plan.js';
import {
  type CreateLiveBody,
  type LiveDetail,
  type LiveEventView,
  type LiveProcessView,
  type LiveStopSource,
  type LiveSummary,
  type OrcaGraph,
  type OrcaGraphMessage,
  type ResumeCopy,
  type ResumeDefaults,
  type ResumeLiveBody,
  type ResumePlan,
  TITLE_MAX,
  type WorkerSendResult,
  type WorkerTranscript,
} from './views.js';

export interface LiveDeps {
  db: Db;
  variants: Variants;
  settings: SettingsStore;
  vaultDir: string;
  product: string;
  // data/live
  liveDir: string;
  // Data directory holding the variants (skills are read from it when a session is bound to a variant)
  dataDir: string;
  // URL the hook command POSTs to: the http://host:port the server actually listens on
  serverUrl: () => string;
  // HOME of the "local config" (claude reads <home>/.claude)
  localHome: string;
  // Copy repos of isolated sessions live on GitHub (Contracts 7.2, 14.2)
  repos: RunRepos;
  // Codex sessions (Contracts 17.3): the command, the source of auth and model config, the timeout for the session record to appear
  codex: { bin: string; sources: CodexSources; sessionTimeoutMs: number };
  // Command that runs Claude Code sessions (config.claudeBin)
  claudeBin: string;
  // Source of credentials and model config for design and analysis-optimize Claude Code sessions (Contracts 22.2), default config.claudeSettingsPath
  claudeSettingsPath?: string | undefined;
  // Auto-stop and "stop process" (Contracts 14.3): after idleMs with no page connected, stop every running session process;
  // stopping sends SIGINT first, then SIGTERM if still alive after graceMs
  autoStop: { idleMs: number; graceMs: number };
  // SSH hosts (Contracts 31): hosts and checks, the directory of local copies of remote sessions (data/remote), the reconnect interval
  remote: { hosts: Hosts; dir: string; reconnectMs: number };
  // Orca (Contracts 35): the orca command and the topology poll interval while a page is connected
  orca: { bin: string; pollMs: number };
  // Paid environment checks an operation needs (Contracts 8): the simulated user before it drives, Codex before a
  // local Codex process starts
  requireChecks: RequireChecks;
}

export const LIVE_ID = /^l-\d{8}-[a-z0-9]{6}$/;

const HOOK_EVENTS = ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart'] as const;

// Default name of a new item: the first 40 characters of the input (Contracts 14.3)
const DEFAULT_TITLE_LENGTH = 40;

// Name of a Magi Agent session before the user submits the first message; then the first 40 characters of it (unless the user renamed it)
export const AGENT_UNTITLED = 'New session';

// Entry command at the start of the initial message (/lfg for Claude Code, $workflow-design for Codex): stripped when prefilling the goal box
const ENTRY_COMMAND = /^[/$][a-z][\w-]*[ \t]*/u;

const defaultTitle = (text: string) =>
  Array.from((text.split('\n')[0] ?? text).trim())
    .slice(0, DEFAULT_TITLE_LENGTH)
    .join('');

// A rename: non-empty after trimming, at most 200 characters; otherwise an error with the reason
export function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') throw new HttpError(400, 'Name cannot be empty');
  const length = Array.from(trimmed).length;
  if (length > TITLE_MAX) {
    throw new HttpError(
      400,
      `Name can be at most ${String(TITLE_MAX)} characters, got ${String(length)}`,
    );
  }
  return trimmed;
}

// Separator line in pty.log at the start of each process (Contracts 14.5)
function separatorLine(at: Date, kind: LiveProcessKind, variant: string): string {
  return `\r\n\u001b[2m──── ${at.toISOString()} · ${kind} · ${variant} ────\u001b[0m\r\n`;
}

// Separator line when reconnecting to a remote process after a dashboard restart (Contracts 31.4): the same process, no new start or resume
function reconnectLine(at: Date, host: string): string {
  return `\r\n\u001b[2m──── ${at.toISOString()} · reconnected to ${host} after dashboard restart ────\u001b[0m\r\n`;
}

// Interval for syncing a remote session back to this machine while connected (Contracts 31.6)
const REMOTE_SYNC_MS = 3000;

// Orca-hosted terminals: read the rendered screen once per second while the tab is in front and a page is connected (Contracts 35.4)
const SCREEN_POLL_MS = 1000;

// How long one Orca sync waits for its working directory checks; one still pending counts as unknown (W139)
const ORCA_DIR_WAIT_MS = 3000;

interface Launch {
  liveId: string;
  kind: LiveProcessKind;
  variantId: string | null;
  // Model and effort chosen at create and resume (Contracts 16.5); not passed for local config
  model: string;
  effort: string;
  environment: LiveEnvironment;
  cwd: string;
  claudeSessionId: string;
  // Arguments before claude's positional ones: --session-id and the initial message, or --resume
  sessionArgs: string[];
  // Name of the session's directory under <CLAUDE_CONFIG_DIR>/projects/ (CLAUDE_CODE_PROJECT_DIR_NAME)
  projectDirName: string;
  driver: LiveDriver;
  // Who the simulated user plays; items with a task and run sessions use the task's persona and hidden requirements, other items use the goal (Contracts 34.2)
  persona: SimulatedPersona | null;
  eval: EvalFacts | null;
  extraEnv: Record<string, string>;
  start: Record<string, unknown>;
  // Design and analysis-optimize Claude Code sessions (Contracts 22.2): the config directory, full env and sandbox are owned by the session,
  // belonging to no variant and not local config; null for other items
  owned: OwnedClaude | null;
}

interface OwnedClaude {
  claudeDir: string;
  env: Record<string, string>;
  // launch writes the hooks settings file claude reads; the sandbox allows it
  sandboxProfile: (hooksFile: string) => string;
}

type ItemRow = typeof liveSessions.$inferSelect;
type ProcessRow = typeof liveProcesses.$inferSelect;

export function createLive(deps: LiveDeps) {
  const { db, variants, settings } = deps;
  const controllers = new Map<string, LiveController | CodexRunner>();
  // Latest sync failure of each remote process (Contracts 31.6); in memory only, cleared on the next successful sync
  const syncFailures = new Map<number, SyncFailure>();
  // Variants on SSH hosts (Contracts 31.5): wf for lfg and ic is prepared at the commit in the txe-workflow repo
  const remoteVariants = createRemoteVariants({
    variants,
    dataDir: deps.dataDir,
    repo: config.txeWorkflowRepo,
  });

  // Processes running when the server last exited: local PTY processes exit with the server; processes on SSH hosts keep
  // running in tmux and are reconnected after the server listens (reattachRemote, Contracts 31.4); agents in Orca keep
  // running in Orca and are picked up by the topology sync (Contracts 35.3)
  const interrupted = db
    .update(liveProcesses)
    .set({ status: 'exited', error: 'Interrupted by a service restart', endedAt: new Date() })
    .where(
      and(
        eq(liveProcesses.status, 'running'),
        sql`${liveProcesses.liveId} in (select ${liveSessions.id} from ${liveSessions} where ${liveSessions.hostId} is null)`,
        sql`not exists (${orcaPaneEvent(sql`${liveProcesses.id}`)})`,
      ),
    )
    .returning({ liveId: liveProcesses.liveId })
    .all();
  for (const r of interrupted) events.publish({ type: 'live.updated', liveId: r.liveId });

  // Codex Magi Agent sessions still named AGENT_UNTITLED (e.g. created before the migration): name them from the first message in the rollout in the user's own ~/.codex
  const unnamed = db
    .select()
    .from(liveSessions)
    .where(
      and(
        eq(liveSessions.purpose, 'agent'),
        eq(liveSessions.engine, 'codex'),
        eq(liveSessions.title, AGENT_UNTITLED),
      ),
    )
    .all();
  for (const item of unnamed) {
    if (item.claudeSessionId === null) continue;
    const message = firstUserMessage(path.join(deps.localHome, '.codex'), item.claudeSessionId);
    if (message !== null) nameAgentItem(item.id, message);
  }

  function row(id: string): ItemRow {
    const found = db.select().from(liveSessions).where(eq(liveSessions.id, id)).get();
    if (found === undefined) throw new HttpError(404, `Live item does not exist: ${id}`);
    return found;
  }

  function processesOf(id: string): ProcessRow[] {
    return db
      .select()
      .from(liveProcesses)
      .where(eq(liveProcesses.liveId, id))
      .orderBy(asc(liveProcesses.id))
      .all();
  }

  // The latest process; null for items imported from this machine that have never run
  function latestProcess(id: string): ProcessRow | null {
    return (
      db
        .select()
        .from(liveProcesses)
        .where(eq(liveProcesses.liveId, id))
        .orderBy(desc(liveProcesses.id))
        .get() ?? null
    );
  }

  function controllerOf(id: string): LiveController | CodexRunner {
    row(id);
    const controller = controllers.get(id);
    if (controller === undefined || latestProcess(id)?.status !== 'running') {
      throw new HttpError(409, `Live item ${id} is not running`);
    }
    return controller;
  }

  // Hooks belong only to Claude Code processes: a Codex turn end is recorded by task_complete in the rollout (Contracts 34.2)
  function claudeControllerOf(id: string): LiveController {
    const controller = controllerOf(id);
    if (controller instanceof CodexRunner) {
      throw new HttpError(409, `Live item ${id} is a Codex session and has no hooks`);
    }
    return controller;
  }

  function liveDir(id: string) {
    return path.join(deps.liveDir, id);
  }

  const localOrca = {
    kind: 'local' as const,
    bin: deps.orca.bin,
  } satisfies OrcaPlace;

  // A variant's Orca skills belong to the Orca version it was built with (Contracts 35.5): after an Orca update it must be rebuilt before starting
  async function requireCurrentOrcaSkills(variantId: string) {
    const variant = variants.get(variantId);
    if (variant.orcaVersion === null) return;
    const current = await variants.orcaVersion();
    if (current === variant.orcaVersion) return;
    throw new HttpError(
      409,
      `The Orca skills of variant ${variant.name} are for Orca ${variant.orcaVersion}, the current Orca is ${current ?? '(no orca command)'}: rebuild this variant before starting`,
    );
  }

  // Record the process's Orca identity on the item (Contracts 35.2): the topology maps a Run's main agent to this item by the orca-identity event
  function recordIdentity(liveId: string, processId: number, identity: OrcaIdentity) {
    db.update(liveSessions)
      .set({ orcaTerminalHandle: identity.handle })
      .where(eq(liveSessions.id, liveId))
      .run();
    db.insert(liveEvents)
      .values({
        liveId,
        processId,
        at: new Date(),
        kind: 'orca-identity',
        payload:
          identity.handle === null
            ? { handle: null, reason: identity.reason }
            : { handle: identity.handle },
      })
      .run();
  }

  // Identity terminals of local processes being closed; the server waits for them on shutdown
  const closingIdentities = new Set<Promise<void>>();

  // Close a process's identity terminal after it exits (remote identities are created on connect/prepare, so take the one at exit); a close failure is recorded verbatim in the process's error
  function closeIdentityOnExit(
    liveId: string,
    controller: { exited: Promise<void>; processId: number },
    place: OrcaPlace,
    identity: () => OrcaIdentity,
  ) {
    const closing = controller.exited
      .then(async () => {
        const handle = identity().handle;
        if (handle !== null) await closeOrcaIdentity(place, handle);
      })
      .then(
        () => undefined,
        (error: unknown) => {
          db.update(liveProcesses)
            .set({
              error: `Closing the Orca identity terminal failed: ${error instanceof Error ? error.message : String(error)}`,
            })
            .where(eq(liveProcesses.id, controller.processId))
            .run();
          events.publish({ type: 'live.updated', liveId });
        },
      )
      .finally(() => {
        closingIdentities.delete(closing);
      });
    // Remote processes keep running after the server shuts down, so their identity terminals stay open
    if (place.kind === 'local') closingIdentities.add(closing);
  }

  // "Stop process" (Contracts 14.3, 31.4): SIGINT first (tmux send-keys C-c on remote), SIGTERM if still alive after graceMs
  // (kill-session on remote), then wait for the process to exit
  async function terminate(controller: LiveController | CodexRunner) {
    await controller.pty.interrupt();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, deps.autoStop.graceMs);
    });
    const outcome = await Promise.race([controller.exited.then(() => 'exited' as const), late]);
    clearTimeout(timer);
    if (outcome === 'late' && controller.pty.alive) await controller.pty.forceStop();
    await controller.exited;
  }

  // A running process no controller holds, because it is an agent in an Orca pane that vanished while the dashboard
  // was down (W116, and on an SSH host W117); null when the process is not one. A pane Orca still lists belongs to the
  // sync, which has not attached it yet, so stopping it here would act behind the sync's back
  async function vanishedPaneOf(
    liveId: string,
    processId: number,
    host: RemoteHost | null,
  ): Promise<PaneProcess | null> {
    const pane = runningPaneProcesses(db, host?.id ?? null).find((p) => p.processId === processId);
    if (pane === undefined) return null;
    // A worker Orca runs without a pane is in no terminal list to begin with; stop ends it through its Dispatch
    if (!isPaneHandle(pane.handle)) return null;
    const handles = await orcaSync.paneHandles(host);
    if (handles?.has(pane.handle) === true) {
      throw new HttpError(
        409,
        `Orca still has the pane ${pane.handle} of live item ${liveId}; the dashboard has not attached it yet, try again in a moment`,
      );
    }
    return pane;
  }

  // A worker Orca runs without a pane behind this item's running process (Contracts 35.4): its Dispatch and the Orca
  // that holds it, for reading the transcript, sending input and "Stop process". Null for every other process
  function structuredWorkerOf(
    item: ItemRow,
    processId: number,
  ): { place: OrcaPlace; version: string; dispatchId: string } | null {
    const handle = item.orcaTerminalHandle;
    if (handle === null || isPaneHandle(handle)) return null;
    const dispatchId = dispatchOfProcess(processId);
    if (dispatchId === null) return null;
    const host = item.hostId === null ? null : deps.remote.hosts.known(item.hostId);
    const at = orcaSync.placeOf(host);
    if (at === null) {
      throw new HttpError(
        409,
        `Orca on ${host?.label ?? 'this machine'} has not been read yet; try again in a moment`,
      );
    }
    return { ...at, dispatchId };
  }

  // "Stop process" on such a process: with the pid gone it is simply recorded as exited; a pid still running is
  // signalled the way a local process is (SIGINT, then SIGTERM after graceMs) before the process is recorded
  async function stopVanishedPane(pane: PaneProcess, host: RemoteHost | null) {
    if (host !== null) {
      await stopVanishedRemotePane(pane, host);
      return;
    }
    const pid = pane.pid;
    const boot = bootTime();
    if (pid !== null && paneProcessAlive(pid, pane.startedAt, boot)) {
      process.kill(pid, 'SIGINT');
      if (!(await goneWithin(pid, pane.startedAt, boot, deps.autoStop.graceMs))) {
        process.kill(pid, 'SIGTERM');
        await goneWithin(pid, pane.startedAt, boot, deps.autoStop.graceMs);
      }
    }
    reconcilePaneProcess(db, pane, paneProcessAlive(pane.pid, pane.startedAt, bootTime()));
  }

  // The same on an SSH host: the pid is read and signalled there, over the same ssh connection
  async function stopVanishedRemotePane(pane: PaneProcess, host: RemoteHost) {
    const pid = pane.pid;
    const aliveNow = async () => {
      const pids = pid === null ? [] : [pid];
      const { boot, alive } = await remotePids(host, pids);
      return remotePaneProcessAlive(pane, boot, alive);
    };
    if (pid !== null && (await aliveNow())) {
      const signal = (name: string) =>
        sshExec(host.target, quote(['kill', `-${name}`, String(pid)]));
      await signal('INT');
      if (!(await goneRemotelyWithin(aliveNow, deps.autoStop.graceMs))) {
        await signal('TERM');
        await goneRemotelyWithin(aliveNow, deps.autoStop.graceMs);
      }
    }
    reconcilePaneProcess(db, pane, await aliveNow());
  }

  async function goneRemotelyWithin(
    alive: () => Promise<boolean>,
    withinMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      if (!(await alive())) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return !(await alive());
  }

  async function goneWithin(
    pid: number,
    startedAt: Date,
    boot: Date,
    withinMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      if (!paneProcessAlive(pid, startedAt, boot)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !paneProcessAlive(pid, startedAt, boot);
  }

  // Auto-stop (Contracts 14.3): start timing when page connections (SSE on /api/events and PTY WebSockets) drop to 0,
  // cancel if one returns within idleMs; if still 0 then, stop every running session process and record auto-stop per item. Eval runs are not affected
  let connections = 0;
  // Time the last connection closed; null if there has been no connection since the server started
  let lastDisconnectAt: Date | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  // Remote items are exempt from auto-stop (Contracts 31.4)
  const localControllers = () => [...controllers.values()].filter((c) => !c.pty.remote);

  function scheduleAutoStop() {
    if (connections > 0 || idleTimer !== null || localControllers().length === 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void autoStopAll();
    }, deps.autoStop.idleMs);
  }

  function cancelAutoStop() {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  async function autoStopAll() {
    if (connections > 0) return;
    const running = localControllers().filter((c) => c.pty.alive);
    for (const c of running) {
      db.insert(liveEvents)
        .values({
          liveId: c.liveId,
          processId: c.processId,
          at: new Date(),
          kind: 'auto-stop',
          payload: {
            lastDisconnectAt: lastDisconnectAt?.toISOString() ?? null,
            idleMs: deps.autoStop.idleMs,
          },
        })
        .run();
      events.publish({ type: 'live.updated', liveId: c.liveId });
    }
    await Promise.all(running.map((c) => terminate(c)));
  }

  // One page connection: call on open; returns the function to call on close (repeated calls count once)
  function connect(): () => void {
    connections += 1;
    cancelAutoStop();
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      connections -= 1;
      if (connections === 0) {
        lastDisconnectAt = new Date();
        scheduleAutoStop();
      }
    };
  }

  // Display name: a deleted variant shows as "<name> (deleted)" (Contracts 24.3)
  function variantName(variantId: string | null): string | null {
    if (variantId === null) return null;
    const v = db
      .select({ name: variantsTable.name, deletedAt: variantsTable.deletedAt })
      .from(variantsTable)
      .where(eq(variantsTable.id, variantId))
      .get();
    return v === undefined ? null : displayName(v);
  }

  // Name of the config a Magi Agent item uses: local config, or "name (workflow)" (Contracts 23.6); null for items of other purposes
  function agentConfigName(config: string | null): string | null {
    if (config === null) return null;
    if (config === 'local') return 'Local config';
    const v = db
      .select({
        name: variantsTable.name,
        workflowId: variantsTable.workflowId,
        deletedAt: variantsTable.deletedAt,
      })
      .from(variantsTable)
      .where(eq(variantsTable.id, config))
      .get();
    if (v === undefined) throw new Error(`Magi Agent config ${config} is not a known variant`);
    return `${displayName(v)} (${v.workflowId})`;
  }

  function processView(p: ProcessRow): LiveProcessView {
    return {
      id: p.id,
      kind: p.kind,
      variantId: p.variantId,
      variantName: variantName(p.variantId),
      pid: p.pid,
      status: p.status,
      exitCode: p.exitCode,
      error: p.error,
      driver: p.driver,
      model: p.model,
      effort: p.effort,
      startedAt: p.startedAt.getTime(),
      endedAt: p.endedAt === null ? null : p.endedAt.getTime(),
    };
  }

  // start event of the first process: the copy repo and ticket created by the isolated environment
  function startPayload(id: string): Record<string, unknown> {
    const start = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(and(eq(liveEvents.liveId, id), eq(liveEvents.kind, 'start')))
      .orderBy(asc(liveEvents.id))
      .get();
    return start?.payload ?? {};
  }

  function summary(r: ItemRow): LiveSummary {
    const all = processesOf(r.id);
    const last = all.at(-1);
    const process = last === undefined ? null : processView(last);
    const start = startPayload(r.id);
    const controller = controllers.get(r.id);
    const draft = db
      .select({
        id: workflowDrafts.id,
        mode: workflowDrafts.mode,
        analysisId: workflowDrafts.analysisId,
      })
      .from(workflowDrafts)
      .where(eq(workflowDrafts.liveId, r.id))
      .get();
    return {
      id: r.id,
      title: r.title,
      claudeSessionId: r.claudeSessionId,
      engine: r.engine,
      purpose: r.purpose,
      // Whether the design is a new workflow or a new variant; null for other purposes
      designMode:
        r.purpose === 'design' && (draft?.mode === 'workflow' || draft?.mode === 'variant')
          ? draft.mode
          : null,
      // The analysis an optimize session belongs to (Contracts 19.3)
      analysisId: r.purpose === 'optimize' ? (draft?.analysisId ?? null) : null,
      draftId: draft?.id ?? null,
      agentConfig: r.agentConfig,
      agentConfigName: agentConfigName(r.agentConfig),
      environment: r.environment,
      workflow: r.workflow,
      input: r.input,
      taskId: r.taskId,
      simulatedGoal: r.simulatedGoal,
      // Prefill of the goal box the first time the simulated user takes over (Contracts 34.2)
      simulatedGoalDefault: initialRequest(r),
      cwd: r.cwd,
      process,
      variantId: process?.variantId ?? null,
      // Design and analysis-optimize sessions have no variant; show the engine's name
      variantName:
        process?.variantName ??
        (isDraftItem(r) && process !== null
          ? r.engine === 'codex'
            ? 'Codex'
            : 'Claude Code'
          : null),
      status: process?.status ?? 'idle',
      driver: process?.driver ?? 'human',
      error: process?.error ?? null,
      syncFailure: last === undefined ? null : (syncFailures.get(last.id) ?? null),
      resumeCount: all.filter((p) => p.kind === 'resume').length,
      starting: process?.status === 'running' && controller?.starting === true,
      repo: typeof start.repo === 'string' ? start.repo : null,
      ticket: typeof start.ticket === 'string' ? start.ticket : null,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      hiddenAt: r.hiddenAt === null ? null : r.hiddenAt.getTime(),
      host: hostOf(r),
      connected:
        r.hostId !== null && process?.status === 'running' && controller !== undefined
          ? controller.pty.connected
          : null,
      orca: orcaView(r, last, controller),
    };
  }

  // Orca state of this item in the list and topology (Contracts 35.4)
  function orcaView(
    r: ItemRow,
    last: ProcessRow | undefined,
    controller: LiveController | CodexRunner | undefined,
  ): LiveSummary['orca'] {
    // The latest process is an agent in an Orca terminal (not one running in the dashboard after resume)
    const hosted =
      last !== undefined &&
      db.$client
        .prepare<[number], { found: number }>(
          `select 1 as found from live_events where process_id = ? and kind in ('start', 'resume') and json_extract(payload, '$.orca') is not null`,
        )
        .get(last.id) !== undefined;
    let state: LiveSummary['orca']['state'] = null;
    if (last?.status === 'exited') state = 'exited';
    else if (last !== undefined && hosted) {
      const runs = orcaSync.topology().runs;
      state =
        runs.flatMap((run) => run.workers).find((w) => w.liveId === r.id)?.state ??
        runs.find((run) => run.coordinator.liveId === r.id)?.coordinator.state ??
        null;
    } else if (last !== undefined && controller instanceof LiveController) {
      if (controller.waiting === null) state = 'working';
      else state = controller.waiting.kind === 'questions' ? 'waiting' : 'idle';
    }
    let identityReason: string | null = null;
    if (!hosted && last !== undefined) {
      const identity = db
        .select({ payload: liveEvents.payload })
        .from(liveEvents)
        .where(
          and(
            eq(liveEvents.liveId, r.id),
            eq(liveEvents.processId, last.id),
            eq(liveEvents.kind, 'orca-identity'),
          ),
        )
        .get();
      const reason = identity?.payload.reason;
      identityReason = typeof reason === 'string' ? reason : null;
    }
    const handle = r.orcaTerminalHandle;
    return {
      hosted,
      handle,
      identityReason,
      runId: r.orcaRunId,
      parentLiveId: r.orcaParentLiveId,
      state,
      paneGone: last === undefined ? null : paneGoneOf(last),
      // A worker Orca runs without a pane: its handle is in no terminal list, so the page reads it through its
      // Dispatch instead of a terminal (Contracts 35.4)
      structured: hosted && handle !== null && !isPaneHandle(handle),
      dispatchId: last === undefined ? null : dispatchOfProcess(last.id),
    };
  }

  // The Dispatch recorded when this process was attached to Orca; null for a main agent and for processes the
  // dashboard runs itself
  function dispatchOfProcess(processId: number): string | null {
    const start = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(
        and(eq(liveEvents.processId, processId), sql`${liveEvents.kind} in ('start', 'resume')`),
      )
      .orderBy(desc(liveEvents.id))
      .get();
    const orca = start?.payload.orca;
    if (orca === null || typeof orca !== 'object') return null;
    const dispatchId = (orca as Record<string, unknown>).dispatchId;
    return typeof dispatchId === 'string' ? dispatchId : null;
  }

  // Warning of a running process whose Orca pane is gone while its own process is still alive (Contracts 35.3): it is
  // left running, so the status line says why Orca no longer shows it. Null once the process ends
  function paneGoneOf(last: ProcessRow): string | null {
    if (last.status !== 'running') return null;
    const warning = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(and(eq(liveEvents.processId, last.id), eq(liveEvents.kind, 'orca-pane-gone')))
      .get();
    const reason = warning?.payload.reason;
    return typeof reason === 'string' ? reason : null;
  }

  // Host shown in the list item and toolbar (Contracts 31.3); label and target are null once the host is deleted
  function hostOf(r: ItemRow): LiveSummary['host'] {
    if (r.hostId === null) return null;
    const host = deps.remote.hosts.brief(r.hostId);
    return { id: r.hostId, label: host?.label ?? null, target: host?.target ?? null };
  }

  function eventViews(id: string): LiveEventView[] {
    return db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.liveId, id))
      .orderBy(asc(liveEvents.id))
      .all()
      .map((e) => ({
        id: e.id,
        processId: e.processId,
        at: e.at.getTime(),
        kind: e.kind,
        payload: e.payload,
      }));
  }

  function detail(id: string): LiveDetail {
    const r = row(id);
    const base = summary(r);
    // Driver switches only count for the latest process
    const evs = eventViews(id);
    const lastDriver = evs.findLast(
      (e) => e.kind === 'driver' && e.processId !== null && e.processId === base.process?.id,
    );
    const reason = lastDriver?.payload.reason;
    const handedBack =
      base.driver === 'human' &&
      (reason === 'input' ||
        reason === 'done' ||
        reason === 'max-turns' ||
        reason === 'error' ||
        reason === 'manual' ||
        reason === 'disconnected')
        ? reason
        : null;
    const controller = controllers.get(id);
    // The one-sentence reason the simulated user gives when it considers the work done (Contracts 34.2)
    const doneReason = lastDriver?.payload.doneReason;
    return {
      ...base,
      waiting: base.status === 'running' && controller !== undefined ? controller.waiting : null,
      handedBack,
      doneReason: handedBack === 'done' && typeof doneReason === 'string' ? doneReason : null,
      processes: processesOf(id).map(processView),
      events: evs,
    };
  }

  // Pass only hooks; never modify the variant's or the user's own settings files (Contracts 14.2)
  function writeHooks(id: string): string {
    const url = `${deps.serverUrl()}/api/live/${id}/hook`;
    const command = `curl -sS --fail-with-body -m 10 -X POST -H 'content-type: application/json' --data-binary @- '${url}' > /dev/null`;
    const hook = { type: 'command', command };
    const file = path.join(liveDir(id), 'hooks.json');
    const settingsFile = {
      skipDangerousModePermissionPrompt: true,
      hooks: {
        ...Object.fromEntries(HOOK_EVENTS.map((name) => [name, [{ hooks: [hook] }]])),
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook] }],
      },
    };
    fs.writeFileSync(file, `${JSON.stringify(settingsFile, null, 2)}\n`);
    return file;
  }

  function configDirOf(variantId: string | null): string {
    return variantId === null
      ? path.join(deps.localHome, '.claude')
      : variants.runtimeEnv(variantId).env.CLAUDE_CONFIG_DIR;
  }

  // Variant used by a Magi Agent item; null for local config
  function agentVariantOf(item: ItemRow): string | null {
    if (item.agentConfig === null)
      throw new Error(`Magi Agent item ${item.id} has no recorded config`);
    return item.agentConfig === 'local' ? null : item.agentConfig;
  }

  function insertItem(values: {
    id: string;
    // Null for Codex draft items until Codex first starts
    claudeSessionId: string | null;
    engine?: 'claude' | 'codex';
    // Defaults to interaction (ordinary items from create, import, resume)
    purpose?: LivePurpose;
    agentConfig?: string;
    title: string;
    environment: LiveEnvironment;
    workflow: string | null;
    input: string | null;
    taskId: string | null;
    cwd: string;
    // Item on an SSH host (Contracts 31.3); defaults to this machine
    hostId?: string | null;
    // Goal for the simulated user (Contracts 34.2); defaults to null, written the first time the simulated user takes over
    simulatedGoal?: string | null;
  }) {
    db.insert(liveSessions)
      .values({ ...values, updatedAt: new Date() })
      .run();
  }

  // Start a process on an item: first start or resume; the caller creates the item. The process's Orca identity is created before starting (Contracts 35.2)
  async function launch(spec: Launch): Promise<LiveDetail> {
    launching.add(spec.liveId);
    const identity = await (async () => {
      if (spec.variantId !== null) await requireCurrentOrcaSkills(spec.variantId);
      return createOrcaIdentity(localOrca, spec.liveId, spec.cwd);
    })().finally(() => {
      launching.delete(spec.liveId);
    });
    const dir = liveDir(spec.liveId);
    fs.mkdirSync(dir, { recursive: true });
    const hooksFile = writeHooks(spec.liveId);
    let env: Record<string, string>;
    let variantArgs: string[];
    // --model and --effort actually passed to claude; null (not passed) for local config
    let model: string | null = null;
    let effort: string | null = null;
    let sandboxProfile: string | null = null;
    let configDir: string;
    if (spec.owned !== null) {
      env = { ...spec.owned.env };
      variantArgs = [];
      sandboxProfile = spec.owned.sandboxProfile(hooksFile);
      configDir = spec.owned.claudeDir;
    } else if (spec.variantId === null) {
      // Local config: no CLAUDE_CONFIG_DIR, claude uses <HOME>/.claude; in the isolated environment it is sandboxed too,
      // the sandbox allows <HOME>/.claude, .claude.json and wf's state directory, so the user's hooks and wf work as usual (Contracts 29.2)
      env = { ...isolatedBaseEnv(), HOME: deps.localHome };
      variantArgs = [];
      configDir = configDirOf(null);
      if (spec.environment === 'isolated') {
        sandboxProfile = variants.localSandboxProfile(spec.liveId, deps.liveDir, deps.localHome);
      }
    } else {
      variants.refreshAuthEnv(spec.variantId);
      // Workspace trust prompt (Contracts 14.2): mark the directory trusted in the variant's config directory first
      variants.trustDirectory(spec.variantId, spec.cwd, await fs.promises.realpath(spec.cwd));
      const runtime = variants.runtimeEnv(spec.variantId);
      env = { ...runtime.env };
      configDir = runtime.env.CLAUDE_CONFIG_DIR;
      model = spec.model;
      effort = spec.effort;
      variantArgs = ['--model', model, '--effort', effort, ...runtime.claudeArgs];
      if (spec.environment === 'isolated') {
        sandboxProfile = variants.sandboxProfile(spec.variantId, spec.liveId, deps.liveDir);
      }
    }
    env = {
      ...env,
      ...spec.extraEnv,
      ...identityEnv(identity, null),
      CLAUDE_CODE_PROJECT_DIR_NAME: spec.projectDirName,
      COLORTERM: 'truecolor',
    };
    const args = [
      ...variantArgs,
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      hooksFile,
      ...spec.sessionArgs,
    ];
    const jsonl = path.join(
      configDir,
      'projects',
      spec.projectDirName,
      `${spec.claudeSessionId}.jsonl`,
    );
    const startedAt = new Date();
    const pty = new LivePty({
      file: sandboxProfile === null ? deps.claudeBin : 'sandbox-exec',
      args: sandboxProfile === null ? args : ['-p', sandboxProfile, deps.claudeBin, ...args],
      cwd: spec.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(
        startedAt,
        spec.kind,
        spec.owned !== null ? 'Claude Code' : (variantName(spec.variantId) ?? 'local config'),
      ),
    });
    const processId = db.$client.transaction(() => {
      // A cleared session returns to the management table when it starts a new process (Contracts 25.1)
      restoreCleared(db, spec.claudeSessionId);
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId: spec.liveId,
          kind: spec.kind,
          variantId: spec.variantId,
          model,
          effort,
          pid: pty.pid,
          status: 'running',
          // The driver stays human until the first SessionStart (Contracts 14.2)
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({
          liveId: spec.liveId,
          processId: inserted.id,
          at: startedAt,
          kind: spec.kind,
          payload: {
            ...spec.start,
            argv: ['claude', ...args],
            sandboxed: sandboxProfile !== null,
            configDir: spec.variantId === null && spec.owned === null ? null : configDir,
            jsonl,
            initialDriver: spec.driver,
          },
        })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, spec.liveId))
        .run();
      recordIdentity(spec.liveId, inserted.id, identity);
      return inserted.id;
    })();
    const controller = new LiveController({
      db,
      settings,
      liveId: spec.liveId,
      processId,
      pty,
      jsonl,
      initialDriver: spec.driver,
      role: () => roleOf(spec.liveId, spec.persona),
      eval: spec.eval,
      variantId: spec.variantId,
      dataDir: deps.dataDir,
      cwd: spec.cwd,
      remote: null,
      reattached: false,
    });
    controllers.set(spec.liveId, controller);
    void controller.exited.then(() => {
      if (controllers.get(spec.liveId) === controller) controllers.delete(spec.liveId);
    });
    closeIdentityOnExit(spec.liveId, controller, localOrca, () => identity);
    scheduleAutoStop();
    events.publish({ type: 'live.updated', liveId: spec.liveId });
    return detail(spec.liveId);
  }

  // Who the simulated user plays; stage is the workflow's eval config, null for a workflow without an eval kind (only the generic end conditions apply)
  const taskPersona = (task: Task, stage: EvalSpec | null): SimulatedPersona => ({
    stage,
    persona: task.persona,
    hiddenRequirements: task.hiddenRequirements,
  });

  // The item's original user request (Contracts 34.2): the input with the leading slash command ($ for Codex) removed; items
  // started from an existing session use its first user message
  function initialRequest(item: ItemRow): string {
    if (item.input !== null && item.input.trim() !== '') {
      return item.input.trim().replace(ENTRY_COMMAND, '');
    }
    const sessionId = item.claudeSessionId;
    if (sessionId === null) return '';
    const items = sessionConversation(db, sessionId) ?? [];
    return items.flatMap((i) => (i.kind === 'user' ? [i.text] : []))[0] ?? '';
  }

  // The item's persona: items with a task use the task's persona and hidden requirements (Contracts 14.4); otherwise null and driven by the goal (34.2)
  function personaOfItem(item: ItemRow): SimulatedPersona | null {
    if (item.taskId === null) return null;
    return taskPersona(
      loadTask(db, item.taskId),
      item.workflow === null ? null : stageOfWorkflow(item.workflow),
    );
  }

  // Who the simulated user plays or the goal it pursues (Contracts 34.2): items with a null persona use their goal, which can change while running
  function roleOf(
    liveId: string,
    persona: SimulatedPersona | null,
  ): SimulatedPersona | SimulatedGoal {
    if (persona !== null) return persona;
    const item = row(liveId);
    const goal = item.simulatedGoal;
    if (goal === null) {
      throw new HttpError(409, `Live item ${liveId} has no goal for the simulated user yet`);
    }
    return {
      goal,
      request: initialRequest(item),
      stage: item.workflow === null ? null : stageOfWorkflow(item.workflow),
    };
  }

  // Goal written in the toolbar or the create/resume form (Contracts 34.2): non-empty after trimming
  function checkGoal(goal: string): string {
    const trimmed = goal.trim();
    if (trimmed === '') throw new HttpError(400, 'Goal cannot be empty');
    return trimmed;
  }

  // Goal written at create or resume: required when the initial driver is the simulated user
  function goalOf(body: { driver: LiveDriver; goal?: string | undefined }): string | null {
    if (body.driver === 'simulated') return checkGoal(body.goal ?? '');
    const goal = body.goal?.trim() ?? '';
    return goal === '' ? null : goal;
  }

  // Resuming an existing item (Contracts 34.2): choosing the simulated user for an item with neither a task nor a goal requires a goal in the dialog
  function requireGoal(
    item: ItemRow | null,
    body: { driver: LiveDriver; goal?: string | undefined },
  ) {
    if (body.driver !== 'simulated') return;
    if (item !== null && item.taskId !== null) return;
    if ((body.goal?.trim() ?? '') !== '') return;
    if (item?.simulatedGoal != null) return;
    throw new HttpError(400, 'Write a goal before handing over to the simulated user');
  }

  // Save the goal written in the dialog (keep the item's existing goal when empty)
  function saveGoal(liveId: string, goal: string | undefined) {
    const next = goal?.trim() ?? '';
    if (next === '' || row(liveId).taskId !== null) return;
    db.update(liveSessions).set({ simulatedGoal: next }).where(eq(liveSessions.id, liveId)).run();
  }

  function setGoal(id: string, goal: string): LiveDetail {
    const item = row(id);
    if (item.taskId !== null) {
      throw new HttpError(
        409,
        `Live item ${id} has a task; the simulated user uses the task's persona, not a goal`,
      );
    }
    db.update(liveSessions)
      .set({ simulatedGoal: checkGoal(goal) })
      .where(eq(liveSessions.id, id))
      .run();
    events.publish({ type: 'live.updated', liveId: id });
    return detail(id);
  }

  // Eval config of a workflow with an eval kind; null without one
  function stageOfWorkflow(workflowId: string): EvalSpec | null {
    const workflow = workflowRow(db, workflowId);
    return workflow.evalKind === null ? null : evalSpec(workflow.evalKind, workflow.id);
  }

  // Model and effort not chosen at create or resume default to the settings (Contracts 16.5)
  function modelOf(body: { model?: string | undefined; effort?: string | undefined }) {
    const { agentModel, agentEffort } = settings.get();
    return { model: body.model ?? agentModel, effort: body.effort ?? agentEffort };
  }

  // Entry commands available to local config (Contracts 29.2): undeleted workflows whose <HOME>/.claude/skills/<entry skill>/SKILL.md exists
  function localEntries(): string[] {
    return db
      .select({ id: workflowTable.id })
      .from(workflowTable)
      .where(isNull(workflowTable.deletedAt))
      .orderBy(asc(workflowTable.createdAt), asc(workflowTable.id))
      .all()
      .map((w) => w.id)
      .filter((id) =>
        fs.existsSync(path.join(deps.localHome, '.claude', 'skills', id, 'SKILL.md')),
      );
  }

  // Contracts 29.2, 16.7: config is a variant or local config; the initial message is /<entry> <input>, or the raw input without a command
  async function create(body: CreateLiveBody): Promise<LiveDetail> {
    if (body.driver === 'simulated') await deps.requireChecks(['model-simulated-user']);
    if (body.hostId !== null) return createRemote(body, body.hostId);
    if (body.engine !== 'claude') {
      throw new HttpError(
        400,
        'New local Live items use Claude Code only; Codex is available only on SSH hosts',
      );
    }
    if (body.variantId !== null) {
      const variant = variants.get(body.variantId);
      if (body.workflow !== null && variant.workflowId !== body.workflow) {
        throw new HttpError(
          400,
          `Variant ${variant.name} belongs to workflow ${variant.workflowId}, not ${body.workflow}`,
        );
      }
      // runtimeEnv exists only after a successful build
      variants.runtimeEnv(body.variantId);
    } else if (body.workflow !== null && !localEntries().includes(body.workflow)) {
      throw new HttpError(
        400,
        `Local config has no entry skill for workflow ${body.workflow}: ${path.join(deps.localHome, '.claude', 'skills', body.workflow, 'SKILL.md')} does not exist`,
      );
    }
    const stage = body.workflow === null ? null : stageOfWorkflow(body.workflow);
    const entry = body.workflow === null ? null : entryOf(body.workflow);
    const liveId = newId('l');
    const sessionId = randomUUID();
    const dir = liveDir(liveId);
    let cwd: string;
    let initial = entry === null ? body.input : `${entry} ${body.input}`;
    let evalFacts: EvalFacts | null = null;
    let extraEnv: Record<string, string> = {};
    let start: Record<string, unknown> = {};
    if (body.environment === 'isolated') {
      if (body.cwd !== null) {
        throw new HttpError(
          400,
          'The dashboard creates the working directory of an isolated environment',
        );
      }
      fs.mkdirSync(dir, { recursive: true });
      cwd = path.join(dir, 'workspace');
      const signal = new AbortController().signal;
      // The process already runs in a sandbox, so Claude Code does not ask whether to trust the working directory
      extraEnv = { CLAUDE_CODE_SANDBOXED: '1', MAGI_VAULT: deps.vaultDir };
      if (stage === null) {
        // No command or no eval kind: just create an empty workspace
        fs.mkdirSync(cwd, { recursive: true });
      } else if (stage.kind === 'lfg') {
        const repo = await deps.repos.createEmpty(liveId, signal);
        // wf obsidian requires the product directory to exist
        await fs.promises.mkdir(path.join(deps.vaultDir, `Project ${deps.product}`), {
          recursive: true,
        });
        extraEnv.MAGI_PRODUCT = deps.product;
        initial = [
          initial,
          '',
          `Product: ${deps.product}`,
          `Feature slug: ${liveId}`,
          `Repository: ${repo.repo}`,
        ].join('\n');
        evalFacts = { runId: liveId, repo: repo.repo, ticket: null, product: deps.product };
        start = { repo: repo.repo, repoUrl: repo.url };
      } else {
        // The issue must be a Linear ticket: read it per section 13, take the starting repo and commit, create the repo copy and ticket copy (copies do not record the source)
        const preview = await previewLinearImport(
          { issue: body.input, criteria: false },
          settings.get().copyRunnerLabels,
        );
        const sourceDir = path.join(dir, 'source');
        await ensureImportedBundle(preview.task, sourceDir);
        const task: Task = { ...preview.task, dir: path.join(sourceDir, preview.task.id) };
        const repo = await deps.repos.createCopy(withRepo(task), liveId, signal);
        const ticket = await createRunTicket(withTicket(task), liveId);
        initial = `${entryOf(stage.id)} ${ticket.identifier}`;
        evalFacts = {
          runId: liveId,
          repo: repo.repo,
          ticket: ticket.identifier,
          product: deps.product,
        };
        start = {
          repo: repo.repo,
          repoUrl: repo.url,
          ticket: ticket.identifier,
          ticketUrl: ticket.url,
          source: preview.issue.identifier,
        };
      }
      if (evalFacts !== null) {
        if (evalFacts.repo === null) throw new Error(`Live item ${liveId} created no repo`);
        await deps.repos.clone(evalFacts.repo, cwd, signal);
      }
    } else {
      if (body.cwd === null)
        throw new HttpError(400, 'The real environment needs a working directory');
      cwd = path.resolve(body.cwd);
      if (!(await isDirectory(cwd))) {
        throw new HttpError(400, `Working directory does not exist: ${cwd}`);
      }
    }
    // Default name: the first 40 characters of the initial message's first line (/lfg <idea>, /ic <ticket>, or the input's first line without a command)
    insertItem({
      id: liveId,
      claudeSessionId: sessionId,
      title: defaultTitle(initial),
      environment: body.environment,
      workflow: body.workflow,
      input: body.input,
      taskId: null,
      cwd,
      simulatedGoal: goalOf(body),
    });
    return launch({
      liveId,
      kind: 'start',
      variantId: body.variantId,
      ...modelOf(body),
      environment: body.environment,
      cwd,
      claudeSessionId: sessionId,
      sessionArgs: ['--session-id', sessionId, initial],
      projectDirName: liveId,
      driver: body.driver,
      persona: null,
      eval: evalFacts,
      extraEnv,
      start: { ...start, initial },
      owned: null,
    });
  }

  // New Live item on an SSH host (Contracts 31.3): the environment is always a real remote directory; config is the remote machine's or a variant (Claude Code only);
  // the host is checked before starting (no reuse), and the remote working path must exist
  async function createRemote(body: CreateLiveBody, hostId: string): Promise<LiveDetail> {
    if (body.environment !== 'real') {
      throw new HttpError(
        400,
        'Live items on SSH hosts run in a real remote directory; there is no isolated environment',
      );
    }
    if (body.cwd === null) throw new HttpError(400, 'A remote working path is required');
    if (body.engine === 'codex' && body.variantId !== null) {
      throw new HttpError(
        400,
        "Variants are for Claude Code only; Codex uses the remote machine's config",
      );
    }
    if (body.engine === 'codex' && body.workflow !== null) {
      throw new HttpError(400, 'Codex takes no command: the input is sent to Codex as is');
    }
    const host = await deps.remote.hosts.ready(hostId, body.engine);
    if (body.variantId !== null) {
      const variant = variants.get(body.variantId);
      if (body.workflow !== null && variant.workflowId !== body.workflow) {
        throw new HttpError(
          400,
          `Variant ${variant.name} belongs to workflow ${variant.workflowId}, not ${body.workflow}`,
        );
      }
      variants.runtimeEnv(body.variantId);
    } else if (body.workflow !== null && !host.check.entries.includes(body.workflow)) {
      throw new HttpError(
        400,
        `The config of ${host.label} has no entry skill for workflow ${body.workflow}: ${host.home}/.claude/skills/${body.workflow}/SKILL.md does not exist`,
      );
    }
    await requireRemoteDir(host, body.cwd);
    const initial = body.workflow === null ? body.input : `${entryOf(body.workflow)} ${body.input}`;
    const liveId = newId('l');
    const sessionId = body.engine === 'claude' ? randomUUID() : null;
    insertItem({
      id: liveId,
      claudeSessionId: sessionId,
      engine: body.engine,
      title: defaultTitle(initial),
      environment: 'real',
      workflow: body.workflow,
      input: body.input,
      taskId: null,
      cwd: body.cwd,
      hostId,
      simulatedGoal: goalOf(body),
    });
    return launchRemote({
      liveId,
      kind: 'start',
      host,
      engine: body.engine,
      variantId: body.variantId,
      ...modelOf(body),
      cwd: body.cwd,
      claudeSessionId: sessionId,
      remotePath: null,
      args:
        body.engine === 'claude'
          ? ['--session-id', sessionId ?? '', initial]
          : [...codexRemoteArgs(body.cwd), initial],
      driver: body.driver,
      persona: null,
      start: { initial },
    });
  }

  interface RemoteLaunch {
    liveId: string;
    kind: LiveProcessKind;
    host: RemoteHost;
    engine: LiveEngine;
    variantId: string | null;
    model: string;
    effort: string;
    cwd: string;
    // A new Codex session has an id only after Codex writes the rollout
    claudeSessionId: string | null;
    // On resume, the remote session file (its local copy); null on create, learned from SessionStart or the rollout
    remotePath: string | null;
    // claude or codex arguments (without hooks and variant arguments)
    args: string[];
    driver: LiveDriver;
    // Who the simulated user plays; items with a task and run sessions use the task's persona and hidden requirements, other items use the goal (Contracts 34.2)
    persona: SimulatedPersona | null;
    start: Record<string, unknown>;
  }

  // Start a process on an SSH host (Contracts 31.4): run.sh runs in the remote tmux session wfd-<liveId>; RemoteTerminal handles connecting,
  // reconnecting and stopping, and RemoteSessionSync syncs the session back to this machine
  function launchRemote(spec: RemoteLaunch): LiveDetail {
    const { host, liveId } = spec;
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    const paths = remoteLive(host, liveId);
    const claude = spec.engine === 'claude';
    // Variant config passes --model and --effort; the remote machine's config uses its own settings
    const model = claude && spec.variantId !== null ? spec.model : null;
    const effort = claude && spec.variantId !== null ? spec.effort : null;
    const argv = claude
      ? [
          host.tool('claude'),
          ...(model === null || effort === null ? [] : ['--model', model, '--effort', effort]),
          '--permission-mode',
          'bypassPermissions',
          '--settings',
          paths.hooks,
          ...spec.args,
        ]
      : [host.tool('codex'), ...spec.args];
    const variantId = spec.variantId;
    // Remote Orca identity (Contracts 35.6): when the host check shows Orca running, create the identity terminal in the remote Orca and put it in run.sh's environment
    let identity: OrcaIdentity = { handle: null, reason: 'Not prepared yet' };
    const remoteOrca: OrcaPlace = { kind: 'remote', host };
    const prepare = async (log: (line: string) => void) => {
      // Variant config (Contracts 31.5): sync to the remote variant config directory, inject the remote credentials and the variant's variables into the process environment,
      // and mark the working directory trusted in the config directory
      let env: Record<string, string> = { COLORTERM: 'truecolor' };
      if (variantId !== null) {
        await requireCurrentOrcaSkills(variantId);
        const prepared = await remoteVariants.prepareRemoteVariant(host, variantId, log);
        await remoteVariants.trustRemoteDirectory(host, prepared.configDir, spec.cwd);
        env = { ...prepared.env, ...env };
      }
      const orca = host.check.orca;
      identity =
        orca?.running === true
          ? await createOrcaIdentity(remoteOrca, liveId, spec.cwd)
          : {
              handle: null,
              reason: orca?.problem ?? `The check of ${host.label} has no Orca entry`,
            };
      recordIdentity(liveId, processId, identity);
      env = { ...env, ...identityEnv(identity, remoteOrcaUserData(host)) };
      await writeRemoteLive(host, liveId, {
        hooks: claude ? remoteHooks(host, liveId) : null,
        run: runScript(host, liveId, { cwd: spec.cwd, env, argv }),
      });
      log(`Wrote ${paths.dir}`);
    };
    const startedAt = new Date();
    // Record the process first: RemoteTerminal starts prepare as soon as it is created, which records the Orca identity per process
    const processId = recordProcess(spec, startedAt, model, effort, {
      ...spec.start,
      engine: spec.engine,
      host: { id: host.id, target: host.target },
      argv,
      tmuxSession: paths.session,
      initialDriver: spec.driver,
    });
    const terminal = new RemoteTerminal({
      host,
      liveId,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(
        startedAt,
        spec.kind,
        `${host.label} · ${claude ? (variantName(variantId) ?? `config of ${host.label}`) : 'Codex'}`,
      ),
      cols: 120,
      rows: 40,
      dashboardPort: dashboardPort,
      prepare,
      reconnectMs: deps.remote.reconnectMs,
    });
    const controller = attachRemote({
      host,
      liveId,
      processId,
      terminal,
      engine: spec.engine,
      variantId,
      cwd: spec.cwd,
      remotePath: spec.remotePath,
      driver: spec.driver,
      persona: spec.persona,
      reattached: false,
    });
    closeIdentityOnExit(liveId, controller, remoteOrca, () => identity);
    return detail(liveId);
  }

  function recordProcess(
    spec: {
      liveId: string;
      kind: LiveProcessKind;
      variantId: string | null;
      claudeSessionId: string | null;
    },
    startedAt: Date,
    model: string | null,
    effort: string | null,
    payload: Record<string, unknown>,
  ): number {
    return db.$client.transaction(() => {
      setHidden(spec.liveId, false, { reason: spec.kind });
      if (spec.claudeSessionId !== null) restoreCleared(db, spec.claudeSessionId);
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId: spec.liveId,
          kind: spec.kind,
          variantId: spec.variantId,
          model,
          effort,
          pid: null,
          status: 'running',
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({
          liveId: spec.liveId,
          processId: inserted.id,
          at: startedAt,
          kind: spec.kind,
          payload,
        })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, spec.liveId))
        .run();
      return inserted.id;
    })();
  }

  // After each sync of a remote session (Contracts 31.6): a failure records its message and time, a success clears it; notify pages on change
  function syncResult(liveId: string, processId: number) {
    return (failure: SyncFailure | null) => {
      const before = syncFailures.get(processId) ?? null;
      if (failure === null) syncFailures.delete(processId);
      else syncFailures.set(processId, failure);
      if (before?.message !== failure?.message || before?.at !== failure?.at) {
        events.publish({ type: 'live.updated', liveId });
      }
    };
  }

  // Controller of a remote process: Claude Code's is driven by hooks (sync starts once SessionStart reports the remote jsonl), Codex's starts
  // syncing once the rollout is found. reattached marks a process reconnected after a dashboard restart
  function attachRemote(spec: {
    host: RemoteHost;
    liveId: string;
    processId: number;
    terminal: RemoteTerminal;
    engine: LiveEngine;
    variantId: string | null;
    cwd: string;
    remotePath: string | null;
    driver: LiveDriver;
    // Who the simulated user plays; items with a task and run sessions use the task's persona and hidden requirements, other items use the goal (Contracts 34.2)
    persona: SimulatedPersona | null;
    reattached: boolean;
  }): LiveController | CodexRunner {
    const { host, liveId, processId, terminal } = spec;
    const sync = new RemoteSessionSync(
      db,
      host,
      deps.remote.dir,
      () => terminal.connected,
      syncResult(liveId, processId),
      REMOTE_SYNC_MS,
    );
    let controller: LiveController | CodexRunner;
    if (spec.engine === 'claude') {
      const item = row(liveId);
      const sessionId = item.claudeSessionId;
      if (sessionId === null)
        throw new Error(`Remote Claude Code Live item ${liveId} has no session id`);
      // Before SessionStart: the project directory for cwd in the remote machine's config (Claude Code's default location)
      const guess = `${host.home}/.claude/projects/${spec.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`;
      const jsonl =
        spec.remotePath === null
          ? localCopyOf(deps.remote.dir, host.id, guess)
          : sync.follow(spec.remotePath);
      controller = new LiveController({
        db,
        settings,
        liveId,
        processId,
        pty: terminal,
        jsonl,
        initialDriver: spec.driver,
        role: () => roleOf(liveId, spec.persona),
        eval: null,
        variantId: spec.variantId,
        dataDir: deps.dataDir,
        cwd: spec.cwd,
        remote: sync,
        reattached: spec.reattached,
      });
    } else {
      const runner = new CodexRunner({
        db,
        settings,
        liveId,
        processId,
        pty: terminal,
        tail: spec.remotePath === null ? null : sync.follow(spec.remotePath),
        remote: sync,
        role: () => roleOf(liveId, spec.persona),
        initialDriver: spec.driver,
      });
      controller = runner;
      if (spec.remotePath === null) void followRemoteCodex(host, liveId, runner, sync, spec.cwd);
    }
    controllers.set(liveId, controller);
    void controller.exited.then(() => {
      if (controllers.get(liveId) === controller) controllers.delete(liveId);
    });
    events.publish({ type: 'live.updated', liveId });
    return controller;
  }

  // Remote Codex writes the rollout only after the initial message is submitted: list remote rollouts every 2 s, record the id of the new session whose cwd is the working path, and sync it
  async function followRemoteCodex(
    host: RemoteHost,
    liveId: string,
    runner: CodexRunner,
    sync: RemoteSessionSync,
    cwd: string,
  ) {
    const dirs = [`${host.home}/.codex/sessions`];
    const known = new Set((await listRemoteRollouts(host, dirs)).map((r) => r.file));
    while (runner.pty.alive) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!runner.pty.connected) continue;
      const found = (await listRemoteRollouts(host, dirs)).find(
        (r) => !known.has(r.file) && r.cwd === cwd,
      );
      if (found === undefined) continue;
      db.update(liveSessions)
        .set({ claudeSessionId: found.id })
        .where(eq(liveSessions.id, liveId))
        .run();
      runner.follow(sync.follow(found.file));
      events.publish({ type: 'live.updated', liveId });
      return;
    }
  }

  // After a dashboard restart (Contracts 31.4): running processes on SSH hosts stay running; check the tmux session: reconnect if it is there,
  // otherwise mark exited with the exit code run.sh wrote (RemoteTerminal checks the session before connecting). The driver becomes human (disconnected during the restart)
  function reattachRemote() {
    const rows = db
      .select({ process: liveProcesses, item: liveSessions })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(
        and(
          eq(liveProcesses.status, 'running'),
          sql`${liveSessions.hostId} is not null`,
          // Agents in a remote Orca are picked up by the topology sync
          sql`not exists (${orcaPaneEvent(sql`${liveProcesses.id}`)})`,
        ),
      )
      .all();
    for (const { process: p, item } of rows) {
      const hostId = item.hostId;
      if (hostId === null || controllers.has(item.id)) continue;
      if (deps.remote.hosts.brief(hostId) === null) {
        db.update(liveProcesses)
          .set({ status: 'exited', error: 'Host deleted', endedAt: new Date() })
          .where(eq(liveProcesses.id, p.id))
          .run();
        events.publish({ type: 'live.updated', liveId: item.id });
        continue;
      }
      const host = deps.remote.hosts.known(hostId);
      if (p.driver === 'simulated') {
        db.update(liveProcesses).set({ driver: 'human' }).where(eq(liveProcesses.id, p.id)).run();
        db.insert(liveEvents)
          .values({
            liveId: item.id,
            processId: p.id,
            at: new Date(),
            kind: 'driver',
            payload: { driver: 'human', reason: 'disconnected' },
          })
          .run();
      }
      const terminal = new RemoteTerminal({
        host,
        liveId: item.id,
        logFile: path.join(liveDir(item.id), 'pty.log'),
        separator: reconnectLine(new Date(), host.label),
        cols: 120,
        rows: 40,
        dashboardPort,
        prepare: null,
        reconnectMs: deps.remote.reconnectMs,
      });
      const controller = attachRemote({
        host,
        liveId: item.id,
        processId: p.id,
        terminal,
        engine: item.engine,
        variantId: p.variantId,
        cwd: item.cwd,
        remotePath: remoteTranscriptOf(item),
        driver: 'human',
        persona: personaOfItem(item),
        reattached: true,
      });
      // The Orca identity created on the remote at process start; closed when it exits
      const handle = item.orcaTerminalHandle;
      closeIdentityOnExit(item.id, controller, { kind: 'remote', host }, () =>
        handle === null ? { handle: null, reason: 'No Orca identity' } : { handle },
      );
    }
  }

  // Session file most recently synced for a remote item: sessions.remote_path, or the transcript_path of the latest SessionStart
  function remoteTranscriptOf(item: ItemRow): string | null {
    if (item.claudeSessionId !== null) {
      const s = db
        .select({ remotePath: sessions.remotePath })
        .from(sessions)
        .where(eq(sessions.id, item.claudeSessionId))
        .get();
      if (s?.remotePath != null) return s.remotePath;
    }
    const hook = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(
        and(
          eq(liveEvents.liveId, item.id),
          eq(liveEvents.kind, 'hook'),
          sql`json_extract(${liveEvents.payload}, '$.hook_event_name') = 'SessionStart'`,
        ),
      )
      .orderBy(desc(liveEvents.id))
      .get();
    const transcript = hook?.payload.transcript_path;
    return typeof transcript === 'string' ? transcript : null;
  }

  // Attach an agent running in an Orca terminal (Contracts 35.3, 35.4): Orca's main agent and workers get a process, controller
  // and terminal like ordinary items; the terminal is Orca's rendered screen (OrcaPaneTerminal), and the session is incrementally imported as usual (remote ones are synced back first)
  function attachOrca(spec: OrcaPaneSpec): AttachedPane {
    const { liveId, place, host, handle } = spec;
    const item = row(liveId);
    if (item.claudeSessionId !== spec.agent.sessionId) {
      db.update(liveSessions)
        .set({ claudeSessionId: spec.agent.sessionId })
        .where(eq(liveSessions.id, liveId))
        .run();
    }
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = new Date();
    const kind: LiveProcessKind = processesOf(liveId).length === 0 ? 'start' : 'resume';
    const processId =
      spec.processId ??
      recordProcess(
        { liveId, kind, variantId: null, claudeSessionId: spec.agent.sessionId },
        startedAt,
        null,
        null,
        {
          engine: spec.engine,
          orca: { handle, dispatchId: spec.dispatchId, hostId: host?.id ?? null },
          pid: spec.agent.pid,
          transcript: spec.agent.transcript,
        },
      );
    if (spec.processId === null) {
      db.update(liveProcesses)
        .set({ pid: spec.agent.pid })
        .where(eq(liveProcesses.id, processId))
        .run();
    }
    const interruptKey = () =>
      orcaCall(place, ['terminal', 'send', '--terminal', handle, '--text=\u0003']);
    // Kill the agent's process (SIGTERM); a process already gone counts as stopped, one that is still there and cannot be stopped fails
    const killScript = 'kill -TERM "$1" 2>/dev/null || ! kill -0 "$1" 2>/dev/null';
    const killAgent = async () => {
      const pid = String(spec.agent.pid);
      const result =
        host === null
          ? await execa('sh', ['-c', killScript, 'kill-agent', pid], { reject: false, input: '' })
          : await sshExec(host.target, quote(['sh', '-c', killScript, 'kill-agent', pid]));
      if (result.exitCode !== 0) {
        throw new Error(
          `Stopping process ${pid} on ${host?.label ?? 'this machine'} failed: ${result.stderr}`,
        );
      }
    };
    const terminal = new OrcaPaneTerminal({
      place,
      handle,
      pid: spec.agent.pid,
      pollMs: SCREEN_POLL_MS,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, kind, `Orca · ${host?.label ?? 'this machine'}`),
      // Orca stops workers (worker-stop); Orca's main agent is asked to exit like pressing Ctrl+C twice (Claude Code exits on the second);
      // if still alive after graceMs (e.g. a worker that already sent worker_done, which worker-stop leaves alone), kill the agent's process
      stop: {
        interrupt: async () => {
          const dispatchId = spec.dispatchId;
          if (dispatchId !== null) {
            await orcaCall(place, ['orchestration', 'worker-stop', '--dispatch', dispatchId]);
            return;
          }
          await interruptKey();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await interruptKey();
        },
        forceStop: killAgent,
      },
      onError: (error) => {
        db.update(liveProcesses)
          .set({ error: error.message })
          .where(eq(liveProcesses.id, processId))
          .run();
        events.publish({ type: 'live.updated', liveId });
      },
    });
    const sync =
      host === null
        ? null
        : new RemoteSessionSync(
            db,
            host,
            deps.remote.dir,
            () => terminal.alive,
            syncResult(liveId, processId),
            REMOTE_SYNC_MS,
          );
    const transcript = sync === null ? spec.agent.transcript : sync.follow(spec.agent.transcript);
    // Handed to the simulated user, it answers by this item's goal (Contracts 34.2)
    const role = () => roleOf(liveId, personaOfItem(row(liveId)));
    const controller =
      spec.engine === 'claude'
        ? new LiveController({
            db,
            settings,
            liveId,
            processId,
            pty: terminal,
            jsonl: transcript,
            initialDriver: 'human',
            role,
            eval: null,
            variantId: null,
            dataDir: deps.dataDir,
            cwd: item.cwd,
            remote: sync,
            reattached: true,
          })
        : new CodexRunner({
            db,
            settings,
            liveId,
            processId,
            pty: terminal,
            tail: transcript,
            remote: sync,
            role,
            initialDriver: 'human',
          });
    controllers.set(liveId, controller);
    void controller.exited.then(() => {
      if (controllers.get(liveId) === controller) controllers.delete(liveId);
    });
    events.publish({ type: 'live.updated', liveId });
    return {
      end: () => {
        terminal.end({ exitCode: null, signal: null, error: null });
      },
      observe: (state) => {
        if (controller instanceof LiveController) controller.observeAgent(state);
      },
    };
  }

  // Take over a worker Orca runs without a pane (Contracts 35.4): there is no screen to mirror and no terminal to
  // drive, so the item gets a process recording what Orca launched and the session import every Orca item has (on
  // an SSH host the session is synced back first). The page reads the worker's transcript and sends it input through
  // its Dispatch (api/live.ts)
  function attachStructuredWorker(spec: StructuredWorkerSpec): AttachedWorker {
    const { liveId, host, worker } = spec;
    if (row(liveId).claudeSessionId !== spec.agent.sessionId) {
      db.update(liveSessions)
        .set({ claudeSessionId: spec.agent.sessionId })
        .where(eq(liveSessions.id, liveId))
        .run();
    }
    const startedAt = new Date();
    const kind: LiveProcessKind = processesOf(liveId).length === 0 ? 'start' : 'resume';
    const processId =
      spec.processId ??
      recordProcess(
        { liveId, kind, variantId: null, claudeSessionId: spec.agent.sessionId },
        startedAt,
        worker.model,
        worker.effort,
        {
          engine: spec.engine,
          orca: { handle: worker.handle, dispatchId: worker.dispatchId, hostId: host?.id ?? null },
          pid: spec.agent.pid,
          transcript: spec.agent.transcript,
        },
      );
    if (spec.processId === null) {
      db.update(liveProcesses)
        .set({ pid: spec.agent.pid })
        .where(eq(liveProcesses.id, processId))
        .run();
    }
    let attached = true;
    const sync =
      host === null
        ? null
        : new RemoteSessionSync(
            db,
            host,
            deps.remote.dir,
            () => attached,
            syncResult(liveId, processId),
            REMOTE_SYNC_MS,
          );
    const transcript = sync === null ? spec.agent.transcript : sync.follow(spec.agent.transcript);
    const watcher = watchSession(db, transcript, (error) => {
      db.update(liveProcesses)
        .set({ error: error.message })
        .where(eq(liveProcesses.id, processId))
        .run();
      events.publish({ type: 'live.updated', liveId });
    });
    events.publish({ type: 'live.updated', liveId });
    return {
      end: () => {
        attached = false;
        const endedAt = new Date();
        db.update(liveProcesses)
          .set({ status: 'exited', endedAt })
          .where(and(eq(liveProcesses.id, processId), eq(liveProcesses.status, 'running')))
          .run();
        db.insert(liveEvents)
          .values({
            liveId,
            processId,
            at: endedAt,
            kind: 'exit',
            payload: { exitCode: null, signal: null, error: null },
          })
          .run();
        events.publish({ type: 'live.updated', liveId });
        // The last of the session: synced back once more on an SSH host, then imported
        void (sync === null ? Promise.resolve() : sync.close(true)).then(() => watcher.close());
      },
    };
  }

  // The Orca page's working directories on this machine, checked without holding the server (W139)
  const orcaDirs = createDirChecks({
    waitMs: ORCA_DIR_WAIT_MS,
    changed: () => {
      events.publish({ type: 'orca.updated' });
    },
  });
  const orcaSync = createOrcaSync({
    db,
    local: localOrca,
    localHome: deps.localHome,
    remoteHosts: () => deps.remote.hosts.withOrca(),
    pollMs: deps.orca.pollMs,
    hasViewers: () => connections > 0,
    attach: attachOrca,
    attachWorker: attachStructuredWorker,
    running: (id) => controllers.has(id),
    // The graph of the new topology names the directories to check before pages read it
    checkDirs: () => {
      orcaGraphOf();
      return orcaDirs.refresh();
    },
  });

  // A Live item as a node of the topology page (Contracts 40.2): the model actually used is the process's, or else
  // the one its session's latest request went to; the cost is its session's
  function graphItem(liveId: string): GraphItem | null {
    const r = db.select().from(liveSessions).where(eq(liveSessions.id, liveId)).get();
    if (r === undefined) return null;
    const s = summary(r);
    const sessionId = r.claudeSessionId;
    const cost =
      sessionId === null
        ? undefined
        : db
            .select({ costUsd: sql<number>`sum(${requests.costUsd})`, n: sql<number>`count(*)` })
            .from(requests)
            .where(eq(requests.sessionId, sessionId))
            .get();
    const latestModel =
      sessionId === null
        ? undefined
        : db
            .select({ model: requests.model })
            .from(requests)
            .where(eq(requests.sessionId, sessionId))
            .orderBy(desc(requests.timestamp))
            .get();
    return {
      title: s.title,
      engine: s.engine,
      state: s.orca.state ?? (s.status === 'running' ? 'idle' : 'exited'),
      cwd: s.cwd,
      host: s.host === null ? null : { id: s.host.id, label: s.host.label },
      model: s.process?.model ?? latestModel?.model ?? null,
      effort: s.process?.effort ?? null,
      costUsd: cost === undefined || cost.n === 0 ? null : cost.costUsd,
    };
  }

  function orcaGraphOf() {
    const items = new Map<string, GraphItem | null>();
    return buildOrcaGraph({
      topology: orcaSync.topology(),
      peers: orcaSync.peers(),
      item: (liveId) => {
        if (!items.has(liveId)) items.set(liveId, graphItem(liveId));
        return items.get(liveId) ?? null;
      },
      locate: (hostId, cwd) => orcaSync.locate(hostId, cwd),
      itemOfSession: (sessionId) => itemOfSession(sessionId)?.id ?? null,
      exists: (dir) => orcaDirs.exists(dir),
      sessionDirs: orcaSync.sessionDirs,
    });
  }

  function orcaNode(nodeId: string): OrcaGraph['nodes'][number] {
    const node = orcaGraphOf().nodes.find((n) => n.id === nodeId);
    if (node === undefined) throw new HttpError(404, `No session ${nodeId} on the Orca page`);
    return node;
  }

  // "Open in Live" on the Orca page (Contracts 40.2): the node's Live item, shown again if it was closed; a node with
  // only a session record gets one through the 14.5 import, its record imported into Sessions first if needed
  async function orcaOpenLive(nodeId: string): Promise<string> {
    const node = orcaNode(nodeId);
    if (node.liveId !== null) {
      unhide(node.liveId);
      return node.liveId;
    }
    if (node.session === null || node.open.live !== null) {
      throw new HttpError(409, node.open.live ?? `${nodeId} has no session record`);
    }
    const record = orcaSync.sessionRecord(node.session.id);
    if (record === null)
      throw new HttpError(409, `The record of session ${node.session.id} is gone`);
    if (
      db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, record.id)).get() ===
      undefined
    ) {
      await importInChunks(db, record.engine, record.file);
    }
    const [item] = importSessions([record.id]);
    if (item === undefined) throw new Error(`Importing session ${record.id} returned no item`);
    // The record's first message is Orca's task text: the item takes the name the Orca page shows (the task's title)
    rename(item.id, node.title);
    events.publish({ type: 'orca.updated' });
    return item.id;
  }

  // The directory "Open in VS Code" opens for a node of the Orca page (Contracts 40.2): its working directory, on the
  // SSH host it ran on
  function orcaNodeDir(nodeId: string): { cwd: string; hostTarget: string | null } {
    const node = orcaNode(nodeId);
    if (node.open.vscode !== null) throw new HttpError(409, node.open.vscode);
    if (node.host === null) return { cwd: node.location.cwd, hostTarget: null };
    const host = deps.remote.hosts.brief(node.host.id);
    if (host === null) throw new HttpError(409, `The SSH host ${node.host.id} was deleted`);
    return { cwd: node.location.cwd, hostTarget: host.target };
  }

  // The Orca environment the desktop Orca reaches an SSH host's runtime through: the paired one named after the host
  // (its address in the ssh target, or its label)
  async function orcaEnvironmentOf(hostId: string): Promise<string> {
    const host = deps.remote.hosts.brief(hostId);
    if (host === null) throw new HttpError(404, `No SSH host ${hostId}`);
    const address = (host.target.split('@').at(-1) ?? host.target).split(':')[0] ?? host.target;
    const { environments } = OrcaEnvironments.parse(
      await orcaCall(localOrca, ['environment', 'list']),
    );
    const paired = environments.find((e) => e.name === address || e.name === host.label);
    if (paired === undefined) {
      throw new HttpError(
        409,
        `The Orca on this machine has no paired environment for ${host.label} (${host.target})`,
      );
    }
    return paired.id;
  }

  function dashboardPort(): number {
    return Number(new URL(deps.serverUrl()).port);
  }

  // Design and analysis-optimize items (Contracts 17.1, 19.3, 22.1): created at once when started, with no process and
  // no session id yet; launchDraft starts them once the draft is prepared. engine is the Codex or Claude Code chosen
  function createDraftItem(input: {
    cwd: string;
    prompt: string;
    title: string;
    workflow: string | null;
    purpose: 'design' | 'optimize';
    engine: 'codex' | 'claude';
  }): LiveDetail {
    const liveId = newId('l');
    insertItem({
      id: liveId,
      claudeSessionId: null,
      engine: input.engine,
      purpose: input.purpose,
      title: Array.from(input.title.trim()).slice(0, DEFAULT_TITLE_LENGTH).join(''),
      // Codex's own sandbox and the sandbox around Claude Code both allow writing only the working directory
      environment: 'isolated',
      workflow: input.workflow,
      input: input.prompt,
      taskId: null,
      cwd: input.cwd,
    });
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // Design and analysis-optimize items (Contracts 17.3, 22.2)
  const isDraftItem = (r: ItemRow) => r.purpose === 'design' || r.purpose === 'optimize';

  // Items being started and not yet registered in controllers
  const launching = new Set<string>();
  // Local sessions whose resume is between its preflight and its launch
  const resuming = new Set<string>();

  // Called when the Sessions page resumes a Magi Agent session (the Magi Agent module is created after live; app.ts
  // sets it)
  let agentResume: ((liveId: string) => Promise<LiveDetail>) | null = null;

  // One process of a design or analysis-optimize session: the first start uses the initial message while the item has
  // no session id; afterwards it resumes the same session
  async function launchDraft(liveId: string, kind: LiveProcessKind): Promise<LiveDetail> {
    const item = row(liveId);
    if (!isDraftItem(item)) {
      throw new HttpError(400, `Live item ${item.id} is not a design or analysis-optimize session`);
    }
    if (item.engine === 'codex') await deps.requireChecks(['codex']);
    if (launching.has(liveId) || controllers.has(liveId) || running(liveId)) {
      throw new HttpError(409, `Live item ${item.id} has a running process`);
    }
    if (kind === 'resume' && item.claudeSessionId === null) {
      throw new HttpError(
        409,
        `Live item ${item.id} has never been started, so there is no session to resume`,
      );
    }
    if (kind === 'start' && item.claudeSessionId !== null) {
      throw new HttpError(
        409,
        `Live item ${item.id} has already been started; resume the session instead`,
      );
    }
    launching.add(liveId);
    const started =
      item.engine === 'codex'
        ? startCodexProcess(item, kind)
        : Promise.resolve().then(() => startDraftClaude(item, kind));
    return started.finally(() => {
      launching.delete(liveId);
    });
  }

  // Claude Code design and analysis-optimize sessions (Contracts 22.2): the configuration directory is claude-config/
  // in the working directory; before every start and resume, credentials, onboarding, trust and the MCP servers of
  // src/mcp.json are rewritten and src/skills is installed into the configuration's skills/ (28.1, 28.2). The process
  // runs in a sandbox that may write only the working directory, the npm cache and ~/.mcp-auth; the session id is
  // generated on the first start
  function startDraftClaude(item: ItemRow, kind: LiveProcessKind): Promise<LiveDetail> {
    const { claudeDir } = claudeSessionDirsOf(item.cwd);
    const layout = sessionLayoutOf(item);
    writeSessionClaudeConfig(
      claudeDir,
      item.cwd,
      deps.claudeSettingsPath,
      readMcpServers(layout.src),
    );
    syncSessionSkills(layout, 'claude');
    const sessionId = item.claudeSessionId ?? randomUUID();
    if (item.claudeSessionId === null) {
      db.update(liveSessions)
        .set({ claudeSessionId: sessionId })
        .where(eq(liveSessions.id, item.id))
        .run();
    }
    setHidden(item.id, false, { reason: kind });
    const program = path.isAbsolute(deps.claudeBin) ? [fs.realpathSync(deps.claudeBin)] : [];
    return launch({
      liveId: item.id,
      kind,
      variantId: null,
      model: '',
      effort: '',
      environment: 'isolated',
      cwd: item.cwd,
      claudeSessionId: sessionId,
      sessionArgs:
        kind === 'start' ? ['--session-id', sessionId, item.input ?? ''] : ['--resume', sessionId],
      projectDirName: item.id,
      driver: 'human',
      persona: null,
      eval: null,
      extraEnv: {},
      start: { engine: 'claude', claudeDir },
      owned: {
        claudeDir,
        env: {
          ...isolatedBaseEnv(),
          CLAUDE_CONFIG_DIR: claudeDir,
          // The process already runs in a sandbox, so Claude Code does not ask whether to trust the working directory
          CLAUDE_CODE_SANDBOXED: '1',
          // npx keeps using the user's own ~/.npm
          npm_config_cache: path.join(os.homedir(), '.npm'),
        },
        sandboxProfile: (hooksFile) => sessionSandboxProfile(item.cwd, [hooksFile, ...program]),
      },
    });
  }

  async function startCodexProcess(item: ItemRow, kind: LiveProcessKind): Promise<LiveDetail> {
    const liveId = item.id;
    const cwd = item.cwd;
    const args =
      item.claudeSessionId === null
        ? codexStartArgs(item.input ?? '')
        : codexResumeArgs(item.claudeSessionId);
    const { codexHome, home } = codexDirsOf(cwd);
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // Rewritten before every start: authentication and model settings may have changed; keys Codex wrote into
    // config.toml itself are dropped and regenerated at the next start. The MCP servers of src/mcp.json go into
    // mcp_servers and src/skills is installed into .agents/skills/ (Contracts 28.1, 28.2)
    const layout = sessionLayoutOf(item);
    const mcpServers = codexMcpServers(readMcpServers(layout.src));
    const { model, effort } = writeCodexHome(codexHome, deps.codex.sources, {
      ...codexConfigExtra(cwd),
      ...(Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
    });
    syncSessionSkills(layout, 'codex');
    const identity = await createOrcaIdentity(localOrca, liveId, cwd);
    const env = {
      ...isolatedBaseEnv(),
      HOME: home,
      CODEX_HOME: codexHome,
      // npx keeps using the user's own ~/.npm
      npm_config_cache: path.join(os.homedir(), '.npm'),
      ...identityEnv(identity, null),
      COLORTERM: 'truecolor',
    };
    const known = new Set(rolloutFiles(codexHome));
    const startedAt = new Date();
    const pty = new LivePty({
      file: deps.codex.bin,
      args,
      cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, kind, 'Codex'),
    });
    const sessionId =
      item.claudeSessionId ??
      (await waitForSession(pty, codexHome, cwd, known, deps.codex.sessionTimeoutMs));
    const processId = db.$client.transaction(() => {
      if (item.claudeSessionId === null) {
        db.update(liveSessions)
          .set({ claudeSessionId: sessionId })
          .where(eq(liveSessions.id, liveId))
          .run();
      }
      setHidden(liveId, false, { reason: kind });
      restoreCleared(db, sessionId);
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId,
          kind,
          variantId: null,
          model,
          effort,
          pid: pty.pid,
          status: 'running',
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({
          liveId,
          processId: inserted.id,
          at: startedAt,
          kind,
          payload: { engine: 'codex', argv: [deps.codex.bin, ...args], codexHome, home, sessionId },
        })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, liveId))
        .run();
      recordIdentity(liveId, inserted.id, identity);
      return inserted.id;
    })();
    const runner = new CodexRunner({
      db,
      settings,
      liveId,
      processId,
      pty,
      // This session's rollout: imported incrementally, and turn-end records are read from it (Contracts 34.2)
      tail: rolloutOf(codexHome, sessionId),
      role: () => roleOf(liveId, null),
      initialDriver: 'human',
    });
    controllers.set(liveId, runner);
    void runner.exited.then(() => {
      if (controllers.get(liveId) === runner) controllers.delete(liveId);
    });
    closeIdentityOnExit(liveId, runner, localOrca, () => identity);
    scheduleAutoStop();
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // A session's rollout file; empty until it is written
  function rolloutOf(codexHome: string, sessionId: string): string | null {
    return rolloutFiles(codexHome).find((f) => f.endsWith(`-${sessionId}.jsonl`)) ?? null;
  }

  // Magi Agent sessions (Contracts 23.1): real environment, cwd is the worktree, config is local or a variant id. A
  // Claude Code session id is fixed when the item is created; a Codex one is recorded once the user submits the first
  // message and Codex writes the rollout
  function createAgentItem(input: { engine: LiveEngine; config: string; cwd: string }): LiveDetail {
    const liveId = newId('l');
    insertItem({
      id: liveId,
      claudeSessionId: input.engine === 'claude' ? randomUUID() : null,
      engine: input.engine,
      purpose: 'agent',
      agentConfig: input.config,
      title: AGENT_UNTITLED,
      environment: 'real',
      workflow: null,
      input: null,
      taskId: null,
      cwd: input.cwd,
    });
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // A Magi Agent session is named after the user's first message, only while its title is still "New session" (a
  // title the user changed is kept)
  function nameAgentItem(liveId: string, message: string) {
    const item = row(liveId);
    const title = defaultTitle(message);
    if (item.purpose !== 'agent' || item.title !== AGENT_UNTITLED || title === '') return;
    db.update(liveSessions).set({ title }).where(eq(liveSessions.id, liveId)).run();
    events.publish({ type: 'live.updated', liveId });
  }

  // Start or resume a Magi Agent session (Contracts 23.3): the local configuration or a variant's, with MAGI.md
  // appended to the system prompt; with no conversation yet (nothing submitted since the start) the same session is
  // started again. message is the message submitted on resume (deploy finished)
  async function launchAgent(
    liveId: string,
    opts: { instructions: string; message: string | null },
  ): Promise<LiveDetail> {
    const item = row(liveId);
    if (item.purpose !== 'agent') {
      throw new HttpError(400, `Live item ${item.id} is not a Magi Agent session`);
    }
    if (item.engine === 'codex') await deps.requireChecks(['codex']);
    if (launching.has(liveId) || controllers.has(liveId) || running(liveId)) {
      throw new HttpError(409, `Live item ${item.id} has a running process`);
    }
    // The agent passes its own live id when calling the deploy API; the dashboard address is the one the service
    // actually listens on
    const magiEnv = { MAGI_LIVE_ID: liveId, MAGI_DASHBOARD_URL: deps.serverUrl() };
    const message = opts.message === null ? [] : [opts.message];
    if (item.engine === 'codex') return startAgentCodex(item, opts, magiEnv);
    const sessionId = item.claudeSessionId;
    if (sessionId === null)
      throw new Error(`Magi Agent Claude Code session ${liveId} has no session id`);
    const variantId = agentVariantOf(item);
    // A variant that was deleted or never built fails here with its error; the item counts as launching while its
    // copy is looked for
    const configDir = configDirOf(variantId);
    launching.add(liveId);
    const copy = await locate(configDir, sessionId).finally(() => {
      launching.delete(liveId);
    });
    const kind = copy === null ? 'start' : 'resume';
    // Continuing a closed session from the popover shows it again
    setHidden(liveId, false, { reason: kind });
    return launch({
      liveId,
      kind,
      variantId,
      ...modelOf({}),
      environment: 'real',
      cwd: item.cwd,
      claudeSessionId: sessionId,
      sessionArgs:
        kind === 'start'
          ? ['--append-system-prompt', opts.instructions, '--session-id', sessionId, ...message]
          : ['--resume', sessionId, '--append-system-prompt', opts.instructions, ...message],
      projectDirName: liveId,
      driver: 'human',
      persona: null,
      eval: null,
      extraEnv: magiEnv,
      start: { magiAgent: true, message: opts.message },
      owned: null,
    });
  }

  async function startAgentCodex(
    item: ItemRow,
    opts: { instructions: string; message: string | null },
    magiEnv: Record<string, string>,
  ): Promise<LiveDetail> {
    const liveId = item.id;
    const kind: LiveProcessKind = item.claudeSessionId === null ? 'start' : 'resume';
    const args =
      item.claudeSessionId === null
        ? codexAgentStartArgs(item.cwd, opts.instructions, opts.message)
        : codexAgentResumeArgs(item.cwd, opts.instructions, item.claudeSessionId, opts.message);
    // The user's own ~/.codex: CODEX_HOME is not set and HOME is unchanged
    const env: Record<string, string> = {
      ...isolatedBaseEnv(),
      HOME: deps.localHome,
      ...magiEnv,
      COLORTERM: 'truecolor',
    };
    const codexHome = env.CODEX_HOME ?? path.join(deps.localHome, '.codex');
    const known = new Set(rolloutFiles(codexHome));
    const runner = await spawnCodex({
      item,
      kind,
      args,
      env,
      payload: {
        engine: 'codex',
        magiAgent: true,
        argv: [deps.codex.bin, ...args],
        codexHome,
        sessionId: item.claudeSessionId,
        message: opts.message,
      },
      tail: item.claudeSessionId === null ? null : rolloutOf(codexHome, item.claudeSessionId),
    });
    if (item.claudeSessionId === null || item.title === AGENT_UNTITLED) {
      void followCodexSession(liveId, runner, codexHome, known);
    }
    return detail(liveId);
  }

  // Start a Codex process on an item (Magi Agent and resume from the Sessions page), recording the process and its
  // events; tail is the rollout to import incrementally (stopped when the process ends), and turn-end records are read
  // from it too (Contracts 34.2)
  async function spawnCodex(spec: {
    item: ItemRow;
    kind: LiveProcessKind;
    args: string[];
    env: Record<string, string>;
    payload: Record<string, unknown>;
    tail: string | null;
    driver?: LiveDriver;
  }): Promise<CodexRunner> {
    const { item, kind, args } = spec;
    const liveId = item.id;
    launching.add(liveId);
    const identity = await createOrcaIdentity(localOrca, liveId, item.cwd).finally(() => {
      launching.delete(liveId);
    });
    const env = { ...spec.env, ...identityEnv(identity, null) };
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = new Date();
    const pty = new LivePty({
      file: deps.codex.bin,
      args,
      cwd: item.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, kind, 'Codex'),
    });
    const processId = db.$client.transaction(() => {
      setHidden(liveId, false, { reason: kind });
      if (item.claudeSessionId !== null) restoreCleared(db, item.claudeSessionId);
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId,
          kind,
          variantId: null,
          pid: pty.pid,
          status: 'running',
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({ liveId, processId: inserted.id, at: startedAt, kind, payload: spec.payload })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, liveId))
        .run();
      recordIdentity(liveId, inserted.id, identity);
      return inserted.id;
    })();
    const runner = new CodexRunner({
      db,
      settings,
      liveId,
      processId,
      pty,
      tail: spec.tail,
      role: () => roleOf(liveId, personaOfItem(row(liveId))),
      initialDriver: spec.driver ?? 'human',
    });
    controllers.set(liveId, runner);
    void runner.exited.then(() => {
      if (controllers.get(liveId) === runner) controllers.delete(liveId);
    });
    closeIdentityOnExit(liveId, runner, localOrca, () => identity);
    scheduleAutoStop();
    events.publish({ type: 'live.updated', liveId });
    return runner;
  }

  // Resume a Codex session from the Sessions page (Contracts 25.2): codex resume <id> in the CODEX_HOME it lives in,
  // with this machine's HOME and no update check at start (as in 23.3); sandbox and approvals follow that CODEX_HOME's
  // own configuration. Design and optimize sessions resume on their own items per 17.3 and 22.2
  async function resumeCodex(
    session: typeof sessions.$inferSelect,
    item: ItemRow | null,
    cwd: string,
    codexHome: string,
    body: ResumeLiveBody,
  ): Promise<LiveDetail> {
    if (item !== null && isDraftItem(item)) return launchDraft(item.id, 'resume');
    await deps.requireChecks(['codex']);
    const liveId = item?.id ?? newId('l');
    db.$client.transaction(() => {
      if (item === null) {
        insertItem({
          id: liveId,
          claudeSessionId: session.id,
          engine: 'codex',
          title: sessionListTitle(session.id),
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd,
        });
      }
      db.update(sessions).set({ liveId }).where(eq(sessions.id, session.id)).run();
    })();
    saveGoal(liveId, body.goal);
    const args = ['resume', '--no-daemon', '-c', 'check_for_update_on_startup=false', session.id];
    await spawnCodex({
      item: row(liveId),
      kind: 'resume',
      args,
      env: {
        ...isolatedBaseEnv(),
        HOME: deps.localHome,
        CODEX_HOME: codexHome,
        COLORTERM: 'truecolor',
      },
      payload: {
        engine: 'codex',
        argv: [deps.codex.bin, ...args],
        codexHome,
        sessionId: session.id,
      },
      tail: session.filePath,
      driver: body.driver,
    });
    return detail(liveId);
  }

  // Codex writes the rollout only after the user submits the first message: while the process runs, look once a
  // second for a new rollout whose cwd is the worktree, then record the session id and start importing it (turn-end
  // records are read from it too, Contracts 34.2); while the title is still "New session", name it after the user's
  // first message from the rollout
  async function followCodexSession(
    liveId: string,
    runner: CodexRunner,
    codexHome: string,
    known: Set<string>,
  ) {
    const cwd = row(liveId).cwd;
    // Once the worktree is deleted the process's cwd is gone; stop looking
    while (runner.pty.alive && (await pathExists(cwd))) {
      const item = row(liveId);
      let sessionId = item.claudeSessionId;
      if (sessionId === null) {
        sessionId = await newSessionId(codexHome, cwd, known);
        if (sessionId !== null) {
          db.update(liveSessions)
            .set({ claudeSessionId: sessionId })
            .where(eq(liveSessions.id, liveId))
            .run();
          const rollout = rolloutOf(codexHome, sessionId);
          if (rollout !== null) runner.follow(rollout);
          events.publish({ type: 'live.updated', liveId });
        }
      }
      if (sessionId !== null) {
        if (item.title !== AGENT_UNTITLED) return;
        const message = firstUserMessage(codexHome, sessionId);
        if (message !== null) {
          nameAgentItem(liveId, message);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  // The copy of a session in a configuration directory's projects/<project>/<session id>.jsonl
  async function locate(configDir: string, sessionId: string): Promise<string | null> {
    const projects = path.join(configDir, 'projects');
    if (!(await isDirectory(projects))) return null;
    for (const entry of await fs.promises.readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (await pathExists(file)) return file;
    }
    return null;
  }

  // The simulated user of a resumed session: a run's session uses the run's task, an interactive session its task;
  // a session with no task is driven by this item's goal (Contracts 34.2) with an empty persona
  function resumePersona(
    session: typeof sessions.$inferSelect,
    item: ItemRow | null,
  ): SimulatedPersona | null {
    if (session.runId !== null) {
      const run = db.select().from(runs).where(eq(runs.id, session.runId)).get();
      if (run !== undefined) {
        return taskPersona(
          loadTask(db, run.taskId),
          evalSpecOf(db, workflowOfVariant(db, run.variantId)),
        );
      }
    }
    return item === null ? null : personaOfItem(item);
  }

  // The item this session belongs to (Contracts 14.5: same live_sessions.claude_session_id)
  function itemOfSession(sessionId: string): ItemRow | null {
    return (
      db.select().from(liveSessions).where(eq(liveSessions.claudeSessionId, sessionId)).get() ??
      null
    );
  }

  function running(id: string): boolean {
    return latestProcess(id)?.status === 'running';
  }

  // Default title of an item started from an existing session: that session's title in the Sessions list
  function sessionListTitle(sessionId: string): string {
    const title = sessionTitles(db, [sessionId]).get(sessionId) ?? '';
    return title === '' ? `session ${sessionId.slice(0, 8)}` : title;
  }

  async function resumeDefaults(sessionId: string): Promise<ResumeDefaults> {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `Session not found: ${sessionId}`);
    const item = itemOfSession(sessionId);
    // Defaults to the variant bound to the session (Contracts 15.1); the local configuration when unbound or the bound
    // variant was deleted (24.3). A Codex session resumes in its own CODEX_HOME with no configuration to choose (25.2)
    const bound =
      session.variantId === null || session.engine === 'codex'
        ? undefined
        : db
            .select({ deletedAt: variantsTable.deletedAt })
            .from(variantsTable)
            .where(eq(variantsTable.id, session.variantId))
            .get();
    return {
      sessionId,
      engine: session.engine,
      variantId: bound?.deletedAt === null ? session.variantId : null,
      cwd: session.cwd,
      // A session on an SSH host: the working directory is remote and the preflight checks it over ssh
      cwdExists:
        session.hostId !== null || (session.cwd !== null && (await pathExists(session.cwd))),
      liveId: item?.id ?? null,
      running: item !== null && running(item.id),
      hostId: session.hostId,
      simulatedGoal: item?.simulatedGoal ?? null,
      simulatedGoalDefault:
        item === null
          ? ((sessionConversation(db, sessionId) ?? []).flatMap((i) =>
              i.kind === 'user' ? [i.text] : [],
            )[0] ?? '')
          : initialRequest(item),
      hasTask: item?.taskId != null,
    };
  }

  async function copyOf(file: string): Promise<ResumeCopy> {
    const last = await lastMessage(file);
    return {
      path: file,
      bytes: (await fs.promises.stat(file)).size,
      lastAt: last.at,
      lastRole: last.role,
      lastText: last.text,
    };
  }

  // The last message of a Codex rollout: the later of the last imported user input and the last reply
  async function codexCopyOf(session: typeof sessions.$inferSelect): Promise<ResumeCopy> {
    const user = db
      .select({ at: userMessages.timestamp, text: userMessages.text })
      .from(userMessages)
      .where(and(eq(userMessages.sessionId, session.id), eq(userMessages.kind, 'user')))
      .orderBy(desc(userMessages.timestamp), desc(userMessages.id))
      .get();
    const reply = db
      .select({ at: requests.timestamp, text: requests.text })
      .from(requests)
      .where(and(eq(requests.sessionId, session.id), sql`${requests.text} is not null`))
      .orderBy(desc(requests.timestamp), desc(requests.id))
      .get();
    const last =
      reply !== undefined && (user === undefined || reply.at >= user.at)
        ? { ...reply, role: 'assistant' as const }
        : user === undefined
          ? undefined
          : { ...user, role: 'user' as const };
    const flat = last?.text?.replace(/\s+/g, ' ').trim() ?? null;
    return {
      path: session.filePath,
      bytes: (await fs.promises.stat(session.filePath)).size,
      lastAt: last?.at.toISOString() ?? null,
      lastRole: last?.role ?? null,
      lastText:
        flat === null || flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS)}…`,
    };
  }

  // Resume preflight of a Codex session (Contracts 25.2): codex resume in its own CODEX_HOME, no copy, no variant
  async function codexResumePlan(
    session: typeof sessions.$inferSelect,
    variantId: string | null,
    item: ItemRow | null,
  ): Promise<ResumePlan> {
    if (variantId !== null) {
      throw new HttpError(
        400,
        'A Codex session resumes in its own CODEX_HOME; a variant cannot be chosen',
      );
    }
    const problems: ResumePlan['problems'] = [];
    if (session.cwd === null) {
      problems.push({
        code: 'no-cwd',
        message:
          'This session has no recorded working directory, so there is nowhere to continue it.',
      });
    } else if (!(await isDirectory(session.cwd))) {
      problems.push({
        code: 'cwd-missing',
        message: `Working directory ${session.cwd} no longer exists. Put it back, then resume.`,
      });
    }
    if (session.archivedAt !== null) {
      problems.push({
        code: 'archived',
        message: 'This session is archived. Restore it on the Sessions page, then resume.',
      });
    }
    if (item !== null && (controllers.has(item.id) || running(item.id))) {
      problems.push({
        code: 'running',
        message: `This session is running in Live item "${item.title}". Stop the process there, then resume.`,
      });
    }
    const exists = await pathExists(session.filePath);
    if (!exists) {
      problems.push({
        code: 'file-missing',
        message: `Session file ${session.filePath} no longer exists (moved or deleted); there is no record to continue from.`,
      });
    }
    return {
      sessionId: session.id,
      variantId: null,
      configDir: codexHomeOf(session.filePath),
      liveId: item?.id ?? null,
      cwd: session.cwd,
      model: null,
      effort: null,
      action: problems.length > 0 ? 'blocked' : 'resume',
      latest: exists ? await codexCopyOf(session) : null,
      target: null,
      problems,
      notes: [],
    };
  }

  // Resume preflight (Contracts 14.5, 31.3): a session on an SSH host is checked over ssh
  function resumePlan(sessionId: string, variantId: string | null): Promise<ResumePlan> {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `Session not found: ${sessionId}`);
    if (session.hostId !== null) {
      return remoteResumePlan(session, session.hostId, variantId, itemOfSession(sessionId));
    }
    return localResumePlan(sessionId, variantId);
  }

  // Preflight of a local session (Contracts 14.5): which configuration and which jsonl it continues with, or why it
  // cannot resume
  async function localResumePlan(sessionId: string, variantId: string | null): Promise<ResumePlan> {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `Session not found: ${sessionId}`);
    const item = itemOfSession(sessionId);
    if (session.engine === 'codex') return codexResumePlan(session, variantId, item);
    const problems: ResumePlan['problems'] = [];
    const notes: string[] = [];
    if (session.cwd === null) {
      problems.push({
        code: 'no-cwd',
        message:
          'This session has no recorded working directory, so there is nowhere to continue it.',
      });
    } else if (!(await isDirectory(session.cwd))) {
      problems.push({
        code: 'cwd-missing',
        message: `Working directory ${session.cwd} no longer exists. Put it back, then resume.`,
      });
    }
    let configDir: string;
    if (variantId === null) {
      configDir = configDirOf(null);
    } else {
      const variant = variants.get(variantId);
      configDir = variants.layout(variantId).claudeDir;
      if (variant.buildStatus !== 'built' || variant.builtHash !== variant.skillsHash) {
        problems.push({
          code: 'variant-not-built',
          message: `Variant ${variant.name} has not been built from its current content. Build it on the variant page or choose another configuration.`,
        });
      }
    }
    if (item !== null && (controllers.has(item.id) || running(item.id))) {
      problems.push({
        code: 'running',
        message: `This session is running in Live item "${item.title}". Stop the process there, then resume.`,
      });
    }
    const latestExists = await pathExists(session.filePath);
    const targetFile = await locate(configDir, session.id);
    const latest = latestExists ? await copyOf(session.filePath) : null;
    const target = targetFile === null ? null : await copyOf(targetFile);
    let action: ResumePlan['action'];
    if (!latestExists) {
      problems.push({
        code: 'file-missing',
        message:
          targetFile === null
            ? `Session file ${session.filePath} no longer exists (moved or deleted); there is no record to continue from.`
            : `The latest session file ${session.filePath} no longer exists; the target configuration has a copy at ${targetFile}, but it cannot be confirmed to hold the whole conversation, so it is not continued. Put the file back, then resume.`,
      });
      action = 'blocked';
    } else if (targetFile === null) {
      action = 'copy';
    } else {
      const relation = await relationOf(session.filePath, targetFile);
      action = relation === 'behind' ? 'sync' : relation === 'diverged' ? 'diverged' : 'resume';
    }
    if (problems.length > 0) action = 'blocked';
    // A session with subagents keeps their records in the directory named like the jsonl, copied and synced with it
    const subagentCount = db
      .select({ n: sql<number>`count(*)` })
      .from(subagents)
      .where(eq(subagents.sessionId, session.id))
      .get()?.n;
    const sessionDir = path.join(path.dirname(session.filePath), session.id);
    if ((subagentCount ?? 0) > 0 && latestExists && !(await pathExists(sessionDir))) {
      notes.push(
        `Subagent record directory ${sessionDir} is missing: the main conversation continues, but earlier subagent details are not carried into the target configuration.`,
      );
    }
    const { agentModel, agentEffort } = settings.get();
    return {
      sessionId,
      variantId,
      configDir,
      liveId: item?.id ?? null,
      cwd: session.cwd,
      model: variantId === null ? null : agentModel,
      effort: variantId === null ? null : agentEffort,
      action,
      latest,
      target,
      problems,
      notes,
    };
  }

  // Preflight of a session on an SSH host (Contracts 31.3): it resumes only on its host; the host is checked again
  // (no reuse), and the working directory and how the two session copies relate are checked remotely. The
  // configuration is the remote machine's (~/.claude, ~/.codex for Codex) or a variant (Claude Code only)
  async function remoteResumePlan(
    session: typeof sessions.$inferSelect,
    hostId: string,
    variantId: string | null,
    item: ItemRow | null,
  ): Promise<ResumePlan> {
    const problems: ResumePlan['problems'] = [];
    const base = {
      sessionId: session.id,
      variantId,
      liveId: item?.id ?? null,
      cwd: session.cwd,
      model: null,
      effort: null,
      notes: [],
    };
    const blocked = (configDir: string): ResumePlan => ({
      ...base,
      configDir,
      action: 'blocked',
      latest: null,
      target: null,
      problems,
    });
    if (session.engine === 'codex' && variantId !== null) {
      throw new HttpError(
        400,
        "A Codex session resumes with the remote machine's configuration; a variant cannot be chosen",
      );
    }
    if (deps.remote.hosts.brief(hostId) === null) {
      problems.push({
        code: 'host',
        message: 'The SSH host of this session was deleted, so it cannot resume.',
      });
      return blocked('');
    }
    const view = await deps.remote.hosts.check(hostId);
    const check = view.check;
    if (check === null) throw new Error(`Host ${hostId} has no result after the check`);
    const missing = [...check.problems];
    if (check.connected && !check.engines.includes(session.engine)) {
      missing.push(`No ${session.engine === 'codex' ? 'Codex' : 'Claude Code'}`);
    }
    if (missing.length > 0) {
      problems.push({
        code: 'host',
        message: `Cannot launch on ${view.label}: ${missing.join('; ')}`,
      });
      return blocked('');
    }
    const host = deps.remote.hosts.known(hostId);
    const configDir =
      session.engine === 'codex'
        ? `${host.home}/.codex`
        : variantId === null
          ? `${host.home}/.claude`
          : remoteRoot(host).variant(variantId);
    if (session.cwd === null) {
      problems.push({
        code: 'no-cwd',
        message:
          'This session has no recorded working directory, so there is nowhere to continue it.',
      });
    } else {
      const cd = await sshExec(host.target, `cd -- ${quote([session.cwd])}`);
      if (cd.exitCode !== 0) {
        problems.push({
          code: 'cwd-missing',
          message: `Cannot enter working directory ${session.cwd} on ${host.label}: ${cd.stderr.trim()}`,
        });
      }
    }
    if (variantId !== null) {
      const variant = variants.get(variantId);
      if (variant.buildStatus !== 'built' || variant.builtHash !== variant.skillsHash) {
        problems.push({
          code: 'variant-not-built',
          message: `Variant ${variant.name} has not been built from its current content. Build it on the variant page or choose another configuration.`,
        });
      }
    }
    if (item !== null && (controllers.has(item.id) || running(item.id))) {
      problems.push({
        code: 'running',
        message: `This session is running in Live item "${item.title}". Stop the process there, then resume.`,
      });
    }
    const remotePath = session.remotePath;
    if (remotePath === null)
      throw new Error(`Session ${session.id} on an SSH host has no recorded remote path`);
    const remote = `${host.label}:${remotePath}`;
    const latest = (await pathExists(session.filePath))
      ? { ...(await copyOf(session.filePath)), path: remote }
      : null;
    let action: ResumePlan['action'] = 'resume';
    let target: ResumePlan['target'] = null;
    if (session.engine === 'claude') {
      const relation = await remoteResumeAction(host, remotePath, configDir, session.id);
      if (relation.action === 'missing') {
        problems.push({
          code: 'file-missing',
          message: `${remote} no longer exists (moved or deleted); there is no record to continue from.`,
        });
      } else {
        action = relation.action;
        if (relation.action === 'sync' || relation.action === 'diverged') {
          target = {
            path: `${host.label}:${relation.target}`,
            bytes: relation.targetBytes ?? 0,
            lastAt: null,
            lastRole: null,
            lastText: null,
          };
        }
      }
    } else {
      const exists = await sshExec(host.target, `test -f ${quote([remotePath])}`);
      if (exists.exitCode !== 0) {
        problems.push({
          code: 'file-missing',
          message: `${remote} no longer exists (moved or deleted); there is no record to continue from.`,
        });
      }
    }
    const { agentModel, agentEffort } = settings.get();
    return {
      ...base,
      configDir,
      model: variantId === null ? null : agentModel,
      effort: variantId === null ? null : agentEffort,
      action: problems.length > 0 ? 'blocked' : action,
      latest,
      target,
      problems,
    };
  }

  // Resume a session on an SSH host (Contracts 31.3): on its host, in its recorded working directory; when the target
  // configuration has no copy or an older one, copy remotely first
  async function resumeRemote(
    body: ResumeLiveBody,
    session: typeof sessions.$inferSelect,
    hostId: string,
  ): Promise<LiveDetail> {
    const plan = await remoteResumePlan(session, hostId, body.variantId, itemOfSession(session.id));
    const problem = plan.problems[0];
    if (problem !== undefined) throw new HttpError(409, problem.message);
    if (plan.action === 'diverged' && body.onDiverged !== 'use-latest') {
      throw new HttpError(
        409,
        'The copy in the target configuration has diverged from the latest; choose "Continue from the latest" in the dialog',
      );
    }
    const host = deps.remote.hosts.known(hostId);
    const cwd = plan.cwd;
    const remotePath = session.remotePath;
    if (cwd === null || remotePath === null) {
      throw new Error(
        `Session ${session.id} passed the preflight without a working directory or remote path`,
      );
    }
    const item = itemOfSession(session.id);
    requireGoal(item, body);
    ingestFile(db, session.filePath);
    let target = remotePath;
    const start: Record<string, unknown> = { remotePath };
    if (session.engine === 'claude' && plan.action !== 'resume') {
      target = await applyRemoteResume(
        host,
        remotePath,
        plan.configDir,
        session.id,
        plan.action === 'diverged',
      );
      start.copiedTo = target;
    }
    const liveId = item?.id ?? newId('l');
    db.$client.transaction(() => {
      if (item === null) {
        insertItem({
          id: liveId,
          claudeSessionId: session.id,
          engine: session.engine,
          title: sessionListTitle(session.id),
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd,
          hostId,
        });
      }
      if (target !== remotePath) {
        db.update(sessions)
          .set({ filePath: localCopyOf(deps.remote.dir, hostId, target), remotePath: target })
          .where(eq(sessions.id, session.id))
          .run();
      }
      db.update(sessions).set({ liveId }).where(eq(sessions.id, session.id)).run();
    })();
    saveGoal(liveId, body.goal);
    return launchRemote({
      liveId,
      kind: 'resume',
      host,
      engine: session.engine,
      variantId: body.variantId,
      ...modelOf(body),
      cwd,
      claudeSessionId: session.id,
      remotePath: target,
      args:
        session.engine === 'claude'
          ? ['--resume', session.id]
          : codexRemoteResumeArgs(cwd, session.id),
      driver: body.driver,
      persona: resumePersona(session, item),
      start,
    });
  }
  // otherwise create an item for it. When the target configuration already has another copy, sync it per the preflight
  // or ask the user to choose
  async function resume(body: ResumeLiveBody): Promise<LiveDetail> {
    if (body.driver === 'simulated') await deps.requireChecks(['model-simulated-user']);
    const remoteSession = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (remoteSession?.hostId != null)
      return resumeRemote(body, remoteSession, remoteSession.hostId);
    // The preflight and the copy wait on the filesystem: a second resume of the same session meanwhile is refused
    if (resuming.has(body.sessionId)) {
      throw new HttpError(409, `Session ${body.sessionId} is already being resumed`);
    }
    resuming.add(body.sessionId);
    return resumeLocal(body).finally(() => {
      resuming.delete(body.sessionId);
    });
  }

  async function resumeLocal(body: ResumeLiveBody): Promise<LiveDetail> {
    const plan = await localResumePlan(body.sessionId, body.variantId);
    const problem = plan.problems[0];
    if (problem !== undefined) throw new HttpError(409, problem.message);
    if (plan.action === 'diverged' && body.onDiverged !== 'use-latest') {
      throw new HttpError(
        409,
        'The copy in the target configuration has diverged from the latest; choose "Continue from the latest" in the dialog',
      );
    }
    const session = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (session === undefined) throw new HttpError(404, `Session not found: ${body.sessionId}`);
    const cwd = plan.cwd;
    if (cwd === null)
      throw new Error(`Session ${session.id} passed the preflight without a working directory`);
    const item = itemOfSession(session.id);
    requireGoal(item, body);
    // A Magi Agent session starts with its recorded engine and worktree and the MAGI.md injection (Contracts 23.3),
    // handled by the Magi Agent module
    if (item?.purpose === 'agent') {
      if (agentResume === null)
        throw new Error('Magi Agent resume is not set (app.ts sets it after creating Magi Agent)');
      return agentResume(item.id);
    }
    if (session.engine === 'codex') {
      return resumeCodex(session, item, cwd, plan.configDir, body);
    }
    const liveId = item?.id ?? newId('l');
    // Read the latest copy to the end first, so the bytes after copying or syncing match the imported offset
    ingestFile(db, session.filePath);
    let target: string;
    // Recorded in this resume event: which copy was copied, overwritten or kept under a new name
    const start: Record<string, unknown> = { copiedFrom: null };
    if (plan.target === null) {
      target = path.join(plan.configDir, 'projects', liveId, `${session.id}.jsonl`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(session.filePath, target);
      await syncSessionDir(session.filePath, target);
      start.copiedFrom = session.filePath;
    } else {
      target = plan.target.path;
      if (plan.action === 'diverged') {
        const kept = divergedName(target, new Date());
        await fs.promises.rename(target, kept);
        start.divergedKept = kept;
      }
      if (plan.action === 'sync' || plan.action === 'diverged') {
        await fs.promises.copyFile(session.filePath, target);
        await syncSessionDir(session.filePath, target);
        start.syncedFrom = session.filePath;
        start.overwrote = target;
      }
    }
    // From now on the copy in the target configuration is imported; the original file is untouched
    db.$client.transaction(() => {
      if (item === null) {
        insertItem({
          id: liveId,
          claudeSessionId: session.id,
          title: sessionListTitle(session.id),
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd,
        });
      }
      // Resuming the session of a closed item from Sessions details shows the item again (Contracts 14.5)
      if (item !== null) setHidden(item.id, false, { reason: 'resume' });
      if (target !== session.filePath) {
        const oldDir = path.join(path.dirname(session.filePath), session.id);
        const newDir = path.join(path.dirname(target), session.id);
        db.update(sessions).set({ filePath: target }).where(eq(sessions.id, session.id)).run();
        for (const sub of db
          .select()
          .from(subagents)
          .where(eq(subagents.sessionId, session.id))
          .all()) {
          db.update(subagents)
            .set({ filePath: path.join(newDir, path.relative(oldDir, sub.filePath)) })
            .where(eq(subagents.filePath, sub.filePath))
            .run();
        }
      }
      db.update(sessions).set({ liveId }).where(eq(sessions.id, session.id)).run();
    })();
    saveGoal(liveId, body.goal);
    return launch({
      liveId,
      kind: 'resume',
      variantId: body.variantId,
      ...modelOf(body),
      environment: 'real',
      cwd,
      claudeSessionId: session.id,
      sessionArgs: ['--resume', session.id],
      projectDirName: path.basename(path.dirname(target)),
      driver: body.driver,
      persona: resumePersona(session, item),
      eval: null,
      extraEnv: {},
      start,
      owned: null,
    });
  }

  // Contracts 14.5 "Import to Live": create an item per session (real environment, cwd as the session recorded it)
  // without starting a process; closed items are shown again. Everything is checked first: missing sessions are a 404,
  // ones with a shown item a 409 listing them, and nothing changes
  function importSessions(sessionIds: string[]): LiveSummary[] {
    const ids = [...new Set(sessionIds)];
    const rows = ids.map((id) => ({
      id,
      session: db.select().from(sessions).where(eq(sessions.id, id)).get(),
      item: itemOfSession(id),
    }));
    const missing = rows.filter((r) => r.session === undefined).map((r) => r.id);
    if (missing.length > 0) throw new HttpError(404, `Session not found: ${missing.join(', ')}`);
    // Closed items do not count as in Live: importing shows them again
    const taken = rows.flatMap(({ id, item }) =>
      item?.hiddenAt === null ? [`${id} (${item.id})`] : [],
    );
    if (taken.length > 0)
      throw new HttpError(409, `These sessions are already in Live: ${taken.join(', ')}`);
    const noCwd = rows.filter((r) => r.item === null && r.session?.cwd == null).map((r) => r.id);
    if (noCwd.length > 0)
      throw new HttpError(
        400,
        `These sessions have no recorded working directory: ${noCwd.join(', ')}`,
      );
    const liveIds = db.$client.transaction(() =>
      rows.map(({ id, session, item }) => {
        if (item !== null) {
          setHidden(item.id, false, { reason: 'import' });
          return item.id;
        }
        if (session?.cwd == null)
          throw new Error(`Session ${id} has no recorded working directory`);
        const liveId = newId('l');
        const title = sessionListTitle(id);
        insertItem({
          id: liveId,
          claudeSessionId: id,
          engine: session.engine,
          title,
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd: session.cwd,
          hostId: session.hostId,
        });
        db.insert(liveEvents)
          .values({
            liveId,
            processId: null,
            at: new Date(),
            kind: 'import',
            payload: { sessionId: id, filePath: session.filePath, title },
          })
          .run();
        db.update(sessions).set({ liveId }).where(eq(sessions.id, id)).run();
        return liveId;
      }),
    )();
    for (const [i, liveId] of liveIds.entries()) {
      events.publish({ type: 'live.updated', liveId });
      const sessionId = ids[i];
      if (sessionId !== undefined) events.publish({ type: 'session.updated', sessionId });
    }
    return liveIds.map((liveId) => summary(row(liveId)));
  }

  // Close ("×") and show again: only hidden_at changes and one event is recorded; nothing when already in that state
  function setHidden(id: string, hidden: boolean, payload: Record<string, unknown>) {
    const item = row(id);
    if ((item.hiddenAt !== null) === hidden) return;
    const at = new Date();
    db.update(liveSessions)
      .set({ hiddenAt: hidden ? at : null })
      .where(eq(liveSessions.id, id))
      .run();
    db.insert(liveEvents)
      .values({ liveId: id, processId: null, at, kind: hidden ? 'hide' : 'unhide', payload })
      .run();
  }

  // An item with a running process cannot be closed or deleted; stop the process first (Contracts 14.5)
  function requireStopped(id: string, action: string) {
    if (controllers.has(id) || running(id)) {
      throw new HttpError(409, `Live item ${id} has a running process; stop it before ${action}`);
    }
  }

  function hide(id: string): LiveDetail {
    requireStopped(id, 'closing');
    setHidden(id, true, { reason: 'user' });
    events.publish({ type: 'live.updated', liveId: id });
    return detail(id);
  }

  function unhide(id: string): LiveDetail {
    setHidden(id, false, { reason: 'user' });
    events.publish({ type: 'live.updated', liveId: id });
    return detail(id);
  }

  // Delete an item (Contracts 14.5): the Live item, its processes and event records, data/live/<liveId>/. The session
  // itself stays (jsonl and copies, its Sessions record, sessions.live_id set to null); GitHub repos and Linear
  // tickets are left to the user
  function remove(id: string, confirmTitle: string) {
    const item = row(id);
    requireStopped(id, 'deleting');
    if (confirmTitle !== item.title) {
      throw new HttpError(
        400,
        `The name entered does not match this item's name: ${JSON.stringify(confirmTitle)}`,
      );
    }
    removeItem(id);
  }

  // Delete an item and its directory (no running process); sessions are only unlinked. Items deleted together with
  // their sessions when a variant or workflow is deleted go through here too (Contracts 24.2, 24.5)
  function removeItem(id: string) {
    const item = row(id);
    requireStopped(id, 'deleting');
    const counts = db.$client.transaction(() => {
      const unlinked = db
        .update(sessions)
        .set({ liveId: null })
        .where(eq(sessions.liveId, id))
        .returning({ id: sessions.id })
        .all();
      const removedEvents = db.delete(liveEvents).where(eq(liveEvents.liveId, id)).run().changes;
      const removedProcesses = db
        .delete(liveProcesses)
        .where(eq(liveProcesses.liveId, id))
        .run().changes;
      // A Codex session's draft is kept (Contracts 17.3)
      db.update(workflowDrafts).set({ liveId: null }).where(eq(workflowDrafts.liveId, id)).run();
      // A Magi Agent session: the deploy records it started are deleted with it
      db.delete(magiDeploys).where(eq(magiDeploys.liveId, id)).run();
      db.delete(liveSessions).where(eq(liveSessions.id, id)).run();
      return { unlinked: unlinked.map((s) => s.id), removedEvents, removedProcesses };
    })();
    const dir = liveDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    console.info(
      `[live] deleted Live item ${id} (${item.title}): ${String(counts.removedProcesses)} processes, ${String(counts.removedEvents)} events, ${dir}; sessions ${counts.unlinked.join(', ')} kept`,
    );
    events.publish({ type: 'live.updated', liveId: id });
    for (const sessionId of counts.unlinked) events.publish({ type: 'session.updated', sessionId });
  }

  // Contracts 14.3: a rename shows at once in the tab, the Sessions list and details
  function rename(id: string, title: string): LiveDetail {
    const item = row(id);
    const next = checkTitle(title);
    if (next !== item.title) {
      const at = new Date();
      db.$client.transaction(() => {
        db.update(liveSessions)
          .set({ title: next, updatedAt: at })
          .where(eq(liveSessions.id, id))
          .run();
        db.insert(liveEvents)
          .values({
            liveId: id,
            processId: null,
            at,
            kind: 'rename',
            payload: { from: item.title, to: next },
          })
          .run();
      })();
      events.publish({ type: 'live.updated', liveId: id });
      if (item.claudeSessionId !== null) {
        events.publish({ type: 'session.updated', sessionId: item.claudeSessionId });
      }
    }
    return detail(id);
  }

  return {
    setAgentResume(fn: (liveId: string) => Promise<LiveDetail>) {
      agentResume = fn;
    },
    // Items with a running process first, the rest by updated_at descending (Contracts 14.3); closed items only with
    // includeHidden
    list(includeHidden = false): LiveSummary[] {
      return db
        .select()
        .from(liveSessions)
        .where(includeHidden ? undefined : isNull(liveSessions.hiddenAt))
        .orderBy(
          sql`case when exists (select 1 from ${liveProcesses} where ${liveProcesses.liveId} = ${liveSessions.id} and ${liveProcesses.status} = 'running') then 0 else 1 end`,
          desc(liveSessions.updatedAt),
        )
        .all()
        .map(summary);
    },
    get: detail,
    create,
    localEntries,
    // Design and analysis-optimize sessions (Contracts 17.1, 19.3, 22): the drafts module creates the item when
    // started and starts it once prepared, with Codex or Claude Code
    createDraftItem,
    startDraft: (id: string) => launchDraft(id, 'start'),
    resumeDraft: (id: string) => launchDraft(id, 'resume'),
    // Magi Agent (Contracts section 23)
    createAgentItem,
    launchAgent,
    running,
    resume,
    resumeDefaults,
    resumePlan,
    rename,
    importSessions,
    hide,
    unhide,
    remove,
    removeItem,
    dirOf: liveDir,
    // The two directories of "Open in Finder" (Contracts 14.2): the working directory and the configuration directory
    // of the latest process (<HOME>/.claude for the local configuration; CODEX_HOME or claude-config/ in the working
    // directory for design and analysis-optimize sessions; the rollout's CODEX_HOME for Codex sessions resumed from
    // the Sessions page; this machine's ~/.codex for Magi Agent)
    dirs(id: string): { cwd: string; configDir: string } {
      const r = row(id);
      // An item on an SSH host: the page copies ssh <target> and the working path; nothing opens in Finder
      // (Contracts 31.3)
      if (r.hostId !== null) {
        throw new HttpError(
          400,
          `Live item ${id} runs on an SSH host; its working directory is remote`,
        );
      }
      if (r.engine === 'codex') {
        if (isDraftItem(r)) return { cwd: r.cwd, configDir: codexDirsOf(r.cwd).codexHome };
        const s =
          r.claudeSessionId === null
            ? undefined
            : db
                .select({ filePath: sessions.filePath })
                .from(sessions)
                .where(eq(sessions.id, r.claudeSessionId))
                .get();
        return {
          cwd: r.cwd,
          configDir:
            s === undefined ? path.join(deps.localHome, '.codex') : codexHomeOf(s.filePath),
        };
      }
      if (isDraftItem(r)) return { cwd: r.cwd, configDir: claudeSessionDirsOf(r.cwd).claudeDir };
      const variantId = latestProcess(id)?.variantId ?? null;
      return {
        cwd: r.cwd,
        configDir:
          variantId === null
            ? path.join(deps.localHome, '.claude')
            : variants.layout(variantId).claudeDir,
      };
    },
    hook(id: string, payload: HookPayload) {
      claudeControllerOf(id).hook(payload);
      if (payload.hook_event_name === 'UserPromptSubmit' && row(id).purpose === 'agent') {
        nameAgentItem(id, z.string().parse(payload.prompt));
      }
    },
    // The driver switch (Contracts 34.2): available for every purpose, both engines, local and SSH items; an item with
    // no task needs a goal first
    async setDriver(id: string, driver: LiveDriver, goal?: string) {
      const item = row(id);
      if (driver === 'simulated' && item.taskId === null) {
        if (goal !== undefined) setGoal(id, goal);
        else if (item.simulatedGoal === null) {
          throw new HttpError(409, 'Write down the goal before handing over to the simulated user');
        }
      }
      const controller = controllerOf(id);
      if (controller.driver === driver) throw new HttpError(409, `The driver is already ${driver}`);
      if (driver === 'simulated') {
        await deps.requireChecks(['model-simulated-user']);
        controller.release();
      } else controller.setDriver('human', 'manual' satisfies HandBackReason);
      return detail(id);
    },
    // View and change the goal from the toolbar (Contracts 34.2)
    setGoal,
    // "Stop process" records a stop first (from the page button or the API), then stops
    async stop(id: string, source: LiveStopSource) {
      const item = row(id);
      const latest = latestProcess(id);
      if (latest?.status !== 'running') {
        throw new HttpError(409, `Live item ${id} is not running`);
      }
      const controller = controllers.get(id);
      // An agent in an Orca pane that no controller holds (W116, W117): there is no terminal to interrupt, so stop
      // acts on the recorded pid, on this machine or on the item's SSH host
      const host = item.hostId === null ? null : deps.remote.hosts.known(item.hostId);
      const worker = controller === undefined ? structuredWorkerOf(item, latest.id) : null;
      const pane =
        controller === undefined && worker === null
          ? await vanishedPaneOf(id, latest.id, host)
          : null;
      if (controller === undefined && pane === null && worker === null) {
        throw new HttpError(409, `Live item ${id} is not running`);
      }
      db.insert(liveEvents)
        .values({
          liveId: id,
          processId: latest.id,
          at: new Date(),
          kind: 'stop',
          payload: { source },
        })
        .run();
      events.publish({ type: 'live.updated', liveId: id });
      // A worker Orca runs without a pane: Orca ends it, and the sync sees the Dispatch settle and ends the process
      if (worker !== null) {
        await orcaSync.whileStopping(async () => {
          await orcaCall(worker.place, [
            'orchestration',
            'worker-stop',
            '--dispatch',
            worker.dispatchId,
          ]);
          await orcaSync.pollOnce();
        });
        return detail(id);
      }
      if (pane !== null) {
        await stopVanishedPane(pane, host);
        return detail(id);
      }
      if (controller === undefined) throw new Error(`Live item ${id} has no controller`);
      // An Orca-managed item: the agent's exit is found by the topology sync, so sync while stopping whether or not a
      // page is open
      if (item.purpose === 'orca') await orcaSync.whileStopping(() => terminate(controller));
      else await terminate(controller);
      return detail(id);
    },
    connect,
    // Once the service listens, reconnect running processes on SSH hosts (Contracts 31.4, app.ts onListen)
    reattachRemote,
    // Once the service listens, start syncing Orca's collaboration topology (Contracts 35.3)
    startOrca() {
      orcaSync.start();
    },
    orcaTopology: () => orcaSync.topology(),
    // The Orca topology page (Contracts 40): the graph of the latest sync
    orcaGraph(): OrcaGraph {
      const { nodes, edges } = orcaGraphOf();
      return { local: orcaSync.topology().local, nodes, edges };
    },
    orcaOpenLive,
    orcaNodeDir,
    // The messages between any node in a and any node in b, oldest first (clicking an edge, Contracts 40.2)
    orcaMessages(a: string[], b: string[]): OrcaGraphMessage[] {
      const left = new Set(a);
      const right = new Set(b);
      return orcaGraphOf().messages.filter(
        (m) => (left.has(m.from) && right.has(m.to)) || (left.has(m.to) && right.has(m.from)),
      );
    },
    // "Open in Orca" (Contracts 40.2): the desktop Orca on this machine comes to the front on that terminal's worktree and
    // tab. A terminal on an SSH host belongs to the Orca environment paired with that host
    async orcaSwitch(handle: string, hostId: string | null): Promise<void> {
      if (!isPaneHandle(handle)) {
        throw new HttpError(
          409,
          `${handle} is not an Orca terminal (a worker without a pane has none)`,
        );
      }
      const environment = hostId === null ? null : await orcaEnvironmentOf(hostId);
      await showOrcaTerminal(localOrca, handle, environment);
    },
    // One page of a structured worker's transcript (Contracts 35.4): the page polls with the cursor it last got, so
    // each read returns only what the worker wrote since. Orca keeps the transcript readable after the worker ends
    async workerTranscript(id: string, cursor: string | null): Promise<WorkerTranscript> {
      const item = row(id);
      const latest = latestProcess(id);
      if (latest === null) throw new HttpError(409, `Live item ${id} has not run`);
      const worker = structuredWorkerOf(item, latest.id);
      if (worker === null) {
        throw new HttpError(409, `Live item ${id} is not a worker Orca runs without a pane`);
      }
      return workerRead(worker.place, worker.version, worker.dispatchId, cursor);
    },
    // Input typed in such an item: it reaches the worker as a message to its Dispatch
    async sendToWorker(id: string, text: string): Promise<WorkerSendResult> {
      const item = row(id);
      const latest = latestProcess(id);
      if (latest?.status !== 'running') throw new HttpError(409, `Live item ${id} is not running`);
      const worker = structuredWorkerOf(item, latest.id);
      if (worker === null) {
        throw new HttpError(409, `Live item ${id} is not a worker Orca runs without a pane`);
      }
      const sent = await workerSend(
        worker.place,
        worker.dispatchId,
        'Message from the dashboard',
        text,
      );
      db.insert(liveEvents)
        .values({
          liveId: id,
          processId: latest.id,
          at: new Date(),
          kind: 'orca-worker-input',
          payload: { orca: { dispatchId: worker.dispatchId, delivery: sent.delivery }, text },
        })
        .run();
      events.publish({ type: 'live.updated', liveId: id });
      return { delivery: sent.delivery };
    },
    // Sync once now (tests, and when the topology drawer opens)
    syncOrca: () => orcaSync.pollOnce(),
    // GET /api/diagnostics (Contracts section 5): page connections, whether auto-stop is timing, controllers still
    // kept per item
    diagnostics() {
      return {
        connections,
        autoStopPending: idleTimer !== null,
        controllers: [...controllers.values()].map((c) => ({
          liveId: c.liveId,
          engine: c.engine,
          pid: c.pty.pid,
          alive: c.pty.alive,
          retainedBytes: c.pty.retainedBytesCount,
          screenReleased: c.pty.screenReleased,
          watching: c.watching,
        })),
        ptys: unreleasedPtys(),
      };
    },
    // For WebSocket connections: the running controller, empty once exited (only pty.log is replayed)
    controller(id: string): LiveController | CodexRunner | null {
      row(id);
      return controllers.get(id) ?? null;
    },
    logFile(id: string): string {
      return path.join(liveDir(row(id).id), 'pty.log');
    },
    // Service shutdown: stop local PTY processes; remote processes keep running in tmux (Contracts 31.4) and no error
    // is recorded
    async shutdown() {
      cancelAutoStop();
      orcaSync.stop();
      for (const controller of controllers.values()) {
        if (controller.pty.remote) continue;
        db.update(liveProcesses)
          .set({ error: 'Service shut down; process stopped' })
          .where(eq(liveProcesses.id, controller.processId))
          .run();
      }
      await Promise.all([...controllers.values()].map((c) => c.shutdown()));
      // A local process's identity terminal closes after the process ends
      await Promise.all([...closingIdentities]);
    },
  };
}

export type Live = ReturnType<typeof createLive>;
