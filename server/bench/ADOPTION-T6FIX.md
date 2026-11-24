# Adoption benchmark (multi-agent, headless Claude Code)

2026-10-27 · 3 trial(s) per cell · total spent $1.93 · fixture: server/ + 2 specs > 300 lines + orchestrator CLAUDE.md + reviewer/producer agents.
native = token-eco sealed off (tools disallowed, hook off) · eco-before = plugin + token-eco:eco + hook, reviewer `tools: Read, Grep, Glob` · eco-after = same, reviewer also gets token-eco read/search.

| Model | Task | Variant | Success | Cost | vs native | Turns main / sub | Coverage main | Coverage sub | Bash file reads (avg) | Hook redirects | Subagent model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet | t6-review | native | 3/3 | $0.219 | – | 3.7 / 3.0 | – | 0% | 0.0 (0 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t6-review | eco-before | 3/3 | $0.194 | **-11%** | 2.0 / 4.3 | – | 0% | 0.0 (0 KB) | 1.0 | claude-sonnet-5.5 |
| sonnet | t6-review | eco-after | 3/3 | $0.228 | **4%** | 2.3 / 4.0 | – | 93% | 0.0 (0 KB) | 0.0 | claude-sonnet-5.5 |

Coverage = token-eco read/search/edit ÷ (those + built-in Read/Grep/Glob/Edit/MultiEdit), from the session logs. Cost = total_cost_usd (subagents included).
The subagent model follows your settings (CLAUDE_CODE_SUBAGENT_MODEL): with Opus as main model the subagents may run on Sonnet, as in real use.
No run excluded.
Few trials = high variance: a gap of a few % is noise.
