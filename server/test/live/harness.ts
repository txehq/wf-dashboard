import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import xtermHeadless from '@xterm/headless';
import Fastify from 'fastify';
import { liveRoutes } from '../../src/api/live.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { createLive, type Live } from '../../src/live/index.js';
import type { LiveDetail } from '../../src/live/views.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants, type Variant } from '../../src/variants/index.js';
import { testRepos } from '../helpers/local-repos.js';

// 交互测试的服务：真实构建的基线 variant（wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用）、
// 真实 SQLite、监听随机端口（hook 命令 POST 到这里）
export async function startLiveServer(options: { localHome?: string } = {}) {
  const variantsData = path.join(config.repoRoot, '.work', 'test-data');
  const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
  const db = openDatabase(dbFile, config.migrationsDir);
  const variants = createVariants({
    db,
    dataDir: variantsData,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
  });
  const base = await variants.createBaseline({
    name: `W30 基线 ${randomUUID().slice(0, 8)}`,
  });
  const variant: Variant = await variants.build(base.id);
  const settings = createSettingsStore(db);
  const app = Fastify();
  await app.register(fastifyWebsocket);
  const live: Live = createLive({
    db,
    variants,
    settings,
    vaultDir: config.vaultDir,
    product: config.evalProduct,
    liveDir: config.liveDir,
    dataDir: variantsData,
    serverUrl: () => url,
    localHome: options.localHome ?? path.join(config.dataDir, 'home'),
    repos: testRepos(),
  });
  await app.register(liveRoutes, { live });
  app.addHook('onClose', async () => {
    await live.shutdown();
  });
  await app.listen({ host: config.host, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听端口');
  const url = `http://${config.host}:${String(address.port)}`;

  const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${route} 返回 ${String(response.status)}：${text}`);
    return JSON.parse(text) as T;
  };

  return {
    app,
    url,
    db,
    variants,
    variant,
    live,
    api,
    detail: (id: string) => api<LiveDetail>('GET', `/api/live/${id}`),
    async close() {
      await app.close();
      db.$client.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
      fs.rmSync(path.join(variantsData, 'variants', variant.id), { recursive: true, force: true });
    },
  };
}

export type LiveServer = Awaited<ReturnType<typeof startLiveServer>>;

// 一个 WebSocket 客户端：收到的输出写进 headless xterm，可以读屏幕
export function terminalClient(url: string, liveId: string, cols = 120, rows = 40) {
  const term = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
  const socket = new WebSocket(`${url.replace('http', 'ws')}/api/live/${liveId}/pty`);
  const messages: { type: string; data?: string }[] = [];
  let received = '';
  const opened = new Promise<void>((resolve) => {
    socket.addEventListener('open', () => {
      resolve();
    });
  });
  socket.addEventListener('message', (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as { type: string; data?: string };
    messages.push(message);
    if (message.type === 'output' && message.data !== undefined) {
      received += message.data;
      term.write(message.data);
    }
  });
  const screen = async () => {
    await new Promise<void>((resolve) => {
      term.write('', resolve);
    });
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + term.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines;
  };
  return {
    socket,
    opened,
    messages,
    received: () => received,
    screen,
    send(message: unknown) {
      socket.send(JSON.stringify(message));
    },
    input(data: string) {
      socket.send(JSON.stringify({ type: 'input', data }));
    },
    resize(c: number, r: number) {
      term.resize(c, r);
      socket.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
    },
    close() {
      socket.close();
      term.dispose();
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 每秒检查一次，直到 check 返回非空
export async function until<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | null> | T | null,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${String(timeoutMs)} ms）`);
    await sleep(1000);
  }
}

export const hookNames = (detail: LiveDetail) =>
  detail.events.filter((e) => e.kind === 'hook').map((e) => String(e.payload.hook_event_name));
