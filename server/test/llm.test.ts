import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  anthropic,
  claudeSettingsEnv,
  defaultModels,
  gatewayClient,
  models,
  parseStructured,
  stripContextTag,
} from '../src/llm/client.js';
import { costUsd, fromApiUsage, priceOf } from '../src/llm/pricing.js';

describe('默认模型', () => {
  it('模拟用户与 judge 默认取 settings env 中 opus 的别名（Contracts 4）', () => {
    const opus = stripContextTag(claudeSettingsEnv().ANTHROPIC_DEFAULT_OPUS_MODEL);
    expect(opus).not.toMatch(/\[/);
    expect(defaultModels().simulatedUser).toBe(opus);
    expect(defaultModels().judge).toBe(opus);
  });
});

describe('pricing', () => {
  it('按前缀识别 gateway 模型名', () => {
    expect(priceOf('claude-haiku-4-5-20251001-cc', 0).input).toBe(1);
    expect(priceOf('claude-opus-5-5', 0).output).toBe(20);
    expect(() => priceOf('gpt-x', 0)).toThrow();
  });

  // W15 Medium 6：以前按前缀匹配，未列出的新版本静默按同族旧版本计价
  it('提供方前缀可以识别；未列出的版本抛错，不按同族其他版本计价', () => {
    expect(priceOf('us.anthropic.claude-opus-5-5', 0).input).toBe(4);
    expect(priceOf('claude-sonnet-5[1m]', 0).input).toBe(2);
    expect(priceOf('claude-opus-5-5-20261001', 0).input).toBe(4);
    expect(() => priceOf('claude-sonnet-5-7', 0)).toThrow('价格表中没有模型');
    expect(() => priceOf('claude-opus-5-9-cc', 0)).toThrow('价格表中没有模型');
  });

  // W15 Medium 6（W18c）：Haiku 5.5 按单次请求的 prompt（input 加 cache 读写）是否超过 100K 分档
  it('Haiku 5.5 的两档价格：prompt 超过 100K 时 input / output / cache 都按高档计', () => {
    const usage = (input: number, cacheRead: number, cacheWrite5m: number) => ({
      inputTokens: input,
      outputTokens: 1_000_000,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite5m,
      cacheWrite1hTokens: 0,
    });
    // 正好 100K：低档（$0.10 / $0.50，cache 读 $0.01、写 $0.125）
    expect(costUsd(usage(40_000, 50_000, 10_000), 'claude-haiku-5-5')).toBeCloseTo(
      (40_000 * 0.1 + 1_000_000 * 0.5 + 50_000 * 0.01 + 10_000 * 0.125) / 1_000_000,
      12,
    );
    // 多 1 个 token：整次请求按高档（$0.50 / $2.50，cache 读 $0.05、写 $0.625）
    expect(costUsd(usage(40_001, 50_000, 10_000), 'claude-haiku-5-5')).toBeCloseTo(
      (40_001 * 0.5 + 1_000_000 * 2.5 + 50_000 * 0.05 + 10_000 * 0.625) / 1_000_000,
      12,
    );
    // 其他模型没有分档
    expect(priceOf('claude-opus-5-5', 500_000)).toEqual(priceOf('claude-opus-5-5', 0));
  });

  // W15 Medium 7：以前细分缺失时全部按 5 分钟价计
  it('有 cache write 而没有 5 分钟 / 1 小时细分时抛错', () => {
    expect(() =>
      fromApiUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100 }),
    ).toThrow('没有 5 分钟 / 1 小时的细分');
    expect(
      fromApiUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0 }),
    ).toMatchObject({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
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
  it('gateway 返回 529 时只发一次请求，错误直接抛出（W15 H5：SDK 默认重试 2 次）', async () => {
    const server = Fastify();
    let hits = 0;
    server.post('/v1/messages', async (_request, reply) => {
      hits += 1;
      return reply.code(529).send({ type: 'error', error: { type: 'overloaded_error' } });
    });
    const url = await server.listen({ port: 0, host: '127.0.0.1' });
    const client = gatewayClient(url, 'test-token');
    expect(anthropic().maxRetries).toBe(0);
    // 挂起的请求 120 秒后失败（Contracts 4）
    expect(anthropic().timeout).toBe(120_000);
    await expect(
      client.messages.create({
        model: models.judge,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/529/);
    expect(hits).toBe(1);
    await server.close();
  });
  it('judge 模型返回符合 schema 的 JSON 并记账', async () => {
    const result = await parseStructured({
      model: models.judge,
      system: '只输出 JSON。',
      user: '2 加 3 等于多少？',
      schema: z.object({ answer: z.number() }).strict(),
      maxTokens: 256,
    });
    expect(result.value.answer).toBe(5);
    expect(result.costUsd).toBeGreaterThan(0);
  }, 150_000);
});
