/**
 * What the real sessions say (Claude Code logs + token-eco calls), for the dashboard and /eco-stats:
 * - coverage: share of file reads/searches/edits done with token-eco instead of the built-in tools,
 *   main thread and subagents apart, and share of Bash calls whose output was compacted;
 * - where the money goes: main thread vs subagents, token kinds, most used tools;
 * - with vs without token-eco, only within the same project AND model, on medians per turn;
 * - per session: avoided tokens priced with the session's own model, as a share of its bill.
 */
import { readConfig, saveAutoModel, type Config } from "./config.ts";
import { callsInWindow } from "./db.ts";
import { PRICES, savedTokenRate } from "./pricing.ts";
import { listSessions, modelKey, type SessionTotals } from "./sessions.ts";

const ECO_FILE = ["eco:read", "eco:search", "eco:edit"];
const NATIVE_FILE = ["Read", "Grep", "Glob", "Edit", "MultiEdit"];

export interface Filters { project?: string; model?: string; days?: number; includeBench?: boolean }

export interface Coverage { eco: number; native: number }
export interface SessionRow {
  id: string; project: string; name: string; model: string; start: string; end: string;
  turns: number; subagentTurns: number; cost: number; costSub: number; costPerTurn: number; tokensPerTurn: number;
  peakContext: number; main: Coverage; sub: Coverage; bash: { total: number; compacted: number };
  avoidedTokens: number; avoidedUsd: number;
}

export const isBench = (project: string, cfg: Config) => cfg.excludeProjects.some((p) => p && project.includes(p));
const shortName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const pct = (c: Coverage) => (c.eco + c.native ? c.eco / (c.eco + c.native) : null);

export function median(a: number[]): number {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/** One session with its coverage and its token-eco calls (matched by project + time window). */
export function sessionRow(s: SessionTotals, cfg: Config, calls = callsInWindow): SessionRow {
  const count = (prefix: string, names: string[]) => names.reduce((a, k) => a + (s.tools[prefix + k] ?? 0), 0);
  const eco = calls(s.project, s.start, s.end);
  const key = modelKey(s.model);
  const rate = savedTokenRate(PRICES[key] ? key : "", cfg.laterTurns);
  const saved = eco.reduce((a, c) => a + c.saved, 0);
  const allTurns = s.turns + s.subagentTurns;
  return {
    id: s.id, project: s.project, name: shortName(s.project), model: key, start: s.start, end: s.end,
    turns: s.turns, subagentTurns: s.subagentTurns, cost: s.cost, costSub: s.costSub,
    costPerTurn: allTurns ? s.cost / allTurns : 0, tokensPerTurn: allTurns ? Math.round(s.tokens / allTurns) : 0,
    peakContext: s.peakContext,
    main: { eco: count("", ECO_FILE), native: count("", NATIVE_FILE) },
    sub: { eco: count("sub:", ECO_FILE), native: count("sub:", NATIVE_FILE) },
    bash: { total: (s.tools.Bash ?? 0) + (s.tools["sub:Bash"] ?? 0), compacted: eco.find((c) => c.tool === "bash")?.calls ?? 0 },
    avoidedTokens: saved, avoidedUsd: (saved / 1e6) * rate,
  };
}

const usesEco = (r: SessionRow) => r.main.eco + r.sub.eco + r.bash.compacted > 0;

/** With vs without token-eco, only inside (project, model) groups that have both; medians per turn. */
export function compare(rows: SessionRow[]) {
  const groups = new Map<string, { project: string; model: string; with: SessionRow[]; without: SessionRow[] }>();
  for (const r of rows) {
    const k = `${r.project}|${r.model}`;
    if (!groups.has(k)) groups.set(k, { project: r.name, model: r.model, with: [], without: [] });
    groups.get(k)![usesEco(r) ? "with" : "without"].push(r);
  }
  const stat = (l: SessionRow[]) => ({
    sessions: l.length, costPerTurn: median(l.map((r) => r.costPerTurn)), tokensPerTurn: median(l.map((r) => r.tokensPerTurn)),
    peakContext: median(l.map((r) => r.peakContext)), costPerSession: median(l.map((r) => r.cost)),
  });
  const matched = [...groups.values()].filter((g) => g.with.length && g.without.length);
  const w = matched.flatMap((g) => g.with), o = matched.flatMap((g) => g.without);
  const all = { with: stat(w), without: stat(o) };
  const delta = all.without.costPerTurn ? all.with.costPerTurn / all.without.costPerTurn - 1 : null;
  const verdict = w.length < 3 || o.length < 3
    ? `Not enough comparable sessions (${w.length} with / ${o.length} without, same project and model; 3 of each needed).`
    : `Cost per turn ${delta! <= 0 ? "−" : "+"}${Math.abs(Math.round(delta! * 100))}% with token-eco (median, ${w.length} vs ${o.length} sessions). Tasks still differ: a trend, not a proof.`;
  return { verdict, delta, all, groups: matched.map((g) => ({ project: g.project, model: g.model, with: stat(g.with), without: stat(g.without) })) };
}

/** Where the money goes over a set of sessions. */
export function breakdown(list: SessionTotals[]) {
  const sum = (f: (s: SessionTotals) => number) => list.reduce((a, s) => a + f(s), 0);
  const tools: Record<string, number> = {};
  for (const s of list) for (const [k, n] of Object.entries(s.tools)) tools[k] = (tools[k] ?? 0) + n;
  return {
    cost: sum((s) => s.cost), costSub: sum((s) => s.costSub),
    kinds: { input: sum((s) => s.costKind.input), write: sum((s) => s.costKind.write), read: sum((s) => s.costKind.read), output: sum((s) => s.costKind.output) },
    turns: sum((s) => s.turns), subagentTurns: sum((s) => s.subagentTurns),
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tool, calls]) => ({ tool, calls })),
  };
}

/** Model that carried most of the real cost (priced models only). */
export function dominantModel(list: SessionTotals[]): string | undefined {
  const by: Record<string, number> = {};
  for (const s of list) { const k = modelKey(s.model); if (PRICES[k]) by[k] = (by[k] ?? 0) + s.cost; }
  return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Everything the "Real sessions" part of the dashboard shows. */
export function insights(f: Filters = {}) {
  const cfg = readConfig();
  const days = f.days && f.days > 0 ? Math.min(f.days, 365) : 30;
  const scanned = listSessions({ project: f.project, days }).filter((s) => s.turns >= 2);
  const real = scanned.filter((s) => f.includeBench || !isBench(s.project, cfg));
  const auto = dominantModel(real);
  if (auto) try { saveAutoModel(auto); } catch { /* read-only data dir */ }
  const list = f.model ? real.filter((s) => modelKey(s.model) === f.model) : real;
  const rows = list.map((s) => sessionRow(s, cfg));
  const total = (pick: (r: SessionRow) => Coverage): Coverage =>
    rows.reduce((a, r) => ({ eco: a.eco + pick(r).eco, native: a.native + pick(r).native }), { eco: 0, native: 0 });
  const main = total((r) => r.main), sub = total((r) => r.sub);
  const bash = rows.reduce((a, r) => ({ total: a.total + r.bash.total, compacted: a.compacted + r.bash.compacted }), { total: 0, compacted: 0 });
  const avoidedUsd = rows.reduce((a, r) => a + r.avoidedUsd, 0), cost = rows.reduce((a, r) => a + r.cost, 0);
  return {
    filters: { project: f.project ?? "", model: f.model ?? "", days, includeBench: !!f.includeBench },
    excluded: scanned.length - real.length, excludePatterns: cfg.excludeProjects, autoModel: auto ?? null,
    projects: [...new Set(real.map((s) => s.project))].map((p) => ({ path: p, name: shortName(p) })),
    models: [...new Set(real.map((s) => modelKey(s.model)))],
    coverage: { main, sub, bash, mainPct: pct(main), subPct: pct(sub), bashPct: bash.total ? bash.compacted / bash.total : null },
    avoided: { tokens: rows.reduce((a, r) => a + r.avoidedTokens, 0), usd: avoidedUsd, shareOfCost: cost ? avoidedUsd / cost : 0 },
    breakdown: breakdown(list),
    compare: compare(rows),
    sessions: rows.slice(0, 40),
  };
}
