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

## Script authoring

- Use `.mjs` files for Node.js 20 or later.
- Make scripts portable: use Node.js built-in modules only, with no external dependencies, and make them work on macOS and Linux.
- Write code without comments. Use clear names and simple structure, so that the code itself shows what it does.
- Write plain, readable code. Prefer explicit steps over clever or compact code.
- Organize each file top-down: high-level functions first, then the helpers that they use.
- Put tests next to the script as `<name>.test.mjs`. Use `node:test` and `node:assert`.
- Run tests with `node --test <path>`.
- When you deliver a script, list its failure modes and edge cases.
