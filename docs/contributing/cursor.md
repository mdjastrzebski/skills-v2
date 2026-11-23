# Cursor session store

Read this before you change `skills/session-retro/scripts/cursor.mjs`. Do not probe a live `~/.cursor` store to relearn these fields.

The on-disk layout is private to Cursor. `meta.json` is `schemaVersion` 1, and the store meta blob can contain `blobEncryptionKey`. The file layout can change in any Cursor release. The JSON tool rows are the part the script depends on. The protobuf blobs and the `highLevelToolCallResult` wrapper can move.

Required: at least one JSON message blob, and `toolCallId` and `toolName` on each tool row. If one is missing, stop. Exit with a clear error that names the missing field. Do not scan blobs for a replacement.

Optional: `highLevelToolCallResult`. If it is missing, the call has no duration, and a failure comes only from `Exit code:` text.

## Paths

`CURSOR_HOME` defaults to `~/.cursor`.

- Session: `$CURSOR_HOME/chats/<hash>/<id>/store.db`
- Meta beside the store: `meta.json` with `cwd`, `title`, `createdAtMs`, `updatedAtMs`, `schemaVersion`
- Session update time: the latest of `updatedAtMs` and the file times of `store.db` and `store.db-wal`. New writes can go to the WAL file first.
- Subagents: `$CURSOR_HOME/projects/<cwd-slug>/agent-transcripts/<id>/subagents/*.jsonl`
- The cwd slug replaces each non-alphanumeric character with `-`, then strips leading dashes.
- A session id that appears as a subagent `.jsonl` is not a main session.

`agent-transcripts/<id>/<id>.jsonl` has `tool_use` only. It has no tool results, no shell duration, and no token totals. Prefer `store.db` when both exist.

## Rows the script reads

`store.db` is SQLite. The table is `blobs (id TEXT, data BLOB)`. Read rows in `rowid` order. Keep a blob only when the data is a JSON object with a string `role`. Skip every other blob, including protobuf.

- `user`: text. A `<timestamp>` in the text sets the clock. ISO timestamps parse with `Date.parse`. The English form `Nov 23, 2026, 9:29 AM (UTC+1)` is also used. Without `(UTC±N)`, read it as local time.
- `assistant`: `content[]` items with `type: "tool-call"`, `toolName`, `args`, and `toolCallId`.
- `tool`: `content[]` item with `type: "tool-result"`, the same `toolCallId`, and `result`.

`providerOptions.cursor.highLevelToolCallResult` on a tool row:

- `isError: true` and `rawErrorMessages` mark a failed call.
- `output.failure.exitCode` or a result that starts with `Exit code:` other than 0 also marks a failure. Exit code 0 is success.
- Shell duration is `localExecutionTimeMs`, then `executionTime`, on `output.success` or `output.failure`.

Shell tools are `Shell` and `Bash` (`args.command`). Edit tools are `Write`, `StrReplace`, `Edit`, `MultiEdit`, `Delete`, and `NotebookEdit` (`args.path` or `args.file_path`). The repeat key is the tool name plus the args without `description`.

## Model time

A thinking blob is one protobuf field 3. Inside it: field 1 is the text, field 3 is the start time in milliseconds, and field 4 is the end time. The gap is `end - start`. Use that as model time. Ignore a copy of the same start, end, and text. Ignore a span longer than 15 minutes.

Shell duration still comes from the tool row. Do not treat a big protobuf copy as a thinking span. Those copies repeat the session start time.

If no thinking span has a start and an end, leave the gap list empty.

## Clock

Only user timestamps and shell durations move the clock. Model time between them is not recorded. So loop cycle times and subagent times are lower bounds, and the report prints them with `≥`. If the session has no user timestamp, the report prints `cycle unknown` and leaves out subagent times.

## Absent

The JSON rows have no model-token total. Report tool-output size as chars/4. Do not search the store for `input_tokens`, `tokenUsage`, or `parentAgentId`. Those strings also appear inside file text that a tool result stored.
