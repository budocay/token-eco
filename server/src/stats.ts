import {
  aggregate, aggregateScope, byDay, byDayAndKey, byKey, projects, recent, redirectStats, type Aggregate, type Scope,
} from "./db.ts";
import { readConfig, toDollars, type Config } from "./config.ts";
import { PRICES, PRICES_CHECKED, PRICES_SOURCE, savedTokenRate } from "./pricing.ts";
import { CHARS_PER_TOKEN } from "./tokens.ts";
import { compareSessions, listSessions, type SessionGroup } from "./sessions.ts";

type WithDollars<T> = T & { dollars: number };

/** Compact token count, the usual notation of usage dashboards: 950 · 12.3K · 4.56M. */
export function formatTokens(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+(n / 1e6).toFixed(2)}M`;
}

/** Dollars: $1.23, <$0.01 for tiny non-zero amounts, $0.00 for zero. */
export function formatUsd(d: number): string {
  if (d > 0 && d < 0.01) return "<$0.01";
  return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface StatsQuery extends Scope { model?: string }

/** Everything the dashboard (web API) and the CLI need, optionally scoped to one project / N days. */
export function statistics(q: StatsQuery = {}) {
  const cfg: Config = readConfig();
  const model = q.model && PRICES[q.model] ? q.model : cfg.model;
  const $ = <T extends Aggregate>(a: T): WithDollars<T> => ({ ...a, dollars: toDollars(a.saved, cfg, model) });
  const scope: Scope = { project: q.project || undefined, days: q.days ?? null };
  return {
    estimate: `Estimates: 1 token ≈ ${CHARS_PER_TOKEN} characters; "native" = assumed size of the equivalent built-in tool's output.`,
    pricing: {
      model, label: PRICES[model].label, laterTurns: cfg.laterTurns, rate: savedTokenRate(model, cfg.laterTurns),
      checked: PRICES_CHECKED, source: PRICES_SOURCE,
      formula: `saved tokens × (5-min cache write + ${cfg.laterTurns} later turns × cache read) per MTok`,
      models: Object.entries(PRICES).map(([key, p]) => ({ key, ...p })),
    },
    scope,
    today: $(aggregate("day", scope.project)),
    week: $(aggregate("week", scope.project)),
    total: $(aggregate("total", scope.project)),
    range: $(aggregateScope(scope)),
    byDay: byDay(scope.days ?? 3650, scope.project).map($),
    stack: { by: scope.project ? "tool" : "project", rows: byDayAndKey(scope.project ? "tool" : "project", scope) },
    byTool: byKey("tool", scope).map($),
    byProject: byKey("project", scope).map($),
    projects: projects().map($),
    recent: recent(30, scope),
    redirections: { day: redirectStats("day"), week: redirectStats("week"), total: redirectStats("total") },
  };
}

const pct = (a: Aggregate) => (a.native ? Math.round((a.saved / a.native) * 100) : 0);

/** Plain-text summary for the terminal (/eco-stats). */
export function summaryText(): string {
  const s = statistics();
  const line = (name: string, a: WithDollars<Aggregate>) =>
    `${name.padEnd(9)} ${formatTokens(a.saved).padStart(8)} tokens  ${formatUsd(a.dollars).padStart(9)}  (−${pct(a)}%, ${a.calls} call${a.calls === 1 ? "" : "s"})`;
  let real: string[] = [];
  try {
    const { withEco: w, withoutEco: o } = compareSessions(listSessions({ days: 7 }));
    const g = (name: string, x: SessionGroup) => x.sessions
      ? `  ${name.padEnd(16)} ${String(x.sessions).padStart(3)} session(s)  ${formatTokens(x.tokensPerTurn).padStart(7)} tokens/turn  ${formatTokens(x.tokens / x.sessions).padStart(7)} tokens  ${formatUsd(x.costPerSession).padStart(7)} per session`
      : `  ${name.padEnd(16)}   – no session`;
    real = ["", "Real sessions, last 7 days (Claude Code logs, everything the model processed):",
      g("With token-eco", w), g("Without", o), "  (different tasks: compare over many sessions, or bench/session-cost.ts on the same task)"];
  } catch { /* logs unreadable: estimates only */ }
  return [
    "token-eco — ESTIMATED tokens avoided per call (vs the assumed built-in call; extra turns not counted)",
    line("Today", s.today),
    line("7 days", s.week),
    line("Total", s.total),
    "",
    "By tool:",
    ...s.byTool.map((o) => `  ${o.key.padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  (−${pct(o)}%, ${o.calls} call${o.calls === 1 ? "" : "s"})`),
    "",
    "By project:",
    ...s.byProject.slice(0, 8).map((o) => `  ${(o.key.split(/[\\/]/).filter(Boolean).pop() ?? o.key).padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  ${formatUsd(o.dollars).padStart(9)}`),
    "",
    (({ refused, fallbacks }) => `Hook (total): ${refused} built-in Read/Grep redirected, ${fallbacks} allowed on retry`)(s.redirections.total),
    ...real,
    "",
    `Pricing: ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok avoided (${s.pricing.formula}; prices checked ${s.pricing.checked}).`,
    `Change "model" / "laterTurns" in ~/.token-eco/config.json.`,
    s.estimate,
  ].join("\n");
}
