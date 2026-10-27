import {
  aggregate, aggregateScope, byDay, byDayAndKey, byKey, byWorkdir, projects, recent, redirectStats, type Aggregate, type Scope,
} from "./db.ts";
import { effectiveModel, readConfig, toDollars, uiLang, type Config } from "./config.ts";
import { PRICES, PRICES_CHECKED, PRICES_SOURCE, savedTokenRate } from "./pricing.ts";
import { CHARS_PER_TOKEN } from "./tokens.ts";
import { insights, isBench } from "./insights.ts";

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

export interface StatsQuery extends Scope { model?: string; includeBench?: boolean }

/** Everything the dashboard (web API) and the CLI need, optionally scoped to one project / N days. */
export function statistics(q: StatsQuery = {}) {
  const cfg: Config = readConfig();
  const model = q.model && PRICES[q.model] ? q.model : effectiveModel(cfg);
  const $ = <T extends Aggregate>(a: T): WithDollars<T> => ({ ...a, dollars: toDollars(a.saved, cfg, model) });
  const scope: Scope = { project: q.project || undefined, days: q.days ?? null };
  const keep = (p: { key: string }) => !!q.includeBench || !isBench(p.key, cfg);
  return {
    estimate: `Estimates: 1 token ≈ ${CHARS_PER_TOKEN} characters; "native" = assumed size of the equivalent built-in tool's output.`,
    pricing: {
      model, label: PRICES[model].label + (cfg.model === "auto" && !q.model ? " (auto: your main model)" : ""), laterTurns: cfg.laterTurns, rate: savedTokenRate(model, cfg.laterTurns),
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
    // Benchmark / temp folders (config excludeProjects) stay out of the project lists unless asked.
    byProject: byKey("project", scope).filter(keep).map($),
    projects: projects().filter(keep).map($),
    // Inside one project: its worktrees / sub-folders.
    byWorkdir: scope.project ? byWorkdir(scope).map($) : [],
    recent: recent(30, scope),
    redirections: { day: redirectStats("day"), week: redirectStats("week"), total: redirectStats("total") },
  };
}

const pct = (a: Aggregate) => (a.native ? Math.round((a.saved / a.native) * 100) : 0);

/** Plain-text summary for the terminal (/eco-stats). */
export function summaryText(lang: "en" | "fr" = uiLang()): string {
  const fr = lang === "fr", L = (en: string, f: string) => (fr ? f : en);
  const s = statistics();
  const calls = (n: number) => fr ? `${n} appel${n > 1 ? "s" : ""}` : `${n} call${n === 1 ? "" : "s"}`;
  const line = (name: string, a: WithDollars<Aggregate>) =>
    `${name.padEnd(12)} ${formatTokens(a.saved).padStart(8)} tokens  ${formatUsd(a.dollars).padStart(9)}  (−${pct(a)}%, ${calls(a.calls)})`;
  let real: string[] = [];
  try {
    const r = insights({ days: 30 });
    const p = (x: number | null) => (x == null ? "–" : x > 0 && x < 0.001 ? "<0.1%" : `${+(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
    const c = r.coverage, b = r.breakdown, cmp = r.compare, nW = cmp.all.with.sessions, nO = cmp.all.without.sessions;
    const verdict = nW < 3 || nO < 3
      ? L(`Not enough comparable sessions (${nW} with / ${nO} without, same project and model; 3 of each needed).`,
        `Pas assez de sessions comparables (${nW} avec / ${nO} sans, même projet et même modèle ; il en faut 3 de chaque).`)
      : L(`Cost per turn ${cmp.delta! <= 0 ? "−" : "+"}${Math.abs(Math.round(cmp.delta! * 100))}% with token-eco (median, ${nW} vs ${nO} sessions). Tasks still differ: a trend, not a proof.`,
        `Coût par tour ${cmp.delta! <= 0 ? "−" : "+"}${Math.abs(Math.round(cmp.delta! * 100))}% avec token-eco (médiane, ${nW} vs ${nO} sessions). Les tâches diffèrent : une tendance, pas une preuve.`);
    const notSet = L("not set", "non réglé");
    real = [
      L(`Real sessions, last 30 days (${r.sessions.length} session(s), ${r.excluded} benchmark/temp hidden), ${formatUsd(b.cost)}:`,
        `Sessions réelles, 30 derniers jours (${r.sessions.length} session(s), ${r.excluded} benchmark/temp masquée(s)), ${formatUsd(b.cost)} :`),
      L(`  Coverage   main thread ${p(c.mainPct)} (${c.main.eco} token-eco / ${c.main.native} built-in) · subagents ${p(c.subPct)} (${c.sub.eco} / ${c.sub.native})`,
        `  Couverture fil principal ${p(c.mainPct)} (${c.main.eco} token-eco / ${c.main.native} natifs) · sous-agents ${p(c.subPct)} (${c.sub.eco} / ${c.sub.native})`),
      L(`  Bash       ${p(c.bashPct)} compacted (${c.bash.compacted} of ${c.bash.total})`, `  Bash       ${p(c.bashPct)} compacté (${c.bash.compacted} sur ${c.bash.total})`),
      L(`  Avoided    ${formatUsd(r.avoided.usd)} = ${p(r.avoided.shareOfCost)} of the bill (est., each session's own model)`,
        `  Évité      ${formatUsd(r.avoided.usd)} = ${p(r.avoided.shareOfCost)} de la facture (est., modèle de chaque session)`),
      L(`  Cost       subagents ${p(b.cost ? b.costSub / b.cost : null)} · cache reads ${p(b.cost ? b.kinds.read / b.cost : null)} · cache writes ${p(b.cost ? b.kinds.write / b.cost : null)} · output ${p(b.cost ? b.kinds.output / b.cost : null)}`,
        `  Coût       sous-agents ${p(b.cost ? b.costSub / b.cost : null)} · lectures cache ${p(b.cost ? b.kinds.read / b.cost : null)} · écritures cache ${p(b.cost ? b.kinds.write / b.cost : null)} · sortie ${p(b.cost ? b.kinds.output / b.cost : null)}`),
      `  ${L("Compare   ", "Comparaison")} ${verdict}`,
      L("Levers (measured; setting in ~/.claude/settings.json \"env\"):", "Leviers (mesurés ; réglage dans ~/.claude/settings.json \"env\") :"),
      `  ${L("Context above 300K (main)    ", "Contexte au-delà de 300K     ")} ${formatUsd(r.levers.compaction.over300k).padStart(10)}  CLAUDE_CODE_AUTO_COMPACT_WINDOW = ${r.levers.compaction.setting ?? L("not set (try 300k)", "non réglé (essayer 300k)")}`,
      `  ${L(`Subagents on ${r.levers.subagents.cheaperModel.replace("claude-", "")} would save`, `Sous-agents en ${r.levers.subagents.cheaperModel.replace("claude-", "")} : économie`)} ${formatUsd(r.levers.subagents.saving).padStart(6)}  CLAUDE_CODE_SUBAGENT_MODEL = ${r.levers.subagents.setting ?? notSet}`,
      `  ${L(`Cache expired (${r.levers.rebuilds.count} rewrites)  `, `Cache expiré (${r.levers.rebuilds.count} réécritures)`)} ${formatUsd(r.levers.rebuilds.cost).padStart(10)}  cache TTL = ${r.levers.rebuilds.setting ?? L("5m (try CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h)", "5m (essayer CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h)")}`,
      "",
    ];
  } catch { /* logs unreadable: estimates only */ }
  const { refused, fallbacks } = s.redirections.total;
  return [
    ...real,
    L("token-eco — ESTIMATED tokens avoided per call (vs the assumed built-in call; extra turns not counted)",
      "token-eco — tokens évités par appel, ESTIMÉS (vs l'appel natif supposé ; tours en plus non comptés)"),
    line(L("Today", "Aujourd'hui"), s.today),
    line(L("7 days", "7 jours"), s.week),
    line("Total", s.total),
    "",
    L("By tool:", "Par outil :"),
    ...s.byTool.map((o) => `  ${o.key.padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  (−${pct(o)}%, ${calls(o.calls)})`),
    "",
    L("By project:", "Par projet :"),
    ...s.byProject.slice(0, 8).map((o) => `  ${(o.key.split(/[\\/]/).filter(Boolean).pop() ?? o.key).padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  ${formatUsd(o.dollars).padStart(9)}`),
    "",
    L(`Hook (total): ${refused} built-in Read/Grep redirected, ${fallbacks} allowed on retry`,
      `Hook (total) : ${refused} Read/Grep natifs redirigés, ${fallbacks} autorisés à la relance`),
    "",
    L(`Pricing: ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok avoided (${s.pricing.formula}; prices checked ${s.pricing.checked}).`,
      `Tarifs : ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok évité (tokens économisés × (écriture cache 5 min + ${s.pricing.laterTurns} tours suivants × lecture cache) par MTok ; prix vérifiés le ${s.pricing.checked}).`),
    L(`Change "model" / "laterTurns" / "lang" in ~/.token-eco/config.json.`, `Modifier "model" / "laterTurns" / "lang" dans ~/.token-eco/config.json.`),
    L(s.estimate, `Estimations : 1 token ≈ ${CHARS_PER_TOKEN} caractères ; « natif » = taille supposée de la sortie de l'outil intégré équivalent.`),
  ].join("\n");
}
