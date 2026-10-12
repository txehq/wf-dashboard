import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { describe, expect, test } from 'vitest';
import { judgeSchema } from '../src/grading/rubric-judge.js';
import { parseStructuredResponse } from '../src/llm/client.js';

// W31b：gateway 上真实被拒绝的 judge 响应原文（.work/w31b 实测的 brief-1）：stop_reason refusal，
// stop_details.category reasoning_extraction，content 为 thinking 加一个 input 为 {} 的 respond 调用
const fixture = path.join(import.meta.dirname, 'fixtures/llm/judge-refusal.response.json');
const refused = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Message;
const schema = judgeSchema({
  artifact: 'brief',
  items: [1, 2, 3, 4, 5].map((n) => ({
    id: `b${String(n)}`,
    criterion: `条目 ${String(n)}`,
    maxScore: 5,
  })),
});
const message =
  "结构化输出被上游拒绝（stop_reason=refusal）：category=reasoning_extraction，explanation=This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/commercial-terms.";

describe('结构化输出被上游拒绝', () => {
  test('tool_use 的 input 为空时，以 stop_details 的 category 与 explanation 原文报错', () => {
    expect(refused.stop_reason).toBe('refusal');
    expect(refused.content.find((b) => b.type === 'tool_use')).toMatchObject({ input: {} });
    expect(() => parseStructuredResponse(refused, schema, 'claude-opus-5-5')).toThrow(message);
  });

  test('拦在思考阶段、没有 tool_use 时同样报拒绝的原文', () => {
    // 编排者 w31-test.log 中的形状：content 只有 thinking 块
    const thinkingOnly: Message = {
      ...refused,
      content: refused.content.filter((b) => b.type === 'thinking'),
    };
    expect(thinkingOnly.content.length).toBeGreaterThan(0);
    expect(() => parseStructuredResponse(thinkingOnly, schema, 'claude-opus-5-5')).toThrow(message);
  });
});
