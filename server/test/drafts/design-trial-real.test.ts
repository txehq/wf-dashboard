import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sum } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { makeSkillSources } from '../helpers/codex-skills.js';

// 真实档（Contracts 28.1、28.2）：一次真实的 Claude Code 设计会话，两问。
// 1. 初始需求只有"列出本机可用的 MCP 并说明哪个能查 Linear 工单，写进 src/mcp.json"：确认 agent 调用 platform-mcp，
//    src/mcp.json 中有指向 mcp.linear.app 的服务器；
// 2. 会话运行中把 examples/simple-workflow 的 skill 写进 src/skills（随写随装进 claude-config/skills），然后在同一个
//    终端中输入 /hello-flow：确认入口与 gather 被调用，gather 问完后停下等回复（28.3）。
// 三个工具 skill 来自本地 git 仓库（不从网络安装）。耗时与花费写进 .work/real-results/w83-design-trial.json
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts', randomUUID());
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(
  makeSkillSources(path.join(work, 'skill-sources')),
);

const { buildApp } = await import('../../src/api/app.js');
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { requests } = await import('../../src/db/schema.js');
const { ingestFile } = await import('../../src/ingest/ingest.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
let base = '';
const created: string[] = [];

interface Draft {
  id: string;
  status: string;
  error: string | null;
  liveId: string;
  dir: string;
  steps: { status: string }[];
}
interface Live {
  id: string;
  status: string;
  claudeSessionId: string | null;
  events: { kind: string; payload: Record<string, unknown> }[];
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function until<T>(what: string, check: () => T | null | Promise<T | null>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${String(ms)} ms 内没有等到：${what}`);
    await sleep(500);
  }
}

const getLive = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/live/${id}` })).json<Live>();

// 一轮结束（Stop hook）的次数
const stops = (live: Live) =>
  live.events.filter((e) => e.kind === 'hook' && e.payload.hook_event_name === 'Stop').length;

// 终端的一次输入：经 PTY 的 WebSocket 写进进程
async function typeInto(liveId: string, data: string) {
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

const Line = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({
      content: z.union([
        z.string(),
        z.array(
          z.looseObject({
            type: z.string(),
            name: z.string().optional(),
            input: z.unknown().optional(),
            text: z.string().optional(),
          }),
        ),
      ]),
    })
    .optional(),
});

function transcript(file: string) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Line.parse(JSON.parse(l)));
}

// transcript 中调用过的 skill（Skill 工具的 input.skill）
function skillCalls(file: string): string[] {
  return transcript(file).flatMap((l) =>
    l.type === 'assistant' && Array.isArray(l.message?.content)
      ? l.message.content.flatMap((c) =>
          c.type === 'tool_use' && c.name === 'Skill'
            ? [z.looseObject({ skill: z.string() }).parse(c.input).skill]
            : [],
        )
      : [],
  );
}

beforeAll(async () => {
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('设计会话找 MCP 与试跑（真实档）', { timeout: 900_000 }, () => {
  test('按 platform-mcp 写出 src/mcp.json；随写随装后 /hello-flow 在同一个终端中试跑，gather 问完停下', async () => {
    const started = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow-drafts',
      payload: {
        mode: 'workflow',
        engine: 'claude',
        workflowId: 'hello-flow',
        name: '你好流程',
        description: '',
        requirement:
          '这次只做一件事：列出本机可用的 MCP 并说明哪个能查 Linear 工单，把能查 Linear 工单的那个写进 src/mcp.json。不要修改 src/skills/，做完就停下。',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    let draft = response.json<{ draft: Draft }>().draft;
    created.push(draft.dir);
    draft = await until(
      '草稿准备完',
      async () => {
        const d = (
          await app.inject({ method: 'GET', url: `/api/workflow-drafts/${draft.id}` })
        ).json<Draft>();
        if (d.status === 'failed') throw new Error(d.error ?? '准备失败');
        return d.steps.every((s) => s.status === 'done') ? d : null;
      },
      120_000,
    );
    const live = await getLive(draft.liveId);
    expect(live.status).toBe('running');
    const sessionId = live.claudeSessionId ?? '';
    const jsonl = path.join(draft.dir, 'claude-config/projects', live.id, `${sessionId}.jsonl`);

    // 第一问：按 platform-mcp 写出 src/mcp.json
    const mcpFile = path.join(draft.dir, 'src/mcp.json');
    await until(
      '第一轮结束',
      async () => (stops(await getLive(live.id)) >= 1 ? true : null),
      480_000,
    );
    const firstSeconds = (Date.now() - started) / 1000;
    expect(skillCalls(jsonl)).toContain('platform-mcp');
    const mcp = z
      .object({ mcpServers: z.record(z.string(), z.looseObject({})) })
      .parse(JSON.parse(fs.readFileSync(mcpFile, 'utf8')));
    expect(JSON.stringify(mcp.mcpServers)).toContain('mcp.linear.app');

    // 运行中把例子的 skill 写进 src/skills：随写随装进 claude-config/skills
    const src = path.join(draft.dir, 'src/skills');
    fs.rmSync(src, { recursive: true });
    fs.cpSync(path.join(draft.dir, 'examples/simple-workflow/skills'), src, { recursive: true });
    const installed = path.join(draft.dir, 'claude-config/skills');
    await until(
      'src/skills 装进会话配置',
      () =>
        ['draft', 'gather', 'hello-flow', 'review'].every((s) =>
          fs.existsSync(path.join(installed, s, 'SKILL.md')),
        ) && !fs.existsSync(path.join(installed, 'stage-1'))
          ? true
          : null,
      5_000,
    );
    // Claude Code 发现新增的 skill 后再输入
    await sleep(3000);

    // 第二问：试跑
    const trialStarted = Date.now();
    await typeInto(live.id, '/hello-flow 给新同事写一句欢迎词');
    await sleep(800);
    await typeInto(live.id, '\r');
    await until(
      '第二轮结束',
      async () => (stops(await getLive(live.id)) >= 2 ? true : null),
      300_000,
    );
    const trialSeconds = (Date.now() - trialStarted) / 1000;
    const calls = skillCalls(jsonl);
    const lines = transcript(jsonl);
    const entry = lines.some(
      (l) =>
        l.type === 'user' &&
        JSON.stringify(l.message?.content ?? '').includes(
          '<command-name>/hello-flow</command-name>',
        ),
    );
    expect(entry || calls.includes('hello-flow')).toBe(true);
    expect(calls).toContain('gather');
    // gather 问完停下等回复：没有进入 draft，也没有写出 hello.md
    expect(calls).not.toContain('draft');
    expect(fs.existsSync(path.join(draft.dir, 'hello.md'))).toBe(false);

    await sleep(3000);
    const stopped = await app.inject({ method: 'POST', url: `/api/live/${live.id}/stop` });
    expect(stopped.json<Live>().status).toBe('exited');
    ingestFile(db, jsonl);
    const cost = db
      .select({ usd: sum(requests.costUsd) })
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .get();
    const result = path.join(config.repoRoot, '.work', 'real-results', 'w83-design-trial.json');
    fs.mkdirSync(path.dirname(result), { recursive: true });
    fs.writeFileSync(
      result,
      `${JSON.stringify(
        {
          firstSeconds,
          trialSeconds,
          totalSeconds: (Date.now() - started) / 1000,
          costUsd: Number(cost?.usd ?? 0),
          sessionId,
          mcpServers: mcp.mcpServers,
          skillCalls: calls,
        },
        null,
        2,
      )}\n`,
    );
    // 终端输出留给报告
    fs.copyFileSync(
      path.join(config.liveDir, live.id, 'pty.log'),
      path.join(path.dirname(result), 'w83-design-trial.pty.log'),
    );
    fs.copyFileSync(jsonl, path.join(path.dirname(result), 'w83-design-trial.jsonl'));
  });
});
