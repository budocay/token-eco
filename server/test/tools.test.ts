import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRange } from "../src/tools/readRange.ts";
import { outline } from "../src/tools/outline.ts";
import { searchCompact, searchMany, globToRegex, declarationName } from "../src/tools/searchCompact.ts";
import { readMany } from "../src/tools/read.ts";

let dir: string;

const TS = `import { readFile } from "node:fs";
import type { X } from "./x";

export interface Options {
  a: number;
}

export async function load(filePath: string): Promise<string> {
  if (filePath) {
    return filePath;
  }
  return "";
}

export class Service {
  private n = 0;
  constructor(private o: Options) {
    this.n = 1;
  }
  async launch(x: number): Promise<void> {
    for (let i = 0; i < x; i++) {
      console.log(i);
    }
  }
}

export const double = (x: number) => x * 2;
`;

const PY = `import os
from pathlib import Path

MAX = 10

class Reader:
    def __init__(self, p):
        self.p = p

    async def read(self):
        if self.p:
            return 1

def main():
    pass
`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "token-eco-"));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "src/a.ts"), TS);
  await writeFile(join(dir, "src/b.py"), PY);
  await writeFile(join(dir, "node_modules/c.ts"), "load();\n");
  await writeFile(join(dir, "gros.txt"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
});

after(() => rm(dir, { recursive: true, force: true }));

test("read range: requested range and numbering", async () => {
  const r = await readRange({ file: "gros.txt", start: 10, end: 12 }, dir);
  assert.equal(r.text, "[10-12/500]\n10|line 10\n11|line 11\n12|line 12");
  // Native reference = Read with the same offset/limit: no fictitious savings.
  assert.ok(r.nativeChars < r.text.length);
});

test("read range: 200 lines by default, range outside the file", async () => {
  const r = await readRange({ file: "gros.txt" }, dir);
  assert.match(r.text, /^\[1-200\/500\]/);
  assert.ok(r.nativeChars > r.text.length * 2); // default native Read: 500 lines
  const empty = await readRange({ file: "gros.txt", start: 900 }, dir);
  assert.match(empty.text, /500 lines/);
});

test("outline TS: declarations without bodies or control structures", async () => {
  const r = await outline({ file: "src/a.ts" }, dir);
  for (const expected of ["interface Options", "function load", "class Service", "constructor(", "async launch(", "const double"]) {
    assert.ok(r.text.includes(expected), `missing : ${expected}\n${r.text}`);
  }
  for (const forbidden of ["if (", "for (", "console.log", "return"]) {
    assert.ok(!r.text.includes(forbidden), `unexpected: ${forbidden}\n${r.text}`);
  }
  assert.match(r.text, /imports \(2, from l\.1\): node:fs, \.\/x/);
  assert.ok(r.text.length < r.nativeChars);
});

test("outline Python", async () => {
  const r = await outline({ file: "src/b.py" }, dir);
  for (const expected of ["MAX = 10", "class Reader:", "def __init__", "async def read", "def main"]) {
    assert.ok(r.text.includes(expected), `missing : ${expected}\n${r.text}`);
  }
  assert.ok(!r.text.includes("return"));
  assert.match(r.text, /imports \(2.*os, pathlib/);
});

test("search: grouping, node_modules skipped, filter", async () => {
  const r = await searchCompact({ pattern: "load" }, dir);
  assert.match(r.text, /^1 match\(es\) in 1 file\(s\) \(exact count\)/);
  assert.match(r.text, /src\/a\.ts\n {2}8: export async function load/);
  assert.ok(!r.text.includes("node_modules"));
  const nothing = await searchCompact({ pattern: "load", filter: "*.py" }, dir);
  assert.match(nothing.text, /No matches/);
});

test("search: cap, exact total, native reference = lines shown", async () => {
  const r = await searchCompact({ pattern: "line", maxResults: 5 }, dir);
  assert.match(r.text, /^500 match/);
  assert.match(r.text, /\[truncated: 495 matches not shown/);
  assert.ok(r.nativeChars < 200, `native = 5 grep -rn lines, not 500 (${r.nativeChars})`);
});

test("search: files and count modes", async () => {
  const f = await searchCompact({ pattern: "load|line", mode: "files" }, dir);
  assert.match(f.text, /\(exact count\)\n.*\n.*$/);
  assert.ok(!/\d+: /.test(f.text));
  const c = await searchCompact({ pattern: "line", mode: "count" }, dir);
  assert.match(c.text, /gros\.txt:500/);
});

test("search symbols: each hit labelled with its enclosing function/method", async () => {
  const r = await searchCompact({ pattern: "console\\.log|return filePath|self\\.p = p", symbols: true }, dir);
  assert.match(r.text, /› launch L20-24\n\s+22: console\.log/);
  assert.match(r.text, /› load L8-13\n\s+10: return filePath/);
  assert.match(r.text, /› __init__ L7-8/);
  assert.equal(declarationName("export const double = (x: number) => x * 2;"), "double");
});

test("read targets: several reads in one call, isolated error, cap", async () => {
  const r = await readMany([
    { file: "src/a.ts", name: "load" }, { file: "absent.ts" }, { file: "gros.txt", start: 2, end: 3 },
  ], dir, 300);
  assert.match(r.text, /=== src\/a\.ts load ===[\s\S]*return filePath/);
  assert.match(r.text, /=== absent\.ts ===\nerror:/);
  assert.match(r.text, /=== gros\.txt 2-3 ===[\s\S]*line 3/);
  const cap = await readMany([{ file: "src/a.ts" }, { file: "src/b.py" }], dir, 300, 100);
  assert.match(cap.text, /not read: src\/b\.py/);
});

test("search expand: whole enclosing body once, exact indentation, top-level hits as lines", async () => {
  const r = await searchCompact({ pattern: "console\\.log|for \\(let|^import os", expand: true }, dir);
  assert.match(r.text, /› launch L20-24\n20\|  async launch\(x: number\): Promise<void> \{\n21\|    for/);
  assert.equal(r.text.match(/› launch/g)?.length, 1); // two hits, one body
  assert.match(r.text, /src\/b\.py\n  1: import os/);
  assert.ok(r.nativeChars > 0);
});

test("search queries: several searches in one call, isolated error, cap", async () => {
  const r = await searchMany([{ pattern: "console\\.log" }, { pattern: "(" }, { filter: "*.py" }], dir);
  assert.match(r.text, /=== console\\\.log ===\n1 match/);
  assert.match(r.text, /=== \( ===\nerror:/);
  assert.match(r.text, /=== files \*\.py ===\n1 file/);
  const cap = await searchMany([{ pattern: "class" }, { pattern: "def" }], dir, 50);
  assert.match(cap.text, /not run: def/);
});

test("read target with pattern: matching lines of one file with context", async () => {
  const r = await readMany([{ file: "src/b.py", pattern: "self\\.p", context: 0 }, { file: "src/a.ts", name: "double" }], dir, 300);
  assert.match(r.text, /=== src\/b\.py \/self\\\.p\/ ===\n2 match\(es\)[\s\S]*8: self\.p = p/);
  assert.match(r.text, /=== src\/a\.ts double ===/);
});

test("globToRegex", () => {
  assert.ok(globToRegex("*.ts").test("a.ts"));
  assert.ok(!globToRegex("*.ts").test("src/a.ts"));
  assert.ok(globToRegex("src/**/*.{ts,py}").test("src/x/y/b.py"));
  assert.ok(globToRegex("src/**/*.ts").test("src/a.ts"));
});
