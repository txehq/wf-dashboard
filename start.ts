import { runDaemon } from './server/src/magi-agent/daemon.js';

// pnpm start（Contracts 23.5）：守护进程先构建再启动服务；Magi Agent 部署后服务以退出码 75 结束，这里重新构建并启动
const code = await runDaemon({
  cwd: import.meta.dirname,
  build: ['pnpm', 'build'],
  serve: ['pnpm', '--filter', '@wf-dashboard/server', 'start'],
  log: (line) => {
    console.log(`[pnpm start] ${line}`);
  },
});
process.exit(code);
