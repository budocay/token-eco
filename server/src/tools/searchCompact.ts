import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { absolutePath, splitLines, truncate, type ToolResult } from "../types.ts";
import { declarations, blockEnd, computeMask, profileFor } from "../languages/engine.ts";

/**
 * Compact regex search: results grouped by file (the path is written
 * once), lines truncated, number of results capped.
 * Native reference: `grep -rn` style output (path:line:text) of the same lines shown.
 */

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".venv", "venv",
  "__pycache__", ".idea", ".vscode", "coverage", ".cache", "target",
]);
const MAX_SIZE = 1_000_000;

export interface SearchArgs {
  /** Missing: list of the files matching `filter` (like Glob). */
  pattern?: string;
  filePath?: string;
  filter?: string;
  ignoreCase?: boolean;
  maxResults?: number;
  context?: number;
  /** lines (default) | files (list only) | count (occurrences per file). */
  mode?: "lines" | "files" | "count";
  /** Lines mode: shows the function/class containing each hit (for a direct `read name=`). */
  symbols?: boolean;
  /** Lines mode: returns the whole body of the function/class containing each hit (search + read in one call). */
  expand?: boolean;
}

/** expand: longest symbol body returned whole, and total budget of expanded text per search (≈ 6k tokens). */
export const EXPAND_MAX_LINES = 150;
export const EXPAND_CAP = 24_000;

const DECL_KEYWORD = /\b(?:function|class|def|fn|func|struct|interface|type|enum|trait|impl|module|object|record|protocol|extension|macro|sub|proc|method)\s+([A-Za-z_$][\w$.:]*)/;

/** Short name of a declaration: identifier after a keyword, else before “(” or “=”, else the shortened line. */
export function declarationName(line: string): string {
  const t = line.trim();
  const m = DECL_KEYWORD.exec(t) ?? /([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|=\s*(?:async\s*)?(?:\(|function))/.exec(t);
  return m ? m[1] : truncate(t, 50);
}

interface Span { start: number; end: number; label: string }

/** Function i → innermost symbol containing line i (0-based span; undefined at top level). */
function enclosingSymbol(file: string, lines: string[]): (i: number) => Span | undefined {
  const p = profileFor(file, lines.slice(0, 5).join("\n"));
  const mask = computeMask(lines, p);
  const decls = declarations(lines, p, mask);
  const ends = new Map<number, number>();
  return (i) => {
    let best: number | undefined;
    for (const d of decls) {
      if (d > i) break;
      let end = ends.get(d);
      if (end === undefined) { end = blockEnd(lines, d, p, mask); ends.set(d, end); }
      if (end >= i) best = d; // decls are sorted: the last one containing i is the innermost
    }
    if (best === undefined) return undefined;
    const end = ends.get(best)!;
    return { start: best, end, label: `${declarationName(lines[best])} L${best + 1}-${end + 1}` };
  };
}

/** Minimal glob: * ** ? {a,b}. Tested on the file name, or on the relative path if it contains “/”. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function* walkDir(folder: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(folder, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walkDir(p);
    } else if (e.isFile()) yield p; // symbolic links are skipped (avoids loops)
  }
}

export async function searchCompact(args: SearchArgs, cwd: string = process.cwd()): Promise<ToolResult> {
  const regex = new RegExp(args.pattern ?? "", args.ignoreCase ? "i" : "");
  const root = absolutePath(args.filePath ?? ".", cwd);
  const max = args.maxResults ?? 50;
  const ctx = Math.min(Math.max(args.context ?? 0, 0), 3);
  const filter = args.filter ? globToRegex(args.filter) : null;

  const rootInfo = await stat(root);
  const files: AsyncIterable<string> | string[] = rootInfo.isFile() ? [root] : walkDir(root);

  const mode = args.mode ?? "lines";
  const blocks: string[] = [];
  let fileCount = 0, totalCount = 0, shownCount = 0, nativeChars = 0, expandBudget = EXPAND_CAP;

  for await (const f of files) {
    const rel = relative(cwd, f).split(sep).join("/") || f;
    if (filter && !filter.test(args.filter!.includes("/") ? rel : rel.split("/").pop()!)) continue;
    if (!args.pattern) { // no pattern: plain list of files (replaces Glob)
      fileCount++; totalCount++;
      if (shownCount < max) { shownCount++; blocks.push(rel); nativeChars += rel.length + 1; }
      continue;
    }
    if ((await stat(f)).size > MAX_SIZE) continue;
    const raw = await readFile(f);
    if (raw.subarray(0, 8000).includes(0)) continue; // binaire
    const lines = splitLines(raw.toString("utf8"));

    const found: number[] = [];
    lines.forEach((l, i) => { if (regex.test(l)) found.push(i); });
    if (!found.length) continue;

    fileCount++;
    totalCount += found.length;
    // “files” / “count” modes: one line per file; native reference = Grep
    // files_with_matches (`path`) or count (`path:n`) for the same files shown.
    if (mode !== "lines") {
      if (shownCount >= max) continue;
      shownCount++;
      const suffix = mode === "count" ? `:${found.length}` : "";
      blocks.push(`${rel}${suffix}`);
      nativeChars += rel.length + suffix.length + 1;
      continue;
    }
    if (shownCount >= max) continue;

    const toShow = found.slice(0, max - shownCount);
    shownCount += toShow.length;
    // Honest native reference: the SAME lines (and context) in `grep -rn` format
    // (full path repeated) — the savings come from the compact format, not from truncation.
    for (const i of toShow) {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        nativeChars += rel.length + String(j + 1).length + lines[j].length + 3;
      }
    }
    const seen = new Set<number>();
    const output: string[] = [rel];
    const enclosing = args.symbols || args.expand ? enclosingSymbol(f, lines) : null;
    let lastSymbol: string | undefined;
    const expanded = new Set<string>();
    for (const i of toShow) {
      if (args.expand && seen.has(i)) continue; // already inside an expanded body
      const span = enclosing?.(i);
      // expand: the whole enclosing body once (exact lines, `n|code` like read), if small enough and in budget.
      if (args.expand && span) {
        if (expanded.has(span.label)) continue;
        const n = span.end - span.start + 1;
        const body = lines.slice(span.start, span.end + 1).map((l, k) => `${span.start + k + 1}|${truncate(l, 500)}`);
        const size = body.reduce((s, l) => s + l.length + 1, 0);
        if (n <= EXPAND_MAX_LINES && expandBudget >= size) {
          expanded.add(span.label);
          expandBudget -= size;
          output.push(`  › ${span.label}`, ...body);
          // Native equivalent: a Read of the same range on top of the grep line.
          nativeChars += lines.slice(span.start, span.end + 1).reduce((s, l, k) => s + l.length + String(span.start + k + 1).length + 2, 0);
          for (let j = span.start; j <= span.end; j++) seen.add(j);
          lastSymbol = span.label;
          continue;
        }
      }
      if (enclosing) {
        const s = span?.label;
        if (s !== lastSymbol) { output.push(`  › ${s ?? "(top level)"}${args.expand && span ? " (too long or over budget: read name=…)" : ""}`); lastSymbol = s; }
      }
      const from = Math.max(0, i - ctx), a = Math.min(lines.length - 1, i + ctx);
      if (ctx && output.length > 1 && !seen.has(from - 1) && !seen.has(from)) output.push("  --");
      for (let j = from; j <= a; j++) {
        if (seen.has(j)) continue;
        seen.add(j);
        output.push(`  ${j + 1}${j === i ? ":" : "-"} ${truncate(lines[j].trim(), 160)}`);
      }
    }
    if (toShow.length < found.length) output.push(`  [+${found.length - toShow.length} more in this file]`);
    blocks.push(output.join("\n"));
  }

  if (!totalCount) return { text: "No matches.", nativeChars: 0 };
  // Counters cover ALL the files walked: only the display is capped.
  const header = args.pattern ? `${totalCount} match(es) in ${fileCount} file(s) (exact count)` : `${fileCount} file(s) (exact count)`;
  const rest = mode === "lines" ? totalCount - shownCount : fileCount - shownCount;
  const unit = mode === "lines" ? "matches" : "files";
  const footer = rest > 0 ? `\n[truncated: ${rest} ${unit} not shown — refine the pattern, raise max_results, or use mode files/count]` : "";
  return {
    text: `${header}\n${blocks.join("\n")}${footer}`,
    nativeChars,
    details: { pattern: args.pattern, mode, files: fileCount, results: totalCount },
  };
}

/** Cap of the text returned by a batch search (≈ 10k tokens), like readMany. */
export const MANY_CAP = 40_000;

/**
 * Several searches in ONE call (every extra call costs a full turn). A failing query does not
 * cancel the others; past the cap, the remaining queries are listed without being run.
 */
export async function searchMany(queries: SearchArgs[], cwd: string = process.cwd(), cap = MANY_CAP): Promise<ToolResult> {
  const chunks: string[] = [];
  let native = 0, size = 0, i = 0;
  const label = (q: SearchArgs) => `${q.pattern ?? `files ${q.filter ?? ""}`}${q.filePath ? ` in ${q.filePath}` : ""}`;
  for (; i < queries.length; i++) {
    let text: string;
    try {
      const r = await searchCompact(queries[i], cwd);
      text = r.text; native += r.nativeChars;
    } catch (e) { text = `error: ${(e as Error).message}`; }
    const block = `=== ${label(queries[i])} ===\n${text}`;
    if (size + block.length > cap && chunks.length) break;
    chunks.push(block); size += block.length;
  }
  if (i < queries.length) chunks.push(`[size cap reached; not run: ${queries.slice(i).map(label).join(", ")}]`);
  return { text: chunks.join("\n\n"), nativeChars: native, details: { queries: queries.length, runCount: i } };
}
