---
name: session-summary
disable-model-invocation: true
description: Summarize subagents, models, costs, and durations in a Claude Code or Codex session.
---

Run from the session's working directory and show the output unchanged:

```sh
node <skill-base-dir>/scripts/summary.mjs [session-id | path/to/session.jsonl]
```

With no argument, the script selects the most recent session for the current directory. Pass a session ID or file path to select a specific session. Codex costs use standard API token prices as an estimate, not actual charges. Task names come from agent paths.
