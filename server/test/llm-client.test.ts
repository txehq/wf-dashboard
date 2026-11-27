import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

// The gateway settings are read on first use, not at import or startup (WF Dashboard could not start on a machine
// whose ~/.claude/settings.json had no ANTHROPIC_AUTH_TOKEN or model aliases): HOME points at an empty directory before
// the client module loads
const home = path.resolve(import.meta.dirname, '../../.work/test-llm-client', String(process.pid));
const realHome = process.env.HOME;

beforeAll(() => {
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function settingsFile(name: string, value: unknown): string {
  const file = path.join(home, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('importing the client does not read the gateway settings', async () => {
  const client = await import('../src/llm/client.js');
  expect(client.models.judge).toBe(client.DEFAULT_ROLE_MODEL);
});

test('a gateway call without a credential fails at call time, naming the keys to set', async () => {
  const { anthropic, parseStructured } = await import('../src/llm/client.js');
  const { z } = await import('zod');
  expect(() => anthropic()).toThrow(
    /No gateway credential in .*settings\.json: set env\.ANTHROPIC_AUTH_TOKEN/,
  );
  await expect(
    parseStructured({
      model: 'claude-sonnet-5-5',
      system: 's',
      user: 'u',
      schema: z.object({ reply: z.string() }),
      maxTokens: 10,
      role: null,
    }),
  ).rejects.toThrow(/No gateway credential/);
});

test('claudeSettingsEnv: no file or no env block is an empty env; other env kept as is', async () => {
  const { claudeSettingsEnv } = await import('../src/llm/client.js');
  expect(claudeSettingsEnv(path.join(home, 'missing.json'))).toEqual({});
  expect(claudeSettingsEnv(settingsFile('no-env.json', { model: 'opus' }))).toEqual({});
  const env = { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: 'k', EXTRA: '1' };
  expect(claudeSettingsEnv(settingsFile('api-key.json', { env }))).toEqual(env);
  expect(() => claudeSettingsEnv(settingsFile('broken.json', '{'))).toThrow(/is not valid JSON/);
});

test('gatewayCredentials prefers ANTHROPIC_AUTH_TOKEN and falls back to ANTHROPIC_API_KEY', async () => {
  const { gatewayCredentials } = await import('../src/llm/client.js');
  const both = settingsFile('both.json', {
    env: { ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' },
  });
  expect(gatewayCredentials(both)).toEqual({ baseURL: 'https://g', authToken: 't', apiKey: null });
  const key = settingsFile('key.json', { env: { ANTHROPIC_API_KEY: 'k' } });
  expect(gatewayCredentials(key)).toEqual({ baseURL: undefined, authToken: null, apiKey: 'k' });
});

test('modelChoices shows the alias when settings.json has no model name for it', async () => {
  const { modelChoices } = await import('../src/variants/models.js');
  writeFileSync(
    path.join(home, '.claude/settings.json'),
    JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' } }),
  );
  const choices = modelChoices();
  expect(choices.find((c) => c.alias === 'opus')?.model).toBe('claude-opus-5-5');
  expect(choices.find((c) => c.alias === 'sonnet')?.model).toBe('sonnet');
});

test('a variant config gets whatever env settings.json has, even without the gateway keys', async () => {
  const { writeIsolatedSettings } = await import('../src/variants/claude-config.js');
  const claudeDir = path.join(home, 'variant-claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { KEEP: '1' } }));
  const source = settingsFile('partial.json', {
    env: { ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_API_KEY: 'k' },
  });
  expect(writeIsolatedSettings(claudeDir, source)).toEqual([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
  ]);
  const written: unknown = JSON.parse(readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  expect(written).toEqual({
    env: { KEEP: '1', ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_API_KEY: 'k' },
  });
});
