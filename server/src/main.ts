import { buildApp } from './api/app.js';
import { config } from './config.js';
import { openDatabase } from './db/index.js';

const db = openDatabase(config.dbPath, config.migrationsDir);
const app = await buildApp({ db, sseHeartbeatMs: config.sseHeartbeatMs, logger: true });
await app.listen({ host: config.host, port: config.port });
