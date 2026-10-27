/**
 * ADOPTION benchmark: does a multi-agent session (orchestrator + subagents, like real projects) actually use the
 * token-eco tools, and what does it change? Spends real tokens (except --dry).
 *
 * Fixture (fresh copy in /tmp per trial): server/ with its tests, two long Markdown specs (> 300 lines, read whole
 * by agents in real logs), CLAUDE.md "you orchestrate, you delegate", and two project agents: `reviewer`
 * (read-only, `tools:` list) and `producer` (no list).
 * Variants: native (token-eco sealed off) · eco-before (plugin + eco agent + hook, reviewer = Read/Grep/Glob)
 *           · eco-after (same, reviewer also gets token-eco read/search).
 * Measures, from the Claude Code logs of each trial (subagents included): cost, turns, success, coverage
 * (token-eco vs built-in file tools, main / subagents), file reads through Bash, hook redirects, main agent.
 *
 * Usage: node bench/adoption.ts [--dry | --report-only] [--models sonnet,opus] [--trials 3] [--tasks t6,t7]
 *          [--variants native,eco-before,eco-after] [--budget 4] [--max-total 100]
 * Output: bench/ADOPTION.md + bench/adoption-raw.json
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProject, projectsDir, sessionTotals } from "../src/sessions.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "../..");
const SERVER = join(HERE, "..");
const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const DRY = process.argv.includes("--dry");
const MODELS = arg("models", "sonnet,opus").split(",");
const TRIALS = Number(arg("trials", "3")), BUDGET = arg("budget", "4"), MAX_TOTAL = Number(arg("max-total", "100"));
const ECO_TOOLS = "mcp__plugin_token-eco_token-eco__read, mcp__plugin_token-eco_token-eco__search";

interface Variant { id: string; plugin: boolean; reviewerEco: boolean }
const VARIANTS: Variant[] = [
  { id: "native", plugin: false, reviewerEco: false },
  { id: "eco-before", plugin: true, reviewerEco: false },
  { id: "eco-after", plugin: true, reviewerEco: true },
].filter((v) => { const w = arg("variants", "").split(",").filter(Boolean); return !w.length || w.includes(v.id); });

// ---------- Long specs (generated: plausible requirements, the ones that matter buried in the middle) ----------
const FILLER = ["Inputs are validated before any file is touched; an invalid input returns an error message, never throws.",
  "Paths are resolved against the project root; a path outside it is refused with a clear message.",
  "Output is plain text, one item per line, with 1-based line numbers where lines are shown.",
  "Errors of one item of a batch never cancel the other items; each error is reported next to its item.",
  "Every call records its returned size and the estimated size of the equivalent built-in call.",
  "Large outputs are cut at a documented cap and say how many items were left out.",
  "Behaviour is identical on macOS and Linux; Windows paths are accepted but not tested.",
  "No network access; no child process except the ones listed in the security section."];
function spec(title: string, prefix: string, key: Record<number, [string, string]>, n = 30): string {
  const out = [`# ${title}`, "", "Status: approved · Owner: platform team · Every requirement is normative (MUST).", ""];
  for (let i = 1; i <= n; i++) {
    const id = `${prefix}-${String(i).padStart(2, "0")}`;
    const [name, body] = key[i] ?? [`General rule ${i}`, FILLER[i % FILLER.length]];
    out.push(`## ${id} — ${name}`, "", body, "", "Rationale:", "", `- keeps ${title.toLowerCase()} predictable for agents;`,
      "- measured on real sessions before being written down;", "- any change needs a new version of this document.", "",
      "Acceptance:", "", `- covered by the test suite (see test/), case ${id};`, "- reviewed by the platform team.", "");
  }
  return out.join("\n");
}
const SPEC_TOOLS = spec("Token-eco tools", "TOOL", {
  12: ["Default range of read", "When `read` gets a `start` without an `end`, it returns at most **200 lines** (constant `DEFAULT_MAX_LINES` in src/tools/readRange.ts)."],
  17: ["Expanded search hits", "With `expand: true`, each enclosing function/class is shown up to **150 lines** (constant `EXPAND_MAX_LINES` in src/tools/searchCompact.ts)."],
  23: ["Batched reads cap", "A `read` with several `targets` stops at **40,000 characters** in total, about 10K tokens (constant `MULTI_CAP` in src/tools/read.ts)."],
});
const SPEC_DISPLAY = spec("Display rules", "DISP", {
  14: ["Billions of tokens", "`formatTokens` (src/stats.ts) MUST show amounts of one billion and more with a `B` suffix, at most 2 decimals and no trailing zeros, exactly like the `M` case: 2500000000 → `2.5B`, 1234567890 → `1.23B`, -3000000000 → `-3B`. Below one billion nothing changes (999000000 → `999M`)."],
});

// ---------- Fixture ----------
function fixture(folder: string, v: Variant): void {
  for (const x of ["src", "test", "public", "package.json"]) cpSync(join(SERVER, x), join(folder, x), { recursive: true });
  mkdirSync(join(folder, "docs"));
  writeFileSync(join(folder, "docs/SPEC-tools.md"), SPEC_TOOLS);
  writeFileSync(join(folder, "docs/SPEC-display.md"), SPEC_DISPLAY);
  writeFileSync(join(folder, "CLAUDE.md"), [
    "# Project rules", "",
    "You are the ORCHESTRATOR. You never read, search or edit project files yourself: you delegate.",
    "- Reviews and questions about the code → the `reviewer` agent (read-only).",
    "- Any code change → the `producer` agent; it also runs the tests (`node --test test/`).",
    "Give each agent a precise brief, then report its result to the user. Specs are in docs/.", ""].join("\n"));
  mkdirSync(join(folder, ".claude/agents"), { recursive: true });
  writeFileSync(join(folder, ".claude/agents/reviewer.md"), ["---", "name: reviewer",
    "description: Read-only reviewer. Checks code against the specs in docs/ and reports every discrepancy with file, constant and values.",
    `tools: Read, Grep, Glob${v.reviewerEco ? `, ${ECO_TOOLS}` : ""}`, "---", "",
    "You review; you never change files. For each discrepancy: file, symbol, value in the code, value required by the spec, requirement id.", ""].join("\n"));
  writeFileSync(join(folder, ".claude/agents/producer.md"), ["---", "name: producer",
    "description: Implements changes requested by the orchestrator, following the specs in docs/, and runs the tests.", "---", "",
    "Implement exactly what the brief and the spec ask, add or update tests, run `node --test test/` and report.", ""].join("\n"));
}

// ---------- Tasks ----------
interface Task { id: string; prompt: string; prepare: (folder: string) => void; verify: (answer: string, folder: string) => { ok: boolean; detail: string } }
const mutate = (folder: string, file: string, from: string, to: string) => {
  const p = join(folder, file), s = readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`fixture: "${from}" not found in ${file}`);
  writeFileSync(p, s.replace(from, to));
};
const TASKS: Task[] = [
  {
    id: "t6-review",
    prompt: "Have the code of src/tools reviewed against docs/SPEC-tools.md and give me the list of discrepancies (file, constant, code value, spec value).",
    prepare: (f) => {
      mutate(f, "src/tools/readRange.ts", "DEFAULT_MAX_LINES = 200", "DEFAULT_MAX_LINES = 250");
      mutate(f, "src/tools/searchCompact.ts", "EXPAND_MAX_LINES = 150", "EXPAND_MAX_LINES = 120");
      mutate(f, "src/tools/read.ts", "MULTI_CAP = 40_000", "MULTI_CAP = 60_000");
    },
    verify: (a) => {
      const found = [/DEFAULT_MAX_LINES[\s\S]{0,200}250|250[\s\S]{0,200}DEFAULT_MAX_LINES/, /EXPAND_MAX_LINES[\s\S]{0,200}120|120[\s\S]{0,200}EXPAND_MAX_LINES/,
        /MULTI_CAP[\s\S]{0,200}60[ ,._]?000|60[ ,._]?000[\s\S]{0,200}MULTI_CAP/].filter((r) => r.test(a)).length;
      return { ok: found === 3, detail: `${found}/3 discrepancies` };
    },
  },
  {
    id: "t7-feature",
    prompt: "Implement requirement DISP-14 of docs/SPEC-display.md, with tests. Tell me when the test suite passes.",
    prepare: () => {},
    verify: (_a, f) => {
      const hidden = join(f, "test/zz-hidden-disp14.test.ts");
      writeFileSync(hidden, [`import { test } from "node:test"; import assert from "node:assert/strict";`,
        `import { formatTokens } from "../src/stats.ts";`,
        `test("DISP-14 hidden", () => { assert.equal(formatTokens(2_500_000_000), "2.5B"); assert.equal(formatTokens(1_234_567_890), "1.23B");`,
        `  assert.equal(formatTokens(-3_000_000_000), "-3B"); assert.equal(formatTokens(999_000_000), "999M"); assert.equal(formatTokens(12_300), "12.3K"); });`].join("\n"));
      const r = spawnSync("node", ["--test", "test/"], { cwd: f, encoding: "utf8", timeout: 180_000, env: { ...process.env, TOKEN_ECO_HOME: mkdtempSync(join(tmpdir(), "te-ad-verify-")) } });
      const fail = /(?:#|ℹ) fail (\d+)/.exec(r.stdout)?.[1] ?? "?";
      return { ok: r.status === 0, detail: r.status === 0 ? "suite + hidden test pass" : `${fail} failing test(s)` };
    },
  },
];
const tasks = arg("tasks", "") ? TASKS.filter((t) => arg("tasks", "").split(",").some((c) => t.id.startsWith(c))) : TASKS;

// ---------- Measures from the trial's Claude Code logs ----------
interface Trial {
  model: string; task: string; variant: string; ok: boolean; detail: string; cost: number; turnsMain: number; turnsSub: number;
  agent: string; subModels: string; mainEco: number; mainNative: number; subEco: number; subNative: number;
  bashReads: number; bashReadKb: number; refused: number; fallback: number; error?: string;
}
const ECO_FILE = ["eco:read", "eco:search", "eco:edit"], NATIVE_FILE = ["Read", "Grep", "Glob", "Edit", "MultiEdit"];
const READ_BASH = /^(?:cd\s+\S+\s*&&\s*)?(cat|head|tail|sed\s+-n|grep|rg|find|awk|ls\s+-R)\b/;

function findLog(id: string, folder: string): string | null {
  const root = projectsDir(), guess = join(root, encodeProject(realpathSync(folder)), `${id}.jsonl`);
  if (existsSync(guess)) return guess;
  for (const d of readdirSync(root)) { const p = join(root, d, `${id}.jsonl`); if (existsSync(p)) return p; }
  return null;
}
/** File reads done through Bash (cat/sed -n/grep…), main thread + subagents: calls and KB returned. */
function bashReads(mainLog: string): { calls: number; kb: number } {
  const sub = join(mainLog.replace(/\.jsonl$/, ""), "subagents");
  const files = [mainLog, ...(existsSync(sub) ? readdirSync(sub).filter((x) => x.endsWith(".jsonl")).map((x) => join(sub, x)) : [])];
  let calls = 0, chars = 0;
  for (const f of files) {
    const reads = new Set<string>(), size: Record<string, number> = {};
    for (const line of readFileSync(f, "utf8").split("\n")) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      for (const c of Array.isArray(o?.message?.content) ? o.message.content : []) {
        if (c.type === "tool_use" && c.name === "Bash" && READ_BASH.test(String(c.input?.command ?? "").trim())) reads.add(c.id);
        if (c.type === "tool_result") size[c.tool_use_id] = JSON.stringify(c.content ?? "").length;
      }
    }
    for (const id of reads) { calls++; chars += size[id] ?? 0; }
  }
  return { calls, kb: Math.round(chars / 1024) };
}
function hookStats(home: string): { refused: number; fallback: number } {
  try {
    const db = new DatabaseSync(join(home, "eco.db"));
    const r = db.prepare("SELECT COALESCE(SUM(outcome = 'refused'), 0) AS refused, COALESCE(SUM(outcome = 'fallback'), 0) AS fallback FROM redirections").get() as { refused: number; fallback: number };
    db.close();
    return { refused: Number(r.refused), fallback: Number(r.fallback) };
  } catch { return { refused: 0, fallback: 0 }; }
}

// ---------- --dry: fixture and hook checks, no API call ----------
if (DRY) {
  const { decide } = await import("../src/hook.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "[OK]" : "[KO]"} ${what}`); if (!cond) process.exitCode = 1; };
  const v = spawnSync("claude", ["--version"], { encoding: "utf8" });
  ok(v.status === 0, `claude available: ${(v.stdout || v.stderr || "").trim()}`);
  for (const variant of VARIANTS) {
    const f = mkdtempSync(join(tmpdir(), "te-ad-dry-")); fixture(f, variant);
    ok(readFileSync(join(f, ".claude/agents/reviewer.md"), "utf8").includes(ECO_TOOLS) === variant.reviewerEco, `${variant.id}: reviewer tools ${variant.reviewerEco ? "with" : "without"} token-eco`);
    rmSync(f, { recursive: true, force: true });
  }
  const f = mkdtempSync(join(tmpdir(), "te-ad-dry-")); fixture(f, VARIANTS[VARIANTS.length - 1]);
  for (const s of ["SPEC-tools.md", "SPEC-display.md"]) ok(readFileSync(join(f, "docs", s), "utf8").split("\n").length > 300, `docs/${s}: ${readFileSync(join(f, "docs", s), "utf8").split("\n").length} lines (> 300: hook threshold)`);
  const cfg = { ...DEFAULT_CONFIG, hook: { mode: "redirect" as const, lineThreshold: 300 } };
  const bash = (command: string) => ({ session_id: "dry", cwd: f, tool_name: "Bash", tool_input: { command } });
  for (const [c, want] of [["cat docs/SPEC-tools.md", "refused"], ["cat -n docs/SPEC-display.md", "refused"],
    ["cd docs && cat SPEC-tools.md && cat SPEC-display.md", "refused"], ["sed -n '1,40p' docs/SPEC-tools.md", "pass"], ["cat package.json", "pass"]] as const) {
    ok(decide(bash(c), cfg, {}, 0).action === want, `hook: \`${c}\` → ${want}`);
  }
  const base = spawnSync("node", ["--test", "test/"], { cwd: f, encoding: "utf8", timeout: 180_000, env: { ...process.env, TOKEN_ECO_HOME: mkdtempSync(join(tmpdir(), "te-ad-dry-home-")) } });
  ok(base.status === 0, `fixture test suite passes as is (${/(?:#|ℹ) pass (\d+)/.exec(base.stdout)?.[1] ?? "?"} tests)`);
  ok(!TASKS[1].verify("", f).ok, "t7 check fails before the feature is implemented");
  const t6 = mkdtempSync(join(tmpdir(), "te-ad-dry-")); fixture(t6, VARIANTS[0]); TASKS[0].prepare(t6);
  ok(TASKS[0].verify("DEFAULT_MAX_LINES is 250 (spec 200); EXPAND_MAX_LINES 120 vs 150; MULTI_CAP 60_000 vs 40,000", t6).ok && !TASKS[0].verify("all good", t6).ok, "t6: mutations applied, check recognises a full answer and rejects an empty one");
  for (const d of [f, t6]) rmSync(d, { recursive: true, force: true });
  console.log(`\nPlan: ${MODELS.join("+")} × ${tasks.length} task(s) × ${VARIANTS.length} variant(s) × ${TRIALS} trial(s) = ${MODELS.length * tasks.length * VARIANTS.length * TRIALS} runs, ≤ $${BUDGET} each, stop at $${MAX_TOTAL} total.`);
  process.exit();
}

// ---------- Runs ----------
const HOME_NATIVE = mkdtempSync(join(tmpdir(), "te-ad-native-"));
writeFileSync(join(HOME_NATIVE, "config.json"), JSON.stringify({ hook: { mode: "off" } }));
// --report-only: rebuild ADOPTION.md from adoption-raw.json (e.g. after a run stopped early).
const REPORT_ONLY = process.argv.includes("--report-only");
const trials: Trial[] = REPORT_ONLY ? JSON.parse(readFileSync(join(HERE, "adoption-raw.json"), "utf8")) : [];
let spent = trials.reduce((a, x) => a + x.cost, 0), infra = 0;
outer: for (const model of REPORT_ONLY ? [] : MODELS) for (const t of tasks) for (let n = 0; n < TRIALS; n++) for (const v of VARIANTS) {
  const folder = mkdtempSync(join(tmpdir(), "te-ad-"));
  fixture(folder, v); t.prepare(folder);
  const home = v.plugin ? mkdtempSync(join(tmpdir(), "te-ad-eco-")) : HOME_NATIVE;
  // The copy installed on the account is always disabled (its "agent" setting would also apply to native runs, and
  // eco runs would load the plugin twice); eco runs load THIS checkout with --plugin-dir. Checked on 2026-10-27.
  const args = ["-p", t.prompt, "--model", model, "--output-format", "json", "--max-budget-usd", BUDGET, "--dangerously-skip-permissions",
    "--settings", JSON.stringify({ enabledPlugins: { "token-eco@token-eco-marketplace": false } }),
    ...(v.plugin ? ["--plugin-dir", PLUGIN, "--agent", "token-eco:eco"] : ["--disallowedTools", "mcp__plugin_token-eco_token-eco"])];
  process.stdout.write(`${model} ${t.id} #${n + 1} ${v.id}… `);
  const r = spawnSync("claude", args, { cwd: folder, encoding: "utf8", maxBuffer: 1 << 28, timeout: 1_800_000, env: { ...process.env, TOKEN_ECO_HOME: home } });
  const row: Trial = { model, task: t.id, variant: v.id, ok: false, detail: "", cost: 0, turnsMain: 0, turnsSub: 0, agent: "", subModels: "",
    mainEco: 0, mainNative: 0, subEco: 0, subNative: 0, bashReads: 0, bashReadKb: 0, refused: 0, fallback: 0 };
  try {
    const end = JSON.parse(r.stdout);
    row.cost = end.total_cost_usd ?? 0;
    if (end.is_error || end.subtype !== "success") row.error = `${end.subtype}: ${String(end.result ?? "").slice(0, 200)}`;
    else Object.assign(row, t.verify(String(end.result ?? ""), folder));
    const log = end.session_id ? findLog(end.session_id, folder) : null;
    if (log) {
      const s = sessionTotals(log), sum = (keys: string[], p: string) => keys.reduce((a, k) => a + (s.tools[p + k] ?? 0), 0);
      Object.assign(row, { turnsMain: s.turns, turnsSub: s.subagentTurns, agent: s.agent ?? "", subModels: Object.keys(s.levers.subByModel).join(","),
        mainEco: sum(ECO_FILE, ""), mainNative: sum(NATIVE_FILE, ""), subEco: sum(ECO_FILE, "sub:"), subNative: sum(NATIVE_FILE, "sub:") });
      const b = bashReads(log); row.bashReads = b.calls; row.bashReadKb = b.kb;
    } else row.detail += " (log not found)";
    Object.assign(row, hookStats(home));
    // Guard: a plugin variant must really run as token-eco:eco; a native one must not use token-eco at all.
    if (!row.error && v.plugin && row.agent !== "token-eco:eco") row.error = `main agent was "${row.agent || "none"}"`;
    if (!row.error && !v.plugin && (row.mainEco + row.subEco > 0 || row.agent)) row.error = `native trial not sealed (agent "${row.agent}", ${row.mainEco + row.subEco} token-eco calls)`;
  } catch (e) { row.error = (r.stderr || r.stdout || String(e)).slice(0, 200); }
  trials.push(row);
  spent += row.cost;
  console.log(row.error ? `ERROR (excluded) ${row.error}` : `${row.ok ? "OK" : "FAILED"} ${row.detail} · $${row.cost.toFixed(3)} · cov sub ${row.subEco}/${row.subEco + row.subNative} · bash reads ${row.bashReads}`);
  if (v.plugin) rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
  writeFileSync(join(HERE, "adoption-raw.json"), JSON.stringify(trials, null, 1));
  infra = row.error && !/main agent|not sealed/.test(row.error) ? infra + 1 : 0;
  if (infra >= 2) { console.error("\nStopping: 2 Claude Code errors in a row (usage limit, login…). Partial report below."); break outer; }
  if (spent >= MAX_TOTAL) { console.error(`\nStopping: $${spent.toFixed(2)} spent (--max-total ${MAX_TOTAL}). Partial report below.`); break outer; }
}

// ---------- Report ----------
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const share = (e: number, n: number) => (e + n ? `${Math.round((e / (e + n)) * 100)}%` : "–");
const lines: string[] = [];
for (const model of MODELS) for (const t of tasks) {
  const base = avg(trials.filter((x) => x.model === model && x.task === t.id && x.variant === "native" && !x.error).map((x) => x.cost));
  for (const v of VARIANTS) {
    const xs = trials.filter((x) => x.model === model && x.task === t.id && x.variant === v.id && !x.error);
    if (!xs.length) continue;
    const c = avg(xs.map((x) => x.cost)), sum = (k: keyof Trial) => xs.reduce((a, x) => a + (x[k] as number), 0);
    lines.push(`| ${model} | ${t.id} | ${v.id} | ${xs.filter((x) => x.ok).length}/${xs.length} | $${c.toFixed(3)} | ${base && v.id !== "native" ? `**${Math.round(((c - base) / base) * 100)}%**` : "–"} | `
      + `${avg(xs.map((x) => x.turnsMain)).toFixed(1)} / ${avg(xs.map((x) => x.turnsSub)).toFixed(1)} | ${share(sum("mainEco"), sum("mainNative"))} | ${share(sum("subEco"), sum("subNative"))} | `
      + `${avg(xs.map((x) => x.bashReads)).toFixed(1)} (${Math.round(avg(xs.map((x) => x.bashReadKb)))} KB) | ${avg(xs.map((x) => x.refused)).toFixed(1)} | ${[...new Set(xs.map((x) => x.subModels))].join(" ")} |`);
  }
}
const excluded = trials.filter((x) => x.error);
writeFileSync(join(HERE, "ADOPTION.md"), [
  "# Adoption benchmark (multi-agent, headless Claude Code)", "",
  `${new Date().toISOString().slice(0, 10)} · ${TRIALS} trial(s) per cell · total spent $${spent.toFixed(2)} · fixture: server/ + 2 specs > 300 lines + orchestrator CLAUDE.md + reviewer/producer agents.`,
  "native = token-eco sealed off (tools disallowed, hook off) · eco-before = plugin + token-eco:eco + hook, reviewer `tools: Read, Grep, Glob` · eco-after = same, reviewer also gets token-eco read/search.", "",
  "| Model | Task | Variant | Success | Cost | vs native | Turns main / sub | Coverage main | Coverage sub | Bash file reads (avg) | Hook redirects | Subagent model |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|", ...lines, "",
  "Coverage = token-eco read/search/edit ÷ (those + built-in Read/Grep/Glob/Edit/MultiEdit), from the session logs. Cost = total_cost_usd (subagents included).",
  "The subagent model follows your settings (CLAUDE_CODE_SUBAGENT_MODEL): with Opus as main model the subagents may run on Sonnet, as in real use.",
  excluded.length ? `Excluded runs (${excluded.length}): ${excluded.map((x) => `${x.model}/${x.task}/${x.variant}: ${x.error}`).join(" · ")}` : "No run excluded.",
  "Few trials = high variance: a gap of a few % is noise.", ""].join("\n"));
console.log(`\nReport: bench/ADOPTION.md (raw: bench/adoption-raw.json) · spent $${spent.toFixed(2)}`);
