# Adoption benchmark (multi-agent, headless Claude Code)

2026-10-27 · 3 trial(s) per cell · total spent $11.40 · fixture: server/ + 2 specs > 300 lines + orchestrator CLAUDE.md + reviewer/producer agents.
native = token-eco sealed off (tools disallowed, hook off) · eco-before = plugin + token-eco:eco + hook, reviewer `tools: Read, Grep, Glob` · eco-after = same, reviewer also gets token-eco read/search.

| Model | Task | Variant | Success | Cost | vs native | Turns main / sub | Coverage main | Coverage sub | Bash file reads (avg) | Hook redirects | Subagent model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet | t6-review | native | 3/3 | $0.194 | – | 2.7 / 3.0 | – | 0% | 0.0 (0 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t6-review | eco-before | 3/3 | $0.238 | **22%** | 2.0 / 3.0 | – | 0% | 0.0 (0 KB) | 1.0 | claude-sonnet-5.5 |
| sonnet | t6-review | eco-after | 3/3 | $0.237 | **22%** | 2.3 / 4.0 | – | 67% | 0.0 (0 KB) | 1.0 | claude-sonnet-5.5 |
| sonnet | t7-feature | native | 3/3 | $0.262 | – | 3.0 / 4.7 | – | – | 3.3 (16 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t7-feature | eco-before | 3/3 | $0.265 | **1%** | 2.7 / 5.3 | – | 100% | 0.7 (0 KB) | 0.0 | claude-sonnet-5.5 |
| sonnet | t7-feature | eco-after | 3/3 | $0.259 | **-1%** | 3.0 / 5.7 | – | 100% | 1.0 (1 KB) | 0.0 | claude-sonnet-5.5 |
| opus | t6-review | native | 3/3 | $0.391 | – | 2.0 / 3.0 | – | 0% | 0.0 (0 KB) | 0.0 | claude-sonnet-5.5 |
| opus | t6-review | eco-before | 3/3 | $0.406 | **4%** | 2.0 / 3.0 | – | 0% | 0.0 (0 KB) | 1.0 | claude-sonnet-5.5 |
| opus | t6-review | eco-after | 3/3 | $0.369 | **-6%** | 2.0 / 3.7 | – | 39% | 0.0 (0 KB) | 0.7 | claude-sonnet-5.5 |
| opus | t7-feature | native | 3/3 | $0.399 | – | 2.0 / 4.7 | – | – | 3.0 (15 KB) | 0.0 | claude-sonnet-5.5 |
| opus | t7-feature | eco-before | 3/3 | $0.394 | **-1%** | 2.0 / 6.3 | – | 100% | 2.0 (2 KB) | 0.0 | claude-sonnet-5.5 |
| opus | t7-feature | eco-after | 3/3 | $0.386 | **-3%** | 2.3 / 5.3 | – | 90% | 0.7 (1 KB) | 0.0 | claude-sonnet-5.5 |

Coverage = token-eco read/search/edit ÷ (those + built-in Read/Grep/Glob/Edit/MultiEdit), from the session logs. Cost = total_cost_usd (subagents included).
The subagent model follows your settings (CLAUDE_CODE_SUBAGENT_MODEL): with Opus as main model the subagents may run on Sonnet, as in real use.
No run excluded.
Few trials = high variance: a gap of a few % is noise.
