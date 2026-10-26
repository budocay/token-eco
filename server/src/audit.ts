/**
 * What fills the starting context of every session and subagent (re-read on every turn): CLAUDE.md files
 * (whole, with @imports), and the name + description of every skill, agent and command of the enabled plugins
 * and of ~/.claude. Hooks injecting text at session start and MCP servers are listed (their size is only
 * known at run time: compare with the measured starting context).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { estimateTokens } from "./tokens.ts";

export interface AuditItem { source: string; kind: string; count: number; tokens: number; note?: string }

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const description = (md: string) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  const name = /^name:\s*(.*)$/m.exec(fm)?.[1] ?? "";
  const desc = /^description:\s*([\s\S]*?)(?=^\w[\w-]*:|$(?![\s\S]))/m.exec(fm)?.[1] ?? "";
  return `${name} ${desc}`.trim();
};

/** CLAUDE.md with its @imports (one level is enough in practice; cycles guarded). */
function claudeMd(file: string, seen = new Set<string>()): number {
  if (seen.has(file) || !existsSync(file)) return 0;
  seen.add(file);
  const text = read(file);
  let n = estimateTokens(text);
  for (const m of text.matchAll(/^@(\S+)/gm)) {
    const p = m[1].startsWith("~/") ? join(homedir(), m[1].slice(2)) : resolve(dirname(file), m[1]);
    n += claudeMd(p, seen);
  }
  return n;
}

/** Skills / agents / commands of one root (a plugin or ~/.claude): descriptions only. */
function components(root: string, source: string): AuditItem[] {
  const out: AuditItem[] = [];
  const add = (kind: string, files: string[]) => {
    const descs = files.map((f) => description(read(f))).filter(Boolean);
    if (descs.length) out.push({ source, kind, count: descs.length, tokens: estimateTokens(descs.join("\n")) });
  };
  const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  const skills: string[] = [];
  const walk = (d: string, depth: number) => {
    if (existsSync(join(d, "SKILL.md"))) { skills.push(join(d, "SKILL.md")); return; }
    if (depth < 4) for (const s of ls(d)) if (s !== "node_modules" && !s.startsWith(".")) walk(join(d, s), depth + 1);
  };
  for (const s of ls(join(root, "skills"))) walk(join(root, "skills", s), 1);
  add("skills", skills);
  add("agents", ls(join(root, "agents")).filter((f) => f.endsWith(".md")).map((f) => join(root, "agents", f)));
  add("commands", ls(join(root, "commands")).filter((f) => f.endsWith(".md")).map((f) => join(root, "commands", f)));
  const hooks = read(join(root, "hooks", "hooks.json"));
  if (/"SessionStart"/.test(hooks)) out.push({ source, kind: "SessionStart hook", count: 1, tokens: 0, note: "injects text at startup (size known at run time)" });
  const mcp = read(join(root, ".mcp.json"));
  try {
    const n = Object.keys(JSON.parse(mcp).mcpServers ?? JSON.parse(mcp)).length;
    if (n) out.push({ source, kind: "MCP servers", count: n, tokens: 0, note: "tool schemas loaded (or deferred) at startup" });
  } catch { /* none */ }
  return out;
}

export function audit(cwd = process.cwd(), home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): AuditItem[] {
  const items: AuditItem[] = [];
  const user = claudeMd(join(home, "CLAUDE.md"));
  if (user) items.push({ source: "~/.claude", kind: "CLAUDE.md", count: 1, tokens: user });
  for (const f of [join(cwd, "CLAUDE.md"), join(cwd, ".claude", "CLAUDE.md"), join(cwd, "CLAUDE.local.md")]) {
    const n = claudeMd(f);
    if (n) items.push({ source: "project", kind: f.slice(cwd.length + 1), count: 1, tokens: n });
  }
  items.push(...components(home, "~/.claude"));
  let enabled: Record<string, boolean> = {};
  try { enabled = JSON.parse(read(join(home, "settings.json"))).enabledPlugins ?? {}; } catch { /* none */ }
  let installed: Record<string, { installPath: string; scope?: string }[]> = {};
  try { installed = JSON.parse(read(join(home, "plugins", "installed_plugins.json"))).plugins ?? {}; } catch { /* none */ }
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const entry = installed[id]?.find((x) => x.scope === "user") ?? installed[id]?.[0];
    if (entry && existsSync(entry.installPath)) items.push(...components(entry.installPath, id.split("@")[0]));
  }
  return items.sort((a, b) => b.tokens - a.tokens);
}

export function auditText(measured?: { main: number; sub: number }): string {
  const items = audit();
  const total = items.reduce((a, i) => a + i.tokens, 0);
  return [
    "token-eco audit — what every session and subagent loads before your first message (re-read on every turn)",
    ...items.map((i) => `  ${i.source.padEnd(22)} ${`${i.count} ${i.kind}`.padEnd(26)} ${i.tokens ? `~${i.tokens} tok` : ""}${i.note ? `  (${i.note})` : ""}`),
    `  ${"".padEnd(22)} ${"listed total".padEnd(26)} ~${total} tok`,
    measured ? `Measured starting context (median): ${measured.main} tok main thread, ${measured.sub} tok per subagent — the rest is Claude Code's own prompt and tool schemas.` : "",
    "Disable plugins you do not use (claude plugin disable <name>) and keep CLAUDE.md short: each 10K tokens is re-read on every turn.",
  ].filter(Boolean).join("\n");
}
