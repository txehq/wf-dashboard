import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sessionLines } from '../helpers/session-copies.js';

// 自动结束（Contracts 14.3），基础档：真实的服务（buildApp，真实的 /api/events SSE 与 PTY WebSocket），
// Claude Code 换成替身（test/fixtures/live/claude-stand-in.mjs，收到 SIGINT 即退出），"本机配置"的 HOME 在 .work/ 下。
// 计时改为 800 ms；"结束进程"在 SIGINT 之后补发 SIGTERM 前等待的时长改为 1.5 秒（默认 10 秒，下面的用例确认）
const work = path.join(import.meta.dirname, '../../../.work/test-live-auto-stop', randomUUID());
const home = path.join(work, 'home');
const projects = path.join(work, 'projects');
const cwd = path.join(work, 'cwd');
const IDLE_MS = 800;
const GRACE_MS = 1_500;
process.env.WFD_LIVE_AUTO_STOP_MS = String(IDLE_MS);
process.env.WFD_LIVE_STOP_GRACE_MS = String(GRACE_MS);
process.env.WFD_CLAUDE_BIN = path.join(import.meta.dirname, '../fixtures/live/claude-stand-in.mjs');
process.env.WFD_LOCAL_HOME = home;
process.env.WFD_CLAUDE_PROJECTS = projects;

const { config, LIVE_STOP_GRACE_MS } = await import('../../src/config.js');
const { buildApp } = await import('../../src/api/app.js');
const { openDatabase } = await import('../../src/db/index.js');
const { ingestFile } = await import('../../src/ingest/ingest.js');
const { ClaudeProcess } = await import('../../src/runs/claude-process.js');

fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(projects, '-w56'), { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
  localHome: config.localHome,
});
let base = '';

beforeAll(async () => {
  await app.listen({ host: config.host, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听端口');
  base = `http://${config.host}:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

interface Event {
  kind: string;
  processId: number | null;
  payload: Record<string, unknown>;
}
interface Detail {
  id: string;
  status: string;
  process: { id: number; status: string } | null;
  events: Event[];
}

const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} 返回 ${String(response.status)}：${text}`);
  return JSON.parse(text) as T;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 一个本机导入的短 session，以"本机配置"resume：进程是替身
async function resumed(): Promise<Detail> {
  const id = randomUUID();
  const file = path.join(projects, '-w56', `${id}.jsonl`);
  fs.writeFileSync(file, sessionLines(id, cwd));
  ingestFile(db, file);
  const live = await api<Detail>('POST', '/api/live/resume', {
    sessionId: id,
    variantId: null,
    driver: 'human',
  });
  expect(live.status).toBe('running');
  return live;
}

const detail = (id: string) => api<Detail>('GET', `/api/live/${id}`);

async function exited(id: string, timeoutMs: number): Promise<Detail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await detail(id);
    if (d.status === 'exited') return d;
    if (Date.now() > deadline) throw new Error(`交互 ${id} 在 ${String(timeoutMs)} ms 内没有结束`);
    await sleep(100);
  }
}

// 一个打开着的页面：/api/events 的 SSE 连接，收到 ready 后返回关闭它的函数
async function openSse(): Promise<() => Promise<void>> {
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
  return async () => {
    // 中止请求即关闭连接，服务端的 onClose 随之触发；等它处理完
    abort.abort();
    await sleep(50);
  };
}

async function openPty(liveId: string): Promise<() => Promise<void>> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/live/${liveId}/pty`);
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => {
      resolve();
    });
  });
  return async () => {
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => {
        resolve();
      });
    });
    socket.close();
    await closed;
  };
}

const autoStops = (d: Detail) => d.events.filter((e) => e.kind === 'auto-stop');

test('没有任何页面连接：计时到达时结束运行中的交互进程并记 auto-stop；运行中的 run 不受影响', async () => {
  // 一个评测 run 的 claude 进程（runs 模块的 ClaudeProcess，替身脚本一直运行）
  const bin = path.join(work, 'run-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const run = new ClaudeProcess({
    sessionId: randomUUID(),
    cwd: work,
    env: { PATH: `${bin}:/usr/bin:/bin` },
    variantArgs: [],
    sandboxProfile: '(version 1)\n(allow default)',
    logDir: path.join(work, 'run-log'),
    onEvent: () => undefined,
    onTurn: () => undefined,
    onError: (error) => {
      throw error;
    },
  });
  let runExited = false;
  void run.exited.then(() => {
    runExited = true;
  });

  const started = Date.now();
  const live = await resumed();
  const ended = await exited(live.id, IDLE_MS + 5000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS);
  const stops = autoStops(ended);
  expect(stops).toHaveLength(1);
  expect(stops[0]?.processId).toBe(live.process?.id);
  // 服务启动后还没有过任何连接
  expect(stops[0]?.payload).toEqual({ lastDisconnectAt: null, idleMs: IDLE_MS });
  // 显示与其他结束的项相同（已退出），只在 live_events 中记 auto-stop；先记 auto-stop，再有进程的 exit
  expect(ended).toMatchObject({ status: 'exited', process: { status: 'exited' } });
  expect(ended).not.toHaveProperty('autoStopped');
  const kinds = ended.events.map((e) => e.kind);
  expect(kinds.indexOf('auto-stop')).toBeLessThan(kinds.lastIndexOf('exit'));

  await sleep(500);
  expect(runExited).toBe(false);
  run.terminate();
  await run.exited;
});

test('计时中重新连上 SSE 或 WebSocket 时不结束；最后一个连接断开后重新计时', async () => {
  const closeSse = await openSse();
  const live = await resumed();
  await closeSse();
  // 计时到一半时打开这一项的终端（WebSocket），超过计时后仍在运行
  await sleep(IDLE_MS / 2);
  const closePty = await openPty(live.id);
  await sleep(IDLE_MS * 2);
  expect((await detail(live.id)).status).toBe('running');
  // 再换回 SSE：先连上 SSE 再关终端，连接数一直不为 0
  const closeSse2 = await openSse();
  await closePty();
  await sleep(IDLE_MS * 2);
  expect((await detail(live.id)).status).toBe('running');
  const disconnectedAt = Date.now();
  await closeSse2();
  const ended = await exited(live.id, IDLE_MS + 5000);
  const stops = autoStops(ended);
  expect(stops).toHaveLength(1);
  const at = new Date(String(stops[0]?.payload.lastDisconnectAt)).getTime();
  expect(Math.abs(at - disconnectedAt)).toBeLessThan(1000);
  // 之后照常可以 resume；新的进程不算自动结束
  const again = await api<Detail>('POST', '/api/live/resume', {
    sessionId: (await api<{ claudeSessionId: string }>('GET', `/api/live/${live.id}`))
      .claudeSessionId,
    variantId: null,
    driver: 'human',
  });
  expect(again.id).toBe(live.id);
  expect(again.status).toBe('running');
  await api('POST', `/api/live/${live.id}/stop`);
});

test('在页面之间切换（SSE 一直连着、终端开开关关）时不结束', async () => {
  const closeSse = await openSse();
  const live = await resumed();
  for (let i = 0; i < 3; i++) {
    const closePty = await openPty(live.id);
    await sleep(IDLE_MS / 2);
    await closePty();
    await sleep(IDLE_MS);
  }
  const d = await detail(live.id);
  expect(d.status).toBe('running');
  expect(autoStops(d)).toEqual([]);
  await api('POST', `/api/live/${live.id}/stop`);
  await closeSse();
});

test('"结束进程"先发 SIGINT，进程不理会时等待的时长过后补发 SIGTERM（默认 10 秒）', async () => {
  expect(LIVE_STOP_GRACE_MS).toBe(10_000);
  expect(config.liveStopGraceMs).toBe(GRACE_MS);
  process.env.STAND_IN_IGNORE_SIGINT = '1';
  const closeSse = await openSse();
  const live = await resumed();
  delete process.env.STAND_IN_IGNORE_SIGINT;
  // 替身写出第一行之后才装好 SIGINT 的处理；在那之前发的 SIGINT 会直接结束它
  const log = path.join(config.liveDir, live.id, 'pty.log');
  while (!(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('替身'))) await sleep(50);
  const started = Date.now();
  const stopped = await api<Detail>('POST', `/api/live/${live.id}/stop`);
  const took = Date.now() - started;
  expect(stopped.status).toBe('exited');
  expect(took).toBeGreaterThanOrEqual(config.liveStopGraceMs);
  expect(took).toBeLessThan(config.liveStopGraceMs + 5000);
  const exit = stopped.events.findLast((e) => e.kind === 'exit');
  expect(exit?.payload.signal).toBe(15);
  expect(fs.readFileSync(log, 'utf8')).toContain('sigint ignored');
  await closeSse();
});
