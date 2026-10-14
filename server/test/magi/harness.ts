import fs from 'node:fs';
import path from 'node:path';
import { createMagiRepo } from '../helpers/magi-repo.js';

// Magi Agent 测试的服务（真实的 buildApp 与 /api/magi-agent）：Claude Code 与 Codex 换成替身命令（回显收到的参数），
// "本机配置"的 HOME、主仓库与 worktree 都在 work 下。环境变量在第一次导入 config 之前设置，所以这个文件中的 config、
// buildApp 都动态导入
export interface MagiApp {
  base: string;
  work: string;
  home: string;
  repo: string;
  worktree: string;
  db: import('../../src/db/index.js').Db;
  close: () => Promise<void>;
  restarts: { count: number };
}

export async function startMagiApp(
  work: string,
  env: Record<string, string> = {},
): Promise<MagiApp> {
  const home = path.join(work, 'home');
  const repo = path.join(work, 'repo');
  const worktree = path.join(work, 'wf-dashboard-magi-agent');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(work, 'projects'), { recursive: true });
  if (!fs.existsSync(repo)) await createMagiRepo(repo);
  Object.assign(process.env, {
    WFD_DATA_DIR: path.join(work, 'data'),
    WFD_CLAUDE_BIN: path.join(import.meta.dirname, '../fixtures/live/claude-stand-in.mjs'),
    WFD_CODEX_BIN: path.join(import.meta.dirname, '../fixtures/codex/codex-stand-in.mjs'),
    WFD_LOCAL_HOME: home,
    WFD_CLAUDE_PROJECTS: path.join(work, 'projects'),
    WFD_MAGI_REPO: repo,
    WFD_MAGI_WORKTREE: worktree,
    STAND_IN_ECHO_ARGV: '1',
    ...env,
  });
  const { config } = await import('../../src/config.js');
  const { buildApp } = await import('../../src/api/app.js');
  const { openDatabase } = await import('../../src/db/index.js');
  const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
  const restarts = { count: 0 };
  const app = await buildApp({
    db,
    sseHeartbeatMs: config.sseHeartbeatMs,
    logger: false,
    tasksDir: config.tasksDir,
    localHome: config.localHome,
    onRestart: () => {
      restarts.count += 1;
    },
  });
  await app.listen({ host: config.host, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听端口');
  return {
    base: `http://${config.host}:${String(address.port)}`,
    work,
    home,
    repo,
    worktree,
    db,
    restarts,
    close: async () => {
      await app.close();
      db.$client.close();
    },
  };
}

export interface Process {
  id: number;
  kind: string;
  status: string;
}
export interface Event {
  kind: string;
  processId: number | null;
  payload: Record<string, unknown>;
}
export interface Detail {
  id: string;
  title: string;
  claudeSessionId: string | null;
  engine: string;
  purpose: string;
  environment: string;
  cwd: string;
  status: string;
  processes: Process[];
  events: Event[];
}
export interface MagiView {
  worktree: {
    path: string;
    branch: string;
    state: string;
    steps: { id: string; status: string; output: string | null }[];
    ahead: number | null;
    behind: number | null;
    uncommitted: number | null;
    startError: string | null;
  };
  current: { codex: string | null; claude: string | null };
  deploy: {
    id: number;
    status: string;
    error: string | null;
    commit: string | null;
    steps: { id: string; status: string; output: string | null }[];
  } | null;
}

export function client(base: string) {
  const request = async (method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await request(method, route, body);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${route} 返回 ${String(response.status)}：${text}`);
    }
    return JSON.parse(text) as T;
  };
  return { request, api };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 等到条件成立；超时时以说明报错
export async function until<T>(
  what: string,
  check: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${String(timeoutMs)} ms 内没有等到：${what}`);
    await sleep(100);
  }
}

// 终端的一次输入：经 PTY 的 WebSocket 写进进程
export async function typeInto(base: string, liveId: string, data: string) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/live/${liveId}/pty`);
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => {
      resolve();
    });
  });
  socket.send(JSON.stringify({ type: 'input', data }));
  await sleep(200);
  socket.close();
}
