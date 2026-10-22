/**
 * SINGLE place where the project estimates tokens.
 *
 * Offline approximation: 1 token ≈ 4 characters (usual order of magnitude for
 * code and English; other languages and symbols often give a few more
 * tokens). Displayed figures are therefore ESTIMATES.
 * To improve: replace the body of this function with a local tokenizer.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(input: string | number): number {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}
