---
name: summarize-changes
description: Use when the user asks to summarize, explain, or get an overview of a PR, branch, git range, or their current changes ("what does this PR do", "summarize my branch", "is this the right approach"). Takes a PR number or URL, a branch, or `A..B`; defaults to the current branch plus uncommitted changes. Gives a one-screen, high-level summary that answers the basic PR questions and its own follow-ups, for a human reviewer. Not for line-level code review.
---

# Summarize Changes

Give evidence and let the human judge; give no overall verdict. Read only: do not edit files, commit, push, post to GitHub, or use subagents.

1. **Collect.** Run `node <skill-dir>/scripts/collect-changes.mjs [target]`. On error, show the message and stop; if `gh` failed for a PR, ask for the branch name. If `files` is empty, say "no changes" and stop.
2. **Find the intent.** Use the spec or issue the user names, else `pr` (title, body, `linkedIssues`), else local `*SPEC*` or `PLAN*` files at the repo root (even if git ignores them), else changesets, ADRs, or docs in the diff, else issue keys in the branch name or commits, else commit messages. If none, write "intent inferred from code".
3. **Read.** Read the shape (`files`, `totals`, `commits`), then the diff (`node <skill-dir>/scripts/collect-changes.mjs --diff [target]`, same target as step 1; it includes untracked files) and the code around it, block by block. If the commit messages tell a story, use commits as blocks; else group files by purpose, not by folder. Track coverage: in depth, skimmed, collapsed, skipped.
4. **Large change** (`totals` over ~30 files or ~1,500 lines): read by priority: public interfaces, types, schemas, deleted code, entry points, core logic. Spot-check each mechanical pattern (renames, codemods, import moves), then collapse it into one line. Read in depth the files that break the pattern.
5. **Pass 1: answer the core questions.** Make them final before step 6.
   - **Matches intent:** yes, partly, or no, against the named source. **Not in this change:** up to 3 things the intent promises or implies that the diff does not do.
   - **Focused:** the size and the number of unrelated topics. If topics are unrelated, say "consider splitting".
   - **Main changes:** 2–6 blocks by purpose, one sentence each, each with a key file.
   - **Fits codebase:** does it follow the repo's patterns for similar things, or add a new pattern, dependency, or abstraction? Compare with 1–2 similar files in the repo and the agent docs (AGENTS.md, CLAUDE.md, and the files they link). Give evidence.
   - **Decisions** (real choices only, max 5) and **Assumptions** (non-trivial only, max 4): most impact on design and risk first; drop the rest. Mark each `stated` (PR, commits) or `inferred` (code). Name the rejected alternative when obvious.
   - **Risk:** `low`, `medium`, or `high`, from blast radius (what and who it affects), reversibility (data, schema, public API, wire format), and safety nets (tests, flags). Name the evidence.
   - **For review:** a read order (usually contracts, then implementation, then callers and tests). Then up to 3 places to look closely at, named by what they touch (migrations, auth, concurrency, public API, deleted behavior, input handling), not by what is wrong, each with a file and a risk level. Else "none".
6. **Pass 2: follow-ups.** Ask 2–3 questions that pass 1 raises (for example "Why is the retry in the client, not the server?"). Re-read the code for each and answer with a file. If the code, PR, and commits do not answer it, write `open: ask the author`.
7. **Print** the template, about one screen. One line per bullet; no point in two sections. Omit empty Decisions, Assumptions, Not in this change, and diagram; elsewhere write "none". Add a mermaid `flowchart` only for 4+ blocks with real data or control flow: one node per block, labeled edges, no file nodes. Show coverage if you did not read all files in depth. If the change is only generated or mechanical, say so in the TL;DR and skip the conditional sections. Then answer the user's follow-up questions.

```text
## Summary: <target>
`<PR # / branch / range>` · base `<base>` · N files, +X/−Y · uncommitted <included | not included> · <"all files read" | coverage: N in depth, N skimmed, N collapsed (<patterns>), N skipped>

### TL;DR
- <what and why, one line; intent source>
- Matches intent: <yes | partly | no>: <why>
- Focused: <yes | no>: <why>
- Risk: <low | medium | high>: <why, evidence>
- Fits codebase: <yes | partly | no>: <why>

### Details
**Main changes**
1. **<block>**: <one sentence>. `file`

<optional mermaid flowchart>

**Decisions**
- <decision> (<stated | inferred>); rejects <alternative>

**Assumptions**
- <assumption> (<stated | inferred>)

**Not in this change:** <item>; <item>

**For review:** read <block> → <block>. Look closely at: <what it touches> (`file`, <risk>); …

**Follow-ups**
- **Q:** <question> **A:** <answer> `file`
- **Q:** <question> **A:** open: ask the author
```
