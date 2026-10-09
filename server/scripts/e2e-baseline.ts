import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { variants as variantsTable } from '../src/db/schema.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';

// 端到端运行用的基线 variant：txe-workflow HEAD，opus / high；已构建时直接复用
// 用法：tsx scripts/e2e-baseline.ts [name]
const name = process.argv[2] ?? 'e2e-baseline';
const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});

let row = db.select().from(variantsTable).where(eq(variantsTable.name, name)).get();
row ??= await variants.createBaseline({ name, model: 'opus', effort: 'high' });
if (row.buildStatus !== 'built' || row.builtHash !== row.skillsHash) {
  const started = performance.now();
  row = await variants.build(row.id);
  console.log(`构建用时 ${String(Math.round(performance.now() - started))}ms`);
}
const { id, version, status } = row;
console.log(JSON.stringify({ id, name, version, status }));
db.$client.close();
