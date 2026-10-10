import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { runs } from '../src/db/schema.js';
import { scanCrossRunRefs } from '../src/runs/cross-run-refs.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { syncTasks } from '../src/tasks/loader.js';
import { importRun, isImported, repairImportedVariants } from './import-run-lib.js';

// 用法：WFD_DATA_DIR=.work/e2e/runs-data tsx scripts/prepare-runs-e2e.ts
// Runs 页面 e2e 的数据目录：导入 W4 端到端留下的四个已结束的 run（已评分的 lfg 与 ic、因 GitHub EOF 失败的 ic、
// 更早一次 ic），之后重新扫描运行之间的参考；
// 并复制已编译的 wf runtime，测试中构建 variant 时不必重新编译。已导入的 run 跳过。

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：e2e 数据目录不能是 data/');
}

// W4 的 worktree：端到端运行的数据留在那里
const w4 = '/Users/linhaoz/orca/workspaces/wf-dashboard/wfd-w4';
const sources = [
  { runId: 'r-20261009-dqva52', dataDir: path.join(w4, 'data') },
  {
    runId: 'r-20261009-a26chw',
    dataDir: path.join(w4, '.work/data-ic'),
    dbPath: path.join(w4, 'server/.work/data-ic/db-v3.sqlite'),
  },
  {
    runId: 'r-20261009-780j7l',
    dataDir: path.join(w4, '.work/data-ic'),
    dbPath: path.join(w4, 'server/.work/data-ic/db-v3.sqlite'),
  },
  // a26chw 之前同一 task 的 ic run（工单 TXE-3767）
  { runId: 'r-20261009-27yz3d', dataDir: path.join(w4, '.work/data-ic') },
];

const runtimes = path.join(config.dataDir, 'runtimes');
if (!fs.existsSync(runtimes)) {
  fs.cpSync(path.join(w4, 'data/runtimes'), runtimes, { recursive: true });
}

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const stageCheck = createSettingsStore(db).get().models.stageCheck;
for (const { runId, ...from } of sources) {
  if (isImported(db, runId)) continue;
  console.log(JSON.stringify(await importRun(db, from, runId, stageCheck, config.dataDir)));
}
// 全部导入后按 runs 模块在 run 结束时的做法重新扫描运行之间的参考（Contracts 7.11）
for (const { runId } of sources) {
  const refs = scanCrossRunRefs(db, runId);
  db.update(runs).set({ crossRunRefs: refs }).where(eq(runs.id, runId)).run();
  console.log(JSON.stringify({ runId, crossRunRefs: refs.length }));
}
db.$client.close();
// 早先导入时没有复制 variant 的内容：补齐 skills 与基线导出
const repaired = repairImportedVariants(config.dbPath, config.dataDir, [
  ...new Set(sources.map((s) => s.dataDir)),
]);
console.log(JSON.stringify(repaired.filter((r) => r.copied.length > 0)));
