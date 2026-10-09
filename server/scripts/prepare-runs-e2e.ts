import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { syncTasks } from '../src/tasks/loader.js';
import { importRun, isImported } from './import-run-lib.js';

// 用法：WFD_DATA_DIR=.work/runs-e2e-data tsx scripts/prepare-runs-e2e.ts
// Runs 页面 e2e 的数据目录：导入 W4 端到端留下的三个已结束的 run（已评分的 lfg 与 ic、因 GitHub EOF 失败的 ic），
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
  console.log(JSON.stringify(await importRun(db, from, runId, stageCheck)));
}
db.$client.close();
