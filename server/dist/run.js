// src/run.ts
import { spawn } from "node:child_process";

// src/compact.ts
var ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
var IMPORTANT = /\b(error|errors|fail|failed|failure|failing|panic|exception|traceback|assert|fatal|warning|✗|✕|×)\b|^E\s|^FAIL\b|^\s*at\s.+:\d+/i;
var MAX_LINES = 150;
var HEAD_LINES = 40;
var QUEUE = 80;
var MAX_IMPORTANTES = 60;
var TESTS = /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|^(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test)\b|^(python3?\s+-m\s+)?pytest\b|^go\s+test\b|^cargo\s+(test|nextest)\b|^node\s+--test\b|^(bundle\s+exec\s+)?rspec\b|^dotnet\s+test\b|^mvn\b.*\btest\b|^gradlew?\b.*\btest\b|^mix\s+test\b|^phpunit\b|^(flutter|dart)\s+test\b/;
var INSTALL = /^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update)\b|^pip3?\s+install\b|^(uv\s+)?pip\s+install\b|^poetry\s+(install|add)\b|^cargo\s+(fetch|update)\b|^go\s+(mod|get)\b|^bundle(\s+install)?$|^composer\s+(install|update|require)\b|^brew\s+(install|upgrade)\b|^(flutter|dart)\s+pub\s+(get|upgrade|add)\b/;
var BUILD = /^(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|check)\b|^(npx\s+)?(tsc|eslint|biome|prettier\s+--check|ruff|mypy|pyright|next\s+build|vite\s+build|webpack)\b|^cargo\s+(build|check|clippy)\b|^go\s+(build|vet)\b|^make\b|^gradlew?\b|^mvn\b|^dotnet\s+build\b|^swift\s+build\b|^flutter\s+(analyze|build)\b|^dart\s+(analyze|compile)\b/;
var GIT = /^git\s+(status|log|diff|show|branch|fetch|pull|push|commit|add|checkout|switch|merge|rebase|stash)\b/;
function normalizeCommand(command2) {
  return command2.trim().replace(/^(?:\S*\/)?(?:\.?venv|env)\/bin\//, "").replace(/^(?:\S*\/)?node_modules\/\.bin\//, "").replace(/^(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+/, "").replace(/^python[\d.]*\s+-m\s+/, "");
}
function family(command2) {
  const c = normalizeCommand(command2);
  if (TESTS.test(c)) return "test";
  if (GIT.test(c)) return "git";
  if (INSTALL.test(c)) return "install";
  if (BUILD.test(c)) return "build";
  return "other";
}
function clean(raw) {
  const lines = raw.replace(ANSI, "").split("\n").map((l) => {
    const r = l.split("\r").filter((s) => s.trim());
    return (r[r.length - 1] ?? "").trimEnd();
  });
  const out = [];
  let reply = 0;
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (!l.trim() && (!prev || !prev.trim())) continue;
    if (prev !== void 0 && l === prev && l.trim()) {
      reply++;
      continue;
    }
    if (reply) {
      out[out.length - 1] += `  (\xD7${reply + 1})`;
      reply = 0;
    }
    out.push(l);
  }
  if (reply) out[out.length - 1] += `  (\xD7${reply + 1})`;
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}
function cutAt(lines, max = MAX_LINES) {
  if (lines.length <= max) return lines;
  const middle = lines.slice(HEAD_LINES, lines.length - QUEUE);
  const kept = middle.filter((l) => IMPORTANT.test(l)).slice(0, MAX_IMPORTANTES);
  const omittedCount = middle.length - kept.length;
  return [...lines.slice(0, HEAD_LINES), `[\u2026 ${omittedCount} lines omitted by token-eco; important lines kept \u2026]`, ...kept, ...lines.slice(-QUEUE)];
}
var GIT_NOISE = /^\s*\(use "git .*"\)\s*$|^\s*\(use "git .* to .*\)\s*$|^no changes added to commit|^\s*\(commit or discard the untracked or modified content in submodules\)/;
var INSTALL_NOISE = /^npm (warn|WARN) deprecated|^\s*(Downloading|Collecting|Using cached|Requirement already satisfied|Fetching|Resolving|Progress|Downloaded|Compiling|Checking|Installing collected packages)\b|^\s*[|/\\-]\s*$|^\s*\d+(\.\d+)?\s*(k|M)?B\s*\/\s*\d/;
var TEST_SUMMARY = /\b(tests?|passed|failed|failures?|errors?|skipped|pending|todo|suites?|ok|FAIL|PASS|duration|Ran \d+|examples?|assertions?)\b/i;
function compact(command2, raw, exitCode) {
  let lines = clean(raw);
  const f = family(command2);
  if (f === "git") lines = lines.filter((l) => !GIT_NOISE.test(l));
  if (f === "install") lines = lines.filter((l) => !INSTALL_NOISE.test(l) || IMPORTANT.test(l));
  if (f === "build") lines = lines.filter((l) => !/^\s*(Compiling|Checking|Downloaded|Fresh)\s/.test(l));
  if (f === "test" && exitCode === 0 && lines.length > 20) {
    const summary = lines.filter((l) => TEST_SUMMARY.test(l) && !/^\s*(✓|✔|√|ok\s+\d|PASS\s)/.test(l)).slice(-15);
    const okCount = lines.filter((l) => /^\s*(✓|✔|√|ok\s|PASS\s|test .* \.\.\. ok)/.test(l)).length;
    lines = [`[token-eco: tests passed \u2014 ${okCount} passing lines hidden]`, ...summary];
  }
  return cutAt(lines).join("\n");
}

// src/db.ts
import { DatabaseSync } from "node:sqlite";
import { join as join3 } from "node:path";

// src/config.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function dataDir() {
  const d = process.env.TOKEN_ECO_HOME ?? join(homedir(), ".token-eco");
  mkdirSync(d, { recursive: true });
  return d;
}

// src/project.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, isAbsolute, join as join2, resolve } from "node:path";
var cache = null;
var cacheFile = () => join2(dataDir(), "projects.json");
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

// src/db.ts
var db = null;
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

// src/tokens.ts
var CHARS_PER_TOKEN = 4;
function estimateTokens(input) {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// src/run.ts
var NATIVE_CAP = 3e4;
var MAX_CAPTURE = 2e7;
var command = process.argv[2] ?? "";
var t0 = Date.now();
var child = spawn(process.env.SHELL || "/bin/bash", ["-c", command], { stdio: ["inherit", "pipe", "pipe"] });
var chunks = [];
var size = 0;
var capture = (b) => {
  if (size < MAX_CAPTURE) {
    chunks.push(b);
    size += b.length;
  }
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);
child.on("error", (e) => {
  process.stderr.write(`token-eco run: ${e.message}
`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  const raw = Buffer.concat(chunks).toString("utf8");
  const output = code ?? (signal ? 128 : 1);
  let text = raw;
  try {
    text = compact(command, raw, output);
  } catch {
  }
  if (text.length >= raw.length) text = raw.replace(/\s+$/, "");
  process.stdout.write(text + (text ? "\n" : ""));
  try {
    record({
      project: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      tool: "bash",
      returnedTokens: estimateTokens(text),
      nativeTokens: estimateTokens(raw.slice(0, NATIVE_CAP)),
      durationMs: Date.now() - t0,
      details: { family: family(command), code: output, command: command.slice(0, 120) }
    });
  } catch {
  }
  process.exit(output);
});
