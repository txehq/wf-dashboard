import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import {
  DISPATCH_GATE_REPLY,
  simulateUser,
  type SimulatedUserContext,
  type TranscriptEntry,
} from '../../src/runs/simulated-user.js';
import { parseTaskYaml } from '../../src/tasks/loader.js';
import type { LfgTask } from '../../src/tasks/schema.js';

// 真实调用 gateway 上的 models.simulatedUser
const file = path.join(config.tasksDir, 'lfg-calculator', 'task.yaml');
const definition = parseTaskYaml(fs.readFileSync(file, 'utf8'), file);
if (definition.kind !== 'lfg') throw new Error('lfg-calculator 应为 lfg task');
const task: LfgTask = { ...definition, dir: path.dirname(file) };
const runId = 'r-20261009-simusr';
const ctx: SimulatedUserContext = {
  task,
  runId,
  repo: `txehq/wfe-${runId}`,
  ticket: null,
  product: 'Magi Eval',
};

const initial: TranscriptEntry = {
  speaker: 'user',
  content: `/lfg ${task.input}\n\nProduct: Magi Eval\nFeature slug: ${runId}\nRepository: txehq/wfe-${runId}`,
};

const GO = /\bgo\b/i;

describe('模拟用户（真实 gateway）', () => {
  test('interview 的提问：按 persona 回答被问到的部分，不倾倒全部需求', async () => {
    const r = await simulateUser(ctx, [initial], {
      kind: 'text',
      text: '在动手之前我想先确认几件事：\n1. 这个计算器主要是谁在用？在什么地方、什么设备上用？\n2. 你说的"计算器"需要做到什么程度——只要加减乘除，还是要更多功能？',
    });
    console.log('[interview]', r.reply);
    expect(r.done).toBe(false);
    expect(r.answers).toBeUndefined();
    expect(r.costUsd).toBeGreaterThan(0);
    // 被问到使用者与场景：应提到学生与机房
    expect(r.reply).toMatch(/学生/);
    expect(r.reply).toMatch(/机房/);
    // 没被问到的验收题与"不做"清单不应整段出现
    expect(r.reply).not.toContain('(1+2)*(3+4)/7');
    expect(r.reply).not.toContain('localStorage');
  }, 120_000);

  const gateHistory: TranscriptEntry[] = [
    initial,
    {
      speaker: 'agent',
      content:
        'Brief 已写好：Project Magi Eval/Features/r-20261009-simusr/Brief.md。请确认范围是否正确。',
    },
    { speaker: 'user', content: '对，就是这样。' },
    { speaker: 'agent', content: '计划已锁定，开始拆分工单。' },
  ];
  const gateText = [
    'Tickets filed in Linear (TXE team, Workflow Eval project):',
    '- Epic TXE-901 课堂网页计算器',
    '- TXE-902 表达式解析与十进制精确计算 (wave 1)',
    '- TXE-903 界面、键盘输入与投影模式 (wave 2)',
    '- TXE-904 历史记录 (wave 2)',
    '',
    'Execution plan: wave 1 → TXE-902; wave 2 → TXE-903, TXE-904.',
    'Reply `go` to dispatch every wave, `go wave 1` to dispatch only wave 1, or anything else to stop here as designer-only.',
  ].join('\n');

  test('dispatch gate 的文字提问：回答不派发，且不含 go', async () => {
    const r = await simulateUser(ctx, gateHistory, { kind: 'text', text: gateText });
    console.log('[gate text]', r.reply);
    expect(r.done).toBe(false);
    expect(r.reply).toContain('不派发');
    expect(r.reply).not.toMatch(GO);
  }, 120_000);

  test('dispatch gate 的 AskUserQuestion：选择不派发的选项', async () => {
    const question = 'Dispatch the implementation lanes now?';
    const r = await simulateUser(ctx, gateHistory, {
      kind: 'questions',
      questions: [
        {
          question,
          header: 'Dispatch',
          multiSelect: false,
          options: [
            { label: 'go', description: 'Dispatch every wave now' },
            { label: 'go wave 1', description: 'Dispatch only wave 1' },
            { label: 'Designer-only', description: 'Keep the tickets, dispatch nothing' },
          ],
        },
      ],
    });
    console.log('[gate ask]', r.answers, r.reply);
    expect(r.answers).toEqual({ [question]: 'Designer-only' });
    expect(r.done).toBe(false);
  }, 120_000);

  test('回答 gate 之后 agent 报告结束状态：done 为 true', async () => {
    const r = await simulateUser(
      ctx,
      [
        ...gateHistory,
        { speaker: 'agent', content: gateText },
        { speaker: 'user', content: DISPATCH_GATE_REPLY },
      ],
      {
        kind: 'text',
        text: 'Stopped at the dispatch gate as designer-only. Epic TXE-901 and tickets TXE-902–904 stay in Todo; Tickets.md is filed at Project Magi Eval/Features/r-20261009-simusr/Tickets.md. Nothing was dispatched.',
      },
    );
    console.log('[after gate]', r.reply);
    expect(r.done).toBe(true);
  }, 120_000);
});
