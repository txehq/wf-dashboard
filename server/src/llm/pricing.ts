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

// 价格按单次请求的 prompt 大小分档：prompt（input 加 cache 读写）超过 above 时整次请求按 price 计
interface LongContextTier {
  above: number;
  price: Price;
}

// 按模型族与版本号匹配，顺序从具体到一般。gateway 上的名称可以带提供方前缀（us.anthropic.）与后缀
// （日期 -20251001、-cc、[1m]）；版本号之后不能再接一段版本号，未列出的版本（例如 claude-sonnet-5-7）直接抛错，
// 不按同族的其他版本计价
const model = (name: string) => new RegExp(`^(?:[a-z]+\\.)*${name}(?!-\\d{1,2}(?:\\D|$))`);
const table: { match: RegExp; price: Price; longContext?: LongContextTier }[] = [
  { match: model('claude-fable-5-1'), price: price(10, 50, 0.25) },
  { match: model('claude-fable-5'), price: price(10, 50, 0.25) },
  { match: model('claude-opus-5-5'), price: price(4, 20, 0.2) },
  { match: model('claude-opus-5'), price: price(5, 25, 0.5) },
  { match: model('claude-opus-4-[678]'), price: price(5, 25, 0.5) },
  { match: model('claude-sonnet-5-5'), price: price(2, 10, 0.2) },
  { match: model('claude-sonnet-5'), price: price(2, 10, 0.2) },
  { match: model('claude-sonnet-4-6'), price: price(3, 15, 0.3) },
  // Haiku 5.5：prompt 不超过 100K token 时 $0.10 / $0.50，超过时 $0.50 / $2.50（官方模型表）；
  // cache 读写按同档 input 的倍率（读 0.1×，写 1.25× / 2×）
  {
    match: model('claude-haiku-5-5'),
    price: price(0.1, 0.5, 0.01),
    longContext: { above: 100_000, price: price(0.5, 2.5, 0.05) },
  },
  { match: model('claude-haiku-4-5'), price: price(1, 5, 0.1) },
];

// promptTokens：这次请求的 input 加 cache 读写的 token 总数，决定分档
export function priceOf(model: string, promptTokens: number): Price {
  const entry = table.find((e) => e.match.test(model));
  if (!entry) throw new Error(`价格表中没有模型 ${model}`);
  const long = entry.longContext;
  return long !== undefined && promptTokens > long.above ? long.price : entry.price;
}

// 价格表中有没有这个模型：Codex 的模型不在表中，只记 token（Contracts 25.2）
export const hasPrice = (model: string) => table.some((e) => e.match.test(model));

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function costUsd(usage: TokenUsage, model: string): number {
  const prompt =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  const p = priceOf(model, prompt);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWrite5mTokens * p.cacheWrite5m +
      usage.cacheWrite1hTokens * p.cacheWrite1h) /
    1_000_000
  );
}

// Messages API 返回的 usage 转成 TokenUsage。有 cache write 时必须有 5 分钟 / 1 小时的细分，
// 两种价格不同，缺失时无法计价，直接抛错
export function fromApiUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}): TokenUsage {
  const written = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const write5m = split?.ephemeral_5m_input_tokens;
  const write1h = split?.ephemeral_1h_input_tokens;
  if (written > 0 && (write5m === undefined || write1h === undefined)) {
    throw new Error(
      `usage 有 ${String(written)} 个 cache write token，但没有 5 分钟 / 1 小时的细分`,
    );
  }
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: write5m ?? 0,
    cacheWrite1hTokens: write1h ?? 0,
  };
}
