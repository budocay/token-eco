# token-eco

A personal Claude Code plugin that tries to cut token usage (see **Benchmarks** for what it does and does not
achieve). It brings:

- an **MCP server** of token-saving file tools;
- a short **session guidance** (SessionStart hook) so the default agent uses them and batches its calls;
- an opt-in strict agent `eco` (plus `eco-explore`, a cheap read-only explorer on Haiku);
- a **PreToolUse hook** for every agent: compact Bash output, expensive Read/Grep calls redirected;
- a **local web dashboard**, per project, and a terminal summary of the (**estimated**) savings.

## MCP tools

| Tool | What it does | "Native" reference used for the estimate |
|---|---|---|
| `read` | `name` → that symbol's code (doc, `template <…>`, overloads; definition preferred over prototype); `start`/`end` → range; `pattern` → matching lines of the file with context; nothing → whole file if short, else an outline; `targets` → up to 20 reads in one call (cap ≈ 10K tokens) | whole file / Read of the same range |
| `search` | regex grouped by file, exact totals; `mode` `lines`/`files`/`count`; `symbols: true` → each hit labelled with its enclosing function/class (`› name L12-30`); `expand: true` → the whole enclosing function/class of each hit (≤ 150 lines each, ≈ 6K tokens per search): search + read in one call; `queries` → up to 10 searches in one call; no `pattern` + `glob` = file list | same lines in `grep -rn` format (+ Read of the expanded ranges) |
| `edit` | N exact replacements (`old_string`/`new_string`/`replace_all`) in one call, all or nothing; when a text is not found, the error shows the closest passage (other indentation, matching line, shared words) to copy exactly | snippets returned by N native `Edit` calls |
| `eco_report` | savings summary; `dashboard: true` starts the dashboard | – |

**Why batching**: every tool call is a full turn that re-reads the whole context from the prompt cache (≈ 75K
tokens per turn in a real session), so the number of calls drives the cost more than the size of each result.
All tools accept batches, and the session guidance asks for them.

**Default: strict main agent `eco`** (`settings.json` → `"agent": "token-eco:eco"`). In the real-session runs it
processed 6-10% fewer tokens than plain Claude Code (smaller context, fewer cache reads), while the "tools only" mode
did not (see Benchmarks); the dollar cost was about the same because it wrote more output. To use your usual agent
instead (it still gets the tools, the 5-line session guidance and the hook), remove the `"agent"` line from the
plugin's `settings.json`. The `eco` agent has no built-in Read/Grep/Glob/Edit/NotebookEdit, and
none of the rarely used automation/remote tools (Cron*, DesignSync, worktrees, PushNotification, RemoteTrigger,
ReportFindings, ScheduleWakeup, SendMessage, Workflow, ListAgents). Measured: running as a custom agent costs ~5K extra
prompt tokens per session; with these removals the eco prefix is 39.3K tokens vs 40.0K for plain Claude Code (44.2K
before). It keeps Task, Bash, Write, WebFetch, WebSearch, Monitor, TaskStop, Skill and ToolSearch. To get a removed tool
back, delete it from `disallowedTools` in `agents/eco.md`. `alwaysLoad: true`: tools loaded upfront, no `ToolSearch` turn.

## Hook (every agent, including yours)

- **Compact Bash output**: tests, builds, installs and git commands are transparently rewritten to `server/dist/run.js`
  (exit code kept; errors and failures always kept). Detects tools run through `.venv/bin/`, `node_modules/.bin/`,
  `uv run`/`poetry run`, `python -m`. In lists like `cd x && pytest -q; git status` (`;`, `&&`, `||`), each noisy
  part is rewritten and the others kept verbatim; `| tail -N`, `| head -N` and `2>&1` are handled.
  Permissions are respected: a deny rule on any part → nothing rewritten; every part allowed (or git
  status/log/diff/show, `cd`) → allowed; otherwise Claude Code asks as usual. Anything with `$(…)`, backticks,
  heredocs, `( )`/`{ }`, loops/conditions, background `&` or watch/dev modes is left alone.
- **Read of a big file** (> 300 lines, no offset/limit) → refused once, and the message contains the outline (no wasted
  turn). **Grep in `content` mode** → refused once, pointing to `search`. The same call repeated within 10 minutes goes
  through, so an agent without the token-eco tools is never blocked.
- `/eco-adopt [agent…]`: adds the token-eco tools and a short guidance block to your agents that have a restricted
  `tools:` list (asks for confirmation, keeps `.bak` copies).

## Install

Requires Node ≥ 22.13 (`node:sqlite`). `server/dist/` is committed, nothing to build.

```
/plugin marketplace add budocay/token-eco
/plugin install token-eco@token-eco-marketplace
```
From a local clone instead: `/plugin marketplace add /path/to/token-eco`.
Restart Claude Code and check with `/mcp` that the `token-eco` server is connected.

## Usage

- `/eco-stats`: terminal summary: per-call estimates (today, 7 days, total, per tool, per project) and the **real
  sessions** of the last 7 days from the Claude Code logs (tokens per turn and per session, with vs without token-eco).
- `/eco-dashboard`: starts the dashboard on `http://127.0.0.1:4777` and opens the browser.
- `/eco-statusline`: savings in the Claude Code status line.
- Outside Claude Code: `node server/dist/cli.js <stats|statusline|dashboard|serve|stop>`.

**Dashboard**: project sidebar (all projects, or one, sorted by last activity, one colour each), period 7d/30d/90d/All,
model selector for pricing, KPIs (per-call estimates: dollars, tokens avoided, reduction, calls), a **Real sessions**
card (actual tokens per turn / per session and cost from the Claude Code logs, with vs without token-eco, recent
sessions), daily chart stacked by project (or by tool inside a
project) with a clickable legend, per-tool and per-project bars, pricing card, hook counters, filterable recent calls.
Light/dark/auto theme. Listens on 127.0.0.1 only and rejects foreign `Host` headers.

## Pricing and estimates

- Prices: official Anthropic table in `server/src/pricing.ts` (USD per million tokens, MTok; checked 2026-10-22).
- A tool result is written to the prompt cache once (5-minute write), then re-read from the cache on every later turn.
  So one saved token is worth `cacheWrite5m + laterTurns × cacheRead`. Default: Claude Sonnet 5.5, 10 later turns
  → $2.50 + 10 × $0.10 = **$3.50 per MTok saved**.
- Tokens are estimated at 1 token ≈ 4 characters (`server/src/tokens.ts`, the single place to change).
- Not counted: avoided round trips, nor the prior full read the native `Edit` requires.
- Display: tokens as `950`, `12.3K`, `4.56M` (exact value on hover); dollars as `$1.23`, `<$0.01`.

## Data and configuration

Everything lives in `~/.token-eco/` (override with `TOKEN_ECO_HOME`):
- `eco.db` (SQLite): one row per call (`ts`, `project`, `tool`, `returned_tokens`, `native_tokens_est`, `duration_ms`,
  `details`) and the hook `redirections`. Pre-0.4 databases are migrated in place automatically.
- `config.json`: `model` (a key of `pricing.ts`, e.g. `claude-opus-5.5`), `laterTurns`, `port`,
  `hook: { mode: "redirect" | "off", lineThreshold: 300 }`. Pre-0.4 keys are migrated automatically.

## Benchmarks

Reports are generated locally and not committed.

**Offline** (`cd server && npm run bench`, free → `server/bench/RESULTS.md`): tool output compared with the real syntax
tree (TypeScript compiler, Python `ast`) on zod, ajv, the MCP SDK and the Python stdlib (~260 files, 2,600 symbols):

| | TypeScript | JavaScript | Python |
|---|---|---|---|
| outline: declarations found / relevant lines | 96% / 92% | 100% / 98% | 100% / 98% |
| outline: size vs native Read (median) | 10% | 6% | 8% |
| read symbol: exact block / correct start | 92% / 99% | 100% / 100% | 100% / 100% |
| read symbol: size vs native Read | 5% | 9% | 4% |

`search` gives exactly the same results as `grep` (10 patterns out of 10) for about 47% of the `grep -rn` tokens.
Multi-language results (ctags ground truth): `node bench/languages.ts` → `server/bench/LANGUAGES.md`.

**Real A/B** (`npm run bench:ab -- --model sonnet --trials 4 [--tasks t4,t5]`, paid, capped by `--budget`): runs the
same tasks in `claude -p` with and without the plugin and compares real cost, context, turns and success →
`server/bench/AB.md`. Disable the installed plugin first. Results (Sonnet): v0.3 (t1-t5 × 4) eco −8% cost
(≈ −10% without the cold-cache bias, now removed by an uncounted warmup; `--no-warmup` to skip it); v0.4.1 (t4, t5 × 4)
−10% cost, 16/16 successes, −20% context. Floor ≈ −10% on short tasks (fixed prompt cost).

**Real sessions** (`node bench/session-cost.ts <dir> <dir>… [--latest] [--cold]`: real cost from the Claude Code
session logs, subagents included; `--cold` removes the warm-cache bias of the first turn). A 6-step session on
click 8.5.0 (explore, fix a bug, add a type, rename across files, review with a subagent, changelog), Sonnet 5.5,
same prompts, warm cache, 9 hidden acceptance checks. Cost vs plain Claude Code:

| Run | token-eco (tools, default) | token-eco strict agent |
|---|---|---|
| 1 (v0.4, cold-corrected) | +17% | – |
| 2 (v0.4) | −7% | – |
| 3 (v0.5.0) | 0% | −5% |
| 4 (v0.5.1) | +22% | +6% |
| 5 (v0.5.3, **Opus 5.5**) | −1% (tokens −14%) | **−13%** (tokens −32%, 27 turns vs 37) |

Every session passed 9/9. Tokens actually processed (all cache reads/writes + output): the strict agent used
−10% (run 3) and −6% (run 4); the tools-only mode +4% and +29%.

**Honest conclusion: no measurable dollar saving on real sessions with Sonnet 5.5; a modest token saving with the
strict agent (2 runs, to confirm). With Opus 5.5 the strict agent saved 13% of the cost and 32% of the tokens
(1 run, to confirm):** plain Opus reads whole files (18 Read, 17 Edit in that session) where plain Sonnet uses
`grep`/`sed`, so the targeted tools have more to save. Cache reads are cheap ($0.10/MTok) so fewer tokens barely move the bill, but
they matter for subscription limits and context length. Plain Sonnet already reads sparingly (`grep -A`, `sed -n` chained in one Bash call); the cost is driven by the number
of turns, which the plugin does not reduce reliably, and session-to-session variance (±15%) is larger than any
effect. Where it measurably helps: short targeted tasks (−10% in the A/B above), very long test/build outputs
(Bash compaction), full reads of very large files (redirected to an outline), and the usage dashboard.
Lessons turned into fixes: search kept indentation (copied into edits), failed `edit` batches now show the
closest passage so the retry takes one call.

## Development

```
cd server && npm install
npm test               # node:test
npm run typecheck
npm run build          # esbuild bundle → dist/index.js (MCP), cli.js, hook.js, run.js
```
Commit `server/dist/` after a build: the plugin runs from it.

## License

Personal project, provided as is. MIT (see `LICENSE`).
