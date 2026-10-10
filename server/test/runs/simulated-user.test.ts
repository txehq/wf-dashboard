import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { models, setModels } from '../../src/llm/client.js';
import {
  DISPATCH_GATE_REPLY,
  simulateUser,
  type SimulatedUserContext,
  type TranscriptEntry,
} from '../../src/runs/simulated-user.js';
import { parseTaskYaml } from '../../src/tasks/loader.js';
import type { LfgTask } from '../../src/tasks/schema.js';

// 真实调用 gateway；模拟用户用 opus（W12：gateway 上 sonnet 的结构化回答经常为空或是占位词）
setModels({ ...models, simulatedUser: models.judge });
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

  test('文字里列出 A/B 选项的提问：在 reply 中作答，没有 answers', async () => {
    const r = await simulateUser(ctx, [initial], {
      kind: 'text',
      text: '历史记录怎么保存？\nA. 存在每台电脑自己的浏览器里，不联网也能看\nB. 存到学校服务器上，换电脑也能看\n请选 A 或 B。',
    });
    console.log('[text options]', r.reply);
    expect(r.answers).toBeUndefined();
    expect(r.done).toBe(false);
    expect(r.reply).toMatch(/A/);
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

  // r-20261009-i6vxt1（W12）：research 等 Codex 额度时，模拟用户与 agent 来回「好的 / 好」直到回答次数上限
  test('agent 在等外部条件而不是提问：done 为 true', async () => {
    const r = await simulateUser(
      ctx,
      [
        initial,
        {
          speaker: 'agent',
          content:
            '好的。账号额度我们这边自己处理，不会再拿这件事麻烦你。额度恢复以后，我会从对抗评审接着做，先把调研草稿和这六个问题再审一遍。',
        },
        { speaker: 'user', content: '好，那就等你们那边弄好了，六个问题整理好发给我。' },
      ],
      {
        kind: 'text',
        text: '好的。我刚才又试了一次，Codex 的额度还没有恢复，所以这一步还在等。额度恢复以后，我会先把六个问题审好，再整理好发给你。',
      },
    );
    console.log('[waiting]', r.reply);
    expect(r.done).toBe(true);
  }, 120_000);

  test('agent 还在正常提问：done 为 false', async () => {
    const r = await simulateUser(ctx, [initial], {
      kind: 'text',
      text: '在开始之前想先确认一下：这个计算器主要是谁在用？在什么场合用？',
    });
    expect(r.done).toBe(false);
  }, 120_000);
});

// r-20261009-jzo9c4（W12）中 /ic 的 Goal 确认：问题长达数百字，模型逐字抄写问题时留空，run 因此失败
describe('模拟用户回答 /ic 的长问题（真实 gateway）', () => {
  const icFile = path.join(config.tasksDir, 'ic-money-format', 'task.yaml');
  const icDefinition = parseTaskYaml(fs.readFileSync(icFile, 'utf8'), icFile);
  if (icDefinition.kind !== 'ic') throw new Error('ic-money-format 应为 ic task');
  const icRunId = 'r-20261009-jzo9c4';
  const icCtx: SimulatedUserContext = {
    task: { ...icDefinition, dir: path.dirname(icFile) },
    runId: icRunId,
    repo: `txehq/wfe-${icRunId}`,
    ticket: 'TXE-3820',
    product: 'Magi Eval',
  };
  const goal =
    "TXE-3820: make `formatMoney` in `src/format.js` take each currency's decimals from `src/currencies.js` (JPY/KRW with no fraction, KWD with three digits), put the minus sign before the symbol, show amounts up to Number.MAX_SAFE_INTEGER exactly, and throw RangeError (unsupported currency) / TypeError (amount not a safe integer). The checklist holds 8 requirements. /readiness will check node >=22.12.0 with npm. Authority ceiling: code and tests in this repo, a draft PR on txehq/wfe-r-20261009-jzo9c4, and Linear updates on this ticket, with no merge and no other external side effects. Is that the work?";

  test('Goal 确认的 AskUserQuestion：answers 的键是问题原文，选确认项', async () => {
    const r = await simulateUser(icCtx, [{ speaker: 'user', content: '/ic TXE-3820' }], {
      kind: 'questions',
      questions: [
        {
          question: goal,
          header: 'Goal',
          multiSelect: false,
          options: [
            {
              label: 'Yes, run it',
              description: 'Run /readiness through /ready-for-review without asking again.',
            },
            {
              label: 'Correct the goal',
              description: "I'll describe the correction, and it gets folded into the checklist.",
            },
          ],
        },
      ],
    });
    console.log('[ic goal]', r.answers, r.reply);
    expect(r.answers).toEqual({ [goal]: 'Yes, run it' });
    expect(r.done).toBe(false);
  }, 120_000);

  test('两个问题：按编号对应到各自的问题原文', async () => {
    const q1 = 'Which Node version should /readiness require for this repository?';
    const q2 =
      'Should the PR also update README.md to document the new RangeError and TypeError behaviour?';
    const r = await simulateUser(icCtx, [{ speaker: 'user', content: '/ic TXE-3820' }], {
      kind: 'questions',
      questions: [
        {
          question: q1,
          header: 'Node',
          multiSelect: false,
          options: [
            { label: '>=22.12.0', description: 'What package.json engines says' },
            { label: '>=20', description: 'Older LTS' },
          ],
        },
        {
          question: q2,
          header: 'README',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'Document the errors in README' },
            { label: 'No', description: 'Code and tests only' },
          ],
        },
      ],
    });
    console.log('[ic two]', r.answers);
    expect(Object.keys(r.answers ?? {}).sort()).toEqual([q1, q2].sort());
    // 没有合适的选项时 prompt 允许写自己的简短回答，这里只要求每个问题都有回答
    for (const q of [q1, q2]) expect(r.answers?.[q]).toMatch(/\S/);
  }, 120_000);
});
