# Install

1. Run `node scripts/link-skills.mjs` to link every skill as a global user skill.
2. Run the script again after you add, rename, or remove a skill.

Link layout:

- `~/.agents/skills/<name>` -> `<repo>/skills/<name>`
- `~/.claude/skills/<name>` -> `../../.agents/skills/<name>`
