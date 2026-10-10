import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { syncTasks } from '../src/tasks/loader.js';
import { importRun } from './import-run-lib.js';

// 用法：tsx scripts/import-run.ts <来源数据目录> <run id> [来源数据库，默认为数据目录下的 db.sqlite]
// 把另一个数据目录中一个已结束的 run 导入当前数据库（WFD_DATA_DIR / WFD_DB_PATH），见 import-run-lib.ts

const [dataDir, runId, dbPath] = process.argv.slice(2);
if (dataDir === undefined || runId === undefined) {
  throw new Error('用法：import-run.ts <来源数据目录> <run id> [来源数据库]');
}
const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const result = await importRun(
  db,
  { dataDir, ...(dbPath === undefined ? {} : { dbPath }) },
  runId,
  createSettingsStore(db).get().models.stageCheck,
  config.dataDir,
);
console.log(JSON.stringify(result));
db.$client.close();
