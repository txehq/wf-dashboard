import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { git, MAGI_TEXT } from '../helpers/magi-repo.js';
import { sessionLines } from '../helpers/session-copies.js';
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
// 等到 pty.log 中出现 text 后返回它的内容：进程开始后写入流才异步建出这个文件，替身的每一行分别写入
const ptyLogWith = (id: string, text: string, times = 1) =>
  until(`pty.log 中出现 ${String(times)} 次 ${text}`, () => {
    const file = path.join(work, 'data/live', id, 'pty.log');
    if (!fs.existsSync(file)) return null;
    const log = fs.readFileSync(file, 'utf8');
    return log.split(text).length > times ? log : null;
  });
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
// 弹出框的"打开"：liveId 为空时新建
const open = (engine: string, config: string, liveId: string | null) =>
  api<Detail>('POST', '/api/magi-agent/open', { engine, config, liveId });

test('第一次打开 Codex：从 main 建 magi-agent 分支的 worktree、pnpm install，然后用本机配置启动并注入 MAGI.md', async () => {
  const opened = await open('codex', 'local', null);
  expect(opened).toMatchObject({
    purpose: 'agent',
    engine: 'codex',
    agentConfig: 'local',
    agentConfigName: '本机配置',
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
  expect(state.sessions).toEqual([
    {
      id: opened.id,
      title: '新会话',
      engine: 'codex',
      config: 'local',
      updatedAt: expect.any(Number) as number,
      running: true,
    },
  ]);
  expect(await git(magi.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('magi-agent');
  expect(await git(magi.worktree, 'rev-parse', 'HEAD')).toBe(
    await git(magi.repo, 'rev-parse', 'main'),
  );
  expect(fs.existsSync(path.join(magi.worktree, 'node_modules'))).toBe(true);
  // 不开沙箱、不检查更新、整张 projects 表记 worktree 为已信任、MAGI.md 作为 developer_instructions；没有初始消息
  expect(lastArgv(started).slice(1)).toEqual([
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    trust(magi.worktree),
    '-c',
    instructions(MAGI_TEXT),
  ]);

  // 用户提交第一条消息后 Codex 才写出 rollout（在用户自己的 ~/.codex 中，即 HOME 下），之后记下会话 id
  // 替身写出 cwd 一行之后才进入 raw 模式接收按键
  await ptyLogWith(opened.id, 'cwd:');
  await typeInto(magi.base, opened.id, 'MAGI.md 的第一个标题是什么\r');
  const withSession = await until('记下 Codex 的会话 id', async () => {
    const d = await detail(opened.id);
    return d.claudeSessionId === null ? null : d;
  });
  // 以用户的第一条消息命名（rollout 中的 UserMessage）
  await until('以第一条消息命名', async () =>
    (await detail(opened.id)).title === 'MAGI.md 的第一个标题是什么' ? true : null,
  );
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

  // 运行中再打开这个会话：同一项，不起新进程
  const again = await open('codex', 'local', opened.id);
  expect(again.id).toBe(opened.id);
  expect(again.processes).toHaveLength(1);

  // 结束后打开：resume 同一个会话，参数相同；MAGI.md 每次从主仓库读取
  await stop(opened.id);
  const changed = `${MAGI_TEXT}\n第二版。\n`;
  fs.writeFileSync(path.join(magi.repo, 'agent', 'MAGI.md'), changed);
  await open('codex', 'local', opened.id);
  const resumed = await running(opened.id, 2);
  expect(resumed.processes[1]?.kind).toBe('resume');
  expect(lastArgv(resumed).slice(1)).toEqual([
    'resume',
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    trust(magi.worktree),
    '-c',
    instructions(changed),
    String(withSession.claudeSessionId),
  ]);
  // 开始时与 resume 后的替身各打出一次这个会话
  await ptyLogWith(opened.id, `会话 ${String(withSession.claudeSessionId)}`, 2);
  await stop(opened.id);
  fs.writeFileSync(path.join(magi.repo, 'agent', 'MAGI.md'), MAGI_TEXT);
});

test('新会话与更早的会话：列表最近的在前；继续时引擎与配置要相同，Codex 只有本机配置；可以关闭（继续时恢复显示）与删除', async () => {
  const before = (await view()).sessions[0]?.id;
  if (before === undefined) throw new Error('上一个用例没有留下会话');
  const fresh = await open('codex', 'local', null);
  expect(fresh.id).not.toBe(before);
  await running(fresh.id, 1);
  expect((await view()).sessions.map((s) => s.id)).toEqual([fresh.id, before]);

  // Codex 只有本机配置；继续的会话与所选的引擎或配置不同时拒绝
  const variantConfig = await request('POST', '/api/magi-agent/open', {
    engine: 'codex',
    config: 'v-any',
    liveId: null,
  });
  expect(variantConfig.status).toBe(400);
  expect(await variantConfig.text()).toContain('只有本机配置');
  const mismatch = await request('POST', '/api/magi-agent/open', {
    engine: 'claude',
    config: 'local',
    liveId: before,
  });
  expect(mismatch.status).toBe(400);

  // 选更早的会话继续：resume，同样注入 MAGI.md；它成为最近的
  const old = await open('codex', 'local', before);
  expect(old.id).toBe(before);
  const resumedOld = await running(before, 3);
  expect(lastArgv(resumedOld)).toContain(instructions(MAGI_TEXT));
  expect((await view()).sessions.map((s) => s.id)).toEqual([before, fresh.id]);

  // 驾驶者只有人
  const driver = await request('POST', `/api/live/${fresh.id}/driver`, { driver: 'simulated' });
  expect(driver.status).toBe(409);
  expect(await driver.text()).toContain('只有人驾驶');

  // 关闭：运行中不能关闭；结束后关闭，仍在弹出框的列表中，继续时恢复显示
  expect((await request('POST', `/api/live/${before}/hide`)).status).toBe(409);
  await stop(before);
  expect((await api<Detail>('POST', `/api/live/${before}/hide`)).hiddenAt).not.toBeNull();
  const listed = await api<Detail[]>('GET', '/api/live');
  expect(listed.map((l) => l.id)).not.toContain(before);
  expect((await view()).sessions.map((s) => s.id)).toContain(before);
  const reopened = await open('codex', 'local', before);
  expect(reopened.hiddenAt).toBeNull();
  await running(before, 4);
  await stop(before);

  // 删除：项与它的目录删除，磁盘上 ~/.codex 下的会话文件保留
  const sessionId = (await detail(before)).claudeSessionId;
  if (sessionId === null) throw new Error('第一个用例应记下 Codex 的会话 id');
  const removed = await request('DELETE', `/api/live/${before}`, {
    confirmTitle: resumedOld.title,
  });
  expect(removed.status).toBe(200);
  expect(fs.existsSync(path.join(work, 'data/live', before))).toBe(false);
  expect((await view()).sessions.map((s) => s.id)).toEqual([fresh.id]);
  const rollouts = fs
    .readdirSync(path.join(magi.home, '.codex', 'sessions'), { recursive: true })
    .map(String);
  expect(rollouts.some((f) => f.endsWith(`${sessionId}.jsonl`))).toBe(true);
  await stop(fresh.id);
});

test('Claude Code，本机配置：--append-system-prompt 注入 MAGI.md 与 --session-id；有对话记录后打开时 --resume 同一个 session', async () => {
  const opened = await open('claude', 'local', null);
  expect(opened).toMatchObject({
    purpose: 'agent',
    engine: 'claude',
    agentConfig: 'local',
    cwd: magi.worktree,
  });
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
  // 替身回显的参数与 agent 部署时用的两个环境变量，config 一行在 magi 之后写出；
  // 本机配置不设 CLAUDE_CONFIG_DIR，HOME 为本机的
  const log = await ptyLogWith(opened.id, `config ${JSON.stringify([null, null, magi.home])}`);
  expect(log).toContain(`magi ${JSON.stringify([opened.id, magi.base])}`);
  expect((await view()).sessions[0]).toMatchObject({ id: opened.id, config: 'local' });

  // 以第一条消息命名（UserPromptSubmit hook 的 prompt，取第一行的前 40 个字）；之后的消息与改过的名字都不再改
  const prompt = (text: string) =>
    api('POST', `/api/live/${opened.id}/hook`, {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: text,
    });
  expect(opened.title).toBe('新会话');
  await prompt('帮我看看 Live 列表为什么在 1280 宽时折行\n第二行不算');
  expect((await detail(opened.id)).title).toBe('帮我看看 Live 列表为什么在 1280 宽时折行');
  await prompt('第二条消息');
  expect((await detail(opened.id)).title).toBe('帮我看看 Live 列表为什么在 1280 宽时折行');

  // 还没有对话记录（没有提交过消息）：以同一个会话 id 重新启动
  await stop(opened.id);
  await open('claude', 'local', opened.id);
  const restarted = await running(opened.id, 2);
  expect(restarted.processes[1]?.kind).toBe('start');
  expect(lastArgv(restarted)).toContain('--session-id');

  // 有了对话记录（用户自己的 ~/.claude/projects 下）：resume
  await stop(opened.id);
  const jsonl = path.join(magi.home, '.claude/projects', opened.id, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, '');
  await open('claude', 'local', opened.id);
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

  // 从 Sessions 页面 resume 这个 session（导入后）：同样按它记下的引擎与 worktree 启动，带 MAGI.md 的注入
  fs.writeFileSync(jsonl, sessionLines(sessionId, magi.worktree, ['还记得暗号吗？', '记得。']));
  const { ingestFile } = await import('../../src/ingest/ingest.js');
  ingestFile(magi.db, jsonl);
  const fromSessions = await api<Detail>('POST', '/api/live/resume', {
    sessionId,
    variantId: null,
    driver: 'human',
  });
  expect(fromSessions.id).toBe(opened.id);
  const again = await running(opened.id, 4);
  expect(again.processes[3]?.kind).toBe('resume');
  expect(lastArgv(again).slice(1)).toEqual([
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

test('Claude Code，variant 的配置：CLAUDE_CONFIG_DIR 与 env 来自它的 runtimeEnv，--model 与 --effort，worktree 记为已信任；在它的配置目录中找对话记录', async () => {
  const { config } = await import('../../src/config.js');
  const { createVariants } = await import('../../src/variants/index.js');
  const variants = createVariants({
    db: magi.db,
    dataDir: config.dataDir,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    home: magi.home,
  });
  const flowId = `magi-config-${randomUUID().slice(0, 6)}`;
  await api('POST', '/api/workflows', {
    id: flowId,
    name: 'Magi 配置',
    description: '',
    definition: { id: flowId, name: 'Magi 配置', stages: [{ id: 'step' }] },
  });
  const variant = variants.list().find((v) => v.workflowId === flowId);
  if (variant === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);

  // 没有构建成功的 variant 不能用
  const unbuilt = await request('POST', '/api/magi-agent/open', {
    engine: 'claude',
    config: variant.id,
    liveId: null,
  });
  expect(unbuilt.status).toBe(409);
  expect(await unbuilt.text()).toContain('还没有按当前内容构建');

  await variants.build(variant.id);
  const layout = variants.layout(variant.id);
  const opened = await open('claude', variant.id, null);
  expect(opened).toMatchObject({
    agentConfig: variant.id,
    agentConfigName: `${variant.name} (${flowId})`,
  });
  const sessionId = opened.claudeSessionId;
  if (sessionId === null) throw new Error('Claude Code 的会话 id 应在建项时定下');
  const started = await running(opened.id, 1);
  const hooks = path.join(work, 'data/live', opened.id, 'hooks.json');
  const argv = lastArgv(started).slice(1);
  expect(argv[0]).toBe('--model');
  expect(argv[2]).toBe('--effort');
  expect(argv.slice(4)).toEqual([
    '--mcp-config',
    layout.mcpConfig,
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    hooks,
    '--append-system-prompt',
    MAGI_TEXT,
    '--session-id',
    sessionId,
  ]);
  expect(started.processes[0]).toMatchObject({ variantId: variant.id });
  const runtime = variants.runtimeEnv(variant.id).env;
  await ptyLogWith(
    opened.id,
    `config ${JSON.stringify([layout.claudeDir, runtime.WF_HOME, process.env.HOME])}`,
  );
  // 信任与引导写在 variant 的配置目录中（Contracts 14.2），worktree 的原路径与真实路径都记上
  const state = JSON.parse(
    fs.readFileSync(path.join(layout.claudeDir, '.claude.json'), 'utf8'),
  ) as {
    hasCompletedOnboarding: boolean;
    projects: Record<string, { hasTrustDialogAccepted: boolean }>;
  };
  expect(state.hasCompletedOnboarding).toBe(true);
  expect(state.projects[fs.realpathSync(magi.worktree)]?.hasTrustDialogAccepted).toBe(true);
  // 弹出框的列表按引擎与配置区分
  expect((await view()).sessions[0]).toMatchObject({
    id: opened.id,
    engine: 'claude',
    config: variant.id,
  });

  // 对话记录在 variant 的配置目录中：resume
  await stop(opened.id);
  const jsonl = path.join(layout.claudeDir, 'projects', opened.id, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, '');
  await open('claude', variant.id, opened.id);
  const resumed = await running(opened.id, 2);
  expect(resumed.processes[1]?.kind).toBe('resume');
  expect(lastArgv(resumed).slice(5)).toEqual([
    '--mcp-config',
    layout.mcpConfig,
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
