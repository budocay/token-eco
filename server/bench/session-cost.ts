/**
 * Real cost of Claude Code sessions, from the session logs (~/.claude/projects/<encoded cwd>/*.jsonl,
 * subagents in <session>/subagents/*.jsonl). Usage:
 *   node bench/session-cost.ts <project dir | session.jsonl> [more…] [--model claude-sonnet-5.5] [--latest] [--cold]
 * --latest: only the most recent session of each project (skips warmup sessions);
 * --cold: count the first turn's cache read as a cache write (same cold start for every session).
 * Every argument after the first is compared with the first one (delta %).
 * Assumptions: an assistant message logged on several lines is counted once (by message.id);
 * 1-hour cache writes cost 2 × input, 5-minute writes use cacheWrite5m (Anthropic pricing rules).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PRICES, type ModelPrice } from "../src/pricing.ts";

interface Totals {
  sessions: number; turns: number; subagentTurns: number; input: number; write5m: number; write1h: number;
  cacheRead: number; output: number; cost: number; peakContext: number; tools: Record<string, number>;
  models: Set<string>; unpriced: Set<string>;
}

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const forcedModel = flag("--model");
const bool = (name: string) => (args.includes(name) ? (args.splice(args.indexOf(name), 1), true) : false);
const latest = bool("--latest");
const cold = bool("--cold");
if (!args.length) { console.error("usage: node bench/session-cost.ts <project dir | session.jsonl> [more…] [--model m] [--latest]"); process.exit(1); }

function priceFor(model: string): ModelPrice | undefined {
  if (forcedModel) return PRICES[forcedModel];
  const key = model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return PRICES[key];
}

/** Main session files (+ their subagent files) for a project dir or a single jsonl. */
function sessionFiles(arg: string): { main: string[]; sub: string[] } {
  let mains: string[];
  if (arg.endsWith(".jsonl")) mains = [resolve(arg)];
  else {
    const dir = join(homedir(), ".claude", "projects", resolve(arg).replace(/[^a-zA-Z0-9]/g, "-"));
    if (!existsSync(dir)) { console.error(`no session log for ${arg} (expected ${dir})`); process.exit(1); }
    mains = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (latest) mains = mains.slice(0, 1);
  }
  const sub = mains.flatMap((m) => {
    const d = join(m.replace(/\.jsonl$/, ""), "subagents");
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => join(d, f)) : [];
  });
  return { main: mains, sub };
}

function add(t: Totals, file: string, isSub: boolean): void {
  const seenMsg = new Set<string>(), seenTool = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== "assistant" || !m) continue;
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "tool_use" && !seenTool.has(c.id)) {
        seenTool.add(c.id);
        const name = String(c.name).replace(/^mcp__plugin_token-eco_token-eco__/, "eco:");
        const key = (isSub ? "sub:" : "") + name;
        t.tools[key] = (t.tools[key] ?? 0) + 1;
      }
    }
    const u = m.usage;
    if (!u || !m.id || seenMsg.has(m.id) || m.model === "<synthetic>") continue;
    seenMsg.add(m.id);
    let w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
    const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0;
    let read = u.cache_read_input_tokens ?? 0;
    // --cold: the first turn of a session pays its whole prefix as a 1h cache write (removes warm-cache bias).
    if (cold && !isSub && seenMsg.size === 1) { w1h += read; read = 0; }
    t.input += inp; t.write5m += w5m; t.write1h += w1h; t.cacheRead += read; t.output += out;
    if (isSub) t.subagentTurns++; else { t.turns++; t.peakContext = Math.max(t.peakContext, inp + w5m + w1h + read); }
    t.models.add(m.model);
    const p = priceFor(m.model);
    if (!p) { t.unpriced.add(m.model); continue; }
    t.cost += (inp * p.input + w5m * p.cacheWrite5m + w1h * 2 * p.input + read * p.cacheRead + out * p.output) / 1e6;
  }
}

function totals(arg: string): Totals {
  const t: Totals = { sessions: 0, turns: 0, subagentTurns: 0, input: 0, write5m: 0, write1h: 0, cacheRead: 0,
    output: 0, cost: 0, peakContext: 0, tools: {}, models: new Set(), unpriced: new Set() };
  const { main, sub } = sessionFiles(arg);
  t.sessions = main.length;
  for (const f of main) add(t, f, false);
  for (const f of sub) add(t, f, true);
  return t;
}

const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));
const pct = (a: number, b: number) => (a ? `${b >= a ? "+" : "−"}${Math.abs(Math.round(((b - a) / a) * 100))}%` : "–");

const results = args.map((a) => ({ name: basename(resolve(a)).replace(/\.jsonl$/, ""), t: totals(a) }));
const rows: [string, (t: Totals) => number, (n: number) => string][] = [
  ["Cost (USD)", (t) => t.cost, (n) => "$" + n.toFixed(2)],
  ["Main turns", (t) => t.turns, String],
  ["Subagent turns", (t) => t.subagentTurns, String],
  ["Peak context", (t) => t.peakContext, k],
  ["Input (uncached)", (t) => t.input, k],
  ["Cache write 5m", (t) => t.write5m, k],
  ["Cache write 1h", (t) => t.write1h, k],
  ["Cache read", (t) => t.cacheRead, k],
  ["Output", (t) => t.output, k],
];
// Every column after the first is followed by its delta vs the first one (the baseline).
const head = ["", ...results.flatMap((r, i) => (i ? [r.name, `Δ ${r.name}`] : [r.name]))];
console.log(`| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|`);
for (const [label, get, fmt] of rows) {
  const vals = results.map((r) => get(r.t));
  console.log(`| ${[label, ...vals.flatMap((v, i) => (i ? [fmt(v), pct(vals[0], v)] : [fmt(v)]))].join(" | ")} |`);
}
for (const r of results) {
  const tools = Object.entries(r.t.tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ");
  console.log(`\n${r.name}: ${r.t.sessions} session(s), models ${[...r.t.models].join(", ") || "–"}\n  tools: ${tools || "–"}`);
  if (r.t.unpriced.size) console.log(`  WARNING no price for ${[...r.t.unpriced].join(", ")} (use --model)`);
}
