import os from 'node:os';
import { execa } from 'execa';

// 服务以这个退出码结束时，pnpm start 的守护进程重新构建并启动（Contracts 23.5）
export const RESTART_EXIT_CODE = 75;

export interface DaemonOptions {
  cwd: string;
  build: string[];
  serve: string[];
  log: (line: string) => void;
}

// pnpm start 的守护进程：先构建再启动服务；服务以退出码 75 结束时重新构建并启动，其他退出码时以同样的退出码结束。
// 构建失败时以构建的退出码结束。守护进程收到 SIGINT 或 SIGTERM 时转给服务
export async function runDaemon(opts: DaemonOptions): Promise<number> {
  for (;;) {
    const [buildFile, ...buildArgs] = opts.build;
    const [serveFile, ...serveArgs] = opts.serve;
    if (buildFile === undefined || serveFile === undefined) throw new Error('构建或启动的命令为空');
    const build = await execa(buildFile, buildArgs, {
      cwd: opts.cwd,
      stdio: 'inherit',
      reject: false,
    });
    if (build.exitCode !== 0) {
      opts.log(`构建失败，退出码 ${String(build.exitCode)}`);
      return build.exitCode ?? 1;
    }
    const serve = execa(serveFile, serveArgs, { cwd: opts.cwd, stdio: 'inherit', reject: false });
    const forward = (signal: NodeJS.Signals) => {
      serve.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const result = await serve;
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    if (result.exitCode === RESTART_EXIT_CODE) {
      opts.log(`服务以退出码 ${String(RESTART_EXIT_CODE)} 结束：重新构建并启动`);
      continue;
    }
    // 被信号结束时按 shell 的习惯返回 128 加信号编号
    const code =
      result.exitCode ??
      (result.signal === undefined ? 1 : 128 + os.constants.signals[result.signal]);
    opts.log(`服务结束，退出码 ${String(code)}`);
    return code;
  }
}
