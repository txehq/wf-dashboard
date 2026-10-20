import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from './api/app.js';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { type SessionTail, startSessionTail } from './ingest/session-import.js';
import { defaultSourceDirs } from './ingest/sources.js';
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
// 已导入的 session 与 dashboard 自己的配置中新出现的 session 的增量导入（Contracts 25.1），服务监听后开始
const running: { tail?: SessionTail } = {};
// 先停止增量导入，再结束全部运行中的子进程、关闭服务
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
  localHome: config.localHome,
  releaseCheck: config.releaseCheck,
  // Magi Agent 部署后（Contracts 23.5）：结束全部子进程后以退出码 75 结束，pnpm start 的守护进程重新构建并启动
  onRestart: () => {
    shutdown(RESTART_EXIT_CODE);
  },
});
await app.listen({ host: config.host, port: config.port });

// 增量导入出错时服务退出（fast-fail）
running.tail = startSessionTail(db, defaultSourceDirs, (error) => {
  console.error('[sessions] 增量导入失败', error);
  shutdown(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown(0);
  });
}
