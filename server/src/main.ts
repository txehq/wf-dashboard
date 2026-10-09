import { buildApp } from './api/app.js';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { syncTasks } from './tasks/loader.js';

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: true,
  tasksDir: config.tasksDir,
});
await app.listen({ host: config.host, port: config.port });

// 关闭服务时先结束全部运行中的 claude 子进程
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
