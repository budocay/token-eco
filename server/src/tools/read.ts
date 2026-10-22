import { readFile } from "node:fs/promises";
import { absolutePath, splitLines, type ToolResult } from "../types.ts";
import { outline } from "./outline.ts";
import { readRange } from "./readRange.ts";
import { readSymbol } from "./readSymbol.ts";
import { searchCompact } from "./searchCompact.ts";

/**
 * Single read tool (fewer tool definitions = lower fixed cost per turn):
 * - name → that symbol's code; start/end → range;
 * - otherwise: short file → whole content, long file → outline + hint.
 */
export interface ReadArgs {
  file: string; name?: string; start?: number; end?: number;
  /** Matching lines of this file with `context` lines around (default 2): a grep inside a batch read. */
  pattern?: string; context?: number;
}

/** Cap of the text returned by a batch read (≈ 10k tokens). */
export const MULTI_CAP = 40_000;

/**
 * Several reads in ONE call (one turn less per extra target: every turn re-reads the whole
 * context from the cache). A failing target does not cancel the others; past the cap, the
 * remaining targets are listed without being read.
 */
export async function readMany(targets: ReadArgs[], cwd: string | undefined, fullThreshold: number,
  cap = MULTI_CAP): Promise<ToolResult> {
  const chunks: string[] = [];
  let native = 0, size = 0, i = 0;
  for (; i < targets.length; i++) {
    const c = targets[i];
    const what = c.name ? ` ${c.name}` : c.pattern ? ` /${c.pattern}/` : c.start || c.end ? ` ${c.start ?? 1}-${c.end ?? ""}` : "";
    let text: string;
    try {
      const r = await read(c, cwd, fullThreshold);
      text = r.text; native += r.nativeChars;
    } catch (e) { text = `error: ${(e as Error).message}`; }
    const block = `=== ${c.file}${what} ===\n${text}`;
    if (size + block.length > cap && chunks.length) break;
    chunks.push(block); size += block.length;
  }
  if (i < targets.length) {
    chunks.push(`[size cap reached; not read: ${targets.slice(i).map((c) => c.file + (c.name ? ` ${c.name}` : "")).join(", ")}]`);
  }
  return { text: chunks.join("\n\n"), nativeChars: native, details: { targets: targets.length, readCount: i } };
}

export async function read(args: ReadArgs, cwd: string | undefined, fullThreshold: number): Promise<ToolResult> {
  if (args.name) return readSymbol({ file: args.file, name: args.name }, cwd);
  if (args.pattern) {
    return searchCompact({ pattern: args.pattern, filePath: args.file, context: args.context ?? 2, maxResults: 30 }, cwd);
  }
  if (args.start || args.end) return readRange(args, cwd);
  const total = splitLines(await readFile(absolutePath(args.file, cwd), "utf8")).length;
  if (total <= fullThreshold) return readRange({ file: args.file, start: 1, end: total }, cwd);
  const r = await outline({ file: args.file }, cwd);
  return { ...r, text: `${r.text}\n[${total} lines: outline only — read again with name=<symbol> or start/end]` };
}
