import path from 'node:path';
import { runDaemon } from './server/src/magi-agent/daemon.js';

// pnpm start (Contracts 23.5): the daemon builds, then starts the server. After a Magi Agent deploy the server exits with code 75 and the daemon rebuilds and restarts it.
// The serve command is the same as the server package's start script. UV_THREADPOOL_SIZE: every asynchronous filesystem
// call holds a libuv thread, and a path macOS protects holds it until the user answers; the default 4 threads would let
// a few such paths stop all other file access (W139)
const code = await runDaemon({
  build: { command: ['pnpm', 'build'], cwd: import.meta.dirname },
  serve: {
    command: ['env', 'UV_THREADPOOL_SIZE=64', 'node', 'dist/main.js', '--web', '../web/dist'],
    cwd: path.join(import.meta.dirname, 'server'),
  },
  log: (line) => {
    console.log(`[pnpm start] ${line}`);
  },
});
process.exit(code);
