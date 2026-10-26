/**
 * Compaction of shell command outputs: an error line is
 * never removed; the noise goes (colours, progress bars, git hints, repeated lines) and,
 * if it is still long, we keep head + tail + important lines.
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const IMPORTANT = /\b(error|errors|fail|failed|failure|failing|panic|exception|traceback|assert|fatal|warning|✗|✕|×)\b|^E\s|^FAIL\b|^\s*at\s.+:\d+/i;
const MAX_LINES = 150, HEAD_LINES = 40, QUEUE = 80, MAX_IMPORTANTES = 60;

export type Family = "test" | "git" | "install" | "build" | "other";

const TESTS = /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|^(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test)\b|^(python3?\s+-m\s+)?pytest\b|^go\s+test\b|^cargo\s+(test|nextest)\b|^node\s+--test\b|^(bundle\s+exec\s+)?rspec\b|^dotnet\s+test\b|^mvn\b.*\btest\b|^gradlew?\b.*\btest\b|^mix\s+test\b|^phpunit\b|^(flutter|dart)\s+test\b/;
const INSTALL = /^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update)\b|^pip3?\s+install\b|^(uv\s+)?pip\s+install\b|^poetry\s+(install|add)\b|^cargo\s+(fetch|update)\b|^go\s+(mod|get)\b|^bundle(\s+install)?$|^composer\s+(install|update|require)\b|^brew\s+(install|upgrade)\b|^(flutter|dart)\s+pub\s+(get|upgrade|add)\b/;
const BUILD = /^(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|check)\b|^(npx\s+)?(tsc|eslint|biome|prettier\s+--check|ruff|mypy|pyright|next\s+build|vite\s+build|webpack)\b|^cargo\s+(build|check|clippy)\b|^go\s+(build|vet)\b|^make\b|^gradlew?\b|^mvn\b|^dotnet\s+build\b|^swift\s+build\b|^flutter\s+(analyze|build)\b|^dart\s+(analyze|compile)\b/;
const GIT = /^git\s+(status|log|diff|show|branch|fetch|pull|push|commit|add|checkout|switch|merge|rebase|stash)\b/;

/** `.venv/bin/python -m pytest`, `uv run pytest`, `node_modules/.bin/jest` → `pytest`, `jest` (detection only). */
export function normalizeCommand(command: string): string {
  return command.trim()
    .replace(/^(?:\S*\/)?(?:\.?venv|env)\/bin\//, "")
    .replace(/^(?:\S*\/)?node_modules\/\.bin\//, "")
    .replace(/^(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+/, "")
    .replace(/^python[\d.]*\s+-m\s+/, "");
}

export function family(command: string): Family {
  const c = normalizeCommand(command);
  if (TESTS.test(c)) return "test";
  if (GIT.test(c)) return "git";
  if (INSTALL.test(c)) return "install";
  if (BUILD.test(c)) return "build";
  return "other";
}

/** Shared cleanup: colours, carriage returns (progress), spaces, blank and repeated lines. */
function clean(raw: string): string[] {
  const lines = raw.replace(ANSI, "").split("\n").map((l) => {
    const r = l.split("\r").filter((s) => s.trim()); // progress bar: last state only
    return (r[r.length - 1] ?? "").trimEnd();
  });
  const out: string[] = [];
  let reply = 0;
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (!l.trim() && (!prev || !prev.trim())) continue; // at most one blank line in a row
    if (prev !== undefined && l === prev && l.trim()) { reply++; continue; }
    if (reply) { out[out.length - 1] += `  (×${reply + 1})`; reply = 0; }
    out.push(l);
  }
  if (reply) out[out.length - 1] += `  (×${reply + 1})`;
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/** Keeps head + tail + important lines from the middle when it is too long. */
function cutAt(lines: string[], max = MAX_LINES): string[] {
  if (lines.length <= max) return lines;
  const middle = lines.slice(HEAD_LINES, lines.length - QUEUE);
  const kept = middle.filter((l) => IMPORTANT.test(l)).slice(0, MAX_IMPORTANTES);
  const omittedCount = middle.length - kept.length;
  return [...lines.slice(0, HEAD_LINES), `[… ${omittedCount} lines omitted by token-eco; important lines kept …]`, ...kept, ...lines.slice(-QUEUE)];
}

const GIT_NOISE = /^\s*\(use "git .*"\)\s*$|^\s*\(use "git .* to .*\)\s*$|^no changes added to commit|^\s*\(commit or discard the untracked or modified content in submodules\)/;
const INSTALL_NOISE = /^npm (warn|WARN) deprecated|^\s*(Downloading|Collecting|Using cached|Requirement already satisfied|Fetching|Resolving|Progress|Downloaded|Compiling|Checking|Installing collected packages)\b|^\s*[|/\\-]\s*$|^\s*\d+(\.\d+)?\s*(k|M)?B\s*\/\s*\d/;
const TEST_SUMMARY = /\b(tests?|passed|failed|failures?|errors?|skipped|pending|todo|suites?|ok|FAIL|PASS|duration|Ran \d+|examples?|assertions?)\b/i;

export function compact(command: string, raw: string, exitCode: number): string {
  let lines = clean(raw);
  const f = family(command);
  if (f === "git") lines = lines.filter((l) => !GIT_NOISE.test(l));
  if (f === "install") lines = lines.filter((l) => !INSTALL_NOISE.test(l) || IMPORTANT.test(l));
  if (f === "build") lines = lines.filter((l) => !/^\s*(Compiling|Checking|Downloaded|Fresh)\s/.test(l));
  if (f === "test" && exitCode === 0 && lines.length > 20) {
    // Success: only the summary lines matter (usually at the end of the output).
    const summary = lines.filter((l) => TEST_SUMMARY.test(l) && !/^\s*(✓|✔|√|ok\s+\d|PASS\s)/.test(l)).slice(-15);
    const okCount = lines.filter((l) => /^\s*(✓|✔|√|ok\s|PASS\s|test .* \.\.\. ok)/.test(l)).length;
    lines = [`[token-eco: tests passed — ${okCount} passing lines hidden]`, ...summary];
  }
  return cutAt(lines).join("\n");
}
