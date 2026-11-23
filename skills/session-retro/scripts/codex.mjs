import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  createAgent,
  listJsonlFiles,
  noteTime,
  oneLine,
  parseTime,
  readFirstJsonLine,
  readJsonl,
  readTranscript,
  summarizeError,
} from './transcript.mjs';

const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const MODEL_TYPES = new Set(['reasoning', 'web_search_call', 'local_shell_call']);

export function isCodexTranscript(file) {
  return readFirstJsonLine(file)?.type === 'session_meta';
}

export function listCodexMainSessions(cwd) {
  return listCodexSessions()
    .filter(({ meta }) => meta.cwd === cwd && !isSubagentMeta(meta))
    .map(({ file }) => file);
}

export function findCodexSessionById(sessionId) {
  const match = listCodexFiles().find((file) => {
    const name = basename(file);
    return name === `${sessionId}.jsonl` || name.endsWith(`-${sessionId}.jsonl`);
  });
  return match ?? null;
}

export function readCodexSession(sessionFile) {
  const entries = readTranscript(sessionFile);
  const meta = entries.find((entry) => entry.type === 'session_meta')?.payload;
  if (!meta) {
    throw new Error(`Bad Codex transcript file ${sessionFile}: no session_meta line`);
  }
  const sessionId = getSessionId(meta);
  const mainAgent = readCodexAgent(entries, 'main', true);
  const subagents = findDescendants(sessionId, sessionFile).map(({ file, meta: childMeta }) =>
    readCodexAgent(readJsonl(file), getSubagentLabel(childMeta), false),
  );
  return { id: sessionId, harness: 'Codex', agents: [mainAgent, ...subagents] };
}

function getCodexHome() {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function listCodexFiles() {
  const codexHome = getCodexHome();
  return [
    ...listJsonlFiles(join(codexHome, 'sessions')),
    ...listJsonlFiles(join(codexHome, 'archived_sessions')),
  ];
}

function listCodexSessions() {
  const sessions = [];
  for (const file of listCodexFiles()) {
    const firstLine = readFirstJsonLine(file);
    if (firstLine?.type === 'session_meta' && firstLine.payload) {
      sessions.push({ file, meta: firstLine.payload });
    }
  }
  return sessions;
}

function findDescendants(rootId, rootFile) {
  const rootPath = resolve(rootFile);
  const sessions = listCodexSessions().filter(({ file }) => resolve(file) !== rootPath);
  const descendants = [];
  const visited = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const session of sessions) {
      const sessionId = getSessionId(session.meta);
      if (getParentId(session.meta) !== parentId || visited.has(sessionId)) {
        continue;
      }
      visited.add(sessionId);
      descendants.push(session);
      queue.push(sessionId);
    }
  }
  return descendants;
}

function getSessionId(meta) {
  return meta.id ?? meta.session_id;
}

function getParentId(meta) {
  return meta.source?.subagent?.thread_spawn?.parent_thread_id;
}

function isSubagentMeta(meta) {
  return Boolean(meta.source?.subagent) || meta.thread_source === 'subagent';
}

function getSubagentLabel(meta) {
  const spawn = meta.source?.subagent?.thread_spawn ?? {};
  const pathName = spawn.agent_path?.split('/').pop();
  return pathName || spawn.agent_nickname || spawn.agent_role || getSessionId(meta);
}

function readCodexAgent(entries, label, isMain) {
  const agent = createAgent(label, isMain);
  const callsById = new Map();
  const failuresById = new Map();
  for (const entry of entries) {
    const timeMs = parseTime(entry.timestamp);
    const payload = entry.payload;
    if (timeMs === null || !payload) {
      continue;
    }
    noteTime(agent, timeMs);
    if (entry.type === 'response_item') {
      readResponseItem(payload, timeMs, agent, callsById);
    } else if (entry.type === 'event_msg' && payload.type === 'task_started') {
      agent.steps.push({ timeMs, kind: 'user' });
    } else if (entry.type === 'event_msg') {
      readEvent(payload, agent, failuresById);
    }
  }
  applyFailures(callsById, failuresById);
  return agent;
}

function readResponseItem(payload, timeMs, agent, callsById) {
  if (CALL_TYPES.has(payload.type)) {
    addCall(payload, timeMs, agent, callsById);
  } else if (OUTPUT_TYPES.has(payload.type)) {
    agent.steps.push({ timeMs, kind: 'tool_result' });
    readOutput(payload, timeMs, callsById);
  } else if (payload.type === 'message' && payload.role === 'user') {
    agent.steps.push({ timeMs, kind: 'user' });
  } else if (payload.type === 'message' && payload.role === 'assistant') {
    agent.steps.push({ timeMs, kind: 'model' });
  } else if (MODEL_TYPES.has(payload.type)) {
    agent.steps.push({ timeMs, kind: 'model' });
  }
}

function addCall(payload, timeMs, agent, callsById) {
  const callId = payload.call_id ?? payload.id;
  if (callsById.has(callId)) {
    return;
  }
  const tool = payload.name ?? '?';
  const rawInput = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
  const args = parseArguments(rawInput);
  const call = {
    tool,
    input: describeInput(tool, args, rawInput),
    repeatKey: `${tool}\u0000${getRepeatInput(tool, args, rawInput)}`,
    startMs: timeMs,
    endMs: null,
    failed: false,
    error: '',
    outputChars: 0,
  };
  callsById.set(callId, call);
  agent.calls.push(call);
  agent.steps.push({ timeMs, kind: 'model', call });
}

function readOutput(payload, timeMs, callsById) {
  const call = callsById.get(payload.call_id);
  if (!call) {
    return;
  }
  const text = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output);
  call.endMs = timeMs;
  call.outputChars = text.length;
  const error = findOutputError(text);
  if (error) {
    call.failed = true;
    call.error = error;
  }
}

function findOutputError(text) {
  const exitCode = text.match(/^(?:Process exited with code|Exit code:) (\d+)$/m);
  if (exitCode && exitCode[1] !== '0') {
    const outputStart = text.indexOf('Output:\n');
    const output = outputStart === -1 ? '' : text.slice(outputStart + 'Output:\n'.length);
    return summarizeError(`exit code ${exitCode[1]}\n${output}`);
  }
  if (/^\S+ failed: /.test(text) || text.startsWith('aborted by user')) {
    return summarizeError(text);
  }
  return '';
}

function readEvent(payload, agent, failuresById) {
  if (payload.type === 'token_count') {
    const total = payload.info?.total_token_usage?.total_tokens;
    if (typeof total === 'number' && total > agent.tokens) {
      agent.tokens = total;
    }
  } else if (payload.type === 'mcp_tool_call_end') {
    const result = payload.result ?? {};
    if (result.Err !== undefined) {
      failuresById.set(payload.call_id, summarizeError(JSON.stringify(result.Err)));
    } else if (result.Ok?.isError === true) {
      failuresById.set(payload.call_id, summarizeError(getMcpText(result.Ok)));
    }
  } else if (payload.type === 'patch_apply_end' && payload.success === false) {
    failuresById.set(payload.call_id, summarizeError(payload.stderr || payload.stdout));
  } else if (payload.type === 'exec_command_end' && payload.exit_code) {
    const output = payload.stderr || payload.aggregated_output || payload.stdout || '';
    failuresById.set(payload.call_id, summarizeError(`exit code ${payload.exit_code}\n${output}`));
  }
}

function applyFailures(callsById, failuresById) {
  for (const [callId, error] of failuresById) {
    const call = callsById.get(callId);
    if (call && !call.failed) {
      call.failed = true;
      call.error = error;
    }
  }
}

function getMcpText(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((block) => typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function parseArguments(rawInput) {
  if (typeof rawInput !== 'string') {
    return rawInput ?? null;
  }
  try {
    return JSON.parse(rawInput);
  } catch {
    return null;
  }
}

function describeInput(tool, args, rawInput) {
  const command = getCommand(args);
  if (command) {
    return oneLine(command);
  }
  if (tool === 'apply_patch' && typeof rawInput === 'string') {
    const files = rawInput.match(/^\*\*\* (?:Add|Update|Delete) File: .+$/gm) ?? [];
    return oneLine(files.map((line) => line.replace(/^\*\*\* /, '')).join(', ') || rawInput);
  }
  if (args && typeof args === 'object') {
    return oneLine(JSON.stringify(args));
  }
  return oneLine(rawInput);
}

function getRepeatInput(tool, args, rawInput) {
  const command = getCommand(args);
  if (command) {
    return `${command}\u0000${args.workdir ?? ''}`;
  }
  return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
}

function getCommand(args) {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const command = args.cmd ?? args.command;
  if (typeof command === 'string') {
    return command;
  }
  if (Array.isArray(command)) {
    const isShellWrapper = command.length === 3 && /^-l?c$/.test(command[1]);
    return isShellWrapper ? command[2] : command.join(' ');
  }
  return '';
}
