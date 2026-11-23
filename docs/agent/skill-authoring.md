# Skill authoring

- Keep skills loosely coupled. A skill must not know the internals of other skills. Treat other skills as black boxes, and use only their public contract: name, description, inputs, and outputs.
- Keep `SKILL.md` under 60 lines. If a skill needs more, put the details in a reference file next to it and link that file from `SKILL.md`.
- Write the steps as one numbered list, in the order the agent does them.
- Each step does one action. If a step needs more than three sentences, make it a script or a reference file.
- Use plain words. Do not use internal jargon unless you define it.
- Write the skill `description` for the agent that must decide to use the skill. Say when to use the skill and what the agent gets from it. Do not summarize how the skill works.
- When you author a skill, identify steps that a short script can do better than the agent. Suggest a script for these steps. See [Script authoring](script-authoring.md).
- Make skills report problems, not hide them. If a step does not work, the skill can try one quick alternative. It must not use slow or expensive workarounds. It must tell the user what happened and ask what to do. This rule applies to the skill instructions only. Scripts always fail fast.

## Install and links

- Do not add repo-local skill links (`.agents/skills/`, `.claude/skills/`). Install skills globally instead.
- After you add, rename, or remove a skill, run `node scripts/link-skills.mjs`. See [Install](../install.md).
