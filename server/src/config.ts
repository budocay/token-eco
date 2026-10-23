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
  /** Key of PRICES (pricing.ts) used to turn saved tokens into dollars. */
  model: string;
  /** Average number of turns that follow a tool result in a session (each one re-reads it from the cache). */
  laterTurns: number;
  port: number;
  /** PreToolUse hook: "redirect" refuses once a full Read of a big file / a Grep in content mode. */
  hook: { mode: "off" | "redirect"; lineThreshold: number };
}

export const DEFAULT_CONFIG: Config = {
  model: DEFAULT_MODEL,
  laterTurns: 10,
  port: 4777,
  hook: { mode: "redirect", lineThreshold: 300 },
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
    const old = "tarifs" in c || "seuilLignes" in (c.hook ?? {}) || "pricing" in c;
    const hook = { ...DEFAULT_CONFIG.hook, ...c.hook };
    if (hook.seuilLignes != null) { hook.lineThreshold = hook.seuilLignes; delete hook.seuilLignes; }
    const cfg: Config = {
      model: typeof c.model === "string" && PRICES[c.model] ? c.model : DEFAULT_MODEL,
      laterTurns: Number.isFinite(c.laterTurns) ? c.laterTurns : DEFAULT_CONFIG.laterTurns,
      port: Number.isFinite(c.port) ? c.port : DEFAULT_CONFIG.port,
      hook,
    };
    if (old) writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Saved tokens → estimated dollars (see savedTokenRate for the formula). */
export function toDollars(tokens: number, config: Config = readConfig(), model = config.model): number {
  return (tokens / 1_000_000) * savedTokenRate(model, config.laterTurns);
}
