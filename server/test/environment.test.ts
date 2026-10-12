import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { type EnvironmentOptions, runEnvironmentChecks } from '../src/environment.js';
import { closeLinearClient } from '../src/external/linear.js';
import { claudeSettingsEnv, models, stripContextTag } from '../src/llm/client.js';

// 全部检查都真实执行：真实的 claude、gateway、gh、Linear MCP、codex exec 与本机路径
const work = path.join(config.repoRoot, '.work', 'test-environment', randomUUID());
fs.mkdirSync(work, { recursive: true });

const machine: EnvironmentOptions = {
  models: () => models,
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  txeWorkflowRepo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  codexAuthPath: config.codexAuthPath,
  codexConfigPath: config.codexConfigPath,
  workDir: path.join(work, 'machine'),
};

const ids = [
  'claude',
  'model-simulated-user',
  'model-judge',
  'gh',
  'linear',
  'codex',
  'vault',
  'txe-workflow',
  'wf',
  'uv',
  'ctx',
];

afterAll(async () => {
  await closeLinearClient();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('runEnvironmentChecks', () => {
  test(
    '本机：十一项按 Contracts 第 8 节的顺序返回，本机工具与路径通过',
    { timeout: 240_000 },
    async () => {
      const report = await runEnvironmentChecks(machine);
      expect(report.checks.map((c) => c.id)).toEqual(ids);
      const byId = new Map(report.checks.map((c) => [c.id, c]));
      expect(byId.get('claude')?.detail).toMatch(/\(Claude Code\)/);
      expect(byId.get('wf')?.detail).toMatch(/^wf \d/);
      expect(byId.get('uv')?.detail).toMatch(/^uv \d/);
      expect(byId.get('ctx')?.detail).toMatch(/^ctx \d/);
      expect(byId.get('txe-workflow')?.detail).toContain('个 skill');
      expect(byId.get('vault')?.detail).toContain('Project Magi Eval 可写');
      for (const id of ['claude', 'wf', 'uv', 'ctx', 'txe-workflow', 'vault']) {
        expect(byId.get(id)?.ok, id).toBe(true);
      }
      for (const check of report.checks) {
        expect(check.label).not.toBe('');
        expect(check.detail).not.toBe('');
        expect(check.fix).not.toBe('');
      }
      // 角色模型的检查发的是与 parseStructured 相同的 strict tool 请求，通过时 detail 为 respond 的内容
      for (const id of ['model-simulated-user', 'model-judge']) {
        const check = byId.get(id);
        expect(check?.detail, id).toMatch(check?.ok === true ? /respond：\S/ : /\S/);
      }
      // Codex 检查只写自己的 CODEX_HOME
      expect(fs.readdirSync(path.join(machine.workDir, 'codex-home'))).toContain('config.toml');
    },
  );

  test('未通过的项给出真实输出与具体的修复命令', { timeout: 240_000 }, async () => {
    const missingVault = path.join(work, 'vault');
    fs.mkdirSync(missingVault);
    const report = await runEnvironmentChecks({
      ...machine,
      // W4 中实际用到过的、gateway 上没有渠道的模型名
      models: () => ({ ...models, judge: 'claude-haiku-4-5-20251001-cc' }),
      vaultDir: missingVault,
      txeWorkflowRepo: path.join(work, 'no-such-repo'),
      ctxBin: path.join(work, 'no-such-ctx'),
      codexAuthPath: path.join(work, 'no-such-auth.json'),
      workDir: path.join(work, 'broken'),
    });
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    expect(byId.has('model-stage-check')).toBe(false);
    const judge = byId.get('model-judge');
    expect(judge?.ok).toBe(false);
    expect(judge?.label).toContain('claude-haiku-4-5-20251001-cc');
    expect(judge?.detail).toMatch(/No available channel/);
    expect(judge?.fix).toContain('为「评分（judge）」换一个模型');

    const vault = byId.get('vault');
    expect(vault?.ok).toBe(false);
    expect(vault?.detail).toBe(`${path.join(missingVault, 'Project Magi Eval')} 不存在`);
    expect(vault?.fix).toContain(`mkdir -p "${path.join(missingVault, 'Project Magi Eval')}"`);

    const repo = byId.get('txe-workflow');
    expect(repo?.ok).toBe(false);
    expect(repo?.detail).toMatch(/cannot change to|No such file/);
    expect(repo?.fix).toContain('git clone https://github.com/txehq/txe-workflow.git');

    const ctx = byId.get('ctx');
    expect(ctx?.ok).toBe(false);
    expect(ctx?.detail).toMatch(/ENOENT/);

    const codex = byId.get('codex');
    expect(codex?.ok).toBe(false);
    expect(codex?.detail).toMatch(/ENOENT.*no-such-auth\.json/);
    expect(codex?.fix).toContain('codex login');
  });
});

describe('GET /api/environment', () => {
  const dbFile = path.join(work, 'db.sqlite');
  const db = openDatabase(dbFile, config.migrationsDir);
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      db,
      sseHeartbeatMs: config.sseHeartbeatMs,
      logger: false,
      tasksDir: config.tasksDir,
    });
  });

  afterAll(async () => {
    await app.close();
    db.$client.close();
  });

  test('结果缓存，refresh=1 重新检查', { timeout: 240_000 }, async () => {
    const first = await app.inject({ method: 'GET', url: '/api/environment' });
    expect(first.statusCode).toBe(200);
    const report = first.json<{ checkedAt: number; checks: { id: string }[] }>();
    expect(report.checks.map((c) => c.id)).toEqual(ids);

    const cached = await app.inject({ method: 'GET', url: '/api/environment' });
    expect(cached.json<{ checkedAt: number }>().checkedAt).toBe(report.checkedAt);

    const refreshed = await app.inject({ method: 'GET', url: '/api/environment?refresh=1' });
    expect(refreshed.json<{ checkedAt: number }>().checkedAt).toBeGreaterThan(report.checkedAt);

    const invalid = await app.inject({ method: 'GET', url: '/api/environment?refresh=yes' });
    expect(invalid.statusCode).toBe(400);
  });

  test('Settings 改了角色模型后，下一次读取重新检查', { timeout: 240_000 }, async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/environment' })).json<{
      checkedAt: number;
    }>();
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json<{
      models: Record<string, string>;
    }>();
    // 模拟用户换成 opus 的别名（与默认的 sonnet 不同）
    const next = stripContextTag(claudeSettingsEnv().ANTHROPIC_DEFAULT_OPUS_MODEL);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...settings, models: { ...settings.models, simulatedUser: next } },
    });
    expect(saved.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/environment' })).json<{
      checkedAt: number;
      checks: { id: string; label: string }[];
    }>();
    expect(after.checkedAt).toBeGreaterThan(before.checkedAt);
    expect(after.checks.find((c) => c.id === 'model-simulated-user')?.label).toBe(
      `gateway：模拟用户模型 ${next}`,
    );
  });

  // 另一个页面的读取先开始了一次检查，检查进行中保存了新的角色模型：之后的读取不返回用旧模型的结果
  test('检查进行中改了角色模型，之后的读取用新模型重新检查', { timeout: 240_000 }, async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json<{
      models: Record<string, string>;
    }>();
    const old = settings.models.judge;
    const running = app.inject({ method: 'GET', url: '/api/environment?refresh=1' });
    const next = stripContextTag(claudeSettingsEnv().ANTHROPIC_DEFAULT_OPUS_MODEL);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...settings, models: { ...settings.models, judge: next } },
    });
    expect(saved.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/environment' })).json<{
      checks: { id: string; label: string }[];
    }>();
    const first = (await running).json<{ checks: { id: string; label: string }[] }>();
    expect(first.checks.find((c) => c.id === 'model-judge')?.label).toBe(
      `gateway：评分（judge）模型 ${String(old)}`,
    );
    expect(after.checks.find((c) => c.id === 'model-judge')?.label).toBe(
      `gateway：评分（judge）模型 ${next}`,
    );
  });
});
