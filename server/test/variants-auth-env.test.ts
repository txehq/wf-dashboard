import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { claudeSettingsEnv } from '../src/llm/client.js';
import { createVariants } from '../src/variants/index.js';

// 真实构建一个 variant；认证 env 的来源是一份测试用 settings，不碰真实 ~/.claude/settings.json
const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const work = path.join(config.repoRoot, '.work', 'test-auth-env', randomUUID());
fs.mkdirSync(work, { recursive: true });
const source = path.join(work, 'settings.json');
const codexAuthPath = path.join(work, 'codex-auth.json');
const codexConfigPath = path.join(work, 'codex', 'config.toml');
const dbFile = path.join(work, 'db.sqlite');
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  claudeSettingsPath: source,
  codexAuthPath,
  codexConfigPath,
});

function writeSource(probe: string) {
  const env = { ...claudeSettingsEnv(), WFD_AUTH_PROBE: probe };
  fs.writeFileSync(source, JSON.stringify({ env }), { mode: 0o600 });
  fs.writeFileSync(codexAuthPath, JSON.stringify({ probe }), { mode: 0o644 });
  // 源 config.toml：模型配置与相对路径的模型目录
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(codexConfigPath), 'models.json'), `{"probe":"${probe}"}`);
  fs.writeFileSync(
    codexConfigPath,
    `model = "gpt-probe-${probe}"\nmodel_catalog_json = "models.json"\n`,
  );
}

const Isolated = z.looseObject({
  env: z.record(z.string(), z.string()),
  claudeMdExcludes: z.array(z.string()),
});

let variantId: string | undefined;

afterAll(() => {
  if (variantId !== undefined) fs.rmSync(variants.layout(variantId).dir, { recursive: true });
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('refreshAuthEnv', () => {
  test('修改源 settings 的 env 值与 Codex 凭据后刷新：只改认证，冻结的 variant 也可以，hash 不变', async () => {
    writeSource('v1');
    const base = await variants.createBaseline({
      name: `auth-env-${randomUUID().slice(0, 8)}`,
      model: 'sonnet',
      effort: 'low',
    });
    variantId = base.id;
    const built = await variants.build(base.id);
    const frozen = variants.freeze(built.id);
    const file = path.join(variants.layout(base.id).claudeDir, 'settings.json');
    const before = Isolated.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(before.env.WFD_AUTH_PROBE).toBe('v1');

    writeSource('v2');
    const merged = variants.refreshAuthEnv(base.id);
    expect(merged).toContain('WFD_AUTH_PROBE');
    const after = Isolated.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(after.env.WFD_AUTH_PROBE).toBe('v2');
    expect(after.claudeMdExcludes).toEqual(before.claudeMdExcludes);
    expect({ ...after, env: undefined }).toEqual({ ...before, env: undefined });
    // 原子写入不留下临时文件
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Codex 凭据复制进 variant 的 CODEX_HOME，权限 600
    const codexHome = variants.runtimeEnv(base.id).env.CODEX_HOME;
    const copied = path.join(codexHome, 'auth.json');
    expect(JSON.parse(fs.readFileSync(copied, 'utf8'))).toEqual({ probe: 'v2' });
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(codexHome).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Codex 的模型配置随源一起刷新进 variant 的 CODEX_HOME（键的取舍与模型目录副本见 codex-home.test.ts）
    const codexConfig = z
      .looseObject({ model: z.string(), model_catalog_json: z.string() })
      .parse(parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')));
    expect(codexConfig.model).toBe('gpt-probe-v2');
    expect(fs.readFileSync(codexConfig.model_catalog_json, 'utf8')).toBe('{"probe":"v2"}');
    expect(path.dirname(codexConfig.model_catalog_json)).toBe(codexHome);
    const row = variants.get(base.id);
    expect(row).toMatchObject({
      status: 'frozen',
      skillsHash: frozen.skillsHash,
      builtHash: frozen.builtHash,
    });
    expect(variants.runtimeEnv(base.id).env.CLAUDE_CONFIG_DIR).toBe(path.dirname(file));
  }, 900_000);
});
