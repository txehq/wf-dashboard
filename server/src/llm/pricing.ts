// 每百万 token 的美元价格，取 Anthropic 官方价格表（2026-10-06）。
// cache write 按官方倍率：5 分钟 = 1.25 × input，1 小时 = 2 × input；cache read 取官方公布值。
export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

function price(input: number, output: number, cacheRead: number): Price {
  return { input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead };
}

// 按模型名前缀匹配，顺序从具体到一般。gateway 上的名称带后缀，例如 claude-sonnet-5-cc[1m]。
const table: { match: RegExp; price: Price }[] = [
  { match: /^claude-fable-5-1/, price: price(10, 50, 0.25) },
  { match: /^claude-fable-5/, price: price(10, 50, 0.25) },
  { match: /^claude-opus-5-5/, price: price(4, 20, 0.2) },
  { match: /^claude-opus-5/, price: price(5, 25, 0.5) },
  { match: /^claude-opus-4-[678]/, price: price(5, 25, 0.5) },
  { match: /^claude-sonnet-5-5/, price: price(2, 10, 0.2) },
  { match: /^claude-sonnet-5/, price: price(2, 10, 0.2) },
  { match: /^claude-sonnet-4-6/, price: price(3, 15, 0.3) },
  { match: /^claude-haiku-5-5/, price: price(0.1, 0.5, 0.01) },
  { match: /^claude-haiku-4-5/, price: price(1, 5, 0.1) },
];

export function priceOf(model: string): Price {
  const entry = table.find((e) => e.match.test(model));
  if (!entry) throw new Error(`价格表中没有模型 ${model}`);
  return entry.price;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function costUsd(usage: TokenUsage, model: string): number {
  const p = priceOf(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWrite5mTokens * p.cacheWrite5m +
      usage.cacheWrite1hTokens * p.cacheWrite1h) /
    1_000_000
  );
}

// Messages API 返回的 usage 转成 TokenUsage；cache_creation 细分缺失时按 5 分钟计
export function fromApiUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}): TokenUsage {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - write1h;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
  };
}
