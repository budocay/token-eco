# Adoption benchmark (multi-agent, headless Claude Code)

2026-10-28 · 8 trial(s) per cell · total spent $94.86 · fixture: server/ + 2 specs > 300 lines + orchestrator CLAUDE.md + reviewer/producer agents.
native = token-eco sealed off (tools disallowed, hook off) · eco-agent = native + main agent with the eco discipline written for the built-in tools (separates agent from tools) · eco-before = plugin + token-eco:eco + hook, reviewer `tools: Read, Grep, Glob` · eco-after = same, reviewer also gets token-eco read/search.

| Model | Task | Variant | Success | Cost | vs native | Turns main / sub | Coverage main | Coverage sub | Bash file reads (avg) | Hook redirects | Subagent model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet | t8-long | native | 8/8 | $2.382 | – | 12.4 / 56.1 | – | 0% | 15.6 (106 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t8-long | eco-agent | 8/8 | $1.978 | **-17%** | 8.9 / 44.6 | – | 0% | 16.1 (125 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t8-long | eco-before | 8/8 | $2.094 | **-12%** | 7.9 / 48.4 | – | 26% | 8.3 (56 KB) | 4.9 | claude-sonnet-5.5 |
| sonnet | t8-long | eco-after | 8/8 | $1.494 | **-37%** | 6.4 / 35.4 | – | 74% | 5.4 (42 KB) | 0.3 | claude-sonnet-5.5 |

Coverage = token-eco read/search/edit ÷ (those + built-in Read/Grep/Glob/Edit/MultiEdit), from the session logs. Cost = total_cost_usd (subagents included).
The subagent model follows your settings (CLAUDE_CODE_SUBAGENT_MODEL): with Opus as main model the subagents may run on Sonnet, as in real use.
No run excluded.
Few trials = high variance: a gap of a few % is noise.
