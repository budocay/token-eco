---
description: Make your existing agents use token-eco tools (adds them to restricted `tools:` lists + a short guidance block)
argument-hint: "[agent-name…] (default: all)"
---

Goal: let the user's existing subagents benefit from the token-eco MCP tools.

1. List agent files in `~/.claude/agents/` and `.claude/agents/` (project). If arguments are
   given ($ARGUMENTS), keep only those agent names. Skip the token-eco agents themselves.
2. Tool names: `mcp__plugin_token-eco_token-eco__` + `read`, `search`, `edit` (current set).
   Older token-eco names to REPLACE if present: outline, read_symbol, read_range → read;
   batch_edit → edit (search unchanged). Check the names exist in YOUR available tool list;
   if the prefix differs, use the names you see, or stop and tell the user to check `/mcp`.
3. For each agent, plan:
   - If its frontmatter has a `tools:` field (restricted list): add token-eco tools matching
     what it already has (Read → read; Grep or Glob → search; Edit → edit), replace older
     token-eco names, keep the existing format (comma list or YAML list). No `tools:` field
     = the agent already inherits every tool: do not add one.
   - Insert or REPLACE the block between the markers (keep exactly one) at the end of the body:
     ```
     <!-- token-eco:start -->
     To save tokens, prefer the token-eco tools: read (outline, name=symbol, start/end, or
     targets=[…] for several reads in one call) instead of a full Read, search instead of
     Grep/Glob (symbols: true shows the enclosing function), edit to group edits.
     Fall back to built-in tools only if they fail.
     <!-- token-eco:end -->
     ```
4. Show a compact summary table (agent, tools added/replaced, block added/updated) and ASK
   for confirmation before writing anything.
5. After confirmation: copy each file to `<file>.bak` (overwrite older backups only if the
   user agrees), then apply the edits. Report briefly and remind the user to restart Claude
   Code. To undo: restore the `.bak` files.
