import net from 'node:net';
import path from 'node:path';

// 评分用的隐藏测试配置。评分时本文件被复制到 checkout 之外，命令的 cwd 是 checkout，
// 所以项目根目录取 process.cwd()；从 checkout 之外无法解析 checkout 的 node_modules，这里只用 Node 内置模块

const root = process.cwd();

// 空闲端口在 runner 进程中选一次，worker 经环境变量继承；并发评分时各自不同
async function freePort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('没有拿到端口');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(address.port);
}

process.env.WF_HIDDEN_PORT ??= await freePort();
const baseURL = `http://127.0.0.1:${process.env.WF_HIDDEN_PORT}`;

export default {
  // testDir 取仓库根目录，JUnit 的 classname 才是相对仓库根目录的路径
  testDir: root,
  testMatch: 'test/hidden/**/*.spec.ts',
  outputDir: path.join(root, 'test-results', 'hidden'),
  retries: 0,
  fullyParallel: true,
  workers: 4,
  // 页面上缺少的控件会让操作一直等待，超时设短，起始仓库上的失败也能很快结束
  timeout: 15_000,
  expect: { timeout: 3_000 },
  use: { baseURL, actionTimeout: 3_000, browserName: 'chromium', headless: true },
  webServer: {
    command: `npx vite build --outDir dist-hidden --emptyOutDir && npx vite preview --outDir dist-hidden --host 127.0.0.1 --port ${process.env.WF_HIDDEN_PORT} --strictPort`,
    cwd: root,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
};
