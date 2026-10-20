import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { runs } from '../src/db/schema.js';
import { restoreCleared } from '../src/ingest/imports.js';
import { scanCrossRunRefs } from '../src/runs/cross-run-refs.js';
import { syncTasks } from '../src/tasks/loader.js';
import { resetOnMigrationChange } from './e2e-data-dir.js';
import { importRun, isImported, repairImportedVariants } from './import-run-lib.js';
import { samplesDir } from '../test/stages/samples.js';
import { unpackW4Data } from '../test/helpers/w4-data.js';

// 用法：WFD_DATA_DIR=.work/e2e/runs-data WFD_CLAUDE_PROJECTS=.work/e2e/runs-projects tsx scripts/prepare-runs-e2e.ts
// Runs 页面 e2e 的数据目录：导入 W4 端到端留下的四个已结束的 run（已评分的 lfg 与 ic、因 GitHub EOF 失败的 ic、
// 更早一次 ic；来源是 test/fixtures/w4，每次解压到 .work/e2e/runs-w4），之后重新扫描运行之间的参考。已导入的 run 跳过；
// 数据库中执行过的迁移与仓库中的不一致时先删除整个数据目录（e2e-data-dir.ts）。
// 本机配置（WFD_CLAUDE_PROJECTS）中放入真实 session f0aca373（test/fixtures/samples），详情页的对话区用例导入它

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：e2e 数据目录不能是 data/');
}
if (process.env.WFD_CLAUDE_PROJECTS === undefined) {
  throw new Error('WFD_CLAUDE_PROJECTS 未设置：e2e 的来源目录不能是 ~/.claude/projects');
}

const sources = unpackW4Data(path.join(config.repoRoot, '.work/e2e/runs-w4'));

const slug = '-Users-linhaoz-Project-txe-txe-workflow';
const f0 = 'f0aca373-863f-4d62-babd-f48055092328';
fs.rmSync(config.claudeProjectsDir, { recursive: true, force: true });
fs.mkdirSync(path.join(config.claudeProjectsDir, slug), { recursive: true });
fs.copyFileSync(
  path.join(samplesDir, slug, `${f0}.jsonl`),
  path.join(config.claudeProjectsDir, slug, `${f0}.jsonl`),
);
fs.cpSync(path.join(samplesDir, slug, f0), path.join(config.claudeProjectsDir, slug, f0), {
  recursive: true,
});

resetOnMigrationChange(config.dataDir, config.dbPath, config.migrationsDir);

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
for (const { runId, ...from } of sources) {
  if (isImported(db, runId)) continue;
  console.log(JSON.stringify(importRun(db, from, runId, config.dataDir)));
}
// 全部导入后按 runs 模块在 run 结束时的做法重新扫描运行之间的参考（Contracts 7.11）。
// 数据目录保留在多次运行之间：上一次运行中途结束时，runs.spec 标为无效的 run 没有恢复，这里每次清除；
// runs.spec 清除的 run 的 session（它们的文件不在这个数据目录的任何配置中，不能从上面重新导入）每次放回管理表格
for (const { runId } of sources) {
  const refs = scanCrossRunRefs(db, runId);
  db.update(runs).set({ crossRunRefs: refs, invalidReason: null }).where(eq(runs.id, runId)).run();
  const run = db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`run ${runId} 没有导入`);
  restoreCleared(db, run.sessionId);
  console.log(JSON.stringify({ runId, crossRunRefs: refs.length }));
}
db.$client.close();
// 早先导入时没有复制 variant 的内容：补齐 skills 与基线导出
const repaired = repairImportedVariants(config.dbPath, config.dataDir, [
  ...new Set(sources.map((s) => s.dataDir)),
]);
console.log(JSON.stringify(repaired.filter((r) => r.copied.length > 0)));
