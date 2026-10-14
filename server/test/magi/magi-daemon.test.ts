import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { RESTART_EXIT_CODE, runDaemon } from '../../src/magi-agent/daemon.js';

// pnpm start 的守护进程（Contracts 23.5），基础档：构建与服务换成两条 node 命令。构建每次在 builds 文件中记一行；
// 服务按 exits 文件中的退出码依次退出（每启动一次用掉一个）
const work = path.join(import.meta.dirname, '../../../.work/test-magi-daemon', randomUUID());
fs.mkdirSync(work, { recursive: true });
const builds = path.join(work, 'builds');
const exits = path.join(work, 'exits');
const build = (code: number) => [
  'node',
  '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(builds)}, 'build\\n'); process.exit(${String(code)})`,
];
const serve = [
  'node',
  '-e',
  `const fs = require('node:fs'); const [code, ...rest] = fs.readFileSync(${JSON.stringify(exits)}, 'utf8').trim().split(' '); fs.writeFileSync(${JSON.stringify(exits)}, rest.join(' ')); process.exit(Number(code))`,
];

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const buildCount = () => fs.readFileSync(builds, 'utf8').trim().split('\n').length;

function daemon(buildCode = 0) {
  const lines: string[] = [];
  return {
    lines,
    run: runDaemon({
      build: { command: build(buildCode), cwd: work },
      serve: { command: serve, cwd: work },
      log: (l) => lines.push(l),
    }),
  };
}

test('服务以退出码 75 结束时重新构建并启动；其他退出码时守护进程以同样的退出码结束', async () => {
  fs.rmSync(builds, { force: true });
  fs.writeFileSync(exits, `${String(RESTART_EXIT_CODE)} ${String(RESTART_EXIT_CODE)} 0`);
  const d = daemon();
  expect(await d.run).toBe(0);
  expect(buildCount()).toBe(3);
  expect(d.lines.filter((l) => l.includes('重新构建并启动'))).toHaveLength(2);

  fs.rmSync(builds, { force: true });
  fs.writeFileSync(exits, '3');
  expect(await daemon().run).toBe(3);
  expect(buildCount()).toBe(1);
});

test('构建失败时以构建的退出码结束，不启动服务', async () => {
  fs.rmSync(builds, { force: true });
  fs.writeFileSync(exits, '0');
  const d = daemon(2);
  expect(await d.run).toBe(2);
  expect(buildCount()).toBe(1);
  // 服务没有启动：exits 中的退出码没有被用掉
  expect(fs.readFileSync(exits, 'utf8')).toBe('0');
});
