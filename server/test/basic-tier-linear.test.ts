import fs from 'node:fs';
import { afterAll, expect, test } from 'vitest';
import { closeLinearClient, linearLoggedIn } from '../src/external/linear.js';
import { runEnvironmentChecks } from '../src/environment.js';
import { config } from '../src/config.js';
import { models } from '../src/llm/client.js';
import { blockedLog } from './setup/basic-tier.js';

// 基础档不依赖网络（test/setup/basic-bin/offline/npx）：Linear MCP 的 mcp-remote 不启动，
// 环境检查的 Linear 一项以屏蔽的原文失败，调用记在 blocked.log
afterAll(async () => {
  await closeLinearClient();
});

test('基础档中 Linear MCP 被屏蔽：环境检查的 Linear 一项以屏蔽的原文失败，不连网', async () => {
  // 本机已登录 Linear：没有屏蔽时这一项会真实连接 mcp.linear.app
  expect(linearLoggedIn()).toBe(true);
  const before = fs.existsSync(blockedLog) ? fs.readFileSync(blockedLog, 'utf8').length : 0;
  const report = await runEnvironmentChecks({
    models: () => models,
    vaultDir: config.vaultDir,
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
