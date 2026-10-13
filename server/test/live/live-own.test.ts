import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, expect, test } from 'vitest';
import { liveRoutes } from '../../src/api/live.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { requests } from '../../src/db/schema.js';
import { sessionConversation } from '../../src/ingest/conversation.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { createLive } from '../../src/live/index.js';
import type { LiveDetail } from '../../src/live/views.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { createWorkflows } from '../../src/workflows/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';
import { hookNames, until } from './harness.js';

// 真实档（Contracts 18.6）：自有管理器构建的 variant 在 Live 的 real 环境中启动真实的 claude，
// 初始消息 /<入口> 你好，入口 skill 从 variant 自己的配置目录加载；只等第一轮结束（Stop hook）就结束进程。
// 用最便宜的 haiku / low，入口 skill 只要求回一句话
const work = path.join(config.repoRoot, '.work', 'test-live-own', randomUUID());
const cwd = path.join(work, 'cwd');
fs.mkdirSync(cwd, { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const app = Fastify();
await app.register(fastifyWebsocket);
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: path.join(work, 'live'),
  dataDir: config.dataDir,
  serverUrl: () => url,
  localHome: path.join(work, 'home'),
  repos: testRepos(),
  codex: testCodex(),
  claudeBin: config.claudeBin,
});
await app.register(liveRoutes, { live });
app.addHook('onClose', async () => {
  await live.shutdown();
});
await app.listen({ host: config.host, port: 0 });
const address = app.server.address();
if (address === null || typeof address === 'string') throw new Error('没有监听端口');
const url = `http://${config.host}:${String(address.port)}`;

afterAll(async () => {
  await app.close();
  const dirs = variants.list().map((v) => variants.layout(v.id).dir);
  db.$client.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test(
  '自有管理器构建的 variant：Live real 环境中 /<入口> 你好 加载入口 skill，第一轮结束后停止',
  { timeout: 600_000 },
  async () => {
    const started = Date.now();
    const id = `hello-${randomUUID().slice(0, 6)}`;
    const marker = `暗号-${randomUUID().slice(0, 6)}`;
    createWorkflows({ db, variants }).create({
      id,
      name: `你好 ${id}`,
      description: '',
      definition: { id, name: `你好 ${id}`, stages: [{ id: `${id}-reply` }] },
    });
    const draft = variants.list().find((v) => v.workflowId === id);
    if (draft === undefined) throw new Error(`${id} 没有 variant`);
    // 入口 skill 只要求回一句带暗号的话，不调用其他工具
    variants.writeFile(
      draft.id,
      `skills/${id}/SKILL.md`,
      `---\nname: ${id}\ndescription: 打招呼的入口\n---\n\n只回复一行：${marker}。不要调用任何工具，不要做别的事。\n`,
    );
    const built = await variants.build(draft.id);
    expect(built.buildStatus).toBe('built');

    const created = await fetch(`${url}/api/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow: id,
        input: '你好',
        variantId: draft.id,
        environment: 'real',
        cwd,
        driver: 'human',
        model: 'haiku',
        effort: 'low',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const item = (await created.json()) as LiveDetail;
    const detail = async () =>
      (await (await fetch(`${url}/api/live/${item.id}`)).json()) as LiveDetail;

    // 第一轮结束：Stop hook
    await until('第一轮结束', 300_000, async () =>
      hookNames(await detail()).includes('Stop') ? true : null,
    );
    const stopped = await fetch(`${url}/api/live/${item.id}/stop`, { method: 'POST' });
    expect(stopped.status).toBe(200);

    // session 中：用户输入的 /<入口> 命令，入口 skill 的正文被加载，回复中有暗号
    const sessionId = item.claudeSessionId ?? '';
    const file = path.join(
      variants.layout(draft.id).claudeDir,
      'projects',
      item.id,
      `${sessionId}.jsonl`,
    );
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(`<command-name>/${id}</command-name>`);
    expect(text).toContain(`只回复一行：${marker}`);
    ingestFile(db, file);
    const conversation = sessionConversation(db, sessionId);
    expect(JSON.stringify(conversation)).toContain(marker);

    // 耗时与花费：导入后 requests 的花费合计
    const cost =
      db
        .select({ cost: sql<number>`coalesce(sum(${requests.costUsd}), 0)` })
        .from(requests)
        .where(eq(requests.sessionId, sessionId))
        .get()?.cost ?? 0;
    const result = { seconds: Math.round((Date.now() - started) / 1000), costUsd: cost, sessionId };
    fs.mkdirSync(path.join(config.repoRoot, '.work', 'w44'), { recursive: true });
    fs.writeFileSync(
      path.join(config.repoRoot, '.work', 'w44', 'live-own.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  },
);
