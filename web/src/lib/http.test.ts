import Fastify from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HttpError, isNotFound, readBody, requestJson } from './http';

// 真实 Fastify 服务的各种响应
const app = Fastify();
// W15 H12：路由中抛出的错误，原文在 Fastify 响应的 message
app.post('/api/tasks/rubric-draft', () => {
  throw new Error('gateway 返回 529 overloaded');
});
app.get('/api/sessions/:id/stages', async (_request, reply) =>
  reply.code(404).send({ error: 'session x 不存在' }),
);
// W15 Medium 20：服务端停止时 Vite 代理返回空正文的 502；以前先读 JSON，页面显示 "Unexpected end of JSON input"
app.get('/api/runs', async (_request, reply) => reply.code(502).type('text/plain').send(''));
app.get('/api/text', async (_request, reply) => reply.type('text/plain').send('plain body'));
let base = '';

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
});

test('路由中抛出的错误显示 Fastify 响应 message 中的原文', async () => {
  const url = `${base}/api/tasks/rubric-draft`;
  const response = await fetch(url, { method: 'POST' });
  expect(await response.clone().json()).toMatchObject({ error: 'Internal Server Error' });
  await expect(readBody(response, url)).rejects.toThrow(
    `${url} 返回 500：gateway 返回 529 overloaded`,
  );
});

test('路由自己返回的 { error } 照常显示，404 可以识别', async () => {
  const url = `${base}/api/sessions/x/stages`;
  const error: unknown = await readBody(await fetch(url), url).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).message).toBe(`${url} 返回 404：session x 不存在`);
  expect(isNotFound(error)).toBe(true);
});

test('空正文的 502 显示 URL 与状态码', async () => {
  const url = `${base}/api/runs`;
  const error: unknown = await requestJson('GET', url).then(
    () => null,
    (e: unknown) => e,
  );
  expect((error as Error).message).toBe(`${url} 返回 502`);
  expect(isNotFound(error)).toBe(false);
});

test('成功的纯文本响应按文本读出', async () => {
  expect(await requestJson('GET', `${base}/api/text`)).toBe('plain body');
});
