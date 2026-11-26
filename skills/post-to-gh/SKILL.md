---
name: post-to-gh
disable-model-invocation: true
description: Use when the user wants to share findings from the current session on GitHub. Gives a short, self-contained comment on a PR or issue, or a new issue, and the URL of the post.
---

# Post to GH

If the user gives a target (PR or issue number or URL) or says what to post, use it.

1. **Find info areas** in the session: recent, meaningful, and actionable for the reader. Examples: root causes, issues to fix, checks, failed approaches, decisions, next steps, open questions. Give priority to facts from the user (versions, devices, repro steps). Skip process noise. If there is no useful info, tell the user and stop.
2. **Infer the target**: a PR or issue in the conversation, the PR of the current branch (`gh pr view`), or an issue in the branch name. Else propose a new issue with a title in the current repo. If there is no GitHub repo, ask for a target.
3. **Ask one question**: the target and a multi-choice list of areas, each with a label and a one-line preview. The user can correct the target. In Claude Code, use the question tool with multi-select; elsewhere, a numbered list that accepts numbers or `all`. If the user picks no areas, stop.
4. **Write the post** to a temporary file, from the picked areas only, in English, with no footer:
   - Headers, lists, and short ASD-STE100 sentences.
   - Status emojis only: ✅ works, ❌ fails, ⚠️ risk.
   - Self-contained: define terms, name files, versions, and commands in full. Do not refer to "above", the session, or local state.
   - Remove with no question: tokens, keys, passwords, local paths, internal hosts or URLs, personal data. Count what you remove.
5. **Post** with `gh pr comment`, `gh issue comment`, or `gh issue create`, with `--body-file`. On a `gh` error, show it and stop.
6. **Report** the post URL and the full posted text. If you left out info, add one line, for example `Left out: 2 local paths, 1 token`.
