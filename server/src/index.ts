import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ToolResult } from "./types.ts";
import { read, readMany } from "./tools/read.ts";
import { searchCompact, searchMany, type SearchArgs } from "./tools/searchCompact.ts";
import { batchEdit } from "./tools/batchEdit.ts";
import { record } from "./db.ts";
import { estimateTokens } from "./tokens.ts";
import { summaryText } from "./stats.ts";
import { readConfig } from "./config.ts";
import { execFile } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const server = new McpServer({ name: "token-eco", version: "0.4.1" });

/** Project root: CLAUDE_PROJECT_DIR when Claude Code provides it, else the cwd. */
const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/** Wraps a tool for MCP and records the measurement (never blocking the tool). */
function adapter<A>(name: string, tool: (args: A) => Promise<ToolResult>) {
  return async (args: A) => {
    try {
      const t0 = Date.now();
      const r = await tool(args);
      try {
        record({
          project: ROOT,
          tool: name,
          returnedTokens: estimateTokens(r.text),
          nativeTokens: estimateTokens(r.nativeChars),
          durationMs: Date.now() - t0,
          details: r.details,
        });
      } catch (e) {
        console.error(`token-eco: measure not recorded (${(e as Error).message})`);
      }
      return { content: [{ type: "text" as const, text: r.text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `${name}: ${(e as Error).message}` }], isError: true };
    }
  };
}

// Three versatile tools (fewer definitions = lower fixed cost on every turn).
// Everything exposed and internal is in English.
server.registerTool(
  "read",
  {
    description: "Read a file cheaply. name → that symbol's code (function/class/method/type, with doc). start/end → those lines. "
      + "Neither → whole file if short, else an outline (signatures + line numbers) to pick from. "
      + "pattern → matching lines of that file with context. "
      + "targets → several of these reads in ONE call (batch everything you already know you need).",
    inputSchema: {
      file: z.string().optional().describe("Path relative to the project"),
      name: z.string().optional(),
      start: z.number().int().min(1).optional(),
      end: z.number().int().min(1).optional(),
      pattern: z.string().optional().describe("Regex: matching lines of file, ±context lines (default 2)"),
      context: z.number().int().min(0).max(3).optional(),
      targets: z.array(z.object({
        file: z.string(), name: z.string().optional(),
        start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional(),
        pattern: z.string().optional(), context: z.number().int().min(0).max(3).optional(),
      })).max(20).optional().describe("Batch: [{file, name?|start?/end?|pattern?}, …]"),
    },
  },
  adapter("read", async (a) => {
    const threshold = readConfig().hook.lineThreshold;
    const targets = [...(a.file ? [a] : []), ...(a.targets ?? [])]
      .map((t) => ({ file: t.file as string, name: t.name, start: t.start, end: t.end, pattern: t.pattern, context: t.context }));
    if (!targets.length) throw new Error("give file or targets");
    return targets.length === 1 ? read(targets[0], ROOT, threshold) : readMany(targets, ROOT, threshold);
  }),
);

const MODES = { lines: "lines", files: "files", count: "count" } as const;
server.registerTool(
  "search",
  {
    description: "Regex search grouped by file, exact totals, capped output; no pattern + glob = list files. Skips .git, node_modules, dist… "
      + "expand → the whole function/class around each hit (search + read in one call). "
      + "queries → several searches in ONE call (top-level options are defaults for each).",
    inputSchema: {
      queries: z.array(z.object({
        pattern: z.string().optional(), path: z.string().optional(), glob: z.string().optional(),
        mode: z.enum(["lines", "files", "count"]).optional(), expand: z.boolean().optional(),
      })).max(10).optional().describe("Batch: [{pattern?, path?, glob?, mode?, expand?}, …]"),
      expand: z.boolean().optional().describe("Return the whole enclosing function/class of each hit (≤150 lines each)"),
      pattern: z.string().optional().describe("JavaScript regex"),
      path: z.string().optional().describe("Directory or file (default .)"),
      glob: z.string().optional().describe("e.g. *.ts or src/**/*.py"),
      ignore_case: z.boolean().optional(),
      mode: z.enum(["lines", "files", "count"]).optional().describe("lines (default) | files | count per file"),
      max_results: z.number().int().min(1).max(500).optional().describe("Shown, default 50"),
      context: z.number().int().min(0).max(3).optional(),
      symbols: z.boolean().optional().describe("Label hits with their enclosing function/class + line span, so you can read name=… directly"),
    },
  },
  adapter("search", (a) => {
    const base: SearchArgs = {
      pattern: a.pattern, filePath: a.path, filter: a.glob, ignoreCase: a.ignore_case, symbols: a.symbols,
      mode: a.mode ? MODES[a.mode] : undefined, maxResults: a.max_results, context: a.context, expand: a.expand,
    };
    if (!a.queries?.length) return searchCompact(base, ROOT);
    const queries: SearchArgs[] = [
      ...(a.pattern ? [base] : []),
      ...a.queries.map((q) => ({
        ...base, pattern: q.pattern, filePath: q.path ?? base.filePath, filter: q.glob ?? base.filter,
        mode: q.mode ? MODES[q.mode] : base.mode, expand: q.expand ?? base.expand,
      })),
    ];
    return queries.length === 1 ? searchCompact(queries[0], ROOT) : searchMany(queries, ROOT);
  }),
);

server.registerTool(
  "edit",
  {
    description: "Exact replacements in one or more files, one call, all or nothing. No prior full read needed.",
    inputSchema: {
      edits: z.array(z.object({
        file: z.string(),
        old_string: z.string().describe("Exact, unique unless replace_all"),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      })).min(1),
    },
  },
  adapter("edit", (a) => batchEdit({
    edits: a.edits.map((e) => ({ file: e.file, oldText: e.old_string, newText: e.new_string, all: e.replace_all })),
  }, ROOT)),
);

// --- Report (not measured): used by /eco-stats and /eco-dashboard ---
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
server.registerTool(
  "eco_report",
  {
    description: "token-eco savings summary (estimates); dashboard=true starts the local dashboard and returns its URL.",
    inputSchema: { dashboard: z.boolean().optional() },
  },
  async (a) => {
    if (!a.dashboard) {
      try { return text(summaryText()); } catch (e) { return { ...text(`eco_report: ${(e as Error).message}`), isError: true }; }
    }
    // cli.js sits next to index.js in dist/ (cli.ts next to index.ts in dev).
    const cli = fileURLToPath(new URL(`./cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
    return new Promise((ok) => {
      execFile(process.execPath, [cli, "dashboard"], { timeout: 10_000 }, (err, stdout, stderr) =>
        ok(err ? { ...text(`eco_report: ${stderr || err.message}`), isError: true } : text(stdout.trim())));
    });
  },
);

await server.connect(new StdioServerTransport());
