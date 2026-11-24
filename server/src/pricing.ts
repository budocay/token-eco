/**
 * Official Anthropic API prices, USD per million tokens (MTok).
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-24).
 * Keep the newest model of each family first: priceKey() falls back to it for unlisted versions.
 */
export interface ModelPrice {
  label: string;
  input: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
  /** A request whose prompt (all input tokens, cache included) is above `above` pays every price × `factor`. */
  longPrompt?: { above: number; factor: number };
}

export const PRICES_CHECKED = "2026-11-24";
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5.2": { label: "Claude Fable 5.2", input: 8, cacheWrite5m: 10, cacheRead: 0.2, output: 40 },
  "claude-fable-5.1": { label: "Claude Fable 5.1", input: 10, cacheWrite5m: 12.5, cacheRead: 0.25, output: 50 },
  "claude-fable-5": { label: "Claude Fable 5", input: 10, cacheWrite5m: 12.5, cacheRead: 1, output: 50 },
  "claude-mythos-5.2": { label: "Claude Mythos 5.2", input: 8, cacheWrite5m: 10, cacheRead: 0.2, output: 40 },
  "claude-mythos-5.1": { label: "Claude Mythos 5.1", input: 10, cacheWrite5m: 12.5, cacheRead: 0.25, output: 50 },
  "claude-mythos-5": { label: "Claude Mythos 5", input: 10, cacheWrite5m: 12.5, cacheRead: 1, output: 50 },
  "claude-opus-5.5": { label: "Claude Opus 5.5", input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
  "claude-opus-5": { label: "Claude Opus 5", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4.8": { label: "Claude Opus 4.8", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4.7": { label: "Claude Opus 4.7", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4.6": { label: "Claude Opus 4.6", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4.5": { label: "Claude Opus 4.5", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5.5": { label: "Claude Sonnet 5.5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
  "claude-sonnet-5": { label: "Claude Sonnet 5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.2, output: 10 },
  "claude-sonnet-4.6": { label: "Claude Sonnet 4.6", input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4.5": { label: "Claude Sonnet 4.5", input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-5.5": { label: "Claude Haiku 5.5 (≤100k prompt)", input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5,
    longPrompt: { above: 100_000, factor: 5 } },
  "claude-haiku-4.5": { label: "Claude Haiku 4.5", input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 },
};

export const DEFAULT_MODEL = "claude-sonnet-5.5";

/** PRICES key for a model. A version missing from the table (released after it was checked) is priced like the
 *  newest listed model of its family, so its sessions are still counted instead of silently dropped. */
export function priceKey(key: string): string | undefined {
  if (PRICES[key]) return key;
  const family = /^claude-[a-z]+/.exec(key)?.[0];
  return family ? Object.keys(PRICES).find((k) => k.startsWith(family + "-")) : undefined;
}

/** Price of ONE request: promptTokens = all its input tokens (cache reads and writes included). */
export function requestPrice(key: string, promptTokens = 0): ModelPrice | undefined {
  const k = priceKey(key);
  if (!k) return undefined;
  const p = PRICES[k], f = p.longPrompt && promptTokens > p.longPrompt.above ? p.longPrompt.factor : 1;
  return f === 1 ? p : { ...p, input: p.input * f, cacheWrite5m: p.cacheWrite5m * f, cacheRead: p.cacheRead * f, output: p.output * f };
}

/**
 * Value of ONE token kept out of the context, in USD per MTok.
 * In Claude Code a tool result is written to the prompt cache once (5-minute write), then read back from
 * the cache on every later turn of the session. So: cacheWrite5m + laterTurns × cacheRead.
 */
export function savedTokenRate(model: string, laterTurns: number): number {
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  return p.cacheWrite5m + Math.max(0, laterTurns) * p.cacheRead;
}
