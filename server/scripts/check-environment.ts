import { config } from '../src/config.js';
import { runEnvironmentChecks } from '../src/environment.js';
import { closeLinearClient } from '../src/external/linear.js';
import { models } from '../src/llm/client.js';

// Run every GET /api/environment check once on this machine and print the result (bypassing the server and cache): tsx scripts/check-environment.ts
const report = await runEnvironmentChecks({
  models: () => models,
  vaultDir: config.vaultDir,
  vaultSource: config.vaultSource,
  product: config.evalProduct,
  txeWorkflowRepo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  codexAuthPath: config.codexAuthPath,
  codexConfigPath: config.codexConfigPath,
  workDir: config.environmentDir,
});
console.log(JSON.stringify(report, null, 2));
await closeLinearClient();
