import os from 'node:os';
import { execa } from 'execa';

// When the service exits with this code, the pnpm start supervisor rebuilds and restarts it (Contracts 23.5)
export const RESTART_EXIT_CODE = 75;

export interface DaemonOptions {
  build: { command: string[]; cwd: string };
  // The service command runs node directly: run through pnpm, any non-zero exit code becomes 1 and 75 is lost
  serve: { command: string[]; cwd: string };
  log: (line: string) => void;
}

// The pnpm start supervisor: builds, then starts the service; when the service exits with 75 it rebuilds and restarts,
// with any other code it exits with the same code. A failed build exits with the build's code. SIGINT and SIGTERM to
// the supervisor are forwarded to the service
export async function runDaemon(opts: DaemonOptions): Promise<number> {
  for (;;) {
    const [buildFile, ...buildArgs] = opts.build.command;
    const [serveFile, ...serveArgs] = opts.serve.command;
    if (buildFile === undefined || serveFile === undefined)
      throw new Error('The build or start command is empty');
    const build = await execa(buildFile, buildArgs, {
      cwd: opts.build.cwd,
      stdio: 'inherit',
      reject: false,
    });
    if (build.exitCode !== 0) {
      opts.log(`Build failed, exit code ${String(build.exitCode)}`);
      return build.exitCode ?? 1;
    }
    const serve = execa(serveFile, serveArgs, {
      cwd: opts.serve.cwd,
      stdio: 'inherit',
      reject: false,
    });
    const forward = (signal: NodeJS.Signals) => {
      serve.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const result = await serve;
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    if (result.exitCode === RESTART_EXIT_CODE) {
      opts.log(`Service exited with code ${String(RESTART_EXIT_CODE)}: rebuilding and restarting`);
      continue;
    }
    // Killed by a signal: return 128 plus the signal number, as shells do
    const code =
      result.exitCode ??
      (result.signal === undefined ? 1 : 128 + os.constants.signals[result.signal]);
    opts.log(`Service exited, exit code ${String(code)}`);
    return code;
  }
}
