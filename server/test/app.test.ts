import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { events } from '../src/events.js';

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({ db, sseHeartbeatMs: config.sseHeartbeatMs, logger: false });

beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true });
});

function baseUrl() {
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('server 未监听 TCP 端口');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('api', () => {
  test('GET /api/health 返回 ok', async () => {
    const response = await fetch(`${baseUrl()}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('GET /api/events 建立 SSE 连接并推送 ready 事件', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl()}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const body = response.body;
    if (body === null) throw new Error('SSE 响应没有 body');
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    const { value } = await reader.read();
    expect(value).toContain('event: ready');
    controller.abort();
  });

  test('GET /api/events 转发事件总线上的 session.updated', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl()}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const body = response.body;
    if (body === null) throw new Error('SSE 响应没有 body');
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let received = '';
    while (!received.includes('event: ready')) received += (await reader.read()).value ?? '';
    events.publish({ type: 'session.updated', sessionId: 'session-1' });
    while (!received.includes('event: session.updated'))
      received += (await reader.read()).value ?? '';
    expect(received).toContain('data: {"type":"session.updated","sessionId":"session-1"}');
    controller.abort();
  });
});
