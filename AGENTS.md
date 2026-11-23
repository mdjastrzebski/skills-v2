# AGENTS.md

- Keep all responses concise and focused on the main points. Include details only when needed to understand the big picture.
- Write responses in ASD-STE100 Simplified Technical English.
- Keep responses to a maximum of approximately 1200 characters.
- Use bullet lists or numbered lists when possible.

## Skill authoring

- Keep skills loosely coupled. A skill must not know the internals of other skills. Treat other skills as black boxes, and use only their public contract: name, description, inputs, and outputs.
- Keep skills short and easy for humans to read.
- When you author a skill, identify steps that a short script can do better than the agent. Suggest a script for these steps.

## Script authoring

- Use `.mjs` files for Node.js 20 or later.
- Make scripts portable: use Node.js built-in modules only, with no external dependencies, and make them work on macOS and Linux.
