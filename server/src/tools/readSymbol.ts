import { readFile } from "node:fs/promises";
import { nativeReadChars, absolutePath, splitLines, truncate, type ToolResult } from "../types.ts";
import { startWithPrefixes, esc, isDeclaration, blockEnd, computeMask, profileFor } from "../languages/engine.ts";

/**
 * Extracts a symbol (function, class, method, type, key, heading…) by name, in
 * any language. End of block from the profile: braces, indentation, `end`,
 * headings, semicolon (src/languages/).
 */

export interface ReadSymbolArgs {
  file: string;
  name: string;
}

const MAX_LINES = 400;
const COMPANION_MAX = 30; // max lines of a joined JS/TS homonym declaration
const DECL_WORDS = "function\\*?|class|interface|type|enum|namespace|module|def|defp|defn|const|let|var|val|struct|trait|impl|fn|func|fun|sub|proc|macro|record|object|protocol|extension|actor|mixin|contract|library|message|service";

/** Is the name the identifier DECLARED on this line (not a mere mention)? */
function strongDeclaration(line: string, n: string, kws: string, headings: boolean): boolean {
  // `^#… name` only makes sense for heading profiles (otherwise `#define … nameX` would match).
  if (!headings && /^\s*#/.test(line) && !new RegExp(`(?:^|[^\\w$])${n}(?![\\w$])`).test(line)) return false;
  return new RegExp(`(?:^|[^\\w$])(?:${kws}${DECL_WORDS})\\s+(?:[\\w$.]*[.:])?${n}(?![\\w$])`).test(line)
    || new RegExp(`(?:^|[\\s.*&:)>])\\*?\\s*#?${n}\\s*(<[^>]*>)?\\s*\\(`).test(line)
    || new RegExp(`^\\s*["']?${n}["']?\\s*(:[^=]+)?(=|:=|<-|:(\\s|$))`).test(line)
    || new RegExp(`^\\s*${n}\\s+(struct|interface)\\b`).test(line) // Go: type in a `type ( … )` group
    || new RegExp(`id=["']${n}["']|\\[\\[?(?:[\\w.-]*\\.)?${n}\\]\\]?|^#{1,6}\\s.*${n}`).test(line);
}

export async function readSymbol(args: ReadSymbolArgs, cwd?: string): Promise<ToolResult> {
  const content = await readFile(absolutePath(args.file, cwd), "utf8");
  const lines = splitLines(content);
  const profile = profileFor(args.file, content.slice(0, 8000));
  const mask = computeMask(lines, profile);
  const nativeChars = nativeReadChars(lines);
  const n = esc(args.name);
  const kws = profile.kws ? `${profile.kws}|` : "";
  const mention = new RegExp(`(^|[^\\w$#-])${n}([^\\w$-]|$)`);
  const keyword = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:${kws}${DECL_WORDS})\\s+(?:[\\w$.]*[.:])?${n}(?![\\w$])`);
  const method = new RegExp(`^\\s*(?:[\\w<>\\[\\],*&:]+\\s+)*\\*?\\s*#?${n}\\s*(<[^>]*>)?\\s*\\((?!.*;\\s*$)`);

  // Priority: lines that DECLARE the name; then “keyword name” declarations the profiles
  // miss (nested functions); then declarations mentioning it; then “name(”.
  const strong: number[] = [], strongOutside: number[] = [], faibles: number[] = [], filet: number[] = [];
  lines.forEach((l, i) => {
    if (mask[i]) return;
    const decl = isDeclaration(l, profile);
    if (decl && strongDeclaration(l, n, kws, profile.block === "headings")) strong.push(i);
    else if (!decl && keyword.test(l)) strongOutside.push(i);
    else if (decl && mention.test(l)) faibles.push(i);
    else if (method.test(l) && !/^\s*(return|if|while|for|await|new|throw|yield)\b/.test(l)) filet.push(i);
  });
  const candidates = [strong, strongOutside, faibles, filet].find((c) => c.length) ?? [];
  if (!candidates.length) {
    return { text: `"${args.name}" not found in ${args.file} (try outline or search).`, nativeChars };
  }

  // End of block of each candidate (capped); a “prototype” = signature without a body
  // ending with `;` (C/C++ declaration, TS overload, C#/Java interface method…).
  const examined = candidates.slice(0, 60);
  const ends = new Map(examined.map((c) => [c, blockEnd(lines, c, profile, mask)] as const));
  const prototype = (c: number) => {
    const block = lines.slice(c, (ends.get(c) ?? c) + 1).join("\n");
    return block.includes("(") && !block.includes("{") && !block.includes("=>") && /;\s*$/.test(block);
  };
  // Prefer the definition over the prototype; failing that, the first candidate.
  let decl = examined.find((c) => !prototype(c)) ?? candidates[0];
  const end = ends.get(decl) ?? blockEnd(lines, decl, profile, mask);
  const included = new Set([decl]);
  // Include the contiguous prototypes/overloads above (blank lines, comments, `template<…>` tolerated).
  const byEnd = new Map(examined.filter(prototype).map((c) => [ends.get(c)!, c] as const));
  for (;;) {
    let j = decl - 1;
    while (j >= 0 && (!lines[j].trim() || /^\s*(\/\/|\/\*\*?|\*|template\s*<)/.test(lines[j]))) j--;
    const c = byEnd.get(j);
    if (c === undefined || included.has(c)) break;
    included.add(c);
    decl = c;
  }
  let others = candidates.filter((c) => !included.has(c));

  const { start, omitted } = startWithPrefixes(lines, decl, profile);
  const shownEnd = Math.min(end, start + MAX_LINES - 1);

  // JS/TS declaration merging (`const X` + `type X`, `class X` + `interface X`…): join the
  // short top-level homonyms so one call returns the whole symbol.
  const segments: [number, number][] = [[start, shownEnd]];
  if ((profile.id === "typescript" || profile.id === "javascript") && candidates === strong) {
    const companions = others
      .filter((c) => !/^\s/.test(lines[c]) && ends.has(c) && ends.get(c)! - c < COMPANION_MAX)
      .slice(0, 3);
    for (const c of companions) {
      const s = startWithPrefixes(lines, c, profile).start;
      segments.push([s, ends.get(c)!]);
    }
    others = others.filter((c) => !companions.includes(c));
    segments.sort((a, b) => a[0] - b[0]);
    // Merge segments separated only by blank lines.
    for (let k = segments.length - 1; k > 0; k--) {
      const [prev, cur] = [segments[k - 1], segments[k]];
      if (lines.slice(prev[1] + 1, cur[0]).every((l) => !l.trim())) {
        prev[1] = Math.max(prev[1], cur[1]);
        segments.splice(k, 1);
      }
    }
  }
  const last = segments[segments.length - 1][1];
  const width = String(last + 1).length;
  const body = segments.map(([s, e]) => lines.slice(s, e + 1)
    .map((l, k) => `${String(s + k + 1).padStart(width)}|${truncate(l, 500)}`).join("\n")).join("\n…\n");
  const first = segments[0][0];
  const range = segments.length === 1 && first === start && last === shownEnd ? `${start + 1}-${end + 1}`
    : segments.map(([s, e]) => `${s + 1}-${e + 1}`).join(",");

  const notes: string[] = [];
  if (omitted) notes.push(`[${omitted[1] - omitted[0] + 1}-line doc omitted: read_range ${omitted[0]}-${omitted[1]}]`);
  if (shownEnd < end) notes.push(`[truncated at ${MAX_LINES} lines: rest with read_range ${shownEnd + 2}-${end + 1}]`);
  if (others.length) notes.push(`[other occurrences: l.${others.slice(0, 10).map((c) => c + 1).join(", ")}]`);
  return {
    text: [`${args.file} › ${args.name} [${range}/${lines.length}]`, body, ...notes].join("\n"),
    nativeChars,
    details: { file: args.file, name: args.name, language: profile.id, start: start + 1, end: end + 1 },
  };
}
