import { describe, expect, test } from 'vitest';
import { structuredRequest } from '../../src/llm/client.js';
import {
  type AgentPrompt,
  checkDispatchGate,
  DISPATCH_GATE_REPLY,
  type PersonaStage,
  questionOutput,
  systemPrompt,
  textOutput,
} from '../../src/runs/simulated-user.js';
import { evalSpec } from '../../src/workflows/eval-kinds.js';

// Contracts 7.4 与 Reports/W40：回答 dispatch gate 的这一轮 done 必须为 false。prompt 按顺序逐条核对，
// 有 dispatch gate 的评测类型在 done 之前先给出 answeringDispatchGate，代码检查两者不矛盾
const lfg: PersonaStage = evalSpec('lfg', 'lfg');
const ic: PersonaStage = evalSpec('ic', 'ic');
const gateText = {
  kind: 'text' as const,
  text: 'Reply `go` to dispatch every wave, or anything else to stop here.',
};
const check = (prompt: AgentPrompt, output: Parameters<typeof checkDispatchGate>[2]) => () => {
  checkDispatchGate(lfg, prompt, output);
};

describe('dispatch gate 的检查', () => {
  test('回答 gate 的这一轮 done 为 true：以原文失败', () => {
    expect(
      check(gateText, { reply: DISPATCH_GATE_REPLY, done: true, answeringDispatchGate: true }),
    ).toThrow(
      '/lfg 运行中模拟用户在回答 dispatch gate 的这一轮给出 done: true（回答 gate 之后才能结束）：{"reply":"不派发，到此结束。","done":true,"answeringDispatchGate":true}',
    );
  });

  test('文字提问的 gate 回答不是固定的那一句：以原文失败；用选项回答时 reply 不限', () => {
    const output = { reply: '先不派发。', done: false, answeringDispatchGate: true };
    expect(check(gateText, output)).toThrow(
      '/lfg 运行中模拟用户对 dispatch gate 的回答不是"不派发，到此结束。"："先不派发。"',
    );
    const questions: AgentPrompt = {
      kind: 'questions',
      questions: [
        { question: 'Dispatch now?', header: 'Dispatch', multiSelect: false, options: [] },
      ],
    };
    expect(
      check(questions, { ...output, answers: { 'Dispatch now?': 'Designer-only' } }),
    ).not.toThrow();
  });

  test('回答中出现 go：以原文失败', () => {
    expect(check(gateText, { reply: 'go', done: false, answeringDispatchGate: true })).toThrow(
      '/lfg 运行中模拟用户的回答出现了 go：["go"]',
    );
  });

  test('gate 回答 done 为 false、回答 gate 之后结束 done 为 true：通过', () => {
    expect(
      check(gateText, { reply: DISPATCH_GATE_REPLY, done: false, answeringDispatchGate: true }),
    ).not.toThrow();
    expect(
      check(gateText, {
        reply: '好的，这次先到这里结束。',
        done: true,
        answeringDispatchGate: false,
      }),
    ).not.toThrow();
  });
});

describe('done 的判断条件', () => {
  const eval_ = { runId: 'r-x', repo: 'txehq/wfe-r-x', ticket: null, product: 'Magi Eval' };
  const prompt = (stage: PersonaStage) =>
    systemPrompt({ task: { stage, persona: 'p', hiddenRequirements: '' }, eval: eval_ });

  test('/lfg：第一条是回答 gate 的这一轮 done 为 false，其后是结束条件、等待外部条件、其余为 false', () => {
    const section = prompt(lfg).split('## 何时结束（done）\n')[1]?.split('\n\n')[0] ?? '';
    expect(section.split('\n')).toEqual([
      '这是 /lfg 运行。',
      '按顺序逐条核对，命中一条就停，不再看后面的：',
      '1. answeringDispatchGate 为 true（你这一轮正在回答 dispatch gate）→ done 必须为 false。你的回答要发给 agent，agent 收到后才会报告结束状态，那之后的一轮才可能结束。',
      `2. 满足这一条 → done 为 true：${lfg.done.trim()}`,
      '3. agent 最新一轮没有向你提问，而是说明它在等待某个外部条件（例如额度恢复、某个服务恢复、别人完成某个操作）才能继续 → 视为 agent 无法继续，done 为 true。',
      '4. 以上都不满足 → done 为 false。',
      'done 为 true 时，reply 写一句简短的结束语，它不会发给 agent。',
    ]);
  });

  test('/ic 没有 dispatch gate：没有 gate 一条，也没有 answeringDispatchGate', () => {
    const text = prompt(ic);
    expect(text).not.toContain('answeringDispatchGate');
    expect(text).toContain(`1. 满足这一条 → done 为 true：${ic.done.trim()}`);
  });

  test('输出的 schema：有 gate 时 answeringDispatchGate 排在最前，没有 gate 时不出现', () => {
    const keys = (schema: Parameters<typeof structuredRequest>[0]['schema']) => {
      const tool = structuredRequest({ model: 'm', system: 's', user: 'u', schema, maxTokens: 1 })
        .tools?.[0];
      if (tool === undefined || !('input_schema' in tool)) throw new Error('没有输出工具');
      return Object.keys(tool.input_schema.properties ?? {});
    };
    expect(keys(textOutput(true))).toEqual(['answeringDispatchGate', 'reply', 'done']);
    expect(keys(textOutput(false))).toEqual(['reply', 'done']);
    const questions = [{ question: 'q', header: '', multiSelect: false, options: [] }];
    expect(keys(questionOutput(questions, true))).toEqual([
      'answeringDispatchGate',
      'reply',
      'answers',
      'done',
    ]);
    expect(keys(questionOutput(questions, false))).toEqual(['reply', 'answers', 'done']);
  });
});
