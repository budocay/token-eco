/**
 * REAL token usage of Claude Code sessions, read from their logs (~/.claude/projects/<encoded cwd>/<id>.jsonl,
 * subagents in <id>/subagents/*.jsonl). Unlike the per-call estimates, this counts everything the model
 * processed: every turn re-reads the context, so extra turns show up here.
 * An assistant message logged on several lines is counted once (message.id). 1-hour cache writes cost
 * 2 × input, 5-minute writes use cacheWrite5m (Anthropic pricing rules).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PRICES, type ModelPrice } from "./pricing.ts";

export interface SessionTotals {
  id: string; project: string; start: string; end: string; model: string;
  turns: number; subagentTurns: number; input: number; write5m: number; write1h: number; cacheRead: number;
  output: number; tokens: number; cost: number; peakContext: number; ecoCalls: number;
  tools: Record<string, number>; unpriced: string[];
}

export const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
export const encodeProject = (dir: string) => resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");
const ECO_TOOL = /^mcp__plugin_token-eco_token-eco__/;

export function priceFor(model: string, forced?: string): ModelPrice | undefined {
  if (forced) return PRICES[forced];
  return PRICES[model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2")];
}

export function emptyTotals(id = "", project = ""): SessionTotals {
  return { id, project, start: "", end: "", model: "", turns: 0, subagentTurns: 0, input: 0, write5m: 0, write1h: 0,
    cacheRead: 0, output: 0, tokens: 0, cost: 0, peakContext: 0, ecoCalls: 0, tools: {}, unpriced: [] };
}

/** Adds one log file (main or subagent) to t. cold: the first main turn pays its prefix as a 1h cache write. */
export function addLog(t: SessionTotals, file: string, isSub: boolean, opts: { cold?: boolean; model?: string } = {}): void {
  const seenMsg = new Set<string>(), seenTool = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isSub && o.cwd && !t.project) t.project = o.cwd;
    if (o.timestamp) { if (!t.start || o.timestamp < t.start) t.start = o.timestamp; if (o.timestamp > t.end) t.end = o.timestamp; }
    const m = o.message;
    if (o.type !== "assistant" || !m) continue;
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "tool_use" && !seenTool.has(c.id)) {
        seenTool.add(c.id);
        if (ECO_TOOL.test(c.name)) t.ecoCalls++;
        const key = (isSub ? "sub:" : "") + String(c.name).replace(ECO_TOOL, "eco:");
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
    if (opts.cold && !isSub && seenMsg.size === 1) { w1h += read; read = 0; }
    t.input += inp; t.write5m += w5m; t.write1h += w1h; t.cacheRead += read; t.output += out;
    t.tokens += inp + w5m + w1h + read + out;
    if (isSub) t.subagentTurns++; else { t.turns++; t.peakContext = Math.max(t.peakContext, inp + w5m + w1h + read); t.model ||= m.model; }
    const p = priceFor(m.model, opts.model);
    if (!p) { if (!t.unpriced.includes(m.model)) t.unpriced.push(m.model); continue; }
    t.cost += (inp * p.input + w5m * p.cacheWrite5m + w1h * 2 * p.input + read * p.cacheRead + out * p.output) / 1e6;
  }
}

export function subagentLogs(mainLog: string): string[] {
  const d = join(mainLog.replace(/\.jsonl$/, ""), "subagents");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => join(d, f)) : [];
}

/** One session (main log + its subagents). */
export function sessionTotals(mainLog: string, opts: { cold?: boolean; model?: string } = {}): SessionTotals {
  const t = emptyTotals(mainLog.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ""));
  addLog(t, mainLog, false, opts);
  for (const f of subagentLogs(mainLog)) addLog(t, f, true, opts);
  return t;
}

// Parsed sessions, by file + mtime + size (the dashboard polls; logs only grow).
const cache = new Map<string, { key: string; t: SessionTotals }>();

/** Sessions with at least one model turn, most recent first. project = full path (as in the calls table). */
export function listSessions(scope: { project?: string; days?: number | null } = {}, root = projectsDir()): SessionTotals[] {
  if (!existsSync(root)) return [];
  const since = scope.days ? Date.now() - scope.days * 86_400_000 : 0;
  const dirs = scope.project ? [encodeProject(scope.project)] : readdirSync(root);
  const out: SessionTotals[] = [];
  for (const d of dirs) {
    const dir = join(root, d);
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      const st = statSync(path);
      if (st.mtimeMs < since) continue;
      const key = `${st.mtimeMs}|${st.size}`;
      let hit = cache.get(path);
      if (!hit || hit.key !== key) { hit = { key, t: sessionTotals(path) }; cache.set(path, hit); }
      if (hit.t.turns && (!scope.project || resolve(hit.t.project) === resolve(scope.project))) out.push(hit.t);
    }
  }
  return out.sort((a, b) => b.end.localeCompare(a.end));
}

export interface SessionGroup { sessions: number; turns: number; tokens: number; cost: number; tokensPerTurn: number; costPerSession: number }

/** Sessions that used the token-eco tools vs sessions that did not. */
export function compareSessions(list: SessionTotals[]): { withEco: SessionGroup; withoutEco: SessionGroup } {
  const group = (l: SessionTotals[]): SessionGroup => {
    // Tokens include the subagents, so do the turns (otherwise Task-heavy sessions look absurd per turn).
    const turns = l.reduce((s, x) => s + x.turns + x.subagentTurns, 0), tokens = l.reduce((s, x) => s + x.tokens, 0), cost = l.reduce((s, x) => s + x.cost, 0);
    return { sessions: l.length, turns, tokens, cost, tokensPerTurn: turns ? Math.round(tokens / turns) : 0, costPerSession: l.length ? cost / l.length : 0 };
  };
  return { withEco: group(list.filter((s) => s.ecoCalls > 0)), withoutEco: group(list.filter((s) => s.ecoCalls === 0)) };
}
