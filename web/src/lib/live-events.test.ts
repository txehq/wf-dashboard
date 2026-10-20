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
// 服务"停止"期间返回 502 的次数
let refused = 0;
// 连上后先发 retry: 100：EventSource 自己的重连在 100 ms 后（默认 3 秒），服务"停止"期间就得到 502。
// ready 在连上 300 ms 后才发，/api/value 在 200 ms 后才读值回答（机器忙时的顺序）：第一次查询先得到数据，之后的 ready
// 再触发一次刷新，这次刷新回答前读到的是那时的值。检查要等刷新结束（client.isFetching() 为 0），不能只看数据
app.get('/api/events', (_request, reply) => {
  if (!up) {
    refused += 1;
    return reply.code(502).type('text/plain').send('');
  }
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  reply.raw.write('retry: 100\n\n');
  open = reply;
  setTimeout(() => {
    if (!reply.raw.writableEnded) reply.raw.write('event: ready\ndata: {}\n\n');
  }, 300);
});
app.get('/api/value', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { value };
});
// 一直失败的接口：记下请求了几次
let failingRequests = 0;
app.get('/api/failing', (_request, reply) => {
  failingRequests += 1;
  return reply.code(500).send({ message: 'ENOENT' });
});
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
  await until(
    () =>
      liveStatus() === 'open' &&
      client.isFetching() === 0 &&
      observer.getCurrentResult().data === 1,
    5_000,
  );

  // 服务"停止"：断开现有连接，之后的请求得到 502；断开期间数据变化，页面收不到事件
  up = false;
  value = 2;
  open?.raw.end();
  await until(() => liveStatus() === 'lost', 5_000);
  // 浏览器自己的重连得到 502 后连接关闭；这时数据仍是旧的
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(refused).toBeGreaterThan(0);
  expect(observer.getCurrentResult().data).toBe(1);

  // 服务恢复：按退避重建连接，ready 之后重新拉取
  up = true;
  await until(() => liveStatus() === 'open', 10_000);
  await until(() => observer.getCurrentResult().data === 2, 5_000);
  expect(seen).toContain(2);
  close();
  unsubscribe();
});

// W62：整页刷新（重连后的 ready）不重新请求已失败的查询，失败的查询只由「重试」（refetch）恢复；成功的查询照常刷新
test('重连后的 ready 刷新成功的查询，不重新请求已失败的查询；refetch 仍然请求', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ok = new QueryObserver(client, {
    queryKey: ['value'],
    queryFn: async () =>
      ((await (await fetch(`${base}/api/value`)).json()) as { value: number }).value,
  });
  const failing = new QueryObserver(client, {
    queryKey: ['failing'],
    queryFn: async () => {
      const response = await fetch(`${base}/api/failing`);
      if (!response.ok) throw new Error(`返回 ${String(response.status)}`);
      return response.json() as Promise<unknown>;
    },
  });
  const unsubscribeOk = ok.subscribe(() => undefined);
  const unsubscribeFailing = failing.subscribe(() => undefined);
  const close = connectLiveEvents(client, `${base}/api/events`);
  await until(() => liveStatus() === 'open' && failing.getCurrentResult().isError, 5_000);
  // 第一次 ready 可能在失败之前或之后到达：之后的检查从 ready 触发的刷新都结束时的次数算起
  await until(() => client.isFetching() === 0, 5_000);
  const before = failingRequests;

  // 断开现有连接，浏览器自己重连（服务正常），新的 ready 到达后成功的查询刷新
  value += 1;
  const next = value;
  open?.raw.end();
  await until(() => ok.getCurrentResult().data === next, 10_000);
  expect(failingRequests).toBe(before);
  expect(failing.getCurrentResult().isError).toBe(true);

  // 「重试」：refetch 照常请求一次
  await failing.refetch();
  expect(failingRequests).toBe(before + 1);
  close();
  unsubscribeOk();
  unsubscribeFailing();
});
