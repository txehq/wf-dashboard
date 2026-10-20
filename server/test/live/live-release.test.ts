import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sessionLines } from '../helpers/session-copies.js';

// W58：交互进程结束后服务端释放这一项的资源（Contracts 14.3、第 5 节的诊断），服务关闭时页面开着也能关闭。
// 基础档：真实的服务（buildApp，真实的 /api/events SSE 与 PTY WebSocket），Claude Code 换成替身，"本机配置"的 HOME 在 .work/ 下
const work = path.join(import.meta.dirname, '../../../.work/test-live-release', randomUUID());
const home = path.join(work, 'home');
const projects = path.join(work, 'projects');
const cwd = path.join(work, 'cwd');
process.env.WFD_CLAUDE_BIN = path.join(import.meta.dirname, '../fixtures/live/claude-stand-in.mjs');
process.env.WFD_LOCAL_HOME = home;
process.env.WFD_CLAUDE_PROJECTS = projects;

const { config } = await import('../../src/config.js');
const { buildApp } = await import('../../src/api/app.js');
const { openDatabase } = await import('../../src/db/index.js');
const { ingestFile } = await import('../../src/ingest/ingest.js');

fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(projects, '-w58'), { recursive: true });

// 一份服务：自己的数据库，监听随机端口
async function startServer() {
  const db = openDatabase(path.join(work, `${randomUUID()}.sqlite`), config.migrationsDir);
  const app = await buildApp({
    db,
    sseHeartbeatMs: config.sseHeartbeatMs,
    logger: false,
    tasksDir: config.tasksDir,
    localHome: config.localHome,
  });
  await app.listen({ host: config.host, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听端口');
  const base = `http://${config.host}:${String(address.port)}`;

  const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${route}`, {
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

  // 一个本机导入的短 session，以"本机配置"resume：进程是替身
  const resumed = async () => {
    const id = randomUUID();
    const file = path.join(projects, '-w58', `${id}.jsonl`);
    fs.writeFileSync(file, sessionLines(id, cwd));
    ingestFile(db, file);
    const live = await api<Detail>('POST', '/api/live/resume', {
      sessionId: id,
      variantId: null,
      driver: 'human',
    });
    expect(live.status).toBe('running');
    return live;
  };

  // 一个打开着的页面：/api/events 的 SSE 连接，收到 ready 后返回关闭它的函数
  const openSse = async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: abort.signal });
    const body = response.body;
    if (body === null) throw new Error('SSE 没有响应体');
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    let text = '';
    while (!text.includes('event: ready')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE 在 ready 之前结束');
      text += new TextDecoder().decode(chunk.value);
    }
    return () => {
      abort.abort();
    };
  };

  // 一项的终端：收到的消息与关闭时的 code
  const openPty = async (liveId: string) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/live/${liveId}/pty`);
    const messages: { type: string; data?: string }[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as { type: string; data?: string });
    });
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        resolve();
      });
    });
    return { socket, messages, closed };
  };

  return { app, db, base, api, resumed, openSse, openPty };
}

interface Detail {
  id: string;
  status: string;
  process: { pid: number } | null;
}
interface Diagnostics {
  activeResources: Record<string, number>;
  events: { subscribers: number };
  live: {
    connections: number;
    controllers: {
      liveId: string;
      alive: boolean;
      retainedBytes: number;
      screenReleased: boolean;
    }[];
    ptys: { unreleased: number; retainedBytes: number };
  };
  ingest: { watchers: number };
}

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.app.close();
  server.db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const diagnostics = () => server.api<Diagnostics>('GET', '/api/diagnostics');
const ptyLog = (id: string) => path.join(config.liveDir, id, 'pty.log');
const standInStarted = async (id: string) => {
  while (!(fs.existsSync(ptyLog(id)) && fs.readFileSync(ptyLog(id), 'utf8').includes('替身'))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test('进程结束后释放这一项保留的输出与屏幕副本，服务端关闭这一项终端的 WebSocket', async () => {
  const closeSse = await server.openSse();
  const before = await diagnostics();
  const live = await server.resumed();
  await standInStarted(live.id);
  const terminal = await server.openPty(live.id);
  const running = await diagnostics();
  const item = running.live.controllers.find((c) => c.liveId === live.id);
  expect(item).toMatchObject({ alive: true, screenReleased: false });
  expect(item?.retainedBytes).toBeGreaterThan(0);
  expect(running.live.ptys.unreleased).toBe(before.live.ptys.unreleased + 1);
  expect(running.ingest.watchers).toBe(before.ingest.watchers + 1);

  await server.api('POST', `/api/live/${live.id}/stop`);
  // 已连接的终端先收到 exit，之后服务端以 1000 关闭连接，不再引用这一项
  expect(await terminal.closed).toBe(1000);
  expect(terminal.messages.at(-1)).toEqual({ type: 'exit' });
  const after = await diagnostics();
  expect(after.live.controllers.find((c) => c.liveId === live.id)).toBeUndefined();
  expect(after.live.ptys).toEqual(before.live.ptys);
  expect(after.ingest.watchers).toBe(before.ingest.watchers);
  expect(after.events.subscribers).toBe(before.events.subscribers);
  expect(after.activeResources.TTYWrap ?? 0).toBe(before.activeResources.TTYWrap ?? 0);
  closeSse();
});

// W81：进程退出的那一刻页面还在发 resize 与输入（拖动窗口、终端自动适配）：服务不退出，页面收到 exit
test('结束进程时终端连续发 resize 与输入：页面收到 exit，服务之后仍然响应', async () => {
  for (let i = 0; i < 5; i++) {
    const live = await server.resumed();
    await standInStarted(live.id);
    const terminal = await server.openPty(live.id);
    let turn = 0;
    const flood = setInterval(() => {
      if (terminal.socket.readyState !== WebSocket.OPEN) return;
      turn += 1;
      terminal.socket.send(JSON.stringify({ type: 'resize', cols: 80 + (turn % 2), rows: 24 }));
      terminal.socket.send(JSON.stringify({ type: 'input', data: 'x' }));
    }, 0);
    await server.api('POST', `/api/live/${live.id}/stop`);
    expect(await terminal.closed).toBe(1000);
    clearInterval(flood);
    expect(terminal.messages.at(-1)).toEqual({ type: 'exit' });
    const after = await diagnostics();
    expect(after.live.controllers.find((c) => c.liveId === live.id)).toBeUndefined();
  }
});

test('结束之后打开终端：回放完整的 pty.log，收到 exit 后服务端关闭连接', async () => {
  const live = await server.resumed();
  await standInStarted(live.id);
  await server.api('POST', `/api/live/${live.id}/stop`);
  const terminal = await server.openPty(live.id);
  expect(await terminal.closed).toBe(1000);
  expect(terminal.messages).toEqual([
    { type: 'output', data: fs.readFileSync(ptyLog(live.id), 'utf8') },
    { type: 'exit' },
  ]);
  expect(terminal.messages[0]?.data).toContain('Claude Code 替身（测试）');
});

test('服务关闭时页面开着（SSE 与终端的 WebSocket）：关闭在几秒内完成，交互进程随之结束', async () => {
  const other = await startServer();
  const closeSse = await other.openSse();
  const live = await other.resumed();
  await standInStarted(live.id);
  const terminal = await other.openPty(live.id);
  const pid = live.process?.pid ?? 0;
  expect((await execa('ps', ['-p', String(pid)], { reject: false })).exitCode).toBe(0);

  const started = Date.now();
  await other.app.close();
  expect(Date.now() - started).toBeLessThan(config.liveStopGraceMs);
  // 终端的 WebSocket 由服务端关闭，替身进程已不在
  await terminal.closed;
  expect((await execa('ps', ['-p', String(pid)], { reject: false })).exitCode).toBe(1);
  closeSse();
  other.db.$client.close();
});
