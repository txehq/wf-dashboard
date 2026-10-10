import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { EventSource } from 'eventsource';
import Fastify, { type FastifyReply } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { connectLiveEvents, liveStatus } from './live-events';

// W15 H11：服务重启期间 Vite 代理对 /api/events 返回 502 text/plain，EventSource 按规范永久关闭、不再重试；
// 页面此后再也收不到实时更新，也补不上断开期间的变化。这里用真实的 Fastify 服务与符合规范的 EventSource 实现：
// 服务"停止"时返回同样的 502，确认连接被重建、状态经过 lost 回到 open，重连后的 ready 让查询重新拉取
globalThis.EventSource = EventSource;

const app = Fastify();
let up = true;
let value = 1;
let open: FastifyReply | null = null;
app.get('/api/events', (_request, reply) => {
  if (!up) return reply.code(502).type('text/plain').send('');
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  reply.raw.write('event: ready\ndata: {}\n\n');
  open = reply;
});
app.get('/api/value', () => ({ value }));
let base = '';

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  open?.raw.end();
  await app.close();
});

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('连接被关闭后重建，状态 lost → open，重连后的 ready 补上断开期间的变化', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, {
    queryKey: ['value'],
    queryFn: async () =>
      ((await (await fetch(`${base}/api/value`)).json()) as { value: number }).value,
  });
  const seen: (number | undefined)[] = [];
  const unsubscribe = observer.subscribe((r) => seen.push(r.data));
  const close = connectLiveEvents(client, `${base}/api/events`);
  await until(() => liveStatus() === 'open' && observer.getCurrentResult().data === 1, 5_000);

  // 服务"停止"：断开现有连接，之后的请求得到 502；断开期间数据变化，页面收不到事件
  up = false;
  value = 2;
  open?.raw.end();
  await until(() => liveStatus() === 'lost', 5_000);
  // 浏览器自己的重连得到 502 后连接关闭；这时数据仍是旧的
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(observer.getCurrentResult().data).toBe(1);

  // 服务恢复：按退避重建连接，ready 之后重新拉取
  up = true;
  await until(() => liveStatus() === 'open', 10_000);
  await until(() => observer.getCurrentResult().data === 2, 5_000);
  expect(seen).toContain(2);
  close();
  unsubscribe();
});
