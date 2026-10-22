/**
 * PreToolUse hook (every agent, including the user's subagents).
 * - Bash: TRANSPARENT rewrite (updatedInput) of noisy commands (tests,
 *   builds, installs, git) to `run.js`, which compacts the output. Permissions are respected:
 *   deny rule → nothing is touched; allow rule (or read-only, or bypass) → allow;
 *   otherwise rewrite without a decision, Claude Code asks as usual.
 * - Read without offset/limit of a big text file → refused, and the message CONTAINS the outline
 *   (no wasted turn); Grep "content" → refused, pointing to search.
 *   Safety net: the SAME call repeated within 10 minutes goes through.
 * Any internal error lets the call through: the hook never blocks.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { dataDir, readConfig, type Config } from "./config.ts";
import { record, recordRedirect } from "./db.ts";
import { family } from "./compact.ts";
import { outline } from "./tools/outline.ts";
import { nativeReadChars, splitLines } from "./types.ts";
import { estimateTokens } from "./tokens.ts";
import { sessionStartOutput } from "./guidance.ts";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  permission_mode?: string;
}
export type State = Record<string, number>;
export type Decision =
  | { action: "pass" }
  | { action: "fallback"; key: string }
  | { action: "refused"; key: string; message: string; file?: string }
  | { action: "rewrite"; command: string; autoAllow: boolean };
export interface Rules { allow: string[]; deny: string[] }

const DELAI_REPLI_MS = 10 * 60_000;
const NON_TEXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".ipynb"]);
const RETRY_HINT = "If these tools are not available to you, or you really need the whole output, repeat the exact same call: it will be allowed.";
const COMPOUND = /&&|\|\||[;|<>`&]|\$\(|\n/;
const WATCH_MODE = /\s(--watch|-w|--watchAll|serve|dev|start)\b/;
const READ_ONLY = /^git\s+(status|log|diff|show)\b/;
const CD_PREFIX = /^cd\s+([\w./~-]+|"[^"$`\\]*"|'[^']*')\s*&&\s*/;
const TAIL_HEAD_SUFFIX = /\s*\|\s*(tail|head)\s+(-n\s*\d+|-\d+|-n\d+)\s*$/;

/**
 * Isolates the core command of the usual forms `cd x && cmd`, `cmd 2>&1 | tail -N`, `cmd | head -N`.
 * `prior`/`trailer` are glued back around the run.js call (which already merges stdout/stderr).
 */
export function decompose(command: string): { prior: string; c: string; trailer: string } {
  let c = command.trim(), prior = "", trailer = "";
  const cd = CD_PREFIX.exec(c);
  if (cd) { prior = `cd ${cd[1]} && `; c = c.slice(cd[0].length); }
  const th = TAIL_HEAD_SUFFIX.exec(c);
  if (th) { trailer = ` | ${th[1]} ${th[2].replace(/\s+/g, " ")}`; c = c.slice(0, th.index); }
  c = c.replace(/\s+2>&1\s*$/, "").trim();
  return { prior, c, trailer };
}

export function countLines(filePath: string): number {
  const size = statSync(filePath).size;
  if (size > 50_000_000) return Infinity;
  const b = readFileSync(filePath);
  if (b.subarray(0, 8000).includes(0)) return 0; // binary: let Read handle it
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}

/** Claude Code permission rule `Bash(...)`: `Bash`, `Bash(prefix:*)`, `Bash(pattern with *)`, `Bash(exact)`. */
export function ruleMatches(rule: string, command: string): boolean {
  if (rule === "Bash") return true;
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pattern = m[1];
  if (pattern.endsWith(":*")) return command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -2) + " ");
  if (pattern.includes("*")) return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command);
  return command === pattern;
}

export function readRules(cwd?: string): Rules {
  const r: Rules = { allow: [], deny: [] };
  const files = [join(homedir(), ".claude/settings.json")];
  if (cwd) files.push(join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json"));
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(f, "utf8")).permissions ?? {};
      r.allow.push(...(p.allow ?? []));
      r.deny.push(...(p.deny ?? []));
    } catch { /* missing or invalid */ }
  }
  return r;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function decide(e: HookInput, config: Config, state: State, now = Date.now(),
  linesOf: (filePath: string) => number = countLines, rules: Rules = { allow: [], deny: [] },
  runJs = "run.js"): Decision {
  if (config.hook.mode === "off") return { action: "pass" };
  const ti = e.tool_input ?? {};
  let key: string, message: string, file: string | undefined;

  if (e.tool_name === "Bash") {
    const complete = String(ti.command ?? "").trim();
    const { prior, c, trailer } = decompose(complete);
    if (!c || COMPOUND.test(c) || WATCH_MODE.test(c) || ti.run_in_background || family(c) === "other") return { action: "pass" };
    if (rules.deny.some((r) => ruleMatches(r, c) || ruleMatches(r, complete))) return { action: "pass" };
    // cd / tail / head are harmless: permission is decided on the core command.
    const autoAllow = e.permission_mode === "bypassPermissions" || READ_ONLY.test(c) || rules.allow.some((r) => ruleMatches(r, c));
    return { action: "rewrite", command: `${prior}node ${quote(runJs)} ${quote(c)}${trailer}`, autoAllow };
  }
  if (e.tool_name === "Read") {
    const f = String(ti.file_path ?? "");
    if (!f || ti.offset != null || ti.limit != null || NON_TEXT.has(extname(f).toLowerCase())) return { action: "pass" };
    file = isAbsolute(f) || !e.cwd ? f : join(e.cwd, f);
    let n: number;
    try { n = linesOf(file); } catch { return { action: "pass" }; }
    if (n <= config.hook.lineThreshold) return { action: "pass" };
    key = `Read|${file}`;
    message = `token-eco: ${f} has ${n === Infinity ? "many" : n} lines; a full Read is expensive. Its outline is below. `
      + `Next, read only what you need with the token-eco tool read (name = symbol, or start/end) or Read with offset/limit. ${RETRY_HINT}`;
  } else if (e.tool_name === "Grep") {
    if (ti.output_mode !== "content") return { action: "pass" };
    key = `Grep|${String(ti.pattern)}|${String(ti.path ?? "")}|${String(ti.glob ?? "")}`;
    message = `token-eco: use the token-eco tool search instead (same regex; grouped by file, exact totals, about half the tokens; `
      + `mode files/count also available). ${RETRY_HINT}`;
  } else return { action: "pass" };

  key = `${e.session_id ?? "?"}|${key}`;
  const prior = state[key];
  if (prior && now - prior < DELAI_REPLI_MS) return { action: "fallback", key };
  return { action: "refused", key, message, file };
}

/** Savings of a Read redirect: native avoided − message; cancelled if the agent repeats the Read. */
function measureRead(e: HookInput, file: string, returned: number, native: number): void {
  record({ project: e.cwd ?? process.cwd(), tool: "read_redirect", returnedTokens: returned, nativeTokens: native,
    details: { file } });
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw) as HookInput;
  const config = readConfig();
  if (e.hook_event_name === "SessionStart") {
    if (config.hook.mode !== "off") process.stdout.write(sessionStartOutput());
    return;
  }
  const runJs = join(dirname(process.argv[1]), "run.js");
  const stateFile = join(dataDir(), "hook-state.json");
  let state: State = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* first call */ }
  const now = Date.now();
  for (const [k, t] of Object.entries(state)) if (now - t > DELAI_REPLI_MS) delete state[k];

  const rules = e.tool_name === "Bash" ? readRules(e.cwd) : undefined;
  const d = decide(e, config, state, now, countLines, rules, runJs);
  if (d.action === "pass") return;

  if (d.action === "rewrite") {
    const output: Record<string, unknown> = { hookEventName: "PreToolUse", updatedInput: { ...e.tool_input, command: d.command } };
    if (d.autoAllow) Object.assign(output, { permissionDecision: "allow", permissionDecisionReason: "token-eco: compact output" });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
    return;
  }

  if (d.action === "fallback") delete state[d.key];
  else state[d.key] = now;
  writeFileSync(stateFile, JSON.stringify(state));
  const [, tool, ...rest] = d.key.split("|");
  try { recordRedirect(e.session_id ?? "", tool, rest.join("|"), d.action); } catch { /* jamais bloquant */ }

  if (d.action === "fallback") {
    if (tool === "Read") {
      try { // the native Read finally happens: take back the savings counted at the refusal
        const native = nativeReadChars(splitLines(readFileSync(rest.join("|"), "utf8")));
        measureRead(e, rest.join("|"), estimateTokens(native), 0);
      } catch { /* ignored */ }
    }
    return;
  }

  let message = d.message;
  if (d.file) {
    try {
      const ap = await outline({ file: d.file });
      message += `\n\n${ap.text}`;
      measureRead(e, d.file, estimateTokens(message), estimateTokens(ap.nativeChars));
    } catch { /* message only */ }
  }
  process.stderr.write(message + "\n");
  process.exit(2);
}

if (process.argv[1] && /hook\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => process.exit(0));
}
