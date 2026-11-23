---
name: implement-spec
description: Use when the user has a spec and wants it built ("implement the spec", "build SPEC.md"). Takes `SPEC.md` at the working tree root, or a pasted spec or file. Gives the verified change and a short report.
---

# Implement Spec

Build the spec in a sized subagent, then verify. Do not write the code yourself. Do not re-open the spec.

If a step fails, try at most one quick alternative. Else tell the user and ask what to do.

## 1. Prepare

- Spec: the pasted text or named file, else `SPEC.md` at the repo root. If none, stop.
- Read the spec. Ask the user only about gaps that change the design. Decide small gaps and record them.
- Find the test, lint, and typecheck commands (`AGENTS.md`, `README`, package scripts).
- If the tree has changes, propose to commit them. On the default branch, propose a feature branch. Wait for the user, then record `HEAD` as the start point.

## 2. Pick the builder

- Tiers (latest version): **standard** = `sonnet` / `terra`, **strong** = `opus` / `sol`. Never `haiku` / `luna`.
- **Simple** (1–2 files, a pattern to copy): standard, low–medium effort.
- **Moderate** (several files, usual logic, new tests): standard, high effort.
- **Hard** (cross-cutting, concurrency, migrations, security, subtle logic): strong, high effort.
- If not sure, pick higher. A user choice wins. Set model and effort explicitly.
- For a spec with phases or one too large for one builder, use one builder per phase, in sequence, and verify each.

## 3. Brief the builder

Give:

- the spec path ("read it in full first") or the pasted text, plus your gap decisions and its phase
- the check commands, to run before it finishes
- the rules: stay in scope, do not change the spec, do not commit, do not do risky actions the spec does not ask for (migrations, new dependencies), do not ask questions
- the return: files changed, summary, deviations with reasons, check results, how to try it

## 4. Verify and report

- If the builder fails or reports a blocker, do not retry. Tell the user.
- Revert spec changes. Measure the diff from the start point, with untracked files.
- Small diff: read it yourself. Large diff (over ~500 lines or 10 files) or a hard build: give the spec and start point, not the builder's report, to a fresh strong reviewer. It returns deviations, unmet criteria, and bugs with file and line.
- Run the checks yourself. Check each acceptance criterion.
- If a deviation changes behavior or scope, or a criterion is not met, ask the user.

Report: **Changed** (key files), **Deviations**, **Builder** (difficulty, model, effort), **Checks**, **Criteria** (met or not), **Try it**. Do not commit unless asked.
