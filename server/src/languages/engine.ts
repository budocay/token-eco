import { basename, extname } from "node:path";
import { GENERIC, PROFILES, type Profile } from "./profiles.ts";

/** Engine shared by every language: detection, masking, declarations, end of block. */

const BY_EXT = new Map<string, Profile>();
for (const p of PROFILES) for (const e of p.ext ?? []) if (!BY_EXT.has(e)) BY_EXT.set(e, p);

/**
 * Profile of a file: exact name (Makefile…), then extension, then shebang, else the universal fallback.
 * `start` = beginning of the content (1st line for the shebang; a .h containing C++ is treated as C++).
 */
export function profileFor(file: string, start = ""): Profile {
  const name = basename(file);
  const byName = PROFILES.find((p) => p.files?.test(name));
  if (byName) return byName;
  const ext = extname(name).toLowerCase();
  if (ext === ".h" && /^\s*(class|namespace|template\s*<)\b|^\s*#include\s*<(iostream|string|vector|memory)>/m.test(start)) {
    return BY_EXT.get(".hpp")!;
  }
  const byExt = BY_EXT.get(ext);
  if (byExt) return byExt;
  const firstLine = start.split("\n", 1)[0];
  if (firstLine.startsWith("#!")) {
    const byShebang = PROFILES.find((p) => p.shebang?.test(firstLine));
    if (byShebang) return byShebang;
  }
  return GENERIC;
}

/** Words that start a statement, never a declaration (filter for “name(” forms). */
const CONTROL = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with", "new", "await", "typeof",
  "function", "super", "this", "delete", "throw", "yield", "case", "goto", "sizeof", "foreach", "lock",
  "elif", "unless", "until", "when", "match", "print", "echo", "defer", "go", "select", "not", "and", "or",
]);

/** Words that, at the start of a line, signal a statement (subset of CONTROL). */
const FIRST = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "new", "await", "throw", "yield",
  "case", "goto", "delete", "sizeof", "typeof", "foreach", "lock", "elif", "unless", "until", "defer", "go", "echo",
]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patternCache = new WeakMap<Profile, RegExp[]>();

function patterns(p: Profile): RegExp[] {
  let m = patternCache.get(p);
  if (!m) {
    m = [...(p.extra ?? [])];
    if (p.kws) m.unshift(new RegExp(`^\\s*${p.prefix ?? ""}(?:(?:${p.mods ?? "(?!)"})\\s+)*(?:${p.kws})(?![\\w$])`));
    patternCache.set(p, m);
  }
  return m;
}

export function isComment(line: string, p: Profile): boolean {
  const t = line.trimStart();
  return (p.lc ?? []).some((c) => t.startsWith(c));
}

/** Is position idx inside a string opened on the same line? */
function inString(l: string, idx: number): boolean {
  for (const q of ['"', "'", "`"]) {
    let n = 0;
    for (let i = 0; i < idx; i++) if (l[i] === q && l[i - 1] !== "\\") n++;
    if (n % 2) return true;
  }
  return false;
}

/** true for each line that STARTS inside a multi-line comment/string. */
export function computeMask(lines: string[], p: Profile): boolean[] {
  const pairs = p.bc ?? [];
  if (!pairs.length && !p.heredoc) return lines.map(() => false);
  let active = -1;
  let heredoc: string | null = null; // terminateur expected
  return lines.map((l) => {
    if (heredoc) {
      if (l.trim() === heredoc) heredoc = null;
      return true;
    }
    if (p.heredoc && active === -1) {
      const h = /<<<?[~-]?(\s?)(['"]?)([A-Za-z_]\w*)\2/.exec(l);
      if (h && !inString(l, h.index) && (!h[1] || /^[A-Z_][A-Z0-9_]*$/.test(h[3]))) heredoc = h[3];
    }
    const masked = active !== -1;
    // For the “inside a string” test, triple quotes do not count as quotes.
    const neutral = l.replace(/"""|'''/g, "\u0001\u0001\u0001");
    let pos = 0;
    for (;;) {
      if (active === -1) {
        let k = -1, at = Infinity;
        pairs.forEach(([o], j) => {
          let i = l.indexOf(o, pos);
          while (i !== -1 && inString(neutral, i)) i = l.indexOf(o, i + 1);
          if (i !== -1 && i < at) { at = i; k = j; }
        });
        if (k === -1) break;
        const lc = (p.lc ?? []).map((c) => l.indexOf(c, pos)).filter((i) => i !== -1 && i < at && !inString(l, i));
        if (lc.length) break; // opener placed after a line comment
        active = k;
        pos = at + pairs[k][0].length;
      } else {
        const i = l.indexOf(pairs[active][1], pos);
        if (i === -1) break;
        pos = i + pairs[active][1].length;
        active = -1;
      }
    }
    return masked;
  });
}

export function isDeclaration(line: string, p: Profile): boolean {
  if (line.length > 400 || !line.trim() || isComment(line, p)) return false;
  const ms = patterns(p);
  for (let k = 0; k < ms.length; k++) {
    const m = ms[k].exec(line);
    if (!m) continue;
    if (!(p.kws && k === 0)) {
      const first = /^\s*([A-Za-z_]\w*)/.exec(line)?.[1];
      if ((first && FIRST.has(first)) || (m.groups?.name && CONTROL.has(m.groups.name))) continue;
    }
    return true;
  }
  return false;
}

/** Indices of the declaration lines (outside comments/strings). */
export function declarations(lines: string[], p: Profile, mask = computeMask(lines, p)): number[] {
  let res: number[] = [];
  lines.forEach((l, i) => { if (!mask[i] && isDeclaration(l, p)) res.push(i); });
  if (p.minLevel && res.length) {
    const min = Math.min(...res.map((i) => indent(lines[i])));
    res = res.filter((i) => indent(lines[i]) === min);
  }
  return res;
}

export function isImport(line: string, p: Profile): boolean {
  return !!p.imports && !isComment(line, p) && p.imports.test(line);
}

/** Imported module, for the compact imports summary (all languages). */
export function importedModule(line: string): string {
  const q = /['"<]([^'"<>]+)['">]/.exec(line);
  if (q) return q[1];
  const m = /^\s*(?:from|import|use|using|require|include|open|alias|library|source|extern\s+crate)(?:\s+|\()(?:static\s+|global\s+)?([^\s;()]+)/.exec(line);
  return m ? m[1].replace(/[;,]$/, "") : line.trim().slice(0, 40);
}

export const indent = (l: string) => l.replace(/\t/g, "    ").search(/\S/);
export { esc };
// ---------- End of block ----------

/** Removes strings and the end-of-line comment before counting braces. */
function clean(l: string, p: Profile): string {
  let s = l.replace(/\\./g, "");
  for (const c of p.stringDelims ?? "\"'`") s = s.replace(new RegExp(`${esc(c)}[^${esc(c)}]*${esc(c)}`, "g"), "");
  for (const c of p.lc ?? []) {
    const m = new RegExp(`(^|\\s)${esc(c)}`).exec(s);
    if (m) s = s.slice(0, m.index);
  }
  return s;
}

const nextNonEmpty = (lines: string[], i: number) => { let j = i + 1; while (j < lines.length && !lines[j].trim()) j++; return j; };

function endBraces(lines: string[], start: number, p: Profile, mask: boolean[]): number {
  let depth = 0, ouvert = false, last = start;
  const base = indent(lines[start]);
  for (let i = start; i < lines.length && i < start + 5000; i++) {
    const raw = lines[i];
    if (i > start && mask[i]) { last = i; continue; }
    // No brace yet and back at the declaration's level: one-line declaration
    // (`type X int`, `fun f() = 1`). Exceptions: Allman brace, closing parenthesis.
    if (i > start && !ouvert && raw.trim() && indent(raw) <= base && !/^\s*[{()\]]/.test(raw)) return last;
    const l = clean(raw, p);
    for (const c of l) {
      if (c === "{") { depth++; ouvert = true; } else if (c === "}") depth--;
    }
    if (raw.trim()) last = i;
    // End = depth 0 at the declaration's level (avoids the `{ k: X }[]` of a parameter type).
    if (ouvert && depth <= 0 && (indent(raw) <= base || /;\s*$|\{\s*\}\s*$/.test(l))) return i;
    if (!ouvert && /;\s*$/.test(l)) return i;
    if (!ouvert && i - start > 30) break;
  }
  return endIndent(lines, start, mask);
}

function endIndent(lines: string[], start: number, mask: boolean[]): number {
  const base = indent(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (mask[i]) { end = i; continue; }
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= base) {
      if (/^\s*[)\]}]/.test(l)) { end = i; continue; }          // `):` of a multi-line signature
      if (indent(l) === base && /^\s*(<\/|end\w*\b(?!\s*[=(.]))/.test(l)) end = i; // </section>, endfunction
      break;
    }
    end = i;
  }
  return end;
}

function endKeyword(lines: string[], start: number, p: Profile, mask: boolean[]): number {
  const l0 = clean(lines[start], p);
  if (/\bend\s*$/.test(l0) || /,\s*do:/.test(l0)) return start; // one-line declaration
  const base = indent(lines[start]);
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (mask[i]) { last = i; continue; }
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) < base) return last;
    if (indent(l) === base) {
      if (/^\s*end\b/.test(l)) return i;
      if (/^\s*(rescue|ensure|else|elsif|elseif|when|in|catch|after)\b/.test(l)) { last = i; continue; }
      return last; // e.g. `def x = 1` (Ruby): no `end`
    }
    last = i;
  }
  return last;
}

function endHeadings(lines: string[], start: number, p: Profile, mask: boolean[]): number {
  const level = p.level ?? (() => 0);
  const n0 = level(lines[start]);
  let i = start + 1;
  for (; i < lines.length; i++) if (!mask[i] && isDeclaration(lines[i], p) && level(lines[i]) <= n0) break;
  let end = i - 1;
  while (end > start && !lines[end].trim()) end--;
  return end;
}

function endSemicolon(lines: string[], start: number, p: Profile, mask: boolean[]): number {
  for (let i = start; i < lines.length && i < start + 2000; i++) {
    if (!mask[i] && /;\s*$/.test(clean(lines[i], p))) return i;
  }
  return start;
}

/** Last line (index) of the block starting at declaration `start`. */
export function blockEnd(lines: string[], start: number, p: Profile, mask = computeMask(lines, p)): number {
  switch (p.block) {
    case "braces": return endBraces(lines, start, p, mask);
    case "indentation": return endIndent(lines, start, mask);
    case "end": return endKeyword(lines, start, p, mask);
    case "headings": return endHeadings(lines, start, p, mask);
    case "semicolon": return endSemicolon(lines, start, p, mask);
    case "auto": {
      const brace = clean(lines[start], p).includes("{") || /^\s*\{/.test(lines[nextNonEmpty(lines, start)] ?? "");
      return brace ? endBraces(lines, start, p, mask) : endIndent(lines, start, mask);
    }
  }
}

// ---------- Prefixes (decorators, attributes, documentation comments) ----------
const RE_DECORATOR = /^\s*(@|#\[|\[[A-Z][\w.]*(\(.*\))?\]\s*$|template\s*<.*>\s*$)/;
const RE_DOC = /^\s*(\/\*\*|\*|\*\/)/;
export const MAX_PREFIXE = 12;

/** Climbs over attached decorators and comments; beyond MAX_PREFIXE lines, the doc is omitted. */
export function startWithPrefixes(lines: string[], i: number, p: Profile): { start: number; omitted?: [number, number] } {
  const isPrefix = (l: string) => RE_DECORATOR.test(l) || RE_DOC.test(l) || (isComment(l, p) && !!l.trim());
  const climb = (j: number, test: (l: string) => boolean) => {
    for (;;) {
      if (j > 0 && test(lines[j - 1])) { j--; continue; }
      const t = multilineTemplateStart(lines, j);
      if (t < 0) return j;
      j = t;
    }
  };
  const j = climb(i, isPrefix);
  if (i - j <= MAX_PREFIXE) return { start: j };
  const k = climb(i, (l) => RE_DECORATOR.test(l));
  return { start: k, omitted: [j + 1, k] };
}

/** `template <A,\n   B>` over several lines right above line j: index of `template`, else -1. */
function multilineTemplateStart(lines: string[], j: number): number {
  if (j < 2 || !/>\s*$/.test(lines[j - 1])) return -1;
  for (let k = j - 2; k >= Math.max(0, j - 6); k--) {
    if (/[;{}]/.test(lines[k])) return -1;
    if (/^\s*template\s*</.test(lines[k])) return k;
  }
  return -1;
}
