/**
 * Offline benchmark (free, deterministic) of token-eco on real code.
 * Ground truth: the TypeScript compiler (TS/JS) and the ast module (Python).
 * Usage: node bench/bench.ts   → prints and writes bench/RESULTS.md
 */
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { outline } from "../src/tools/outline.ts";
import { readSymbol } from "../src/tools/readSymbol.ts";
import { searchCompact, IGNORED_DIRS } from "../src/tools/searchCompact.ts";
import { estimateTokens } from "../src/tokens.ts";
import { nativeReadChars, splitLines } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NM = join(HERE, "../node_modules");

interface Decl { name: string; start: number; decl_line: number; end: number }
interface FileEntry { filePath: string; lang: "ts" | "js" | "py"; decls: Decl[]; legit: Set<number> }

// ---------- Corpus ----------
function listAll(folder: string, filter: (f: string) => boolean, max = Infinity): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && e.name !== "test" && e.name !== "tests") walk(p);
      else if (e.isFile() && filter(p) && statSync(p).size > 3000) out.push(p);
    }
  };
  walk(folder);
  return out;
}

// ---------- TS/JS ground truth ----------
const isFunction = (n: ts.Node) =>
  ts.isFunctionLike(n) && !ts.isMethodSignature(n) && !ts.isCallSignatureDeclaration(n) && !ts.isConstructSignatureDeclaration(n);

function tsTruth(filePath: string): FileEntry {
  const text = readFileSync(filePath, "utf8");
  const js = filePath.endsWith(".js");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const decls: Decl[] = [];
  const legit = new Set<number>();
  const addTo = (name: string, n: ts.Node) => {
    const l = line(n.getStart(sf));
    decls.push({ name, start: l, decl_line: l, end: line(n.getEnd()) });
  };

  // Only “structural” declarations count: not the ones nested in a function body.
  const visit = (n: ts.Node, inFunction: boolean) => {
    if (!inFunction) {
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) ||
           ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)) && n.name) {
        if (!(ts.isFunctionDeclaration(n) && !n.body)) addTo(n.name.getText(sf), n);
        else legit.add(line(n.getStart(sf))); // surcharge : affichage acceptable
      } else if ((ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && n.body && ts.isClassLike(n.parent)) {
        addTo(n.name.getText(sf), n);
      } else if (ts.isConstructorDeclaration(n) && n.body) {
        addTo("constructor", n);
      } else if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) {
          const init = d.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init)) && ts.isIdentifier(d.name)) {
            addTo(d.name.text, n);
          } else if (ts.isSourceFile(n.parent)) legit.add(line(n.getStart(sf))); // export const … : acceptable
        }
      } else if ((ts.isExportDeclaration(n) || ts.isExportAssignment(n)) && ts.isSourceFile(n.parent)) {
        legit.add(line(n.getStart(sf)));
      } else if (ts.isPropertyDeclaration(n) || ts.isMethodSignature(n) || ts.isPropertySignature(n) || ts.isIndexSignatureDeclaration(n)) {
        legit.add(line(n.getStart(sf)));
      }
    }
    ts.forEachChild(n, (c) => visit(c, inFunction || isFunction(n)));
  };
  visit(sf, false);
  for (const d of decls) legit.add(d.decl_line);
  return { filePath, lang: js ? "js" : "ts", decls, legit };
}

// ---------- Python ground truth ----------
function pyTruth(paths: string[]): FileEntry[] {
  const json = execFileSync("python3", [join(HERE, "truth.py")], { input: paths.join("\n"), maxBuffer: 1 << 28 }).toString();
  const res = JSON.parse(json) as Record<string, Decl[]>;
  return Object.entries(res).map(([filePath, decls]) => ({
    filePath, lang: "py" as const, decls, legit: new Set(decls.map((d) => d.decl_line)),
  }));
}
// ---------- Measurements ----------
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pc = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "–") + " %";

interface Stats {
  files: number; decls: number; found: number; outlineLines: number; legitLines: number;
  tokOutline: number; tokNative: number; outlineRatios: number[];
  symTested: number; symExact: number; symStartOk: number; tokSym: number; tokSymNative: number;
  failures: string[];
}
const empty = (): Stats => ({ files: 0, decls: 0, found: 0, outlineLines: 0, legitLines: 0, tokOutline: 0, tokNative: 0,
  outlineRatios: [], symTested: 0, symExact: 0, symStartOk: 0, tokSym: 0, tokSymNative: 0, failures: [] });

async function evaluate(f: FileEntry, s: Stats) {
  const lines = splitLines(readFileSync(f.filePath, "utf8"));
  const native = estimateTokens(nativeReadChars(lines));
  s.files++;

  const ap = await outline({ file: f.filePath });
  const seen = new Set([...ap.text.matchAll(/^\s*(\d+)\|/gm)].map((m) => Number(m[1])));
  s.decls += f.decls.length;
  s.found += f.decls.filter((d) => seen.has(d.decl_line)).length;
  s.outlineLines += seen.size;
  s.legitLines += [...seen].filter((l) => f.legit.has(l)).length;
  const tAp = estimateTokens(ap.text);
  s.tokOutline += tAp; s.tokNative += native; s.outlineRatios.push(tAp / native);

  const count = new Map<string, number>();
  for (const d of f.decls) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  for (const d of f.decls.filter((d) => count.get(d.name) === 1).slice(0, 15)) {
    const r = await readSymbol({ file: f.filePath, name: d.name });
    const m = /\[(\d+)-(\d+)\/\d+\]/.exec(r.text.split("\n")[0]);
    s.symTested++;
    s.tokSym += estimateTokens(r.text); s.tokSymNative += native;
    const a = m ? Number(m[1]) : -1, b = m ? Number(m[2]) : -1;
    if (a <= d.decl_line && d.decl_line <= b) s.symStartOk++;
    // Trailing comments/blank lines at the end of a block tolerated (ast/TS exclude them, but they belong to the body).
    const endOk = b >= d.end && lines.slice(d.end, b).every((l) => /^\s*(#.*|\/\/.*)?$/.test(l));
    if (a <= d.decl_line && a >= d.start - 30 && endOk) s.symExact++;
    else if (s.failures.length < 12) s.failures.push(`${relative(NM, f.filePath)} › ${d.name} : expected ${d.decl_line}-${d.end}, obtenu ${a}-${b}`);
  }
}

function statsLine(name: string, s: Stats): string {
  return `| ${name} | ${s.files} | ${pc(s.found, s.decls)} | ${pc(s.legitLines, s.outlineLines)} | ` +
    `${pc(s.tokOutline, s.tokNative)} (med. ${(100 * median(s.outlineRatios)).toFixed(1)} %) | ` +
    `${pc(s.symExact, s.symTested)} / ${pc(s.symStartOk, s.symTested)} (${s.symTested}) | ${pc(s.tokSym, s.tokSymNative)} |`;
}

// ---------- Search: search_compact vs real grep ----------
async function benchSearch(root: string, names: string[]) {
  const excluded = [...IGNORED_DIRS].map((d) => `--exclude-dir=${d}`);
  const lines: string[] = [];
  let tokGrep = 0, tokFiles = 0, tokEco = 0, exactCounts = 0;
  for (const pattern of names) {
    const output = (args: string[]) => {
      try { return execFileSync("grep", [...args, "--include=*.ts", ...excluded, "-E", pattern, "."], { cwd: root, maxBuffer: 1 << 28 }).toString(); }
      catch { return ""; }
    };
    const grepN = output(["-rn"]), grepL = output(["-rl"]);
    const nGrep = grepN ? grepN.trimEnd().split("\n").length : 0;
    const r = await searchCompact({ pattern, filter: "*.ts" }, root);
    const nEco = Number(/^(\d+) match/.exec(r.text)?.[1] ?? 0);
    if (nEco === nGrep) exactCounts++;
    const [tg, tl, te] = [estimateTokens(grepN), estimateTokens(grepL), estimateTokens(r.text)];
    tokGrep += tg; tokFiles += tl; tokEco += te;
    lines.push(`| \`${pattern}\` | ${nGrep} | ${nEco} | ${tg} | ${tl} | ${te} | ${pc(te, tg)} |`);
  }
  return { lines, tokGrep, tokFiles, tokEco, exactCounts };
}

// ---------- Run ----------
const t0 = Date.now();
const fTS = [...listAll(join(NM, "zod/src"), (p) => p.endsWith(".ts") && !p.endsWith(".d.ts")),
             ...listAll(join(NM, "ajv/lib"), (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"))].map(tsTruth);
const fJS = listAll(join(NM, "@modelcontextprotocol/sdk/dist/esm"), (p) => p.endsWith(".js"), 40).map(tsTruth);
const stdlib = execFileSync("python3", ["-c", "import sysconfig;print(sysconfig.get_paths()['stdlib'])"]).toString().trim();
const fPY = pyTruth(readdirSync(stdlib).filter((f) => f.endsWith(".py")).map((f) => join(stdlib, f))
  .filter((p) => statSync(p).size > 3000).sort());

const results: Record<string, Stats> = { "TypeScript (zod, ajv)": empty(), "JavaScript (MCP SDK, compiled)": empty(), "Python (stdlib 3.15)": empty() };
for (const [name, files] of [["TypeScript (zod, ajv)", fTS], ["JavaScript (MCP SDK, compiled)", fJS], ["Python (stdlib 3.15)", fPY]] as const) {
  for (const f of files) await evaluate(f, results[name]);
}

const tsNames = [...new Set(fTS.flatMap((f) => f.decls.map((d) => d.name)))].filter((n) => n.length >= 5).sort();
const sample = tsNames.filter((_, i) => i % Math.max(1, Math.floor(tsNames.length / 10)) === 0).slice(0, 10);
const searchRes = await benchSearch(join(NM, "zod/src"), sample);

const report = `# token-eco offline benchmark results

Generated by \`node bench/bench.ts\` in ${((Date.now() - t0) / 1000).toFixed(1)} s. Ground truth: the TypeScript compiler
(TS/JS) and the \`ast\` module (Python). Estimated tokens (chars/4). “Native” reference = Claude Code Read
(2000 lines max). These figures measure the **quality** and **size** of the answers, not a real session.

## outline and read symbol

| Corpus | Files | Outline recall¹ | Outline precision² | Outline size / native Read | Read symbol exact³ / correct start (n) | Read symbol size / native Read |
|---|---|---|---|---|---|---|
${Object.entries(results).map(([n, s]) => statsLine(n, s)).join("\n")}

1. Share of structural declarations (functions, classes, methods, types…) visible in the outline.
2. Share of outline lines that are real declarations (the rest is noise).
3. Returned block exactly equal to the syntax tree node (start, JSDoc and decorators included, and end).

Read symbol failure examples:
${Object.values(results).flatMap((s) => s.failures.slice(0, 4)).map((e) => `- ${e}`).join("\n")}

## search_compact vs grep (zod/src, *.ts)

| Pattern | grep results | compact results | \`grep -rn\` tokens | \`grep -rl\` tokens | compact tokens | compact / grep -rn |
|---|---|---|---|---|---|---|
${searchRes.lines.join("\n")}

Total: compact = ${pc(searchRes.tokEco, searchRes.tokGrep)} of \`grep -rn\`; identical count for ${searchRes.exactCounts}/${sample.length} patterns.
Past 50 results, the compact output is deliberately truncated and says so.
Reminder: Claude Code's native Grep returns by default only the list of files (\`grep -rl\`, ${searchRes.tokFiles} tokens in total).
`;
writeFileSync(join(HERE, "RESULTS.md"), report);
console.log(report);
