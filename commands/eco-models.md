---
description: Which model each of your subagents really runs on, and a cheaper one where its role allows (you confirm each change)
argument-hint: "[agent-name…] (default: all)"
---

Goal: propose a sensible model per subagent, from what the logs measured, and apply only what the user accepts.

1. Call the `eco_report` MCP tool of the token-eco server with `models: true`. It returns, per subagent type over
   the last 30 days: role, launches, cost, the models it really ran on, how often its launch carried an explicit
   model, the suggested model and the estimated saving. If arguments are given ($ARGUMENTS), keep those agents.
2. Find the agent files: `.claude/agents/` (project) and `~/.claude/agents/`. Read only the frontmatter of the
   agents that have a suggestion. Built-in and plugin agents (`general-purpose`, `Explore`, `name:agent`) have no
   file to edit: list them, they follow `CLAUDE_CODE_SUBAGENT_MODEL` in `~/.claude/settings.json` "env".
3. Show one compact table: agent, role, cost, ran on, `model:` in its file, suggested, saving. Then say plainly:
   - the suggestion comes from the role only; answer quality is NOT measured;
   - for `judgment` agents (security, review, architecture) keeping the current model is a valid choice;
   - where "ran on" is above the file's `model:`, the launches forced a model: changing the file will not help,
     the cap below will.
4. ASK which changes to apply (all / some / none). Never edit before the answer.
5. Apply: set or add `model:` in the frontmatter of the accepted agents (`haiku`, `sonnet`, `opus`), nothing else.
6. If launches forced a model above the user's choice, offer the cap: in `~/.token-eco/config.json`, set
   `"subagents": { "maxExplicitModel": "sonnet" }` (or `haiku` / `opus`). The hook then drops any explicit model
   above it at launch, so the agent's own `model:` applies again. An agent that must stay on Opus keeps
   `model: opus` in its file. Edit that config only if the user agrees.
7. Report briefly, remind the user to restart Claude Code, and to run `/eco-models` again in a week to compare.
