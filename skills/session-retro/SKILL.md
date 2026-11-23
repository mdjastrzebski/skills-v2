---
name: session-retro
disable-model-invocation: true
description: Use when the user asks for a retrospective of this agent session (or of another Claude Code, Codex, or Cursor session). Gives the 3–5 most costly impediments, such as failed or repeated tool calls, large outputs, slow steps or subagents, and unclear instructions, each with evidence and a concrete fix that the user can pick to apply.
---

# Session Retro

1. **Reflect first.** From your own context, write down where you struggled, waited, retried, or used many tokens, and why. Include user corrections and unclear instructions.
   - Find goal loops: repeated attempts at the same goal (for example fix, run tests, fail, fix again). For each loop, note:
     - The goal.
     - The number of attempts and the end: success, stopped, or gave up.
     - What worked and what did not.
     - Drift: did the attempts go in a weird or unproductive direction just to reach the goal (hacks, weakened tests, workarounds, scope change)?
     - Feedback-loop speed: fast or slow, and why.
2. **Get script signals.** Pass the session ID when you know it. In Claude Code, the ID of this session is `${CLAUDE_SESSION_ID}`. In other harnesses, run with no argument from the session's working directory:

   ```sh
   node <skill-base-dir>/scripts/retro.mjs [session-id | path/to/session.jsonl]
   ```

   With no argument, the script selects the latest main session for the current directory (Claude Code, Codex, or Cursor) with its subagents. This can be a different session if more than one session runs in the same directory. It prints failed tool calls, repeats, token hotspots, time hotspots, and feedback loops (the same command run 3 or more times). The feedback loops are evidence for your goal loops. You judge drift from your own context. The script does not.

   If the script fails or finds no session, tell the user in one line: `No script signals: <reason>`. Then continue with your own reflection only. Do not search for transcripts in other places.

3. **Merge** both sources into 3–5 impediments, most costly first. Do not list small one-off retries. A goal loop is an impediment too. Fix examples: a faster check command, a stop rule after N attempts. For each impediment, give:
   - What happened (one line).
   - Evidence: a script signal or your own observation.
   - Approximate cost (time, tokens, or count of retries), when known. Before you give a cost, know what the number measures.
   - Root cause, if known.
   - Fix: the exact target file path and the proposed change (short text or diff).
4. **Choose the fix target** where the real cause is: project `AGENTS.md` or `CLAUDE.md`, a skill's `SKILL.md`, a new or changed script, tool permissions (`settings.json`), or user memory. For a symlinked skill, resolve the real path and say which repo it is in. If no useful fix exists, say so. Do not invent a fix.
5. **Ask** the user which fixes to apply: numbers, `all`, or `none`. Do not change any file before the user picks.
6. **Apply** only the picked fixes. List the changed files.
