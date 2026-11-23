# AGENTS.md

This repo contains agent skills, and the Node.js scripts that these skills use.

## Responses

- Write responses in ASD-STE100 Simplified Technical English.
- Keep responses to a maximum of approximately 1200 characters. Exception: the failure-mode list for a delivered script can make a response longer.
- Use bullet lists or numbered lists when possible.

## Tooling

- Package manager: pnpm.
- Before you finish a change, run `pnpm format`, `pnpm lint`, and `pnpm test`. Fix all errors and warnings.

## Layout

- `skills/<skill-name>/`: one folder for each skill. Scripts that only one skill uses go in `skills/<skill-name>/scripts/`.
- `scripts/`: repo-wide scripts.
- `docs/agent/`: agent docs. `docs/`: user docs.

## Read when relevant

- [Skill authoring](docs/agent/skill-authoring.md): when you add or change a skill.
- [Script authoring](docs/agent/script-authoring.md): when you add or change a `.mjs` script.
- [Test isolation](docs/agent/testing.md): when you write or change a test.
