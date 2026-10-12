import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import {
  DISPATCH_GATE_REPLY,
  rejectFiller,
  simulateUser,
  type SimulatedUserContext,
  type TranscriptEntry,
} from '../../src/runs/simulated-user.js';
import { parseTaskYaml } from '../../src/tasks/loader.js';
import type { LfgTask } from '../../src/tasks/schema.js';

// 真实调用 gateway，用默认的模拟用户模型（opus）
const file = path.join(config.tasksDir, 'lfg-calculator', 'task.yaml');
const definition = parseTaskYaml(fs.readFileSync(file, 'utf8'), file);
if (definition.kind !== 'lfg') throw new Error('lfg-calculator 应为 lfg task');
const task: LfgTask = { ...definition, dir: path.dirname(file) };
const runId = 'r-20261009-simusr';
const ctx: SimulatedUserContext = {
  task,
  eval: { runId, repo: `txehq/wfe-${runId}`, ticket: null, product: 'Magi Eval' },
};

const initial: TranscriptEntry = {
  speaker: 'user',
  content: `/lfg ${task.input}\n\nProduct: Magi Eval\nFeature slug: ${runId}\nRepository: txehq/wfe-${runId}`,
};

const GO = /\bgo\b/i;
// 每条测试一次模型调用：比 SDK 的请求超时（600 秒）长，gateway 挂起时报告的是 SDK 的超时错误
const TIMEOUT = 660_000;

describe('模拟用户（真实 gateway）', { timeout: TIMEOUT }, () => {
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
  });

  test('文字里列出 A/B 选项的提问：在 reply 中作答，没有 answers', async () => {
    const r = await simulateUser(ctx, [initial], {
      kind: 'text',
      text: '历史记录怎么保存？\nA. 存在每台电脑自己的浏览器里，不联网也能看\nB. 存到学校服务器上，换电脑也能看\n请选 A 或 B。',
    });
    console.log('[text options]', r.reply);
    expect(r.answers).toBeUndefined();
    expect(r.done).toBe(false);
    expect(r.reply).toMatch(/A/);
  });

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
  });

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
  });

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
  });

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
  });

  test('agent 还在正常提问：done 为 false', async () => {
    const r = await simulateUser(ctx, [initial], {
      kind: 'text',
      text: '在开始之前想先确认一下：这个计算器主要是谁在用？在什么场合用？',
    });
    expect(r.done).toBe(false);
  });
});

// r-20261009-jzo9c4（W12）中 /ic 的 Goal 确认：问题长达数百字，模型逐字抄写问题时留空，run 因此失败
describe('模拟用户回答 /ic 的长问题（真实 gateway）', { timeout: TIMEOUT }, () => {
  const icFile = path.join(config.tasksDir, 'ic-money-format', 'task.yaml');
  const icDefinition = parseTaskYaml(fs.readFileSync(icFile, 'utf8'), icFile);
  if (icDefinition.kind !== 'ic') throw new Error('ic-money-format 应为 ic task');
  const icRunId = 'r-20261009-jzo9c4';
  const icCtx: SimulatedUserContext = {
    task: icDefinition,
    eval: {
      runId: icRunId,
      repo: `txehq/wfe-${icRunId}`,
      ticket: 'TXE-3820',
      product: 'Magi Eval',
    },
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
  });

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
  });
});

// r-20261010-1iqzja（W19）：模拟用户对 /ic Confirm goal 的回答是 placeholder，agent 因此停下来追问
const confirmGoal =
  'Is this the work for TXE-3893? Once you agree, the run goes on to /readiness, /implement, /acceptance, /open-pr, /fix-pr and /ready-for-review without asking again.';

describe('占位内容的回答', () => {
  test('W19 记录的回答与复现中出现的占位内容一律抛错', () => {
    expect(() => {
      rejectFiller('Is this the work for TXE-3893? … → placeholder', {
        [confirmGoal]: 'placeholder',
      });
    }).toThrow(/占位内容："placeholder"/);
    for (const filler of [
      'placeholder',
      ' Placeholder。',
      '',
      '  ',
      ': ',
      '.',
      'x',
      'N/A',
      'TODO',
    ]) {
      expect(() => {
        rejectFiller('好的', { q: filler });
      }).toThrow(/占位内容/);
      expect(() => {
        rejectFiller(filler);
      }).toThrow(/占位内容/);
    }
  });

  test('正常回答不受影响：单字、选项 label、正文中出现 placeholder 一词', () => {
    for (const reply of [
      '好',
      'Yes, run it',
      'go，按工单来就行',
      '输入框里的 placeholder 写「请输入数值」就行。',
      '做一个 todo 列表的接口。',
    ]) {
      expect(() => {
        rejectFiller(reply, { q: reply });
      }).not.toThrow();
    }
  });
});

describe('r-20261010-1iqzja 的 Confirm goal（真实 gateway）', () => {
  const unitFile = path.join(config.tasksDir, 'ic-unit-converter', 'task.yaml');
  const unitDefinition = parseTaskYaml(fs.readFileSync(unitFile, 'utf8'), unitFile);
  if (unitDefinition.kind !== 'ic') throw new Error('ic-unit-converter 应为 ic task');
  const unitRunId = 'r-20261010-1iqzja';
  const unitCtx: SimulatedUserContext = {
    task: unitDefinition,
    eval: {
      runId: unitRunId,
      repo: `txehq/wfe-${unitRunId}`,
      ticket: 'TXE-3893',
      product: 'Magi Eval',
    },
  };

  // simulateUser 遇到占位内容会抛错；prompt 允许没有合适选项时写自己的回答（例如要求先看清单）
  test('连续 10 次：每次都有回答，没有占位内容', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await simulateUser(unitCtx, [{ speaker: 'user', content: '/ic TXE-3893' }], {
        kind: 'questions',
        questions: [
          {
            question: confirmGoal,
            header: 'Confirm goal',
            multiSelect: false,
            options: [
              {
                label: 'Yes, run it',
                description: 'Start the run with the 12-line checklist as posted.',
              },
              {
                label: 'Correct the checklist',
                description:
                  'Tell me what to change; I fold it into the checklist and show it to you again.',
              },
            ],
          },
        ],
      });
      console.log(`[confirm goal ${String(i + 1)}]`, r.model, r.answers, r.reply);
      expect(r.answers?.[confirmGoal]).toMatch(/\p{L}/u);
      expect(r.answers?.[confirmGoal]).not.toMatch(/placeholder/i);
      expect(r.done).toBe(false);
    }
  }, 900_000);
});
