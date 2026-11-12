import os from 'node:os';
import { fastifySSE } from '@fastify/sse';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { config, install } from '../config.js';
import type { Db } from '../db/index.js';
import { sshHosts } from '../db/schema.js';
import { events } from '../events.js';
import { closeLinearClient } from '../external/linear.js';
import { githubRepos } from '../external/run-repos.js';
import { defaultSourceDirs } from '../ingest/sources.js';
import { watcherCount } from '../ingest/watch.js';
import { createLive } from '../live/index.js';
import { createRuns } from '../runs/index.js';
import { createSettingsStore } from '../runs/settings.js';
import { createVariants } from '../variants/index.js';
import { createReleaseCheck } from '../variants/release.js';
import { runRoutes } from './runs.js';
import { sessionsRoutes } from './sessions.js';
import { settingsRoutes } from './settings.js';
import { registerStageRoutes } from './stages.js';
import { taskRoutes } from './tasks.js';
import { linearImportRoutes } from './linear-import.js';
import { variantRoutes } from './variants.js';
import { compareRoutes } from './compare.js';
import { gradeRoutes } from './grades.js';
import { createEnvironment } from '../environment.js';
import { models } from '../llm/client.js';
import { environmentRoutes } from './environment.js';
import { liveRoutes } from './live.js';
import { backfillCodexInjections } from '../ingest/codex.js';
import { backfillSkillLoads } from '../ingest/ingest.js';
import { bindRunSessions, rebindAll } from '../bindings/index.js';
import { createInsights } from '../insights/index.js';
import { ensureBuiltinBaselines } from '../workflows/baselines.js';
import { bindingRoutes } from './bindings.js';
import { analysisRoutes } from './analyses.js';
import { createWorkflows } from '../workflows/index.js';
import { workflowRoutes } from './workflows.js';
import { openRoutes } from './open.js';
import { backfillDraftVariants, createDrafts } from '../drafts/index.js';
import { createSessionSync } from '../drafts/session-config.js';
import { draftRoutes } from './drafts.js';
import { createWorkspace } from '../drafts/workspace.js';
import { workspaceRoutes } from './workspace.js';
import { createDeletion } from '../deletion/index.js';
import { deletionRoutes } from './deletion.js';
import { createSessionActions } from '../deletion/sessions.js';
import { sessionActionRoutes } from './session-actions.js';
import { createMagiAgent } from '../magi-agent/index.js';
import { magiAgentRoutes } from './magi-agent.js';
import { createHosts } from '../remote/hosts.js';
import { sshHostRoutes } from './ssh-hosts.js';
import { createVscode } from '../vscode/index.js';
import { vscodeRoutes } from './vscode.js';
import { createLocalDirs } from '../dirs/local.js';
import { localDirRoutes } from './local-dirs.js';
import { createTeamSync } from '../team/sync.js';
import { teamRoutes } from './team.js';
import { createUpdater } from '../install/index.js';
import { installRoutes } from './install.js';

export interface AppOptions {
  db: Db;
  sseHeartbeatMs: number;
  logger: boolean;
  tasksDir: string;
  // pnpm start: the built page directory (web/dist), served by the same process
  webDir?: string | undefined;
  // The last step of a Magi Agent deploy (Contracts 23.5): under pnpm start the service exits with code 75
  onRestart?: (() => void) | undefined;
  // Check for the latest txe-workflow release and import it automatically (Contracts 29.1): only main.ts turns it on
  releaseCheck?: boolean | undefined;
  // Sync the Linear stats at startup and every 30 minutes (Contracts 37.2): only main.ts turns it on
  scheduledTeamSync?: boolean | undefined;
  // From an installed release package, update from the latest Release at startup and every 6 hours (Contracts 39.4):
  // only main.ts turns it on
  selfUpdate?: boolean | undefined;
}

export async function buildApp({
  db,
  sseHeartbeatMs,
  logger,
  tasksDir,
  webDir,
  onRestart,
  releaseCheck,
  scheduledTeamSync,
  selfUpdate,
}: AppOptions) {
  // Destroy every connection on shutdown: an open page's /api/events is a response that never ends, server.close()
  // would wait for it forever, and neither the service nor the Live processes would exit (measured in W58). Terminal
  // WebSockets are closed by @fastify/websocket's preClose
  const app = Fastify({ logger, forceCloseConnections: true });
  await app.register(fastifySSE, { heartbeatInterval: sseHeartbeatMs });

  app.get('/api/health', () => {
    db.$client.prepare('select 1').get();
    return { status: 'ok' };
  });

  await app.register(sessionsRoutes, { prefix: '/api', db, dirs: defaultSourceDirs });
  registerStageRoutes(app, db);
  await app.register(taskRoutes({ db, tasksDir }));

  const variants = createVariants({
    db,
    dataDir: config.dataDir,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    onSkillsChanged: () => {
      rebindAll(db, config.dataDir);
    },
  });
  await app.register(variantRoutes, { variants });

  await app.register(gradeRoutes({ db }));
  await app.register(compareRoutes({ db, variants }));

  const settings = createSettingsStore(db);
  const repos = githubRepos;
  const runs = createRuns({
    db,
    variants,
    settings,
    vaultDir: config.vaultDir,
    product: config.evalProduct,
    runsDir: config.runsDir,
    repos,
  });
  await app.register(runRoutes, { runs, settings });
  await app.register(settingsRoutes, { settings });
  // Stop runs first (they may still be calling Linear), then close the mcp-remote child processes
  app.addHook('onClose', async () => {
    await runs.shutdown();
    await closeLinearClient();
  });

  const environment = createEnvironment({
    models: () => models,
    vaultDir: config.vaultDir,
    vaultSource: config.vaultSource,
    product: config.evalProduct,
    txeWorkflowRepo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    codexAuthPath: config.codexAuthPath,
    codexConfigPath: config.codexConfigPath,
    workDir: config.environmentDir,
    // With a Linux SSH host, check the tools for cross-compiling wf (Contracts 31.5)
    remoteLinux: () =>
      db
        .select({ check: sshHosts.check })
        .from(sshHosts)
        .all()
        .some((h) => h.check?.platform?.startsWith('Linux ') === true),
  });
  await app.register(environmentRoutes, { environment });
  await app.register(linearImportRoutes({ settings }));

  // Analysis, design and optimize are driven by the built-in session-analysis, workflow-design and workflow-optimize
  // (Contracts 19.2, 33.1): their baseline variants are created and built at startup; earlier design and optimize
  // sessions are recorded as using the matching baseline (33.3)
  const baselines = await ensureBuiltinBaselines(db, variants, config.dataDir);
  backfillDraftVariants(db, baselines);
  // Sessions bound to variants and skill analysis (Contracts section 15): sessions imported before this feature get
  // their skill bodies and run bindings extracted
  backfillSkillLoads(db);
  bindRunSessions(db);
  rebindAll(db, config.dataDir);
  // Codex sessions imported before <skill> injections were read get their injections and stages (Contracts 16.6)
  backfillCodexInjections(db);
  await app.register(bindingRoutes, { db, variants, dataDir: config.dataDir });
  const insights = createInsights({ db, variants, dataDir: config.dataDir });
  await app.register(analysisRoutes, { insights });
  app.addHook('onClose', async () => {
    await insights.shutdown();
  });

  // Live (Contracts 14): hook commands POST to the address the service actually listens on
  await app.register(fastifyWebsocket);
  // SSH hosts (Contracts 31.1)
  const hosts = createHosts({ db, sshHostsFile: config.sshHostsFile });
  await app.register(sshHostRoutes, { hosts });
  const live = createLive({
    db,
    variants,
    settings,
    vaultDir: config.vaultDir,
    product: config.evalProduct,
    liveDir: config.liveDir,
    dataDir: config.dataDir,
    serverUrl: () => {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`The HTTP server is not listening on a TCP port: ${String(address)}`);
      }
      return `http://${config.host}:${String(address.port)}`;
    },
    localHome: os.homedir(),
    repos,
    codex: {
      bin: config.codexBin,
      sources: { authPath: config.codexAuthPath, configPath: config.codexConfigPath },
      sessionTimeoutMs: 60_000,
    },
    claudeBin: config.claudeBin,
    autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
    remote: { hosts, dir: config.remoteDir, reconnectMs: config.sshReconnectMs },
    orca: config.orca,
  });
  await app.register(liveRoutes, { live });
  // After a dashboard restart, reconnect running processes on SSH hosts (Contracts 31.4), then start syncing Orca's
  // collaboration topology (Contracts 35.3)
  app.addHook('onListen', () => {
    live.reattachRemote();
    live.startOrca();
  });

  // Live event push: send ready on connect, then forward every event on the event bus. Each connection is an open page
  // (auto-stop, Contracts 14.3)
  app.get('/api/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();
    const unsubscribe = events.subscribe((event) => {
      void reply.sse.send({ event: event.type, data: event });
    });
    const release = live.connect();
    reply.sse.onClose(() => {
      unsubscribe();
      release();
    });
    await reply.sse.send({ event: 'ready', data: {} });
  });
  app.addHook('onClose', async () => {
    await live.shutdown();
    await hosts.shutdown();
  });

  // Magi Agent (Contracts section 23): "resume after deploy" is handled once the service listens
  const restart =
    onRestart ??
    (() => {
      throw new Error(
        'This service has no way to restart after a deploy or update (main.ts of pnpm start sets it)',
      );
    });
  const magi = createMagiAgent({
    db,
    live,
    variants,
    repoDir: config.magiRepo,
    worktree: config.magiWorktree,
    check: config.magiCheck,
    dataDir: config.dataDir,
    install,
    restart,
  });
  await app.register(magiAgentRoutes, { magi });
  // Resuming a Magi Agent session from the Sessions page: started with its recorded engine and worktree, with the
  // injection
  live.setAgentResume((liveId) => magi.resume(liveId));
  app.addHook('onListen', () => {
    magi.resumeAfterDeploy();
  });

  // The installed version and its self-update (Contracts 39.4); a git checkout has neither
  const updater = install === null ? null : createUpdater({ db, install, restart });
  await app.register(installRoutes, {
    view: () => (updater === null ? { installed: false as const } : updater.view(config.dataDir)),
  });
  if (updater !== null && selfUpdate === true) {
    app.addHook('onListen', () => {
      updater.start();
    });
    app.addHook('onClose', () => {
      updater.stop();
      return Promise.resolve();
    });
  }

  // Configurable workflows (Contracts 16.1)
  await app.register(workflowRoutes, { workflows: createWorkflows({ db, variants }) });
  // lfg and ic come with a variant of the latest txe-workflow release (Contracts 29.1): checked in the background once
  // the service listens, without blocking startup
  if (releaseCheck === true) {
    const releases = createReleaseCheck({ db, variants, repo: config.txeWorkflowRepo });
    app.addHook('onListen', () => {
      releases.start();
    });
    app.addHook('onClose', () => {
      releases.stop();
      return Promise.resolve();
    });
  }
  // "Open in Finder" (Contracts 16.7)
  await app.register(openRoutes, { db, variants, live });
  // Generate a workflow or variant with Codex (Contracts section 17)
  const drafts = createDrafts({
    db,
    variants,
    live,
    draftsDir: config.workflowDraftsDir,
    dataDir: config.dataDir,
  });
  await app.register(draftRoutes, { drafts });
  // The workflow panel of design and optimize sessions (Contracts section 26)
  const workspace = createWorkspace({ db, drafts });
  await app.register(workspaceRoutes, { workspace });
  // src/skills in design and optimize sessions are installed as they are written (Contracts 28.2)
  const sessionSync = createSessionSync({ db });
  app.addHook('onClose', () => {
    workspace.shutdown();
    sessionSync.shutdown();
    return Promise.resolve();
  });
  // Deleting variants and workflows (Contracts section 24)
  await app.register(deletionRoutes, {
    deletion: createDeletion({
      db,
      variants,
      live,
      draftsDir: config.workflowDraftsDir,
      dataDir: config.dataDir,
    }),
  });
  // Deleting and archiving on the Sessions page (Contracts 25.3)
  await app.register(sessionActionRoutes, {
    actions: createSessionActions({ db, live, codexBin: config.codexBin }),
  });
  // Diagnostics (Contracts section 5, W58): read-only; measurements and tests use it to confirm resources are released
  app.get('/api/diagnostics', () => {
    const activeResources: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) {
      activeResources[kind] = (activeResources[kind] ?? 0) + 1;
    }
    return {
      memory: process.memoryUsage(),
      activeResources,
      events: { subscribers: events.subscribers() },
      live: live.diagnostics(),
      ingest: { watchers: watcherCount() },
      workspace: workspace.diagnostics(),
    };
  });

  // Open a Live item's working directory in VS Code for the Web (Contracts section 32): the server stops when the
  // dashboard exits
  const vscode = createVscode({
    dir: config.vscodeDir,
    serversDir: config.vscodeServersDir,
    itemOf: (liveId) => {
      const item = live.get(liveId);
      return { cwd: item.cwd, hostId: item.host?.id ?? null };
    },
    hosts,
    stopGraceMs: 10_000,
  });
  await app.register(vscodeRoutes, { vscode });
  // Once the service listens, list the VS Code servers still running on SSH hosts in the background (Contracts 32.3),
  // without blocking startup
  app.addHook('onListen', () => {
    void vscode.restoreRemote();
  });
  app.addHook('onClose', async () => {
    await vscode.shutdown();
  });
  // Working directories of the local real environment: browse and create folders (Contracts 34.1), starting at home
  await app.register(localDirRoutes, {
    dirs: createLocalDirs({ home: os.homedir() }),
  });
  // Linear stats (Contracts section 37): Sync now always works; the sync at startup and every 30 minutes only when
  // main.ts turns it on
  const teamSync = createTeamSync({ db, team: config.teamStatsTeam });
  await app.register(teamRoutes, { db, team: config.teamStatsTeam, sync: teamSync, settings });
  if (scheduledTeamSync === true) {
    app.addHook('onListen', () => {
      teamSync.schedule(config.teamSyncIntervalMs);
    });
  }
  app.addHook('onClose', async () => {
    await teamSync.shutdown();
  });

  // Page routes live in the browser: every path not matching /api returns index.html
  if (webDir !== undefined) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.code(404).send({ message: `${request.method} ${request.url} not found` });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
