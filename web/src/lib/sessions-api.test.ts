import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readJson } from './sessions-api';

// W15 H12：真实 Fastify 服务的两种错误响应
const app = Fastify();
app.post('/api/sessions/:id/analyze', () => {
  throw new Error('gateway 返回 529 overloaded');
});
app.get('/api/sessions/:id/stages', async (_request, reply) =>
  reply.code(404).send({ error: 'session x 尚未判定' }),
);
let base = '';

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
});

test('路由中抛出的错误显示 Fastify 响应 message 中的原文', async () => {
  const url = `${base}/api/sessions/x/analyze`;
  const response = await fetch(url, { method: 'POST' });
  expect(await response.clone().json()).toMatchObject({ error: 'Internal Server Error' });
  await expect(readJson(response, url)).rejects.toThrow(
    `${url} 返回 500：gateway 返回 529 overloaded`,
  );
});

test('路由自己返回的 { error } 照常显示', async () => {
  const url = `${base}/api/sessions/x/stages`;
  await expect(readJson(await fetch(url), url)).rejects.toThrow(
    `${url} 返回 404：session x 尚未判定`,
  );
});
