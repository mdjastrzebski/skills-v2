---
name: post-to-gh
disable-model-invocation: true
description: Use when the user wants to share findings from the current session on GitHub. Gives a short, self-contained comment on a PR or issue, or a new issue, and the URL of the post.
---

# Post to GH

The user can give a target (PR or issue number or URL) and a hint about what to post. Use the target when the user gives one.

1. **Find info areas** in the session. Pick info that is recent, meaningful, and useful for the reader: issues to fix, confirmed checks, failed approaches, root causes, decisions, next steps, open questions, and facts from the user (versions, devices, repro steps). Give priority to facts that the user said. Do not include process noise (tool retries, agent mistakes that do not matter to the ticket). If the user said what to post, use that instead.
2. **Stop if there is no useful info.** Tell the user and do not post.
3. **Infer the target** if the user gave none: a PR or issue in the conversation, the PR of the current branch (`gh pr view`), or an issue named in the branch name. If no target fits, propose a new issue in the current repo (`gh repo view`) with a title. If you cannot find a GitHub repo and have no target URL, tell the user and ask for a target. If more than one target fits, show the most likely one.
4. **Ask one question.** Show the target and a multi-choice list of areas. Give each area a short label and a one-line preview. The user picks areas and can correct the target. In Claude Code, use the question tool with multi-select. In other harnesses, use a numbered list and accept numbers or `all`. Do not post before the answer.
5. **Stop if the user picks no areas.** Do not post.
6. **Write the post** from the picked areas only, in English, and save it to a temporary file. Do not add a footer or attribution.
   - Format: sections with headers, numbered or bullet lists, and short sentences in ASD-STE100 Simplified Technical English.
   - Status: use only plain emojis: ✅ works or confirmed, ❌ fails or rejected, ⚠️ risk or caution. Do not use other emojis.
   - Self-contained: a reader who has only the ticket must understand the post. Define terms. Name files, versions, and commands in full. Do not write "above", "the session", or "as we discussed", and do not refer to your local state.
7. **Remove sensitive info** from the file with no question: tokens, keys, passwords, local absolute paths, internal hostnames or URLs, personal data, and raw log lines that contain these. Count what you remove.
8. **Post** with `gh pr comment`, `gh issue comment`, or `gh issue create`, and pass the file with `--body-file`. If `gh` is missing, is not authenticated, or fails, show the error and stop. Do not try other methods.
9. **Report** the URL of the post, and show the full posted text in the session, so the user does not have to open it. Add one line about what you left out, for example `Left out: 2 local paths, 1 token`. Add nothing if you left out nothing.
