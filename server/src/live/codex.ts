import fs from 'node:fs';
import path from 'node:path';
import { stringify } from '@decimalturn/toml-patch';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { liveEvents, type LiveEventKind, liveProcesses, liveSessions } from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import type { LivePty } from './pty.js';

// Codex 会话（Contracts 17.3，codex-cli 0.162.0 实测，Reports/W42）：cwd 为草稿目录，CODEX_HOME 与 HOME 都是
// 草稿自己的目录；沙箱是 Codex 自己的 workspace-write（只能写 cwd）加网络

export function codexDirsOf(cwd: string) {
  return { codexHome: path.join(cwd, 'codex-home'), home: path.join(cwd, 'home') };
}

const SANDBOX_ARGS = [
  '--no-daemon',
  '-s',
  'workspace-write',
  '-c',
  'sandbox_workspace_write.network_access=true',
];

export const codexStartArgs = (prompt: string) => [...SANDBOX_ARGS, prompt];
export const codexResumeArgs = (sessionId: string) => ['resume', ...SANDBOX_ARGS, sessionId];

// Magi Agent 的 Codex（Contracts 23.3，codex-cli 0.162.0 实测，Reports/W60）：用户自己的 ~/.codex，不开沙箱；
// worktree 的信任只认整张 projects 表的写法（projects."<路径>".trust_level 不起作用），不改 config.toml；
// MAGI.md 作为 developer_instructions 传入；不在启动时检查更新（用户的配置默认检查，会在终端中自行 npm install -g）。
// message 为空时不带初始消息，用户在终端中输入第一条
function agentArgs(cwd: string, instructions: string): string[] {
  return [
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    stringify({ projects: { [cwd]: { trust_level: 'trusted' } } }, { inlineTableStart: 0 }).trim(),
    '-c',
    stringify({ developer_instructions: instructions }).trim(),
  ];
}

export function codexAgentStartArgs(cwd: string, instructions: string, message: string | null) {
  return [...agentArgs(cwd, instructions), ...(message === null ? [] : [message])];
}

export function codexAgentResumeArgs(
  cwd: string,
  instructions: string,
  sessionId: string,
  message: string | null,
) {
  return [
    'resume',
    ...agentArgs(cwd, instructions),
    sessionId,
    ...(message === null ? [] : [message]),
  ];
}

// writeCodexHome 另写的键：草稿目录记为已信任（-c 覆盖不起作用，只认 config.toml）、不检查更新、
// 关掉 Codex 自带的同名 skill-creator 等 bundled skill（只用 .agents/skills/ 中装的）
export function codexConfigExtra(cwd: string): Record<string, unknown> {
  return {
    check_for_update_on_startup: false,
    projects: { [cwd]: { trust_level: 'trusted' } },
    skills: { bundled: { enabled: false } },
  };
}

// rollout 文件的第一行
const SessionMeta = z.looseObject({
  type: z.literal('session_meta'),
  payload: z.looseObject({ id: z.string().min(1), cwd: z.string() }),
});

// CODEX_HOME/sessions 下全部 rollout 文件
export function rolloutFiles(codexHome: string): string[] {
  const dir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
    .map((e) => path.join(e.parentPath, e.name));
}

// 不在 known 中、cwd 为这个目录的 rollout 的会话 id；还没有写出第一行时为空
export function newSessionId(codexHome: string, cwd: string, known: Set<string>): string | null {
  const real = fs.realpathSync(cwd);
  for (const file of rolloutFiles(codexHome)) {
    if (known.has(file)) continue;
    const first = fs.readFileSync(file, 'utf8').split('\n')[0] ?? '';
    if (first.trim() === '') continue;
    const meta = SessionMeta.parse(JSON.parse(first));
    // 用户自己的 ~/.codex 中也有别处的会话，它们的 cwd 可能已经不在
    if (fs.existsSync(meta.payload.cwd) && fs.realpathSync(meta.payload.cwd) === real) {
      return meta.payload.id;
    }
  }
  return null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 提交初始消息后 Codex 才写出 rollout：等它出现。进程先退出或超时时停掉进程，以屏幕内容报错
export async function waitForSession(
  pty: LivePty,
  codexHome: string,
  cwd: string,
  known: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (pty.alive && Date.now() < deadline) {
    const id = newSessionId(codexHome, cwd, known);
    if (id !== null) return id;
    await sleep(200);
  }
  const screen = (await pty.viewport()).filter((l) => l.trim() !== '').join('\n');
  const exitedEarly = !pty.alive;
  pty.kill('SIGHUP');
  await pty.exited;
  throw new HttpError(
    500,
    `Codex 在 ${String(timeoutMs / 1000)} 秒内没有写出会话记录（${path.join(codexHome, 'sessions')}）${exitedEarly ? '，进程已退出' : ''}；屏幕：\n${screen}`,
  );
}

// 一个运行中的 Codex 进程：只有人驾驶，没有 hook 与模拟用户；终端输入原样写进 PTY
export class CodexRunner {
  readonly engine = 'codex';
  readonly starting = false;
  readonly waiting = null;
  readonly driver = 'human';
  readonly exited: Promise<void>;

  constructor(
    private readonly db: Db,
    readonly liveId: string,
    readonly processId: number,
    readonly pty: LivePty,
  ) {
    this.exited = this.pty.exited.then((exit) => {
      const endedAt = new Date();
      this.db
        .update(liveProcesses)
        .set({ status: 'exited', exitCode: exit.exitCode, endedAt })
        .where(eq(liveProcesses.id, this.processId))
        .run();
      this.db
        .update(liveSessions)
        .set({ updatedAt: endedAt })
        .where(eq(liveSessions.id, this.liveId))
        .run();
      this.event('exit', { exitCode: exit.exitCode, signal: exit.signal });
    });
  }

  private event(kind: LiveEventKind, payload: Record<string, unknown>) {
    this.db
      .insert(liveEvents)
      .values({ liveId: this.liveId, processId: this.processId, at: new Date(), kind, payload })
      .run();
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  input(data: string) {
    this.pty.write(data);
  }

  async shutdown() {
    this.pty.kill('SIGHUP');
    await this.exited;
  }
}
