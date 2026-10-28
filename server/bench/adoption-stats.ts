/**
 * Statistics of the adoption campaigns (from the raw JSON files, no API call).
 * Per cell (campaign × model × task × variant): n, mean, sd, min, max of the cost; turns; coverage; Bash reads.
 * Each eco variant vs native: relative difference of the means and an EXACT two-sided permutation test on the
 * cost (all C(n1+n2, n1) splits; with 3 vs 3 there are 20 splits, so p cannot go below 0.10).
 *
 * Usage: node bench/adoption-stats.ts [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
interface Trial { model: string; task: string; variant: string; ok: boolean; cost: number; turnsMain: number; turnsSub: number;
  mainEco: number; mainNative: number; subEco: number; subNative: number; bashReads: number; bashReadKb: number; refused: number; error?: string }
const CAMPAIGNS = [
  { id: "A1 (v0.7.3, short tasks)", file: "adoption-raw.json" },
  { id: "A2 (v0.7.4, t6 again)", file: "adoption-t6fix-raw.json" },
  { id: "A3 (v0.7.4, long task)", file: "adoption-long-raw.json" },
];

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
/** Exact two-sided permutation test on the difference of means. */
function permutationP(a: number[], b: number[]): number {
  const all = [...a, ...b], n = a.length, obs = Math.abs(mean(a) - mean(b));
  let hits = 0, total = 0;
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === n) {
      const ga = chosen.map((i) => all[i]), gb = all.filter((_, i) => !chosen.includes(i));
      total++; if (Math.abs(mean(ga) - mean(gb)) >= obs - 1e-12) hits++; return;
    }
    for (let i = start; i < all.length; i++) pick(i + 1, [...chosen, i]);
  };
  pick(0, []);
  return hits / total;
}

const rows: Record<string, unknown>[] = [];
for (const c of CAMPAIGNS) {
  const trials: Trial[] = JSON.parse(readFileSync(join(HERE, c.file), "utf8")).filter((x: Trial) => !x.error);
  const cells = [...new Set(trials.map((x) => `${x.model}|${x.task}`))];
  for (const cell of cells) {
    const [model, task] = cell.split("|");
    const of = (v: string) => trials.filter((x) => x.model === model && x.task === task && x.variant === v);
    const native = of("native").map((x) => x.cost);
    for (const v of ["native", "eco-before", "eco-after"]) {
      const xs = of(v);
      if (!xs.length) continue;
      const cost = xs.map((x) => x.cost), sum = (k: keyof Trial) => xs.reduce((s, x) => s + (x[k] as number), 0);
      const cov = (e: number, n: number) => (e + n ? e / (e + n) : null);
      rows.push({
        campaign: c.id, model, task, variant: v, n: xs.length, success: xs.filter((x) => x.ok).length,
        costMean: mean(cost), costSd: sd(cost), costMin: Math.min(...cost), costMax: Math.max(...cost),
        vsNative: v === "native" || !native.length ? null : mean(cost) / mean(native) - 1,
        pPermutation: v === "native" || native.length < 2 || cost.length < 2 ? null : permutationP(cost, native),
        turnsMain: mean(xs.map((x) => x.turnsMain)), turnsSub: mean(xs.map((x) => x.turnsSub)),
        coverageSub: cov(sum("subEco"), sum("subNative")), coverageMain: cov(sum("mainEco"), sum("mainNative")),
        subFileCalls: mean(xs.map((x) => x.subEco + x.subNative)), bashReads: mean(xs.map((x) => x.bashReads)),
        bashReadKb: mean(xs.map((x) => x.bashReadKb)), hookRefused: mean(xs.map((x) => x.refused)),
      });
    }
  }
}

const f = (x: unknown, d = 3) => (x == null ? "–" : typeof x === "number" ? x.toFixed(d) : String(x));
const pct = (x: unknown) => (x == null ? "–" : `${Math.round((x as number) * 100)}%`);
console.log("campaign | model | task | variant | n | ok | cost mean ± sd [min-max] | vs native | p | turns main/sub | cov sub | bash reads");
for (const r of rows) {
  console.log([r.campaign, r.model, r.task, r.variant, r.n, r.success, `${f(r.costMean)} ± ${f(r.costSd)} [${f(r.costMin)}-${f(r.costMax)}]`,
    r.vsNative == null ? "–" : `${(r.vsNative as number) > 0 ? "+" : ""}${Math.round((r.vsNative as number) * 100)}%`, f(r.pPermutation, 2),
    `${f(r.turnsMain, 1)}/${f(r.turnsSub, 1)}`, pct(r.coverageSub), `${f(r.bashReads, 1)} (${f(r.bashReadKb, 0)} KB)`].join(" | "));
}
const out = process.argv.indexOf("--json");
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(rows, null, 1));
