---
name: prepare-spec
description: Use when the user gives a rough idea and wants it turned into a spec, or says "spec this out", or "prepare a spec". Gives an approved SPEC.md that an implementing agent can build from. Does not write code.
---

# Prepare Spec

Turn a rough idea into an approved `SPEC.md`. Do not write code.

## 1. Ground yourself

Read enough of the codebase to know where the change would live and which patterns it should follow. Never ask what the code can answer.

## 2. Grill

- Ask one question per message, 25 at most.
- Go from fundamentals to details: goal and problem, assumptions, scope, behavior, interfaces, edge cases.
- Give 2–4 options and mark one as recommended, with a reason.
- Push back when an answer conflicts with an earlier answer or with the code.
- Decide the smaller details yourself and record them as assumptions.
- Stop when no remaining answer would change the design, or when the user says "you decide".
- If you reach 25 questions, record the open items as assumptions and go to approval.

## 3. Get approval

Show a condensed view of the spec: goal, scope, key decisions, assumptions, and acceptance criteria. Wait for approval. If the user asks for changes, change the summary and show it again.

## 4. Write SPEC.md

Write `SPEC.md` at the working tree root for an agent that did not see this conversation. Describe what and why, not a code-level plan:

- goal and problem
- scope: in and out
- decisions and assumptions, each with its reason
- behavior: inputs, outputs, errors, edge cases
- interfaces and data shapes, only where visible to the user or a contract
- acceptance criteria as testable checks
- relevant files and patterns from step 1

Ask before you overwrite an existing `SPEC.md`. Then keep `SPEC.md` out of git:

```sh
node <skill-base-dir>/scripts/exclude-spec.mjs
```

The script adds `/SPEC.md` to `$(git rev-parse --git-common-dir)/info/exclude` once, and skips outside git.
