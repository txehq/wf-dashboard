import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { LivePty } from '../../src/live/pty.js';

// W81：进程退出与 resize、write、kill 交错。node-pty 在进程退出时先关闭 PTY（fd 已关闭），之后才有 onExit；
// 这中间的 resize 曾经抛出 EBADF，没有处理，整个服务退出。基础档：真实的 PTY 与进程
const work = path.join(import.meta.dirname, '../../../.work/test-pty-exit-race', randomUUID());
fs.mkdirSync(work, { recursive: true });
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

// 一个立即退出的进程；直到 exited 完成之前，每一轮事件循环都调用一次 operate
async function race(operate: (pty: LivePty, turn: number) => void) {
  const pty = new LivePty({
    file: '/bin/sh',
    args: ['-c', 'exit 0'],
    cwd: work,
    env: { PATH: process.env.PATH ?? '' },
    cols: 80,
    rows: 24,
    logFile: path.join(work, `${randomUUID()}.log`),
    separator: 'start\r\n',
  });
  const state = { exited: false };
  void pty.exited.then(() => {
    state.exited = true;
  });
  let turn = 0;
  while (!state.exited) {
    // write 在 onExit 之后照常抛出（调用方应先看 alive），只在进程还算活着时调用
    if (pty.alive) operate(pty, turn);
    turn += 1;
    await nextTurn();
  }
  expect((await pty.exited).exitCode).toBe(0);
}

const runs = 30;

test('进程退出时连续 resize：不抛出', async () => {
  for (let i = 0; i < runs; i++) {
    await race((pty, turn) => {
      pty.resize(80 + (turn % 2), 24);
    });
  }
});

test('进程退出时连续写入与 kill：不抛出', async () => {
  for (let i = 0; i < runs; i++) {
    await race((pty, turn) => {
      pty.write('x');
      if (turn % 2 === 1) pty.kill('SIGHUP');
    });
  }
});
