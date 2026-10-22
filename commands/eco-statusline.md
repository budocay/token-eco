---
description: Show token-eco savings in the Claude Code status line
---

Install the token-eco status line in the user's `~/.claude/settings.json`:

1. Find the absolute path of this plugin's `server/dist/cli.js`: it is in the token-eco
   plugin folder (look under `~/.claude/plugins/` for `token-eco/server/dist/cli.js`; take
   the most recent version if several exist).
2. Read `~/.claude/settings.json`. If a `statusLine` already exists, show it and ASK whether
   to replace it (do nothing if the user declines).
3. Set: `"statusLine": { "type": "command", "command": "node <absolute path>/cli.js statusline" }`
   keeping every other setting intact, after copying the file to `settings.json.bak`.
4. Tell the user it appears on the next prompt (restart if not), and that removing the
   `statusLine` key undoes it.
