import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createAgent,
  noteTime,
  oneLine,
  parseTime,
  readJsonFile,
  readJsonl,
  readTranscript,
  summarizeError,
} from './transcript.mjs';

const INPUT_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
];

export function listClaudeSessions(cwd) {
  const projectDir = join(getProjectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  if (!existsSync(projectDir)) {
    return [];
  }
  return readdirSync(projectDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .map((fileName) => join(projectDir, fileName));
}

export function findClaudeSessionById(sessionId) {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) {
    return null;
  }
  for (const projectDir of readdirSync(projectsDir)) {
    const sessionFile = join(projectsDir, projectDir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) {
      return sessionFile;
    }
  }
  return null;
}

export function readClaudeSession(sessionFile) {
  const entries = readTranscript(sessionFile);
  if (!entries.some(isClaudeMessageEntry)) {
    throw new Error(`Not a Claude Code or Codex transcript: ${sessionFile}`);
  }
  const mainEntries = entries.filter((entry) => entry.isSidechain !== true);
  const mainAgent = readClaudeAgent(mainEntries, 'main', true);
  const subagents = loadSubagents(sessionFile);
  return {
    id: basename(sessionFile, '.jsonl'),
    harness: 'Claude Code',
    agents: [mainAgent, ...subagents],
  };
}

function isClaudeMessageEntry(entry) {
  return (entry.type === 'user' || entry.type === 'assistant') && typeof entry.message === 'object';
}

function getProjectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(configDir, 'projects');
}

function loadSubagents(sessionFile) {
  const sessionDir = join(dirname(sessionFile), basename(sessionFile, '.jsonl'));
  const subagentsDir = join(sessionDir, 'subagents');
  if (!existsSync(subagentsDir)) {
    return [];
  }
  return readdirSync(subagentsDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .toSorted()
    .map((fileName) => loadSubagent(subagentsDir, fileName));
}

function loadSubagent(subagentsDir, fileName) {
  const name = basename(fileName, '.jsonl');
  const meta = readJsonFile(join(subagentsDir, `${name}.meta.json`));
  const label = meta.name ?? meta.description ?? meta.agentType ?? name.replace(/^agent-/, '');
  const entries = readJsonl(join(subagentsDir, fileName));
  return readClaudeAgent(entries, label, false);
}

function readClaudeAgent(entries, label, isMain) {
  const agent = createAgent(label, isMain);
  const callsById = new Map();
  const usageByMessage = new Map();
  for (const entry of entries) {
    const timeMs = parseTime(entry.timestamp);
    if (timeMs === null) {
      continue;
    }
    if (entry.type === 'assistant') {
      noteTime(agent, timeMs);
      readAssistantEntry(entry, timeMs, agent, callsById, usageByMessage);
    } else if (entry.type === 'user') {
      noteTime(agent, timeMs);
      readUserEntry(entry, timeMs, agent, callsById);
    }
  }
  const usage = sumUsage(usageByMessage.values());
  agent.tokens = usage.tokens;
  agent.cacheReadTokens = usage.cacheReadTokens;
  return agent;
}

function readAssistantEntry(entry, timeMs, agent, callsById, usageByMessage) {
  const message = entry.message;
  if (message?.usage && message.model !== '<synthetic>') {
    usageByMessage.set(message.id ?? entry.uuid, message.usage);
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses = content.filter((block) => block?.type === 'tool_use');
  if (toolUses.length === 0) {
    agent.steps.push({ timeMs, kind: 'model' });
    return;
  }
  for (const block of toolUses) {
    if (callsById.has(block.id)) {
      continue;
    }
    const call = {
      tool: block.name ?? '?',
      input: describeInput(block.input),
      repeatKey: `${block.name}\u0000${JSON.stringify(withoutDescription(block.input))}`,
      startMs: timeMs,
      endMs: null,
      failed: false,
      error: '',
      outputChars: 0,
    };
    callsById.set(block.id, call);
    agent.calls.push(call);
    agent.steps.push({ timeMs, kind: 'model', call });
  }
}

function readUserEntry(entry, timeMs, agent, callsById) {
  const content = entry.message?.content;
  const toolResults = Array.isArray(content)
    ? content.filter((block) => block?.type === 'tool_result')
    : [];
  if (toolResults.length === 0) {
    agent.steps.push({ timeMs, kind: 'user' });
    return;
  }
  for (const block of toolResults) {
    agent.steps.push({ timeMs, kind: 'tool_result' });
    const call = callsById.get(block.tool_use_id);
    if (!call) {
      continue;
    }
    const text = getResultText(block.content);
    call.endMs = timeMs;
    call.outputChars = text.length;
    if (block.is_error === true) {
      call.failed = true;
      call.error = summarizeError(text.replace(/<\/?tool_use_error>/g, ''));
    }
  }
}

function getResultText(content) {
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

function describeInput(input) {
  if (input === null || typeof input !== 'object') {
    return oneLine(input);
  }
  for (const key of INPUT_KEYS) {
    if (typeof input[key] === 'string') {
      return oneLine(input[key]);
    }
  }
  return oneLine(JSON.stringify(input));
}

function withoutDescription(input) {
  if (input === null || typeof input !== 'object') {
    return input;
  }
  const { description: _description, ...rest } = input;
  return rest;
}

function sumUsage(usages) {
  let tokens = 0;
  let cacheReadTokens = 0;
  for (const usage of usages) {
    tokens +=
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }
  return { tokens, cacheReadTokens };
}
