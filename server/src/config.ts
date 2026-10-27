import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, PRICES, savedTokenRate } from "./pricing.ts";

/** Data directory (override with TOKEN_ECO_HOME, used by the tests). */
/**
 * Node binary to start a child process with. process.execPath can point to a versioned install that no
 * longer exists (e.g. Homebrew upgraded Node while the long-running MCP server kept the old path):
 * then fall back to `node` from PATH.
 */
export function nodeBinary(execPath = process.execPath): string {
  return execPath && existsSync(execPath) ? execPath : "node";
}

export function dataDir(): string {
  const d = process.env.TOKEN_ECO_HOME ?? join(homedir(), ".token-eco");
  mkdirSync(d, { recursive: true });
  return d;
}

export interface Config {
  /** Key of PRICES (pricing.ts) used to turn saved tokens into dollars, or "auto" = the model you used
   *  most in your real sessions of the last 30 days. */
  model: string;
  /** Real-session views ignore sessions whose project path contains one of these (benchmarks, temp dirs). */
  excludeProjects: string[];
  /** Average number of turns that follow a tool result in a session (each one re-reads it from the cache). */
  laterTurns: number;
  port: number;
  /** PreToolUse hook: "redirect" refuses once a full Read of a big file / a Grep in content mode. */
  hook: { mode: "off" | "redirect"; lineThreshold: number };
  /** Language of the terminal texts (/eco-stats, status line): "auto" = from LANG / LC_ALL. */
  lang: "auto" | "en" | "fr";
}

/** "en" | "fr" for the terminal texts. */
export function uiLang(cfg: Config = readConfig()): "en" | "fr" {
  if (cfg.lang === "en" || cfg.lang === "fr") return cfg.lang;
  return /^fr/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "") ? "fr" : "en";
}

export const DEFAULT_CONFIG: Config = {
  model: "auto",
  excludeProjects: ["/var/folders/", "/private/var/", "/tmp/", "/private/tmp/", "token-eco-trial"],
  laterTurns: 10,
  port: 4777,
  hook: { mode: "redirect", lineThreshold: 300 },
  lang: "auto",
};

/** Reads ~/.token-eco/config.json (created with defaults; pre-0.4 keys are migrated and rewritten). */
export function readConfig(): Config {
  const f = join(dataDir(), "config.json");
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return DEFAULT_CONFIG;
  }
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    const old = "tarifs" in c || "seuilLignes" in (c.hook ?? {}) || "pricing" in c || !("excludeProjects" in c);
    const hook = { ...DEFAULT_CONFIG.hook, ...c.hook };
    // Pre-0.6 files hold the old default model explicitly: switch them to "auto".
    if (!("excludeProjects" in c) && c.model === DEFAULT_MODEL) c.model = "auto";
    if (hook.seuilLignes != null) { hook.lineThreshold = hook.seuilLignes; delete hook.seuilLignes; }
    const cfg: Config = {
      model: typeof c.model === "string" && (PRICES[c.model] || c.model === "auto") ? c.model : DEFAULT_CONFIG.model,
      excludeProjects: Array.isArray(c.excludeProjects) ? c.excludeProjects.filter((x: unknown) => typeof x === "string")
        : DEFAULT_CONFIG.excludeProjects,
      laterTurns: Number.isFinite(c.laterTurns) ? c.laterTurns : DEFAULT_CONFIG.laterTurns,
      port: Number.isFinite(c.port) ? c.port : DEFAULT_CONFIG.port,
      hook,
      lang: c.lang === "en" || c.lang === "fr" ? c.lang : "auto",
    };
    if (old) writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Saved tokens → estimated dollars (see savedTokenRate for the formula). */
const AUTO_FILE = () => join(dataDir(), "auto-model.json");

/** Pricing model actually used: the configured one, or for "auto" the last model resolved from the real
 *  sessions (cached by saveAutoModel so the status line does not scan the logs). */
export function effectiveModel(config: Config = readConfig()): string {
  if (config.model !== "auto") return config.model;
  try {
    const m = JSON.parse(readFileSync(AUTO_FILE(), "utf8")).model;
    if (PRICES[m]) return m;
  } catch { /* not resolved yet */ }
  return DEFAULT_MODEL;
}

export function saveAutoModel(model: string): void {
  if (PRICES[model]) writeFileSync(AUTO_FILE(), JSON.stringify({ model, at: new Date().toISOString() }) + "\n");
}

export function toDollars(tokens: number, config: Config = readConfig(), model = effectiveModel(config)): number {
  return (tokens / 1_000_000) * savedTokenRate(model, config.laterTurns);
}
