// USD per million tokens, from Anthropic's official price list (2026-10-06).
// cache write uses the official multipliers: 5 minutes = 1.25 x input, 1 hour = 2 x input; cache read uses the published value.
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

// Prices are tiered by a single request's prompt size: when the prompt (input plus cache reads and writes) exceeds above, the whole request uses price
interface LongContextTier {
  above: number;
  price: Price;
}

// Match by model family and version, most specific first. Gateway names may carry a provider prefix (us.anthropic.) and suffixes
// (date -20251001, -cc, [1m]); no further version segment may follow the version, and unlisted versions (e.g. claude-sonnet-5-7) throw
// instead of being priced as another version of the family
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
  // Haiku 5.5: $0.10 / $0.50 for prompts up to 100K tokens, $0.50 / $2.50 above (official model table);
  // cache reads and writes use the tier's input multipliers (read 0.1x, write 1.25x / 2x)
  {
    match: model('claude-haiku-5-5'),
    price: price(0.1, 0.5, 0.01),
    longContext: { above: 100_000, price: price(0.5, 2.5, 0.05) },
  },
  { match: model('claude-haiku-4-5'), price: price(1, 5, 0.1) },
];

// promptTokens: this request's input plus cache read and write tokens, which picks the tier
export function priceOf(model: string, promptTokens: number): Price {
  const entry = table.find((e) => e.match.test(model));
  if (!entry) throw new Error(`Model ${model} is not in the price list`);
  const long = entry.longContext;
  return long !== undefined && promptTokens > long.above ? long.price : entry.price;
}

// Whether the price list has this model: Codex models are not in it and only tokens are recorded (Contracts 25.2)
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

// Convert the Messages API usage to TokenUsage. With cache writes the 5-minute / 1-hour split is required:
// the two prices differ, so without it the cost cannot be computed and this throws
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
      `usage has ${String(written)} cache write tokens but no 5-minute / 1-hour split`,
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
