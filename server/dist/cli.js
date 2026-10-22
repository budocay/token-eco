var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/pricing.ts
function savedTokenRate(model, laterTurns) {
  const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  return p.cacheWrite5m + Math.max(0, laterTurns) * p.cacheRead;
}
var PRICES_CHECKED, PRICES_SOURCE, PRICES, DEFAULT_MODEL;
var init_pricing = __esm({
  "src/pricing.ts"() {
    "use strict";
    PRICES_CHECKED = "2026-10-22";
    PRICES_SOURCE = "https://docs.claude.com/en/docs/about-claude/pricing";
    PRICES = {
      "claude-fable-5.1": { label: "Claude Fable 5.1", input: 10, cacheWrite5m: 12.5, cacheRead: 0.25, output: 50 },
      "claude-opus-5.5": { label: "Claude Opus 5.5", input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
      "claude-opus-5": { label: "Claude Opus 5", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
      "claude-opus-4.8": { label: "Claude Opus 4.8", input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
      "claude-sonnet-5.5": { label: "Claude Sonnet 5.5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
      "claude-sonnet-5": { label: "Claude Sonnet 5", input: 2, cacheWrite5m: 2.5, cacheRead: 0.2, output: 10 },
      "claude-sonnet-4.6": { label: "Claude Sonnet 4.6", input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
      "claude-haiku-5.5": { label: "Claude Haiku 5.5 (\u2264100k prompt)", input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 },
      "claude-haiku-4.5": { label: "Claude Haiku 4.5", input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 }
    };
    DEFAULT_MODEL = "claude-sonnet-5.5";
  }
});

// src/config.ts
var config_exports = {};
__export(config_exports, {
  DEFAULT_CONFIG: () => DEFAULT_CONFIG,
  dataDir: () => dataDir,
  readConfig: () => readConfig,
  toDollars: () => toDollars
});
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function dataDir() {
  const d = process.env.TOKEN_ECO_HOME ?? join(homedir(), ".token-eco");
  mkdirSync(d, { recursive: true });
  return d;
}
function readConfig() {
  const f = join(dataDir(), "config.json");
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return DEFAULT_CONFIG;
  }
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    const old = "tarifs" in c || "seuilLignes" in (c.hook ?? {}) || "pricing" in c;
    const hook = { ...DEFAULT_CONFIG.hook, ...c.hook };
    if (hook.seuilLignes != null) {
      hook.lineThreshold = hook.seuilLignes;
      delete hook.seuilLignes;
    }
    const cfg = {
      model: typeof c.model === "string" && PRICES[c.model] ? c.model : DEFAULT_MODEL,
      laterTurns: Number.isFinite(c.laterTurns) ? c.laterTurns : DEFAULT_CONFIG.laterTurns,
      port: Number.isFinite(c.port) ? c.port : DEFAULT_CONFIG.port,
      hook
    };
    if (old) writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}
function toDollars(tokens, config = readConfig(), model = config.model) {
  return tokens / 1e6 * savedTokenRate(model, config.laterTurns);
}
var DEFAULT_CONFIG;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_pricing();
    DEFAULT_CONFIG = {
      model: DEFAULT_MODEL,
      laterTurns: 10,
      port: 4777,
      hook: { mode: "redirect", lineThreshold: 300 }
    };
  }
});

// src/db.ts
var db_exports = {};
__export(db_exports, {
  aggregate: () => aggregate,
  aggregateScope: () => aggregateScope,
  byDay: () => byDay,
  byDayAndKey: () => byDayAndKey,
  byKey: () => byKey,
  closeDb: () => closeDb,
  openDb: () => openDb,
  projects: () => projects,
  recent: () => recent,
  record: () => record,
  recordRedirect: () => recordRedirect,
  redirectStats: () => redirectStats
});
import { DatabaseSync } from "node:sqlite";
import { join as join2 } from "node:path";
function migrate(d) {
  const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (has("appels")) {
    d.exec("ALTER TABLE appels RENAME TO calls");
    const ren = [
      ["projet", "project"],
      ["outil", "tool"],
      ["tokens_renvoyes", "returned_tokens"],
      ["tokens_natif_estimes", "native_tokens_est"],
      ["duree_ms", "duration_ms"]
    ];
    for (const [a, b] of ren) if (cols("calls").includes(a)) d.exec(`ALTER TABLE calls RENAME COLUMN ${a} TO ${b}`);
    const keys = [
      ["fichier", "file"],
      ["fichiers", "files"],
      ["motif", "pattern"],
      ["nom", "name"],
      ["debut", "start"],
      ["fin", "end"],
      ["langage", "language"],
      ["resultats", "results"],
      ["cibles", "targets"],
      ["lues", "readCount"],
      ["lignes", "lines"],
      ["compte", "count"],
      ["famille", "family"],
      ["commande", "command"]
    ];
    for (const [a, b] of keys) d.exec(`UPDATE calls SET details = replace(details, '"${a}":', '"${b}":') WHERE details LIKE '%"${a}":%'`);
    d.exec(`UPDATE calls SET details = replace(replace(replace(details, '"mode":"lignes"', '"mode":"lines"'),
      '"mode":"fichiers"', '"mode":"files"'), '"mode":"compte"', '"mode":"count"') WHERE details LIKE '%"mode":%'`);
  }
  if (has("redirections") && cols("redirections").includes("issue")) {
    for (const [a, b] of [["outil", "tool"], ["cible", "target"], ["issue", "outcome"]]) {
      d.exec(`ALTER TABLE redirections RENAME COLUMN ${a} TO ${b}`);
    }
    d.exec("UPDATE redirections SET outcome = CASE outcome WHEN 'refus' THEN 'refused' WHEN 'repli' THEN 'fallback' ELSE outcome END");
  }
}
function openDb(filePath = join2(dataDir(), "eco.db")) {
  if (db) return db;
  db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  migrate(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      project TEXT NOT NULL,
      tool TEXT NOT NULL,
      returned_tokens INTEGER NOT NULL,
      native_tokens_est INTEGER NOT NULL,
      duration_ms INTEGER,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ts ON calls(ts);
    -- PreToolUse hook: native calls refused (redirected) or let through on the second attempt.
    CREATE TABLE IF NOT EXISTS redirections (
      id INTEGER PRIMARY KEY, ts TEXT NOT NULL, session TEXT, tool TEXT NOT NULL,
      target TEXT, outcome TEXT NOT NULL -- 'refused' | 'fallback'
    );
    -- Older tool names (v0.1 French, v0.2 split tools) folded into the v0.3+ tools: continuous history.
    UPDATE calls SET tool = CASE tool
      WHEN 'apercu' THEN 'read' WHEN 'lire_symbole' THEN 'read' WHEN 'lire_plage' THEN 'read'
      WHEN 'outline' THEN 'read' WHEN 'read_symbol' THEN 'read' WHEN 'read_range' THEN 'read'
      WHEN 'chercher_compact' THEN 'search' WHEN 'search_compact' THEN 'search'
      WHEN 'editer_groupe' THEN 'edit' WHEN 'batch_edit' THEN 'edit' ELSE tool END
    WHERE tool IN ('apercu', 'lire_symbole', 'lire_plage', 'outline', 'read_symbol', 'read_range',
                   'chercher_compact', 'search_compact', 'editer_groupe', 'batch_edit');
  `);
  return db;
}
function closeDb() {
  db?.close();
  db = null;
}
function record(a, when = /* @__PURE__ */ new Date()) {
  openDb().prepare(`INSERT INTO calls (ts, project, tool, returned_tokens, native_tokens_est, duration_ms, details)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    when.toISOString(),
    a.project,
    a.tool,
    a.returnedTokens,
    a.nativeTokens,
    a.durationMs ?? null,
    a.details ? JSON.stringify(a.details) : null
  );
}
function recordRedirect(session, tool, target, outcome) {
  openDb().prepare(`INSERT INTO redirections (ts, session, tool, target, outcome) VALUES (?, ?, ?, ?, ?)`).run((/* @__PURE__ */ new Date()).toISOString(), session, tool, target, outcome);
}
function where(s = {}, extra = "1 = 1") {
  const parts = [extra], params = [];
  if (s.project) {
    parts.push("project = ?");
    params.push(s.project);
  }
  if (s.days) {
    parts.push("date(ts, 'localtime') >= date('now', 'localtime', ?)");
    params.push(`-${s.days - 1} days`);
  }
  return [parts.join(" AND "), params];
}
function redirectStats(period) {
  return openDb().prepare(`SELECT COALESCE(SUM(outcome = 'refused'), 0) AS refused, COALESCE(SUM(outcome = 'fallback'), 0) AS fallbacks
    FROM redirections WHERE ${PERIODS[period]}`).get();
}
function aggregate(period, project) {
  const [w, p] = where({ project }, PERIODS[period]);
  return openDb().prepare(`SELECT ${SUMS} FROM calls WHERE ${w}`).get(...p);
}
function aggregateScope(s) {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT ${SUMS} FROM calls WHERE ${w}`).get(...p);
}
function byDay(days = 30, project) {
  const [w, p] = where({ project, days });
  return openDb().prepare(`SELECT date(ts, 'localtime') AS day, ${SUMS} FROM calls WHERE ${w} GROUP BY day ORDER BY day`).all(...p);
}
function byDayAndKey(key, s) {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT date(ts, 'localtime') AS day, ${key} AS key,
      COALESCE(SUM(native_tokens_est - returned_tokens), 0) AS saved, COUNT(*) AS calls
    FROM calls WHERE ${w} GROUP BY day, key ORDER BY day`).all(...p);
}
function byKey(key, s = {}) {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT ${key} AS key, ${SUMS} FROM calls WHERE ${w} GROUP BY ${key} ORDER BY saved DESC`).all(...p);
}
function projects() {
  return openDb().prepare(`SELECT project AS key, ${SUMS}, MIN(ts) AS first, MAX(ts) AS last,
      (SELECT tool FROM calls c2 WHERE c2.project = calls.project GROUP BY tool ORDER BY COUNT(*) DESC LIMIT 1) AS topTool
    FROM calls GROUP BY project ORDER BY last DESC`).all();
}
function recent(n = 20, s = {}) {
  const [w, p] = where(s);
  return openDb().prepare(`
    SELECT ts, project, tool, returned_tokens AS returned, native_tokens_est AS native, duration_ms, details
    FROM calls WHERE ${w} ORDER BY id DESC LIMIT ?`).all(...p, n);
}
var db, SUMS, PERIODS;
var init_db = __esm({
  "src/db.ts"() {
    "use strict";
    init_config();
    db = null;
    SUMS = `COUNT(*) AS calls,
  COALESCE(SUM(returned_tokens), 0) AS returned,
  COALESCE(SUM(native_tokens_est), 0) AS native,
  COALESCE(SUM(native_tokens_est - returned_tokens), 0) AS saved`;
    PERIODS = {
      day: "date(ts, 'localtime') = date('now', 'localtime')",
      week: "date(ts, 'localtime') >= date('now', 'localtime', '-6 days')",
      total: "1 = 1"
    };
  }
});

// src/cli.ts
init_config();
import { spawn } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/stats.ts
init_db();
init_config();
init_pricing();

// src/tokens.ts
var CHARS_PER_TOKEN = 4;

// src/stats.ts
function formatTokens(n) {
  const a = Math.abs(n);
  if (a < 1e3) return String(Math.round(n));
  if (a < 1e6) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+(n / 1e6).toFixed(2)}M`;
}
function formatUsd(d) {
  if (d > 0 && d < 0.01) return "<$0.01";
  return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function statistics(q = {}) {
  const cfg = readConfig();
  const model = q.model && PRICES[q.model] ? q.model : cfg.model;
  const $ = (a) => ({ ...a, dollars: toDollars(a.saved, cfg, model) });
  const scope = { project: q.project || void 0, days: q.days ?? null };
  return {
    estimate: `Estimates: 1 token \u2248 ${CHARS_PER_TOKEN} characters; "native" = assumed size of the equivalent built-in tool's output.`,
    pricing: {
      model,
      label: PRICES[model].label,
      laterTurns: cfg.laterTurns,
      rate: savedTokenRate(model, cfg.laterTurns),
      checked: PRICES_CHECKED,
      source: PRICES_SOURCE,
      formula: `saved tokens \xD7 (5-min cache write + ${cfg.laterTurns} later turns \xD7 cache read) per MTok`,
      models: Object.entries(PRICES).map(([key, p]) => ({ key, ...p }))
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
    redirections: { day: redirectStats("day"), week: redirectStats("week"), total: redirectStats("total") }
  };
}
var pct = (a) => a.native ? Math.round(a.saved / a.native * 100) : 0;
function summaryText() {
  const s = statistics();
  const line = (name, a) => `${name.padEnd(9)} ${formatTokens(a.saved).padStart(8)} tokens  ${formatUsd(a.dollars).padStart(9)}  (\u2212${pct(a)}%, ${a.calls} call${a.calls === 1 ? "" : "s"})`;
  return [
    "token-eco \u2014 ESTIMATED savings",
    line("Today", s.today),
    line("7 days", s.week),
    line("Total", s.total),
    "",
    "By tool:",
    ...s.byTool.map((o) => `  ${o.key.padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  (\u2212${pct(o)}%, ${o.calls} call${o.calls === 1 ? "" : "s"})`),
    "",
    "By project:",
    ...s.byProject.slice(0, 8).map((o) => `  ${(o.key.split(/[\\/]/).filter(Boolean).pop() ?? o.key).padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  ${formatUsd(o.dollars).padStart(9)}`),
    "",
    (({ refused, fallbacks }) => `Hook (total): ${refused} built-in Read/Grep redirected, ${fallbacks} allowed on retry`)(s.redirections.total),
    "",
    `Pricing: ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok saved (${s.pricing.formula}; prices checked ${s.pricing.checked}).`,
    `Change "model" / "laterTurns" in ~/.token-eco/config.json.`,
    s.estimate
  ].join("\n");
}

// src/web.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
var HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));
var HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store"
};
function startServer(port2) {
  const allowedHosts = /* @__PURE__ */ new Set([`127.0.0.1:${port2}`, `localhost:${port2}`]);
  const httpServer = createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const page = await readFile(HTML);
        res.writeHead(200, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" }).end(page);
      } else if (req.method === "GET" && url.pathname === "/api/stats") {
        const days = Number(url.searchParams.get("days"));
        const body = statistics({
          project: url.searchParams.get("project") ?? void 0,
          days: Number.isInteger(days) && days > 0 && days <= 3650 ? days : null,
          model: url.searchParams.get("model") ?? void 0
        });
        res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(body));
      } else if (req.method === "GET" && url.pathname === "/api/ping") {
        res.writeHead(200, HEADERS).end("token-eco");
      } else if (req.method === "POST" && url.pathname === "/api/stop") {
        res.writeHead(200, HEADERS).end("stopping");
        httpServer.close();
        setTimeout(() => process.exit(0), 100).unref();
      } else {
        res.writeHead(404, HEADERS).end();
      }
    } catch (e) {
      res.writeHead(500, HEADERS).end(e.message);
    }
  });
  return new Promise((ok, ko) => {
    httpServer.once("error", ko);
    httpServer.listen(port2, "127.0.0.1", () => ok(httpServer));
  });
}

// src/cli.ts
var [cmd = "stats", ...opts] = process.argv.slice(2);
var port = readConfig().port;
var base = `http://127.0.0.1:${port}`;
async function running() {
  try {
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(500) });
    return await r.text() === "token-eco";
  } catch {
    return false;
  }
}
function openBrowser(url) {
  const [prog, ...args] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(prog, args, { detached: true, stdio: "ignore" }).on("error", () => {
  }).unref();
}
switch (cmd) {
  case "stats":
    console.log(summaryText());
    break;
  case "statusline": {
    const { aggregate: aggregate2 } = await Promise.resolve().then(() => (init_db(), db_exports));
    const { toDollars: toDollars2 } = await Promise.resolve().then(() => (init_config(), config_exports));
    const d = aggregate2("day"), t = aggregate2("total");
    console.log(`token-eco \u2193 today ${formatTokens(d.saved)} tok (${formatUsd(toDollars2(d.saved))}) \xB7 total ${formatTokens(t.saved)} tok (${formatUsd(toDollars2(t.saved))})`);
    break;
  }
  case "serve":
    await startServer(port);
    console.log(`token-eco: dashboard on ${base}`);
    break;
  case "dashboard": {
    if (!await running()) {
      spawn(process.execPath, [fileURLToPath2(import.meta.url), "serve"], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < 30 && !await running(); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!await running()) {
      console.error(`Could not start the server on port ${port} (already in use? change "port" in ~/.token-eco/config.json).`);
      process.exit(1);
    }
    if (!opts.includes("--no-open")) openBrowser(base);
    console.log(`token-eco dashboard: ${base}  (stop: node cli.js stop)`);
    break;
  }
  case "stop":
    if (await running()) {
      await fetch(`${base}/api/stop`, { method: "POST" }).catch(() => {
      });
      console.log("Server stopped.");
    } else console.log("No server running.");
    break;
  default:
    console.error("Usage: cli.js <stats | statusline | dashboard [--no-open] | serve | stop>");
    process.exit(2);
}
