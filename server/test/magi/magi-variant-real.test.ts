import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { client, type Detail, type MagiApp, startMagiApp, typeInto, until } from './harness.js';

// Magi Agent 的真实档（Contracts 23.3、23.4）：真实的 Claude Code 用一个 variant 的配置（CLAUDE_CONFIG_DIR 为它的配置
// 目录），问一次"MAGI.md 的第一个标题是什么"。worktree 建好之后，主仓库中的 MAGI.md 换成仓库中真实的 agent/MAGI.md，
// 只把第一个标题换成一个独有的（worktree 中没有它）：答出这个标题、没有调用工具、不把它当作提示注入，说明模型把注入的
// 说明当作自己的。模型与 effort 取测试自己的设置：gateway 上 haiku 没有可用渠道，用 sonnet / medium
const work = path.join(import.meta.dirname, '../../../.work/test-magi-variant-real', randomUUID());
const logsDir = path.join(import.meta.dirname, '../../../.work/test-magi-real-logs');
const HEADING = 'Magi Agent（蜗牛-83）：Magi Dashboard 自己的 agent';
const realMagi = fs.readFileSync(path.join(import.meta.dirname, '../../../agent/MAGI.md'), 'utf8');
vi.setConfig({ testTimeout: 600_000 });

let magi: MagiApp;
let api: ReturnType<typeof client>['api'];
let variants: import('../../src/variants/index.js').Variants;

beforeAll(async () => {
  magi = await startMagiApp(work, { WFD_CLAUDE_BIN: 'claude', STAND_IN_ECHO_ARGV: '0' });
  ({ api } = client(magi.base));
  const { config } = await import('../../src/config.js');
  const { createVariants } = await import('../../src/variants/index.js');
  variants = createVariants({
    db: magi.db,
    dataDir: config.dataDir,
    repo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    home: magi.home,
  });
});

afterAll(async () => {
  const dirs = variants.list().map((v) => variants.layout(v.id).dir);
  await magi.close();
  const live = path.join(work, 'data/live');
  fs.mkdirSync(logsDir, { recursive: true });
  for (const id of fs.existsSync(live) ? fs.readdirSync(live) : []) {
    const log = path.join(live, id, 'pty.log');
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(logsDir, `variant-${id}.log`));
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const detail = (id: string) => api<Detail>('GET', `/api/live/${id}`);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

function latestOutput(liveId: string): string {
  const log = fs.readFileSync(path.join(work, 'data/live', liveId, 'pty.log'), 'utf8');
  return log.split('────').at(-1) ?? '';
}

const ClaudeLine = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) })
    .optional(),
});

test('Claude Code 用 variant 的配置：答出注入的 MAGI.md 的第一个标题，session 在 variant 的配置目录中', async () => {
  const started = Date.now();
  const settings = await api<Record<string, unknown>>('GET', '/api/settings');
  await api('PUT', '/api/settings', { ...settings, agentModel: 'sonnet', agentEffort: 'medium' });
  const flowId = `magi-real-${randomUUID().slice(0, 6)}`;
  await api('POST', '/api/workflows', {
    id: flowId,
    name: 'Magi 配置',
    description: '',
    definition: { id: flowId, name: 'Magi 配置', stages: [{ id: 'step' }] },
  });
  const variant = variants.list().find((v) => v.workflowId === flowId);
  if (variant === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
  await variants.build(variant.id);
  const claudeDir = variants.layout(variant.id).claudeDir;

  const opened = await api<Detail>('POST', '/api/magi-agent/open', {
    engine: 'claude',
    config: variant.id,
    liveId: null,
  });
  const sessionId = opened.claudeSessionId;
  if (sessionId === null) throw new Error('Claude Code 的会话 id 应在建项时定下');
  await until(
    'worktree 建好',
    () => (fs.existsSync(path.join(magi.worktree, 'node_modules')) ? true : null),
    120_000,
  );
  fs.writeFileSync(
    path.join(magi.repo, 'agent', 'MAGI.md'),
    realMagi.replace(/^# .*$/m, `# ${HEADING}`),
  );
  // 第一次启动时 MAGI.md 可能还是建 worktree 之前的那份：结束后再打开，启动时读到改过的一份
  await waitRunning(opened.id, 1);
  await stop(opened.id);
  await api('POST', '/api/magi-agent/open', {
    engine: 'claude',
    config: variant.id,
    liveId: opened.id,
  });
  await waitRunning(opened.id, 2);
  await until(
    'Claude Code 可以输入',
    () => (latestOutput(opened.id).includes('bypass permissions') ? true : null),
    120_000,
  );
  const question = 'MAGI.md 的第一个标题是什么？只回答标题本身。';
  await typeInto(magi.base, opened.id, question);
  await sleep(800);
  await typeInto(magi.base, opened.id, '\r');

  // session 写在 variant 的配置目录中；回答之前调用过的工具一并记下
  const file = path.join(claudeDir, 'projects', opened.id, `${sessionId}.jsonl`);
  const tools: string[] = [];
  const answer = await until(
    '回答标题',
    () => {
      if (!fs.existsSync(file)) return null;
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
      if (asked < 0) return null;
      const blocks = lines
        .slice(asked + 1)
        .filter((l) => l.type === 'assistant')
        .flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content : []));
      tools.splice(
        0,
        tools.length,
        ...blocks.flatMap((c) =>
          c.type === 'tool_use' && typeof c.name === 'string' ? [c.name] : [],
        ),
      );
      const texts = blocks.flatMap((c) =>
        c.type === 'text' && typeof c.text === 'string' ? [c.text] : [],
      );
      return texts.length === 0 ? null : texts.join('\n');
    },
    180_000,
  );
  expect(answer).toContain('蜗牛-83');
  expect(answer).not.toMatch(/inject|注入/i);
  expect(tools).toEqual([]);
  const final = await detail(opened.id);
  await stop(opened.id);

  const { ingestFile } = await import('../../src/ingest/ingest.js');
  const { requests } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  ingestFile(magi.db, file);
  const rows = magi.db.select().from(requests).where(eq(requests.sessionId, sessionId)).all();
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'claude-variant.json'),
    `${JSON.stringify(
      {
        liveId: opened.id,
        sessionId,
        variantId: variant.id,
        processes: final.processes.map((p) => p.kind),
        seconds: Math.round((Date.now() - started) / 1000),
        answer,
        tools,
        usage: { requests: rows.length, costUsd: rows.reduce((sum, r) => sum + r.costUsd, 0) },
      },
      null,
      2,
    )}\n`,
  );
});
