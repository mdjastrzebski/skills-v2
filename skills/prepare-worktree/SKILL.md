---
name: prepare-worktree
description: Use when the user asks for a worktree or parallel work on a branch (existing or new). Gives the path of a ready git worktree.
---

If the user did not give a branch name, ask for it. Then run this command from inside the repo, and show the output unchanged:

```sh
node <skill-base-dir>/scripts/prepare-worktree.mjs <branch> [--base <ref>]
```

The script reuses an existing worktree, checks out a local or origin branch, or creates a new branch from the latest `origin/main`. It puts the worktree at `../<repo>-worktrees/<branch-slug>`.

If the mode is `main-checkout`, do not start work. Show the note and ask the user what to do.
