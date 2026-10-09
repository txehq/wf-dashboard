import { fastifySSE } from '@fastify/sse';
import Fastify from 'fastify';
import type { Db } from '../db/index.js';

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

  // 实时事件推送；具体事件由后续模块发布
  app.get('/api/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();
    await reply.sse.send({ event: 'ready', data: {} });
  });

  return app;
}
