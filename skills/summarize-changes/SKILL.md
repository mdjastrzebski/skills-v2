---
name: summarize-changes
description: Use when the user asks to summarize, explain, or get an overview of a PR, branch, git range, or their current changes ("what does this PR do", "summarize my branch", "is this the right approach"). Takes a PR number or URL, a branch, or `A..B`; defaults to the current branch plus uncommitted changes, against the PR base when one exists. Gives a one-screen, high-level summary that answers the basic PR questions for a human reviewer. Not for line-level code review.
---

# Summarize Changes

Give evidence and let the human judge; give no overall verdict. Read only: do not edit files, commit, push, post to GitHub, or use subagents.

1. **Collect.** Run `node <skill-dir>/scripts/collect-changes.mjs [target]`. On error, show the message and stop; if `gh` failed for a PR, ask for the branch name. If a sandbox or blocked network caused a `gh` error (also in `prLookup`), run the command again one time with network access. If `files` is empty, say "no changes" and stop; report other `prLookup` errors. `gh_missing` is not an error: continue without PR data. Show `baseRef` as `<base>` in the template, even when it is not the default branch.
2. **Find the intent.** Use the spec or issue the user names, else `pr` (title, body, `linkedIssues`), else local `*SPEC*` or `PLAN*` files at the repo root (even if git ignores them), else changesets, ADRs, or docs in the diff, else issue keys in the branch name or commits, else commit messages. If none, write "intent inferred from code".
3. **Read.** Read the diff with `node <skill-dir>/scripts/collect-changes.mjs --diff [target] -- <path>...`, with the same target as step 1, in batches of about 4,000 tokens (estimate from `added` and `removed`). Split a large file with `--lines <start>-<end>`; a last line `[diff continues: ...]` gives the rest. Read implementation first, then tests in separate calls; go in depth on risky paths. Track each file's coverage: `in depth`, `skimmed`, `collapsed`, or `skipped`; a rename counts once.
4. **Large change** (`totals` over ~30 files or ~1,500 lines): read by priority: public interfaces, types, schemas, deleted code, entry points, core logic. Spot-check each mechanical pattern (renames, codemods, import moves), then collapse it into one line. Read in depth the files that break the pattern.
5. **Answer the core questions.**
   - **Matches intent:** yes, partly, or no, against the named source. **Not in this change:** up to 3 things the intent promises that the diff does not do. **Not in intent:** up to 3 things the diff does that the intent does not mention.
   - **Focused:** the size and the number of unrelated topics. If topics are unrelated, say "consider splitting".
   - **Main changes:** 2–6 blocks by purpose, one sentence each, each with a key file.
   - **Fits codebase:** does it follow the repo's patterns, or add a new pattern, dependency, or abstraction? Compare with 1–2 similar files and the agent docs (AGENTS.md, CLAUDE.md, and the files they link).
   - **Decisions** (real choices only, max 5) and **Assumptions** (non-trivial only, max 4), most impact first. Mark each `stated` (PR, commits) or `inferred` (code). Name the rejected alternative when obvious.
   - **Risk:** `low`, `medium`, or `high`, from blast radius, reversibility (data, schema, public API, wire format), and safety nets (tests, flags). Name the evidence.
   - **For review:** a read order (usually contracts, then implementation, then callers and tests), then up to 3 places to look closely at, from the **Risk** boundaries, each with a file and a risk level.
6. **Verify.** Check the main claims with quick read-only commands (for example, run the tests) when repo rules permit. Under **Evidence**, say what the checks showed and what rests on reading only. Remove points that appear in two sections.
7. **Print** the template, about one screen. Put the verdict word first in each answer. Each bullet holds one fact in about 15 words; give one item per bullet, not a list joined by `;`. Omit empty Gap, Decision, Assumption, and diagram lines; elsewhere write "none". Add a mermaid `flowchart` only for 4+ blocks that pass data or control to each other: one node per block, labeled edges, no file nodes. If the change is only generated or mechanical, say so in the what-and-why line and skip the omittable lines. Then answer the user's follow-up questions.

```text
## Summary: <target>
`<PR # / branch / range>` · base `<base>` · N files, +X/−Y · uncommitted <included | not included>
<what and why, one line>

- **Intent:** <source>
- **Matches intent:** **<yes | partly | no>**: <why>
- **Focused:** **<yes | no>**: <why>
- **Risk:** **<low | medium | high>**: <why, evidence>
- **Fits codebase:** **<yes | partly | no>**: <why>

**Gaps**
- Not in this change: <item>
- Not in intent: <item>

**Main changes**
1. **<block>**: <one sentence>. `file`

<optional mermaid flowchart>

**Review**
- Read: <block> → <block> → <block>
- Look closely: <what it touches> (`file`, <risk>)

**Approach**
- Decision: <decision> (<stated | inferred>); rejects <alternative>
- Assumption: <assumption> (<stated | inferred>)

**Evidence**
- Checked: <check>: <result>
- Reading only: <claim>
- Coverage: <"all files read" | N in depth, N skimmed, N collapsed (<patterns>), N skipped>; <N not code, if any>
```
