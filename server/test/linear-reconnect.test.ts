import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config.js';
import { createEnvironment } from '../src/environment.js';
import {
  callLinear,
  closeLinearClient,
  EVAL_TEAM,
  hasLinearConnection,
  linearConnectionPid,
} from '../src/external/linear.js';
import { models } from '../src/llm/client.js';

// W24：dashboard 进程内的长期 Linear 连接断开之后（mcp-remote 子进程退出、网络中断后每次调用都返回
// transport 层错误），丢弃这个连接，下一次调用新建；当次调用照常以原文失败。全部是真实的 mcp-remote 与 Linear
const Teams = z.object({ teams: z.array(z.object({ key: z.string() }).loose()) }).loose();
const keys = async () => (await callLinear('list_teams', {}, Teams)).teams.map((t) => t.key);

// npx -y mcp-remote 由 npx 再启动 mcp-remote 的 node 进程：结束整棵进程树，stdio 管道才会关闭。
// pgrep 没有子进程时退出码为 1
function killTree(pid: number) {
  const children = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l !== '')
    .map(Number);
  for (const child of children) killTree(child);
  process.kill(pid, 'SIGKILL');
}

const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0;

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

afterAll(async () => {
  await closeLinearClient();
});

describe('Linear 连接断开后重建', () => {
  test('调用进行中 mcp-remote 被结束：当次调用失败，下一次调用用新连接成功', async () => {
    expect(await keys()).toContain(EVAL_TEAM);
    const pid = await linearConnectionPid();
    if (pid === null) throw new Error('没有连接');
    const call = keys();
    killTree(pid);
    await expect(call).rejects.toThrow();
    expect(await keys()).toContain(EVAL_TEAM);
    const next = await linearConnectionPid();
    expect(next).not.toBeNull();
    expect(next).not.toBe(pid);
  }, 120_000);

  test('mcp-remote 在两次调用之间退出：下一次调用用新连接成功', async () => {
    expect(await keys()).toContain(EVAL_TEAM);
    const pid = await linearConnectionPid();
    if (pid === null) throw new Error('没有连接');
    killTree(pid);
    // 子进程退出（stdio 关闭）被注意到之后，这个连接就不再给调用使用
    expect(await waitFor(() => !hasLinearConnection(), 10_000)).toBe(true);
    expect(await keys()).toContain(EVAL_TEAM);
    expect(await linearConnectionPid()).not.toBe(pid);
  }, 120_000);

  test('环境检查的重新检查用新建的连接，旧的 mcp-remote 退出', async () => {
    expect(await keys()).toContain(EVAL_TEAM);
    const before = await linearConnectionPid();
    if (before === null) throw new Error('没有连接');
    const environment = createEnvironment({
      models: () => models,
      vaultDir: config.vaultDir,
      product: config.evalProduct,
      txeWorkflowRepo: config.txeWorkflowRepo,
      ctxBin: config.ctxBin,
      codexAuthPath: config.codexAuthPath,
      codexConfigPath: config.codexConfigPath,
      workDir: `${config.repoRoot}/.work/test-linear-reconnect`,
    });
    const report = await environment.get(true);
    const linear = report.checks.find((c) => c.id === 'linear');
    expect(linear).toMatchObject({ ok: true });
    const after = await linearConnectionPid();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    // 旧连接没有进行中的调用，随即关闭
    expect(await waitFor(() => !alive(before), 10_000)).toBe(true);
  }, 300_000);
});
