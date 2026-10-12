import path from 'node:path';
import { execaSync } from 'execa';

// 测试进程（vitest 的 worker、Playwright 启动的服务及其子进程）的 PATH 最前面放 test/setup/bin/gh：
// 在 GitHub 上创建或修改对象的 gh 命令以原文报错，其余交给真实的 gh。只设置一次，嵌套调用时不再改
const bin = path.resolve(import.meta.dirname, 'bin');

export function guardGithub() {
  if (process.env.WFD_REAL_GH !== undefined) return;
  const real = execaSync('which', ['gh']).stdout.trim();
  if (path.dirname(real) === bin) throw new Error(`PATH 中的 gh 已是测试用的包装：${real}`);
  process.env.WFD_REAL_GH = real;
  process.env.PATH = `${bin}${path.delimiter}${String(process.env.PATH)}`;
}

// vitest 的 globalSetup：在启动任何 worker 之前生效
export function setup() {
  guardGithub();
}
