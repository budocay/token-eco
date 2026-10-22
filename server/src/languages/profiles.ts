/**
 * Language profiles: how to recognise a declaration and where its block ends.
 * Heuristics (regex), not real parsers. Adding a language = adding a profile.
 * Unknown languages use the GENERIC profile (universal fallback).
 */

export type BlockMode = "braces" | "indentation" | "end" | "headings" | "semicolon" | "auto";

export interface Profile {
  id: string;
  ext?: string[];              // lowercase extensions (".go")
  files?: RegExp;              // file names without a meaningful extension (Makefile…)
  shebang?: RegExp;            // detection from the 1st line (#!/usr/bin/env python)
  kws?: string;                // declaration keywords (regex alternation)
  mods?: string;               // modifiers allowed before the keyword
  prefix?: string;             // e.g. “@MainActor” attributes before the modifiers
  extra?: RegExp[];            // other forms; named group “name” checked against the control words
  block: BlockMode;
  lc?: string[];               // line comments
  bc?: [string, string][];     // multi-line comments / strings (masked)
  stringDelims?: string;       // string delimiters for brace counting
  imports?: RegExp;            // import lines (summarised on one line)
  level?: (line: string) => number; // “headings” mode: hierarchical depth
  minLevel?: boolean;          // keep only the least indented declarations (JSON)
  heredoc?: boolean;           // mask heredocs (<<EOF … EOF, <<~HTML, <<<EOT)
}

/** C-style function without a keyword: `type name(params)` without a final “;” (C, C++, Java, C#, Dart…). */
// Type token: generic `<T extends A>` (spaces allowed) or word (`std::vector<int>`, `char*`…).
const TOK = "(?:<[^<>;()]*(?:<[^<>;()]*>[^<>;()]*)*>|[\\w~*&][\\w:<>,*&\\[\\]~?.]*)";
const C_NAME = "[*&]*(?<name>~?[A-Za-z_][\\w:~]*)\\s*";
export const C_FUNC = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;]*$`);
/** Prototype / abstract method / interface method: same form, ending with “;”. */
export const CPROTO = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;{}]*\\)\\s*` +
  `(?:const|override|final|noexcept|=\\s*0|=\\s*default|=\\s*delete|throws\\s+[\\w.,\\s]+|default\\s+[^;]+|\\s)*;\\s*$`);
/** One-line definition: `auto f() const -> int { return x; }` or `int F() => 0;` (C#, Dart). */
export const C_ONE_LINE = new RegExp(`^\\s*(?:${TOK}\\s+)+${C_NAME}\\([^;{]*\\)[^;{=]*(?:\\{.*\\}\\s*;?|=>.*;)\\s*$`);
const C_BC: [string, string][] = [["/*", "*/"]];
const ATTRIBUTES = "(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*";

// --- JavaScript / TypeScript (regexes proven by the benchmark) ---
const JS_EXTRA = [
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace|module)\s/,
  /^(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)\s*(:[^=]+)?=>|[\w$]+\s*=>|\(\s*$|\([^)]*,\s*$)/,
  /^(export\s+)?(const|let|var)\s+[\w$]+\s*=\s*(async\s+)?function/,
  /^\s+((public|private|protected|static|async|readonly|get|set|override|abstract)\s+)*\*?\s*(?<name>#?[\w$]+)\s*(<[^>]*>)?\s*\(.*\)\s*(:\s*[^{]+)?\{\s*$/,
  /^\s+((public|private|protected|static|async|readonly|get|set|override|abstract)\s+)+\*?\s*(?<name>#?[\w$]+)\s*(<[^>]*>)?\s*\((?!.*;\s*$)/,
  /^\s*export\s+(\{|\*|default\s|const\s|let\s|var\s)/,
];
const JS: Profile = {
  id: "javascript", ext: [".js", ".jsx", ".mjs", ".cjs"], shebang: /\b(node|deno|bun)\b/,
  extra: JS_EXTRA, block: "braces", lc: ["//"], bc: C_BC,
  imports: /^\s*import\s/,
};
const TS: Profile = { ...JS, id: "typescript", ext: [".ts", ".tsx", ".mts", ".cts"], shebang: undefined };
const WEBCOMP: Profile = {
  ...JS, id: "composant-web", ext: [".vue", ".svelte", ".astro"], shebang: undefined, block: "auto",
  extra: [...JS_EXTRA, /^<(template|script|style)\b/], bc: [...C_BC, ["<!--", "-->"]],
};

const PY: Profile = {
  id: "python", ext: [".py", ".pyi", ".pyw"], shebang: /python/,
  kws: "def|class", mods: "async", extra: [/^[A-Z_][A-Z0-9_]*\s*(:[^=]+)?=/],
  block: "indentation", lc: ["#"], bc: [['"""', '"""'], ["'''", "'''"]],
  imports: /^\s*(import\s|from\s+\S+\s+import\s)/,
};

// --- Family C ---
const C: Profile = {
  id: "c", ext: [".c", ".h"],
  kws: "struct|union|enum|typedef|#\\s*define", mods: "static|extern|inline|const|volatile",
  extra: [C_FUNC, CPROTO, C_ONE_LINE, /^(?<name>[A-Za-z_]\w*)\s*\([^;]*$/], // 3rd form: GNU style (name alone in column 0)
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*#\s*include\b/,
};
const CPP: Profile = {
  ...C, id: "cpp", ext: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".cu", ".inl"],
  // `template <…>` alone on its line = prefix of the next declaration (see engine).
  prefix: "(?:[A-Z][A-Z0-9_]{2,}(?:\\([^)]*\\))?\\s+)*", // macros d'export : FMT_EXPORT, DLLEXPORT…
  kws: "class|struct|union|enum(?:\\s+class)?|namespace|typedef|using\\s+\\w+\\s*=|concept|#\\s*define",
  mods: "template\\s*<[^>]*>|export|inline|static|constexpr|consteval|extern|virtual|explicit|friend",
};
const JAVA_MODS = "public|private|protected|static|final|abstract|sealed|non-sealed|strictfp|synchronized|native|default";
const JAVA: Profile = {
  id: "java", ext: [".java"], kws: "class|interface|enum|record|@interface|package", mods: JAVA_MODS,
  extra: [C_FUNC, CPROTO], block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*import\s/,
};
const CSHARP: Profile = {
  id: "csharp", ext: [".cs", ".csx"],
  kws: "class|struct|interface|enum|record|namespace|delegate|event",
  mods: "public|private|protected|internal|static|abstract|sealed|partial|async|override|virtual|readonly|unsafe|extern|new|file|required",
  extra: [C_FUNC, CPROTO, C_ONE_LINE,
    /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|required)\s+)+[\w<>\[\],?.]+\s+(?<name>\w+)\s*(?:\{|=>)/],
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*(?:global\s+)?using\s+(?:static\s+)?[\w.]+\s*;/,
};
const KOTLIN: Profile = {
  id: "kotlin", ext: [".kt", ".kts"], prefix: ATTRIBUTES,
  kws: "fun|class|interface|object|typealias|package|constructor|init",
  mods: "public|private|protected|internal|open|abstract|override|final|suspend|inline|data|sealed|enum|annotation|companion|operator|infix|tailrec|external|inner|value|expect|actual|const|lateinit|fun",
  extra: [/^(?:(?:private|internal|public|const)\s+)*(?:val|var)\s+\w+/],
  block: "braces", lc: ["//"], bc: [...C_BC, ['"""', '"""']], imports: /^\s*import\s/,
};
const SCALA: Profile = {
  id: "scala", ext: [".scala", ".sc"],
  kws: "def|class|object|trait|type|package|given|extension|enum",
  mods: "private(?:\\[\\w+\\])?|protected(?:\\[\\w+\\])?|final|sealed|abstract|implicit|lazy|override|case|inline|opaque|transparent|open",
  block: "braces", lc: ["//"], bc: [...C_BC, ['"""', '"""']], imports: /^\s*import\s/,
};
const GROOVY: Profile = {
  id: "groovy", ext: [".groovy", ".gradle", ".gvy"], kws: "def|class|interface|trait|enum", mods: JAVA_MODS,
  extra: [C_FUNC, /^(?<name>\w+)\s*(\([^)]*\))?\s*\{\s*$/], block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*import\s/,
};
const SWIFT: Profile = {
  id: "swift", ext: [".swift"], prefix: ATTRIBUTES,
  kws: "func|class|struct|enum|protocol|extension|init[?!]?|deinit|subscript|typealias|actor|macro",
  mods: "public|private|fileprivate|internal|package|open|static|final|override|mutating|nonmutating|convenience|required|lazy|dynamic|indirect|nonisolated|async",
  block: "braces", lc: ["//"], bc: [...C_BC, ['"""', '"""']], imports: /^\s*(?:@\w+\s+)?import\s/,
};
const GO: Profile = {
  id: "go", ext: [".go"], kws: "func|type|package",
  extra: [/^(var|const)\b/, /^\s+(?<name>[A-Za-z_]\w*)\s+(struct|interface)\s*\{/], // 2nd: types in a `type ( … )` group
  block: "braces", lc: ["//"], bc: C_BC, stringDelims: "\"'`", imports: /^\s*import\b/,
};
const RUST: Profile = {
  id: "rust", ext: [".rs"],
  kws: "fn|struct|enum|trait|impl|mod|type|const|static|union|macro_rules!|extern\\s+crate",
  mods: "pub(?:\\([^)]*\\))?|async|unsafe|extern(?:\\s+\"[^\"]*\")?|const|default",
  block: "braces", lc: ["//"], bc: C_BC, stringDelims: "\"", imports: /^\s*(?:pub\s+)?use\s/,
};
const DART: Profile = {
  id: "dart", ext: [".dart"], kws: "class|mixin|extension|enum|typedef|factory",
  mods: "abstract|base|final|interface|sealed|static|external|const|late",
  extra: [C_FUNC, C_ONE_LINE, /^\s*(?:static\s+)?[\w<>?,]+\s+(?:get|set)\s+(?<name>\w+)/],
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*(?:import|export|part)\s+['"]/,
};
const ZIG: Profile = {
  id: "zig", ext: [".zig"], kws: "fn|test", mods: "pub|export|extern|inline|noinline",
  extra: [/^(?:pub\s+)?(?:const|var)\s+\w+/], block: "braces", lc: ["//"], imports: /@import\(/,
};
const SOLIDITY: Profile = {
  id: "solidity", ext: [".sol"],
  kws: "contract|interface|library|function|modifier|event|struct|enum|constructor|error", mods: "abstract",
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*import\s/,
};
const OBJC: Profile = {
  id: "objective-c", ext: [".m", ".mm"],
  kws: "@interface|@implementation|@protocol|@end|struct|typedef|enum",
  extra: [/^[-+]\s*\(/, C_FUNC], block: "auto", lc: ["//"], bc: C_BC, imports: /^\s*[#@]\s*(?:import|include)\b/,
};
// --- Scripting languages ---
const PHP: Profile = {
  id: "php", ext: [".php", ".phtml"], kws: "function|class|interface|trait|enum|namespace",
  mods: "public|private|protected|static|abstract|final|readonly",
  block: "braces", lc: ["//", "#"], bc: C_BC, heredoc: true, imports: /^\s*(?:use|require(?:_once)?|include(?:_once)?)\b/,
};
const RUBY: Profile = {
  id: "ruby", ext: [".rb", ".rake", ".gemspec", ".ru"], files: /^(Rakefile|Gemfile|Vagrantfile|Podfile|Guardfile|Fastfile)$/,
  shebang: /ruby/, kws: "def|class|module", mods: "private|protected|public|private_class_method",
  block: "end", lc: ["#"], bc: [["=begin", "=end"]], heredoc: true, imports: /^\s*require(?:_relative)?\b/,
};
const LUA: Profile = {
  id: "lua", ext: [".lua"], shebang: /lua/, kws: "function|local\\s+function",
  extra: [/^\s*(?:local\s+)?(?<name>[\w.:]+)\s*=\s*function\b/],
  block: "end", lc: ["--"], bc: [["--[[", "]]"]], imports: /\brequire\s*\(?\s*['"]/,
};
const ELIXIR: Profile = {
  id: "elixir", ext: [".ex", ".exs"],
  kws: "defmodule|def|defp|defmacro|defmacrop|defstruct|defprotocol|defimpl|defdelegate|defguard|defguardp|defexception|@callback|@type|@typep|@opaque",
  block: "end", lc: ["#"], bc: [['"""', '"""'], ["'''", "'''"]], imports: /^\s*(?:alias|import|use|require)\s/,
};
const JULIA: Profile = {
  id: "julia", ext: [".jl"], kws: "function|macro|module|baremodule|struct|mutable\\s+struct|abstract\\s+type|primitive\\s+type",
  block: "end", lc: ["#"], bc: [["#=", "=#"], ['"""', '"""']], imports: /^\s*(?:using|import)\s/,
};
const R: Profile = {
  id: "r", ext: [".r"], extra: [/^\s*(?<name>[\w.]+)\s*(?:<-|=)\s*function\b/],
  block: "braces", lc: ["#"], imports: /^\s*(?:library|require|source)\(/,
};
const PERL: Profile = {
  id: "perl", ext: [".pl", ".pm"], shebang: /perl/, kws: "sub|package",
  block: "braces", lc: ["#"], bc: [["=pod", "=cut"]], heredoc: true, imports: /^\s*(?:use|require)\s/,
};
const SHELL: Profile = {
  id: "shell", ext: [".sh", ".bash", ".zsh", ".ksh"], files: /^\.(bash|zsh)(rc|_profile)$|^\.profile$/,
  shebang: /\b(ba|z|k|da)?sh\b/, kws: "function",
  extra: [/^\s*(?:function\s+)?(?<name>[\w:.-]+)\s*\(\)/], block: "braces", lc: ["#"], heredoc: true, imports: /^\s*(?:source|\.)\s+\S/,
};
const POWERSHELL: Profile = {
  id: "powershell", ext: [".ps1", ".psm1"], kws: "function|filter|class|enum|workflow|configuration",
  block: "braces", lc: ["#"], bc: [["<#", "#>"]], imports: /^\s*(?:Import-Module|using\s+module)\b/i,
};
const VIM: Profile = { id: "vim", ext: [".vim"], kws: "function!?|fun!?|command!?|augroup", block: "indentation", lc: ['"'] };

// --- Functional languages ---
const HASKELL: Profile = {
  id: "haskell", ext: [".hs", ".lhs"], extra: [/^(?:data|newtype|type|class|instance|module)\b/, /^(?<name>[a-z_][\w']*)\s*::/],
  block: "indentation", lc: ["--"], bc: [["{-", "-}"]], imports: /^\s*import\s/,
};
const OCAML: Profile = {
  id: "ocaml", ext: [".ml", ".mli"], extra: [/^(?:let|and|type|module|exception|class|val|external)\b/],
  block: "indentation", bc: [["(*", "*)"]], imports: /^\s*open\s/,
};
const FSHARP: Profile = {
  id: "fsharp", ext: [".fs", ".fsi", ".fsx"], extra: [/^let\b/, /^\s*(?:type|module|member|abstract|override|static\s+member|namespace)\b/],
  block: "indentation", lc: ["//"], bc: [["(*", "*)"]], imports: /^\s*open\s/,
};
const ERLANG: Profile = {
  id: "erlang", ext: [".erl", ".hrl"],
  extra: [/^(?<name>[a-z]\w*)\(.*\)\s*(?:when\s.*)?->/, /^-(?:module|export|record|type|spec|define|behaviour|callback)\b/],
  block: "indentation", lc: ["%"],
};
const CLOJURE: Profile = { id: "clojure", ext: [".clj", ".cljs", ".cljc", ".edn"], extra: [/^\((?:def\w*|ns)\s/], block: "indentation", lc: [";"] };
const LISP: Profile = { id: "lisp", ext: [".el", ".lisp", ".lsp", ".cl", ".scm", ".ss", ".rkt"], extra: [/^\((?:def\w*|define\w*)\s/], block: "indentation", lc: [";"] };
const NIM: Profile = {
  id: "nim", ext: [".nim"], kws: "proc|func|method|iterator|template|macro|converter|type",
  block: "indentation", lc: ["#"], bc: [["#[", "]#"]], imports: /^\s*(?:import|include|from)\s/,
};
// --- Data, markup, configuration ---
const SQL: Profile = {
  id: "sql", ext: [".sql"],
  extra: [/^\s*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|UNIQUE\s+INDEX|TRIGGER|TYPE|SCHEMA|SEQUENCE|DATABASE|EXTENSION)\b/i],
  block: "semicolon", lc: ["--"], bc: C_BC,
};
const CSS: Profile = {
  id: "css", ext: [".css", ".scss", ".less"],
  kws: "@media|@supports|@keyframes|@font-face|@mixin|@function|@layer|@container|@page",
  extra: [/^[^\s@{}/*][^{};]*?\s*\{\s*$/, /^\$[\w-]+\s*:/],
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*@(?:import|use|forward)\s/,
};
const HTML: Profile = {
  id: "html", ext: [".html", ".htm", ".xhtml", ".xml", ".svg", ".jsp", ".erb"],
  extra: [/^\s*<(?<balise>h[1-6]|section|article|nav|header|footer|main|aside|form|table|template|script|style|head|body|dialog)\b/,
    /<[\w-]+[^>]*\sid=["'][^"']+["']/],
  block: "indentation", bc: [["<!--", "-->"]],
};
const MD: Profile = {
  id: "markdown", ext: [".md", ".markdown", ".mdx"], extra: [/^#{1,6}\s/],
  block: "headings", bc: [["```", "```"], ["<!--", "-->"]], level: (l) => /^#+/.exec(l)?.[0].length ?? 9,
};
const TEX_RANKS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const LATEX: Profile = {
  id: "latex", ext: [".tex"], extra: [/^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{/],
  block: "headings", lc: ["%"], level: (l) => TEX_RANKS[/\\(\w+)/.exec(l)?.[1] ?? ""] ?? 9,
};
const YAML: Profile = { id: "yaml", ext: [".yml", ".yaml"], extra: [/^ {0,2}[\w"'./$-][^:#]*:(\s|$)/], block: "indentation", lc: ["#"] };
const TOML: Profile = { id: "toml-ini", ext: [".toml", ".ini", ".cfg", ".properties"], extra: [/^\s*\[\[?[^\]]+\]\]?\s*$/], block: "headings", lc: ["#", ";"] };
const JSON_: Profile = {
  id: "json", ext: [".json", ".jsonc", ".json5", ".ipynb"], extra: [/^\s*"(?<key>[^"]+)"\s*:/],
  block: "indentation", lc: ["//"], minLevel: true,
};
const MAKE: Profile = {
  id: "makefile", ext: [".mk", ".make"], files: /^(GNU)?[Mm]akefile$/,
  extra: [/^(?<target>[\w.%/$()-][^:=#\s]*(?:\s+[^:=#\s]+)*)\s*::?(?!=)/, /^define\s/], block: "indentation", lc: ["#"],
};
const DOCKER: Profile = {
  id: "dockerfile", ext: [".dockerfile"], files: /^(Docker|Container)file(\..+)?$/,
  extra: [/^\s*(?:FROM|ENTRYPOINT|CMD|EXPOSE|ARG|ENV|WORKDIR|USER|VOLUME|HEALTHCHECK|LABEL)\b/i], block: "headings", lc: ["#"],
};
const CMAKE: Profile = {
  id: "cmake", ext: [".cmake"], files: /^CMakeLists\.txt$/,
  extra: [/^\s*(?:function|macro|project|add_executable|add_library|add_subdirectory|option)\s*\(/i], block: "indentation", lc: ["#"],
};
const HCL: Profile = {
  id: "hcl", ext: [".tf", ".tfvars", ".hcl", ".nomad"],
  extra: [/^(?:resource|data|module|variable|output|provider|locals|terraform|job|group|task|service)\b/],
  block: "braces", lc: ["#", "//"], bc: C_BC,
};
const PROTO: Profile = {
  id: "protobuf", ext: [".proto"], kws: "message|service|enum|rpc|oneof|extend|syntax|package",
  block: "braces", lc: ["//"], bc: C_BC, imports: /^\s*import\s/,
};
const GRAPHQL: Profile = {
  id: "graphql", ext: [".graphql", ".gql"],
  extra: [/^(?:type|input|enum|interface|union|scalar|schema|query|mutation|subscription|fragment|extend|directive)\b/],
  block: "braces", lc: ["#"],
};
const ASM: Profile = { id: "assembleur", ext: [".s", ".asm"], extra: [/^(?<etiquette>[\w.$]+):/], block: "headings", lc: [";", "#", "//"] };
const TEXT: Profile = { id: "text", ext: [".txt", ".log", ".csv", ".tsv"], extra: [], block: "headings" };

/** Universal fallback: common keywords, C-style functions, column-0 lines that open a block. */
export const GENERIC: Profile = {
  id: "generic",
  extra: [
    /^\s*(export\s+)?(pub(\([^)]*\))?\s+)?(public\s+|private\s+|protected\s+|static\s+|async\s+)*(func|fn|def|defn|function|sub|proc|class|struct|interface|trait|impl|enum|type|module|package|object|record|namespace|macro)\s/,
    C_FUNC,
    /^[A-Za-z_@.#$][^=;]*\{\s*$/,
  ],
  block: "auto", lc: ["//", "#", ";", "--"], bc: C_BC,
};

export const PROFILES: Profile[] = [
  TS, JS, WEBCOMP, PY, C, CPP, JAVA, CSHARP, KOTLIN, SCALA, GROOVY, SWIFT, GO, RUST, DART, ZIG, SOLIDITY, OBJC,
  PHP, RUBY, LUA, ELIXIR, JULIA, R, PERL, SHELL, POWERSHELL, VIM,
  HASKELL, OCAML, FSHARP, ERLANG, CLOJURE, LISP, NIM,
  SQL, CSS, HTML, MD, LATEX, YAML, TOML, JSON_, MAKE, DOCKER, CMAKE, HCL, PROTO, GRAPHQL, ASM, TEXT,
];
