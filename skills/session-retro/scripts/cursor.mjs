import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createAgent,
  createCall,
  describeArgs,
  isOneOfDirectories,
  joinTextBlocks,
  noteTime,
  oneLine,
  readJsonFile,
  readJsonl,
  readFirstJsonLine,
  summarizeError,
  withoutDescription,
} from './transcript.mjs';

const require = createRequire(import.meta.url);

const INPUT_KEYS = [
  'command',
  'pattern',
  'glob_pattern',
  'query',
  'url',
  'path',
  'file_path',
  'prompt',
  'description',
];
const EDIT_TOOLS = new Set(['Write', 'StrReplace', 'Edit', 'MultiEdit', 'Delete', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Shell', 'Bash']);
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function listCursorMainSessions(directories) {
  const subagentIds = listSubagentIds();
  const sessions = [];
  const seen = new Set();
  for (const dir of listChatSessionDirs()) {
    const meta = readJsonFile(join(dir, 'meta.json'));
    const store = join(dir, 'store.db');
    const isMain = isOneOfDirectories(meta.cwd, directories) && !subagentIds.has(basename(dir));
    if (!isMain || !existsSync(store)) {
      continue;
    }
    seen.add(basename(dir));
    sessions.push({ file: store, updatedMs: getStoreUpdatedMs(store, meta) });
  }
  for (const session of listTranscriptSessions(directories, subagentIds)) {
    if (seen.has(session.id)) {
      continue;
    }
    sessions.push({ file: session.file, updatedMs: session.updatedMs });
  }
  return sessions;
}

export function findCursorSessionById(sessionId) {
  return findStoreFile(sessionId) ?? findTranscriptFile(sessionId);
}

export function isCursorTranscript(file) {
  if (basename(file) === 'store.db' || basename(file) === 'meta.json') {
    return true;
  }
  const first = readFirstJsonLine(file);
  return Boolean(first?.role && first.message && first.type === undefined);
}

export function readCursorSession(sessionFile) {
  const resolved = resolveSession(sessionFile);
  if (resolved.messages.length === 0 && resolved.blobCount > 0) {
    throw new Error(
      `Bad Cursor store ${sessionFile}: ${resolved.blobCount} blobs but no JSON message blob. The Cursor store format may have changed.`,
    );
  }
  if (resolved.messages.length === 0) {
    throw new Error(`Bad transcript file ${sessionFile}: no messages`);
  }
  if (!hasToolResults(resolved.messages)) {
    attachAppToolResults(resolved);
  }
  const mainAgent = messagesToAgent(resolved.messages, 'main', true);
  applyModelSpans(mainAgent, resolved.spans);
  const subagents = loadSubagents(resolved.id, resolved.cwd, resolved.transcriptFile);
  return {
    id: resolved.id,
    harness: 'Cursor',
    agents: [mainAgent, ...subagents],
    resultsRecorded: hasToolResults(resolved.messages) || !hasToolCalls(resolved.messages),
  };
}

function getStoreUpdatedMs(store, meta) {
  const times = [statSync(store).mtimeMs];
  const writeAheadLog = `${store}-wal`;
  if (existsSync(writeAheadLog)) {
    times.push(statSync(writeAheadLog).mtimeMs);
  }
  if (typeof meta.updatedAtMs === 'number') {
    times.push(meta.updatedAtMs);
  }
  return Math.max(...times);
}

function getCursorHome() {
  return process.env.CURSOR_HOME ?? join(homedir(), '.cursor');
}

function listTranscriptSessions(directories, subagentIds) {
  const projectsDir = join(getCursorHome(), 'projects');
  if (!existsSync(projectsDir)) {
    return [];
  }
  const slugs = new Set(directories.map((directory) => projectSlug(directory)));
  const sessions = [];
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory() || !slugs.has(project.name)) {
      continue;
    }
    const transcriptsDir = join(projectsDir, project.name, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) {
      continue;
    }
    for (const session of readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!session.isDirectory() || subagentIds.has(session.name)) {
        continue;
      }
      const file = join(transcriptsDir, session.name, `${session.name}.jsonl`);
      if (!existsSync(file)) {
        continue;
      }
      sessions.push({ id: session.name, file, updatedMs: statSync(file).mtimeMs });
    }
  }
  return sessions;
}

function hasToolCalls(messages) {
  return messages.some((message) =>
    (Array.isArray(message.content) ? message.content : []).some(
      (block) => block?.type === 'tool-call' || block?.type === 'tool_use',
    ),
  );
}

const APP_TOOL_NAMES = new Map([
  ['run_terminal_command_v2', 'Shell'],
  ['read_file_v2', 'Read'],
  ['ripgrep_raw_search', 'Grep'],
  ['glob_file_search', 'Glob'],
  ['edit_file_v2', 'StrReplace'],
]);

function attachAppToolResults(resolved) {
  const bubbles = readAppToolBubbles(resolved.id);
  if (bubbles.length === 0) {
    return;
  }
  const kept = resolved.messages.filter((message) => !messageHasToolCall(message));
  resolved.messages = [...kept, ...bubbles.flatMap(bubbleToMessages)];
}

function messageHasToolCall(message) {
  return (Array.isArray(message.content) ? message.content : []).some(
    (block) => block?.type === 'tool-call' || block?.type === 'tool_use',
  );
}

function readAppToolBubbles(sessionId) {
  const file = cursorStateDb();
  if (!file) {
    return [];
  }
  const database = openStore(file);
  try {
    const header = database
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerConvHeaders:${sessionId}:000000`);
    if (!header) {
      return [];
    }
    const bubbles = JSON.parse(decodeValue(header.value));
    if (!Array.isArray(bubbles)) {
      throw new Error(
        `Bad Cursor state ${file}: composer headers for ${sessionId} are not a list.`,
      );
    }
    const readBubble = database.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const tools = [];
    for (const item of bubbles) {
      if (!item || typeof item.bubbleId !== 'string') {
        continue;
      }
      const row = readBubble.get(`bubbleId:${sessionId}:${item.bubbleId}`);
      if (!row) {
        continue;
      }
      const bubble = JSON.parse(decodeValue(row.value));
      const data = bubble.toolFormerData;
      if (!data || typeof data.name !== 'string' || data.name === '') {
        continue;
      }
      tools.push({ data, startedAtMs: bubble.startedAtMs, completedAtMs: bubble.completedAtMs });
    }
    return tools;
  } finally {
    database.close();
  }
}

function cursorStateDb() {
  if (process.env.CURSOR_STATE_DB) {
    return process.env.CURSOR_STATE_DB;
  }
  const home = homedir();
  const candidates = [
    join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function bubbleToMessages(bubble) {
  const { data } = bubble;
  const toolName = APP_TOOL_NAMES.get(data.name) ?? data.name;
  const args = appArgs(data.name, parseJson(data.params) ?? {});
  const result = parseJson(data.result) ?? data.result ?? '';
  const callId = data.toolCallId || data.name;
  const failure = appFailure(data, result);
  const text = failure?.text ?? appResultText(result);
  const durationMs = durationBetween(bubble.startedAtMs, bubble.completedAtMs);
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: callId,
          toolName,
          args,
          startedAtMs: typeof bubble.startedAtMs === 'number' ? bubble.startedAtMs : undefined,
        },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, toolName, result: text }],
      providerOptions: {
        cursor: {
          highLevelToolCallResult: {
            isError: failure?.isError === true,
            rawErrorMessages: failure?.isError ? [text] : [],
            output: {
              success: {
                exitCode: failure?.exitCode ?? 0,
                localExecutionTimeMs: durationMs ?? undefined,
              },
            },
          },
        },
      },
    },
  ];
}

function appArgs(name, params) {
  if (!params || typeof params !== 'object') {
    return {};
  }
  if (name === 'run_terminal_command_v2') {
    return { command: params.command };
  }
  if (name === 'read_file_v2') {
    return { path: params.targetFile };
  }
  if (name === 'ripgrep_raw_search') {
    return { pattern: params.pattern, path: params.path, glob: params.glob };
  }
  if (name === 'glob_file_search') {
    return { glob_pattern: params.globPattern, path: params.targetDirectory };
  }
  if (name === 'edit_file_v2') {
    return { path: params.relativeWorkspacePath };
  }
  return params;
}

function appResultText(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object' && typeof result.output === 'string') {
    return result.output;
  }
  return result === undefined ? '' : JSON.stringify(result);
}

function appFailure(data, result) {
  const status = data.additionalData?.status;
  if (status === 'cancelled') {
    return { isError: true, text: 'cancelled' };
  }
  const exitCode = result && typeof result === 'object' ? result.exitCode : undefined;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return { exitCode };
  }
  if (status === 'error') {
    return { isError: true };
  }
  return null;
}

function durationBetween(startMs, endMs) {
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

function decodeValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.from(value).toString('utf8');
}

function parseJson(value) {
  if (typeof value !== 'string' || !value.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasToolResults(messages) {
  return messages.some((message) => {
    if (message.role === 'tool') {
      return true;
    }
    return (Array.isArray(message.content) ? message.content : []).some(
      (block) => block?.type === 'tool-result' || block?.type === 'tool_result',
    );
  });
}

function listChatSessionDirs() {
  const chatsDir = join(getCursorHome(), 'chats');
  if (!existsSync(chatsDir)) {
    return [];
  }
  const dirs = [];
  for (const hash of readdirSync(chatsDir, { withFileTypes: true })) {
    if (!hash.isDirectory()) {
      continue;
    }
    const hashDir = join(chatsDir, hash.name);
    for (const session of readdirSync(hashDir, { withFileTypes: true })) {
      if (session.isDirectory()) {
        dirs.push(join(hashDir, session.name));
      }
    }
  }
  return dirs;
}

function listSubagentIds() {
  const ids = new Set();
  const projectsDir = join(getCursorHome(), 'projects');
  if (!existsSync(projectsDir)) {
    return ids;
  }
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) {
      continue;
    }
    const transcriptsDir = join(projectsDir, project.name, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) {
      continue;
    }
    for (const session of readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) {
        continue;
      }
      const subagentsDir = join(transcriptsDir, session.name, 'subagents');
      if (!existsSync(subagentsDir)) {
        continue;
      }
      for (const fileName of readdirSync(subagentsDir)) {
        if (fileName.endsWith('.jsonl')) {
          ids.add(basename(fileName, '.jsonl'));
        }
      }
    }
  }
  return ids;
}

function findStoreFile(sessionId) {
  for (const dir of listChatSessionDirs()) {
    if (basename(dir) !== sessionId) {
      continue;
    }
    const store = join(dir, 'store.db');
    if (existsSync(store)) {
      return store;
    }
  }
  return null;
}

function findTranscriptFile(sessionId) {
  const projectsDir = join(getCursorHome(), 'projects');
  if (!existsSync(projectsDir)) {
    return null;
  }
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) {
      continue;
    }
    const file = join(
      projectsDir,
      project.name,
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`,
    );
    if (existsSync(file)) {
      return file;
    }
  }
  return null;
}

function resolveSession(sessionFile) {
  if (basename(sessionFile) === 'meta.json') {
    const store = join(dirname(sessionFile), 'store.db');
    if (!existsSync(store)) {
      throw new Error(`Bad Cursor transcript file ${sessionFile}: no store.db`);
    }
    return resolveSession(store);
  }
  if (basename(sessionFile) === 'store.db') {
    const id = basename(dirname(sessionFile));
    const meta = readJsonFile(join(dirname(sessionFile), 'meta.json'));
    const stored = readStore(sessionFile);
    return {
      id,
      cwd: meta.cwd ?? null,
      messages: stored.messages,
      spans: stored.spans,
      blobCount: stored.blobCount,
      transcriptFile: findTranscriptFile(id),
    };
  }
  const id = basename(sessionFile, '.jsonl');
  const store = findStoreFile(id);
  if (store) {
    const meta = readJsonFile(join(dirname(store), 'meta.json'));
    const stored = readStore(store);
    return {
      id,
      cwd: meta.cwd ?? null,
      messages: stored.messages,
      spans: stored.spans,
      blobCount: stored.blobCount,
      transcriptFile: sessionFile,
    };
  }
  return {
    id,
    cwd: null,
    messages: readTranscriptMessages(sessionFile),
    spans: [],
    blobCount: 0,
    transcriptFile: sessionFile,
  };
}

function loadSubagents(sessionId, cwd, transcriptFile) {
  const files = new Map();
  const dirs = [];
  if (transcriptFile) {
    dirs.push(join(dirname(transcriptFile), 'subagents'));
  }
  if (cwd) {
    dirs.push(
      join(
        getCursorHome(),
        'projects',
        projectSlug(cwd),
        'agent-transcripts',
        sessionId,
        'subagents',
      ),
    );
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const fileName of readdirSync(dir)) {
      if (fileName.endsWith('.jsonl')) {
        files.set(basename(fileName, '.jsonl'), join(dir, fileName));
      }
    }
  }
  return [...files.values()]
    .toSorted()
    .map((file) => loadSubagent(file))
    .filter((agent) => agent !== null);
}

function loadSubagent(file) {
  const id = basename(file, '.jsonl');
  const store = findStoreFile(id);
  const stored = store ? readStore(store) : { messages: [], spans: [] };
  const messages = stored.messages.length > 0 ? stored.messages : readTranscriptMessages(file);
  if (messages.length === 0) {
    return null;
  }
  const meta = store ? readJsonFile(join(dirname(store), 'meta.json')) : {};
  const label = meta.title || labelFromMessages(messages, id);
  const agent = messagesToAgent(messages, label, false);
  applyModelSpans(agent, stored.spans);
  return agent;
}

function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

function readStore(file) {
  const database = openStore(file);
  try {
    const rows = database.prepare('SELECT data FROM blobs ORDER BY rowid').all();
    const messages = [];
    const spans = [];
    const seenSpans = new Set();
    for (const row of rows) {
      const bytes = Buffer.from(row.data);
      const message = parseMessageBlob(bytes);
      if (message) {
        messages.push(message);
        continue;
      }
      const span = readThinkingSpan(bytes);
      if (!span) {
        continue;
      }
      const key = `${span.startMs}\u0000${span.endMs}\u0000${span.label}`;
      if (seenSpans.has(key)) {
        continue;
      }
      seenSpans.add(key);
      spans.push(span);
    }
    return { messages, spans, blobCount: rows.length };
  } catch (error) {
    throw new Error(`Cannot read transcript file ${file}: ${error.message}`, { cause: error });
  } finally {
    database.close();
  }
}

function applyModelSpans(agent, spans) {
  if (!spans || spans.length === 0) {
    return;
  }
  agent.modelSpans = spans;
}

function readThinkingSpan(bytes) {
  const fields = parseProto(bytes);
  if (!fields || fields.length !== 1 || fields[0].field !== 3 || fields[0].kind !== 'bytes') {
    return null;
  }
  const inner = parseProto(fields[0].value);
  if (!inner) {
    return null;
  }
  const textField = inner.find((field) => field.field === 1 && field.kind === 'bytes');
  const startField = inner.find((field) => field.field === 3 && field.kind === 'varint');
  const endField = inner.find((field) => field.field === 4 && field.kind === 'varint');
  if (!textField || !startField || !endField) {
    return null;
  }
  const durationMs = endField.value - startField.value;
  if (durationMs <= 0 || durationMs > 15 * 60 * 1000) {
    return null;
  }
  if (startField.value < 1_000_000_000_000) {
    return null;
  }
  const text = readableText(textField.value);
  if (!text) {
    return null;
  }
  return { startMs: startField.value, endMs: endField.value, label: oneLine(text, 80) };
}

function parseProto(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) {
      return null;
    }
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0 || field > 200) {
      return null;
    }
    offset = key.next;
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) {
        return null;
      }
      offset = value.next;
      fields.push({ field, kind: 'varint', value: value.value });
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length) {
        return null;
      }
      offset = length.next;
      const end = offset + length.value;
      if (end > bytes.length) {
        return null;
      }
      fields.push({ field, kind: 'bytes', value: bytes.subarray(offset, end) });
      offset = end;
    } else {
      return null;
    }
  }
  return fields;
}

function readVarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < bytes.length && shift <= 49) {
    const byte = bytes[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: index };
    }
    shift += 7;
  }
  return null;
}

function readableText(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  if (text.includes('\uFFFD')) {
    return null;
  }
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return null;
    }
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function openStore(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new Error(
      `Cannot read transcript file ${file}: node:sqlite is not available (Node.js 22.13 or later).`,
      { cause: error },
    );
  }
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot read transcript file ${file}: ${error.message}`, { cause: error });
  }
}

function parseMessageBlob(data) {
  const text = Buffer.from(data).toString('utf8');
  if (!text.startsWith('{')) {
    return null;
  }
  try {
    const message = JSON.parse(text);
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}

function readTranscriptMessages(file) {
  const messages = [];
  for (const entry of readJsonl(file)) {
    if (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'tool') {
      continue;
    }
    const content = entry.message?.content;
    if (typeof content === 'string') {
      messages.push({ role: entry.role, content: [{ type: 'text', text: content }] });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const blocks = [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        blocks.push({
          type: 'tool-call',
          toolCallId: block.id ?? `tool-${messages.length}-${blocks.length}`,
          toolName: block.name ?? '?',
          args: block.input ?? {},
        });
      } else if (block?.type === 'tool_result' || block?.type === 'tool-result') {
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: block.tool_use_id ?? block.toolCallId,
              toolName: block.toolName ?? block.name ?? '?',
              result: block.content ?? block.result ?? '',
            },
          ],
        });
      } else if (block?.type === 'text') {
        blocks.push(block);
      }
    }
    if (blocks.length > 0) {
      messages.push({ role: entry.role, content: blocks, id: entry.message?.id });
    }
  }
  return messages;
}

function messagesToAgent(messages, label, isMain) {
  const agent = createAgent(label, isMain, 'partial');
  const callsById = new Map();
  const state = { clock: null, elapsed: 0 };
  for (const message of messages) {
    if (message.role === 'user') {
      readUserMessage(message, agent, state);
    } else if (message.role === 'assistant') {
      readAssistantMessage(message, agent, state, callsById);
    } else if (message.role === 'tool') {
      readToolMessage(message, agent, state, callsById);
    }
  }
  if (state.clock === null) {
    agent.timing = 'none';
  }
  return agent;
}

function readUserMessage(message, agent, state) {
  const timeMs = userTimeOf(joinTextBlocks(message.content));
  if (timeMs !== null) {
    anchor(agent, state, timeMs);
  }
  const stepTime = currentTime(state);
  agent.steps.push({ timeMs: stepTime, kind: 'user' });
  noteTime(agent, stepTime);
}

function readAssistantMessage(message, agent, state, callsById) {
  const content = Array.isArray(message.content) ? message.content : [];
  const toolCalls = content.filter(
    (block) => block?.type === 'tool-call' || block?.type === 'tool_use',
  );
  if (toolCalls.length === 0) {
    const stepTime = currentTime(state);
    agent.steps.push({ timeMs: stepTime, kind: 'model' });
    noteTime(agent, stepTime);
    return;
  }
  for (const block of toolCalls) {
    if (typeof block.startedAtMs === 'number') {
      anchor(agent, state, block.startedAtMs);
    }
    const tool = requireField(block.toolName ?? block.name, 'toolName', agent);
    const callId = requireField(block.toolCallId ?? block.id, 'toolCallId', agent);
    const args = normalizeArgs(block.args ?? block.input);
    if (callsById.has(callId)) {
      continue;
    }
    const startMs = currentTime(state);
    const call = createCall({
      tool,
      input: describeArgs(args, INPUT_KEYS),
      repeatInput: JSON.stringify(withoutDescription(args) ?? null),
      startMs,
      shellCommand: shellCommandOf(tool, args),
      editedFiles: editedFilesOf(tool, args),
    });
    callsById.set(callId, call);
    agent.calls.push(call);
    agent.steps.push({ timeMs: startMs, kind: 'model', call });
    noteTime(agent, startMs);
  }
}

function readToolMessage(message, agent, state, callsById) {
  const block = (Array.isArray(message.content) ? message.content : []).find(
    (item) => item?.type === 'tool-result' || item?.type === 'tool_result',
  );
  if (!block) {
    return;
  }
  const callId = requireField(block.toolCallId ?? block.tool_use_id, 'toolCallId', agent);
  const call = callsById.get(callId);
  if (!call) {
    return;
  }
  const text = resultText(block.result ?? block.content);
  const durationMs = durationOf(message);
  call.outputChars = text.length;
  const error = failureOf(message, text);
  if (error) {
    call.failed = true;
    call.error = error;
  }
  if (durationMs !== null && durationMs > 0) {
    call.endMs = call.startMs + durationMs;
    moveClock(state, call.endMs);
    noteTime(agent, call.endMs);
  }
  agent.steps.push({ timeMs: call.endMs ?? call.startMs, kind: 'tool_result' });
}

function requireField(value, field, agent) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `Bad Cursor session (${agent.label}): a tool row has no ${field}. The Cursor store format may have changed.`,
    );
  }
  return value;
}

function anchor(agent, state, timeMs) {
  if (state.clock === null) {
    const shift = timeMs - state.elapsed;
    if (state.elapsed !== 0) {
      shiftTimes(agent, shift);
    }
    state.clock = timeMs;
    state.elapsed = timeMs;
    return;
  }
  if (timeMs > state.clock) {
    state.clock = timeMs;
    state.elapsed = timeMs;
  }
}

function currentTime(state) {
  return state.clock === null ? state.elapsed : state.clock;
}

function moveClock(state, timeMs) {
  if (timeMs < currentTime(state)) {
    return;
  }
  if (state.clock === null) {
    state.elapsed = timeMs;
    return;
  }
  state.clock = timeMs;
  state.elapsed = timeMs;
}

function shiftTimes(agent, shift) {
  if (agent.startMs !== null) {
    agent.startMs += shift;
  }
  if (agent.endMs !== null) {
    agent.endMs += shift;
  }
  for (const call of agent.calls) {
    call.startMs += shift;
    if (call.endMs !== null) {
      call.endMs += shift;
    }
  }
  for (const step of agent.steps) {
    step.timeMs += shift;
  }
}

function durationOf(message) {
  const run = toolRun(message);
  const duration = run.localExecutionTimeMs ?? run.executionTime;
  return typeof duration === 'number' ? duration : null;
}

function failureOf(message, text) {
  const result = message.providerOptions?.cursor?.highLevelToolCallResult ?? {};
  if (result.isError === true) {
    const raw = Array.isArray(result.rawErrorMessages)
      ? result.rawErrorMessages.filter((line) => typeof line === 'string').join('\n')
      : '';
    return summarizeError(raw || text);
  }
  const exitCode = toolRun(message).exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return summarizeError(`exit code ${exitCode}\n${commandOutput(text)}`);
  }
  const exitLine = text.match(/^Exit code:\s*(\d+)/);
  if (exitLine && exitLine[1] !== '0') {
    return summarizeError(`exit code ${exitLine[1]}\n${commandOutput(text)}`);
  }
  return '';
}

function toolRun(message) {
  const output = message.providerOptions?.cursor?.highLevelToolCallResult?.output ?? {};
  return output.failure ?? output.success ?? {};
}

function commandOutput(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line !== '```' &&
        line !== 'Command output:' &&
        !line.startsWith('Exit code:'),
    )
    .join('\n');
}

function resultText(result) {
  if (result === undefined || typeof result === 'string' || Array.isArray(result)) {
    return joinTextBlocks(result);
  }
  return JSON.stringify(result);
}

function normalizeArgs(value) {
  if (typeof value !== 'string') {
    return value ?? {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    return value;
  }
  return value;
}

function shellCommandOf(tool, args) {
  if (!SHELL_TOOLS.has(tool) || !args || typeof args !== 'object') {
    return null;
  }
  const command = args.command ?? args.cmd;
  return typeof command === 'string' ? command : null;
}

function editedFilesOf(tool, args) {
  if (!EDIT_TOOLS.has(tool) || !args || typeof args !== 'object') {
    return [];
  }
  const file = args.path ?? args.file_path ?? args.notebook_path ?? args.target_file;
  return typeof file === 'string' ? [file] : [];
}

function userTimeOf(text) {
  const match = text.match(/<timestamp>([^<]+)<\/timestamp>/);
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return parseEnglishTime(raw);
}

function parseEnglishTime(raw) {
  const match = raw.match(
    /(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*\(UTC([+-])(\d{1,2})(?::(\d{2}))?\))?/i,
  );
  if (!match) {
    return null;
  }
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month === undefined) {
    return null;
  }
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === 'PM') {
    hour += 12;
  }
  const year = Number(match[3]);
  const day = Number(match[2]);
  const minute = Number(match[5]);
  if (!match[7]) {
    return new Date(year, month, day, hour, minute).getTime();
  }
  const sign = match[7] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(match[8]) * 60 + Number(match[9] ?? 0));
  return Date.UTC(year, month, day, hour, minute) - offsetMinutes * 60 * 1000;
}

function labelFromMessages(messages, fallback) {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = joinTextBlocks(message.content)
      .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
      .trim();
    const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    const body = (query?.[1] ?? text).trim();
    const line = body
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item !== '');
    if (line) {
      return oneLine(line, 60);
    }
  }
  return fallback;
}
