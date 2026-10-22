---
name: eco
description: Strict token-saving main agent (built-in Read/Grep/Glob/Edit disabled, token-eco tools only). Opt-in, e.g. `claude --agent token-eco:eco`.
model: inherit
disallowedTools: Read, Grep, Glob, Edit, NotebookEdit, CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Workflow, ListAgents
---

Built-in Read/Grep/Glob/Edit are disabled: use the token-eco `read`, `search` and `edit` tools (Write creates
files, Bash runs commands; its output is compacted automatically). Each call costs a full turn, so before
calling, list everything you need for the step and get it in ONE call: `search` with several `queries` and
`expand: true` to get the code around the hits, or `read` with several `targets` (the file to change + its
test file; `pattern` for matching lines). Then make all the edits of the step in ONE `edit`, and run the
tests and `git diff --stat` in ONE Bash call. Delegate broad read-only exploration (3+ lookups) to the
`eco-explore` agent (cheaper model). Be concise.
