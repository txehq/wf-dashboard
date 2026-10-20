import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../../src/config.js';
import { sessions } from '../../src/db/schema.js';
import type { LiveDetail } from '../../src/live/views.js';
import { hookNames, type LiveServer, startLiveServer, until } from './harness.js';

// Contracts 29.2 的真实档：本机配置（用户自己的 ~/.claude）、不加命令，真实的 claude 与 PTY。
// real 环境（.work/ 下的空目录）与 isolated 环境（sandbox 中，读写 ~/.claude）各启动一次，输入同一句"只回答 ok"：
// session 中第一条用户消息就是这句原文、没有 slash 命令，agent 回答之后结束进程。每次的耗时与花费写进 .work/w90/
const work = path.join(config.repoRoot, '.work', 'w90', 'real', randomUUID());
const results = path.join(config.repoRoot, '.work', 'w90', 'real-results.jsonl');
const INPUT = '只回答 ok';

const Line = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({
      content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
    })
    .optional(),
});

let server: LiveServer;

beforeAll(async () => {
  fs.mkdirSync(path.join(work, 'cwd'), { recursive: true });
  server = await startLiveServer({ localHome: os.homedir(), claudeBin: 'claude' });
}, 600_000);

afterAll(async () => {
  await server.close();
  fs.rmSync(work, { recursive: true, force: true });
});

// 主 agent 的记录：第一条用户消息与之后 assistant 的文字
function conversation(file: string) {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Line.parse(JSON.parse(l)));
  const firstUser = lines.find((l) => l.type === 'user' && typeof l.message?.content === 'string')
    ?.message?.content;
  const answer = lines
    .filter((l) => l.type === 'assistant')
    .flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content : []))
    .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
    .join('\n');
  return { firstUser, answer };
}

async function runOnce(environment: 'real' | 'isolated') {
  const startedAt = Date.now();
  const created = await server.api<LiveDetail>('POST', '/api/live', {
    workflow: null,
    variantId: null,
    input: INPUT,
    environment,
    cwd: environment === 'real' ? path.join(work, 'cwd') : null,
    driver: 'human',
  });
  const sessionId = created.claudeSessionId;
  if (sessionId === null) throw new Error(`交互 ${created.id} 没有 session id`);
  // agent 答完一轮（Stop hook），dashboard 已按 SessionStart 报告的位置导入了 session
  const file = await until(`${environment} 环境中 agent 答完一轮`, 240_000, async () => {
    const d = await server.detail(created.id);
    if (d.status === 'exited') {
      throw new Error(`进程提前退出：${String(d.process?.exitCode)} ${String(d.error)}`);
    }
    if (!hookNames(d).includes('Stop')) return null;
    const imported = server.db
      .select({ filePath: sessions.filePath })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return imported !== undefined && conversation(imported.filePath).answer !== ''
      ? imported.filePath
      : null;
  });
  const talk = conversation(file);
  await server.api('POST', `/api/live/${created.id}/stop`);
  const done = await until('进程结束', 60_000, async () => {
    const d = await server.detail(created.id);
    return d.status === 'exited' ? d : null;
  });
  const seconds = (Date.now() - startedAt) / 1000;
  const session = await server.api<{ costUsd: number; priced: boolean }>(
    'GET',
    `/api/sessions/${sessionId}`,
  );
  fs.appendFileSync(
    results,
    `${JSON.stringify({ environment, liveId: created.id, sessionId, seconds, costUsd: session.costUsd, priced: session.priced, answer: talk.answer })}\n`,
  );
  return { created, done, talk };
}

test(
  'real 环境：第一条用户消息就是输入原文，agent 回答 ok，进程结束',
  { timeout: 420_000 },
  async () => {
    const { done, talk } = await runOnce('real');
    expect(talk.firstUser).toBe(INPUT);
    expect(talk.answer.toLowerCase()).toContain('ok');
    expect(done.events.find((e) => e.kind === 'start')?.payload.sandboxed).toBe(false);
    expect(done.variantName).toBeNull();
    expect(done.workflow).toBeNull();
  },
);

test(
  'isolated 环境：本机配置的进程在 sandbox 中，读到凭据、写出 session 并回答',
  { timeout: 420_000 },
  async () => {
    const { done, talk } = await runOnce('isolated');
    expect(talk.firstUser).toBe(INPUT);
    expect(talk.answer.toLowerCase()).toContain('ok');
    // dashboard 的 hook 从 sandbox 中照常 POST 回来
    expect(hookNames(done)).toEqual(expect.arrayContaining(['SessionStart', 'Stop']));
    expect(done.events.find((e) => e.kind === 'start')?.payload.sandboxed).toBe(true);
    expect(done.cwd).toBe(path.join(config.liveDir, done.id, 'workspace'));
    // 用户自己的 hook（wf hook …）在 sandbox 中照常运行：终端中没有 hook error（Claude Code 按光标移动画出，空白不一定在）
    const screen = fs.readFileSync(path.join(config.liveDir, done.id, 'pty.log'), 'utf8');
    expect(screen.replace(/\s/g, '').toLowerCase()).not.toContain('hookerror');
  },
);
