import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from './api/app.js';
import { config, install } from './config.js';
import { openDatabase } from './db/index.js';
import { prepareInstall } from './install/index.js';
import { type SessionTail, startSessionTail } from './ingest/session-import.js';
import { defaultSourceDirs } from './ingest/sources.js';
import { RESTART_EXIT_CODE } from './magi-agent/daemon.js';
import { syncTasks } from './tasks/loader.js';

// pnpm start passes --web <web/dist>: one port serves the API and the built pages; pnpm dev omits it and Vite serves the pages
const { values } = parseArgs({ options: { web: { type: 'string' } } });
const webDir = values.web === undefined ? undefined : path.resolve(values.web);
if (webDir !== undefined && !fs.existsSync(path.join(webDir, 'index.html'))) {
  throw new Error(`No index.html in ${webDir}; run pnpm build first`);
}

const db = openDatabase(config.dbPath, config.migrationsDir);
// An installed package (Contracts 39): tasks live in data/tasks/, older versions under app/ are removed
if (install !== null) {
  prepareInstall(install, { bundled: config.bundledTasksDir, data: config.tasksDir });
}
syncTasks(db, config.tasksDir);
// Incremental import of imported sessions and new sessions in the dashboard's own config (Contracts 25.1), started after listening
const running: { tail?: SessionTail } = {};
// Stop the incremental import first, then stop all running child processes and close the server
const shutdown = (code: number) => {
  running.tail?.close();
  void app.close().then(() => process.exit(code));
};
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: true,
  tasksDir: config.tasksDir,
  webDir,
  releaseCheck: true,
  scheduledTeamSync: true,
  selfUpdate: true,
  // After a Magi Agent deploy (Contracts 23.5) or a switch to an updated package (39.4): stop all child processes, then
  // exit with code 75; the pnpm start daemon rebuilds and restarts, launchd starts the installed service again
  onRestart: () => {
    shutdown(RESTART_EXIT_CODE);
  },
});
await app.listen({ host: config.host, port: config.port });

// An error in one session during incremental import affects only that session (its text is recorded and shown in Sessions);
// an error not tied to a session (e.g. a config directory cannot be read) stops the server (fast-fail)
running.tail = startSessionTail(db, defaultSourceDirs, (error) => {
  console.error('[sessions] Incremental import failed', error);
  shutdown(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown(0);
  });
}
