import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { dataDir } from "./config.ts";
import { projectRoot } from "./project.ts";

export interface Call {
  project: string;
  tool: string;
  returnedTokens: number;
  nativeTokens: number;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface Aggregate {
  calls: number;
  returned: number;
  native: number;
  saved: number;
}

/** Optional scope of a query: one project and/or the last N days (null = all time). */
export interface Scope { project?: string; days?: number | null }

let db: DatabaseSync | null = null;

/** Pre-0.4 databases used French table/column names and values: rename them in place, no data loss. */
function migrate(d: DatabaseSync): void {
  const has = (t: string) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const cols = (t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (has("appels")) {
    d.exec("ALTER TABLE appels RENAME TO calls");
    const ren: [string, string][] = [["projet", "project"], ["outil", "tool"], ["tokens_renvoyes", "returned_tokens"],
      ["tokens_natif_estimes", "native_tokens_est"], ["duree_ms", "duration_ms"]];
    for (const [a, b] of ren) if (cols("calls").includes(a)) d.exec(`ALTER TABLE calls RENAME COLUMN ${a} TO ${b}`);
    const keys: [string, string][] = [["fichier", "file"], ["fichiers", "files"], ["motif", "pattern"], ["nom", "name"],
      ["debut", "start"], ["fin", "end"], ["langage", "language"], ["resultats", "results"], ["cibles", "targets"],
      ["lues", "readCount"], ["lignes", "lines"], ["compte", "count"], ["famille", "family"], ["commande", "command"]];
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

export function openDb(filePath: string = join(dataDir(), "eco.db")): DatabaseSync {
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

/** project = main git repo (sub-folders and worktrees grouped), workdir = exact folder of the call.
 *  Also fixes rows written by older versions (workdir NULL). */
function normalizeProjects(d: DatabaseSync): void {
  const cols = (d.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("workdir")) d.exec("ALTER TABLE calls ADD COLUMN workdir TEXT");
  const raw = d.prepare("SELECT DISTINCT project FROM calls WHERE workdir IS NULL").all() as { project: string }[];
  if (!raw.length) return;
  const upd = d.prepare("UPDATE calls SET workdir = project, project = ? WHERE workdir IS NULL AND project = ?");
  for (const { project } of raw) upd.run(projectRoot(project), project);
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function record(a: Call, when: Date = new Date()): void {
  openDb()
    .prepare(`INSERT INTO calls (ts, project, workdir, tool, returned_tokens, native_tokens_est, duration_ms, details)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(when.toISOString(), projectRoot(a.project), a.project, a.tool, a.returnedTokens, a.nativeTokens, a.durationMs ?? null,
      a.details ? JSON.stringify(a.details) : null);
}

export function recordRedirect(session: string, tool: string, target: string, outcome: "refused" | "fallback"): void {
  openDb().prepare(`INSERT INTO redirections (ts, session, tool, target, outcome) VALUES (?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), session, tool, target, outcome);
}

const SUMS = `COUNT(*) AS calls,
  COALESCE(SUM(returned_tokens), 0) AS returned,
  COALESCE(SUM(native_tokens_est), 0) AS native,
  COALESCE(SUM(native_tokens_est - returned_tokens), 0) AS saved`;

const PERIODS = {
  day: "date(ts, 'localtime') = date('now', 'localtime')",
  week: "date(ts, 'localtime') >= date('now', 'localtime', '-6 days')",
  total: "1 = 1",
} as const;

export type Period = keyof typeof PERIODS;

export interface ToolSums { tool: string; calls: number; returned: number; native: number; saved: number }

/** token-eco calls of one Claude Code session: same project, inside its time window (the calls table has
 *  no session id; concurrent sessions in the same project would share their calls). */
export function callsInWindow(project: string, from: string, to: string): ToolSums[] {
  return openDb().prepare(`SELECT tool, ${SUMS} FROM calls WHERE project = ? AND ts >= ? AND ts <= ? GROUP BY tool`)
    .all(project, from, to) as unknown as ToolSums[];
}

/** WHERE clause + parameters for a scope. */
function where(s: Scope = {}, extra = "1 = 1"): [string, (string | number)[]] {
  const parts = [extra], params: (string | number)[] = [];
  if (s.project) { parts.push("project = ?"); params.push(s.project); }
  if (s.days) { parts.push("date(ts, 'localtime') >= date('now', 'localtime', ?)"); params.push(`-${s.days - 1} days`); }
  return [parts.join(" AND "), params];
}

export function redirectStats(period: Period): { refused: number; fallbacks: number } {
  return openDb().prepare(`SELECT COALESCE(SUM(outcome = 'refused'), 0) AS refused, COALESCE(SUM(outcome = 'fallback'), 0) AS fallbacks
    FROM redirections WHERE ${PERIODS[period]}`).get() as unknown as { refused: number; fallbacks: number };
}

export function aggregate(period: Period, project?: string): Aggregate {
  const [w, p] = where({ project }, PERIODS[period]);
  return openDb().prepare(`SELECT ${SUMS} FROM calls WHERE ${w}`).get(...p) as unknown as Aggregate;
}

export function aggregateScope(s: Scope): Aggregate {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT ${SUMS} FROM calls WHERE ${w}`).get(...p) as unknown as Aggregate;
}

export function byDay(days = 30, project?: string): ({ day: string } & Aggregate)[] {
  const [w, p] = where({ project, days });
  return openDb().prepare(`SELECT date(ts, 'localtime') AS day, ${SUMS} FROM calls WHERE ${w} GROUP BY day ORDER BY day`)
    .all(...p) as never;
}

/** Saved tokens per day AND per key (stacked chart: per project, or per tool inside one project). */
export function byDayAndKey(key: "project" | "tool", s: Scope): { day: string; key: string; saved: number; calls: number }[] {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT date(ts, 'localtime') AS day, ${key} AS key,
      COALESCE(SUM(native_tokens_est - returned_tokens), 0) AS saved, COUNT(*) AS calls
    FROM calls WHERE ${w} GROUP BY day, key ORDER BY day`).all(...p) as never;
}

export function byKey(key: "tool" | "project", s: Scope = {}): ({ key: string } & Aggregate)[] {
  const [w, p] = where(s);
  return openDb().prepare(`SELECT ${key} AS key, ${SUMS} FROM calls WHERE ${w} GROUP BY ${key} ORDER BY saved DESC`)
    .all(...p) as never;
}

/** Every project with its totals, first/last activity and most used tool (most recent first). */
export function projects(): ({ key: string; first: string; last: string; topTool: string } & Aggregate)[] {
  return openDb().prepare(`SELECT project AS key, ${SUMS}, MIN(ts) AS first, MAX(ts) AS last,
      (SELECT tool FROM calls c2 WHERE c2.project = calls.project GROUP BY tool ORDER BY COUNT(*) DESC LIMIT 1) AS topTool
    FROM calls GROUP BY project ORDER BY last DESC`).all() as never;
}

export function recent(n = 20, s: Scope = {}): Record<string, unknown>[] {
  const [w, p] = where(s);
  return openDb().prepare(`
    SELECT ts, project, tool, returned_tokens AS returned, native_tokens_est AS native, duration_ms, details
    FROM calls WHERE ${w} ORDER BY id DESC LIMIT ?`).all(...p, n) as never;
}
