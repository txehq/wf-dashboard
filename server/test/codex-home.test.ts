import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { writeCodexHome } from '../src/variants/codex-home.js';

// 源目录模拟 ~/.codex：config.toml 里有模型配置以外的键与相对路径的 model_catalog_json
const work = path.join(config.repoRoot, '.work', 'test-codex-home', randomUUID());
const source = path.join(work, 'source');
const codexHome = path.join(work, 'home');
fs.mkdirSync(source, { recursive: true });

const sourceConfig = `model = "gpt-test"
model_reasoning_effort = "high"
model_provider = "gw"
approval_policy = "never"
model_catalog_json = "catalog/models.json"

[model_providers.gw]
name = "gateway"
base_url = "https://gateway.example/v1"
env_key = "GW_KEY"

[mcp_servers.linear]
command = "npx"
args = ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]

[projects."/Users/someone/repo"]
trust_level = "trusted"
`;
const catalog = JSON.stringify({ models: [{ slug: 'gpt-test' }] });
const auth = JSON.stringify({ OPENAI_API_KEY: 'sk-test' });

fs.writeFileSync(path.join(source, 'config.toml'), sourceConfig);
fs.mkdirSync(path.join(source, 'catalog'));
fs.writeFileSync(path.join(source, 'catalog/models.json'), catalog, { mode: 0o644 });
fs.writeFileSync(path.join(source, 'auth.json'), auth, { mode: 0o644 });

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe('writeCodexHome', () => {
  writeCodexHome(codexHome, {
    authPath: path.join(source, 'auth.json'),
    configPath: path.join(source, 'config.toml'),
  });

  test('只复制模型相关的键，model_providers 整表保留', () => {
    const written = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(written).sort()).toEqual([
      'model',
      'model_catalog_json',
      'model_provider',
      'model_providers',
      'model_reasoning_effort',
    ]);
    expect(written.model).toBe('gpt-test');
    expect(written.model_provider).toBe('gw');
    expect(written.model_reasoning_effort).toBe('high');
    expect(written.model_providers).toEqual({
      gw: { name: 'gateway', base_url: 'https://gateway.example/v1', env_key: 'GW_KEY' },
    });
  });

  test('model_catalog_json 指向的文件复制进 CODEX_HOME，路径改写为副本', () => {
    const written = parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')) as {
      model_catalog_json: string;
    };
    expect(written.model_catalog_json).toBe(path.join(codexHome, 'models.json'));
    expect(fs.readFileSync(written.model_catalog_json, 'utf8')).toBe(catalog);
  });

  test('auth.json 原样复制，全部文件权限 600，没有临时文件残留', () => {
    expect(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toBe(auth);
    expect(fs.readdirSync(codexHome).sort()).toEqual(['auth.json', 'config.toml', 'models.json']);
    for (const file of fs.readdirSync(codexHome))
      expect(mode(path.join(codexHome, file))).toBe(0o600);
  });
});
