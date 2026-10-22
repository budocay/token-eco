/**
 * Official Anthropic API prices, USD per million tokens (MTok).
 * Source: https://docs.claude.com/en/docs/about-claude/pricing (checked 2026-10-22).
 */
export interface ModelPrice {
  label: string;
  input: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
}

export const PRICES_CHECKED = "2026-10-22";
export const PRICES_SOURCE = "https://docs.claude.com/en/docs/about-claude/pricing";

export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5.1": { label: "Claude Fable 5.1", input: 10, cacheWrite5m: 12.5, cacheRead: 0.25, output: 50 },
  "claude-opus-5.5": { label: "Claude Opus 5.5", input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
  "claude-opus-5": { label: "Claude Opus 5", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4.8": { label: "Claude Opus 4.8", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5.5": { label: "Claude Sonnet 5.5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
  "claude-sonnet-5": { label: "Claude Sonnet 5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.2, output: 10 },
  "claude-sonnet-4.6": { label: "Claude Sonnet 4.6", input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-5.5": { label: "Claude Haiku 5.5 (≤100k prompt)", input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-haiku-4.5": { label: "Claude Haiku 4.5", input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 },
};

export const DEFAULT_MODEL = "claude-sonnet-5.5";

/**
 * Value of ONE token kept out of the context, in USD per MTok.
 * In Claude Code a tool result is written to the prompt cache once (5-minute write), then read back from
 * the cache on every later turn of the session. So: cacheWrite5m + laterTurns × cacheRead.
 */
export function savedTokenRate(model: string, laterTurns: number): number {
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  return p.cacheWrite5m + Math.max(0, laterTurns) * p.cacheRead;
}
