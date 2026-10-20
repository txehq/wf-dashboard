import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config.js';

// vault 的位置（Contracts 第 30 节）：MAGI_VAULT 非空时取它（展开 ~，转为绝对路径），否则为 txe-workflow 的默认值
// ~/Projects/Obsidian/TXE。config 在服务启动时读一次，所以每种情形在新进程中读取（test/helpers/vault-probe.ts）
const work = path.join(config.repoRoot, '.work', 'test-vault-location', randomUUID());
const home = path.join(work, 'home');
fs.mkdirSync(home, { recursive: true });
const probe = path.join(import.meta.dirname, 'helpers/vault-probe.ts');

const Probe = z.object({
  vaultDir: z.string(),
  vaultSource: z.enum(['MAGI_VAULT', '默认']),
  check: z.object({ id: z.string(), ok: z.boolean(), detail: z.string(), fix: z.string() }),
  runEnv: z.string(),
  agentEnv: z.string(),
});

async function run(magiVault: string | undefined, cwd = work) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  if (magiVault === undefined) delete env.MAGI_VAULT;
  else env.MAGI_VAULT = magiVault;
  const result = await execa('tsx', [probe], { cwd, env, extendEnv: false, preferLocal: true });
  return Probe.parse(JSON.parse(result.stdout));
}

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('vault 的位置取自 MAGI_VAULT', { timeout: 60_000 }, () => {
  test('MAGI_VAULT 设为某个目录：位置、来源、环境检查与传给 agent 的 MAGI_VAULT 都是它', async () => {
    const vault = path.join(work, 'My Vault');
    fs.mkdirSync(path.join(vault, `Project ${config.evalProduct}`, 'Features', 'r-1'), {
      recursive: true,
    });
    const got = await run(vault);
    expect(got.vaultDir).toBe(vault);
    expect(got.vaultSource).toBe('MAGI_VAULT');
    expect(got.check).toMatchObject({
      id: 'vault',
      ok: true,
      detail: `${vault}（来自 MAGI_VAULT），Project Magi Eval/ 可写，Features/ 下 1 个目录`,
    });
    expect(got.runEnv).toBe(vault);
    expect(got.agentEnv).toBe(vault);
  });

  test('没有设或为空：txe-workflow 的默认值 ~/Projects/Obsidian/TXE，来源为默认', async () => {
    const fallback = path.join(home, 'Projects/Obsidian/TXE');
    for (const value of [undefined, '']) {
      const got = await run(value);
      expect(got.vaultDir).toBe(fallback);
      expect(got.vaultSource).toBe('默认');
      expect(got.runEnv).toBe(fallback);
      expect(got.agentEnv).toBe(fallback);
      // vault 不存在：修复方法是在 shell 的配置文件中 export MAGI_VAULT
      expect(got.check.ok).toBe(false);
      expect(got.check.detail).toBe(`${fallback}（默认，没有设 MAGI_VAULT）：不存在`);
      expect(got.check.fix).toContain("export MAGI_VAULT='<vault 路径>'");
      expect(got.check.fix).toContain('重新打开终端后重启 dashboard');
    }
  });

  test('~ 展开为 HOME，相对路径转为绝对路径', async () => {
    expect((await run('~/Notes/TXE')).vaultDir).toBe(path.join(home, 'Notes/TXE'));
    expect((await run('~')).vaultDir).toBe(home);
    expect((await run('notes', home)).vaultDir).toBe(path.join(home, 'notes'));
  });
});
