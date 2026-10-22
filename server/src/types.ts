import { resolve } from "node:path";

/**
 * Result shared by every tool.
 * - text: what is sent back to Claude.
 * - nativeChars: estimated size (characters) of what the equivalent built-in
 *   tool would have returned. Converted to tokens in tokens.ts.
 */
export interface ToolResult {
  text: string;
  nativeChars: number;
  details?: Record<string, unknown>;
}

export function absolutePath(file: string, cwd: string = process.cwd()): string {
  return resolve(cwd, file);
}

/** Splits into lines without a phantom empty line at the end of the file. */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Size (characters) of what Claude Code's native Read would return for this file:
 * first 2000 lines at most, lines truncated to 2000 characters, prefixed with “n° + tab”.
 */
export function nativeReadChars(lines: string[]): number {
  let total = 0;
  const n = Math.min(lines.length, 2000);
  for (let i = 0; i < n; i++) total += Math.min(lines[i].length, 2000) + String(i + 1).length + 2;
  return total;
}

/** Truncates an overly long line (minified, data…) to avoid wasting tokens. */
export function truncate(line: string, max = 200): string {
  return line.length > max ? line.slice(0, max) + `… [+${line.length - max} chars]` : line;
}
