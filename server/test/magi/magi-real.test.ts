import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { client, type Detail, type MagiApp, startMagiApp, typeInto, until } from './harness.js';

// Magi Agent 的真实档（Contracts 23.3、23.4）：真实的 Claude Code 与 Codex，用户自己的 ~/.claude 与 ~/.codex（本机配置）。
// 主仓库是 .work/ 下的测试仓库，worktree 建好之后把主仓库中的 MAGI.md 改成另一个标题（不提交，worktree 中没有它）：
// agent 答出这个标题，说明答案来自注入的说明。每种引擎问一次"MAGI.md 的第一个标题是什么"，结束后 resume，
// 再问"我上一条问了什么"，证明 resume 后仍在同一个 session。.work/ 在已信任的仓库目录下，Claude Code 不弹信任确认
const work = path.join(import.meta.dirname, '../../../.work/test-magi-real', randomUUID());
const HEADING = '青蛙-47 的注入说明';
vi.setConfig({ testTimeout: 300_000 });

let magi: MagiApp;
let api: ReturnType<typeof client>['api'];

beforeAll(async () => {
  magi = await startMagiApp(work, {
    WFD_LOCAL_HOME: os.homedir(),
    WFD_CLAUDE_BIN: 'claude',
    WFD_CODEX_BIN: 'codex',
    STAND_IN_ECHO_ARGV: '0',
  });
  ({ api } = client(magi.base));
});

afterAll(async () => {
  await magi.close();
  // 每一项的终端输出留在 .work/test-magi-real-logs/ 下，供报告与排查
  const live = path.join(work, 'data/live');
  const logs = logsDir;
  fs.mkdirSync(logs, { recursive: true });
  for (const id of fs.existsSync(live) ? fs.readdirSync(live) : []) {
    const log = path.join(live, id, 'pty.log');
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(logs, `${id}.log`));
  }
  fs.rmSync(work, { recursive: true, force: true });
});

const detail = (id: string) => api<Detail>('GET', `/api/live/${id}`);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 用户提交一条消息：先输入文字，稍等再回车（两个 TUI 都把一次到达的文字与回车当作粘贴）
async function ask(liveId: string, text: string) {
  await typeInto(magi.base, liveId, text);
  await sleep(800);
  await typeInto(magi.base, liveId, '\r');
}

const ClaudeLine = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) })
    .optional(),
});

// 最近一个进程的终端输出：pty.log 中每个进程开始时有一行 ──── 分隔
function latestOutput(liveId: string): string {
  const log = fs.readFileSync(path.join(work, 'data/live', liveId, 'pty.log'), 'utf8');
  return log.split('────').at(-1) ?? '';
}

// Claude Code：session（用户自己的 ~/.claude/projects 下）中这个问题之后 assistant 的文字
function claudeAnswer(_liveId: string, sessionId: string, question: string) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const file = fs
    .readdirSync(projects)
    .map((d) => path.join(projects, d, `${sessionId}.jsonl`))
    .find((f) => fs.existsSync(f));
  if (file === undefined) return Promise.resolve(null);
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => ClaudeLine.parse(JSON.parse(l)));
  const asked = lines.findLastIndex(
    (l) =>
      l.type === 'user' &&
      typeof l.message?.content === 'string' &&
      l.message.content.includes(question),
  );
  if (asked < 0) return Promise.resolve(null);
  const texts = lines
    .slice(asked + 1)
    .filter((l) => l.type === 'assistant')
    .flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content : []))
    .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []));
  return Promise.resolve(texts.length === 0 ? null : texts.join('\n'));
}

// Codex：codex-cli 0.162.0 的 rollout 只记会话的开头（history_mode 为 paginated，对话在它自己的数据库中），回答从终端读：
// 用 @xterm/headless 重现最近一个进程的屏幕，取这个问题之后、"Worked for"（这一轮结束）之前的文字
async function codexAnswer(liveId: string, _sessionId: string, question: string) {
  const terminal = new xtermHeadless.Terminal({
    cols: 120,
    rows: 40,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => {
    terminal.write(latestOutput(liveId), resolve);
  });
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, i) =>
    (buffer.getLine(i)?.translateToString(true) ?? '').trim(),
  );
  terminal.dispose();
  const asked = lines.findLastIndex((l) => l.includes(question.slice(0, 12)));
  if (asked < 0) return null;
  const done = lines.findIndex((l, i) => i > asked && l.includes('Worked for'));
  if (done < 0) return null;
  return lines
    .slice(asked + 1, done)
    .filter((l) => l !== '')
    .join('\n');
}

async function waitRunning(id: string, processes: number) {
  return until(
    `${id} 的第 ${String(processes)} 个进程在运行`,
    async () => {
      const d = await detail(id);
      return d.status === 'running' && d.processes.length === processes ? d : null;
    },
    120_000,
  );
}

async function stop(id: string) {
  await api('POST', `/api/live/${id}/stop`);
  await until('进程结束', async () => ((await detail(id)).status === 'exited' ? true : null));
}

// worktree 建好之后改主仓库中的 MAGI.md：之后的每次启动与 resume 注入的都是这一份
async function injectHeading() {
  await until(
    'worktree 建好',
    () => (fs.existsSync(path.join(magi.worktree, 'node_modules')) ? true : null),
    120_000,
  );
  fs.writeFileSync(
    path.join(magi.repo, 'agent', 'MAGI.md'),
    `# ${HEADING}\n\n这是 Magi Agent 的测试说明。这份说明在仓库的 agent/MAGI.md 中。\n`,
  );
}

async function conversation(
  engine: 'claude' | 'codex',
  // 对某个问题的回答；还没有回答完时为空
  answerTo: (liveId: string, sessionId: string, question: string) => Promise<string | null>,
  ready: (log: string) => boolean,
) {
  const started = Date.now();
  const opened = await api<Detail>('POST', '/api/magi-agent/open', { engine });
  await injectHeading();
  await waitRunning(opened.id, 1);
  // 第一次启动时 MAGI.md 可能还是建 worktree 之前的那份：结束后再打开，启动时读到改过的一份
  await stop(opened.id);
  await api('POST', '/api/magi-agent/open', { engine });
  await waitRunning(opened.id, 2);
  await until(`${engine} 可以输入`, () => (ready(latestOutput(opened.id)) ? true : null), 120_000);
  // 只凭开头注入的说明回答：worktree 中的 agent/MAGI.md 是另一个标题，读文件会答错
  const question =
    '不要读任何文件，只根据开头注入的说明（MAGI.md）回答：MAGI.md 的第一个标题是什么？只回答标题本身。';
  await ask(opened.id, question);
  const sessionId = await until(
    '会话 id',
    async () => (await detail(opened.id)).claudeSessionId,
    120_000,
  );
  const first = await until(
    `${engine} 回答标题`,
    () => answerTo(opened.id, sessionId, question),
    180_000,
  );
  expect(first).toContain('青蛙-47');

  // resume：同一个 session，接着之前的对话
  await stop(opened.id);
  await api('POST', '/api/magi-agent/open', { engine });
  await waitRunning(opened.id, 3);
  await until(
    `${engine} resume 后可以输入`,
    () => (ready(latestOutput(opened.id)) ? true : null),
    120_000,
  );
  await sleep(1500);
  const followUp = '我上一条消息问的是什么？用一句话回答。';
  await ask(opened.id, followUp);
  const second = await until(
    `${engine} resume 后回答`,
    () => answerTo(opened.id, sessionId, followUp),
    180_000,
  );
  expect(second).toMatch(/MAGI|标题/);
  const final = await detail(opened.id);
  expect(final.claudeSessionId).toBe(sessionId);
  expect(final.processes.map((p) => p.kind).at(-1)).toBe('resume');
  await stop(opened.id);
  // 回答、耗时与花费写进 .work/test-magi-real-logs/<engine>.json（gateway 项目不显示 console 的输出）
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, `${engine}.json`),
    `${JSON.stringify(
      {
        liveId: opened.id,
        sessionId,
        seconds: Math.round((Date.now() - started) / 1000),
        first,
        afterResume: second,
        usage: engine === 'claude' ? await claudeUsage(sessionId) : null,
      },
      null,
      2,
    )}\n`,
  );
}

const logsDir = path.join(import.meta.dirname, '../../../.work/test-magi-real-logs');

// 花费：Claude Code 的 session 导入后按请求的 usage 与模型价格相加。Codex 用用户自己的账号，codex-cli 0.162 的 rollout
// 与终端中都没有 token 数，只记耗时。导入与表定义在 harness 设置环境变量之后动态导入
async function claudeUsage(sessionId: string): Promise<Record<string, unknown>> {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const file = fs
    .readdirSync(projects)
    .map((d) => path.join(projects, d, `${sessionId}.jsonl`))
    .find((f) => fs.existsSync(f));
  if (file === undefined) throw new Error(`没有找到 session ${sessionId}`);
  const { ingestFile } = await import('../../src/ingest/ingest.js');
  const { requests } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  ingestFile(magi.db, file);
  const rows = magi.db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
  return {
    requests: rows.length,
    costUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

test('Claude Code：答出注入的 MAGI.md 的第一个标题，resume 后仍在同一个 session', async () => {
  await conversation('claude', claudeAnswer, (log) => log.includes('bypass permissions'));
});

test('Codex：答出注入的 MAGI.md 的第一个标题，resume 后仍在同一个 session', async () => {
  await conversation('codex', codexAnswer, (log) => log.includes('Ask Codex'));
});
