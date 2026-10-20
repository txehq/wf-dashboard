import fs from 'node:fs';
import path from 'node:path';

// 基础档中 Claude Code 的替身（Contracts 22.2 的测试）：测试自己写出的最小可执行文件，只证明 PTY、sandbox 与
// resume 的串接，不验证 Claude Code 本身。启动时打出 argv、相关的环境变量，并试着写工作目录与 HOME 下的一个文件
// （sandbox 只允许前者）；之后把每段输入回显；收到 SIGINT 时退出
const source = `#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = (line) => process.stdout.write(line + '\\r\\n');
out('Claude Code 替身（W59 测试）');
out('argv ' + JSON.stringify(process.argv.slice(2)));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC') || k.startsWith('ORCA_AGENT') ||
    k === 'npm_config_cache' || k === 'HOME'),
);
out('env ' + JSON.stringify(env));
const tryWrite = (file) => {
  try {
    fs.writeFileSync(file, 'stand-in\\n');
    return 'ok';
  } catch (error) {
    return error.code;
  }
};
out('write-cwd ' + tryWrite(path.join(process.cwd(), 'stand-in-wrote.txt')));
out('write-home ' + tryWrite(path.join(os.homedir(), 'w59-stand-in-should-not-exist.txt')));
// mcp-remote 的登录目录可以写（Contracts 28.1）：写一个本进程的文件后立即删除
const mcpAuth = path.join(os.homedir(), '.mcp-auth');
const probe = path.join(mcpAuth, 'w83-stand-in-' + process.pid + '.txt');
const mcpWrite = (() => {
  try {
    fs.mkdirSync(mcpAuth, { recursive: true });
  } catch (error) {
    return error.code;
  }
  return tryWrite(probe);
})();
fs.rmSync(probe, { force: true });
out('write-mcp-auth ' + mcpWrite);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => out('key ' + JSON.stringify(data)));
process.on('SIGINT', () => process.exit(0));
`;

// 写到 dir 下并返回它的路径（可执行）
export function writeClaudeStandIn(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude-stand-in.mjs');
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}
