import path from 'node:path';
import { runDaemon } from './server/src/magi-agent/daemon.js';

// pnpm start（Contracts 23.5）：守护进程先构建再启动服务；Magi Agent 部署后服务以退出码 75 结束，这里重新构建并启动。
// 服务的命令与 server 的 start 脚本相同
const code = await runDaemon({
  build: { command: ['pnpm', 'build'], cwd: import.meta.dirname },
  serve: {
    command: ['node', 'dist/main.js', '--web', '../web/dist'],
    cwd: path.join(import.meta.dirname, 'server'),
  },
  log: (line) => {
    console.log(`[pnpm start] ${line}`);
  },
});
process.exit(code);
