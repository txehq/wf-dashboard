import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from './api/app.js';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { RESTART_EXIT_CODE } from './magi-agent/daemon.js';
import { syncTasks } from './tasks/loader.js';

// pnpm start 传入 --web <web/dist>：同一个端口提供 API 与构建好的页面；pnpm dev 不传，页面由 Vite 提供
const { values } = parseArgs({ options: { web: { type: 'string' } } });
const webDir = values.web === undefined ? undefined : path.resolve(values.web);
if (webDir !== undefined && !fs.existsSync(path.join(webDir, 'index.html'))) {
  throw new Error(`${webDir} 中没有 index.html，先运行 pnpm build`);
}

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: true,
  tasksDir: config.tasksDir,
  webDir,
  localHome: config.localHome,
  // Magi Agent 部署后（Contracts 23.5）：结束全部子进程后以退出码 75 结束，pnpm start 的守护进程重新构建并启动
  onRestart: () => {
    void app.close().then(() => process.exit(RESTART_EXIT_CODE));
  },
});
await app.listen({ host: config.host, port: config.port });

// 关闭服务时先结束全部运行中的 claude 子进程
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
