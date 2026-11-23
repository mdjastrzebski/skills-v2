# Script authoring

## Runtime

- Use `.mjs` files for Node.js 22.13 or later.
- Make scripts portable: use Node.js built-in modules only, with no external dependencies, and make them work on macOS and Linux.

## Code style

- Write code without comments.
- Prefer explicit steps and plain code over clever or compact code.
- Organize each file top-down: high-level functions first, then the helpers that they use.

## Errors

- When a step fails, exit with a clear error message and a non-zero code. Do not guess, and do not silently fall back. This also applies to scripts that a skill uses.

## Tests

- Put tests next to the script as `<name>.test.mjs`. Use `node:test` and `node:assert`.
- For a bug fix, run the new test against the old code first. It must fail.
- Follow [Test isolation](testing.md).

## Delivery

- When you deliver a script, list its failure modes and edge cases. This list can make the response longer than the usual limit.
