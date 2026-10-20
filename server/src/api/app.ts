import os from 'node:os';
import { fastifySSE } from '@fastify/sse';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { events } from '../events.js';
import { closeLinearClient } from '../external/linear.js';
import { runReposFor } from '../external/run-repos.js';
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
import { backfillSkillLoads } from '../ingest/ingest.js';
import { bindRunSessions, rebindAll } from '../bindings/index.js';
import { createInsights } from '../insights/index.js';
import { ensureAnalysisBaseline } from '../insights/baseline.js';
import { bindingRoutes } from './bindings.js';
import { analysisRoutes } from './analyses.js';
import { createWorkflows } from '../workflows/index.js';
import { workflowRoutes } from './workflows.js';
import { openRoutes } from './open.js';
import { createDrafts } from '../drafts/index.js';
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

export interface AppOptions {
  db: Db;
  sseHeartbeatMs: number;
  logger: boolean;
  tasksDir: string;
  // pnpm start：构建好的页面目录（web/dist），由同一个进程提供
  webDir?: string | undefined;
  // 交互"本机配置"的 HOME，默认真实 HOME；测试用 .work/ 下的目录
  localHome?: string | undefined;
  // Magi Agent 部署的最后一步（Contracts 23.5）：pnpm start 中服务以退出码 75 结束；部署的测试传自己的函数
  onRestart?: (() => void) | undefined;
  // 检查 txe-workflow 的最新版并自动导入（Contracts 29.1）：只有 main.ts 按 config.releaseCheck 打开
  releaseCheck?: boolean | undefined;
}

export async function buildApp({
  db,
  sseHeartbeatMs,
  logger,
  tasksDir,
  webDir,
  localHome,
  onRestart,
  releaseCheck,
}: AppOptions) {
  // 关闭服务时销毁全部连接：打开着的页面的 /api/events 是一直不结束的响应，server.close() 会一直等它，
  // 服务不退出、交互进程也不结束（W58 实测）。终端的 WebSocket 由 @fastify/websocket 的 preClose 关闭
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
  const repos = runReposFor(config.localReposDir);
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
  // 先结束 run（它们可能还在调用 Linear），再关闭 mcp-remote 子进程
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
  });
  await app.register(environmentRoutes, { environment });
  await app.register(linearImportRoutes({ settings }));

  // session 绑定 variant 与 skill 分析（Contracts 第 15 节）：本功能之前导入的 session 补提取 skill 正文与 run 的绑定
  backfillSkillLoads(db);
  bindRunSessions(db);
  rebindAll(db, config.dataDir);
  await app.register(bindingRoutes, { db, variants, dataDir: config.dataDir });
  // 分析由内置的 session-analysis 驱动（Contracts 19.2）：启动时建出并构建它的基线 variant
  await ensureAnalysisBaseline(db, variants);
  const insights = createInsights({ db, variants, dataDir: config.dataDir });
  await app.register(analysisRoutes, { insights });
  app.addHook('onClose', async () => {
    await insights.shutdown();
  });

  // 交互（Contracts 14）：hook 命令 POST 到服务实际监听的地址
  await app.register(fastifyWebsocket);
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
        throw new Error(`HTTP 服务没有监听 TCP 端口：${String(address)}`);
      }
      return `http://${config.host}:${String(address.port)}`;
    },
    localHome: localHome ?? os.homedir(),
    repos,
    codex: {
      bin: config.codexBin,
      sources: { authPath: config.codexAuthPath, configPath: config.codexConfigPath },
      sessionTimeoutMs: 60_000,
    },
    claudeBin: config.claudeBin,
    autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
  });
  await app.register(liveRoutes, { live });

  // 实时事件推送：连接时先发 ready，之后转发事件总线上的全部事件。每个连接是一个打开着的页面（自动结束，Contracts 14.3）
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
  });

  // Magi Agent（Contracts 第 23 节）：服务监听端口之后处理"部署后 resume"
  const magi = createMagiAgent({
    db,
    live,
    variants,
    repoDir: config.magiRepo,
    worktree: config.magiWorktree,
    check: config.magiCheck,
    dataDir: config.dataDir,
    restart:
      onRestart ??
      (() => {
        throw new Error('这个服务没有设置部署后重新启动的方法（pnpm start 的 main.ts 设置）');
      }),
  });
  await app.register(magiAgentRoutes, { magi });
  // Sessions 页面 resume Magi Agent 的会话：按它记下的引擎与 worktree 启动，带注入
  live.setAgentResume((liveId) => magi.resume(liveId));
  app.addHook('onListen', () => {
    magi.resumeAfterDeploy();
  });

  // 可配置的 workflow（Contracts 16.1）
  await app.register(workflowRoutes, { workflows: createWorkflows({ db, variants }) });
  // lfg、ic 默认带 txe-workflow 最新版的 variant（Contracts 29.1）：服务监听后在后台检查，不阻塞启动
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
  // "在访达中打开"（Contracts 16.7）
  await app.register(openRoutes, { db, variants, live });
  // 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
  const drafts = createDrafts({
    db,
    variants,
    live,
    draftsDir: config.workflowDraftsDir,
    dataDir: config.dataDir,
    skillSources: config.codexSkillSources,
  });
  await app.register(draftRoutes, { drafts });
  // 设计与优化会话的 workflow 面板（Contracts 第 26 节）
  const workspace = createWorkspace({ db, drafts });
  await app.register(workspaceRoutes, { workspace });
  // 设计与优化会话中 src/skills 随写随装（Contracts 28.2）
  const sessionSync = createSessionSync({ db });
  app.addHook('onClose', () => {
    workspace.shutdown();
    sessionSync.shutdown();
    return Promise.resolve();
  });
  // 删除 variant 与 workflow（Contracts 第 24 节）
  await app.register(deletionRoutes, {
    deletion: createDeletion({
      db,
      variants,
      live,
      draftsDir: config.workflowDraftsDir,
      dataDir: config.dataDir,
    }),
  });
  // Sessions 页面的删除与归档（Contracts 25.3）
  await app.register(sessionActionRoutes, {
    actions: createSessionActions({ db, live, codexBin: config.codexBin }),
  });
  // 诊断（Contracts 第 5 节，W58）：只读，测量与测试用它确认资源释放
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

  // 页面的路由在浏览器中：未匹配 /api 的路径都返回 index.html
  if (webDir !== undefined) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.code(404).send({ message: `${request.method} ${request.url} 不存在` });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
