import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, expect, test } from 'vitest';
import { sessionsRoutes } from '../src/api/sessions.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { events } from '../src/events.js';
import { configSourceDirs } from '../src/ingest/session-config.js';
import { SAMPLES } from './stages/samples.js';

// 分段导入期间服务照常响应（Contracts 25.5「分段，不阻塞其他请求」）：真实样本 9f4adf2d（主 jsonl 4.2 MB，每段 2 MB，三段）。
// 服务与客户端在同一个进程中：第一段写完时（session.updated，同步发生在导入中），经已连好的 keep-alive 连接
// 发出 GET /api/sessions/<id>，请求在第二段开始前已写进连接。导入在段之间让出事件循环时，这个请求在后面的段
// 写入之前被处理，返回的 session 只有部分请求；导入不让出时它排在导入结束之后，返回的是全部请求。
// 结果只取决于事件循环的顺序，与机器快慢无关
const id = path.basename(SAMPLES.research, '.jsonl');
const tag = randomUUID().slice(0, 8);
const dirs = configSourceDirs;
const work = path.join(config.repoRoot, '.work', 'test-session-import-yield', tag);
const projectDir = path.join(dirs.projectsDir, `-yield-${tag}`);
const file = path.join(projectDir, `${id}.jsonl`);
fs.mkdirSync(projectDir, { recursive: true });
fs.copyFileSync(SAMPLES.research, file);
fs.cpSync(SAMPLES.research.replace(/\.jsonl$/, ''), path.join(projectDir, id), {
  recursive: true,
});
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const app = Fastify();
await app.register(sessionsRoutes, { prefix: '/api', db, dirs });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

afterAll(async () => {
  agent.destroy();
  await app.close();
  db.$client.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function detail(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/api/sessions/${id}`, { agent }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      })
      .on('error', reject);
  });
}

const requestCount = (body: string) => (JSON.parse(body) as { requestCount: number }).requestCount;

test('分段导入的段之间让出事件循环：第一段写完时发出的请求在导入结束前得到回答，看到的 session 只导入了一部分', async () => {
  // 先连好 keep-alive 连接：导入前 session 不存在
  expect((await detail()).status).toBe(404);
  // 第一段写完时发出的请求；之后的段不再发
  const probes: Promise<{ status: number; body: string }>[] = [];
  let updates = 0;
  const unsubscribe = events.subscribe((event) => {
    if (event.type !== 'session.updated' || event.sessionId !== id) return;
    updates += 1;
    if (probes.length === 0) probes.push(detail());
  });
  const response = await fetch(`${base}/api/session-import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'claude', files: [file] }),
  });
  unsubscribe();
  expect(response.status, await response.text()).toBe(200);
  expect(updates).toBeGreaterThan(1);
  const [during] = await Promise.all(probes);
  if (during === undefined) throw new Error('导入没有发布 session.updated');
  expect(during.status).toBe(200);
  const final = await detail();
  expect(requestCount(during.body)).toBeGreaterThan(0);
  expect(requestCount(during.body)).toBeLessThan(requestCount(final.body));
});
