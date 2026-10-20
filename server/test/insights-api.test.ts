import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, onTestFinished, test } from 'vitest';
import { analysisRoutes } from '../src/api/analyses.js';
import { bindingRoutes } from '../src/api/bindings.js';
import { sessionsRoutes } from '../src/api/sessions.js';
import { rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { ingestCodexFile } from '../src/ingest/codex.js';
import { writeInput } from '../src/insights/export.js';
import { ensureAnalysisBaseline } from '../src/insights/baseline.js';
import { createInsights } from '../src/insights/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import {
  BASE_COMMIT,
  IC,
  IC_OTHER,
  LFG,
  sourceDirsOf,
  unpackSession,
  workDir,
} from './helpers/session-fixtures.js';
import { sessionLines } from './helpers/session-copies.js';

// Codex 的真实样本（test/ingest-codex.test.ts）
const CODEX_SESSION = '01a106dd-2ba7-7e71-8490-0e170a634111';
const codexFixture = path.join(
  import.meta.dirname,
  `fixtures/codex-rollouts/rollout-2026-10-04T20-22-00-${CODEX_SESSION}.jsonl`,
);

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
const insights = createInsights({ db, variants, dataDir, dirs: sourceDirsOf(dataDir) });
const app = Fastify();
await app.register(bindingRoutes, { db, variants, dataDir });
await app.register(analysisRoutes, { insights });
await app.register(sessionsRoutes, { prefix: '/api', db, dirs: sourceDirsOf(dataDir) });

afterAll(async () => {
  await app.close();
  await insights.shutdown();
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ingestFile(db, unpackSession(dir, IC));
ingestFile(db, unpackSession(dir, LFG));

interface ScopeBody {
  engine: string | null;
  config: { id: string; label: string } | null;
  variant: { id: string; name: string } | null;
  local: boolean;
  problem: string | null;
  sessions: {
    id: string;
    title: string | null;
    config: { id: string; label: string } | null;
    project: string | null;
    inDashboard: boolean;
  }[];
}
const scope = async (query: string) =>
  (await app.inject({ method: 'GET', url: `/api/analyses/scope?${query}` })).json<ScopeBody>();
const postScope = async (payload: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url: '/api/analyses/scope', payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ScopeBody>();
};

describe('本机配置的 session 的分析（Contracts 25.4、27）', { timeout: 120_000 }, () => {
  // 本机配置：测试进程的 Claude Code projects 目录与 CODEX_HOME（test/setup/data-dir.ts），其中放真实样本
  const claudeFile = path.join(
    config.claudeProjectsDir,
    '-fixture-local',
    `${IC_OTHER.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures/runs', `${IC_OTHER.sessionId}.jsonl`),
    claudeFile,
  );
  ingestFile(db, claudeFile);
  const rollout = path.join(config.codexHome, 'sessions/2026/10/04', path.basename(codexFixture));
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.copyFileSync(codexFixture, rollout);
  ingestCodexFile(db, rollout);

  afterAll(() => {
    fs.rmSync(path.dirname(claudeFile), { recursive: true, force: true });
    fs.rmSync(path.join(config.codexHome, 'sessions'), { recursive: true, force: true });
  });

  test('本机配置的 Claude Code 或 Codex 的 session 可以分析，没有 variant；两种引擎混合时给出原因', async () => {
    const claude = await scope(`sessions=${IC_OTHER.sessionId}`);
    expect(claude).toMatchObject({
      engine: 'claude',
      config: { id: 'local', label: '本机配置' },
      variant: null,
      local: true,
      problem: null,
    });
    // 项目是工作目录的目录名（run 的工作目录 .../runs/<run>/workspace）
    expect(claude.sessions).toMatchObject([
      { config: { id: 'local' }, project: 'workspace', inDashboard: true },
    ]);
    expect(await scope(`sessions=${CODEX_SESSION}`)).toMatchObject({
      engine: 'codex',
      local: true,
      problem: null,
    });
    // ids 放在请求体中（POST，Contracts 25.5）的结果与 GET 相同
    const mixed = await scope(`sessions=${IC_OTHER.sessionId},${CODEX_SESSION}`);
    expect(await postScope({ ids: [IC_OTHER.sessionId, CODEX_SESSION] })).toEqual(mixed);
    expect(mixed).toMatchObject({
      engine: null,
      variant: null,
      local: false,
      problem: '所选 session 必须是同一种引擎，现在有 Claude Code 与 Codex',
    });
  });

  test('input/：stage 为 null，没有 stages.json、skills/ 与 workflow.yaml，case.json 的 variant 为 null', async () => {
    const inputDir = path.join(dir, 'local-analysis', 'input');
    const exported = await writeInput(db, {
      analysisId: 'a-20261014-local1',
      variant: null,
      sessionIds: [IC_OTHER.sessionId, CODEX_SESSION],
      inputDir,
    });
    for (const id of [IC_OTHER.sessionId, CODEX_SESSION]) {
      const rows = exported.get(id) ?? [];
      expect(rows.length, id).toBeGreaterThan(0);
      expect(rows.every((r) => r.stage === null)).toBe(true);
      expect(fs.readdirSync(path.join(inputDir, 'sessions', id)).sort()).toEqual([
        'conversation.json',
        'instructions.json',
      ]);
    }
    expect(fs.readdirSync(inputDir).sort()).toEqual(['case.json', 'sessions']);
    const caseFile = JSON.parse(fs.readFileSync(path.join(inputDir, 'case.json'), 'utf8')) as {
      variant: unknown;
      sessions: { id: string }[];
    };
    expect(caseFile.variant).toBeNull();
    expect(caseFile.sessions.map((s) => s.id)).toEqual([IC_OTHER.sessionId, CODEX_SESSION]);
  });
});

describe('绑定与分析的 HTTP 接口', { timeout: 120_000 }, () => {
  test('不在任何配置中的 session 不能分析，原因写在范围中，POST 以 400 返回同样的原文', async () => {
    const s = await scope(`sessions=${IC.sessionId}`);
    expect(s).toMatchObject({ config: null, variant: null });
    expect(s.problem).toBe(`这些 session 不在任何配置中：${IC.sessionId.slice(0, 8)}`);
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

  test('建基线后自动绑定；手动改选、解除与恢复自动判定', async () => {
    const base = await variants.createBaseline({
      name: 'w31-api-基线',
      commit: BASE_COMMIT,
    });
    const view = await app.inject({ method: 'GET', url: `/api/sessions/${IC.sessionId}/binding` });
    expect(view.json()).toMatchObject({
      variant: { id: base.id, name: base.name },
      binding: 'auto',
      matching: [{ id: base.id }],
      defaultBase: { id: base.id },
    });
    // 标题与 Sessions 列表相同：slash 命令显示为命令名加参数
    const titled = await scope(`sessions=${IC.sessionId},${LFG.sessionId}`);
    expect(titled.sessions.map((x) => x.title)).toEqual(['/ic TXE-3767', '/lfg 做一个计算器']);

    const other = variants.derive(base.id, { name: 'w31-api-other' });
    const put = (payload: { variantId: string | null } | { auto: true }) =>
      app.inject({ method: 'PUT', url: `/api/sessions/${LFG.sessionId}/binding`, payload });
    expect((await put({ variantId: other.id })).json()).toMatchObject({
      variant: { id: other.id },
      binding: 'manual',
    });
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
    expect(res.json()).toEqual({ defaults: insights.defaults(), analysisVariants: [] });
    expect(insights.defaults().codex).not.toBe('');
  });
});

// 同一个配置、同一种引擎；从磁盘选的开始分析时读入
describe('分析的范围与读入（Contracts 27）', { timeout: 300_000 }, () => {
  const named = (name: string) => {
    const found = variants.list().find((v) => v.name === name);
    if (found === undefined) throw new Error(`没有 variant ${name}`);
    return found;
  };
  // variant 的配置目录或本机配置中的一个 session（fixture「请记住暗号」的副本）
  const sessionIn = (claudeDir: string, slug: string) => {
    const id = randomUUID();
    const file = path.join(claudeDir, slug, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sessionLines(id, path.join(dir, slug)));
    return { id, file };
  };
  const ids = async (query: string) =>
    (
      await app.inject({ method: 'GET', url: `/api/sessions?engine=claude&idsOnly=true&${query}` })
    ).json<{ ids: string[] }>().ids;

  test('同一个 variant 的配置中的可以一起分析；两个 variant、variant 与本机配置混合时以原文拒绝', async () => {
    const base = named('w31-api-基线');
    const other = named('w31-api-other');
    const projects = (id: string) => path.join(variants.layout(id).claudeDir, 'projects');
    const a = sessionIn(projects(base.id), '-w79-a');
    const b = sessionIn(projects(base.id), '-w79-b');
    const c = sessionIn(projects(other.id), '-w79-c');
    for (const s of [a, b, c]) ingestFile(db, s.file);

    const together = await scope(`sessions=${a.id},${b.id}`);
    expect(together).toMatchObject({
      engine: 'claude',
      config: { id: `variant:${base.id}`, label: `${base.name} (lfg)` },
      variant: { id: base.id, name: base.name },
      local: false,
      problem: null,
    });
    expect(together.sessions.map((s) => s.project)).toEqual(['-w79-a', '-w79-b']);
    expect((await scope(`sessions=${a.id},${c.id}`)).problem).toBe(
      `所选 session 必须属于同一个配置，现在是：${base.name} (lfg)、${other.name} (lfg)`,
    );
    expect((await scope(`sessions=${a.id},${IC_OTHER.sessionId}`)).problem).toBe(
      `所选 session 必须属于同一个配置，现在是：${base.name} (lfg)、本机配置`,
    );
  });

  test('从磁盘选的还不在 dashboard 中的：范围按文件；开始分析时读入，不在管理表格中，之后从 Sessions 导入时出现', async () => {
    const local = sessionIn(config.claudeProjectsDir, `-w79-local-${randomUUID().slice(0, 6)}`);
    onTestFinished(() => {
      fs.rmSync(path.dirname(local.file), { recursive: true, force: true });
    });
    const disk = { engine: 'claude', files: [local.file] };
    const picked = await postScope({ ids: [IC_OTHER.sessionId], disk });
    expect(picked).toMatchObject({ config: { id: 'local' }, local: true, problem: null });
    expect(picked.sessions.map((s) => [s.id, s.inDashboard])).toEqual([
      [IC_OTHER.sessionId, true],
      [local.id, false],
    ]);
    expect(picked.sessions[1]?.title).not.toBeNull();
    const outside = await app.inject({
      method: 'POST',
      url: '/api/analyses/scope',
      payload: { disk: { engine: 'claude', files: [path.join(dir, 'x.jsonl')] } },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.body).toContain('不是 Claude Code 配置下的 session 文件');
    // 范围不对时不读入
    const mixed = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { sessionIds: [IC.sessionId], disk, engine: 'claude' },
    });
    expect(mixed.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${local.id}` })).statusCode).toBe(
      404,
    );

    // 开始分析（基础档中引擎的调用失败，这里只看读入）
    await ensureAnalysisBaseline(db, variants);
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      payload: { disk, engine: 'claude' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ id: string }>();
    await insights.settled(created.id);
    expect(insights.detail(created.id).sessionIds).toEqual([local.id]);
    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${local.id}` });
    expect(detail.statusCode).toBe(200);
    expect(await ids(`q=${local.id}`)).toEqual([]);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/session-import/sessions?engine=claude&config=local&cwd=${encodeURIComponent(path.join(dir, path.basename(path.dirname(local.file))))}`,
    });
    expect(listed.json<{ sessions: { id: string; imported: boolean }[] }>().sessions).toMatchObject(
      [{ id: local.id, imported: false }],
    );
    // 已读入的再选时按记录
    expect((await postScope({ disk })).sessions).toMatchObject([
      { id: local.id, inDashboard: true },
    ]);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/session-import',
      payload: disk,
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(await ids(`q=${local.id}`)).toEqual([local.id]);
  });
});
