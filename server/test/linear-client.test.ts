import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { config } from '../src/config.js';

// W15 Medium 16 的复现：没有 token 文件时连接失败；以前失败的 promise 被缓存到进程结束，登录之后仍然报同样的错。
// 用一个空的 HOME（模块加载时按 HOME 定位 token 文件），不会真的启动 mcp-remote
const home = path.join(config.repoRoot, '.work/test-linear-home', String(process.pid));
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
const realHome = process.env.HOME;
process.env.HOME = home;
const linear = await import('../src/external/linear.js');

afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('连接失败不缓存：下一次调用重新连接', async () => {
  const first = linear.linearClient();
  await expect(first).rejects.toThrow('Linear 未登录');
  const second = linear.linearClient();
  expect(second).not.toBe(first);
  await expect(second).rejects.toThrow('Linear 未登录');
});
