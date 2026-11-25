# Adoption benchmark (multi-agent, headless Claude Code)

2026-11-25 · 4 trial(s) per cell · total spent $15.51 · fixture: server/ + 2 specs > 300 lines + orchestrator CLAUDE.md + reviewer/producer agents.
native = token-eco sealed off (tools disallowed, hook off) · eco-agent = native + main agent with the eco discipline written for the built-in tools (separates agent from tools) · eco-before = plugin + token-eco:eco + hook, reviewer `tools: Read, Grep, Glob` · eco-after = same, reviewer also gets token-eco read/search.

| Model | Task | Variant | Success | Cost | vs native | Turns main / sub | Coverage main | Coverage sub | Bash file reads (avg) | Hook redirects | Subagent model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet | t8-long | eco-after | 4/4 | $3.878 | – | 5.8 / 51.5 | – | 95% | 1.3 (1 KB) | 0.0 | claude-opus-5.5 |

Coverage = token-eco read/search/edit ÷ (those + built-in Read/Grep/Glob/Edit/MultiEdit), from the session logs. Cost = total_cost_usd (subagents included).
The subagent model follows your settings (CLAUDE_CODE_SUBAGENT_MODEL): with Opus as main model the subagents may run on Sonnet, as in real use.
No run excluded.
Few trials = high variance: a gap of a few % is noise.
