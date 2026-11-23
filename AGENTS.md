# AGENTS.md

- Keep all responses concise and focused on the main points. Include details only when needed to understand the big picture.
- Write responses in ASD-STE100 Simplified Technical English.
- Keep responses to a maximum of approximately 1200 characters.
- Use bullet lists or numbered lists when possible.

## Repository layout

- `skills/<skill-name>/`: one folder for each skill.
- `skills/<skill-name>/scripts/`: scripts that only one skill uses.
- `scripts/`: repo-wide scripts.
- `AGENTS.md`, `CLAUDE.md`: agent instructions. `CLAUDE.md` only imports `AGENTS.md`.
- Do not add repo-local skill links (`.agents/skills/`, `.claude/skills/`). Install skills globally instead.

## Install

- Run `node scripts/link-skills.mjs` to link every skill as a global user skill.
- Layout: `~/.agents/skills/<name>` -> `<repo>/skills/<name>`, and `~/.claude/skills/<name>` -> `../../.agents/skills/<name>`.
- Run the script again after you add, rename, or remove a skill.

## Skill authoring

- Keep skills loosely coupled. A skill must not know the internals of other skills. Treat other skills as black boxes, and use only their public contract: name, description, inputs, and outputs.
- Keep skills short and easy for humans to read.
- Write the skill `description` for the agent that must decide to use the skill. Say when to use the skill and what the agent gets from it. Do not summarize how the skill works.
- When you author a skill, identify steps that a short script can do better than the agent. Suggest a script for these steps.
- Make skills report problems, not hide them. If a step does not work, the skill can try one quick alternative. It must not use slow or expensive workarounds. It must tell the user what happened and ask what to do.

## Script authoring

- Use `.mjs` files for Node.js 20 or later.
- Make scripts portable: use Node.js built-in modules only, with no external dependencies, and make them work on macOS and Linux.
- Write code without comments. Use clear names and simple structure, so that the code itself shows what it does.
- Write plain, readable code. Prefer explicit steps over clever or compact code.
- When a step fails, exit with a clear error message and a non-zero code. Do not guess, and do not silently fall back.
- Organize each file top-down: high-level functions first, then the helpers that they use.
- Put tests next to the script as `<name>.test.mjs`. Use `node:test` and `node:assert`.
- Run `pnpm install` once to get the dev tools.
- Before you finish, run `pnpm format`, `pnpm lint`, and `pnpm test`. Fix all errors and warnings.
- Formatter and linter config: `.oxfmtrc.json` (oxfmt), `.oxlintrc.json` (oxlint).
- When you deliver a script, list its failure modes and edge cases.

## Test isolation

- Make each test independent. Do not share state or files between tests, and do not rely on test order.
- Create all files in a new `mkdtempSync` folder. Delete it in an `after()` hook.
- Never read or write real user files, such as `~/.claude`, `~/.agents`, `~/.codex`, or this repo's `.git`.
- Run each child process (the script, `git`) with an isolated environment:
  - Set `HOME` and each config-folder override (for example `CODEX_HOME`, `CLAUDE_CONFIG_DIR`) to the temp folder.
  - Remove all `GIT_*` variables. Set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
  - Set `cwd` to a folder inside the temp folder.
- Run child scripts with `process.execPath`, not `node`.
