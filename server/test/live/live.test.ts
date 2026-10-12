import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { sessions } from '../../src/db/schema.js';
import { sessionConversation } from '../../src/ingest/conversation.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { answerMenu, pasted } from '../../src/live/keys.js';
import type { LiveDetail } from '../../src/live/views.js';
import { AskUserQuestionInput } from '../../src/runs/stream.js';
import {
  hookNames,
  type LiveServer,
  sleep,
  startLiveServer,
  terminalClient,
  until,
} from './harness.js';

// 真实的 claude（基线 variant）、真实的 PTY 与 WebSocket；real 环境的工作目录是 git init 的空目录
const realCwd = path.join(config.repoRoot, '.work/w30/real-cwd');
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

describe('交互：PTY、WebSocket 与 hooks（真实 claude）', { timeout: 1_200_000 }, () => {
  let live: LiveDetail;

  test('real 环境启动 /lfg：cwd、没有 sandbox、variant 的配置目录', async () => {
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
    const pid = live.pid;
    if (pid === null) throw new Error('没有 pid');
    expect(await processCwd(pid)).toBe(fs.realpathSync(realCwd));
    const env = await processEnv(pid);
    const claudeDir = server.variants.layout(server.variant.id).claudeDir;
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${claudeDir}`);
    expect(env).toContain(`CLAUDE_CODE_PROJECT_DIR_NAME=${live.id}`);
    expect(env).not.toContain('CLAUDE_CODE_SANDBOXED');
    const start = live.events.find((e) => e.kind === 'start');
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

  test('两个客户端收到相同输出，重连先收到保留的输出，resize 生效', async () => {
    const a = terminalClient(server.url, live.id);
    const b = terminalClient(server.url, live.id);
    await Promise.all([a.opened, b.opened]);
    await acceptTrustIfAsked(a, live.id);
    const started = await until('SessionStart', 120_000, async () => {
      const d = await server.detail(live.id);
      if (d.status === 'exited') throw new Error(`进程已退出：${JSON.stringify(d.events.at(-1))}`);
      return d.starting ? null : d;
    });
    expect(hookNames(started)).toContain('SessionStart');
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

    await sleep(3000);
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
  });

  test('结束进程：status 为 exited，记下退出码与 exit 事件', async () => {
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.status).toBe('exited');
    expect(stopped.exitCode).not.toBeNull();
    expect(stopped.events.at(-1)?.kind).toBe('exit');
    // 已退出的 session 仍可连接，回放 pty.log
    const d = terminalClient(server.url, live.id);
    await until('回放', 10_000, () => (d.messages.length >= 2 ? true : null));
    expect(d.messages[0]?.data).toContain('Claude Code');
    expect(d.messages[1]?.type).toBe('exit');
    d.close();
  });
});

describe('resume 本机导入的 session（真实 claude）', { timeout: 900_000 }, () => {
  const projects = path.join(config.dataDir, 'home-projects', 'wfd-w30');
  const original = path.join(projects, `${fixtureSession}.jsonl`);

  test('用基线 variant resume：复制进 variant 的 projects/<liveId>/，接着回答，原文件不变', async () => {
    fs.mkdirSync(projects, { recursive: true });
    fs.copyFileSync(fixture, original);
    ingestFile(server.db, original);
    const before = sha(original);
    const defaults = await server.api<{ cwd: string; cwdExists: boolean; variantId: null }>(
      'GET',
      `/api/live/resume-defaults?sessionId=${fixtureSession}`,
    );
    expect(defaults.cwdExists).toBe(true);
    expect(defaults.variantId).toBeNull();

    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: fixtureSession,
      variantId: server.variant.id,
      driver: 'human',
    });
    expect(live.resumedFrom).toBe(fixtureSession);
    expect(live.claudeSessionId).toBe(fixtureSession);
    expect(live.environment).toBe('real');
    expect(live.cwd).toBe(defaults.cwd);
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
    const rebound = await server.api<{ variantId: string | null }>(
      'GET',
      `/api/live/resume-defaults?sessionId=${fixtureSession}`,
    );
    expect(rebound.variantId).toBe(server.variant.id);

    const client = terminalClient(server.url, live.id);
    await client.opened;
    await acceptTrustIfAsked(client, live.id);
    const resumed = await until('resume 的 SessionStart', 120_000, async () => {
      const d = await server.detail(live.id);
      if (d.status === 'exited') throw new Error(`进程已退出：${JSON.stringify(d.events.at(-1))}`);
      return d.starting ? null : d;
    });
    const start = resumed.events.find(
      (e) => e.kind === 'hook' && e.payload.hook_event_name === 'SessionStart',
    );
    expect(start?.payload.source).toBe('resume');
    expect(start?.payload.transcript_path).toBe(copy);
    // resume 后停在输入框：等的是上一轮的回答
    expect(resumed.waiting).toEqual({ kind: 'text', text: '记住了' });

    await until('输入框', 30_000, async () =>
      (await client.screen()).some((l) => l.startsWith('❯')) ? true : null,
    );
    client.input(pasted('我上一条消息让你记住的暗号是什么？只回答暗号本身。'));
    await sleep(400);
    client.input('\r');
    const stop = await until('Stop', 300_000, async () => {
      const d = await server.detail(live.id);
      return (
        d.events.findLast((e) => e.kind === 'hook' && e.payload.hook_event_name === 'Stop') ?? null
      );
    });
    expect(String(stop.payload.last_assistant_message)).toContain('青蛙-47');
    expect(stop.payload.transcript_path).toBe(copy);
    expect(sha(original)).toBe(before);
    // 原文件不再导入（导入的是目标配置中的那份），也不报错
    expect(ingestFile(server.db, original).changed).toBe(false);
    ingestFile(server.db, copy);
    const conversation = sessionConversation(server.db, fixtureSession) ?? [];
    expect(conversation.some((i) => i.kind === 'agent' && i.text.includes('青蛙-47'))).toBe(true);

    // AskUserQuestion：PreToolUse hook 带问题与选项；按键回答单选、多选与"其他"
    client.input(
      pasted(
        '调用一次 AskUserQuestion，同时问我三个问题：问题一「选一个颜色」，header「颜色」，选项 红、绿、蓝，单选；问题二「选几种水果」，header「水果」，选项 苹果、香蕉、橙子、葡萄，多选（multiSelect true）；问题三「选一个城市」，header「城市」，选项 北京、上海，单选。得到回答后只输出 OK。',
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
  });

  test('"本机配置" resume：不设 CLAUDE_CONFIG_DIR，用 HOME 下的 .claude（测试用临时 HOME）', async () => {
    const home = path.join(config.dataDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: fixtureSession,
      variantId: null,
      driver: 'human',
    });
    expect(live.variantId).toBeNull();
    expect(live.variantName).toBeNull();
    // 本机配置不绑定：session 仍绑定上一次 resume 所用的 variant
    const row = server.db.select().from(sessions).where(eq(sessions.id, fixtureSession)).get();
    expect(row?.liveId).toBe(live.id);
    expect(row?.variantId).toBe(server.variant.id);
    expect(row?.variantBinding).toBe('run');
    const pid = live.pid;
    if (pid === null) throw new Error('没有 pid');
    const env = await processEnv(pid);
    expect(env).not.toContain('CLAUDE_CONFIG_DIR=');
    expect(env).toContain(`HOME=${home}`);
    const copy = path.join(home, '.claude', 'projects', live.id, `${fixtureSession}.jsonl`);
    expect(fs.existsSync(copy)).toBe(true);
    expect(live.events.find((e) => e.kind === 'start')?.payload.argv).not.toContain('--model');
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.status).toBe('exited');
  });
});
