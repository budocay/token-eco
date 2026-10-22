# token-eco

A personal Claude Code plugin that cuts token usage. It brings:

- an **MCP server** of token-saving file tools;
- a main **agent** `eco` that uses them (plus `eco-explore`, a cheap read-only explorer on Haiku);
- a **PreToolUse hook** for every agent: compact Bash output, expensive Read/Grep calls redirected;
- a **local web dashboard**, per project, and a terminal summary of the (**estimated**) savings.

## MCP tools

| Tool | What it does | "Native" reference used for the estimate |
|---|---|---|
| `read` | `name` → that symbol's code (doc, `template <…>`, overloads; definition preferred over prototype); `start`/`end` → range; nothing → whole file if short, else an outline; `targets` → up to 20 reads in one call (cap ≈ 10K tokens) | whole file / Read of the same range |
| `search` | regex grouped by file, exact totals; `mode` `lines`/`files`/`count`; `symbols: true` → each hit labelled with its enclosing function/class (`› name L12-30`); no `pattern` + `glob` = file list | same lines in `grep -rn` format (or Grep `files_with_matches`/`count`) |
| `edit` | N exact replacements (`old_string`/`new_string`/`replace_all`) in one call, all or nothing | snippets returned by N native `Edit` calls |
| `eco_report` | savings summary; `dashboard: true` starts the dashboard | – |

**Main agent `eco`** (`settings.json` → `"agent": "token-eco:eco"`): no built-in Read/Grep/Glob/Edit/NotebookEdit, and
none of the rarely used automation/remote tools (Cron*, DesignSync, worktrees, PushNotification, RemoteTrigger,
ReportFindings, ScheduleWakeup, SendMessage, Workflow, ListAgents). Measured: running as a custom agent costs ~5K extra
prompt tokens per session; with these removals the eco prefix is 39.3K tokens vs 40.0K for plain Claude Code (44.2K
before). It keeps Task, Bash, Write, WebFetch, WebSearch, Monitor, TaskStop, Skill and ToolSearch. To get a removed tool
back, delete it from `disallowedTools` in `agents/eco.md`. `alwaysLoad: true`: tools loaded upfront, no `ToolSearch` turn.

## Hook (every agent, including yours)

- **Compact Bash output**: tests, builds, installs and git commands are transparently rewritten to `server/dist/run.js`
  (exit code kept; errors and failures always kept). Also handles `cd x && cmd`, `cmd 2>&1 | tail -N`, `cmd | head -N`.
  Permissions are respected: deny rule → nothing rewritten; allow rule (or git status/log/diff/show) → allowed;
  otherwise Claude Code asks as usual. Other compound commands and watch/dev modes are left alone.
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

- `/eco-stats`: terminal summary (today, 7 days, total, per tool, per project).
- `/eco-dashboard`: starts the dashboard on `http://127.0.0.1:4777` and opens the browser.
- `/eco-statusline`: savings in the Claude Code status line.
- Outside Claude Code: `node server/dist/cli.js <stats|statusline|dashboard|serve|stop>`.

**Dashboard**: project sidebar (all projects, or one, sorted by last activity, one colour each), period 7d/30d/90d/All,
model selector for pricing, KPIs (dollars, tokens, reduction, calls), daily chart stacked by project (or by tool inside a
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
