import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { git, MAGI_TEXT } from '../helpers/magi-repo.js';
import {
  client,
  type Detail,
  type MagiApp,
  type MagiView,
  sleep,
  startMagiApp,
  typeInto,
  until,
} from './harness.js';

// Magi Agent 的打开、resume、新会话与旧会话（Contracts 23.1–23.4），基础档：真实的服务与 git、pnpm，
// worktree 建在测试自己的本地仓库上；Claude Code 与 Codex 是回显参数的替身命令，HOME 在 .work/ 下
const work = path.join(import.meta.dirname, '../../../.work/test-magi-agent', randomUUID());
// 每个用例依次启动、结束多个进程，还有真实的 git 与 pnpm install
vi.setConfig({ testTimeout: 30_000 });
let magi: MagiApp;
let api: ReturnType<typeof client>['api'];
let request: ReturnType<typeof client>['request'];

beforeAll(async () => {
  magi = await startMagiApp(work);
  ({ api, request } = client(magi.base));
});

afterAll(async () => {
  await magi.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const detail = (id: string) => api<Detail>('GET', `/api/live/${id}`);
const view = () => api<MagiView>('GET', '/api/magi-agent');
const ptyLog = (id: string) => fs.readFileSync(path.join(work, 'data/live', id, 'pty.log'), 'utf8');
const lastArgv = (d: Detail) => {
  const start = d.events.findLast((e) => e.kind === 'start' || e.kind === 'resume');
  return start?.payload.argv as string[];
};

async function running(id: string, processes: number): Promise<Detail> {
  return until(`${id} 有 ${String(processes)} 个进程且在运行`, async () => {
    const d = await detail(id);
    return d.status === 'running' && d.processes.length === processes ? d : null;
  });
}

async function stop(id: string) {
  await api('POST', `/api/live/${id}/stop`);
  await until(`${id} 结束`, async () => ((await detail(id)).status === 'exited' ? true : null));
}

const trust = (cwd: string) => `projects = { "${cwd}" = { trust_level = "trusted" } }`;
const instructions = (text: string) => `developer_instructions = ${JSON.stringify(text)}`;

test('第一次打开 Codex：从 main 建 magi-agent 分支的 worktree、pnpm install，然后用本机配置启动并注入 MAGI.md', async () => {
  const opened = await api<Detail>('POST', '/api/magi-agent/open', { engine: 'codex' });
  expect(opened).toMatchObject({
    purpose: 'agent',
    engine: 'codex',
    environment: 'real',
    cwd: magi.worktree,
    claudeSessionId: null,
  });
  const started = await running(opened.id, 1);
  const state = await view();
  expect(state.worktree).toMatchObject({
    state: 'ready',
    branch: 'magi-agent',
    ahead: 0,
    behind: 0,
  });
  expect(state.worktree.steps.map((s) => s.status)).toEqual(['done', 'done']);
  expect(state.current).toEqual({ codex: opened.id, claude: null });
  expect(await git(magi.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('magi-agent');
  expect(await git(magi.worktree, 'rev-parse', 'HEAD')).toBe(
    await git(magi.repo, 'rev-parse', 'main'),
  );
  expect(fs.existsSync(path.join(magi.worktree, 'node_modules'))).toBe(true);
  // 不开沙箱、整张 projects 表记 worktree 为已信任、MAGI.md 作为 developer_instructions；没有初始消息
  expect(lastArgv(started).slice(1)).toEqual([
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    trust(magi.worktree),
    '-c',
    instructions(MAGI_TEXT),
  ]);

  // 用户提交第一条消息后 Codex 才写出 rollout（在用户自己的 ~/.codex 中，即 HOME 下），之后记下会话 id
  // 替身写出 cwd 一行之后才进入 raw 模式接收按键
  await until('Codex 替身启动', () => (ptyLog(opened.id).includes('cwd:') ? true : null));
  await typeInto(magi.base, opened.id, 'MAGI.md 的第一个标题是什么\r');
  const withSession = await until('记下 Codex 的会话 id', async () => {
    const d = await detail(opened.id);
    return d.claudeSessionId === null ? null : d;
  });
  const sessions = path.join(magi.home, '.codex', 'sessions');
  const rollout = fs
    .readdirSync(sessions, { recursive: true })
    .map(String)
    .find((f) => f.endsWith(`${String(withSession.claudeSessionId)}.jsonl`));
  expect(rollout).toBeDefined();
  const meta = JSON.parse(
    fs.readFileSync(path.join(sessions, String(rollout)), 'utf8').split('\n')[0] ?? '',
  ) as { payload: { cwd: string; argv: string[] } };
  expect(meta.payload.cwd).toBe(magi.worktree);
  expect(meta.payload.argv).toContain(instructions(MAGI_TEXT));

  // 运行中再打开：同一项，不起新进程
  const again = await api<Detail>('POST', '/api/magi-agent/open', { engine: 'codex' });
  expect(again.id).toBe(opened.id);
  expect(again.processes).toHaveLength(1);

  // 结束后打开：resume 同一个会话，参数相同；MAGI.md 每次从主仓库读取
  await stop(opened.id);
  const changed = `${MAGI_TEXT}\n第二版。\n`;
  fs.writeFileSync(path.join(magi.repo, 'agent', 'MAGI.md'), changed);
  await api('POST', '/api/magi-agent/open', { engine: 'codex' });
  const resumed = await running(opened.id, 2);
  expect(resumed.processes[1]?.kind).toBe('resume');
  expect(lastArgv(resumed).slice(1)).toEqual([
    'resume',
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    trust(magi.worktree),
    '-c',
    instructions(changed),
    String(withSession.claudeSessionId),
  ]);
  expect(ptyLog(opened.id)).toContain(`会话 ${String(withSession.claudeSessionId)}`);
  await stop(opened.id);
  fs.writeFileSync(path.join(magi.repo, 'agent', 'MAGI.md'), MAGI_TEXT);
});

test('新会话记为当前，之前的会话留在 Live 列表中，可以 resume 与删除；删除当前会话后打开时新建', async () => {
  const before = (await view()).current.codex;
  if (before === null) throw new Error('上一个用例没有留下当前会话');
  const fresh = await api<Detail>('POST', '/api/magi-agent/new', { engine: 'codex' });
  expect(fresh.id).not.toBe(before);
  await running(fresh.id, 1);
  expect((await view()).current.codex).toBe(fresh.id);
  const list = await api<Detail[]>('GET', '/api/live');
  expect(list.filter((l) => l.purpose === 'agent').map((l) => l.id)).toEqual(
    expect.arrayContaining([before, fresh.id]),
  );

  // 旧会话：从 Magi Agent resume，同样注入 MAGI.md
  const old = await api<Detail>('POST', `/api/magi-agent/${before}/resume`);
  expect(old.id).toBe(before);
  const resumedOld = await running(before, 3);
  expect(lastArgv(resumedOld)).toContain(instructions(MAGI_TEXT));
  await stop(before);
  const removed = await request('DELETE', `/api/live/${before}`, {
    confirmTitle: resumedOld.title,
  });
  expect(removed.status).toBe(200);

  // 驾驶者只有人
  const driver = await request('POST', `/api/live/${fresh.id}/driver`, { driver: 'simulated' });
  expect(driver.status).toBe(409);
  expect(await driver.text()).toContain('只有人驾驶');

  // 当前会话被删除：下次打开时新建一个并记为当前
  await stop(fresh.id);
  const freshDetail = await detail(fresh.id);
  await api('DELETE', `/api/live/${fresh.id}`, { confirmTitle: freshDetail.title });
  expect((await view()).current.codex).toBeNull();
  const recreated = await api<Detail>('POST', '/api/magi-agent/open', { engine: 'codex' });
  expect(recreated.id).not.toBe(fresh.id);
  await running(recreated.id, 1);
  expect((await view()).current.codex).toBe(recreated.id);
  await stop(recreated.id);
});

test('Claude Code：--append-system-prompt 注入 MAGI.md 与 --session-id；有对话记录后打开时 --resume 同一个 session', async () => {
  const opened = await api<Detail>('POST', '/api/magi-agent/open', { engine: 'claude' });
  expect(opened).toMatchObject({ purpose: 'agent', engine: 'claude', cwd: magi.worktree });
  const sessionId = opened.claudeSessionId;
  if (sessionId === null) throw new Error('Claude Code 的会话 id 应在建项时定下');
  const started = await running(opened.id, 1);
  const hooks = path.join(work, 'data/live', opened.id, 'hooks.json');
  expect(lastArgv(started).slice(1)).toEqual([
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    hooks,
    '--append-system-prompt',
    MAGI_TEXT,
    '--session-id',
    sessionId,
  ]);
  // 替身回显的参数与 agent 部署时用的两个环境变量
  await until('替身回显参数', () => (ptyLog(opened.id).includes('argv') ? true : null));
  expect(ptyLog(opened.id)).toContain(`magi ${JSON.stringify([opened.id, magi.base])}`);
  expect((await view()).current).toMatchObject({ claude: opened.id });

  // 还没有对话记录（没有提交过消息）：以同一个会话 id 重新启动
  await stop(opened.id);
  await api('POST', '/api/magi-agent/open', { engine: 'claude' });
  const restarted = await running(opened.id, 2);
  expect(restarted.processes[1]?.kind).toBe('start');
  expect(lastArgv(restarted)).toContain('--session-id');

  // 有了对话记录（用户自己的 ~/.claude/projects 下）：resume
  await stop(opened.id);
  const jsonl = path.join(magi.home, '.claude/projects', opened.id, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, '');
  await api('POST', '/api/magi-agent/open', { engine: 'claude' });
  const resumed = await running(opened.id, 3);
  expect(resumed.processes[2]?.kind).toBe('resume');
  expect(lastArgv(resumed).slice(1)).toEqual([
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    hooks,
    '--resume',
    sessionId,
    '--append-system-prompt',
    MAGI_TEXT,
  ]);
  await stop(opened.id);
});

test('头部的分支状态：相对 main 领先与落后的 commit 数、未提交的文件数', async () => {
  fs.writeFileSync(path.join(magi.worktree, 'agent-change.md'), '改动\n');
  await sleep(10);
  expect((await view()).worktree).toMatchObject({ ahead: 0, behind: 0, uncommitted: 1 });
  await git(magi.worktree, 'add', '.');
  await git(magi.worktree, 'commit', '-q', '-m', 'agent 的改动');
  fs.writeFileSync(path.join(magi.repo, 'main-change.md'), 'main 上的改动\n');
  await git(magi.repo, 'add', 'main-change.md');
  await git(magi.repo, 'commit', '-q', '-m', 'main 的改动');
  expect((await view()).worktree).toMatchObject({ ahead: 1, behind: 1, uncommitted: 0 });
});

test('分支 magi-agent 已存在时（worktree 被删除后）用已有的分支建 worktree', async () => {
  const { runWorktreeStep } = await import('../../src/magi-agent/git.js');
  const other = path.join(work, 'second-worktree');
  const branchHead = await git(magi.repo, 'rev-parse', 'magi-agent');
  const result = await runWorktreeStep('worktree', magi.repo, other);
  // 同一个分支已经在 magi.worktree 中检出，git 以原文拒绝
  expect(result.ok).toBe(false);
  expect(result.output).toContain('magi-agent');
  await git(magi.repo, 'worktree', 'remove', '--force', magi.worktree);
  const reused = await runWorktreeStep('worktree', magi.repo, other);
  expect(reused.ok).toBe(true);
  expect(await git(other, 'rev-parse', 'HEAD')).toBe(branchHead);
  expect(await git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('magi-agent');
});
