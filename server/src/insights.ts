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
import { modelTier, PRICES, savedTokenRate } from "./pricing.ts";
import { shortName } from "./project.ts";
import { listSessions, modelKey, type AgentUse, type RawTokens, type SessionTotals } from "./sessions.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ECO_FILE = ["eco:read", "eco:search", "eco:edit"];
const NATIVE_FILE = ["Read", "Grep", "Glob", "Edit", "MultiEdit"];

export interface Filters { project?: string; model?: string; days?: number; includeBench?: boolean }

export interface Coverage { eco: number; native: number }
export interface SessionRow {
  id: string; project: string; name: string; agent: string; model: string; start: string; end: string;
  turns: number; subagentTurns: number; cost: number; costSub: number; costPerTurn: number; tokensPerTurn: number;
  peakContext: number; main: Coverage; sub: Coverage; bash: { total: number; compacted: number };
  avoidedTokens: number; avoidedUsd: number;
}

export const isBench = (project: string, cfg: Config) => cfg.excludeProjects.some((p) => p && project.includes(p));
const pct = (c: Coverage) => (c.eco + c.native ? c.eco / (c.eco + c.native) : null);

export function median(a: number[]): number {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/** Start of each session's call window: calls carry no session id, so sessions of one project that overlap in
 *  time get disjoint windows (the earlier one keeps the overlap) and every call is counted once. */
export function callWindows(list: Pick<SessionTotals, "id" | "project" | "start" | "end">[]): Map<string, string> {
  const from = new Map<string, string>(), taken = new Map<string, string>();
  for (const s of [...list].sort((a, b) => a.start.localeCompare(b.start))) {
    const end = taken.get(s.project) ?? "";
    from.set(s.id, end > s.start ? end : s.start);
    if (s.end > end) taken.set(s.project, s.end);
  }
  return from;
}

/** One session with its coverage and its token-eco calls (matched by project + time window from..end). */
export function sessionRow(s: SessionTotals, cfg: Config, calls = callsInWindow, from = s.start): SessionRow {
  const count = (prefix: string, names: string[]) => names.reduce((a, k) => a + (s.tools[prefix + k] ?? 0), 0);
  const eco = from > s.end ? [] : calls(s.project, from, s.end);
  const key = modelKey(s.model);
  const rate = savedTokenRate(PRICES[key] ? key : "", cfg.laterTurns);
  const saved = eco.reduce((a, c) => a + c.saved, 0);
  const allTurns = s.turns + s.subagentTurns;
  return {
    id: s.id, project: s.project, name: shortName(s.project), agent: s.agent ?? "", model: key, start: s.start, end: s.end,
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

/** Claude Code settings that drive the levers: process env, then ~/.claude/settings.json "env". */
export function claudeEnv(home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): Record<string, string> {
  let env: Record<string, string> = {};
  try { env = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).env ?? {}; } catch { /* no settings */ }
  const keys = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
    "CLAUDE_CODE_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H"];
  return Object.fromEntries(keys.map((k) => [k, process.env[k] ?? env[k]]).filter(([, v]) => v));
}

const CHEAP_SUB = "claude-sonnet-5.5";
const priceRaw = (r: RawTokens, key: string) => {
  const p = PRICES[key];
  return p ? (r.input * p.input + r.write5m * p.cacheWrite5m + r.write1h * 2 * p.input + r.read * p.cacheRead + r.output * p.output) / 1e6 : 0;
};

/** The big cost drivers measured in the logs, each with the Claude Code setting that acts on it. */
export function levers(list: SessionTotals[], env = claudeEnv()) {
  const sum = (f: (s: SessionTotals) => number) => list.reduce((a, s) => a + f(s), 0);
  const subModels: Record<string, { turnsCost: number; cheaper: number }> = {};
  for (const s of list) for (const [k, r] of Object.entries(s.levers.subByModel)) {
    const cost = r.cost ?? priceRaw(r, k), cheap = priceRaw(r, CHEAP_SUB);
    subModels[k] ??= { turnsCost: 0, cheaper: 0 };
    subModels[k].turnsCost += cost;
    subModels[k].cheaper += Math.max(0, cost - cheap);
  }
  const startSubs = list.flatMap((s) => s.levers.startSubs);
  return {
    env,
    compaction: { over200k: sum((s) => s.levers.over200k), over300k: sum((s) => s.levers.over300k),
      peakMedian: median(list.map((s) => s.peakContext)), setting: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null },
    rebuilds: { count: sum((s) => s.levers.rebuilds), cost: sum((s) => s.levers.rebuildCost),
      setting: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ?? env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? (env.ENABLE_PROMPT_CACHING_1H ? "1h" : null) },
    subagents: { byModel: Object.entries(subModels).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.turnsCost - a.turnsCost),
      cheaperModel: CHEAP_SUB, saving: Object.values(subModels).reduce((a, v) => a + v.cheaper, 0), setting: env.CLAUDE_CODE_SUBAGENT_MODEL ?? null },
    start: { main: median(list.map((s) => s.levers.startMain).filter(Boolean)), sub: median(startSubs), subagents: startSubs.length,
      // Every turn re-reads the starting context: what 10K fewer tokens would save (at each turn's cache-read price ≈ total).
      per10k: sum((s) => (s.turns + s.subagentTurns) * 10_000 * (PRICES[modelKey(s.model)]?.cacheRead ?? 0) / 1e6) },
  };
}

const JUDGMENT = /secur|review|architect|audit/i;
const ROLE_MODEL = { "read-only": "claude-haiku-5.5", work: "claude-sonnet-5.5", judgment: "claude-sonnet-5.5" } as const;

/** Per subagent type: what it really ran on, how often its launch forced a model, and the cheaper model its role
 *  suggests (no edit and no Bash → Haiku; the rest → Sonnet). Role-based only: answer quality is not measured. */
export function agentModels(list: SessionTotals[]) {
  const by: Record<string, AgentUse> = {};
  for (const s of list) for (const [k, a] of Object.entries(s.agents ?? {})) {
    const b = (by[k] ??= { launches: 0, turns: 0, cost: 0, edits: 0, bash: 0, byModel: {}, forced: {} });
    b.launches += a.launches; b.turns += a.turns; b.cost += a.cost; b.edits += a.edits; b.bash += a.bash;
    for (const [m, n] of Object.entries(a.forced)) b.forced[m] = (b.forced[m] ?? 0) + n;
    for (const [m, r] of Object.entries(a.byModel)) {
      const x = (b.byModel[m] ??= { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, cost: 0 });
      x.input += r.input; x.write5m += r.write5m; x.write1h += r.write1h; x.read += r.read; x.output += r.output;
      x.cost = (x.cost ?? 0) + (r.cost ?? 0);
    }
  }
  return Object.entries(by).filter(([, a]) => a.turns > 0).map(([agent, a]) => {
    const role = JUDGMENT.test(agent) ? "judgment" : a.edits === 0 && a.bash === 0 ? "read-only" : "work";
    const target = ROLE_MODEL[role];
    const saving = Object.entries(a.byModel).reduce((sum, [m, r]) =>
      sum + (modelTier(m) > modelTier(target) ? Math.max(0, (r.cost ?? 0) - priceRaw(r, target)) : 0), 0);
    return { agent, role, launches: a.launches, turns: a.turns, cost: a.cost, forced: a.forced,
      models: Object.entries(a.byModel).map(([model, r]) => ({ model, cost: r.cost ?? 0 })).sort((x, y) => y.cost - x.cost),
      suggested: saving >= 0.01 ? target : null, saving };
  }).sort((x, y) => y.cost - x.cost);
}

/** /eco-models: the table above as text. English only: it is read by the agent, which then talks to the user. */
export function modelsText(days = 30): string {
  const rows = insights({ days }).agentModels, usd = (x: number) => `$${x.toFixed(2)}`, short = (m: string) => m.replace("claude-", "");
  const cap = readConfig().subagents.maxExplicitModel || "off";
  return [
    `Subagents by type, last ${days} days, real sessions (${usd(rows.reduce((a, x) => a + x.cost, 0))}):`,
    "agent | role | launches | turns | cost | ran on | explicit model at launch | suggested | saving",
    ...rows.map((x) => [x.agent, x.role, x.launches, x.turns, usd(x.cost), x.models.map((m) => `${short(m.model)} ${usd(m.cost)}`).join(", "),
      Object.entries(x.forced).map(([m, n]) => `${m} x${n}`).join(", ") || "-", x.suggested ? short(x.suggested) : "-", x.suggested ? usd(x.saving) : "-"].join(" | ")),
    "",
    `Total if every suggestion is applied: ${usd(rows.reduce((a, x) => a + (x.suggested ? x.saving : 0), 0))} (the period's tokens re-priced; Haiku long-prompt tier not applied).`,
    "Roles: read-only = no edit and no Bash in the period (Haiku); judgment = security/review/architecture/audit by name (Sonnet suggested, keeping the current model is a valid choice); work = the rest (Sonnet).",
    "Suggestions come from the role only: answer quality is NOT measured.",
    `An explicit model in the launch call overrides the agent's own "model:" and CLAUDE_CODE_SUBAGENT_MODEL. Cap in ~/.token-eco/config.json: "subagents": { "maxExplicitModel": "sonnet" } drops any explicit model above it (now: ${cap}).`,
  ].join("\n");
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
  const from = callWindows(list);
  const rows = list.map((s) => sessionRow(s, cfg, callsInWindow, from.get(s.id)));
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
    levers: levers(list),
    agentModels: agentModels(list),
    compare: compare(rows),
    agents: agentShare(rows),
    diagnosis: diagnose(rows, installedPlugin()),
    sessions: rows.slice(0, 40),
  };
}

/** Plugins listed in ~/.claude/plugins/installed_plugins.json (keys "name@marketplace"); unreadable → assume installed. */
function installedPlugin(): (plugin: string) => boolean {
  try {
    const j = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
    const names = new Set(Object.keys(j.plugins ?? j).map((k) => k.split("@")[0]));
    return (p) => names.has(p);
  } catch { return () => true; }
}

/** Main-thread agent of the sessions ("" = none / plugin agent not applied). */
export function agentShare(rows: SessionRow[]): { agent: string; sessions: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.agent, (m.get(r.agent) ?? 0) + 1);
  return [...m].map(([agent, sessions]) => ({ agent, sessions })).sort((a, b) => b.sessions - a.sessions);
}

/** Why the coverage is low, as codes the dashboard / CLI turn into sentences (most recent sessions first). */
export type Diagnosis =
  | { code: "other-agent"; agent: string; sessions: number; latest: boolean; installed: boolean }
  | { code: "no-agent"; sessions: number }
  | { code: "sub-native"; native: number; eco: number };
/** installed(plugin): is that plugin still installed? An agent of a removed plugin is history, not a conflict. */
export function diagnose(rows: SessionRow[], installed: (plugin: string) => boolean = () => true): Diagnosis[] {
  const out: Diagnosis[] = [];
  const recent = rows.slice(0, 10);
  const others = new Map<string, number>();
  for (const r of recent) if (r.agent && !r.agent.startsWith("token-eco:")) others.set(r.agent, (others.get(r.agent) ?? 0) + 1);
  for (const [agent, sessions] of others) {
    out.push({ code: "other-agent", agent, sessions, latest: recent[0]?.agent === agent, installed: installed(agent.split(":")[0]) });
  }
  // Old sessions without agent are history: only worth a warning when the latest one has none.
  const none = recent.filter((r) => !r.agent).length;
  if (none && recent[0] && !recent[0].agent) out.push({ code: "no-agent", sessions: none });
  const sub = recent.reduce((a, r) => ({ eco: a.eco + r.sub.eco, native: a.native + r.sub.native }), { eco: 0, native: 0 });
  if (sub.native > 50 && sub.native > 4 * sub.eco) out.push({ code: "sub-native", ...sub });
  return out;
}
