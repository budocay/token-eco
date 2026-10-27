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
  effectiveModel: () => effectiveModel,
  nodeBinary: () => nodeBinary,
  readConfig: () => readConfig,
  saveAutoModel: () => saveAutoModel,
  toDollars: () => toDollars,
  uiLang: () => uiLang
});
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function nodeBinary(execPath = process.execPath) {
  return execPath && existsSync(execPath) ? execPath : "node";
}
function dataDir() {
  const d = process.env.TOKEN_ECO_HOME ?? join(homedir(), ".token-eco");
  mkdirSync(d, { recursive: true });
  return d;
}
function uiLang(cfg = readConfig()) {
  if (cfg.lang === "en" || cfg.lang === "fr") return cfg.lang;
  return /^fr/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "") ? "fr" : "en";
}
function readConfig() {
  const f = join(dataDir(), "config.json");
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return DEFAULT_CONFIG;
  }
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    const old = "tarifs" in c || "seuilLignes" in (c.hook ?? {}) || "pricing" in c || !("excludeProjects" in c);
    const hook = { ...DEFAULT_CONFIG.hook, ...c.hook };
    if (!("excludeProjects" in c) && c.model === DEFAULT_MODEL) c.model = "auto";
    if (hook.seuilLignes != null) {
      hook.lineThreshold = hook.seuilLignes;
      delete hook.seuilLignes;
    }
    const cfg = {
      model: typeof c.model === "string" && (PRICES[c.model] || c.model === "auto") ? c.model : DEFAULT_CONFIG.model,
      excludeProjects: Array.isArray(c.excludeProjects) ? c.excludeProjects.filter((x) => typeof x === "string") : DEFAULT_CONFIG.excludeProjects,
      laterTurns: Number.isFinite(c.laterTurns) ? c.laterTurns : DEFAULT_CONFIG.laterTurns,
      port: Number.isFinite(c.port) ? c.port : DEFAULT_CONFIG.port,
      hook,
      lang: c.lang === "en" || c.lang === "fr" ? c.lang : "auto"
    };
    if (old) writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}
function effectiveModel(config = readConfig()) {
  if (config.model !== "auto") return config.model;
  try {
    const m = JSON.parse(readFileSync(AUTO_FILE(), "utf8")).model;
    if (PRICES[m]) return m;
  } catch {
  }
  return DEFAULT_MODEL;
}
function saveAutoModel(model) {
  if (PRICES[model]) writeFileSync(AUTO_FILE(), JSON.stringify({ model, at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n");
}
function toDollars(tokens, config = readConfig(), model = effectiveModel(config)) {
  return tokens / 1e6 * savedTokenRate(model, config.laterTurns);
}
var DEFAULT_CONFIG, AUTO_FILE;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_pricing();
    DEFAULT_CONFIG = {
      model: "auto",
      excludeProjects: ["/var/folders/", "/private/var/", "/tmp/", "/private/tmp/", "token-eco-trial"],
      laterTurns: 10,
      port: 4777,
      hook: { mode: "redirect", lineThreshold: 300 },
      lang: "auto"
    };
    AUTO_FILE = () => join(dataDir(), "auto-model.json");
  }
});

// src/project.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, isAbsolute, join as join2, resolve } from "node:path";
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync2(cacheFile(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}
function git(dir, ...args) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", ...args], { encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function compute(dir) {
  if (!existsSync2(dir)) return dir;
  const common = git(dir, "--git-common-dir");
  if (common) {
    const abs = isAbsolute(common) ? common : resolve(dir, common);
    if (basename(abs) === ".git") return dirname(abs);
  }
  return git(dir, "--show-toplevel") ?? dir;
}
function projectRoot(dir) {
  const d = resolve(dir);
  const c = load();
  if (c[d]) return c[d];
  const root = compute(d);
  if (existsSync2(d)) {
    c[d] = root;
    try {
      writeFileSync2(cacheFile(), JSON.stringify(c));
    } catch {
    }
  }
  return root;
}
var cache, cacheFile, shortName;
var init_project = __esm({
  "src/project.ts"() {
    "use strict";
    init_config();
    cache = null;
    cacheFile = () => join2(dataDir(), "projects.json");
    shortName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
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
  byWorkdir: () => byWorkdir,
  callsInWindow: () => callsInWindow,
  closeDb: () => closeDb,
  openDb: () => openDb,
  projects: () => projects,
  recent: () => recent,
  record: () => record,
  recordRedirect: () => recordRedirect,
  redirectStats: () => redirectStats
});
import { DatabaseSync } from "node:sqlite";
import { join as join3 } from "node:path";
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
function openDb(filePath = join3(dataDir(), "eco.db")) {
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
  normalizeProjects(db);
  return db;
}
function normalizeProjects(d) {
  const cols = d.prepare("PRAGMA table_info(calls)").all().map((c) => c.name);
  if (!cols.includes("workdir")) d.exec("ALTER TABLE calls ADD COLUMN workdir TEXT");
  const raw = d.prepare("SELECT DISTINCT project FROM calls WHERE workdir IS NULL").all();
  if (!raw.length) return;
  const upd = d.prepare("UPDATE calls SET workdir = project, project = ? WHERE workdir IS NULL AND project = ?");
  for (const { project } of raw) upd.run(projectRoot(project), project);
}
function closeDb() {
  db?.close();
  db = null;
}
function record(a, when = /* @__PURE__ */ new Date()) {
  openDb().prepare(`INSERT INTO calls (ts, project, workdir, tool, returned_tokens, native_tokens_est, duration_ms, details)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    when.toISOString(),
    projectRoot(a.project),
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
function callsInWindow(project, from, to) {
  return openDb().prepare(`SELECT tool, ${SUMS} FROM calls WHERE project = ? AND ts >= ? AND ts <= ? GROUP BY tool`).all(project, from, to);
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
function byWorkdir(s = {}) {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT COALESCE(workdir, project) AS key, ${SUMS} FROM calls WHERE ${w} GROUP BY key ORDER BY saved DESC`).all(...p);
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
    init_project();
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

// src/tokens.ts
function estimateTokens(input) {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}
var CHARS_PER_TOKEN;
var init_tokens = __esm({
  "src/tokens.ts"() {
    "use strict";
    CHARS_PER_TOKEN = 4;
  }
});

// src/sessions.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4, resolve as resolve2 } from "node:path";
function priceFor(model, forced) {
  return PRICES[forced ?? modelKey(model)];
}
function emptyTotals(id = "", project = "") {
  return {
    id,
    project,
    start: "",
    end: "",
    model: "",
    turns: 0,
    subagentTurns: 0,
    input: 0,
    write5m: 0,
    write1h: 0,
    cacheRead: 0,
    output: 0,
    tokens: 0,
    cost: 0,
    peakContext: 0,
    ecoCalls: 0,
    tools: {},
    unpriced: [],
    costSub: 0,
    costKind: { input: 0, write: 0, read: 0, output: 0 },
    levers: { over200k: 0, over300k: 0, rebuilds: 0, rebuildCost: 0, subByModel: {}, startMain: 0, startSubs: [] }
  };
}
function addLog(t, file, isSub, opts2 = {}) {
  const seenMsg = /* @__PURE__ */ new Set(), seenTool = /* @__PURE__ */ new Set();
  let prevReply = 0;
  for (const line of readFileSync3(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isSub && o.cwd && !t.project) t.project = o.cwd;
    if (!isSub && typeof o.agentSetting === "string") t.agent = o.agentSetting;
    if (o.timestamp) {
      if (!t.start || o.timestamp < t.start) t.start = o.timestamp;
      if (o.timestamp > t.end) t.end = o.timestamp;
    }
    const m = o.message;
    if (o.type !== "assistant" || !m) continue;
    for (const c2 of Array.isArray(m.content) ? m.content : []) {
      if (c2?.type === "tool_use" && !seenTool.has(c2.id)) {
        seenTool.add(c2.id);
        if (ECO_TOOL.test(c2.name)) t.ecoCalls++;
        const key = (isSub ? "sub:" : "") + String(c2.name).replace(ECO_TOOL, "eco:");
        t.tools[key] = (t.tools[key] ?? 0) + 1;
      }
    }
    const u = m.usage;
    if (!u || !m.id || seenMsg.has(m.id) || m.model === "<synthetic>") continue;
    seenMsg.add(m.id);
    let w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
    const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0;
    let read2 = u.cache_read_input_tokens ?? 0;
    if (opts2.cold && !isSub && seenMsg.size === 1) {
      w1h += read2;
      read2 = 0;
    }
    t.input += inp;
    t.write5m += w5m;
    t.write1h += w1h;
    t.cacheRead += read2;
    t.output += out;
    t.tokens += inp + w5m + w1h + read2 + out;
    const ctx = inp + w5m + w1h + read2, lv = t.levers, ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (seenMsg.size === 1) {
      if (isSub) lv.startSubs.push(ctx);
      else lv.startMain = ctx;
    }
    if (isSub) t.subagentTurns++;
    else {
      t.turns++;
      t.peakContext = Math.max(t.peakContext, ctx);
      t.model ||= m.model;
    }
    const gap = prevReply && ts ? ts - prevReply : 0;
    if (ts) prevReply = ts;
    const p = priceFor(m.model, opts2.model);
    if (!p) {
      if (!t.unpriced.includes(m.model)) t.unpriced.push(m.model);
      continue;
    }
    if (!isSub) {
      lv.over200k += Math.max(0, Math.min(read2, ctx - 2e5)) * p.cacheRead / 1e6;
      lv.over300k += Math.max(0, Math.min(read2, ctx - 3e5)) * p.cacheRead / 1e6;
    } else {
      const r = lv.subByModel[modelKey(m.model)] ??= { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
      r.input += inp;
      r.write5m += w5m;
      r.write1h += w1h;
      r.read += read2;
      r.output += out;
    }
    if (gap > REBUILD_GAP_MS && ctx > 5e4 && w5m + w1h > 0.6 * ctx) {
      lv.rebuilds++;
      lv.rebuildCost += (w5m * p.cacheWrite5m + w1h * 2 * p.input) / 1e6;
    }
    const k = {
      input: inp * p.input / 1e6,
      write: (w5m * p.cacheWrite5m + w1h * 2 * p.input) / 1e6,
      read: read2 * p.cacheRead / 1e6,
      output: out * p.output / 1e6
    };
    const c = k.input + k.write + k.read + k.output;
    t.cost += c;
    if (isSub) t.costSub += c;
    for (const key of ["input", "write", "read", "output"]) t.costKind[key] += k[key];
  }
}
function subagentLogs(mainLog) {
  const d = join4(mainLog.replace(/\.jsonl$/, ""), "subagents");
  return existsSync3(d) ? readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => join4(d, f)) : [];
}
function sessionTotals(mainLog, opts2 = {}) {
  const t = emptyTotals(mainLog.split(/[\\/]/).pop().replace(/\.jsonl$/, ""));
  addLog(t, mainLog, false, opts2);
  for (const f of subagentLogs(mainLog)) addLog(t, f, true, opts2);
  return t;
}
function listSessions(scope = {}, root = projectsDir()) {
  if (!existsSync3(root)) return [];
  const since = scope.days ? Date.now() - scope.days * 864e5 : 0;
  const dirs = readdirSync(root);
  const want = scope.project ? projectRoot(scope.project) : "";
  const out = [];
  for (const d of dirs) {
    const dir = join4(root, d);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join4(dir, f);
      const st = statSync(path);
      if (st.mtimeMs < since) continue;
      const key = `${st.mtimeMs}|${st.size}`;
      let hit = cache2.get(path);
      if (!hit || hit.key !== key) {
        const t = sessionTotals(path);
        if (t.project) {
          t.workdir = t.project;
          t.project = projectRoot(t.project);
        }
        hit = { key, t };
        cache2.set(path, hit);
      }
      if (hit.t.turns && (!want || hit.t.project === want)) out.push(hit.t);
    }
  }
  return out.sort((a, b) => b.end.localeCompare(a.end));
}
var REBUILD_GAP_MS, projectsDir, ECO_TOOL, modelKey, cache2;
var init_sessions = __esm({
  "src/sessions.ts"() {
    "use strict";
    init_pricing();
    init_project();
    REBUILD_GAP_MS = 5 * 6e4;
    projectsDir = () => join4(process.env.CLAUDE_CONFIG_DIR ?? join4(homedir2(), ".claude"), "projects");
    ECO_TOOL = /^mcp__plugin_token-eco_token-eco__/;
    modelKey = (model) => model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
    cache2 = /* @__PURE__ */ new Map();
  }
});

// src/insights.ts
var insights_exports = {};
__export(insights_exports, {
  agentShare: () => agentShare,
  breakdown: () => breakdown,
  claudeEnv: () => claudeEnv,
  compare: () => compare,
  diagnose: () => diagnose,
  dominantModel: () => dominantModel,
  insights: () => insights,
  isBench: () => isBench,
  levers: () => levers,
  median: () => median,
  sessionRow: () => sessionRow
});
import { readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
function sessionRow(s, cfg, calls = callsInWindow) {
  const count = (prefix, names) => names.reduce((a, k) => a + (s.tools[prefix + k] ?? 0), 0);
  const eco = calls(s.project, s.start, s.end);
  const key = modelKey(s.model);
  const rate = savedTokenRate(PRICES[key] ? key : "", cfg.laterTurns);
  const saved = eco.reduce((a, c) => a + c.saved, 0);
  const allTurns = s.turns + s.subagentTurns;
  return {
    id: s.id,
    project: s.project,
    name: shortName(s.project),
    agent: s.agent ?? "",
    model: key,
    start: s.start,
    end: s.end,
    turns: s.turns,
    subagentTurns: s.subagentTurns,
    cost: s.cost,
    costSub: s.costSub,
    costPerTurn: allTurns ? s.cost / allTurns : 0,
    tokensPerTurn: allTurns ? Math.round(s.tokens / allTurns) : 0,
    peakContext: s.peakContext,
    main: { eco: count("", ECO_FILE), native: count("", NATIVE_FILE) },
    sub: { eco: count("sub:", ECO_FILE), native: count("sub:", NATIVE_FILE) },
    bash: { total: (s.tools.Bash ?? 0) + (s.tools["sub:Bash"] ?? 0), compacted: eco.find((c) => c.tool === "bash")?.calls ?? 0 },
    avoidedTokens: saved,
    avoidedUsd: saved / 1e6 * rate
  };
}
function compare(rows) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const k = `${r.project}|${r.model}`;
    if (!groups.has(k)) groups.set(k, { project: r.name, model: r.model, with: [], without: [] });
    groups.get(k)[usesEco(r) ? "with" : "without"].push(r);
  }
  const stat = (l) => ({
    sessions: l.length,
    costPerTurn: median(l.map((r) => r.costPerTurn)),
    tokensPerTurn: median(l.map((r) => r.tokensPerTurn)),
    peakContext: median(l.map((r) => r.peakContext)),
    costPerSession: median(l.map((r) => r.cost))
  });
  const matched = [...groups.values()].filter((g) => g.with.length && g.without.length);
  const w = matched.flatMap((g) => g.with), o = matched.flatMap((g) => g.without);
  const all = { with: stat(w), without: stat(o) };
  const delta = all.without.costPerTurn ? all.with.costPerTurn / all.without.costPerTurn - 1 : null;
  const verdict = w.length < 3 || o.length < 3 ? `Not enough comparable sessions (${w.length} with / ${o.length} without, same project and model; 3 of each needed).` : `Cost per turn ${delta <= 0 ? "\u2212" : "+"}${Math.abs(Math.round(delta * 100))}% with token-eco (median, ${w.length} vs ${o.length} sessions). Tasks still differ: a trend, not a proof.`;
  return { verdict, delta, all, groups: matched.map((g) => ({ project: g.project, model: g.model, with: stat(g.with), without: stat(g.without) })) };
}
function breakdown(list) {
  const sum = (f) => list.reduce((a, s) => a + f(s), 0);
  const tools = {};
  for (const s of list) for (const [k, n] of Object.entries(s.tools)) tools[k] = (tools[k] ?? 0) + n;
  return {
    cost: sum((s) => s.cost),
    costSub: sum((s) => s.costSub),
    kinds: { input: sum((s) => s.costKind.input), write: sum((s) => s.costKind.write), read: sum((s) => s.costKind.read), output: sum((s) => s.costKind.output) },
    turns: sum((s) => s.turns),
    subagentTurns: sum((s) => s.subagentTurns),
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tool, calls]) => ({ tool, calls }))
  };
}
function dominantModel(list) {
  const by = {};
  for (const s of list) {
    const k = modelKey(s.model);
    if (PRICES[k]) by[k] = (by[k] ?? 0) + s.cost;
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0];
}
function claudeEnv(home = process.env.CLAUDE_CONFIG_DIR ?? join5(homedir3(), ".claude")) {
  let env = {};
  try {
    env = JSON.parse(readFileSync4(join5(home, "settings.json"), "utf8")).env ?? {};
  } catch {
  }
  const keys = [
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
    "CLAUDE_CODE_PROMPT_CACHE_TTL",
    "ENABLE_PROMPT_CACHING_1H"
  ];
  return Object.fromEntries(keys.map((k) => [k, process.env[k] ?? env[k]]).filter(([, v]) => v));
}
function levers(list, env = claudeEnv()) {
  const sum = (f) => list.reduce((a, s) => a + f(s), 0);
  const subModels = {};
  for (const s of list) for (const [k, r] of Object.entries(s.levers.subByModel)) {
    const cost = priceRaw(r, k), cheap = priceRaw(r, CHEAP_SUB);
    subModels[k] ??= { turnsCost: 0, cheaper: 0 };
    subModels[k].turnsCost += cost;
    subModels[k].cheaper += Math.max(0, cost - cheap);
  }
  const startSubs = list.flatMap((s) => s.levers.startSubs);
  return {
    env,
    compaction: {
      over200k: sum((s) => s.levers.over200k),
      over300k: sum((s) => s.levers.over300k),
      peakMedian: median(list.map((s) => s.peakContext)),
      setting: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null
    },
    rebuilds: {
      count: sum((s) => s.levers.rebuilds),
      cost: sum((s) => s.levers.rebuildCost),
      setting: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ?? env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? (env.ENABLE_PROMPT_CACHING_1H ? "1h" : null)
    },
    subagents: {
      byModel: Object.entries(subModels).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.turnsCost - a.turnsCost),
      cheaperModel: CHEAP_SUB,
      saving: Object.values(subModels).reduce((a, v) => a + v.cheaper, 0),
      setting: env.CLAUDE_CODE_SUBAGENT_MODEL ?? null
    },
    start: {
      main: median(list.map((s) => s.levers.startMain).filter(Boolean)),
      sub: median(startSubs),
      subagents: startSubs.length,
      // Every turn re-reads the starting context: what 10K fewer tokens would save (at each turn's cache-read price ≈ total).
      per10k: sum((s) => (s.turns + s.subagentTurns) * 1e4 * (PRICES[modelKey(s.model)]?.cacheRead ?? 0) / 1e6)
    }
  };
}
function insights(f = {}) {
  const cfg = readConfig();
  const days = f.days && f.days > 0 ? Math.min(f.days, 365) : 30;
  const scanned = listSessions({ project: f.project, days }).filter((s) => s.turns >= 2);
  const real = scanned.filter((s) => f.includeBench || !isBench(s.project, cfg));
  const auto = dominantModel(real);
  if (auto) try {
    saveAutoModel(auto);
  } catch {
  }
  const list = f.model ? real.filter((s) => modelKey(s.model) === f.model) : real;
  const rows = list.map((s) => sessionRow(s, cfg));
  const total = (pick) => rows.reduce((a, r) => ({ eco: a.eco + pick(r).eco, native: a.native + pick(r).native }), { eco: 0, native: 0 });
  const main = total((r) => r.main), sub = total((r) => r.sub);
  const bash = rows.reduce((a, r) => ({ total: a.total + r.bash.total, compacted: a.compacted + r.bash.compacted }), { total: 0, compacted: 0 });
  const avoidedUsd = rows.reduce((a, r) => a + r.avoidedUsd, 0), cost = rows.reduce((a, r) => a + r.cost, 0);
  return {
    filters: { project: f.project ?? "", model: f.model ?? "", days, includeBench: !!f.includeBench },
    excluded: scanned.length - real.length,
    excludePatterns: cfg.excludeProjects,
    autoModel: auto ?? null,
    projects: [...new Set(real.map((s) => s.project))].map((p) => ({ path: p, name: shortName(p) })),
    models: [...new Set(real.map((s) => modelKey(s.model)))],
    coverage: { main, sub, bash, mainPct: pct(main), subPct: pct(sub), bashPct: bash.total ? bash.compacted / bash.total : null },
    avoided: { tokens: rows.reduce((a, r) => a + r.avoidedTokens, 0), usd: avoidedUsd, shareOfCost: cost ? avoidedUsd / cost : 0 },
    breakdown: breakdown(list),
    levers: levers(list),
    compare: compare(rows),
    agents: agentShare(rows),
    diagnosis: diagnose(rows),
    sessions: rows.slice(0, 40)
  };
}
function agentShare(rows) {
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) m.set(r.agent, (m.get(r.agent) ?? 0) + 1);
  return [...m].map(([agent, sessions]) => ({ agent, sessions })).sort((a, b) => b.sessions - a.sessions);
}
function diagnose(rows) {
  const out = [];
  const recent2 = rows.slice(0, 10);
  const others = /* @__PURE__ */ new Map();
  for (const r of recent2) if (r.agent && !r.agent.startsWith("token-eco:")) others.set(r.agent, (others.get(r.agent) ?? 0) + 1);
  for (const [agent, sessions] of others) out.push({ code: "other-agent", agent, sessions, latest: recent2[0]?.agent === agent });
  const none = recent2.filter((r) => !r.agent).length;
  if (none) out.push({ code: "no-agent", sessions: none });
  const sub = recent2.reduce((a, r) => ({ eco: a.eco + r.sub.eco, native: a.native + r.sub.native }), { eco: 0, native: 0 });
  if (sub.native > 50 && sub.native > 4 * sub.eco) out.push({ code: "sub-native", ...sub });
  return out;
}
var ECO_FILE, NATIVE_FILE, isBench, pct, usesEco, CHEAP_SUB, priceRaw;
var init_insights = __esm({
  "src/insights.ts"() {
    "use strict";
    init_config();
    init_db();
    init_pricing();
    init_project();
    init_sessions();
    ECO_FILE = ["eco:read", "eco:search", "eco:edit"];
    NATIVE_FILE = ["Read", "Grep", "Glob", "Edit", "MultiEdit"];
    isBench = (project, cfg) => cfg.excludeProjects.some((p) => p && project.includes(p));
    pct = (c) => c.eco + c.native ? c.eco / (c.eco + c.native) : null;
    usesEco = (r) => r.main.eco + r.sub.eco + r.bash.compacted > 0;
    CHEAP_SUB = "claude-sonnet-5.5";
    priceRaw = (r, key) => {
      const p = PRICES[key];
      return p ? (r.input * p.input + r.write5m * p.cacheWrite5m + r.write1h * 2 * p.input + r.read * p.cacheRead + r.output * p.output) / 1e6 : 0;
    };
  }
});

// src/audit.ts
var audit_exports = {};
__export(audit_exports, {
  audit: () => audit,
  auditText: () => auditText
});
import { existsSync as existsSync4, readdirSync as readdirSync2, readFileSync as readFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname2, join as join6, resolve as resolve3 } from "node:path";
function claudeMd(file, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(file) || !existsSync4(file)) return 0;
  seen.add(file);
  const text = read(file);
  let n = estimateTokens(text);
  for (const m of text.matchAll(/^@(\S+)/gm)) {
    const p = m[1].startsWith("~/") ? join6(homedir4(), m[1].slice(2)) : resolve3(dirname2(file), m[1]);
    n += claudeMd(p, seen);
  }
  return n;
}
function components(root, source) {
  const out = [];
  const add = (kind, files) => {
    const byName = new Map(files.map((f) => [f.split(/[\\/]/).slice(-2, -1)[0] + (kind === "skills" ? "" : f), f]));
    const descs = [...byName.values()].map((f) => description(read(f))).filter(Boolean);
    if (descs.length) out.push({ source, kind, count: descs.length, tokens: estimateTokens(descs.join("\n")) });
  };
  const ls = (d) => {
    try {
      return readdirSync2(d);
    } catch {
      return [];
    }
  };
  const skills = [];
  const walk = (d, depth) => {
    if (existsSync4(join6(d, "SKILL.md"))) {
      skills.push(join6(d, "SKILL.md"));
      return;
    }
    if (depth < 4) {
      for (const s of ls(d)) if (s !== "node_modules" && !s.startsWith(".")) walk(join6(d, s), depth + 1);
    }
  };
  for (const s of ls(join6(root, "skills"))) walk(join6(root, "skills", s), 1);
  add("skills", skills);
  add("agents", ls(join6(root, "agents")).filter((f) => f.endsWith(".md")).map((f) => join6(root, "agents", f)));
  add("commands", ls(join6(root, "commands")).filter((f) => f.endsWith(".md")).map((f) => join6(root, "commands", f)));
  const hooks = read(join6(root, "hooks", "hooks.json"));
  if (/"SessionStart"/.test(hooks)) out.push({ source, kind: "SessionStart hook", count: 1, tokens: 0, note: "injects text at startup (size known at run time)" });
  const mcp = read(join6(root, ".mcp.json"));
  try {
    const n = Object.keys(JSON.parse(mcp).mcpServers ?? JSON.parse(mcp)).length;
    if (n) out.push({ source, kind: "MCP servers", count: n, tokens: 0, note: "tool schemas loaded (or deferred) at startup" });
  } catch {
  }
  return out;
}
function audit(cwd = process.cwd(), home = process.env.CLAUDE_CONFIG_DIR ?? join6(homedir4(), ".claude")) {
  const items = [];
  const user = claudeMd(join6(home, "CLAUDE.md"));
  if (user) items.push({ source: "~/.claude", kind: "CLAUDE.md", count: 1, tokens: user });
  for (const f of [join6(cwd, "CLAUDE.md"), join6(cwd, ".claude", "CLAUDE.md"), join6(cwd, "CLAUDE.local.md")]) {
    const n = claudeMd(f);
    if (n) items.push({ source: "project", kind: f.slice(cwd.length + 1), count: 1, tokens: n });
  }
  items.push(...components(home, "~/.claude"));
  let enabled = {};
  try {
    enabled = JSON.parse(read(join6(home, "settings.json"))).enabledPlugins ?? {};
  } catch {
  }
  let installed = {};
  try {
    installed = JSON.parse(read(join6(home, "plugins", "installed_plugins.json"))).plugins ?? {};
  } catch {
  }
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const entry = installed[id]?.find((x) => x.scope === "user") ?? installed[id]?.[0];
    if (entry && existsSync4(entry.installPath)) items.push(...components(entry.installPath, id.split("@")[0]));
  }
  return items.sort((a, b) => b.tokens - a.tokens);
}
function auditText(measured) {
  const items = audit();
  const total = items.reduce((a, i) => a + i.tokens, 0);
  return [
    "token-eco audit \u2014 what every session and subagent loads before your first message (re-read on every turn)",
    ...items.map((i) => `  ${i.source.padEnd(22)} ${`${i.count} ${i.kind}`.padEnd(26)} ${i.tokens ? `~${i.tokens} tok` : ""}${i.note ? `  (${i.note})` : ""}`),
    `  ${"".padEnd(22)} ${"listed total".padEnd(26)} ~${total} tok`,
    measured ? `Measured starting context (median): ${measured.main} tok main thread, ${measured.sub} tok per subagent \u2014 the rest is Claude Code's own prompt and tool schemas.` : "",
    "Disable plugins you do not use (claude plugin disable <name>) and keep CLAUDE.md short: each 10K tokens is re-read on every turn."
  ].filter(Boolean).join("\n");
}
var read, description;
var init_audit = __esm({
  "src/audit.ts"() {
    "use strict";
    init_tokens();
    read = (f) => {
      try {
        return readFileSync5(f, "utf8");
      } catch {
        return "";
      }
    };
    description = (md) => {
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
      const name = /^name:\s*(.*)$/m.exec(fm)?.[1] ?? "";
      const desc = /^description:\s*([\s\S]*?)(?=^\w[\w-]*:|$(?![\s\S]))/m.exec(fm)?.[1] ?? "";
      return `${name} ${desc}`.trim();
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
init_tokens();
init_insights();
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
  const model = q.model && PRICES[q.model] ? q.model : effectiveModel(cfg);
  const $ = (a) => ({ ...a, dollars: toDollars(a.saved, cfg, model) });
  const scope = { project: q.project || void 0, days: q.days ?? null };
  const keep = (p) => !!q.includeBench || !isBench(p.key, cfg);
  return {
    estimate: `Estimates: 1 token \u2248 ${CHARS_PER_TOKEN} characters; "native" = assumed size of the equivalent built-in tool's output.`,
    pricing: {
      model,
      label: PRICES[model].label + (cfg.model === "auto" && !q.model ? " (auto: your main model)" : ""),
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
    // Benchmark / temp folders (config excludeProjects) stay out of the project lists unless asked.
    byProject: byKey("project", scope).filter(keep).map($),
    projects: projects().filter(keep).map($),
    // Inside one project: its worktrees / sub-folders.
    byWorkdir: scope.project ? byWorkdir(scope).map($) : [],
    recent: recent(30, scope),
    redirections: { day: redirectStats("day"), week: redirectStats("week"), total: redirectStats("total") }
  };
}
var pct2 = (a) => a.native ? Math.round(a.saved / a.native * 100) : 0;
function summaryText(lang = uiLang()) {
  const fr = lang === "fr", L = (en, f) => fr ? f : en;
  const s = statistics();
  const calls = (n) => fr ? `${n} appel${n > 1 ? "s" : ""}` : `${n} call${n === 1 ? "" : "s"}`;
  const line = (name, a) => `${name.padEnd(12)} ${formatTokens(a.saved).padStart(8)} tokens  ${formatUsd(a.dollars).padStart(9)}  (\u2212${pct2(a)}%, ${calls(a.calls)})`;
  let real = [];
  try {
    const r = insights({ days: 30 });
    const p = (x) => x == null ? "\u2013" : x > 0 && x < 1e-3 ? "<0.1%" : `${+(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
    const c = r.coverage, b = r.breakdown, cmp = r.compare, nW = cmp.all.with.sessions, nO = cmp.all.without.sessions;
    const verdict = nW < 3 || nO < 3 ? L(
      `Not enough comparable sessions (${nW} with / ${nO} without, same project and model; 3 of each needed).`,
      `Pas assez de sessions comparables (${nW} avec / ${nO} sans, m\xEAme projet et m\xEAme mod\xE8le ; il en faut 3 de chaque).`
    ) : L(
      `Cost per turn ${cmp.delta <= 0 ? "\u2212" : "+"}${Math.abs(Math.round(cmp.delta * 100))}% with token-eco (median, ${nW} vs ${nO} sessions). Tasks still differ: a trend, not a proof.`,
      `Co\xFBt par tour ${cmp.delta <= 0 ? "\u2212" : "+"}${Math.abs(Math.round(cmp.delta * 100))}% avec token-eco (m\xE9diane, ${nW} vs ${nO} sessions). Les t\xE2ches diff\xE8rent : une tendance, pas une preuve.`
    );
    const notSet = L("not set", "non r\xE9gl\xE9");
    real = [
      L(
        `Real sessions, last 30 days (${r.sessions.length} session(s), ${r.excluded} benchmark/temp hidden), ${formatUsd(b.cost)}:`,
        `Sessions r\xE9elles, 30 derniers jours (${r.sessions.length} session(s), ${r.excluded} benchmark/temp masqu\xE9e(s)), ${formatUsd(b.cost)} :`
      ),
      L(
        `  Coverage   main thread ${p(c.mainPct)} (${c.main.eco} token-eco / ${c.main.native} built-in) \xB7 subagents ${p(c.subPct)} (${c.sub.eco} / ${c.sub.native})`,
        `  Couverture fil principal ${p(c.mainPct)} (${c.main.eco} token-eco / ${c.main.native} natifs) \xB7 sous-agents ${p(c.subPct)} (${c.sub.eco} / ${c.sub.native})`
      ),
      L(`  Bash       ${p(c.bashPct)} compacted (${c.bash.compacted} of ${c.bash.total})`, `  Bash       ${p(c.bashPct)} compact\xE9 (${c.bash.compacted} sur ${c.bash.total})`),
      L(
        `  Avoided    ${formatUsd(r.avoided.usd)} = ${p(r.avoided.shareOfCost)} of the bill (est., each session's own model)`,
        `  \xC9vit\xE9      ${formatUsd(r.avoided.usd)} = ${p(r.avoided.shareOfCost)} de la facture (est., mod\xE8le de chaque session)`
      ),
      L(
        `  Cost       subagents ${p(b.cost ? b.costSub / b.cost : null)} \xB7 cache reads ${p(b.cost ? b.kinds.read / b.cost : null)} \xB7 cache writes ${p(b.cost ? b.kinds.write / b.cost : null)} \xB7 output ${p(b.cost ? b.kinds.output / b.cost : null)}`,
        `  Co\xFBt       sous-agents ${p(b.cost ? b.costSub / b.cost : null)} \xB7 lectures cache ${p(b.cost ? b.kinds.read / b.cost : null)} \xB7 \xE9critures cache ${p(b.cost ? b.kinds.write / b.cost : null)} \xB7 sortie ${p(b.cost ? b.kinds.output / b.cost : null)}`
      ),
      `  ${L("Compare   ", "Comparaison")} ${verdict}`,
      ...r.diagnosis.map((x) => "  \u26A0 " + (x.code === "other-agent" ? L(
        `Another main agent is active: ${x.agent} (${x.sessions} of the last 10 sessions${x.latest ? ", including the latest" : ""}); disable that plugin to use token-eco:eco.`,
        `Un autre agent principal est actif : ${x.agent} (${x.sessions} des 10 derni\xE8res sessions${x.latest ? ", dont la derni\xE8re" : ""}) ; d\xE9sactive ce plugin pour utiliser token-eco:eco.`
      ) : x.code === "no-agent" ? L(`${x.sessions} of the last 10 sessions ran without a custom main agent.`, `${x.sessions} des 10 derni\xE8res sessions sans agent principal personnalis\xE9.`) : L(`Subagents mostly use built-in tools (${x.native} vs ${x.eco} token-eco).`, `Sous-agents surtout sur les outils natifs (${x.native} contre ${x.eco} token-eco).`))),
      L('Levers (measured; setting in ~/.claude/settings.json "env"):', 'Leviers (mesur\xE9s ; r\xE9glage dans ~/.claude/settings.json "env") :'),
      `  ${L("Context above 300K (main)    ", "Contexte au-del\xE0 de 300K     ")} ${formatUsd(r.levers.compaction.over300k).padStart(10)}  CLAUDE_CODE_AUTO_COMPACT_WINDOW = ${r.levers.compaction.setting ?? L("not set (try 300k)", "non r\xE9gl\xE9 (essayer 300k)")}`,
      `  ${L(`Subagents on ${r.levers.subagents.cheaperModel.replace("claude-", "")} would save`, `Sous-agents en ${r.levers.subagents.cheaperModel.replace("claude-", "")} : \xE9conomie`)} ${formatUsd(r.levers.subagents.saving).padStart(6)}  CLAUDE_CODE_SUBAGENT_MODEL = ${r.levers.subagents.setting ?? notSet}`,
      `  ${L(`Cache expired (${r.levers.rebuilds.count} rewrites)  `, `Cache expir\xE9 (${r.levers.rebuilds.count} r\xE9\xE9critures)`)} ${formatUsd(r.levers.rebuilds.cost).padStart(10)}  cache TTL = ${r.levers.rebuilds.setting ?? L("5m (try CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h)", "5m (essayer CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h)")}`,
      ""
    ];
  } catch {
  }
  const { refused, fallbacks } = s.redirections.total;
  return [
    ...real,
    L(
      "token-eco \u2014 ESTIMATED tokens avoided per call (vs the assumed built-in call; extra turns not counted)",
      "token-eco \u2014 tokens \xE9vit\xE9s par appel, ESTIM\xC9S (vs l'appel natif suppos\xE9 ; tours en plus non compt\xE9s)"
    ),
    line(L("Today", "Aujourd'hui"), s.today),
    line(L("7 days", "7 jours"), s.week),
    line("Total", s.total),
    "",
    L("By tool:", "Par outil :"),
    ...s.byTool.map((o) => `  ${o.key.padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  (\u2212${pct2(o)}%, ${calls(o.calls)})`),
    "",
    L("By project:", "Par projet :"),
    ...s.byProject.slice(0, 8).map((o) => `  ${(o.key.split(/[\\/]/).filter(Boolean).pop() ?? o.key).padEnd(16)} ${formatTokens(o.saved).padStart(8)} tokens  ${formatUsd(o.dollars).padStart(9)}`),
    "",
    L(
      `Hook (total): ${refused} built-in Read/Grep redirected, ${fallbacks} allowed on retry`,
      `Hook (total) : ${refused} Read/Grep natifs redirig\xE9s, ${fallbacks} autoris\xE9s \xE0 la relance`
    ),
    "",
    L(
      `Pricing: ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok avoided (${s.pricing.formula}; prices checked ${s.pricing.checked}).`,
      `Tarifs : ${s.pricing.label}, $${s.pricing.rate.toFixed(2)}/MTok \xE9vit\xE9 (tokens \xE9conomis\xE9s \xD7 (\xE9criture cache 5 min + ${s.pricing.laterTurns} tours suivants \xD7 lecture cache) par MTok ; prix v\xE9rifi\xE9s le ${s.pricing.checked}).`
    ),
    L(`Change "model" / "laterTurns" / "lang" in ~/.token-eco/config.json.`, `Modifier "model" / "laterTurns" / "lang" dans ~/.token-eco/config.json.`),
    L(s.estimate, `Estimations : 1 token \u2248 ${CHARS_PER_TOKEN} caract\xE8res ; \xAB natif \xBB = taille suppos\xE9e de la sortie de l'outil int\xE9gr\xE9 \xE9quivalent.`)
  ].join("\n");
}

// src/web.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
init_insights();
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
          model: url.searchParams.get("model") ?? void 0,
          includeBench: url.searchParams.get("bench") === "1"
        });
        res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(body));
      } else if (req.method === "GET" && url.pathname === "/api/sessions") {
        const days = Number(url.searchParams.get("days"));
        const body = insights({
          project: url.searchParams.get("project") || void 0,
          model: url.searchParams.get("model") || void 0,
          days: Number.isInteger(days) && days > 0 ? days : 90,
          includeBench: url.searchParams.get("bench") === "1"
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
  case "audit": {
    const { auditText: auditText2 } = await Promise.resolve().then(() => (init_audit(), audit_exports));
    const { insights: insights2 } = await Promise.resolve().then(() => (init_insights(), insights_exports));
    let measured;
    try {
      const s = insights2({ days: 30 }).levers.start;
      measured = { main: s.main, sub: s.sub };
    } catch {
    }
    console.log(auditText2(measured));
    break;
  }
  case "statusline": {
    const { aggregate: aggregate2 } = await Promise.resolve().then(() => (init_db(), db_exports));
    const { toDollars: toDollars2, uiLang: uiLang2 } = await Promise.resolve().then(() => (init_config(), config_exports));
    const d = aggregate2("day"), t = aggregate2("total");
    const today = uiLang2() === "fr" ? "aujourd'hui" : "today";
    console.log(`token-eco \u2193 ${today} ${formatTokens(d.saved)} tok (${formatUsd(toDollars2(d.saved))}) \xB7 total ${formatTokens(t.saved)} tok (${formatUsd(toDollars2(t.saved))})`);
    break;
  }
  case "serve":
    await startServer(port);
    console.log(`token-eco: dashboard on ${base}`);
    break;
  case "dashboard": {
    if (!await running()) {
      spawn(nodeBinary(), [fileURLToPath2(import.meta.url), "serve"], { detached: true, stdio: "ignore" }).unref();
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
