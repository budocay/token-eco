import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { readSymbol } from "../src/tools/readSymbol.ts";
import { batchEdit } from "../src/tools/batchEdit.ts";
import { estimateTokens } from "../src/tokens.ts";
import { DatabaseSync } from "node:sqlite";
import { record, aggregate, byKey, byDay, recent, closeDb, openDb } from "../src/db.ts";
import { summaryText, statistics, formatTokens, formatUsd } from "../src/stats.ts";
import { startServer } from "../src/web.ts";
import { decide, ruleMatches } from "../src/hook.ts";
import { compact, family } from "../src/compact.ts";
import { read } from "../src/tools/read.ts";
import { searchCompact } from "../src/tools/searchCompact.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

let dir: string;

const TS = `/** Doc */
export function a(x: number) {
  const o = { b: "}" };
  return x;
}

export class C {
  m() {
    return 1;
  }
}
export type T = { x: number };
`;
const PY = `class K:
    def f(self):
        return 1

    def g(self):
        pass

def h():
    pass
`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "token-eco-"));
  process.env.TOKEN_ECO_HOME = join(dir, "home");
  await writeFile(join(dir, "a.ts"), TS);
  await writeFile(join(dir, "b.py"), PY);
});

after(async () => { closeDb(); await rm(dir, { recursive: true, force: true }); });

test("estimateTokens: chars/4 rounded up", () => {
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(8), 2);
  assert.equal(estimateTokens(""), 0);
});

test("read symbol TS: JSDoc included, brace inside a string ignored", async () => {
  const r = await readSymbol({ file: "a.ts", name: "a" }, dir);
  assert.match(r.text, /› a \[1-5\/12\]/);
  assert.ok(r.text.includes("return x;") && !r.text.includes("class C"));
  const m = await readSymbol({ file: "a.ts", name: "m" }, dir);
  assert.match(m.text, /\[8-10\/12\]/);
  const t = await readSymbol({ file: "a.ts", name: "T" }, dir);
  assert.match(t.text, /\[12-12\/12\]/);
  const absent = await readSymbol({ file: "a.ts", name: "zzz" }, dir);
  assert.match(absent.text, /not found/);
});

test("read symbol Python: block by indentation", async () => {
  const k = await readSymbol({ file: "b.py", name: "K" }, dir);
  assert.match(k.text, /\[1-6\/9\]/);
  const f = await readSymbol({ file: "b.py", name: "f" }, dir);
  assert.match(f.text, /\[2-3\/9\]/);
});

test("read symbol C/TS: definition preferred over prototype, contiguous overloads included", async () => {
  await writeFile(join(dir, "p.c"), "int f(int a);\n\n#define G compiled_x\nint g(void);\n\nint f(int a) {\n  return a;\n}\n");
  const f = await readSymbol({ file: "p.c", name: "f" }, dir);
  assert.match(f.text, /\[6-8\/8\]/);
  assert.match(f.text, /other occurrences: l\.1/);
  await writeFile(join(dir, "s.ts"), "export function h(a: string): string;\nexport function h(a: number): number;\nexport function h(a: any): any {\n  return a;\n}\n");
  const h = await readSymbol({ file: "s.ts", name: "h" }, dir);
  assert.match(h.text, /\[1-5\/5\]/);
  await writeFile(join(dir, "t.hpp"), "int x;\ntemplate <typename A,\n          typename B>\nconstexpr auto k(A a) {\n  return a;\n}\n");
  const k = await readSymbol({ file: "t.hpp", name: "k" }, dir);
  assert.match(k.text, /\[2-6\/6\]/);
});

test("guidance: injected for the main thread and for every subagent", async () => {
  const { guidanceOutput } = await import("../src/guidance.ts");
  for (const ev of ["SessionStart", "SubagentStart"] as const) {
    const o = JSON.parse(guidanceOutput(ev)).hookSpecificOutput;
    assert.equal(o.hookEventName, ev);
    assert.match(o.additionalContext, /^token-eco:/);
  }
});

test("read symbol TS: homonym const + type joined (adjacent merged, distant as segment)", async () => {
  await writeFile(join(dir, "h.ts"), "export const U = z.object({\n  id: z.string(),\n});\n\nexport type U = z.infer<typeof U>;\n\nfunction use(u: U) {\n  return u;\n}\n\nexport interface U2 {}\nexport type V = 1;\nconst x = 0;\nexport const V = 2;\n");
  const u = await readSymbol({ file: "h.ts", name: "U" }, dir);
  assert.match(u.text, /\[1-5\/14\]/);
  assert.doesNotMatch(u.text, /other occurrences/);
  const v = await readSymbol({ file: "h.ts", name: "V" }, dir);
  assert.match(v.text, /\[12-12,14-14\/14\]/);
  assert.match(v.text, /\n…\n/);
});

test("hook: full Read of a big file refused then allowed on the 2nd try; small files, ranges and Grep list let through", () => {
  const cfg = { ...DEFAULT_CONFIG, hook: { mode: "redirect" as const, lineThreshold: 300 } };
  const lines = (n: number) => () => n;
  const read = { session_id: "s", tool_name: "Read", tool_input: { file_path: "/p/a.ts" } };
  const state: Record<string, number> = {};
  const d1 = decide(read, cfg, state, 1000, lines(800));
  assert.equal(d1.action, "refused");
  assert.match((d1 as { message: string }).message, /800 lines.*outline.*repeat the exact same call/s);
  state[(d1 as { key: string }).key] = 1000;
  assert.equal(decide(read, cfg, state, 5000, lines(800)).action, "fallback");
  assert.equal(decide(read, cfg, state, 1000 + 11 * 60_000, lines(800)).action, "refused"); // delay expired
  assert.equal(decide(read, cfg, {}, 0, lines(100)).action, "pass");
  assert.equal(decide({ ...read, tool_input: { file_path: "/p/a.ts", offset: 1 } }, cfg, {}, 0, lines(800)).action, "pass");
  assert.equal(decide({ ...read, tool_input: { file_path: "/p/x.png" } }, cfg, {}, 0, lines(800)).action, "pass");
  assert.equal(decide({ tool_name: "Grep", tool_input: { pattern: "x" } }, cfg, {}, 0).action, "pass");
  assert.equal(decide({ tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content" } }, cfg, {}, 0).action, "refused");
  assert.equal(decide(read, { ...cfg, hook: { mode: "off", lineThreshold: 300 } }, {}, 0, lines(800)).action, "pass");
});

test("hook: `cat big-file` in Bash handled as a full Read (shared retry state); small files, pipes, flags let through", () => {
  const cfg = { ...DEFAULT_CONFIG, hook: { mode: "redirect" as const, lineThreshold: 300 } };
  const seen: string[] = [];
  const lines = (n: number) => (f: string) => { seen.push(f); return n; };
  const bash = (command: string) => ({ session_id: "s", cwd: "/p", tool_name: "Bash", tool_input: { command } });
  const d = decide(bash("cd sub && cat 'a b.ts'"), cfg, {}, 0, lines(800));
  assert.equal(d.action, "refused");
  assert.equal((d as { key: string }).key, "s|Read|/p/sub/a b.ts");
  assert.match((d as { message: string }).message, /`cat a b.ts` is expensive/);
  assert.equal(decide(bash("cat a.ts"), cfg, { "s|Read|/p/a.ts": 500 }, 1000, lines(800)).action, "fallback"); // a Read was refused before
  assert.equal(decide(bash("cat a.ts"), cfg, {}, 0, lines(100)).action, "pass");
  for (const c of ["cat a.ts | head", "cat -n a.ts", "cat a.ts b.ts", "cat $F"]) assert.equal(decide(bash(c), cfg, {}, 0, lines(800)).action, "pass", c);
  assert.equal(family("flutter test"), "test"); assert.equal(family("flutter analyze"), "build"); assert.equal(family("dart pub get"), "install");
});

test("hook Bash: transparent rewrite, permissions respected, compound commands left alone", () => {
  const cfg = { ...DEFAULT_CONFIG };
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });
  const r = decide(bash("npm test"), cfg, {}, 0, undefined, { allow: ["Bash(npm test:*)"], deny: [] }, "/x/run.js");
  assert.deepEqual(r, { action: "rewrite", command: "node '/x/run.js' 'npm test'", autoAllow: true });
  const without = decide(bash("cargo build"), cfg, {}, 0, undefined, { allow: [], deny: [] });
  assert.equal(without.action === "rewrite" && without.autoAllow, false); // Claude Code will ask
  assert.equal((decide(bash("git status"), cfg, {}, 0) as { autoAllow: boolean }).autoAllow, true); // read-only
  assert.equal(decide(bash("npm test"), cfg, {}, 0, undefined, { allow: [], deny: ["Bash(npm test:*)"] }).action, "pass");
  for (const c of ["npm test | tail", "ls && echo ok", "rm -rf x", "npm run dev", "vitest --watch", "echo 'a'"]) {
    assert.equal(decide(bash(c), cfg, {}, 0).action, "pass", c);
  }
  const rj = (c: string) => (decide(bash(c), cfg, {}, 0, undefined, { allow: [], deny: [] }, "/x/run.js") as { command?: string }).command;
  assert.equal(rj("npm test 2>&1 | tail -20"), "node '/x/run.js' 'npm test' | tail -20");
  assert.equal(rj("cd server && npm test 2>&1 | head -n 40"), "cd server && node '/x/run.js' 'npm test' | head -n 40");
  assert.equal(rj("npm test 2>&1"), "node '/x/run.js' 'npm test'");
  for (const c of ["cd $(pwd) && npm test", "npm test | grep x | tail -5", "npm test &", "for f in a; do npm test; done",
    "(npm test)", "npm test <<EOF\nx\nEOF", "echo `date`; npm test", "npm test\nls"]) {
    assert.equal(decide(bash(c), cfg, {}, 0).action, "pass", c);
  }
  for (const c of [".venv/bin/python -m pytest -q", "uv run pytest", "python3.12 -m ruff check src", "node_modules/.bin/jest", "venv/bin/pip install x"]) {
    assert.equal(decide(bash(c), cfg, {}, 0).action, "rewrite", c);
  }
  // Compound commands: each noisy part rewritten, others verbatim, operators kept.
  assert.equal(rj("cd a && npm test && ls"), "cd a && node '/x/run.js' 'npm test' && ls");
  assert.equal(rj("find . -name __pycache__ -prune -exec rm -rf {} + ; pytest -q 2>&1 | tail -5"),
    "find . -name __pycache__ -prune -exec rm -rf {} + ; node '/x/run.js' 'pytest -q' | tail -5");
  assert.equal(rj("npm test -- -t 'a && b'; git status"), "npm test -- -t 'a && b' ; node '/x/run.js' 'git status'"); // quoted && : split right, part kept (conservative)
  const both = (allow: string[], deny: string[] = []) => decide(bash("npm test && rm -rf x"), cfg, {}, 0, undefined, { allow, deny });
  assert.equal((both(["Bash(npm test:*)"]) as { autoAllow: boolean }).autoAllow, false); // rm not allowed → Claude Code asks
  assert.equal((both(["Bash(npm test:*)", "Bash(rm:*)"]) as { autoAllow: boolean }).autoAllow, true);
  assert.equal(both(["Bash(npm test:*)"], ["Bash(rm:*)"]).action, "pass"); // a denied part → untouched
  assert.equal(ruleMatches("Bash(git diff *)", "git diff --stat"), true);
  assert.equal(ruleMatches("Bash(git diff:*)", "git difftool"), false);
});

test("compact: test success summarised, errors kept, progress and repeats reduced", () => {
  const ok = Array.from({ length: 40 }, (_, i) => `  ✓ test ${i}`).join("\n") + "\nTests: 40 passed, 40 total\nTime: 1.2 s";
  const c = compact("npm test", ok, 0);
  assert.match(c, /tests passed — 40 passing lines hidden/);
  assert.match(c, /Tests: 40 passed/);
  assert.ok(!c.includes("✓ test 3"));
  const ko = Array.from({ length: 400 }, (_, i) => (i === 200 ? "Error: boom at x.ts:3" : `log ${i}`)).join("\n");
  const k = compact("npm run build", ko, 1);
  assert.match(k, /Error: boom/);
  assert.match(k, /lines omitted by token-eco/);
  assert.equal(compact("git status", "a\r50%\r100%\nb\nb\nb\n  (use \"git add <file>...\" to update)\n", 0), "100%\nb  (×3)");
});

test("read: short file whole, long → outline; search without pattern = file list", async () => {
  await writeFile(join(dir, "long.py"), Array.from({ length: 50 }, (_, i) => `def f${i}():\n    return ${i}\n`).join(""));
  const short = await read({ file: "b.py" }, dir, 300);
  assert.match(short.text, /^\[1-9\/9\]/);
  const long = await read({ file: "long.py" }, dir, 30);
  assert.match(long.text, /outline only/);
  assert.match(long.text, /def f49/);
  const list = await searchCompact({ filter: "*.py" }, dir);
  assert.match(list.text, /file\(s\) \(exact count\)\n/);
  assert.match(list.text, /long\.py/);
});

test("batch edit: all or nothing", async () => {
  await writeFile(join(dir, "e.txt"), "one\ntwo\nthree\ntwo\n");
  await assert.rejects(
    batchEdit({ edits: [{ file: "e.txt", oldText: "one", newText: "1" }, { file: "e.txt", oldText: "two", newText: "2" }] }, dir),
    /2 occurrences \(l\.2, 4\)/,
  );
  assert.equal(await readFile(join(dir, "e.txt"), "utf8"), "one\ntwo\nthree\ntwo\n");

  const r = await batchEdit({ edits: [
    { file: "e.txt", oldText: "one", newText: "1\n1b" },
    { file: "e.txt", oldText: "two", newText: "2", all: true },
  ] }, dir);
  assert.equal(await readFile(join(dir, "e.txt"), "utf8"), "1\n1b\n2\nthree\n2\n");
  assert.match(r.text, /^OK: 3 replacement\(s\) in 1 file\(s\)\n {2}e\.txt: l\.1 \(\+1 l\.\); l\.3,5/);
  assert.ok(r.nativeChars > 0);
});

test("db: recording and aggregates", () => {
  const yesterday = new Date(Date.now() - 86_400_000);
  record({ project: "/p/one", tool: "outline", returnedTokens: 100, nativeTokens: 1000 });
  record({ project: "/p/two", tool: "lire_plage", returnedTokens: 50, nativeTokens: 550, details: { file: "x.ts" } });
  record({ project: "/p/one", tool: "outline", returnedTokens: 10, nativeTokens: 110 }, yesterday);
  assert.deepEqual({ ...aggregate("day") }, { calls: 2, returned: 150, native: 1550, saved: 1400 });
  assert.equal(aggregate("week").saved, 1500);
  assert.equal(byKey("tool")[0].key, "outline");
  assert.equal(byDay(30).length, 2);
  assert.equal(recent(1)[0].tool, "outline");
  const s = statistics();
  // Sonnet 5.5: 5-min cache write $2.50 + 10 later turns × cache read $0.10 = $3.50 per MTok saved.
  assert.ok(Math.abs(s.total.dollars - (1500 / 1e6) * 3.5) < 1e-12);
  assert.match(summaryText(), /ESTIMATED[\s\S]*Total\s+1\.5K tokens/);
  const p = statistics({ project: "/p/one", days: 7 });
  assert.equal(p.range.saved, 1000);
  assert.equal(p.stack.by, "tool");
  assert.equal(p.projects[0].key, "/p/two"); // most recent activity first (same second: insertion order)
  assert.equal(formatTokens(4_560_000), "4.56M");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(1234.5), "$1,234.50");
});

test("db: pre-0.4 French schema migrated in place", () => {
  const f = join(dir, "old.db");
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE appels (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, projet TEXT NOT NULL, outil TEXT NOT NULL,
      tokens_renvoyes INTEGER NOT NULL, tokens_natif_estimes INTEGER NOT NULL, duree_ms INTEGER, details TEXT);
    CREATE TABLE redirections (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, session TEXT, outil TEXT NOT NULL, cible TEXT, issue TEXT NOT NULL);
    INSERT INTO appels VALUES (1, '2026-01-01T00:00:00Z', '/p', 'apercu', 10, 100, 5, '{"fichier":"a.ts","mode":"lignes"}');
    INSERT INTO redirections VALUES (1, '2026-01-01T00:00:00Z', 's', 'Read', 'a.ts', 'refus');`);
  old.close();
  closeDb();
  const d = openDb(f);
  assert.deepEqual({ ...d.prepare("SELECT project, tool, returned_tokens, details FROM calls").get() },
    { project: "/p", tool: "read", returned_tokens: 10, details: '{"file":"a.ts","mode":"lines"}' });
  assert.equal((d.prepare("SELECT outcome FROM redirections").get() as { outcome: string }).outcome, "refused");
  closeDb();
});

test("web: API, page and foreign Host rejected", async () => {
  const fixed = 47123;
  const srv2 = await startServer(fixed);
  try {
    const s = await (await fetch(`http://127.0.0.1:${fixed}/api/stats`)).json();
    assert.equal(s.total.calls, 3);
    const page = await fetch(`http://localhost:${fixed}/`);
    assert.match(await page.text(), /estimates/);
    const status = await new Promise<number>((ok, ko) =>
      get({ host: "127.0.0.1", port: fixed, path: "/api/stats", headers: { Host: "evil.com" } }, (r) => { r.resume(); ok(r.statusCode!); })
        .on("error", ko));
    assert.equal(status, 403);
  } finally { srv2.close(); }
});

test("SessionStart hook: injects the batching guidance as additionalContext", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "token-eco-home-"));
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "../src/hook.ts")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s" }),
    env: { ...process.env, TOKEN_ECO_HOME: home }, encoding: "utf8",
  });
  const o = JSON.parse(out).hookSpecificOutput;
  assert.equal(o.hookEventName, "SessionStart");
  assert.match(o.additionalContext, /queries[\s\S]*expand: true[\s\S]*targets/);
  assert.ok(o.additionalContext.length < 1200, "guidance must stay short");
  await rm(home, { recursive: true, force: true });
});

test("edit not found: closest passage (indentation, distinctive line, shared words, nothing)", async () => {
  const { closestPassage } = await import("../src/tools/batchEdit.ts");
  const text = "def f(x):\n    if x:\n        return compute_total(x, 3)\n    return None\n\n# other\n";
  assert.match(closestPassage(text, "if x:\n    return compute_total(x, 3)"), /different indentation[\s\S]*  2\|    if x:\n  3\|        return compute_total/);
  assert.match(closestPassage(text, "        return compute_total(x, 3)\n    return Nothing"), /line 3 matches[\s\S]*  2\|    if x:\n  3\|        return compute_total/);
  assert.match(closestPassage(text, "return compute_total(y, 4)"), /of the words[\s\S]*  3\|        return compute_total\(x, 3\)/);
  assert.match(closestPassage(text, "zzz qqq"), /nothing similar: read the file first/);
  const dir = await mkdtemp(join(tmpdir(), "token-eco-edit-"));
  await writeFile(join(dir, "a.py"), text);
  await assert.rejects(batchEdit({ edits: [
    { file: "a.py", oldText: "# other", newText: "# ok" },
    { file: "a.py", oldText: "if x:\n    return compute_total(x, 3)", newText: "" },
  ] }, dir), /the 1 other edit\(s\) were valid[\s\S]*different indentation/);
  assert.equal(await readFile(join(dir, "a.py"), "utf8"), text); // all or nothing
  await rm(dir, { recursive: true, force: true });
});

test("sessions: real usage from Claude Code logs (dedup by message id, subagents, eco vs not)", async () => {
  const { listSessions, compareSessions, encodeProject } = await import("../src/sessions.ts");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "token-eco-logs-"));
  const proj = "/tmp/some-project", dir = join(root, encodeProject(proj));
  await mkdir(join(dir, "s1", "subagents"), { recursive: true });
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 }, output_tokens: 50 };
  const msg = (id: string, content: unknown[], ts: string) => JSON.stringify({ type: "assistant", cwd: proj, timestamp: ts,
    message: { id, model: "claude-sonnet-5-5", usage, content } });
  await writeFile(join(dir, "s1.jsonl"), [
    msg("m1", [{ type: "tool_use", id: "t1", name: "mcp__plugin_token-eco_token-eco__read", input: {} }], "2026-01-01T10:00:00Z"),
    msg("m1", [{ type: "text", text: "same message, second line" }], "2026-01-01T10:00:01Z"),
    msg("m2", [], "2026-01-01T10:01:00Z"),
  ].join("\n"));
  await writeFile(join(dir, "s1", "subagents", "a.jsonl"), msg("m3", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }], "2026-01-01T10:00:30Z"));
  await writeFile(join(dir, "s2.jsonl"), msg("m4", [{ type: "tool_use", id: "t3", name: "Read", input: {} }], "2026-01-02T10:00:00Z"));
  const list = listSessions({ project: proj }, root);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "s2"); // most recent first
  const s1 = list[1];
  assert.equal(s1.turns, 2); assert.equal(s1.subagentTurns, 1); assert.equal(s1.ecoCalls, 1);
  assert.equal(s1.tokens, 3 * 1160);
  assert.ok(Math.abs(s1.cost - 3 * (10 * 2 + 100 * 4 + 1000 * 0.1 + 50 * 10) / 1e6) < 1e-9);
  const c = compareSessions(list);
  assert.equal(c.withEco.sessions, 1); assert.equal(c.withoutEco.sessions, 1);
  assert.equal(c.withEco.tokensPerTurn, Math.round(3 * 1160 / 3)); // 2 main + 1 subagent turn
  assert.ok(Math.abs(s1.costSub - s1.cost / 3) < 1e-9); // 1 of 3 identical turns in a subagent
  const k = s1.costKind;
  assert.ok(Math.abs(k.input + k.write + k.read + k.output - s1.cost) < 1e-9);

  // Insights: coverage per thread, Bash compacted + avoided from the calls in the session window, bench filter.
  const { sessionRow, compare, isBench, median } = await import("../src/insights.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const calls = () => [{ tool: "bash", calls: 1, returned: 0, native: 0, saved: 0 }, { tool: "read", calls: 1, returned: 100, native: 1100, saved: 1000 }];
  const r1 = sessionRow(s1, DEFAULT_CONFIG, calls);
  assert.deepEqual([r1.main, r1.sub, r1.bash], [{ eco: 1, native: 0 }, { eco: 0, native: 0 }, { total: 1, compacted: 1 }]);
  assert.equal(r1.model, "claude-sonnet-5.5");
  assert.ok(r1.avoidedUsd > 0);
  const r2 = sessionRow(list[0], DEFAULT_CONFIG, () => []);
  assert.deepEqual(r2.main, { eco: 0, native: 1 });
  assert.match(compare([r1, r2]).verdict, /Not enough comparable sessions \(1 with \/ 1 without/);
  assert.ok(isBench(proj, DEFAULT_CONFIG));
  assert.ok(!isBench("/Users/me/dev/app", DEFAULT_CONFIG));
  assert.equal(median([3, 1, 2, 10]), 2.5);
  assert.equal(s1.levers.startMain, 1110); assert.deepEqual(s1.levers.startSubs, [1110]);
  assert.equal(s1.levers.subByModel["claude-sonnet-5.5"].read, 1000);
  const { levers } = await import("../src/insights.ts");
  const lv = levers([s1], { CLAUDE_CODE_SUBAGENT_MODEL: "x" });
  assert.equal(lv.subagents.setting, "x"); assert.equal(lv.rebuilds.setting, null);
  assert.equal(lv.subagents.saving, 0); // already the cheaper model
  await rm(root, { recursive: true, force: true });
});

test("nodeBinary: falls back to PATH node when the recorded binary vanished (Homebrew upgrade)", async () => {
  const { nodeBinary } = await import("../src/config.ts");
  assert.equal(nodeBinary(process.execPath), process.execPath);
  assert.equal(nodeBinary("/opt/homebrew/Cellar/node/0.0.0/bin/node"), "node");
});
