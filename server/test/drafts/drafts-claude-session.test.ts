import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execaSync } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { writeClaudeStandIn } from '../helpers/claude-stand-in.js';
import { codexStandIn, makeSkillSources } from '../helpers/codex-skills.js';
import { blockedGateway } from '../setup/basic-tier.js';

// 基础档（Contracts 22）：设计 workflow 的会话选 Claude Code。草稿目录的准备（dashboard 所有的 claude-config/、
// 三个 skill 以 -a claude-code 装进 .claude/skills/ 并记下版本）、启动的命令与 env（去掉的变量、注入的变量）、
// sandbox（能写工作目录与 ~/.mcp-auth，不能写 HOME 的其他地方）、只有人驾驶、resume 接着同一个会话。Claude Code 是测试自己写出的替身，
// 打出收到的 argv 与 env，不调用真实的 claude
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts', randomUUID());
const sources = makeSkillSources(path.join(work, 'skill-sources'));
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(sources);
process.env.WFD_CODEX_BIN = codexStandIn;
process.env.WFD_CLAUDE_BIN = writeClaudeStandIn(path.join(work, 'bin'));

const { buildApp } = await import('../../src/api/app.js');
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
const marker = randomUUID().slice(0, 6);
const workflowId = `claude-${marker}`;
// 替身试着写的 HOME 下的文件：sandbox 生效时不会出现
const homeProbe = path.join(os.homedir(), 'w59-stand-in-should-not-exist.txt');

interface Draft {
  id: string;
  engine: string;
  status: string;
  error: string | null;
  liveId: string;
  dir: string;
  steps: { id: string; label: string; status: string }[];
  skills: { name: string; source: string; computedHash: string; commit: string }[];
}
interface Live {
  id: string;
  engine: string;
  status: string;
  starting: boolean;
  claudeSessionId: string | null;
  variantName: string | null;
  processes: { kind: string; status: string }[];
  events: { kind: string; payload: Record<string, unknown> }[];
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const getDraft = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/workflow-drafts/${id}` })).json<Draft>();
const getLive = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/live/${id}` })).json<Live>();
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

// pty.log 中替身打出的一行（`<名字> <值>`）；等它出现
async function standInLine(liveId: string, name: string, after = 0): Promise<string> {
  const log = path.join(config.liveDir, liveId, 'pty.log');
  for (let i = 0; i < 100; i++) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(after) : '';
    // 终端把替身写的 \r\n 记为 \r\r\n
    const line = text.split(/\r*\n/).find((l) => l.startsWith(`${name} `));
    if (line !== undefined) return line.slice(name.length + 1);
    await sleep(100);
  }
  throw new Error(`pty.log 中没有 ${name} 一行`);
}

beforeAll(async () => {
  fs.rmSync(homeProbe, { force: true });
  // hooks 指向服务实际监听的地址
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(homeProbe, { force: true });
});

describe('Claude Code 的设计会话（基础档，替身）', { timeout: 60_000 }, () => {
  let draft: Draft;

  test('引擎是必填的；选 Claude Code 时草稿与 Live 项的 engine 都是 claude', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: {
        mode: 'workflow',
        workflowId,
        name: '没有引擎',
        description: '',
        requirement: 'x',
      },
    });
    expect(missing.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: {
        mode: 'workflow',
        engine: 'claude',
        workflowId,
        name: `Claude ${marker}`,
        description: '打招呼',
        requirement: '做一个打招呼的 workflow',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ draft: Draft; live: Live }>();
    expect(body.draft.engine).toBe('claude');
    expect(body.live.engine).toBe('claude');
    expect(body.draft.steps.at(-1)).toMatchObject({ id: 'start-codex', label: '启动 Claude Code' });
    for (;;) {
      draft = await getDraft(body.draft.id);
      if (draft.status === 'failed') throw new Error(draft.error ?? '准备失败');
      if (draft.steps.every((s) => s.status === 'done')) break;
      await sleep(100);
    }
  });

  test('准备：三个 skill 以项目范围装进 .claude/skills/ 并记下版本（与 dashboard 自带的 platform-mcp 并列），没有 .agents/；claude-config/ 由 dashboard 写好', () => {
    const skills = path.join(draft.dir, '.claude/skills');
    expect(fs.readdirSync(skills).sort()).toEqual(
      [...sources.map((s) => s.name), 'platform-mcp'].sort(),
    );
    expect(fs.existsSync(path.join(draft.dir, '.agents'))).toBe(false);
    for (const skill of draft.skills) {
      const source = sources.find((s) => s.name === skill.name);
      expect(skill.source).toBe(source?.source);
      expect(skill.commit).toBe(
        execaSync('git', ['-C', skill.source, 'rev-parse', 'HEAD']).stdout.trim(),
      );
      expect(skill.computedHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // 凭据与模型配置来自 settings 源的 env 块（基础档中 gateway 指向不存在的域名），不读真实的 CLAUDE.md
    const claudeDir = path.join(draft.dir, 'claude-config');
    expect(readJson(path.join(claudeDir, 'settings.json'))).toMatchObject({
      env: { ANTHROPIC_BASE_URL: blockedGateway },
      claudeMdExcludes: [
        path.join(os.homedir(), '.claude/CLAUDE.md'),
        path.join(os.homedir(), '.claude/rules/**'),
      ],
    });
    // 引导已完成，工作目录已信任
    expect(readJson(path.join(claudeDir, '.claude.json'))).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { [draft.dir]: { hasTrustDialogAccepted: true } },
    });
  });

  test('启动：argv、去掉与注入的 env、sandbox 中能写工作目录不能写 HOME、只有人驾驶', async () => {
    const live = await getLive(draft.liveId);
    expect(live.status).toBe('running');
    expect(live.variantName).toBe('Claude Code');
    const sessionId = live.claudeSessionId ?? '';
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const start = live.events.find((e) => e.kind === 'start');
    const hooks = path.join(config.liveDir, live.id, 'hooks.json');
    expect(start?.payload).toMatchObject({
      engine: 'claude',
      sandboxed: true,
      configDir: path.join(draft.dir, 'claude-config'),
    });
    const argv = JSON.parse(await standInLine(live.id, 'argv')) as string[];
    expect(argv.slice(0, 6)).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      hooks,
      '--session-id',
      sessionId,
    ]);
    // 初始消息与 Codex 相同，skill 的位置写 .claude/skills/
    expect(argv[6]).toContain('做一个打招呼的 workflow');
    expect(argv[6]).toContain('.claude/skills/writing-for-agents');
    expect(argv[6]).not.toContain('.agents/skills');
    expect(argv).toHaveLength(7);
    const env = JSON.parse(await standInLine(live.id, 'env')) as Record<string, string>;
    // 父进程的 CLAUDE*、ANTHROPIC*、ORCA_AGENT* 都去掉；只有 dashboard 注入的几个
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CODE_PROJECT_DIR_NAME',
        'CLAUDE_CODE_SANDBOXED',
        'CLAUDE_CONFIG_DIR',
        'npm_config_cache',
        ...(process.env.HOME === undefined ? [] : ['HOME']),
      ].sort(),
    );
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: path.join(draft.dir, 'claude-config'),
      CLAUDE_CODE_SANDBOXED: '1',
      CLAUDE_CODE_PROJECT_DIR_NAME: live.id,
      npm_config_cache: path.join(os.homedir(), '.npm'),
    });
    expect(await standInLine(live.id, 'write-cwd')).toBe('ok');
    expect(await standInLine(live.id, 'write-home')).toBe('EPERM');
    // mcp-remote 刷新 token 时写回 ~/.mcp-auth（Contracts 28.1）
    expect(await standInLine(live.id, 'write-mcp-auth')).toBe('ok');
    expect(fs.existsSync(path.join(draft.dir, 'stand-in-wrote.txt'))).toBe(true);
    expect(fs.existsSync(homeProbe)).toBe(false);
    const driver = await app.inject({
      method: 'POST',
      url: `/api/live/${live.id}/driver`,
      payload: { driver: 'simulated' },
    });
    expect(driver.statusCode).toBe(409);
    expect(driver.body).toContain('只有人驾驶');
    // "启动中"的提示：收到 SessionStart 之前为 starting；hook 请求的字段与真实 Claude Code 2.1.295 发出的相同
    // （Reports/W59，在实例上实测），之后提示消失
    expect((await getLive(live.id)).starting).toBe(true);
    const projects = path.join(draft.dir, 'claude-config/projects', live.id);
    const transcript = path.join(projects, `${sessionId}.jsonl`);
    const hook = await app.inject({
      method: 'POST',
      url: `/api/live/${live.id}/hook`,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        transcript_path: transcript,
        source: 'startup',
        cwd: draft.dir,
        model: 'claude-opus-5-5[1m]',
      },
    });
    expect(hook.statusCode, hook.body).toBeLessThan(300);
    const started = await getLive(live.id);
    expect(started.starting).toBe(false);
    expect(
      started.events.some((e) => e.kind === 'hook' && e.payload.hook_event_name === 'SessionStart'),
    ).toBe(true);
  });

  test('resume：claude --resume <同一个会话>，同一个配置目录；结束后可以再 resume', async () => {
    const before = await getLive(draft.liveId);
    const stopped = await app.inject({ method: 'POST', url: `/api/live/${draft.liveId}/stop` });
    expect(stopped.json<Live>().status).toBe('exited');
    const log = path.join(config.liveDir, draft.liveId, 'pty.log');
    const offset = fs.readFileSync(log, 'utf8').length;
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/live/${draft.liveId}/draft-resume`,
    });
    expect(resumed.statusCode, resumed.body).toBe(201);
    const live = resumed.json<Live>();
    expect(live.claudeSessionId).toBe(before.claudeSessionId);
    expect(live.processes.map((p) => p.kind)).toEqual(['start', 'resume']);
    expect(live.events.find((e) => e.kind === 'resume')?.payload).toMatchObject({
      engine: 'claude',
      configDir: path.join(draft.dir, 'claude-config'),
    });
    const argv = JSON.parse(await standInLine(draft.liveId, 'argv', offset)) as string[];
    expect(argv.slice(-2)).toEqual(['--resume', before.claudeSessionId]);
    expect(argv).not.toContain('--session-id');
    const again = await app.inject({
      method: 'POST',
      url: `/api/live/${draft.liveId}/draft-resume`,
    });
    expect(again.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/live/${draft.liveId}/stop` });
  });
});
