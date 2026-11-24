/**
 * SINGLE place where the project estimates tokens.
 *
 * Offline approximation, so displayed figures are ESTIMATES. Measured on 2026-11-24 with the tokenizer of the
 * current models (Claude 4.7 and later; real input tokens of `claude -p`, Haiku 5.5): TypeScript 2.2-2.4
 * characters per token, Markdown 2.4. 2.5 is kept so savings are not overstated. Until v0.7.4 this was 4
 * (older tokenizer): rows recorded before v0.7.5 count about 40% fewer tokens for the same text.
 * To improve: replace the body of this function with a local tokenizer.
 */
export const CHARS_PER_TOKEN = 2.5;

export function estimateTokens(input: string | number): number {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}
