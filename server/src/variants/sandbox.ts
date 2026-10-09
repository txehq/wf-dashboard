import os from 'node:os';
import path from 'node:path';

// sandbox-exec 的 SBPL 字符串字面量
const literal = (value: string) => JSON.stringify(value);

// wf 命令的 profile：真实 home 下只允许写 variant 目录，越界写入的进程被 SIGKILL
export function wfSandboxProfile(variantDir: string): string {
  return (
    '(version 1)(allow default)' +
    `(deny file-write* (subpath ${literal(os.homedir())}) (with send-signal SIGKILL))` +
    `(allow file-write* (subpath ${literal(variantDir)}))`
  );
}

// claude 进程的 profile：禁止写真实的 Claude 配置、wf 状态、Codex 配置与 ~/.local/bin；
// claude、hook 与 MCP 子进程都继承这个限制
export function claudeSandboxProfile(): string {
  const home = os.homedir();
  const protectedDirs = [
    '.claude',
    'Library/Application Support/wf',
    'Library/Caches/wf',
    '.codex',
    '.local/bin',
  ];
  return (
    '(version 1)(allow default)' +
    protectedDirs
      .map(
        (dir) =>
          `(deny file-write* (subpath ${literal(path.join(home, dir))}) (with send-signal SIGKILL))`,
      )
      .join('') +
    `(deny file-write* (literal ${literal(path.join(home, '.claude.json'))}) (with send-signal SIGKILL))`
  );
}
