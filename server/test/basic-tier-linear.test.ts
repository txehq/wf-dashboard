import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { models } from '../src/llm/client.js';
import { blockedLog } from './setup/basic-tier.js';

// 基础档不依赖网络（test/setup/basic-bin/offline/npx）：Linear MCP 的 mcp-remote 不启动，
// 环境检查的 Linear 一项以屏蔽的原文失败，调用记在 blocked.log。
// 已登录 Linear 时没有屏蔽这一项会真实连接 mcp.linear.app：用一个测试自己的 HOME（模块加载时按 HOME 定位 token 文件），
// 其中有 mcp-remote 的 token 文件，没有登录 Linear 的机器上也是已登录的状态；token 不会被读取
const home = path.join(config.repoRoot, '.work/test-linear-blocked-home', String(process.pid));
const tokens = path.join(
  home,
  '.mcp-auth/mcp-remote-v1',
  `${createHash('md5').update('https://mcp.linear.app/mcp').digest('hex')}_tokens.json`,
);
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.dirname(tokens), { recursive: true });
fs.writeFileSync(tokens, '{}\n');
const realHome = process.env.HOME;
process.env.HOME = home;
const { closeLinearClient, linearLoggedIn } = await import('../src/external/linear.js');
const { runEnvironmentChecks } = await import('../src/environment.js');

afterAll(async () => {
  await closeLinearClient();
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('基础档中 Linear MCP 被屏蔽：环境检查的 Linear 一项以屏蔽的原文失败，不连网', async () => {
  expect(linearLoggedIn()).toBe(true);
  const before = fs.existsSync(blockedLog) ? fs.readFileSync(blockedLog, 'utf8').length : 0;
  const report = await runEnvironmentChecks({
    models: () => models,
    vaultDir: config.vaultDir,
    vaultSource: config.vaultSource,
    product: config.evalProduct,
    txeWorkflowRepo: config.txeWorkflowRepo,
    ctxBin: config.ctxBin,
    codexAuthPath: config.codexAuthPath,
    codexConfigPath: config.codexConfigPath,
    workDir: config.dataDir,
  });
  const linear = report.checks.find((c) => c.id === 'linear');
  expect(linear?.ok).toBe(false);
  expect(linear?.detail).toContain(
    '基础档不允许连接 Linear MCP（不依赖网络）：npx -y mcp-remote https://mcp.linear.app/mcp',
  );
  const logged = fs.readFileSync(blockedLog, 'utf8').slice(before);
  expect(logged).toContain('npx -y mcp-remote https://mcp.linear.app/mcp');
});
