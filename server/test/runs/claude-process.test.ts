import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { ClaudeProcess } from '../../src/runs/claude-process.js';
import type { StreamEvent } from '../../src/runs/stream.js';

// ClaudeProcess 启动 PATH 中的 claude：这里放一个真实的可执行脚本代替 claude CLI，按需要输出 stdout
const work = path.join(config.repoRoot, '.work', 'test-claude-process', randomUUID());
const bin = path.join(work, 'bin');
fs.mkdirSync(bin, { recursive: true });

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function start(script: string) {
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const events: StreamEvent[] = [];
  const errors: Error[] = [];
  const proc = new ClaudeProcess({
    sessionId: randomUUID(),
    cwd: work,
    env: { PATH: `${bin}:/usr/bin:/bin` },
    variantArgs: [],
    sandboxProfile: '(version 1)\n(allow default)',
    logDir: path.join(work, randomUUID()),
    onEvent: (e) => events.push(e),
    onTurn: () => undefined,
    onError: (e) => errors.push(e),
  });
  return { proc, events, errors };
}

describe('ClaudeProcess', () => {
  // W15 Medium 9：无法解析的一行报告失败之后，后续行以前照常处理，失败中的 run 仍在回答 control_request
  test('stdout 出现无法解析的一行后报告一次失败，之后的行不再处理', async () => {
    const control = JSON.stringify({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    });
    const { proc, events, errors } = start(
      `echo '{"type":"system","subtype":"init"}'\necho 'not json'\necho '${control}'`,
    );
    await proc.exited;
    expect(events.map((e) => e.type)).toEqual(['system']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('claude stdout 无法解析：not json');
  });

  // W15 Medium 8：子进程退出后写入的 EPIPE 不是错误（退出由 exited 报告）
  test('子进程退出后写 stdin 的 EPIPE 不报告为错误', async () => {
    const { proc, errors } = start('exit 0');
    await proc.exited;
    proc.sendUser('还在吗');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(errors).toEqual([]);
  });
});
