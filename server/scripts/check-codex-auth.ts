import { execa } from 'execa';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createVariants } from '../src/variants/index.js';

// 刷新 variant 的认证后，在 variant 环境下确认 codex 已登录
// 用法：WFD_DATA_DIR=... tsx scripts/check-codex-auth.ts <variantId>
const id = process.argv[2];
if (id === undefined) throw new Error('用法：tsx scripts/check-codex-auth.ts <variantId>');
const db = openDatabase(config.dbPath, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
variants.refreshAuthEnv(id);
const runtime = variants.runtimeEnv(id);
const result = await execa('codex', ['login', 'status'], { env: runtime.env, extendEnv: false });
console.log(`CODEX_HOME=${runtime.env.CODEX_HOME}`);
console.log(result.stdout || result.stderr);
db.$client.close();
