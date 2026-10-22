/**
 * Real cost of Claude Code sessions, from their logs (parsing in src/sessions.ts). Usage:
 *   node bench/session-cost.ts <project dir | session.jsonl> [more…] [--model claude-sonnet-5.5] [--latest] [--cold]
 * --latest: only the most recent session of each project (skips warmup sessions);
 * --cold: count the first turn's cache read as a cache write (same cold start for every session).
 * Every argument after the first is compared with the first one (delta %).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { addLog, emptyTotals, encodeProject, projectsDir, subagentLogs, type SessionTotals } from "../src/sessions.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (name: string) => (args.includes(name) ? (args.splice(args.indexOf(name), 1), true) : false);
const model = flag("--model");
const latest = bool("--latest");
const cold = bool("--cold");
if (!args.length) { console.error("usage: node bench/session-cost.ts <project dir | session.jsonl> [more…] [--model m] [--latest] [--cold]"); process.exit(1); }

function mainLogs(arg: string): string[] {
  if (arg.endsWith(".jsonl")) return [resolve(arg)];
  const dir = join(projectsDir(), encodeProject(arg));
  if (!existsSync(dir)) { console.error(`no session log for ${arg} (expected ${dir})`); process.exit(1); }
  const logs = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return latest ? logs.slice(0, 1) : logs;
}

const results = args.map((a) => {
  const t = emptyTotals();
  const logs = mainLogs(a);
  for (const f of logs) { addLog(t, f, false, { cold, model }); for (const s of subagentLogs(f)) addLog(t, s, true, { cold, model }); }
  return { name: basename(resolve(a)).replace(/\.jsonl$/, ""), sessions: logs.length, t };
});

const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));
const pct = (a: number, b: number) => (a ? `${b >= a ? "+" : "−"}${Math.abs(Math.round(((b - a) / a) * 100))}%` : "–");
const rows: [string, (t: SessionTotals) => number, (n: number) => string][] = [
  ["Cost (USD)", (t) => t.cost, (n) => "$" + n.toFixed(2)],
  ["Tokens (all)", (t) => t.tokens, k],
  ["Main turns", (t) => t.turns, String],
  ["Subagent turns", (t) => t.subagentTurns, String],
  ["Peak context", (t) => t.peakContext, k],
  ["Input (uncached)", (t) => t.input, k],
  ["Cache write 5m", (t) => t.write5m, k],
  ["Cache write 1h", (t) => t.write1h, k],
  ["Cache read", (t) => t.cacheRead, k],
  ["Output", (t) => t.output, k],
];
const head = ["", ...results.flatMap((r, i) => (i ? [r.name, `Δ ${r.name}`] : [r.name]))];
console.log(`| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|`);
for (const [label, get, fmt] of rows) {
  const vals = results.map((r) => get(r.t));
  console.log(`| ${[label, ...vals.flatMap((v, i) => (i ? [fmt(v), pct(vals[0], v)] : [fmt(v)]))].join(" | ")} |`);
}
for (const r of results) {
  const tools = Object.entries(r.t.tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ");
  console.log(`\n${r.name}: ${r.sessions} session(s), model ${r.t.model || "–"}\n  tools: ${tools || "–"}`);
  if (r.t.unpriced.length) console.log(`  WARNING no price for ${r.t.unpriced.join(", ")} (use --model)`);
}
