# Test isolation

- Do not share state or files between tests.
- Create all files in a new `mkdtempSync` folder. Delete it in an `after()` hook.
- Never read or write real user files, such as `~/.claude`, `~/.agents`, `~/.codex`, or this repo's `.git`.
- Run each child process (the script, `git`) with an isolated environment:
  - Set `HOME` and each config-folder override (for example `CODEX_HOME`, `CLAUDE_CONFIG_DIR`) to the temp folder.
  - Remove all `GIT_*` variables. Set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
  - Set `cwd` to a folder inside the temp folder.
- Run child scripts with `process.execPath`, not `node`.
