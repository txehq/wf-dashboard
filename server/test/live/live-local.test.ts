import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { liveProcesses, sessions } from '../../src/db/schema.js';
import type { LiveDetail, LocalEntries } from '../../src/live/views.js';
import { sessionLines } from '../helpers/session-copies.js';
import { type LiveServer, startLiveServer, until } from './harness.js';

// Contracts 29.2：配置为本机配置或 variant，初始命令为入口命令或不加命令。claude 换成回显参数与配置 env 的替身
// （STAND_IN_ECHO_ARGV），isolated 环境中 sandbox 读不到仓库中的替身，进程立即失败，只看启动参数与记录。
// 绑定：进程运行时把一份 session 写到它的 jsonl 位置，结束进程后看 session 绑定到哪个 variant
const work = path.join(config.repoRoot, '.work/w90/live-local', randomUUID());
const cwd = path.join(work, 'cwd');
const home = path.join(work, 'home');
const standIn = path.join(import.meta.dirname, '../fixtures/live/claude-stand-in.mjs');

let server: LiveServer;

beforeAll(async () => {
  process.env.STAND_IN_ECHO_ARGV = '1';
  fs.mkdirSync(cwd, { recursive: true });
  // 本机装着 lfg 的入口 skill，没有 ic 的
  const skill = path.join(home, '.claude', 'skills', 'lfg', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: lfg\n---\n');
  server = await startLiveServer({ localHome: home, claudeBin: standIn });
}, 600_000);

afterAll(async () => {
  await server.close();
  fs.rmSync(work, { recursive: true, force: true });
  delete process.env.STAND_IN_ECHO_ARGV;
});

const create = (body: Record<string, unknown>) =>
  server.api<LiveDetail>('POST', '/api/live', {
    environment: 'real',
    cwd,
    driver: 'human',
    ...body,
  });

const startOf = (d: LiveDetail) => {
  const start = d.events.find((e) => e.kind === 'start')?.payload;
  if (start === undefined) throw new Error(`交互 ${d.id} 没有 start 事件`);
  return start as { initial: string; argv: string[]; sandboxed: boolean; configDir: string | null };
};

// 替身打印的一行 `<前缀> <json>`
async function echoed(liveId: string, prefix: string): Promise<unknown> {
  const log = path.join(config.liveDir, liveId, 'pty.log');
  return until(`替身输出 ${prefix}`, 30_000, () => {
    const line = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${prefix} `));
    return line === undefined ? null : (JSON.parse(line.slice(prefix.length + 1)) as unknown);
  });
}

// 进程运行时把 session 写到 configDir 的 projects/<dirName>/ 中，以 SessionStart hook 报告这个位置（与真实的
// Claude Code 相同：本机配置时 session 写在 cwd 对应的目录，不是 projects/<liveId>/），结束进程后返回 session 的绑定
async function bindingAfterStop(d: LiveDetail, configDir: string, dirName: string) {
  const sessionId = d.claudeSessionId;
  if (sessionId === null) throw new Error(`交互 ${d.id} 没有 session id`);
  const file = path.join(configDir, 'projects', dirName, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sessionLines(sessionId, cwd));
  await server.api('POST', `/api/live/${d.id}/hook`, {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    transcript_path: file,
    source: 'startup',
  });
  await server.api('POST', `/api/live/${d.id}/stop`);
  await until('进程退出', 30_000, async () =>
    (await server.detail(d.id)).status === 'exited' ? true : null,
  );
  return server.db
    .select({
      variantId: sessions.variantId,
      binding: sessions.variantBinding,
      filePath: sessions.filePath,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
}

const processOf = (liveId: string) =>
  server.db
    .select({
      variantId: liveProcesses.variantId,
      model: liveProcesses.model,
      effort: liveProcesses.effort,
    })
    .from(liveProcesses)
    .where(eq(liveProcesses.liveId, liveId))
    .all();

test('本机配置可选的入口命令：~/.claude/skills/<入口 skill>/SKILL.md 存在的 workflow', async () => {
  expect(await server.api<LocalEntries>('GET', '/api/live/local-entries')).toEqual({
    workflows: ['lfg'],
  });
});

test('本机配置、不加命令、real：初始消息就是输入原文（多行保留），不设 CLAUDE_CONFIG_DIR，不传 model，不绑定 variant', async () => {
  const input = '第一行\n  第二行：/lfg 不是命令\n第三行';
  const d = await create({ workflow: null, variantId: null, input });
  expect(d.workflow).toBeNull();
  expect(d.input).toBe(input);
  expect(d.variantName).toBeNull();
  expect(d.title).toBe('第一行');
  const start = startOf(d);
  expect(start.initial).toBe(input);
  // 位置参数原样传给 claude
  expect(start.argv.at(-1)).toBe(input);
  expect(start.argv).not.toContain('--model');
  expect(start.argv).not.toContain('--effort');
  expect(start.sandboxed).toBe(false);
  expect(start.configDir).toBeNull();
  expect(processOf(d.id)).toEqual([{ variantId: null, model: null, effort: null }]);
  expect((await echoed(d.id, 'argv')) as string[]).toContain(input);
  // [CLAUDE_CONFIG_DIR, WF_HOME, HOME]
  expect(await echoed(d.id, 'config')).toEqual([null, null, home]);
  const slug = '-cwd-slug';
  expect(await bindingAfterStop(d, path.join(home, '.claude'), slug)).toEqual({
    variantId: null,
    binding: null,
    filePath: path.join(home, '.claude', 'projects', slug, `${String(d.claudeSessionId)}.jsonl`),
  });
});

test('variant、不加命令：初始消息是输入原文，用 variant 的配置与 model，绑定这个 variant', async () => {
  const d = await create({ workflow: null, variantId: server.variant.id, input: '只回答 ok' });
  expect(d.workflow).toBeNull();
  expect(d.variantId).toBe(server.variant.id);
  const start = startOf(d);
  expect(start.initial).toBe('只回答 ok');
  expect(start.argv.at(-1)).toBe('只回答 ok');
  expect(start.argv).toEqual(expect.arrayContaining(['--model', '--effort']));
  const configDir = server.variants.runtimeEnv(server.variant.id).env.CLAUDE_CONFIG_DIR;
  expect(start.configDir).toBe(configDir);
  expect(((await echoed(d.id, 'config')) as unknown[])[0]).toBe(configDir);
  expect(await bindingAfterStop(d, configDir, d.id)).toMatchObject({
    variantId: server.variant.id,
    binding: 'run',
  });
});

test('variant 与入口命令、本机配置与本机装着的入口命令：初始消息 /<入口> <输入>', async () => {
  const withVariant = await create({
    workflow: 'lfg',
    variantId: server.variant.id,
    input: '做一个计算器',
  });
  expect(withVariant.workflow).toBe('lfg');
  expect(startOf(withVariant).initial).toBe('/lfg 做一个计算器');
  expect(startOf(withVariant).argv.at(-1)).toBe('/lfg 做一个计算器');
  await server.api('POST', `/api/live/${withVariant.id}/stop`);

  const local = await create({ workflow: 'lfg', variantId: null, input: '做一个计算器' });
  expect(local.workflow).toBe('lfg');
  expect(local.variantId).toBeNull();
  expect(startOf(local).initial).toBe('/lfg 做一个计算器');
  expect(await echoed(local.id, 'config')).toEqual([null, null, home]);
  await server.api('POST', `/api/live/${local.id}/stop`);
});

test('workflow 与配置不匹配时 400 原文', async () => {
  const notInstalled = await server.request('POST', '/api/live', {
    workflow: 'ic',
    variantId: null,
    input: 'TXE-3777',
    environment: 'real',
    cwd,
    driver: 'human',
  });
  expect(notInstalled.status).toBe(400);
  expect(JSON.parse(notInstalled.text)).toMatchObject({
    message: `本机配置中没有 workflow ic 的入口 skill：${path.join(home, '.claude', 'skills', 'ic', 'SKILL.md')} 不存在`,
  });
  const otherWorkflow = await server.request('POST', '/api/live', {
    workflow: 'ic',
    variantId: server.variant.id,
    input: 'TXE-3777',
    environment: 'real',
    cwd,
    driver: 'human',
  });
  expect(otherWorkflow.status).toBe(400);
  expect(JSON.parse(otherWorkflow.text)).toMatchObject({
    message: `variant ${server.variant.name} 属于 workflow lfg，不是 ic 的 variant`,
  });
});

test('本机配置、不加命令、isolated：只建空的 workspace，进程在 sandbox 中', async () => {
  const d = await create({
    workflow: null,
    variantId: null,
    input: '只回答 ok',
    environment: 'isolated',
    cwd: null,
  });
  const start = startOf(d);
  expect(start.initial).toBe('只回答 ok');
  expect(start.sandboxed).toBe(true);
  expect(d.repo).toBeNull();
  expect(d.cwd).toBe(path.join(config.liveDir, d.id, 'workspace'));
  expect(fs.readdirSync(d.cwd)).toEqual([]);
});
