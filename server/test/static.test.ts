import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

// pnpm start：同一个进程提供 API 与 web/dist；这里用一个最小的构建目录
const work = path.join(config.repoRoot, '.work', 'test-static', randomUUID());
const webDir = path.join(work, 'dist');
fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
fs.writeFileSync(path.join(webDir, 'assets/index.js'), 'console.log(1)');

const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
  webDir,
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('构建好的页面', () => {
  test('静态文件按路径返回', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.body).toBe('console.log(1)');
  });

  test('页面路由返回 index.html', async () => {
    for (const url of ['/', '/runs', '/runs/r-20261009-dqva52', '/sessions/abc?x=1']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toMatch(/text\/html/);
      expect(response.body, url).toContain('<div id="root"></div>');
    }
  });

  test('API 照常可用，未匹配的 /api 路径返回 404 JSON', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      status: 'ok',
    });
    const missing = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ message: 'GET /api/no-such-route 不存在' });
  });
});
