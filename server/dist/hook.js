// src/hook.ts
import { readFileSync as readFileSync2, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, extname as extname2, isAbsolute, join as join3 } from "node:path";

// src/config.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/pricing.ts
var PRICES = {
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
var DEFAULT_MODEL = "claude-sonnet-5.5";

// src/config.ts
function dataDir() {
  const d = process.env.TOKEN_ECO_HOME ?? join(homedir(), ".token-eco");
  mkdirSync(d, { recursive: true });
  return d;
}
var DEFAULT_CONFIG = {
  model: "auto",
  excludeProjects: ["/var/folders/", "/private/var/", "/tmp/", "/private/tmp/", "token-eco-trial"],
  laterTurns: 10,
  port: 4777,
  hook: { mode: "redirect", lineThreshold: 300 }
};
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
      hook
    };
    if (old) writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}

// src/db.ts
import { DatabaseSync } from "node:sqlite";
import { join as join2 } from "node:path";
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

// src/compact.ts
var TESTS = /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|^(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test)\b|^(python3?\s+-m\s+)?pytest\b|^go\s+test\b|^cargo\s+(test|nextest)\b|^node\s+--test\b|^(bundle\s+exec\s+)?rspec\b|^dotnet\s+test\b|^mvn\b.*\btest\b|^gradlew?\b.*\btest\b|^mix\s+test\b|^phpunit\b/;
var INSTALL = /^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update)\b|^pip3?\s+install\b|^(uv\s+)?pip\s+install\b|^poetry\s+(install|add)\b|^cargo\s+(fetch|update)\b|^go\s+(mod|get)\b|^bundle(\s+install)?$|^composer\s+(install|update|require)\b|^brew\s+(install|upgrade)\b/;
var BUILD = /^(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|check)\b|^(npx\s+)?(tsc|eslint|biome|prettier\s+--check|ruff|mypy|pyright|next\s+build|vite\s+build|webpack)\b|^cargo\s+(build|check|clippy)\b|^go\s+(build|vet)\b|^make\b|^gradlew?\b|^mvn\b|^dotnet\s+build\b|^swift\s+build\b/;
var GIT = /^git\s+(status|log|diff|show|branch|fetch|pull|push|commit|add|checkout|switch|merge|rebase|stash)\b/;
function normalizeCommand(command) {
  return command.trim().replace(/^(?:\S*\/)?(?:\.?venv|env)\/bin\//, "").replace(/^(?:\S*\/)?node_modules\/\.bin\//, "").replace(/^(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+/, "").replace(/^python[\d.]*\s+-m\s+/, "");
}
function family(command) {
  const c = normalizeCommand(command);
  if (TESTS.test(c)) return "test";
  if (GIT.test(c)) return "git";
  if (INSTALL.test(c)) return "install";
  if (BUILD.test(c)) return "build";
  return "other";
}

// src/tools/outline.ts
import { readFile } from "node:fs/promises";

// src/types.ts
import { resolve } from "node:path";
function absolutePath(file, cwd = process.cwd()) {
  return resolve(cwd, file);
}
function splitLines(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function nativeReadChars(lines) {
  let total = 0;
  const n = Math.min(lines.length, 2e3);
  for (let i = 0; i < n; i++) total += Math.min(lines[i].length, 2e3) + String(i + 1).length + 2;
  return total;
}
function truncate(line, max = 200) {
  return line.length > max ? line.slice(0, max) + `\u2026 [+${line.length - max} chars]` : line;
}

// src/languages/engine.ts
import { basename, extname } from "node:path";

// src/languages/profiles.ts
var TOK = "(?:<[^<>;()]*(?:<[^<>;()]*>[^<>;()]*)*>|[\\w~*&][\\w:<>,*&\\[\\]~?.]*)";
var C_NAME = "[*&]*(?<name>~?[A-Za-z_][\\w:~]*)\\s*";
var C_FUNC = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;]*$`);
var CPROTO = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;{}]*\\)\\s*(?:const|override|final|noexcept|=\\s*0|=\\s*default|=\\s*delete|throws\\s+[\\w.,\\s]+|default\\s+[^;]+|\\s)*;\\s*$`);
var C_ONE_LINE = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;{]*\\)[^;{=]*(?:\\{.*\\}\\s*;?|=>.*;)\\s*$`);
var C_BC = [["/*", "*/"]];
var ATTRIBUTES = "(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*";
var JS_EXTRA = [
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace|module)\s/,
  /^(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)\s*(:[^=]+)?=>|[\w$]+\s*=>|\(\s*$|\([^)]*,\s*$)/,
  /^(export\s+)?(const|let|var)\s+[\w$]+\s*=\s*(async\s+)?function/,
  /^\s+((public|private|protected|static|async|readonly|get|set|override|abstract)\s+)*\*?\s*(?<name>#?[\w$]+)\s*(<[^>]*>)?\s*\(.*\)\s*(:\s*[^{]+)?\{\s*$/,
  /^\s+((public|private|protected|static|async|readonly|get|set|override|abstract)\s+)+\*?\s*(?<name>#?[\w$]+)\s*(<[^>]*>)?\s*\((?!.*;\s*$)/,
  /^\s*export\s+(\{|\*|default\s|const\s|let\s|var\s)/
];
var JS = {
  id: "javascript",
  ext: [".js", ".jsx", ".mjs", ".cjs"],
  shebang: /\b(node|deno|bun)\b/,
  extra: JS_EXTRA,
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*import\s/
};
var TS = { ...JS, id: "typescript", ext: [".ts", ".tsx", ".mts", ".cts"], shebang: void 0 };
var WEBCOMP = {
  ...JS,
  id: "composant-web",
  ext: [".vue", ".svelte", ".astro"],
  shebang: void 0,
  block: "auto",
  extra: [...JS_EXTRA, /^<(template|script|style)\b/],
  bc: [...C_BC, ["<!--", "-->"]]
};
var PY = {
  id: "python",
  ext: [".py", ".pyi", ".pyw"],
  shebang: /python/,
  kws: "def|class",
  mods: "async",
  extra: [/^[A-Z_][A-Z0-9_]*\s*(:[^=]+)?=/],
  block: "indentation",
  lc: ["#"],
  bc: [['"""', '"""'], ["'''", "'''"]],
  imports: /^\s*(import\s|from\s+\S+\s+import\s)/
};
var C = {
  id: "c",
  ext: [".c", ".h"],
  kws: "struct|union|enum|typedef|#\\s*define",
  mods: "static|extern|inline|const|volatile",
  extra: [C_FUNC, CPROTO, C_ONE_LINE, /^(?<name>[A-Za-z_]\w*)\s*\([^;]*$/],
  // 3rd form: GNU style (name alone in column 0)
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*#\s*include\b/
};
var CPP = {
  ...C,
  id: "cpp",
  ext: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".cu", ".inl"],
  // `template <…>` alone on its line = prefix of the next declaration (see engine).
  prefix: "(?:[A-Z][A-Z0-9_]{2,}(?:\\([^)]*\\))?\\s+)*",
  // macros d'export : FMT_EXPORT, DLLEXPORT…
  kws: "class|struct|union|enum(?:\\s+class)?|namespace|typedef|using\\s+\\w+\\s*=|concept|#\\s*define",
  mods: "template\\s*<[^>]*>|export|inline|static|constexpr|consteval|extern|virtual|explicit|friend"
};
var JAVA_MODS = "public|private|protected|static|final|abstract|sealed|non-sealed|strictfp|synchronized|native|default";
var JAVA = {
  id: "java",
  ext: [".java"],
  kws: "class|interface|enum|record|@interface|package",
  mods: JAVA_MODS,
  extra: [C_FUNC, CPROTO],
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*import\s/
};
var CSHARP = {
  id: "csharp",
  ext: [".cs", ".csx"],
  kws: "class|struct|interface|enum|record|namespace|delegate|event",
  mods: "public|private|protected|internal|static|abstract|sealed|partial|async|override|virtual|readonly|unsafe|extern|new|file|required",
  extra: [
    C_FUNC,
    CPROTO,
    C_ONE_LINE,
    /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|required)\s+)+[\w<>\[\],?.]+\s+(?<name>\w+)\s*(?:\{|=>)/
  ],
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*(?:global\s+)?using\s+(?:static\s+)?[\w.]+\s*;/
};
var KOTLIN = {
  id: "kotlin",
  ext: [".kt", ".kts"],
  prefix: ATTRIBUTES,
  kws: "fun|class|interface|object|typealias|package|constructor|init",
  mods: "public|private|protected|internal|open|abstract|override|final|suspend|inline|data|sealed|enum|annotation|companion|operator|infix|tailrec|external|inner|value|expect|actual|const|lateinit|fun",
  extra: [/^(?:(?:private|internal|public|const)\s+)*(?:val|var)\s+\w+/],
  block: "braces",
  lc: ["//"],
  bc: [...C_BC, ['"""', '"""']],
  imports: /^\s*import\s/
};
var SCALA = {
  id: "scala",
  ext: [".scala", ".sc"],
  kws: "def|class|object|trait|type|package|given|extension|enum",
  mods: "private(?:\\[\\w+\\])?|protected(?:\\[\\w+\\])?|final|sealed|abstract|implicit|lazy|override|case|inline|opaque|transparent|open",
  block: "braces",
  lc: ["//"],
  bc: [...C_BC, ['"""', '"""']],
  imports: /^\s*import\s/
};
var GROOVY = {
  id: "groovy",
  ext: [".groovy", ".gradle", ".gvy"],
  kws: "def|class|interface|trait|enum",
  mods: JAVA_MODS,
  extra: [C_FUNC, /^(?<name>\w+)\s*(\([^)]*\))?\s*\{\s*$/],
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*import\s/
};
var SWIFT = {
  id: "swift",
  ext: [".swift"],
  prefix: ATTRIBUTES,
  kws: "func|class|struct|enum|protocol|extension|init[?!]?|deinit|subscript|typealias|actor|macro",
  mods: "public|private|fileprivate|internal|package|open|static|final|override|mutating|nonmutating|convenience|required|lazy|dynamic|indirect|nonisolated|async",
  block: "braces",
  lc: ["//"],
  bc: [...C_BC, ['"""', '"""']],
  imports: /^\s*(?:@\w+\s+)?import\s/
};
var GO = {
  id: "go",
  ext: [".go"],
  kws: "func|type|package",
  extra: [/^(var|const)\b/, /^\s+(?<name>[A-Za-z_]\w*)\s+(struct|interface)\s*\{/],
  // 2nd: types in a `type ( … )` group
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  stringDelims: "\"'`",
  imports: /^\s*import\b/
};
var RUST = {
  id: "rust",
  ext: [".rs"],
  kws: "fn|struct|enum|trait|impl|mod|type|const|static|union|macro_rules!|extern\\s+crate",
  mods: 'pub(?:\\([^)]*\\))?|async|unsafe|extern(?:\\s+"[^"]*")?|const|default',
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  stringDelims: '"',
  imports: /^\s*(?:pub\s+)?use\s/
};
var DART = {
  id: "dart",
  ext: [".dart"],
  kws: "class|mixin|extension|enum|typedef|factory",
  mods: "abstract|base|final|interface|sealed|static|external|const|late",
  extra: [C_FUNC, C_ONE_LINE, /^\s*(?:static\s+)?[\w<>?,]+\s+(?:get|set)\s+(?<name>\w+)/],
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*(?:import|export|part)\s+['"]/
};
var ZIG = {
  id: "zig",
  ext: [".zig"],
  kws: "fn|test",
  mods: "pub|export|extern|inline|noinline",
  extra: [/^(?:pub\s+)?(?:const|var)\s+\w+/],
  block: "braces",
  lc: ["//"],
  imports: /@import\(/
};
var SOLIDITY = {
  id: "solidity",
  ext: [".sol"],
  kws: "contract|interface|library|function|modifier|event|struct|enum|constructor|error",
  mods: "abstract",
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*import\s/
};
var OBJC = {
  id: "objective-c",
  ext: [".m", ".mm"],
  kws: "@interface|@implementation|@protocol|@end|struct|typedef|enum",
  extra: [/^[-+]\s*\(/, C_FUNC],
  block: "auto",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*[#@]\s*(?:import|include)\b/
};
var PHP = {
  id: "php",
  ext: [".php", ".phtml"],
  kws: "function|class|interface|trait|enum|namespace",
  mods: "public|private|protected|static|abstract|final|readonly",
  block: "braces",
  lc: ["//", "#"],
  bc: C_BC,
  heredoc: true,
  imports: /^\s*(?:use|require(?:_once)?|include(?:_once)?)\b/
};
var RUBY = {
  id: "ruby",
  ext: [".rb", ".rake", ".gemspec", ".ru"],
  files: /^(Rakefile|Gemfile|Vagrantfile|Podfile|Guardfile|Fastfile)$/,
  shebang: /ruby/,
  kws: "def|class|module",
  mods: "private|protected|public|private_class_method",
  block: "end",
  lc: ["#"],
  bc: [["=begin", "=end"]],
  heredoc: true,
  imports: /^\s*require(?:_relative)?\b/
};
var LUA = {
  id: "lua",
  ext: [".lua"],
  shebang: /lua/,
  kws: "function|local\\s+function",
  extra: [/^\s*(?:local\s+)?(?<name>[\w.:]+)\s*=\s*function\b/],
  block: "end",
  lc: ["--"],
  bc: [["--[[", "]]"]],
  imports: /\brequire\s*\(?\s*['"]/
};
var ELIXIR = {
  id: "elixir",
  ext: [".ex", ".exs"],
  kws: "defmodule|def|defp|defmacro|defmacrop|defstruct|defprotocol|defimpl|defdelegate|defguard|defguardp|defexception|@callback|@type|@typep|@opaque",
  block: "end",
  lc: ["#"],
  bc: [['"""', '"""'], ["'''", "'''"]],
  imports: /^\s*(?:alias|import|use|require)\s/
};
var JULIA = {
  id: "julia",
  ext: [".jl"],
  kws: "function|macro|module|baremodule|struct|mutable\\s+struct|abstract\\s+type|primitive\\s+type",
  block: "end",
  lc: ["#"],
  bc: [["#=", "=#"], ['"""', '"""']],
  imports: /^\s*(?:using|import)\s/
};
var R = {
  id: "r",
  ext: [".r"],
  extra: [/^\s*(?<name>[\w.]+)\s*(?:<-|=)\s*function\b/],
  block: "braces",
  lc: ["#"],
  imports: /^\s*(?:library|require|source)\(/
};
var PERL = {
  id: "perl",
  ext: [".pl", ".pm"],
  shebang: /perl/,
  kws: "sub|package",
  block: "braces",
  lc: ["#"],
  bc: [["=pod", "=cut"]],
  heredoc: true,
  imports: /^\s*(?:use|require)\s/
};
var SHELL = {
  id: "shell",
  ext: [".sh", ".bash", ".zsh", ".ksh"],
  files: /^\.(bash|zsh)(rc|_profile)$|^\.profile$/,
  shebang: /\b(ba|z|k|da)?sh\b/,
  kws: "function",
  extra: [/^\s*(?:function\s+)?(?<name>[\w:.-]+)\s*\(\)/],
  block: "braces",
  lc: ["#"],
  heredoc: true,
  imports: /^\s*(?:source|\.)\s+\S/
};
var POWERSHELL = {
  id: "powershell",
  ext: [".ps1", ".psm1"],
  kws: "function|filter|class|enum|workflow|configuration",
  block: "braces",
  lc: ["#"],
  bc: [["<#", "#>"]],
  imports: /^\s*(?:Import-Module|using\s+module)\b/i
};
var VIM = { id: "vim", ext: [".vim"], kws: "function!?|fun!?|command!?|augroup", block: "indentation", lc: ['"'] };
var HASKELL = {
  id: "haskell",
  ext: [".hs", ".lhs"],
  extra: [/^(?:data|newtype|type|class|instance|module)\b/, /^(?<name>[a-z_][\w']*)\s*::/],
  block: "indentation",
  lc: ["--"],
  bc: [["{-", "-}"]],
  imports: /^\s*import\s/
};
var OCAML = {
  id: "ocaml",
  ext: [".ml", ".mli"],
  extra: [/^(?:let|and|type|module|exception|class|val|external)\b/],
  block: "indentation",
  bc: [["(*", "*)"]],
  imports: /^\s*open\s/
};
var FSHARP = {
  id: "fsharp",
  ext: [".fs", ".fsi", ".fsx"],
  extra: [/^let\b/, /^\s*(?:type|module|member|abstract|override|static\s+member|namespace)\b/],
  block: "indentation",
  lc: ["//"],
  bc: [["(*", "*)"]],
  imports: /^\s*open\s/
};
var ERLANG = {
  id: "erlang",
  ext: [".erl", ".hrl"],
  extra: [/^(?<name>[a-z]\w*)\(.*\)\s*(?:when\s.*)?->/, /^-(?:module|export|record|type|spec|define|behaviour|callback)\b/],
  block: "indentation",
  lc: ["%"]
};
var CLOJURE = { id: "clojure", ext: [".clj", ".cljs", ".cljc", ".edn"], extra: [/^\((?:def\w*|ns)\s/], block: "indentation", lc: [";"] };
var LISP = { id: "lisp", ext: [".el", ".lisp", ".lsp", ".cl", ".scm", ".ss", ".rkt"], extra: [/^\((?:def\w*|define\w*)\s/], block: "indentation", lc: [";"] };
var NIM = {
  id: "nim",
  ext: [".nim"],
  kws: "proc|func|method|iterator|template|macro|converter|type",
  block: "indentation",
  lc: ["#"],
  bc: [["#[", "]#"]],
  imports: /^\s*(?:import|include|from)\s/
};
var SQL = {
  id: "sql",
  ext: [".sql"],
  extra: [/^\s*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|UNIQUE\s+INDEX|TRIGGER|TYPE|SCHEMA|SEQUENCE|DATABASE|EXTENSION)\b/i],
  block: "semicolon",
  lc: ["--"],
  bc: C_BC
};
var CSS = {
  id: "css",
  ext: [".css", ".scss", ".less"],
  kws: "@media|@supports|@keyframes|@font-face|@mixin|@function|@layer|@container|@page",
  extra: [/^[^\s@{}/*][^{};]*?\s*\{\s*$/, /^\$[\w-]+\s*:/],
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*@(?:import|use|forward)\s/
};
var HTML = {
  id: "html",
  ext: [".html", ".htm", ".xhtml", ".xml", ".svg", ".jsp", ".erb"],
  extra: [
    /^\s*<(?<balise>h[1-6]|section|article|nav|header|footer|main|aside|form|table|template|script|style|head|body|dialog)\b/,
    /<[\w-]+[^>]*\sid=["'][^"']+["']/
  ],
  block: "indentation",
  bc: [["<!--", "-->"]]
};
var MD = {
  id: "markdown",
  ext: [".md", ".markdown", ".mdx"],
  extra: [/^#{1,6}\s/],
  block: "headings",
  bc: [["```", "```"], ["<!--", "-->"]],
  level: (l) => /^#+/.exec(l)?.[0].length ?? 9
};
var TEX_RANKS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
var LATEX = {
  id: "latex",
  ext: [".tex"],
  extra: [/^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{/],
  block: "headings",
  lc: ["%"],
  level: (l) => TEX_RANKS[/\\(\w+)/.exec(l)?.[1] ?? ""] ?? 9
};
var YAML = { id: "yaml", ext: [".yml", ".yaml"], extra: [/^ {0,2}[\w"'./$-][^:#]*:(\s|$)/], block: "indentation", lc: ["#"] };
var TOML = { id: "toml-ini", ext: [".toml", ".ini", ".cfg", ".properties"], extra: [/^\s*\[\[?[^\]]+\]\]?\s*$/], block: "headings", lc: ["#", ";"] };
var JSON_ = {
  id: "json",
  ext: [".json", ".jsonc", ".json5", ".ipynb"],
  extra: [/^\s*"(?<key>[^"]+)"\s*:/],
  block: "indentation",
  lc: ["//"],
  minLevel: true
};
var MAKE = {
  id: "makefile",
  ext: [".mk", ".make"],
  files: /^(GNU)?[Mm]akefile$/,
  extra: [/^(?<target>[\w.%/$()-][^:=#\s]*(?:\s+[^:=#\s]+)*)\s*::?(?!=)/, /^define\s/],
  block: "indentation",
  lc: ["#"]
};
var DOCKER = {
  id: "dockerfile",
  ext: [".dockerfile"],
  files: /^(Docker|Container)file(\..+)?$/,
  extra: [/^\s*(?:FROM|ENTRYPOINT|CMD|EXPOSE|ARG|ENV|WORKDIR|USER|VOLUME|HEALTHCHECK|LABEL)\b/i],
  block: "headings",
  lc: ["#"]
};
var CMAKE = {
  id: "cmake",
  ext: [".cmake"],
  files: /^CMakeLists\.txt$/,
  extra: [/^\s*(?:function|macro|project|add_executable|add_library|add_subdirectory|option)\s*\(/i],
  block: "indentation",
  lc: ["#"]
};
var HCL = {
  id: "hcl",
  ext: [".tf", ".tfvars", ".hcl", ".nomad"],
  extra: [/^(?:resource|data|module|variable|output|provider|locals|terraform|job|group|task|service)\b/],
  block: "braces",
  lc: ["#", "//"],
  bc: C_BC
};
var PROTO = {
  id: "protobuf",
  ext: [".proto"],
  kws: "message|service|enum|rpc|oneof|extend|syntax|package",
  block: "braces",
  lc: ["//"],
  bc: C_BC,
  imports: /^\s*import\s/
};
var GRAPHQL = {
  id: "graphql",
  ext: [".graphql", ".gql"],
  extra: [/^(?:type|input|enum|interface|union|scalar|schema|query|mutation|subscription|fragment|extend|directive)\b/],
  block: "braces",
  lc: ["#"]
};
var ASM = { id: "assembleur", ext: [".s", ".asm"], extra: [/^(?<etiquette>[\w.$]+):/], block: "headings", lc: [";", "#", "//"] };
var TEXT = { id: "text", ext: [".txt", ".log", ".csv", ".tsv"], extra: [], block: "headings" };
var GENERIC = {
  id: "generic",
  extra: [
    /^\s*(export\s+)?(pub(\([^)]*\))?\s+)?(public\s+|private\s+|protected\s+|static\s+|async\s+)*(func|fn|def|defn|function|sub|proc|class|struct|interface|trait|impl|enum|type|module|package|object|record|namespace|macro)\s/,
    C_FUNC,
    /^[A-Za-z_@.#$][^=;]*\{\s*$/
  ],
  block: "auto",
  lc: ["//", "#", ";", "--"],
  bc: C_BC
};
var PROFILES = [
  TS,
  JS,
  WEBCOMP,
  PY,
  C,
  CPP,
  JAVA,
  CSHARP,
  KOTLIN,
  SCALA,
  GROOVY,
  SWIFT,
  GO,
  RUST,
  DART,
  ZIG,
  SOLIDITY,
  OBJC,
  PHP,
  RUBY,
  LUA,
  ELIXIR,
  JULIA,
  R,
  PERL,
  SHELL,
  POWERSHELL,
  VIM,
  HASKELL,
  OCAML,
  FSHARP,
  ERLANG,
  CLOJURE,
  LISP,
  NIM,
  SQL,
  CSS,
  HTML,
  MD,
  LATEX,
  YAML,
  TOML,
  JSON_,
  MAKE,
  DOCKER,
  CMAKE,
  HCL,
  PROTO,
  GRAPHQL,
  ASM,
  TEXT
];

// src/languages/engine.ts
var BY_EXT = /* @__PURE__ */ new Map();
for (const p of PROFILES) for (const e of p.ext ?? []) if (!BY_EXT.has(e)) BY_EXT.set(e, p);
function profileFor(file, start = "") {
  const name = basename(file);
  const byName = PROFILES.find((p) => p.files?.test(name));
  if (byName) return byName;
  const ext = extname(name).toLowerCase();
  if (ext === ".h" && /^\s*(class|namespace|template\s*<)\b|^\s*#include\s*<(iostream|string|vector|memory)>/m.test(start)) {
    return BY_EXT.get(".hpp");
  }
  const byExt = BY_EXT.get(ext);
  if (byExt) return byExt;
  const firstLine = start.split("\n", 1)[0];
  if (firstLine.startsWith("#!")) {
    const byShebang = PROFILES.find((p) => p.shebang?.test(firstLine));
    if (byShebang) return byShebang;
  }
  return GENERIC;
}
var CONTROL = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "with",
  "new",
  "await",
  "typeof",
  "function",
  "super",
  "this",
  "delete",
  "throw",
  "yield",
  "case",
  "goto",
  "sizeof",
  "foreach",
  "lock",
  "elif",
  "unless",
  "until",
  "when",
  "match",
  "print",
  "echo",
  "defer",
  "go",
  "select",
  "not",
  "and",
  "or"
]);
var FIRST = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "new",
  "await",
  "throw",
  "yield",
  "case",
  "goto",
  "delete",
  "sizeof",
  "typeof",
  "foreach",
  "lock",
  "elif",
  "unless",
  "until",
  "defer",
  "go",
  "echo"
]);
var patternCache = /* @__PURE__ */ new WeakMap();
function patterns(p) {
  let m = patternCache.get(p);
  if (!m) {
    m = [...p.extra ?? []];
    if (p.kws) m.unshift(new RegExp(`^\\s*${p.prefix ?? ""}(?:(?:${p.mods ?? "(?!)"})\\s+)*(?:${p.kws})(?![\\w$])`));
    patternCache.set(p, m);
  }
  return m;
}
function isComment(line, p) {
  const t = line.trimStart();
  return (p.lc ?? []).some((c) => t.startsWith(c));
}
function inString(l, idx) {
  for (const q of ['"', "'", "`"]) {
    let n = 0;
    for (let i = 0; i < idx; i++) if (l[i] === q && l[i - 1] !== "\\") n++;
    if (n % 2) return true;
  }
  return false;
}
function computeMask(lines, p) {
  const pairs = p.bc ?? [];
  if (!pairs.length && !p.heredoc) return lines.map(() => false);
  let active = -1;
  let heredoc = null;
  return lines.map((l) => {
    if (heredoc) {
      if (l.trim() === heredoc) heredoc = null;
      return true;
    }
    if (p.heredoc && active === -1) {
      const h = /<<<?[~-]?(\s?)(['"]?)([A-Za-z_]\w*)\2/.exec(l);
      if (h && !inString(l, h.index) && (!h[1] || /^[A-Z_][A-Z0-9_]*$/.test(h[3]))) heredoc = h[3];
    }
    const masked = active !== -1;
    const neutral = l.replace(/"""|'''/g, "");
    let pos = 0;
    for (; ; ) {
      if (active === -1) {
        let k = -1, at = Infinity;
        pairs.forEach(([o], j) => {
          let i = l.indexOf(o, pos);
          while (i !== -1 && inString(neutral, i)) i = l.indexOf(o, i + 1);
          if (i !== -1 && i < at) {
            at = i;
            k = j;
          }
        });
        if (k === -1) break;
        const lc = (p.lc ?? []).map((c) => l.indexOf(c, pos)).filter((i) => i !== -1 && i < at && !inString(l, i));
        if (lc.length) break;
        active = k;
        pos = at + pairs[k][0].length;
      } else {
        const i = l.indexOf(pairs[active][1], pos);
        if (i === -1) break;
        pos = i + pairs[active][1].length;
        active = -1;
      }
    }
    return masked;
  });
}
function isDeclaration(line, p) {
  if (line.length > 400 || !line.trim() || isComment(line, p)) return false;
  const ms = patterns(p);
  for (let k = 0; k < ms.length; k++) {
    const m = ms[k].exec(line);
    if (!m) continue;
    if (!(p.kws && k === 0)) {
      const first = /^\s*([A-Za-z_]\w*)/.exec(line)?.[1];
      if (first && FIRST.has(first) || m.groups?.name && CONTROL.has(m.groups.name)) continue;
    }
    return true;
  }
  return false;
}
function declarations(lines, p, mask = computeMask(lines, p)) {
  let res = [];
  lines.forEach((l, i) => {
    if (!mask[i] && isDeclaration(l, p)) res.push(i);
  });
  if (p.minLevel && res.length) {
    const min = Math.min(...res.map((i) => indent(lines[i])));
    res = res.filter((i) => indent(lines[i]) === min);
  }
  return res;
}
function isImport(line, p) {
  return !!p.imports && !isComment(line, p) && p.imports.test(line);
}
function importedModule(line) {
  const q = /['"<]([^'"<>]+)['">]/.exec(line);
  if (q) return q[1];
  const m = /^\s*(?:from|import|use|using|require|include|open|alias|library|source|extern\s+crate)(?:\s+|\()(?:static\s+|global\s+)?([^\s;()]+)/.exec(line);
  return m ? m[1].replace(/[;,]$/, "") : line.trim().slice(0, 40);
}
var indent = (l) => l.replace(/\t/g, "    ").search(/\S/);

// src/tools/outline.ts
var MAX_DECLARATIONS = 400;
function signature(line) {
  return truncate(line.replace(/\t/g, "  ").replace(/\s*\{\s*$/, "").trimEnd(), 160);
}
async function outline(args, cwd) {
  const content = await readFile(absolutePath(args.file, cwd), "utf8");
  const lines = splitLines(content);
  const profile = profileFor(args.file, content.slice(0, 8e3));
  const mask = computeMask(lines, profile);
  const width = String(lines.length).length;
  const imports = [];
  const importLines = /* @__PURE__ */ new Set();
  let firstImport = 0;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || !isImport(lines[i], profile)) continue;
    if (!firstImport) firstImport = i + 1;
    importLines.add(i);
    if (/\(\s*$/.test(lines[i])) {
      for (i++; i < lines.length && !/^\s*\)/.test(lines[i]); i++) {
        importLines.add(i);
        if (lines[i].trim() && !lines[i].trim().startsWith("//")) imports.push(importedModule(lines[i]));
      }
      importLines.add(i);
    } else imports.push(importedModule(lines[i]));
  }
  const decls = declarations(lines, profile, mask).filter((i) => !importLines.has(i));
  const output = decls.slice(0, MAX_DECLARATIONS).map((i) => `${String(i + 1).padStart(width)}|${signature(lines[i])}`);
  if (decls.length > MAX_DECLARATIONS) output.push(`[+${decls.length - MAX_DECLARATIONS} declarations: refine with search]`);
  const header = `${args.file} (${lines.length} lines, ${profile.id}) \u2014 outline`;
  const importsLine = imports.length ? `imports (${imports.length}, from l.${firstImport}): ${truncate([...new Set(imports)].join(", "), 600)}` : "";
  const body = output.length ? output.join("\n") : "(no declarations detected \u2014 use read_range)";
  return {
    text: [header, importsLine, body].filter(Boolean).join("\n"),
    nativeChars: nativeReadChars(lines),
    details: { file: args.file, language: profile.id, declarations: decls.length }
  };
}

// src/tokens.ts
var CHARS_PER_TOKEN = 4;
function estimateTokens(input) {
  const chars = typeof input === "number" ? input : input.length;
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// src/guidance.ts
var GUIDANCE = [
  "token-eco: every tool call is a full turn that re-reads the whole context, so the NUMBER of calls is what costs. Plan, then batch:",
  "- one `search` with all your `queries`; `expand: true` returns the whole function/class around each hit (search + read in one call);",
  "- one `read` with all `targets` (`name` = one symbol, `start`/`end`, `pattern` = matching lines; no option = whole file if short, else outline);",
  "- one `edit` with every change of a step, using only text you have seen in this session (read a doc file before editing it);",
  "- one Bash call chaining related commands (e.g. tests, then `git diff --stat`).",
  "Prefer these tools to Read/Grep/Glob/Edit and to cat/grep/sed in Bash. Never re-read what you just read or wrote."
].join("\n");
function guidanceOutput(event = "SessionStart") {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: GUIDANCE } });
}

// src/hook.ts
var DELAI_REPLI_MS = 10 * 6e4;
var NON_TEXT = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".ipynb"]);
var RETRY_HINT = "If these tools are not available to you, or you really need the whole output, repeat the exact same call: it will be allowed.";
var COMPOUND = /&&|\|\||[;|<>`&]|\$\(|\n/;
var WATCH_MODE = /\s(--watch|-w|--watchAll|serve|dev|start)\b/;
var READ_ONLY = /^git\s+(status|log|diff|show)\b/;
var CD_PREFIX = /^cd\s+([\w./~-]+|"[^"$`\\]*"|'[^']*')\s*&&\s*/;
var TAIL_HEAD_SUFFIX = /\s*\|\s*(tail|head)\s+(-n\s*\d+|-\d+|-n\d+)\s*$/;
function decompose(command) {
  let c = command.trim(), prior = "", trailer = "";
  const cd = CD_PREFIX.exec(c);
  if (cd) {
    prior = `cd ${cd[1]} && `;
    c = c.slice(cd[0].length);
  }
  const th = TAIL_HEAD_SUFFIX.exec(c);
  if (th) {
    trailer = ` | ${th[1]} ${th[2].replace(/\s+/g, " ")}`;
    c = c.slice(0, th.index);
  }
  c = c.replace(/\s+2>&1\s*$/, "").trim();
  return { prior, c, trailer };
}
var SHELL_KEYWORDS = /* @__PURE__ */ new Set(["for", "while", "until", "if", "case", "do", "then", "else", "elif", "fi", "done", "esac", "function", "select"]);
function splitCompound(command) {
  const parts = [], ops = [];
  let cur = "", q = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i], next = command[i + 1];
    if (q) {
      if (ch === "`" || q === '"' && ch === "$" && next === "(") return null;
      if (ch === "\\" && q === '"') {
        cur += ch + (next ?? "");
        i++;
        continue;
      }
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === "{" && next === "}") {
      cur += "{}";
      i++;
      continue;
    }
    if ("`(){}\n".includes(ch) || ch === "$" && next === "(" || ch === "<" && next === "<") return null;
    if (ch === "&" && next === "&" || ch === "|" && next === "|") {
      parts.push(cur);
      ops.push(ch + next);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";") {
      parts.push(cur);
      ops.push(";");
      cur = "";
      continue;
    }
    if (ch === "&" && command[i - 1] !== ">" && next !== ">") return null;
    cur += ch;
  }
  if (q) return null;
  parts.push(cur);
  const trimmed = parts.map((p) => p.trim());
  if (trimmed.some((p, i) => !p && i < trimmed.length - 1) || trimmed.some((p) => SHELL_KEYWORDS.has(p.split(/\s+/)[0]))) return null;
  if (!trimmed[trimmed.length - 1]) {
    trimmed.pop();
    ops.pop();
  }
  return { parts: trimmed, ops };
}
function countLines(filePath) {
  const size = statSync(filePath).size;
  if (size > 5e7) return Infinity;
  const b = readFileSync2(filePath);
  if (b.subarray(0, 8e3).includes(0)) return 0;
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}
function ruleMatches(rule, command) {
  if (rule === "Bash") return true;
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pattern = m[1];
  if (pattern.endsWith(":*")) return command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -2) + " ");
  if (pattern.includes("*")) return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command);
  return command === pattern;
}
function readRules(cwd) {
  const r = { allow: [], deny: [] };
  const files = [join3(homedir2(), ".claude/settings.json")];
  if (cwd) files.push(join3(cwd, ".claude/settings.json"), join3(cwd, ".claude/settings.local.json"));
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync2(f, "utf8")).permissions ?? {};
      r.allow.push(...p.allow ?? []);
      r.deny.push(...p.deny ?? []);
    } catch {
    }
  }
  return r;
}
var quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function decide(e, config, state, now = Date.now(), linesOf = countLines, rules = { allow: [], deny: [] }, runJs = "run.js") {
  if (config.hook.mode === "off") return { action: "pass" };
  const ti = e.tool_input ?? {};
  let key, message, file;
  if (e.tool_name === "Bash") {
    const complete = String(ti.command ?? "").trim();
    const split = ti.run_in_background ? null : splitCompound(complete);
    if (!split) return { action: "pass" };
    if (rules.deny.some((r) => ruleMatches(r, complete))) return { action: "pass" };
    let changed = false, allAllowed = true;
    const out = [];
    for (const part of split.parts) {
      if (/^cd(\s|$)/.test(part) && !COMPOUND.test(part)) {
        out.push(part);
        continue;
      }
      const { prior: prior2, c, trailer } = decompose(part);
      if (rules.deny.some((r) => ruleMatches(r, c) || ruleMatches(r, part))) return { action: "pass" };
      if (!(READ_ONLY.test(c) || rules.allow.some((r) => ruleMatches(r, c) || ruleMatches(r, part)))) allAllowed = false;
      if (!c || COMPOUND.test(c) || WATCH_MODE.test(c) || family(c) === "other") {
        out.push(part);
        continue;
      }
      changed = true;
      out.push(`${prior2}node ${quote(runJs)} ${quote(c)}${trailer}`);
    }
    if (!changed) return { action: "pass" };
    const command = out.map((p, i) => (i ? ` ${split.ops[i - 1]} ` : "") + p).join("");
    return { action: "rewrite", command, autoAllow: e.permission_mode === "bypassPermissions" || allAllowed };
  }
  if (e.tool_name === "Read") {
    const f = String(ti.file_path ?? "");
    if (!f || ti.offset != null || ti.limit != null || NON_TEXT.has(extname2(f).toLowerCase())) return { action: "pass" };
    file = isAbsolute(f) || !e.cwd ? f : join3(e.cwd, f);
    let n;
    try {
      n = linesOf(file);
    } catch {
      return { action: "pass" };
    }
    if (n <= config.hook.lineThreshold) return { action: "pass" };
    key = `Read|${file}`;
    message = `token-eco: ${f} has ${n === Infinity ? "many" : n} lines; a full Read is expensive. Its outline is below. Next, read only what you need with the token-eco tool read (name = symbol, or start/end) or Read with offset/limit. ${RETRY_HINT}`;
  } else if (e.tool_name === "Grep") {
    if (ti.output_mode !== "content") return { action: "pass" };
    key = `Grep|${String(ti.pattern)}|${String(ti.path ?? "")}|${String(ti.glob ?? "")}`;
    message = `token-eco: use the token-eco tool search instead (same regex; grouped by file, exact totals, about half the tokens; mode files/count also available). ${RETRY_HINT}`;
  } else return { action: "pass" };
  key = `${e.session_id ?? "?"}|${key}`;
  const prior = state[key];
  if (prior && now - prior < DELAI_REPLI_MS) return { action: "fallback", key };
  return { action: "refused", key, message, file };
}
function measureRead(e, file, returned, native) {
  record({
    project: e.cwd ?? process.cwd(),
    tool: "read_redirect",
    returnedTokens: returned,
    nativeTokens: native,
    details: { file }
  });
}
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw);
  const config = readConfig();
  if (e.hook_event_name === "SessionStart" || e.hook_event_name === "SubagentStart") {
    if (config.hook.mode !== "off") process.stdout.write(guidanceOutput(e.hook_event_name));
    return;
  }
  const runJs = join3(dirname(process.argv[1]), "run.js");
  const stateFile = join3(dataDir(), "hook-state.json");
  let state = {};
  try {
    state = JSON.parse(readFileSync2(stateFile, "utf8"));
  } catch {
  }
  const now = Date.now();
  for (const [k, t] of Object.entries(state)) if (now - t > DELAI_REPLI_MS) delete state[k];
  const rules = e.tool_name === "Bash" ? readRules(e.cwd) : void 0;
  const d = decide(e, config, state, now, countLines, rules, runJs);
  if (d.action === "pass") return;
  if (d.action === "rewrite") {
    const output = { hookEventName: "PreToolUse", updatedInput: { ...e.tool_input, command: d.command } };
    if (d.autoAllow) Object.assign(output, { permissionDecision: "allow", permissionDecisionReason: "token-eco: compact output" });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
    return;
  }
  if (d.action === "fallback") delete state[d.key];
  else state[d.key] = now;
  writeFileSync2(stateFile, JSON.stringify(state));
  const [, tool, ...rest] = d.key.split("|");
  try {
    recordRedirect(e.session_id ?? "", tool, rest.join("|"), d.action);
  } catch {
  }
  if (d.action === "fallback") {
    if (tool === "Read") {
      try {
        const native = nativeReadChars(splitLines(readFileSync2(rest.join("|"), "utf8")));
        measureRead(e, rest.join("|"), estimateTokens(native), 0);
      } catch {
      }
    }
    return;
  }
  let message = d.message;
  if (d.file) {
    try {
      const ap = await outline({ file: d.file });
      message += `

${ap.text}`;
      measureRead(e, d.file, estimateTokens(message), estimateTokens(ap.nativeChars));
    } catch {
    }
  }
  process.stderr.write(message + "\n");
  process.exit(2);
}
if (process.argv[1] && /hook\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => process.exit(0));
}
export {
  countLines,
  decide,
  decompose,
  readRules,
  ruleMatches,
  splitCompound
};
