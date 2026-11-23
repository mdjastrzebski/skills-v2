import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./retro.mjs', import.meta.url));
const tempRoots = [];

const CLAUDE_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_SESSION_ID = '019a0000-0000-7000-8000-000000000001';
const CODEX_CHILD_ID = '019a0000-0000-7000-8000-000000000002';
const SECTIONS = [
  'Failed tool calls',
  'Repeats',
  'Token hotspots',
  'Time hotspots',
  'Feedback loops',
];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prints all sections for a Claude Code session and labels the subagent', () => {
  const env = setup();
  writeClaudeSession(env);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Session: ${CLAUDE_SESSION_ID}`));
  assert.match(result.stdout, /Harness: Claude Code/);
  assert.match(result.stdout, /Agents: main \+ 1 subagent/);
  const sections = splitSections(result.stdout);
  assert.deepEqual(Object.keys(sections), SECTIONS.map(headingName));
  assert.match(
    sections['Failed tool calls'],
    /\[subagent: Find config files\] Grep: `config` -> Path does not exist/,
  );
  assert.match(sections['Token hotspots'], /\[main\] Read: `\/repo\/src\/big\.ts`/);
  assert.match(
    sections['Token hotspots'],
    /- \d+ tokens \+ \d+(\.\d)?k cache reads \[subagent: Find config files\]/,
  );
  assert.match(
    sections['Time hotspots'],
    /Slowest subagents:\n- 40s \[subagent: Find config files\]/,
  );
  assert.match(sections['Time hotspots'], /\[main\] Agent: `Find config files`/);
});

test('prints all sections for a Codex session and labels the subagent', () => {
  const env = setup();
  writeCodexSession(env);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Session: ${CODEX_SESSION_ID}`));
  assert.match(result.stdout, /Harness: Codex/);
  assert.match(result.stdout, /Agents: main \+ 1 subagent/);
  const sections = splitSections(result.stdout);
  assert.deepEqual(Object.keys(sections), SECTIONS.map(headingName));
  assert.match(
    sections['Failed tool calls'],
    /\[subagent: review_tests\] apply_patch: `Update File: \/repo\/a\.ts` -> /,
  );
  assert.match(sections['Token hotspots'], /\[subagent: review_tests\] exec_command: `rg TODO`/);
  assert.match(sections['Token hotspots'], /- 2\.5k tokens \[subagent: review_tests\]/);
  assert.match(sections['Time hotspots'], /Slowest subagents:\n- 30s \[subagent: review_tests\]/);
});

test('shows a failed command retried twice in failed calls and repeats (Claude Code)', () => {
  const env = setup();
  writeClaudeSession(env);
  const sections = splitSections(run(env, []).stdout);
  const failedLines = sections['Failed tool calls']
    .split('\n')
    .filter((line) => line.includes('Bash: `pnpm test`'));
  assert.equal(failedLines.length, 2);
  assert.match(failedLines[0], /-> Exit code 1 … FAIL src\/a\.test\.mjs/);
  assert.match(sections.Repeats, /- 3x \[main\] Bash: `pnpm test` \(2 failed\)/);
});

test('shows a failed command retried twice in failed calls and repeats (Codex)', () => {
  const env = setup();
  writeCodexSession(env);
  const sections = splitSections(run(env, []).stdout);
  const failedLines = sections['Failed tool calls']
    .split('\n')
    .filter((line) => line.includes('exec_command: `pnpm test`'));
  assert.equal(failedLines.length, 2);
  assert.match(failedLines[0], /-> exit code 1 … FAIL src\/a\.test\.mjs/);
  assert.match(sections.Repeats, /- 3x \[main\] exec_command: `pnpm test` \(2 failed\)/);
});

test('prints none for empty sections', () => {
  const env = setup();
  const file = claudeSessionFile(env, CLAUDE_SESSION_ID);
  writeJsonl(file, [
    claudeUser('2026-11-20T10:00:00.000Z', 'Say hello'),
    claudeAssistant('2026-11-20T10:00:00.000Z', 'msg_1', [{ type: 'text', text: 'Hello' }]),
  ]);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  const sections = splitSections(result.stdout);
  assert.match(sections['Failed tool calls'], /\nnone$/);
  assert.match(sections.Repeats, /\nnone$/);
  assert.match(sections['Token hotspots'], /Largest tool results:\nnone\n/);
  assert.match(sections['Time hotspots'], /Slowest subagents:\nnone$/);
  assert.match(sections['Feedback loops'], /\nnone$/);
});

test('reports a Claude Code feedback loop and groups command variants', () => {
  const env = setup();
  writeClaudeLoopSession(env, 3);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  const lines = splitSections(result.stdout)['Feedback loops'].split('\n').slice(1);
  assert.deepEqual(lines, [
    '- 3x [main] `pnpm test`: fail fail pass; cycle avg 45s, longest 1m 0s; run avg 20s; files changed between runs: a.ts, b.ts',
  ]);
});

test('lists a feedback-loop command only in feedback loops, not in repeats', () => {
  const env = setup();
  writeClaudeLoopSession(env, 3);
  const sections = splitSections(run(env, []).stdout);
  assert.match(sections['Feedback loops'], /pnpm test/);
  assert.doesNotMatch(sections.Repeats, /pnpm test/);
});

test('notes that Claude Code tool times include the wait for tool approval', () => {
  const env = setup();
  writeClaudeLoopSession(env, 3);
  const sections = splitSections(run(env, []).stdout);
  assert.match(sections['Time hotspots'], /includes time waiting for tool approval/);
});

test('does not mark a Codex call as failed when only its output has an exit code line', () => {
  const env = setup();
  const file = join(
    env.codexHome,
    'sessions',
    '2026',
    '11',
    '20',
    `rollout-${CODEX_SESSION_ID}.jsonl`,
  );
  const output =
    'Chunk ID: a1\nWall time: 10 seconds\nProcess running with session ID 42\nOutput:\nchild step\nExit code: 1\nretrying\n';
  writeJsonl(file, [
    codexMeta('2026-11-20T10:00:00.000Z', CODEX_SESSION_ID, env.cwd, 'cli', 'user'),
    codexCall('2026-11-20T10:00:01.000Z', 'call_1', { cmd: './build.sh', workdir: env.cwd }),
    codexOutput('2026-11-20T10:00:02.000Z', 'call_1', output),
  ]);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(splitSections(result.stdout)['Failed tool calls'], /\(0\)\nnone$/);
});

test('prints none for feedback loops when a command runs only twice (Claude Code)', () => {
  const env = setup();
  writeClaudeLoopSession(env, 2);
  const sections = splitSections(run(env, []).stdout);
  assert.match(sections['Feedback loops'], /\nnone$/);
});

test('reports a Codex feedback loop with patched files', () => {
  const env = setup();
  writeCodexLoopSession(env, 3);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  const lines = splitSections(result.stdout)['Feedback loops'].split('\n').slice(1);
  assert.deepEqual(lines, [
    '- 3x [main] `npm run lint`: fail fail pass; cycle avg 35s, longest 40s; run avg 7s; files changed between runs: x.ts, y.ts, z.ts',
  ]);
});

test('prints none for feedback loops when a command runs only twice (Codex)', () => {
  const env = setup();
  writeCodexLoopSession(env, 2);
  const sections = splitSections(run(env, []).stdout);
  assert.match(sections['Feedback loops'], /\nnone$/);
});

test('does not count back-to-back runs as a feedback loop', () => {
  const env = setup();
  const entries = [claudeUser('2026-11-20T10:00:00.000Z', 'Run tests')];
  for (let index = 1; index <= 3; index += 1) {
    const second = String(index * 10).padStart(2, '0');
    entries.push(
      claudeAssistant(`2026-11-20T10:00:${second}.000Z`, `msg_${index}`, [
        toolUse(`toolu_${index}`, 'Bash', { command: 'pnpm test' }),
      ]),
      claudeToolResult(`2026-11-20T10:00:${second}.500Z`, `toolu_${index}`, 'Exit code 1', true),
    );
  }
  writeJsonl(claudeSessionFile(env, CLAUDE_SESSION_ID), entries);
  const sections = splitSections(run(env, []).stdout);
  assert.match(sections.Repeats, /- 3x \[main\] Bash: `pnpm test` \(3 failed\)/);
  assert.match(sections['Feedback loops'], /\nnone$/);
});

test('shows at most five loops and counts the rest', () => {
  const env = setup();
  const entries = [claudeUser('2026-11-20T10:00:00.000Z', 'Run checks')];
  let second = 0;
  for (let loop = 1; loop <= 7; loop += 1) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const id = `${loop}_${attempt}`;
      const start = `2026-11-20T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;
      entries.push(
        claudeAssistant(start, `msg_${id}`, [
          toolUse(`toolu_${id}`, 'Bash', { command: `check-${loop}` }),
        ]),
        claudeToolResult(start, `toolu_${id}`, 'ok'),
        claudeAssistant(start, `msg_read_${id}`, [
          toolUse(`toolu_read_${id}`, 'Read', { file_path: `/repo/${id}.ts` }),
        ]),
        claudeToolResult(start, `toolu_read_${id}`, 'content'),
      );
      second += 1;
    }
  }
  writeJsonl(claudeSessionFile(env, CLAUDE_SESSION_ID), entries);
  const lines = splitSections(run(env, []).stdout)['Feedback loops'].split('\n').slice(1);
  assert.equal(lines.length, 6);
  assert.equal(lines[5], '- (+2 more)');
});

test('selects the latest main session across Claude Code and Codex', () => {
  const env = setup();
  const claudeFile = writeClaudeSession(env);
  const { mainFile, childFile } = writeCodexSession(env);
  setModifiedTime(claudeFile, 1000);
  setModifiedTime(mainFile, 2000);
  setModifiedTime(childFile, 3000);
  assert.match(run(env, []).stdout, /Harness: Codex/);

  setModifiedTime(claudeFile, 4000);
  assert.match(run(env, []).stdout, /Harness: Claude Code/);
});

test('selects a session by ID or by file path', () => {
  const env = setup();
  const claudeFile = writeClaudeSession(env);
  writeCodexSession(env);
  const otherDir = join(env.root, 'other');
  mkdirSync(otherDir);
  const fromOtherDir = { ...env, cwd: otherDir };

  assert.match(run(fromOtherDir, [CLAUDE_SESSION_ID]).stdout, /Harness: Claude Code/);
  assert.match(run(fromOtherDir, [CODEX_SESSION_ID]).stdout, /Harness: Codex/);
  assert.match(run(fromOtherDir, [claudeFile]).stdout, /Harness: Claude Code/);
});

test('fails with a clear message when the current directory has no session', () => {
  const env = setup();
  const result = run(env, []);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(
    result.stderr,
    /No Claude Code, Codex, or Cursor session found for the current directory/,
  );
});

test('fails with a clear message for an unknown session ID', () => {
  const env = setup();
  writeClaudeSession(env);
  const result = run(env, ['does-not-exist']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown session ID: does-not-exist/);
});

test('fails with a clear message for a missing or bad file', () => {
  const env = setup();
  const missing = run(env, [join(env.root, 'missing.jsonl')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Session file not found: .*missing\.jsonl/);

  const badFile = join(env.root, 'bad.jsonl');
  writeFileSync(badFile, 'not json\n{also bad\n');
  const bad = run(env, [badFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Bad transcript file .*bad\.jsonl: no valid JSON lines/);
});

test('fails with a clear message for a file that is not a transcript', () => {
  const env = setup();
  const file = join(env.root, 'other.jsonl');
  writeFileSync(file, '{"a":1}\n');
  const result = run(env, [file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Not a Claude Code transcript: .*other\.jsonl/);
});

test('prints usage for --help', () => {
  const env = setup();
  const result = run(env, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node retro\.mjs/);
  assert.match(result.stdout, /Cursor/);
});

const CURSOR_SESSION_ID = '019b0000-0000-7000-8000-00000000000c';
const CURSOR_CHILD_ID = '019b0000-0000-7000-8000-00000000000d';

test('prints repeats for a Cursor transcript file', () => {
  const env = setup();
  const file = join(env.root, 'session.jsonl');
  writeJsonl(file, [
    cursorTranscriptUser('2026-11-20T10:00:00.000Z', 'Read the file'),
    cursorTranscriptAssistant('2026-11-20T10:00:05.000Z', [
      { type: 'tool_use', name: 'Read', input: { path: '/repo/a.ts' } },
    ]),
    cursorTranscriptAssistant('2026-11-20T10:00:10.000Z', [
      { type: 'tool_use', name: 'Read', input: { path: '/repo/a.ts' } },
    ]),
  ]);
  const result = run(env, [file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Harness: Cursor/);
  assert.match(splitSections(result.stdout).Repeats, /- 2x \[main\] Read: `\/repo\/a\.ts`/);
});

test('prints all sections for a Cursor session and labels the subagent', () => {
  const env = setup();
  writeCursorSession(env);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Session: ${CURSOR_SESSION_ID}`));
  assert.match(result.stdout, /Harness: Cursor/);
  assert.match(result.stdout, /Agents: main \+ 1 subagent/);
  const sections = splitSections(result.stdout);
  assert.deepEqual(Object.keys(sections), SECTIONS.map(headingName));
  assert.match(
    sections['Failed tool calls'],
    /\[subagent: Find config files\] Grep: `config` -> Path does not exist/,
  );
  assert.match(sections['Token hotspots'], /\[main\] Read: `\/repo\/src\/big\.ts`/);
  assert.match(
    sections['Time hotspots'],
    /Slowest subagents \(Cursor: model time is not recorded\):\n- ≥40s \[subagent: Find config files\]/,
  );
});

test('shows a failed command retried twice in failed calls and repeats (Cursor)', () => {
  const env = setup();
  writeCursorSession(env);
  const sections = splitSections(run(env, []).stdout);
  const failedLines = sections['Failed tool calls']
    .split('\n')
    .filter((line) => line.includes('Shell: `pnpm test`'));
  assert.equal(failedLines.length, 2);
  assert.match(failedLines[0], /-> exit code 1 … FAIL src\/a\.test\.mjs/);
  assert.match(sections.Repeats, /- 3x \[main\] Shell: `pnpm test` \(2 failed\)/);
});

test('reports a Cursor feedback loop with edited files', () => {
  const env = setup();
  writeCursorLoopSession(env);
  const result = run(env, [CURSOR_SESSION_ID]);
  assert.equal(result.status, 0, result.stderr);
  const lines = splitSections(result.stdout)['Feedback loops'].split('\n').slice(1);
  assert.deepEqual(lines, [
    '- 3x [main] `pnpm test`: fail fail pass; cycle avg ≥45s, longest ≥1m 0s; run avg 20s; files changed between runs: a.ts, b.ts',
  ]);
});

test('reports Cursor thinking spans as model gaps and drops duplicates', () => {
  const env = setup();
  const startMs = Date.parse('2026-11-20T10:00:05.000Z');
  const span = thinkingBlob('Let me write the reader', startMs, startMs + 45_000);
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  writeCursorStore(store, [
    cursorUser('2026-11-20T10:00:00.000Z', 'Add the reader'),
    span,
    span,
    Buffer.from([0, 1, 2, 3, 4]),
    thinkingBlob('Short note', startMs + 60_000, startMs + 61_000),
  ]);
  writeFileSync(
    join(dirname(store), 'meta.json'),
    JSON.stringify({ cwd: env.cwd, title: 'Think', createdAtMs: 1, updatedAtMs: 2 }),
  );
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  const timeSection = splitSections(result.stdout)['Time hotspots'];
  const lines = timeSection
    .split('\n')
    .filter((line) => line.includes('before Let me write the reader'));
  assert.deepEqual(lines, ['- 45s [main] at 10:00:05 UTC, before Let me write the reader']);
});

test('reads tool results for a Cursor app transcript from the state database', () => {
  const env = setup();
  const sessionId = 'app-tab-session';
  const file = join(
    env.cursorHome,
    'projects',
    projectSlug(env.cwd),
    'agent-transcripts',
    sessionId,
    `${sessionId}.jsonl`,
  );
  writeJsonl(file, [
    cursorTranscriptUser('2026-11-20T10:00:00.000Z', 'Run tests'),
    cursorTranscriptAssistant('2026-11-20T10:00:05.000Z', [
      { type: 'tool_use', name: 'Shell', input: { command: 'pnpm test' } },
    ]),
  ]);
  const stateDb = join(env.root, 'state.vscdb');
  writeAppState(stateDb, sessionId);
  const result = run(env, [file], { env: { CURSOR_STATE_DB: stateDb } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Tool results: none/);
  const sections = splitSections(result.stdout);
  assert.match(sections['Failed tool calls'], /Shell: `pnpm test` -> exit code 1/);
  assert.match(sections.Repeats, /- 2x \[main\] Shell: `pnpm test`/);
  assert.match(sections['Token hotspots'], /Shell: `pnpm test`/);
  assert.match(sections['Time hotspots'], /5s \[main\] Shell: `pnpm test`/);
});

test('selects a Cursor app transcript that has no store', () => {
  const env = setup();
  const claudeFile = writeClaudeSession(env);
  setModifiedTime(claudeFile, 1000);
  const sessionId = 'app-tab-session';
  const file = join(
    env.cursorHome,
    'projects',
    projectSlug(env.cwd),
    'agent-transcripts',
    sessionId,
    `${sessionId}.jsonl`,
  );
  writeJsonl(file, [
    cursorTranscriptUser('2026-11-20T10:00:00.000Z', 'Read the file'),
    cursorTranscriptAssistant('2026-11-20T10:00:05.000Z', [
      { type: 'tool_use', name: 'Read', input: { path: '/repo/a.ts' } },
    ]),
    cursorTranscriptAssistant('2026-11-20T10:00:10.000Z', [
      { type: 'tool_use', name: 'Read', input: { path: '/repo/a.ts' } },
    ]),
  ]);
  setModifiedTime(file, 5000);
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Session: ${sessionId}`));
  assert.match(result.stdout, /Harness: Cursor/);
  assert.match(result.stdout, /Tool results: none \(2 calls in the transcript\)/);
  assert.match(splitSections(result.stdout).Repeats, /- 2x \[main\] Read: `\/repo\/a\.ts`/);
});

test('selects a newer Cursor session ahead of Claude Code and Codex', () => {
  const env = setup();
  const claudeFile = writeClaudeSession(env);
  const { mainFile } = writeCodexSession(env);
  const cursorFile = writeCursorSession(env);
  setModifiedTime(claudeFile, 1000);
  setModifiedTime(mainFile, 2000);
  setModifiedTime(cursorFile, 3000);
  assert.match(run(env, []).stdout, /Harness: Cursor/);
});

test('finds a Claude Code session from a symlinked working directory', () => {
  const env = setup();
  const link = join(env.root, 'project-link');
  symlinkSync(env.cwd, link);
  const file = claudeSessionFile({ ...env, cwd: link }, CLAUDE_SESSION_ID);
  writeJsonl(file, [
    claudeUser('2026-11-20T10:00:00.000Z', 'Say hello'),
    claudeAssistant('2026-11-20T10:00:01.000Z', 'msg_1', [{ type: 'text', text: 'Hello' }]),
  ]);
  const result = run(env, [], { cwd: link });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Harness: Claude Code/);
});

test('selects a Cursor session by its meta update time', () => {
  const env = setup();
  const claudeFile = writeClaudeSession(env);
  const store = writeCursorSession(env);
  setModifiedTime(claudeFile, 2000);
  setModifiedTime(store, 1000);
  writeFileSync(
    join(dirname(store), 'meta.json'),
    JSON.stringify({ cwd: env.cwd, title: 'Fix tests', updatedAtMs: 3_000_000 }),
  );
  assert.match(run(env, []).stdout, /Harness: Cursor/);
});

test('prints unknown Cursor times when the session has no timestamps', () => {
  const env = setup();
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Run tests' }] }];
  for (let index = 0; index < 3; index += 1) {
    messages.push(cursorAssistant(`call_run_${index}`, 'Shell', { command: 'pnpm test' }));
    messages.push(
      cursorTool(`call_run_${index}`, 'Shell', 'Exit code: 1', {
        exitCode: 1,
        command: 'pnpm test',
        localExecutionTimeMs: 5000,
      }),
    );
    messages.push(cursorAssistant(`call_edit_${index}`, 'Write', { path: '/repo/a.ts' }));
    messages.push(cursorTool(`call_edit_${index}`, 'Write', 'ok', {}));
  }
  writeCursorStore(store, messages);
  writeFileSync(join(dirname(store), 'meta.json'), JSON.stringify({ cwd: env.cwd }));
  const result = run(env, []);
  assert.equal(result.status, 0, result.stderr);
  const sections = splitSections(result.stdout);
  assert.match(sections['Feedback loops'], /fail fail fail; cycle unknown; run avg 5s;/);
  assert.match(sections['Time hotspots'], /\(Cursor: thinking time only\):\nnone\n/);
});

test('fails with a clear message for a Cursor store without message blobs', () => {
  const env = setup();
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  writeCursorStore(store, [Buffer.from([0, 1, 2, 3])]);
  const result = run(env, [store]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /1 blobs but no JSON message blob\. The Cursor store format may have changed/,
  );
});

test('fails with a clear message for a Cursor tool call without an ID', () => {
  const env = setup();
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  writeCursorStore(store, [
    cursorUser('2026-11-20T10:00:00.000Z', 'Read'),
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', args: {} }] },
  ]);
  const result = run(env, [store]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a tool row has no toolCallId/);
});

test('treats a .db file that is not store.db as a session ID', () => {
  const env = setup();
  const result = run(env, ['other.db']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown session ID: other\.db/);
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'session-retro-test-')));
  tempRoots.push(root);
  const env = {
    root,
    home: join(root, 'home'),
    claudeConfigDir: join(root, 'claude'),
    codexHome: join(root, 'codex'),
    cursorHome: join(root, 'cursor'),
    cwd: join(root, 'project'),
  };
  for (const dir of [env.home, env.claudeConfigDir, env.codexHome, env.cursorHome, env.cwd]) {
    mkdirSync(dir, { recursive: true });
  }
  return env;
}

function run(env, args, options = {}) {
  const cwd = options.cwd ?? env.cwd;
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      childEnv[key] = value;
    }
  }
  Object.assign(childEnv, {
    HOME: env.home,
    CLAUDE_CONFIG_DIR: env.claudeConfigDir,
    CODEX_HOME: env.codexHome,
    CURSOR_HOME: env.cursorHome,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    PWD: cwd,
    ...options.env,
  });
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
}

function splitSections(stdout) {
  const sections = {};
  for (const part of stdout.split(/^## /m).slice(1)) {
    const heading = part.split('\n', 1)[0];
    sections[headingName(heading)] = part.trimEnd();
  }
  return sections;
}

function headingName(heading) {
  return heading.replace(/ \(\d+\)$/, '');
}

function writeClaudeSession(env) {
  const file = claudeSessionFile(env, CLAUDE_SESSION_ID);
  const bigOutput = 'export const value = 1;\n'.repeat(2000);
  const testFailure = 'Exit code 1\n> pnpm test\n\nFAIL src/a.test.mjs';
  writeJsonl(file, [
    { type: 'mode', mode: 'normal', sessionId: CLAUDE_SESSION_ID },
    claudeUser('2026-11-20T10:00:00.000Z', 'Fix the failing test'),
    claudeAssistant('2026-11-20T10:00:05.000Z', 'msg_1', [
      toolUse('toolu_1', 'Bash', { command: 'pnpm test', description: 'Run tests' }),
    ]),
    claudeToolResult('2026-11-20T10:00:15.000Z', 'toolu_1', testFailure, true),
    'this line is not json',
    claudeAssistant('2026-11-20T10:00:20.000Z', 'msg_2', [
      toolUse('toolu_2', 'Bash', { command: 'pnpm test', description: 'Run tests again' }),
    ]),
    claudeToolResult('2026-11-20T10:00:30.000Z', 'toolu_2', testFailure, true),
    claudeAssistant('2026-11-20T10:00:35.000Z', 'msg_3', [
      toolUse('toolu_3', 'Read', { file_path: '/repo/src/big.ts' }),
    ]),
    claudeToolResult('2026-11-20T10:00:36.000Z', 'toolu_3', bigOutput, false),
    claudeAssistant('2026-11-20T10:01:30.000Z', 'msg_4', [
      toolUse('toolu_4', 'Agent', {
        description: 'Find config files',
        subagent_type: 'Explore',
        prompt: 'Find all config files.',
      }),
    ]),
    claudeToolResult('2026-11-20T10:02:15.000Z', 'toolu_4', [{ type: 'text', text: 'Found 2' }]),
    claudeAssistant('2026-11-20T10:02:20.000Z', 'msg_5', [
      toolUse('toolu_5', 'Bash', { command: 'pnpm test', description: 'Run tests' }),
    ]),
    claudeToolResult('2026-11-20T10:02:40.000Z', 'toolu_5', 'All tests passed', false),
    claudeAssistant('2026-11-20T10:02:45.000Z', 'msg_6', [{ type: 'text', text: 'Fixed.' }]),
  ]);

  const subagentsDir = join(dirname(file), CLAUDE_SESSION_ID, 'subagents');
  writeJsonl(join(subagentsDir, 'agent-a1b2c3.jsonl'), [
    { ...claudeUser('2026-11-20T10:01:35.000Z', 'Find all config files.'), isSidechain: true },
    {
      ...claudeAssistant('2026-11-20T10:01:40.000Z', 'msg_s1', [
        toolUse('toolu_s1', 'Grep', { pattern: 'config', path: '/repo/missing' }),
      ]),
      isSidechain: true,
    },
    {
      ...claudeToolResult(
        '2026-11-20T10:01:41.000Z',
        'toolu_s1',
        '<tool_use_error>Path does not exist: /repo/missing</tool_use_error>',
        true,
      ),
      isSidechain: true,
    },
    {
      ...claudeAssistant('2026-11-20T10:02:15.000Z', 'msg_s2', [{ type: 'text', text: 'Found 2' }]),
      isSidechain: true,
    },
  ]);
  writeFileSync(
    join(subagentsDir, 'agent-a1b2c3.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'Find config files' }),
  );
  return file;
}

function writeClaudeLoopSession(env, runCount) {
  const commands = [
    'pnpm test',
    'cd /repo/packages/x && pnpm test 2>&1 | tail -20',
    '  pnpm   test | grep -v noise | head -5  ',
  ];
  const starts = ['10:00:05', '10:00:35', '10:01:35'];
  const ends = ['10:00:15', '10:00:55', '10:02:05'];
  const entries = [claudeUser('2026-11-20T10:00:00.000Z', 'Fix the failing test')];
  for (let index = 0; index < runCount; index += 1) {
    const passed = index === runCount - 1;
    entries.push(
      claudeAssistant(`2026-11-20T${starts[index]}.000Z`, `msg_run_${index}`, [
        toolUse(`toolu_run_${index}`, 'Bash', { command: commands[index] }),
      ]),
      claudeToolResult(
        `2026-11-20T${ends[index]}.000Z`,
        `toolu_run_${index}`,
        passed ? 'All tests passed' : 'Exit code 1\nFAIL',
        !passed,
      ),
    );
    if (!passed) {
      const files = index === 0 ? ['/repo/src/a.ts', '/repo/src/b.ts'] : ['/repo/src/a.ts'];
      const names = index === 0 ? ['Edit', 'MultiEdit'] : ['Write'];
      entries.push(
        claudeAssistant(
          `2026-11-20T${ends[index]}.500Z`,
          `msg_edit_${index}`,
          files.map((file, fileIndex) =>
            toolUse(`toolu_edit_${index}_${fileIndex}`, names[fileIndex], { file_path: file }),
          ),
        ),
        ...files.map((_file, fileIndex) =>
          claudeToolResult(
            `2026-11-20T${ends[index]}.600Z`,
            `toolu_edit_${index}_${fileIndex}`,
            'ok',
          ),
        ),
      );
    }
  }
  writeJsonl(claudeSessionFile(env, CLAUDE_SESSION_ID), entries);
}

function claudeSessionFile(env, sessionId) {
  const projectDir = join(env.claudeConfigDir, 'projects', env.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  return join(projectDir, `${sessionId}.jsonl`);
}

function claudeUser(timestamp, content) {
  return {
    type: 'user',
    isSidechain: false,
    uuid: `user-${timestamp}`,
    timestamp,
    sessionId: CLAUDE_SESSION_ID,
    message: { role: 'user', content },
  };
}

function claudeAssistant(timestamp, messageId, content) {
  return {
    type: 'assistant',
    isSidechain: false,
    uuid: `assistant-${timestamp}`,
    timestamp,
    sessionId: CLAUDE_SESSION_ID,
    message: {
      model: 'claude-opus-5-5',
      id: messageId,
      type: 'message',
      role: 'assistant',
      content,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
      },
    },
  };
}

function claudeToolResult(timestamp, toolUseId, content, isError = false) {
  return claudeUser(timestamp, [
    { tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError },
  ]);
}

function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

function writeCodexSession(env) {
  const dayDir = join(env.codexHome, 'sessions', '2026', '11', '20');
  const mainFile = join(dayDir, `rollout-2026-11-20T10-00-00-${CODEX_SESSION_ID}.jsonl`);
  const childFile = join(dayDir, `rollout-2026-11-20T10-01-00-${CODEX_CHILD_ID}.jsonl`);
  const testFailure =
    'Chunk ID: a1b2c3\nWall time: 9.5 seconds\nProcess exited with code 1\nOriginal token count: 12\nOutput:\n> pnpm test\nFAIL src/a.test.mjs\n';
  const testSuccess =
    'Chunk ID: d4e5f6\nWall time: 9.1 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nAll tests passed\n';

  writeJsonl(mainFile, [
    codexMeta('2026-11-20T10:00:00.000Z', CODEX_SESSION_ID, env.cwd, 'cli', 'user'),
    codexEvent('2026-11-20T10:00:00.100Z', { type: 'task_started', turn_id: 'turn_1' }),
    codexItem('2026-11-20T10:00:00.200Z', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the failing test' }],
    }),
    codexItem('2026-11-20T10:00:04.000Z', { type: 'reasoning', summary: [] }),
    codexCall('2026-11-20T10:00:05.000Z', 'call_1', { cmd: 'pnpm test', workdir: env.cwd }),
    codexOutput('2026-11-20T10:00:15.000Z', 'call_1', testFailure),
    'not json at all',
    codexCall('2026-11-20T10:00:20.000Z', 'call_2', { cmd: 'pnpm test', workdir: env.cwd }),
    codexOutput('2026-11-20T10:00:30.000Z', 'call_2', testFailure),
    codexCall('2026-11-20T10:00:40.000Z', 'call_3', { cmd: 'pnpm test', workdir: env.cwd }),
    codexOutput('2026-11-20T10:00:50.000Z', 'call_3', testSuccess),
    codexEvent('2026-11-20T10:00:50.100Z', tokenCount(5000)),
    codexItem('2026-11-20T10:01:55.000Z', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixed.' }],
    }),
    codexEvent('2026-11-20T10:01:55.100Z', tokenCount(7000)),
  ]);

  const spawn = {
    subagent: {
      thread_spawn: {
        parent_thread_id: CODEX_SESSION_ID,
        depth: 1,
        agent_path: 'root/review_tests',
        agent_nickname: 'Hume',
        agent_role: 'explorer',
      },
    },
  };
  writeJsonl(childFile, [
    codexMeta('2026-11-20T10:01:00.000Z', CODEX_CHILD_ID, env.cwd, spawn, 'subagent'),
    codexCall('2026-11-20T10:01:05.000Z', 'call_c1', { cmd: 'rg TODO', workdir: env.cwd }),
    codexOutput(
      '2026-11-20T10:01:06.000Z',
      'call_c1',
      `Chunk ID: 0a0b0c\nWall time: 0.4 seconds\nProcess exited with code 0\nOriginal token count: 9000\nOutput:\n${'src/a.ts:1: // TODO\n'.repeat(1500)}`,
    ),
    codexItem('2026-11-20T10:01:20.000Z', {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_c2',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-old\n+new\n*** End Patch',
    }),
    codexEvent('2026-11-20T10:01:21.000Z', {
      type: 'patch_apply_end',
      call_id: 'call_c2',
      stdout: '',
      stderr: 'Failed to find expected lines in /repo/a.ts',
      success: false,
    }),
    codexItem('2026-11-20T10:01:21.100Z', {
      type: 'custom_tool_call_output',
      call_id: 'call_c2',
      output: 'Failed to find expected lines in /repo/a.ts',
    }),
    codexEvent('2026-11-20T10:01:30.000Z', tokenCount(2500)),
  ]);
  return { mainFile, childFile };
}

function writeCodexLoopSession(env, runCount) {
  const file = join(
    env.codexHome,
    'sessions',
    '2026',
    '11',
    '20',
    `rollout-2026-11-20T10-00-00-${CODEX_SESSION_ID}.jsonl`,
  );
  const commands = [
    'npm run lint',
    'cd /repo && npm run lint | head -50',
    'npm run lint 2>&1 | tail -n 5',
  ];
  const starts = ['10:00:10', '10:00:50', '10:01:20'];
  const ends = ['10:00:16', '10:00:57', '10:01:29'];
  const patches = [
    '*** Begin Patch\n*** Update File: /repo/x.ts\n@@\n-a\n+b\n*** Add File: /repo/y.ts\n+new\n*** End Patch',
    '*** Begin Patch\n*** Update File: /repo/x.ts\n*** Move to: /repo/z.ts\n@@\n-a\n+b\n*** End Patch',
  ];
  const entries = [
    codexMeta('2026-11-20T10:00:00.000Z', CODEX_SESSION_ID, env.cwd, 'cli', 'user'),
    codexEvent('2026-11-20T10:00:00.100Z', { type: 'task_started', turn_id: 'turn_1' }),
  ];
  for (let index = 0; index < runCount; index += 1) {
    const passed = index === runCount - 1;
    const exitCode = passed ? 0 : 1;
    entries.push(
      codexCall(`2026-11-20T${starts[index]}.000Z`, `call_run_${index}`, {
        cmd: commands[index],
        workdir: env.cwd,
      }),
      codexOutput(
        `2026-11-20T${ends[index]}.000Z`,
        `call_run_${index}`,
        `Chunk ID: a1\nWall time: 1 seconds\nProcess exited with code ${exitCode}\nOutput:\nlint output\n`,
      ),
    );
    if (!passed) {
      entries.push(
        codexItem(`2026-11-20T${ends[index]}.500Z`, {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: `call_patch_${index}`,
          name: 'apply_patch',
          input: patches[index],
        }),
        codexItem(`2026-11-20T${ends[index]}.600Z`, {
          type: 'custom_tool_call_output',
          call_id: `call_patch_${index}`,
          output: 'Success. Updated the following files',
        }),
      );
    }
  }
  writeJsonl(file, entries);
}

function codexMeta(timestamp, id, cwd, source, threadSource) {
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp,
      cwd,
      originator: 'codex-tui',
      cli_version: '0.142.2',
      source,
      thread_source: threadSource,
      model_provider: 'openai',
    },
  };
}

function codexItem(timestamp, payload) {
  return { timestamp, type: 'response_item', payload };
}

function codexEvent(timestamp, payload) {
  return { timestamp, type: 'event_msg', payload };
}

function codexCall(timestamp, callId, args) {
  return codexItem(timestamp, {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ ...args, yield_time_ms: 10000 }),
    call_id: callId,
  });
}

function codexOutput(timestamp, callId, output) {
  return codexItem(timestamp, { type: 'function_call_output', call_id: callId, output });
}

function tokenCount(totalTokens) {
  return {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: totalTokens - 100,
        cached_input_tokens: 0,
        output_tokens: 100,
        total_tokens: totalTokens,
      },
    },
  };
}

function writeJsonl(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  writeFileSync(file, `${lines.join('\n')}\n`);
}

function setModifiedTime(file, secondsSinceEpoch) {
  utimesSync(file, secondsSinceEpoch, secondsSinceEpoch);
}

function cursorTranscriptUser(timestamp, text) {
  return {
    role: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: `<timestamp>${timestamp}</timestamp>\n<user_query>\n${text}\n</user_query>`,
        },
      ],
    },
  };
}

function cursorTranscriptAssistant(timestamp, content) {
  return { role: 'assistant', message: { content } };
}

function writeCursorSession(env) {
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  const bigOutput = 'export const value = 1;\n'.repeat(2000);
  const failure = 'Exit code: 1\n\nCommand output:\n\n```\nFAIL src/a.test.mjs';
  writeCursorStore(store, [
    cursorUser('2026-11-20T10:00:00.000Z', 'Fix the failing test'),
    cursorAssistant('call_1', 'Shell', { command: 'pnpm test', description: 'Run tests' }),
    cursorTool('call_1', 'Shell', failure, { exitCode: 1, command: 'pnpm test' }),
    cursorAssistant('call_2', 'Shell', { command: 'pnpm test', description: 'Run tests again' }),
    cursorTool('call_2', 'Shell', failure, { exitCode: 1, command: 'pnpm test' }),
    cursorAssistant('call_3', 'Read', { path: '/repo/src/big.ts' }),
    cursorTool('call_3', 'Read', bigOutput, {}),
    cursorAssistant('call_4', 'Shell', { command: 'pnpm test', description: 'Run tests' }),
    cursorTool('call_4', 'Shell', 'Exit code: 0\n\nCommand output:\n\n```\nAll tests passed', {
      exitCode: 0,
      command: 'pnpm test',
      localExecutionTimeMs: 10000,
    }),
  ]);
  writeFileSync(
    join(dirname(store), 'meta.json'),
    JSON.stringify({ cwd: env.cwd, title: 'Fix tests', createdAtMs: 1, updatedAtMs: 2 }),
  );

  const childStore = cursorStorePath(env, CURSOR_CHILD_ID);
  writeCursorStore(childStore, [
    cursorUser('2026-11-20T10:01:00.000Z', 'Find config files'),
    cursorAssistant('call_g', 'Grep', { pattern: 'config', path: '/repo/missing' }),
    cursorTool('call_g', 'Grep', 'Path does not exist', {
      isError: true,
      rawErrorMessages: ['Path does not exist'],
    }),
    cursorAssistant('call_s', 'Shell', { command: 'rg TODO' }),
    cursorTool('call_s', 'Shell', 'Exit code: 0\n\nCommand output:\n\n```\nsrc/a.ts', {
      exitCode: 0,
      command: 'rg TODO',
      localExecutionTimeMs: 40000,
    }),
  ]);
  writeFileSync(
    join(dirname(childStore), 'meta.json'),
    JSON.stringify({
      cwd: env.cwd,
      title: 'Find config files',
      createdAtMs: 1,
      updatedAtMs: 2,
    }),
  );
  const subagentsDir = join(
    env.cursorHome,
    'projects',
    projectSlug(env.cwd),
    'agent-transcripts',
    CURSOR_SESSION_ID,
    'subagents',
  );
  writeJsonl(join(subagentsDir, `${CURSOR_CHILD_ID}.jsonl`), [
    cursorTranscriptUser('2026-11-20T10:01:00.000Z', 'Find config files'),
  ]);
  return store;
}

function writeCursorLoopSession(env) {
  const store = cursorStorePath(env, CURSOR_SESSION_ID);
  const commands = [
    'pnpm test',
    'cd /repo/packages/x && pnpm test 2>&1 | tail -20',
    '  pnpm   test | grep -v noise | head -5  ',
  ];
  const starts = [
    '2026-11-20T10:00:05.000Z',
    '2026-11-20T10:00:35.000Z',
    '2026-11-20T10:01:35.000Z',
  ];
  const durations = [10000, 20000, 30000];
  const messages = [];
  for (let index = 0; index < 3; index += 1) {
    const passed = index === 2;
    messages.push(cursorUser(starts[index], 'Run tests'));
    messages.push(cursorAssistant(`call_run_${index}`, 'Shell', { command: commands[index] }));
    messages.push(
      cursorTool(
        `call_run_${index}`,
        'Shell',
        passed ? 'Exit code: 0\n\nAll tests passed' : 'Exit code: 1\n\nFAIL',
        {
          exitCode: passed ? 0 : 1,
          command: commands[index],
          localExecutionTimeMs: durations[index],
        },
      ),
    );
    if (!passed) {
      const files = index === 0 ? ['/repo/src/a.ts', '/repo/src/b.ts'] : ['/repo/src/a.ts'];
      const names = index === 0 ? ['StrReplace', 'Write'] : ['Write'];
      for (const [fileIndex, file] of files.entries()) {
        const callId = `call_edit_${index}_${fileIndex}`;
        messages.push(cursorAssistant(callId, names[fileIndex], { path: file }));
        messages.push(cursorTool(callId, names[fileIndex], 'ok', {}));
      }
    }
  }
  writeCursorStore(store, messages);
  writeFileSync(
    join(dirname(store), 'meta.json'),
    JSON.stringify({ cwd: env.cwd, title: 'Loop', createdAtMs: 1, updatedAtMs: 2 }),
  );
  return store;
}

function writeAppState(file, sessionId) {
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const insert = database.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  const bubbles = [
    appBubble('b1', 'pnpm test', 1, 'FAIL src/a.test.mjs', 5_000),
    appBubble('b2', 'pnpm test', 0, 'ok', 1_000),
  ];
  insert.run(
    `composerConvHeaders:${sessionId}:000000`,
    JSON.stringify(bubbles.map((bubble) => ({ bubbleId: bubble.id }))),
  );
  for (const bubble of bubbles) {
    insert.run(`bubbleId:${sessionId}:${bubble.id}`, JSON.stringify(bubble.body));
  }
  database.close();
}

function appBubble(id, command, exitCode, output, durationMs) {
  const start = Date.parse('2026-11-20T10:00:05.000Z');
  return {
    id,
    body: {
      startedAtMs: start,
      completedAtMs: start + durationMs,
      toolFormerData: {
        name: 'run_terminal_command_v2',
        toolCallId: id,
        params: JSON.stringify({ command }),
        result: JSON.stringify({ exitCode, output }),
        additionalData: { status: exitCode === 0 ? 'success' : 'error' },
      },
    },
  };
}

function writeCursorStore(file, messages) {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  const insert = database.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  messages.forEach((message, index) => {
    const data = Buffer.isBuffer(message) ? message : JSON.stringify(message);
    insert.run(String(index), data);
  });
  database.close();
}

function cursorStorePath(env, sessionId) {
  return join(env.cursorHome, 'chats', 'workspace', sessionId, 'store.db');
}

function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

function thinkingBlob(text, startMs, endMs) {
  const inner = Buffer.concat([
    protoBytes(1, Buffer.from(text)),
    protoVarint(2, endMs - startMs),
    protoVarint(3, startMs),
    protoVarint(4, endMs),
  ]);
  return protoBytes(3, inner);
}

function protoBytes(field, data) {
  return Buffer.concat([protoVarintRaw((field << 3) | 2), protoVarintRaw(data.length), data]);
}

function protoVarint(field, value) {
  return Buffer.concat([protoVarintRaw(field << 3), protoVarintRaw(value)]);
}

function protoVarintRaw(value) {
  const bytes = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function cursorUser(timestamp, text) {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<timestamp>${timestamp}</timestamp>\n${text}` }],
  };
}

function cursorAssistant(callId, tool, args) {
  return {
    role: 'assistant',
    id: `msg_${callId}`,
    content: [{ type: 'tool-call', toolCallId: callId, toolName: tool, args }],
  };
}

function cursorTool(callId, tool, result, info) {
  const shellRun = {
    command: info.command,
    exitCode: info.exitCode,
    localExecutionTimeMs: info.localExecutionTimeMs,
  };
  const output =
    info.exitCode === undefined ? {} : { [info.exitCode === 0 ? 'success' : 'failure']: shellRun };
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName: tool, result }],
    providerOptions: {
      cursor: {
        highLevelToolCallResult: {
          isError: info.isError === true,
          rawErrorMessages: info.rawErrorMessages,
          output,
        },
      },
    },
  };
}
