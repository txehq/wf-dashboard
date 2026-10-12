import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { liveProcesses, requests, sessions } from '../../src/db/schema.js';
import { sessionConversation } from '../../src/ingest/conversation.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { answerMenu, pasted } from '../../src/live/keys.js';
import type { LiveDetail, LiveSummary, ResumeDefaults } from '../../src/live/views.js';
import { AskUserQuestionInput } from '../../src/runs/stream.js';
import {
  hookNames,
  type LiveServer,
  processOf,
  sleep,
  startLiveServer,
  terminalClient,
  until,
} from './harness.js';

// 真实的 claude（基线 variant）、真实的 PTY 与 WebSocket。每个用例只做证明行为所需的最少调用：
// 新建的项在初始消息提交后就结束进程，resume 后只问一句（Reports/W34 记下每个用例的耗时与花费）
const realCwd = path.join(config.repoRoot, '.work/w34/real-cwd');
// 本机导入的 session：这个 worktree 中由 claude -p 产生的短 session（"请记住暗号：青蛙-47"）
const fixtureSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const fixture = path.join(import.meta.dirname, '../fixtures/live', `${fixtureSession}.jsonl`);

let server: LiveServer;

beforeAll(async () => {
  fs.mkdirSync(realCwd, { recursive: true });
  if (!fs.existsSync(path.join(realCwd, '.git'))) await execa('git', ['init', '-q', realCwd]);
  server = await startLiveServer();
}, 600_000);

afterAll(async () => {
  await server.close();
});

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 一个 session 全部请求（含子代理）的花费：报告中记下每个真实调用用例的花费
const sessionCost = (sessionId: string) =>
  server.db
    .select({ cost: sql<number>`coalesce(sum(${requests.costUsd}), 0)` })
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .get()?.cost ?? 0;

function report(name: string, startedAt: number, sessionId: string, costBefore = 0) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const cost = sessionCost(sessionId) - costBefore;
  const file = path.join(config.repoRoot, '.work/w34/test-costs.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ name, seconds, costUsd: cost, at: new Date() })}\n`);
}

// real 环境中目录未被这个配置信任时，Claude Code 在任何 hook 之前询问；由人（这里是测试）回答
async function acceptTrustIfAsked(
  client: ReturnType<typeof terminalClient>,
  id: string,
): Promise<'asked' | 'trusted'> {
  return until('信任对话框或 SessionStart', 120_000, async () => {
    const screen = (await client.screen()).join('\n');
    if (screen.includes('Yes, I trust this folder')) {
      const detail = await server.detail(id);
      expect(detail.starting).toBe(true);
      // 光标移到"Yes"之后再回车；回车落在默认的"No, exit"上 Claude Code 会退出
      client.input('\u001b[B');
      await until('光标移到 Yes', 10_000, async () =>
        (await client.screen()).some((l) => /❯.*Yes, I trust this folder/u.test(l)) ? true : null,
      );
      client.input('\r');
      return 'asked' as const;
    }
    return hookNames(await server.detail(id)).includes('SessionStart')
      ? ('trusted' as const)
      : null;
  });
}

async function started(id: string): Promise<LiveDetail> {
  return until('SessionStart', 120_000, async () => {
    const d = await server.detail(id);
    if (d.status === 'exited') throw new Error(`进程已退出：${JSON.stringify(d.events.at(-1))}`);
    return d.starting ? null : d;
  });
}

// 在输入框中写一句话并提交，等这一轮的 Stop
async function ask(client: ReturnType<typeof terminalClient>, id: string, text: string) {
  await until('输入框', 30_000, async () =>
    (await client.screen()).some((l) => l.startsWith('❯')) ? true : null,
  );
  const stops = (await server.detail(id)).events.filter(
    (e) => e.kind === 'hook' && e.payload.hook_event_name === 'Stop',
  ).length;
  client.input(pasted(text));
  await sleep(400);
  client.input('\r');
  return until('Stop', 300_000, async () => {
    const all = (await server.detail(id)).events.filter(
      (e) => e.kind === 'hook' && e.payload.hook_event_name === 'Stop',
    );
    return all.length > stops ? (all.at(-1) ?? null) : null;
  });
}

// 进程的环境变量与工作目录（ps eww 与 lsof 读取真实进程）。node-pty 先启动 spawn-helper，它切换目录后 exec claude；
// 读取前等进程已经是 claude
async function execed(pid: number) {
  await until('进程 exec 为 claude', 30_000, async () => {
    const { stdout } = await execa('ps', ['-o', 'command=', '-p', String(pid)]);
    return stdout.startsWith('claude ') ? true : null;
  });
}
async function processEnv(pid: number): Promise<string> {
  await execed(pid);
  return (await execa('ps', ['eww', '-o', 'command=', '-p', String(pid)])).stdout;
}
async function processCwd(pid: number): Promise<string> {
  await execed(pid);
  const { stdout } = await execa('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = stdout.split('\n').find((l) => l.startsWith('n'));
  if (line === undefined) throw new Error(`读不到进程 ${String(pid)} 的工作目录`);
  return line.slice(1);
}

describe('交互：新建、退出、在同一项上 resume（真实 claude）', { timeout: 1_200_000 }, () => {
  let live: LiveDetail;
  let t0 = 0;

  test('real 环境新建 /lfg：cwd、没有 sandbox、variant 的配置目录、默认名字', async () => {
    t0 = Date.now();
    live = await server.api<LiveDetail>('POST', '/api/live', {
      workflow: 'lfg',
      input: '做一个计算器',
      taskId: null,
      variantId: server.variant.id,
      environment: 'real',
      cwd: realCwd,
      driver: 'human',
    });
    expect(live.status).toBe('running');
    expect(live.starting).toBe(true);
    expect(live.driver).toBe('human');
    expect(live.title).toBe('/lfg 做一个计算器');
    expect(live.resumeCount).toBe(0);
    expect(live.processes.map((p) => p.kind)).toEqual(['start']);
    const pid = processOf(live).pid;
    if (pid === null) throw new Error('没有 pid');
    expect(await processCwd(pid)).toBe(fs.realpathSync(realCwd));
    const env = await processEnv(pid);
    const claudeDir = server.variants.layout(server.variant.id).claudeDir;
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${claudeDir}`);
    expect(env).toContain(`CLAUDE_CODE_PROJECT_DIR_NAME=${live.id}`);
    expect(env).not.toContain('CLAUDE_CODE_SANDBOXED');
    const start = live.events.find((e) => e.kind === 'start');
    expect(start?.processId).toBe(processOf(live).id);
    expect(start?.payload.sandboxed).toBe(false);
    expect((start?.payload.argv as string[])[0]).toBe('claude');
    expect(start?.payload.argv).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--settings']),
    );
    const hooks = JSON.parse(
      fs.readFileSync(path.join(config.liveDir, live.id, 'hooks.json'), 'utf8'),
    ) as { skipDangerousModePermissionPrompt: boolean; hooks: Record<string, unknown> };
    expect(hooks.skipDangerousModePermissionPrompt).toBe(true);
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      ['Notification', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
  });

  test('两个客户端收到相同输出，重连先收到保留的输出，resize 生效；初始消息提交后结束进程', async () => {
    const a = terminalClient(server.url, live.id);
    const b = terminalClient(server.url, live.id);
    await Promise.all([a.opened, b.opened]);
    await acceptTrustIfAsked(a, live.id);
    expect(hookNames(await started(live.id))).toContain('SessionStart');
    await until('初始消息提交', 120_000, async () =>
      hookNames(await server.detail(live.id)).includes('UserPromptSubmit') ? true : null,
    );
    // 首次引导在构建 variant 时写入已完成，交互启动不出现
    expect(a.received()).not.toContain('Choose the text style');
    expect((await a.screen()).join('\n')).toContain('/lfg 做一个计算器');
    // 交互的 session 导入后绑定到交互所用的 variant（Contracts 15.1，binding run）
    const bound = await until('session 导入并绑定', 120_000, () => {
      const row = server.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, live.claudeSessionId))
        .get();
      return row?.variantId === undefined || row.variantId === null ? null : row;
    });
    expect(bound.variantId).toBe(server.variant.id);
    expect(bound.variantBinding).toBe('run');
    expect(bound.liveId).toBe(live.id);

    await sleep(1500);
    expect(b.received()).toBe(a.received());
    expect(await b.screen()).toEqual(await a.screen());

    // 断开后重连：第一条消息就是保留的输出
    b.close();
    const c = terminalClient(server.url, live.id);
    await c.opened;
    await until('重连收到输出', 10_000, () => (c.messages.length > 0 ? true : null));
    expect(c.messages[0]?.type).toBe('output');
    expect(c.messages[0]?.data).toContain('Claude Code');
    expect(c.messages[0]?.data).toContain('/lfg 做一个计算器');
    c.close();

    // resize：Claude Code 按新的宽度重画，横线的长度等于列数
    a.resize(100, 36);
    const rule = (width: number) => '─'.repeat(width);
    await until('按 100 列重画', 30_000, async () => {
      const lines = await a.screen();
      return lines.some((l) => l.trim() === rule(100)) && !lines.some((l) => l.includes(rule(101)))
        ? true
        : null;
    });
    a.close();

    // 不等 /lfg 跑完：resume 只需要 session 中有这条用户消息
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.status).toBe('exited');
    expect(processOf(stopped).exitCode).not.toBeNull();
    expect(stopped.events.at(-1)?.kind).toBe('exit');
    report('新建 /lfg 并在初始消息提交后结束', t0, live.claudeSessionId);
  });

  test('改名：空白与超过 200 字以原文报错；改名后 Sessions 列表与详情显示新名字', async () => {
    const blank = await server.request('PATCH', `/api/live/${live.id}`, { title: '  \n ' });
    expect(blank.status).toBe(400);
    expect(blank.text).toContain('名字不能为空');
    const long = await server.request('PATCH', `/api/live/${live.id}`, { title: '计'.repeat(201) });
    expect(long.status).toBe(400);
    expect(long.text).toContain('名字最多 200 个字，现在是 201 个字');
    // 200 个字可以
    const longest = await server.api<LiveDetail>('PATCH', `/api/live/${live.id}`, {
      title: '算'.repeat(200),
    });
    expect(longest.title).toBe('算'.repeat(200));
    const renamed = await server.api<LiveDetail>('PATCH', `/api/live/${live.id}`, {
      title: '  W34 计算器  ',
    });
    expect(renamed.title).toBe('W34 计算器');
    expect(
      renamed.events.filter((e) => e.kind === 'rename').map((e) => [e.processId, e.payload]),
    ).toEqual([
      [null, { from: '/lfg 做一个计算器', to: '算'.repeat(200) }],
      [null, { from: '算'.repeat(200), to: 'W34 计算器' }],
    ]);
    const detail = await server.api<{ title: string | null; liveId: string | null }>(
      'GET',
      `/api/sessions/${live.claudeSessionId}`,
    );
    expect(detail).toMatchObject({ title: 'W34 计算器', liveId: live.id });
    const list = await server.api<{ sessions: { id: string; title: string | null }[] }>(
      'GET',
      '/api/sessions?limit=500',
    );
    expect(list.sessions.find((s) => s.id === live.claudeSessionId)?.title).toBe('W34 计算器');
    const missing = await server.request('PATCH', '/api/live/l-20261012-nonexx', { title: 'x' });
    expect(missing.status).toBe(404);
  });

  test('从交互区 resume：仍是同一项，两个进程，接着回答，运行中再 resume 返回 409，pty.log 两段', async () => {
    const t1 = Date.now();
    const costBefore = sessionCost(live.claudeSessionId);
    const defaults = await server.api<ResumeDefaults>(
      'GET',
      `/api/live/resume-defaults?sessionId=${live.claudeSessionId}`,
    );
    expect(defaults).toMatchObject({
      liveId: live.id,
      running: false,
      variantId: server.variant.id,
    });
    const resumed = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: live.claudeSessionId,
      variantId: server.variant.id,
      driver: 'human',
    });
    expect(resumed.id).toBe(live.id);
    expect(resumed.title).toBe('W34 计算器');
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.processes.map((p) => [p.kind, p.status])).toEqual([
      ['start', 'exited'],
      ['resume', 'running'],
    ]);
    expect(
      server.db
        .select({ kind: liveProcesses.kind })
        .from(liveProcesses)
        .where(eq(liveProcesses.liveId, live.id))
        .all(),
    ).toEqual([{ kind: 'start' }, { kind: 'resume' }]);
    expect(
      (await server.api<LiveDetail[]>('GET', '/api/live')).filter((l) => l.id === live.id),
    ).toHaveLength(1);
    // 运行中再 resume：409，页面上的按钮同样不可点（resume-defaults 的 running）
    const again = await server.request('POST', '/api/live/resume', {
      sessionId: live.claudeSessionId,
      variantId: server.variant.id,
      driver: 'human',
    });
    expect(again.status).toBe(409);
    expect(again.text).toContain(`正在交互 ${live.id} 中运行`);
    expect(
      (
        await server.api<ResumeDefaults>(
          'GET',
          `/api/live/resume-defaults?sessionId=${live.claudeSessionId}`,
        )
      ).running,
    ).toBe(true);

    const client = terminalClient(server.url, live.id);
    await client.opened;
    // 重连回放这一项的输出：第一个进程的输出、两行分隔
    await until('回放', 10_000, () => (client.messages.length > 0 ? true : null));
    const replay = client.messages[0]?.data ?? '';
    expect(replay).toContain('/lfg 做一个计算器');
    expect(replay.indexOf('· start ·')).toBeLessThan(replay.indexOf('· resume ·'));
    await acceptTrustIfAsked(client, live.id);
    const resumedStart = await started(live.id);
    expect(
      resumedStart.events.find(
        (e) =>
          e.kind === 'hook' &&
          e.payload.hook_event_name === 'SessionStart' &&
          e.processId === processOf(resumed).id,
      )?.payload.source,
    ).toBe('resume');
    const stop = await ask(client, live.id, '我上一条消息说了什么？只用一句话回答。');
    expect(String(stop.payload.last_assistant_message)).toContain('计算器');
    expect(stop.processId).toBe(processOf(resumed).id);
    client.close();
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.processes.map((p) => p.status)).toEqual(['exited', 'exited']);

    const log = fs.readFileSync(path.join(config.liveDir, live.id, 'pty.log'), 'utf8');
    const separatorLine = /──── (\S+) · (start|resume) · (.+?) ────/gu;
    const separators = [...log.matchAll(separatorLine)].map((m) => [m[2], m[3]]);
    expect(separators).toEqual([
      ['start', server.variant.name],
      ['resume', server.variant.name],
    ]);
    const [before, after] = log.split(/──── \S+ · resume · .+? ────/u);
    expect(before).toContain('/lfg 做一个计算器');
    expect(after).toContain('计算器');
    report('交互区 resume 并问一句', t1, live.claudeSessionId, costBefore);
  });
});

describe('导入到交互区后 resume（真实 claude）', { timeout: 300_000 }, () => {
  // W30 第一步实测时的一轮"1+1"；它记录的工作目录在这个 worktree 的 .work/ 下
  const imported = '11111111-2222-4333-8444-000000000001';
  test('导入的项没有进程；从这一项 resume 仍是同一项', async () => {
    const t0 = Date.now();
    const projects = path.join(config.dataDir, 'home-projects', 'w34-import');
    fs.mkdirSync(projects, { recursive: true });
    const file = path.join(projects, `${imported}.jsonl`);
    fs.copyFileSync(path.join(import.meta.dirname, '../fixtures/live', `${imported}.jsonl`), file);
    ingestFile(server.db, file);
    const costBefore = sessionCost(imported);
    const cwd = server.db.select().from(sessions).where(eq(sessions.id, imported)).get()?.cwd;
    if (cwd == null) throw new Error('session 没有工作目录');
    fs.mkdirSync(cwd, { recursive: true });
    const [item] = await server.api<LiveSummary[]>('POST', '/api/live/import', {
      sessionIds: [imported],
    });
    if (item === undefined) throw new Error('没有导入');
    expect(item.status).toBe('idle');
    expect(item.process).toBeNull();
    const resumed = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: imported,
      variantId: server.variant.id,
      driver: 'human',
    });
    expect(resumed.id).toBe(item.id);
    expect(resumed.status).toBe('running');
    expect(resumed.processes.map((p) => p.kind)).toEqual(['resume']);
    expect(resumed.events.map((e) => e.kind).slice(0, 2)).toEqual(['import', 'resume']);
    expect(
      (await server.api<LiveDetail[]>('GET', '/api/live')).filter(
        (l) => l.claudeSessionId === imported,
      ),
    ).toHaveLength(1);
    // 不等模型回答：resume 落在哪一项只看进程起在哪里
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${item.id}/stop`);
    expect(stopped.status).toBe('exited');
    report('导入后 resume（启动后即结束）', t0, imported, costBefore);
  });
});

describe('从 Sessions resume 不属于任何项的 session（真实 claude）', { timeout: 900_000 }, () => {
  const projects = path.join(config.dataDir, 'home-projects', 'wfd-w30');
  const original = path.join(projects, `${fixtureSession}.jsonl`);
  let liveId = '';

  test('第一次 resume 建一项：复制进 variant 的 projects/<liveId>/，接着回答，原文件不变；按键回答 AskUserQuestion', async () => {
    const t0 = Date.now();
    fs.mkdirSync(projects, { recursive: true });
    fs.copyFileSync(fixture, original);
    ingestFile(server.db, original);
    const before = sha(original);
    // fixture 原有的一轮不计入这个用例的花费
    const costBefore = sessionCost(fixtureSession);
    const defaults = await server.api<ResumeDefaults>(
      'GET',
      `/api/live/resume-defaults?sessionId=${fixtureSession}`,
    );
    expect(defaults).toMatchObject({
      cwdExists: true,
      variantId: null,
      liveId: null,
      running: false,
    });

    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: fixtureSession,
      variantId: server.variant.id,
      driver: 'human',
    });
    liveId = live.id;
    expect(live.claudeSessionId).toBe(fixtureSession);
    // 默认名字取该 session 在 Sessions 列表中的标题
    expect(live.title).toBe('请记住暗号：青蛙-47。只回答：记住了');
    expect(live.environment).toBe('real');
    expect(live.workflow).toBeNull();
    expect(live.cwd).toBe(defaults.cwd);
    expect(live.processes.map((p) => p.kind)).toEqual(['resume']);
    const copy = path.join(
      server.variants.layout(server.variant.id).claudeDir,
      'projects',
      live.id,
      `${fixtureSession}.jsonl`,
    );
    expect(fs.existsSync(copy)).toBe(true);
    const row = server.db.select().from(sessions).where(eq(sessions.id, fixtureSession)).get();
    expect(row?.filePath).toBe(copy);
    expect(row?.liveId).toBe(live.id);
    // resume 到 variant 后绑定到它；resume 对话框的默认 variant 读 sessions.variant_id
    expect(row?.variantId).toBe(server.variant.id);
    expect(row?.variantBinding).toBe('run');
    expect(
      await server.api<ResumeDefaults>(
        'GET',
        `/api/live/resume-defaults?sessionId=${fixtureSession}`,
      ),
    ).toMatchObject({ variantId: server.variant.id, liveId: live.id, running: true });

    const client = terminalClient(server.url, live.id);
    await client.opened;
    await acceptTrustIfAsked(client, live.id);
    const resumed = await started(live.id);
    const start = resumed.events.find(
      (e) => e.kind === 'hook' && e.payload.hook_event_name === 'SessionStart',
    );
    expect(start?.payload.source).toBe('resume');
    expect(start?.payload.transcript_path).toBe(copy);
    // resume 后停在输入框：等的是上一轮的回答
    expect(resumed.waiting).toEqual({ kind: 'text', text: '记住了' });

    const stop = await ask(client, live.id, '我上一条消息让你记住的暗号是什么？只回答暗号本身。');
    expect(String(stop.payload.last_assistant_message)).toContain('青蛙-47');
    expect(stop.payload.transcript_path).toBe(copy);
    expect(sha(original)).toBe(before);
    // 原文件不再导入（导入的是目标配置中的那份），也不报错
    expect(ingestFile(server.db, original).changed).toBe(false);

    // AskUserQuestion：PreToolUse hook 带问题与选项；一次调用中按键回答单选、多选与"其他"
    client.input(
      pasted(
        '调用一次 AskUserQuestion，同时问我三个问题：问题一「选一个颜色」，header「颜色」，选项 红、绿、蓝，单选；问题二「选几种水果」，header「水果」，选项 苹果、香蕉、橙子，多选（multiSelect true）；问题三「选一个城市」，header「城市」，选项 北京、上海，单选。得到回答后只输出 OK。',
      ),
    );
    await sleep(400);
    client.input('\r');
    const asked = await until('AskUserQuestion 的 PreToolUse', 300_000, async () => {
      const d = await server.detail(live.id);
      return d.waiting?.kind === 'questions' ? d : null;
    });
    const hook = asked.events.findLast(
      (e) => e.kind === 'hook' && e.payload.hook_event_name === 'PreToolUse',
    );
    expect(hook?.payload.tool_name).toBe('AskUserQuestion');
    expect(hook?.payload.session_id).toBe(fixtureSession);
    const questions = AskUserQuestionInput.parse(hook?.payload.tool_input).questions;
    expect(questions.map((q) => [q.question, q.multiSelect === true])).toEqual([
      ['选一个颜色', false],
      ['选几种水果', true],
      ['选一个城市', false],
    ]);
    const pty = server.live.controller(live.id)?.pty;
    if (pty === undefined) throw new Error('交互不在运行中');
    await answerMenu(
      pty,
      questions,
      [
        { optionNumbers: [], otherAnswer: '紫色' },
        { optionNumbers: [1, 3], otherAnswer: '西瓜' },
        { optionNumbers: [2], otherAnswer: '' },
      ],
      new AbortController().signal,
    );
    const toolUseId = asked.waiting?.kind === 'questions' ? asked.waiting.toolUseId : '';
    const answered = await until('AskUserQuestion 的回答写进 jsonl', 120_000, () => {
      ingestFile(server.db, copy);
      const item = (sessionConversation(server.db, fixtureSession) ?? []).find(
        (i) => i.kind === 'question' && i.toolCallId === toolUseId,
      );
      return item?.kind === 'question' && item.answers !== null ? item.answers : null;
    });
    expect(answered).toEqual({
      选一个颜色: '紫色',
      选几种水果: '苹果, 橙子, 西瓜',
      选一个城市: '上海',
    });
    await until('回答之后的 Stop', 300_000, async () => {
      const d = await server.detail(live.id);
      return d.waiting?.kind === 'text' && d.waiting.text.includes('OK') ? true : null;
    });
    client.close();
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.status).toBe('exited');
    report('Sessions 第一次 resume：问一句与一次 AskUserQuestion', t0, fixtureSession, costBefore);
  });

  test('再 resume 一次（"本机配置"）：仍是这一项；不设 CLAUDE_CONFIG_DIR，用 HOME 下的 .claude（测试用临时 HOME）', async () => {
    const home = path.join(config.dataDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: fixtureSession,
      variantId: null,
      driver: 'human',
    });
    expect(live.id).toBe(liveId);
    expect(live.resumeCount).toBe(2);
    expect(live.processes.map((p) => [p.kind, p.variantId])).toEqual([
      ['resume', server.variant.id],
      ['resume', null],
    ]);
    expect(live.variantId).toBeNull();
    expect(live.variantName).toBeNull();
    // 本机配置不绑定：session 仍绑定上一次 resume 所用的 variant
    const row = server.db.select().from(sessions).where(eq(sessions.id, fixtureSession)).get();
    expect(row?.liveId).toBe(liveId);
    expect(row?.variantId).toBe(server.variant.id);
    expect(row?.variantBinding).toBe('run');
    const pid = processOf(live).pid;
    if (pid === null) throw new Error('没有 pid');
    const env = await processEnv(pid);
    expect(env).not.toContain('CLAUDE_CONFIG_DIR=');
    expect(env).toContain(`HOME=${home}`);
    const copy = path.join(home, '.claude', 'projects', liveId, `${fixtureSession}.jsonl`);
    expect(fs.existsSync(copy)).toBe(true);
    expect(live.events.findLast((e) => e.kind === 'resume')?.payload.argv).not.toContain('--model');
    // 不等模型回答：只断言进程的环境
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${liveId}/stop`);
    expect(stopped.status).toBe('exited');
    expect(
      (await server.api<LiveDetail[]>('GET', '/api/live')).filter(
        (l) => l.claudeSessionId === fixtureSession,
      ),
    ).toHaveLength(1);
  });
});
