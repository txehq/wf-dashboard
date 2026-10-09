import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { models, parseStructured } from '../src/llm/client.js';
import { costUsd, priceOf } from '../src/llm/pricing.js';

describe('pricing', () => {
  it('按前缀识别 gateway 模型名', () => {
    expect(priceOf('claude-haiku-4-5-20251001-cc').input).toBe(1);
    expect(priceOf('claude-opus-5-5').output).toBe(20);
    expect(() => priceOf('gpt-x')).toThrow();
  });

  it('按各类 token 计算花费', () => {
    const cost = costUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 1_000_000,
      },
      'claude-opus-5-5',
    );
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 8);
  });
});

describe('gateway 结构化输出', () => {
  it('Haiku 返回符合 schema 的 JSON 并记账', async () => {
    const result = await parseStructured({
      model: models.stageCheck,
      system: '只输出 JSON。',
      user: '2 加 3 等于多少？',
      schema: z.object({ answer: z.number() }).strict(),
      maxTokens: 256,
    });
    expect(result.value.answer).toBe(5);
    expect(result.costUsd).toBeGreaterThan(0);
  }, 60_000);
});
