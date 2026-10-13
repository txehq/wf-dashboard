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
import { createLive } from '../live/index.js';
import { createRuns } from '../runs/index.js';
import { createSettingsStore } from '../runs/settings.js';
import { createVariants } from '../variants/index.js';
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
import { draftRoutes } from './drafts.js';

export interface AppOptions {
  db: Db;
  sseHeartbeatMs: number;
  logger: boolean;
  tasksDir: string;
  // pnpm start：构建好的页面目录（web/dist），由同一个进程提供
  webDir?: string | undefined;
  // 交互"本机配置"的 HOME，默认真实 HOME；测试用 .work/ 下的目录
  localHome?: string | undefined;
}

export async function buildApp({
  db,
  sseHeartbeatMs,
  logger,
  tasksDir,
  webDir,
  localHome,
}: AppOptions) {
  const app = Fastify({ logger });
  await app.register(fastifySSE, { heartbeatInterval: sseHeartbeatMs });

  app.get('/api/health', () => {
    db.$client.prepare('select 1').get();
    return { status: 'ok' };
  });

  // 实时事件推送：连接时先发 ready，之后转发事件总线上的全部事件
  app.get('/api/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();
    const unsubscribe = events.subscribe((event) => {
      void reply.sse.send({ event: event.type, data: event });
    });
    reply.sse.onClose(unsubscribe);
    await reply.sse.send({ event: 'ready', data: {} });
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
  });
  await app.register(liveRoutes, { live });
  app.addHook('onClose', async () => {
    await live.shutdown();
  });

  // 可配置的 workflow（Contracts 16.1）
  await app.register(workflowRoutes, { workflows: createWorkflows({ db, variants }) });
  // "在访达中打开"（Contracts 16.7）
  await app.register(openRoutes, { db, variants, live });
  // 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）
  await app.register(draftRoutes, {
    drafts: createDrafts({
      db,
      variants,
      live,
      draftsDir: config.workflowDraftsDir,
      dataDir: config.dataDir,
      skillSources: config.codexSkillSources,
    }),
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
