---
name: session-summary
disable-model-invocation: true
description: Use when the user asks which subagents ran in a Claude Code session, which models they used, or what the session cost. Gives a Markdown list of each subagent with task, model, cost, and duration, with nested subagents.
---

Run from the session's working directory, and show the output unchanged:

```sh
node <skill-base-dir>/scripts/summary.mjs [session-id]
```

With no argument, it summarizes the current session.
