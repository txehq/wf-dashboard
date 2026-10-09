import { fastifySSE } from '@fastify/sse';
import Fastify from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { events } from '../events.js';
import { defaultSourceDirs } from '../ingest/sources.js';
import { createVariants } from '../variants/index.js';
import { sessionsRoutes } from './sessions.js';
import { registerStageRoutes } from './stages.js';
import { variantRoutes } from './variants.js';

export interface AppOptions {
  db: Db;
  sseHeartbeatMs: number;
  logger: boolean;
}

export async function buildApp({ db, sseHeartbeatMs, logger }: AppOptions) {
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

  // 事件总线合并前，variant 事件只写日志
  const variants = createVariants({
    db,
    dataDir: config.dataDir,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    publish: (event) => {
      app.log.info(event, 'variant event');
    },
  });
  await app.register(variantRoutes, { variants });

  return app;
}
