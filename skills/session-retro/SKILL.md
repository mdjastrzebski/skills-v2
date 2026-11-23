---
name: session-retro
disable-model-invocation: true
description: Use when the user asks for a retrospective of this agent session (or of another Claude Code or Codex session). Gives the 3–5 most costly impediments, such as failed or repeated tool calls, large outputs, slow steps or subagents, and unclear instructions, each with evidence and a concrete fix that the user can pick to apply.
---

# Session Retro

1. **Reflect first.** From your own context, write down where you struggled, waited, retried, or used many tokens, and why. Include user corrections and unclear instructions.
2. **Get script signals.** Run from the session's working directory:

   ```sh
   node <skill-base-dir>/scripts/retro.mjs [session-id | path/to/session.jsonl]
   ```

   With no argument, the script selects the latest main session for the current directory (Claude Code or Codex) with its subagents. It prints failed tool calls, repeats, token hotspots, and time hotspots.

   If the script fails or finds no session, tell the user in one line: `No script signals: <reason>`. Then continue with your own reflection only. Do not search for transcripts in other places.

3. **Merge** both sources into 3–5 impediments, most costly first. For each impediment, give:
   - What happened (one line).
   - Evidence: a script signal or your own observation.
   - Approximate cost (time, tokens, or count of retries), when known.
   - Root cause, if known.
   - Fix: the exact target file path and the proposed change (short text or diff).
4. **Choose the fix target** where the real cause is: project `AGENTS.md` or `CLAUDE.md`, a skill's `SKILL.md`, a new or changed script, tool permissions (`settings.json`), or user memory. For a symlinked skill, resolve the real path and say which repo it is in. If no useful fix exists, say so. Do not invent a fix.
5. **Ask** the user which fixes to apply: numbers, `all`, or `none`. Do not change any file before the user picks.
6. **Apply** only the picked fixes. List the changed files.
