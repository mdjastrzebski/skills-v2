import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createAgent,
  noteTime,
  oneLine,
  readJsonFile,
  readJsonl,
  readFirstJsonLine,
  summarizeError,
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

export function listCursorMainSessions(cwd) {
  const subagentIds = listSubagentIds();
  const files = [];
  for (const dir of listChatSessionDirs()) {
    const meta = readJsonFile(join(dir, 'meta.json'));
    const store = join(dir, 'store.db');
    if (meta.cwd !== cwd || subagentIds.has(basename(dir)) || !existsSync(store)) {
      continue;
    }
    files.push(store);
  }
  return files;
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
  if (resolved.messages.length === 0) {
    throw new Error(`Bad transcript file ${sessionFile}: no valid JSON lines`);
  }
  const mainAgent = messagesToAgent(resolved.messages, 'main', true);
  applyModelSpans(mainAgent, resolved.spans);
  const subagents = loadSubagents(resolved.id, resolved.cwd, resolved.transcriptFile);
  return { id: resolved.id, harness: 'Cursor', agents: [mainAgent, ...subagents] };
}

function getCursorHome() {
  return process.env.CURSOR_HOME ?? join(homedir(), '.cursor');
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
      transcriptFile: sessionFile,
    };
  }
  return {
    id,
    cwd: null,
    messages: readTranscriptMessages(sessionFile),
    spans: [],
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
      const bytes = toBytes(row.data);
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
    return { messages, spans };
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

function toBytes(data) {
  if (typeof data === 'string') {
    return Buffer.from(data);
  }
  return Buffer.from(data);
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
      `Cannot read transcript file ${file}: node:sqlite is not available (Node.js 22 or later).`,
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
  const agent = createAgent(label, isMain);
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
  return agent;
}

function readUserMessage(message, agent, state) {
  const timeMs = userTimeOf(textOf(message.content));
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
    const tool = block.toolName ?? block.name ?? '?';
    const args = normalizeArgs(block.args ?? block.input);
    const callId = block.toolCallId ?? block.id ?? `${tool}-${callsById.size}`;
    if (callsById.has(callId)) {
      continue;
    }
    const startMs = currentTime(state);
    const call = {
      tool,
      input: describeInput(args),
      repeatKey: `${tool}\u0000${repeatInput(args)}`,
      startMs,
      endMs: null,
      failed: false,
      error: '',
      outputChars: 0,
      shellCommand: shellCommandOf(tool, args),
      editedFiles: editedFilesOf(tool, args),
    };
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
  const call = callsById.get(block.toolCallId ?? block.tool_use_id);
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
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    return result
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return result === undefined ? '' : JSON.stringify(result);
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

function describeInput(args) {
  if (typeof args === 'string') {
    return oneLine(args);
  }
  if (!args || typeof args !== 'object') {
    return oneLine(args);
  }
  for (const key of INPUT_KEYS) {
    if (typeof args[key] === 'string') {
      return oneLine(args[key]);
    }
  }
  return oneLine(JSON.stringify(args));
}

function repeatInput(args) {
  if (!args || typeof args !== 'object') {
    return JSON.stringify(args ?? null);
  }
  const { description: _description, ...rest } = args;
  return JSON.stringify(rest);
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

function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
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
  const utc = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5]));
  const sign = match[7] === '-' ? -1 : 1;
  const offsetMinutes = match[7] ? sign * (Number(match[8]) * 60 + Number(match[9] ?? 0)) : 0;
  return utc - offsetMinutes * 60 * 1000;
}

function labelFromMessages(messages, fallback) {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = textOf(message.content)
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
