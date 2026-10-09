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
