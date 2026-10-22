/**
 * Short guidance injected at session start (SessionStart hook → additionalContext), for the default
 * Claude Code agent: it keeps its built-in tools, so this is what makes it prefer the token-eco tools.
 * Kept short on purpose: it is part of the prompt of every turn.
 */
export const GUIDANCE = [
  "token-eco: every tool call is a full turn that re-reads the whole context, so the NUMBER of calls is what costs. Plan, then batch:",
  "- one `search` with all your `queries`; `expand: true` returns the whole function/class around each hit (search + read in one call);",
  "- one `read` with all `targets` (`name` = one symbol, `start`/`end`, `pattern` = matching lines; no option = whole file if short, else outline);",
  "- one `edit` with every change of a step; one Bash call chaining related commands (e.g. tests, then `git diff --stat`).",
  "Prefer these tools to Read/Grep/Glob/Edit and to cat/grep/sed in Bash. Never re-read what you just read or wrote.",
].join("\n");

export function sessionStartOutput(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: GUIDANCE } });
}
