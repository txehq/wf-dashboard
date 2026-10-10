import { config } from '../src/config.js';
import { runEnvironmentChecks } from '../src/environment.js';
import { closeLinearClient } from '../src/external/linear.js';
import { models } from '../src/llm/client.js';

// 在本机执行一次 GET /api/environment 的全部检查并打印结果（不经过服务与缓存）：tsx scripts/check-environment.ts
const report = await runEnvironmentChecks({
  models: () => models,
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  txeWorkflowRepo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  codexAuthPath: config.codexAuthPath,
  codexConfigPath: config.codexConfigPath,
  workDir: config.environmentDir,
});
console.log(JSON.stringify(report, null, 2));
await closeLinearClient();
