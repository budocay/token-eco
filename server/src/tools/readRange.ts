import { readFile } from "node:fs/promises";
import { nativeReadChars, absolutePath, splitLines, truncate, type ToolResult } from "../types.ts";

export interface ReadRangeArgs {
  file: string;
  start?: number;
  end?: number;
}

export const DEFAULT_MAX_LINES = 200;

export async function readRange(args: ReadRangeArgs, cwd?: string): Promise<ToolResult> {
  const content = await readFile(absolutePath(args.file, cwd), "utf8");
  const lines = splitLines(content);
  const total = lines.length;
  const start = Math.max(1, args.start ?? 1);
  const end = Math.min(total, args.end ?? start + DEFAULT_MAX_LINES - 1);
  // Honest native reference: Read with the same offset/limit when a range is given,
  // else the default Read (first 2000 lines).
  const nativeChars = args.start || args.end
    ? nativeReadChars(lines.slice(start - 1, Math.max(end, start - 1)))
    : nativeReadChars(lines);
  if (start > total || end < start) {
    return { text: `${args.file}: ${total} lines, range ${start}-${args.end ?? "?"} is empty.`, nativeChars };
  }

  // Minimal header (the caller already knows the path; the total tells what follows).
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}|${truncate(l, 500)}`)
    .join("\n");
  return {
    text: `[${start}-${end}/${total}]\n${body}`,
    nativeChars,
    details: { file: args.file, start, end, total },
  };
}
