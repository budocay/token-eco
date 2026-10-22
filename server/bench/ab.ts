/**
 * REAL A/B benchmark: same tasks in Claude Code (claude -p), with and without token-eco.
 * Spends real tokens. Each trial runs on a throwaway copy of zod/src in /tmp,
 * Bash forbidden, budget capped per trial.
 *
 * Usage : node bench/ab.ts [--model sonnet] [--trials 2] [--budget 0.5] [--tasks t1,t2]
 * Output: bench/AB.md (+ raw JSON in bench/ab-raw.json)
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "../..");
const SOURCE = join(HERE, "../node_modules/zod/src/v3");
const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODEL = arg("model", "sonnet"), TRIALS = Number(arg("trials", "2")), BUDGET = arg("budget", "0.5");

interface Task {
  id: string; prompt: string; /** true = success; false or a string (= the reason) = failure. */
  verify: (answer: string, folder: string) => boolean | string;
  /** Copies the corpus into the work folder (default: zod/src/v3). */
  prepare?: (folder: string) => void;
  bash?: boolean;   // Bash allowed (else forbidden)
  budget?: string;  // $ cap per run (default --budget)
}
const SERVER = join(HERE, "..");
/** Copy of a real small project with its tests (server/ without node_modules, dist, bench). */
const copyServer = (d: string) => { for (const x of ["src", "test", "public", "package.json"]) cpSync(join(SERVER, x), join(d, x), { recursive: true }); };
const TASKS: Task[] = [
  {
    id: "t1-comprendre",
    prompt: "In types.ts, what does the safeParseAsync method of the ZodType class do? Answer in 3 sentences at most, naming the methods it calls.",
    verify: (r) => /_parseAsync|_parse/.test(r),
  },
  {
    id: "t2-search",
    prompt: "In which files and at which lines is the ZodDiscriminatedUnion class defined and used? Answer with a short file:line list.",
    verify: (r) => /types\.ts/.test(r),
  },
  {
    id: "t3-editer",
    prompt: "In types.ts, add a `// token-eco-bench` comment on the line right above the declaration of the ZodNaN class, and the same above the ZodSymbol class. Change nothing else.",
    verify: (_r, d) => {
      const t = readFileSync(join(d, "types.ts"), "utf8");
      return /\/\/ token-eco-bench\s*\n\s*export class ZodNaN/.test(t) && /\/\/ token-eco-bench\s*\n\s*export class ZodSymbol/.test(t);
    },
  },
  {
    // Longer “session” task: exploring several symbols, then an edit.
    id: "t4-session",
    prompt: "Explain in 5 sentences at most how ZodObject handles unknown keys (strip, strict, passthrough, catchall modes), naming the methods involved and their lines, then add a `// token-eco-bench` comment on the line right above the strict method of ZodObject. Change nothing else.",
    verify: (r, d) => /strict/.test(r) && /passthrough/.test(r)
      && /\/\/ token-eco-bench\s*\n\s*strict\(/.test(readFileSync(join(d, "types.ts"), "utf8")),
  },
  {
    // Realistic long session: read, search, edit, RUN THE TESTS (Bash), fix.
    id: "t5-feature",
    prepare: copyServer,
    bash: true,
    budget: "1.5",
    prompt: "This project is a Node/TypeScript server. Add to the searchCompact function (src/tools/searchCompact.ts) "
      + "a boolean option `inverse` in SearchArgs: when true, a line is kept if it does NOT match "
      + "the pattern (like grep -v). Add a test in test/tools.test.ts that checks this behaviour, run the tests with "
      + "`npm test` and fix until they all pass. End with a one-sentence summary.",
    verify: (_r, d) => {
      const src = readFileSync(join(d, "src/tools/searchCompact.ts"), "utf8");
      const tests = readFileSync(join(d, "test/tools.test.ts"), "utf8");
      if (!/inverse/.test(src)) return "no `inverse` in searchCompact.ts";
      if (!/inverse/.test(tests)) return "no `inverse` test in tools.test.ts";
      const run = spawnSync("node", ["--test", "--test-timeout=20000", "test/"], { cwd: d, encoding: "utf8", timeout: 120_000 });
      if (run.status === 0) return true;
      const failing = `${run.stdout}\n${run.stderr}`.split("\n").filter((l) => /^✖|Error|expected|actual/.test(l.trim())).slice(0, 6);
      return `tests fail (exit ${run.status ?? run.signal}): ${failing.join(" | ").slice(0, 400)}`;
    },
  },
];
const choice = arg("tasks", "");
const tasks = choice ? TASKS.filter((t) => choice.split(",").some((c) => t.id.startsWith(c))) : TASKS;


interface Trial { task: string; mode: string; ok: boolean; cost: number; turns: number; input: number; cacheRead: number; cacheCreated: number; output: number; tools: string; bashEco?: number; error?: string; why?: string;
  calls?: string[]; perTurn?: { created: number; read: number; input: number; output: number }[] }
const trials: Trial[] = [];
const HOME_NATIVE = mkdtempSync(join(tmpdir(), "te-ab-native-"));
writeFileSync(join(HOME_NATIVE, "config.json"), JSON.stringify({ hook: { mode: "off" } }));
/** A “native” trial that still used token-eco is invalid (plugin/hook active). */
const contaminated = (e: Trial) => e.mode === "native" && /eco:/.test(e.tools);

// Uncounted warmup: fills the cache of each mode's prefix (system prompt + tools). Without it,
// the first eco trial alone paid for a cold cache (+16k tokens created) while native was already warm.
if (!process.argv.includes("--no-warmup")) {
  // The tool list is part of the prefix: one warmup per variant (Bash forbidden or not) actually used.
  for (const bash of new Set(tasks.map((t) => !!t.bash))) for (const mode of ["native", "eco"] as const) {
    const d = mkdtempSync(join(tmpdir(), "te-ab-warmup-"));
    const disallowed = [...(bash ? [] : ["Bash"]), ...(mode === "native" ? ["mcp__plugin_token-eco_token-eco"] : [])];
    const a = ["-p", "Reply OK.", "--model", MODEL, "--output-format", "json", "--max-budget-usd", "0.2", "--dangerously-skip-permissions",
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []), ...(mode === "eco" ? ["--plugin-dir", PLUGIN, "--agent", "token-eco:eco"] : [])];
    process.stdout.write(`warmup ${mode}${bash ? " +bash" : ""}… `);
    const w = spawnSync("claude", a, { cwd: d, encoding: "utf8", timeout: 120_000, env: { ...process.env, TOKEN_ECO_HOME: HOME_NATIVE } });
    rmSync(d, { recursive: true, force: true });
    let res: any = null;
    try { res = JSON.parse(w.stdout); } catch { /* not JSON: reported below */ }
    if (!res || res.is_error || res.subtype !== "success") {
      console.error(`FAILED\nClaude Code is not usable right now: ${res ? `${res.subtype}: ${res.result}` : (w.stderr || w.stdout || w.error?.message || "no output").slice(0, 400)}`);
      process.exit(1);
    }
    console.log("ok");
  }
}

let infraErrors = 0;
outer: for (const t of tasks) {
  for (let n = 0; n < TRIALS; n++) {
    for (const mode of ["native", "eco"] as const) {
      const folder = mkdtempSync(join(tmpdir(), "te-ab-"));
      if (t.prepare) t.prepare(folder); else cpSync(SOURCE, folder, { recursive: true });
      // SEALED native even if the plugin is installed on the account: token-eco tools disallowed
      // and hook disabled (dedicated data folder with hook.mode = "off").
      const disallowed = [...(t.bash ? [] : ["Bash"]), ...(mode === "native" ? ["mcp__plugin_token-eco_token-eco"] : [])];
      const args = ["-p", t.prompt, "--model", MODEL, "--output-format", "json", "--max-budget-usd", t.budget ?? BUDGET,
        "--dangerously-skip-permissions", ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []), "--verbose"];
      const homeEco = mkdtempSync(join(tmpdir(), "te-ab-eco-")); // Bash measurements of THIS trial
      // Eco = real conditions: plugin loaded, main agent eco (built-in tools removed), hook active.
      if (mode === "eco") args.push("--plugin-dir", PLUGIN, "--agent", "token-eco:eco");
      process.stdout.write(`${t.id} #${n + 1} ${mode}… `);
      const r = spawnSync("claude", args, { cwd: folder, encoding: "utf8", maxBuffer: 1 << 28, timeout: 600_000,
        env: { ...process.env, TOKEN_ECO_HOME: mode === "native" ? HOME_NATIVE : homeEco } });
      // Bash output tokens saved by compaction during this trial (real measurement from run.js).
      let bashEco = 0;
      try {
        const db = new DatabaseSync(join(homeEco, "eco.db"));
        bashEco = Number((db.prepare("SELECT COALESCE(SUM(native_tokens_est - returned_tokens), 0) AS s FROM calls WHERE tool = 'bash'").get() as { s: number }).s);
        db.close();
      } catch { /* no database: no command compacted */ }
      rmSync(homeEco, { recursive: true, force: true });
      try {
        // --verbose + json: array of messages; the last element is the result.
        const raw = JSON.parse(r.stdout);
        const messages = Array.isArray(raw) ? raw : [raw];
        const end = messages[messages.length - 1];
        const tools = messages.flatMap((m: any) => m.type === "assistant" ? (m.message?.content ?? []) : [])
          .filter((c: any) => c.type === "tool_use").map((c: any) => String(c.name).replace(/^mcp__plugin_token-eco_token-eco__/, "eco:").replace(/^mcp__.*__/, "mcp:"));
        // Call details (shortened inputs): `command` for Bash, else truncated JSON.
        const calls = messages.flatMap((m: any) => m.type === "assistant" ? (m.message?.content ?? []) : [])
          .filter((c: any) => c.type === "tool_use").map((c: any) => {
            const i = c.input ?? {};
            const txt = typeof i.command === "string" ? i.command : JSON.stringify(i);
            return `${String(c.name).replace(/^mcp__plugin_token-eco_token-eco__/, "eco:")} ${txt.length > 300 ? txt.slice(0, 300) + "…" : txt}`;
          });
        // Usage per assistant message (deduplicated by id): to spot cache-creation spikes.
        const seenIds = new Set<string>();
        const perTurn = messages.filter((m: any) => m.type === "assistant" && m.message?.usage).filter((m: any) => {
          const id = m.message.id ?? Math.random().toString(); if (seenIds.has(id)) return false; seenIds.add(id); return true;
        }).map((m: any) => { const v = m.message.usage; return { created: v.cache_creation_input_tokens ?? 0, read: v.cache_read_input_tokens ?? 0, input: v.input_tokens ?? 0, output: v.output_tokens ?? 0 }; });
        const u = end.usage ?? {};
        const base = { task: t.id, mode, cost: end.total_cost_usd ?? 0, turns: end.num_turns ?? 0, input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, cacheCreated: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0, tools: tools.join(" "), bashEco, calls, perTurn };
        // Claude Code itself failed (usage limit, auth, budget, API error…): not a task failure, excluded from the stats.
        if (end.is_error || end.subtype !== "success") {
          trials.push({ ...base, ok: false, error: `${end.subtype ?? "error"}: ${String(end.result ?? r.stderr ?? "").slice(0, 300)}` });
        } else {
          const verdict = t.verify(String(end.result ?? ""), folder);
          trials.push({ ...base, ok: verdict === true,
            ...(verdict === true ? {} : { why: verdict || "answer or files did not pass the check" }) });
        }
      } catch (e) {
        trials.push({ task: t.id, mode, ok: false, cost: 0, turns: 0, input: 0, cacheRead: 0, cacheCreated: 0, output: 0, tools: "",
          error: (r.stderr || r.stdout || String(e)).slice(0, 300) });
      }
      const last = trials[trials.length - 1];
      console.log(last.error ? `ERROR (excluded) ${last.error}`
        : `${last.ok ? "OK" : `FAILED (${last.why})`} ${last.cost.toFixed(4)} $ [${last.tools}]`);
      rmSync(folder, { recursive: true, force: true });
      infraErrors = last.error ? infraErrors + 1 : 0;
      if (infraErrors >= 2) {
        console.error(`\nStopping: ${infraErrors} Claude Code errors in a row (last: ${last.error}).`
          + "\nFix the cause (usage limit, login, budget…) and run again; partial results are written below.");
        break outer;
      }
    }
  }
}

// ---------- Report ----------
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const lines = tasks.map((t) => {
  const [na, ec] = (["native", "eco"] as const).map((m) => trials.filter((e) => e.task === t.id && e.mode === m && !e.error && !contaminated(e)));
  const c = (xs: Trial[]) => avg(xs.map((e) => e.cost));
  const ctx = (xs: Trial[]) => avg(xs.map((e) => e.input + e.cacheRead + e.cacheCreated));
  const ok = (xs: Trial[]) => `${xs.filter((e) => e.ok).length}/${xs.length}`;
  const delta = c(na) ? `${(((c(ec) - c(na)) / c(na)) * 100).toFixed(0)} %` : "–";
  return `| ${t.id} | ${c(na).toFixed(4)} $ | ${c(ec).toFixed(4)} $ | **${delta}** | ${Math.round(ctx(na))} | ${Math.round(ctx(ec))} | ` +
    `${avg(na.map((e) => e.turns)).toFixed(1)} / ${avg(ec.map((e) => e.turns)).toFixed(1)} | ${ok(na)} / ${ok(ec)} | ` +
    `${Math.round(avg(ec.map((e) => e.bashEco ?? 0)))} |`;
});
const valid = (m: string) => trials.filter((e) => e.mode === m && !e.error && !contaminated(e));
const totalNative = tasks.reduce((s, t) => s + avg(valid("native").filter((e) => e.task === t.id).map((e) => e.cost)), 0);
const totalE = tasks.reduce((s, t) => s + avg(valid("eco").filter((e) => e.task === t.id).map((e) => e.cost)), 0);
lines.push(`| **Total** | ${totalNative.toFixed(4)} $ | ${totalE.toFixed(4)} $ | **${totalNative ? (((totalE - totalNative) / totalNative) * 100).toFixed(0) : "–"} %** | | | | | |`);
const suffix = choice ? `-${choice.replace(/[^\w]+/g, "_")}` : "";
const report = `# Real A/B benchmark (headless Claude Code)

Model: ${MODEL} · ${TRIALS} trial(s) per task and per mode · corpus: zod/src/v3 (t1-t4), server/ with its tests (t5) · ${new Date().toISOString().slice(0, 10)}
“eco” mode = plugin loaded (--plugin-dir) + main agent token-eco:eco + hook (compacted Bash). Costs = Claude Code total_cost_usd (real).

| Task | Native cost | Eco cost | Delta | Native context (tok.) | Eco context (tok.) | Turns native / eco | Success native / eco | Bash output saved (tok.) |
|---|---|---|---|---|---|---|---|---|
${lines.join("\n")}

“native” mode is sealed: token-eco tools disallowed, hook disabled${trials.some(contaminated) ? ` — ⚠️ ${trials.filter(contaminated).length} contaminated native trial(s) excluded` : ""}.
Fixed cost per run (system prompt + tools cached) ≈ ${Math.round(avg(trials.filter((e) => !e.error).map((e) => e.cacheCreated)))} tokens created in cache: it weighs a lot on short tasks.
“Context” = cumulative input tokens (cache included). Tools called per trial: see ab-raw.json.
Few trials = high variance: do not over-read a gap of a few %.
`;
writeFileSync(join(HERE, `AB${suffix}.md`), report);
writeFileSync(join(HERE, `ab-raw${suffix}.json`), JSON.stringify(trials, null, 2));
console.log("\n" + report);
