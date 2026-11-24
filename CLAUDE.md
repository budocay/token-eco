# token-eco

Claude Code plugin that tries to cut token usage: an MCP server of token-saving file tools (`read`, `search`,
`edit`, `eco_report`), a strict main agent (`eco`) plus a cheap explorer (`eco-explore`), hooks (session guidance,
compact Bash output, redirect of expensive Read/Grep/`cat`), and a local savings dashboard.
User docs: `README.md` (keep `README.fr.md` in sync). Private working notes, in French and git-ignored: `ETAT.md` —
read its top section first when resuming work.

## Layout

- `.claude-plugin/` — `plugin.json`, `marketplace.json`. `.mcp.json` starts `server/dist/index.js`.
- `settings.json` — `"agent": "token-eco:eco"` (makes the strict agent the default main agent).
- `agents/`, `commands/` (`/eco-stats`, `/eco-dashboard`, `/eco-audit`, `/eco-statusline`, `/eco-adopt`),
  `hooks/hooks.json` (SessionStart, SubagentStart, PreToolUse on `Read|Grep|Bash` → `server/dist/hook.js`).
- `server/src/`
  - `index.ts` — MCP server, tool schemas and descriptions.
  - `tools/` — `read.ts` (dispatch), `outline.ts`, `readSymbol.ts`, `readRange.ts`, `searchCompact.ts`, `batchEdit.ts`.
  - `languages/` — `engine.ts` + `profiles.ts`: regex-based declaration/import detection per language (no parser).
  - `hook.ts` — guidance injection (`guidance.ts`), Bash rewrite to `run.js`, Read/Grep/`cat` redirection.
  - `run.ts` + `compact.ts` — run a command, compact its output by family (test/git/install/build), same exit code.
  - `db.ts` — SQLite (`node:sqlite`) in `~/.token-eco/eco.db`; `project.ts` groups worktrees under the main repo.
  - `sessions.ts`, `insights.ts`, `audit.ts`, `stats.ts` — real costs and tool coverage from the Claude Code logs.
  - `web.ts` + `public/index.html` — dashboard on `127.0.0.1:4777`. `cli.ts` — `stats|statusline|dashboard|serve|stop`.
  - `config.ts`, `pricing.ts`, `tokens.ts` (1 token ≈ 4 chars, the single place to change), `types.ts` (`ToolResult`).
- `server/bench/` — offline accuracy bench, paid A/B and adoption benches, session cost from logs.
- `server/dist/` — committed esbuild bundles; the installed plugin runs from them.

## Commands

```
cd server
npm test            # node:test, runs the .ts files directly (Node >= 22.13)
npm run typecheck
npm run build       # → dist/index.js, cli.js, hook.js, run.js
```

`npm run bench` is free. `bench:ab` and `bench:adoption` call `claude -p` and cost money: never run them without
the user's agreement on a budget (`--dry` is free).

## Rules

- Everything visible is in **English**: tool names, parameters, tool output, hook messages, commands, agents, CLI,
  JSON API, database keys, dashboard, manifests, commits. French only in `ETAT.md` and `README.fr.md`.
- After changing `server/src/`: test, typecheck, **build, and commit `server/dist/`** with the change.
- Release: bump the version in `server/package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  and `server/src/index.ts`, then build, test, commit. One commit per step.
- Keep tool descriptions, agent prompts and the session guidance short: they are in the prompt of every turn.
- Savings are estimates: `native − returned`, never hidden when negative. Report benchmark results as measured,
  including when the plugin does not help.
- Never tell the user a Claude Code option or variable exists without checking it (binary strings, or a
  `claude -p --model haiku` trial).
- Tests must not touch real data: use `TOKEN_ECO_HOME=<temp dir>`.
- Git: `main` is the public branch (github.com/budocay/token-eco); the user pushes. The local `archive` branch
  holds private files: never push it, never `git push --all`. Do not un-ignore the files listed in `.gitignore`.
- Do not copy code from other plugins, and do not name them in published files.
- The root `.mcp.json` only works inside the installed plugin (`${CLAUDE_PLUGIN_ROOT}`). Opened as a project, this
  folder must not enable it (`"disabledMcpjsonServers": ["token-eco"]` in `.claude/settings.local.json`), or Claude
  Code reports a failed `token-eco` server next to the working plugin one.
- Prices: `server/src/pricing.ts`, newest model of each family first (unlisted versions fall back to it). Check the
  official page before changing a price and update `PRICES_CHECKED`.
- macOS has no `timeout`: use `perl -e 'alarm 90; exec @ARGV' <cmd>`. After a build, restart the dashboard
  (`node server/dist/cli.js stop`, then `serve`) or it keeps the old code.
