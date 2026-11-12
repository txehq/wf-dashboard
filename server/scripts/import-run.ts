import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { importRun } from './import-run-lib.js';

// Usage: tsx scripts/import-run.ts <source data dir> <run id> [source database, defaults to db.sqlite in the data dir]
// Import a finished run from another data dir into the current database (WFD_DATA_DIR / WFD_DB_PATH), see import-run-lib.ts

const [dataDir, runId, dbPath] = process.argv.slice(2);
if (dataDir === undefined || runId === undefined) {
  throw new Error('Usage: import-run.ts <source data dir> <run id> [source database]');
}
const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const result = importRun(
  db,
  { dataDir, ...(dbPath === undefined ? {} : { dbPath }) },
  runId,
  config.dataDir,
);
console.log(JSON.stringify(result));
db.$client.close();
