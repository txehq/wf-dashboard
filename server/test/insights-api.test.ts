import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { analysisRoutes } from '../src/api/analyses.js';
import { bindingRoutes } from '../src/api/bindings.js';
import { rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { createInsights } from '../src/insights/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { BASE_COMMIT, IC, LFG, unpackSession, workDir } from './helpers/session-fixtures.js';

// Contracts 15.1、15.2 的 HTTP 接口（不启动引擎）：真实 session 与真实 variant
const dir = workDir('insights-api');
const dataDir = path.join(dir, 'data');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  onSkillsChanged: () => {
    rebindAll(db, dataDir);
  },
});
const insights = createInsights({ db, variants, dataDir });
const app = Fastify();
await app.register(bindingRoutes, { db, variants, dataDir });
await app.register(analysisRoutes, { insights });

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ingestFile(db, unpackSession(dir, IC));
ingestFile(db, unpackSession(dir, LFG));

const scope = async (query: string) =>
  (await app.inject({ method: 'GET', url: `/api/analyses/scope?${query}` })).json<{
    variant: { id: string; name: string } | null;
    problem: string | null;
    sessions: { id: string; title: string | null }[];
  }>();

describe('绑定与分析的 HTTP 接口', { timeout: 120_000 }, () => {
  test('未绑定的 session 不能分析，原因写在范围中，POST 以 400 返回同样的原文', async () => {
    const s = await scope(`sessions=${IC.sessionId}`);
    expect(s.variant).toBeNull();
    expect(s.problem).toBe(`这些 session 没有绑定 variant：${IC.sessionId.slice(0, 8)}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { sessionIds: [IC.sessionId], engine: 'claude' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toBe(s.problem);
    const both = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { sessionIds: [IC.sessionId], batchId: 'b-x', engine: 'claude' },
    });
    expect(both.statusCode).toBe(400);
  });

  test('建基线后自动绑定；手动改选、解除与恢复自动判定；同一 variant 的两个 session 可以一起分析', async () => {
    const base = await variants.createBaseline({
      name: 'w31-api-基线',
      commit: BASE_COMMIT,
      model: 'opus',
      effort: 'high',
    });
    const view = await app.inject({ method: 'GET', url: `/api/sessions/${IC.sessionId}/binding` });
    expect(view.json()).toMatchObject({
      variant: { id: base.id, name: base.name },
      binding: 'auto',
      matching: [{ id: base.id }],
      defaultBase: { id: base.id },
    });
    const together = await scope(`sessions=${IC.sessionId},${LFG.sessionId}`);
    expect(together).toMatchObject({ variant: { id: base.id }, problem: null });
    // 标题与 Sessions 列表相同：slash 命令显示为命令名加参数
    expect(together.sessions.map((x) => x.title)).toEqual(['/ic TXE-3767', '/lfg 做一个计算器']);

    const other = variants.derive(base.id, { name: 'w31-api-other' });
    const put = (payload: { variantId: string | null } | { auto: true }) =>
      app.inject({ method: 'PUT', url: `/api/sessions/${LFG.sessionId}/binding`, payload });
    expect((await put({ variantId: other.id })).json()).toMatchObject({
      variant: { id: other.id },
      binding: 'manual',
    });
    const mixed = await scope(`sessions=${IC.sessionId},${LFG.sessionId}`);
    expect(mixed.problem).toBe(
      `所选 session 必须都绑定到同一个 variant，现在是：${base.name}、${other.name}`,
    );
    expect((await put({ variantId: null })).json()).toMatchObject({
      variant: null,
      binding: 'manual',
    });
    expect((await put({ auto: true })).json()).toMatchObject({
      variant: { id: base.id },
      binding: 'auto',
    });
    expect((await put({ variantId: 'missing' })).statusCode).toBe(404);
  });

  test('按 session 的 skill 新建 variant 返回 201 与新 variant', async () => {
    const binding = (
      await app.inject({ method: 'GET', url: `/api/sessions/${IC.sessionId}/binding` })
    ).json<{ defaultBase: { id: string } }>();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${IC.sessionId}/derive-variant`,
      payload: { baseVariantId: binding.defaultBase.id, name: 'w31-api-来自 session' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string }>();
    expect(variants.get(created.id)).toMatchObject({
      parentId: binding.defaultBase.id,
      sourceSessionId: IC.sessionId,
      status: 'draft',
    });
  });

  test('默认模型：Claude Code 为 judge，Codex 为 ~/.codex/config.toml 的 model', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analyses/options' });
    expect(res.json()).toEqual({ defaults: insights.defaults() });
    expect(insights.defaults().codex).not.toBe('');
  });
});
