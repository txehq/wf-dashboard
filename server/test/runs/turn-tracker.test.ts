import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseStreamEvent } from '../../src/runs/stream.js';
import { TurnTracker } from '../../src/runs/turn-tracker.js';

// S1 记录的真实 stdin/stdout：每行 { t, dir: argv | in | out | exit, event }
const fixtures = path.join(import.meta.dirname, '../fixtures/claude-cli');

function replay(name: string) {
  const tracker = new TurnTracker();
  const lines = fs
    .readFileSync(path.join(fixtures, `${name}.events.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  for (const line of lines) {
    const record = JSON.parse(line) as { dir: string; event?: unknown };
    if (record.dir === 'out') {
      tracker.observe(parseStreamEvent(record.event));
    } else if (record.dir === 'in' && typeof record.event === 'object' && record.event !== null) {
      const event = record.event as { type: string; response?: { request_id: string } };
      if (event.type === 'user') tracker.userSent();
      if (event.type === 'control_response' && event.response) {
        tracker.controlAnswered(event.response.request_id);
      }
    }
  }
  return tracker;
}

describe('TurnTracker 用 S1 的真实 stream-json 驱动', () => {
  test('s8：后台任务、AskUserQuestion、文字提问依次经过全部状态', () => {
    const tracker = replay('s8-turn-end');
    expect(tracker.transitions).toEqual([
      { state: 'running', cause: 'user message' },
      { state: 'awaiting_background', cause: 'result/success' },
      { state: 'running', cause: 'task_notification' },
      { state: 'awaiting_host', cause: 'control_request can_use_tool:AskUserQuestion' },
      { state: 'running', cause: 'control_response' },
      { state: 'idle', cause: 'result/success' },
      { state: 'running', cause: 'user message' },
      { state: 'idle', cause: 'result/success' },
    ]);
  });

  test('s6：后台命令运行中的 result 不是一轮结束，完成通知唤起下一轮', () => {
    expect(replay('s6-bash-bg').transitions.map((t) => t.state)).toEqual([
      'running',
      'awaiting_background',
      'running',
      'idle',
    ]);
  });

  test('s7：interrupt 之后的 error_during_execution 也结束一轮，之后照常接收消息', () => {
    expect(replay('s7-interrupt').transitions).toEqual([
      { state: 'running', cause: 'user message' },
      { state: 'idle', cause: 'result/error_during_execution' },
      { state: 'running', cause: 'user message' },
      { state: 'idle', cause: 'result/success' },
    ]);
  });

  test('s9：关键路径删除的 can_use_tool 等待宿主回答', () => {
    const tracker = replay('s9-bypass-host');
    expect(tracker.transitions.map((t) => t.state)).toEqual([
      'running',
      'awaiting_host',
      'running',
      'idle',
    ]);
    expect(tracker.hasPendingControl).toBe(false);
  });
});
