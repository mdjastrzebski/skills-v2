#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const HELP = `Usage: node summary.mjs [session-id | path/to/session.jsonl]

Shows the subagent calls of a Claude Code session: task, agent type, model,
cost, and duration, with nested subagents.

Without an argument, it uses the most recent session of the current directory.
Costs are estimates, calculated from token usage and the PRICES_PER_MILLION_TOKENS table.`;

function main() {
  const argument = process.argv[2];
  if (argument === '--help' || argument === '-h') {
    console.log(HELP);
    return;
  }

  const sessionFile = findSessionFile(argument);
  const mainAgent = summarizeTranscript(sessionFile);
  const subagents = loadSubagents(sessionFile);
  const rootSubagents = buildSubagentTree(subagents);

  printSessionTotals(sessionFile, mainAgent, subagents);
  printSubagentList(rootSubagents);
}

function findSessionFile(argument) {
  if (argument && argument.endsWith('.jsonl')) {
    return argument;
  }
  if (argument) {
    return findSessionFileById(argument);
  }
  return findLatestSessionFileForCurrentDirectory();
}

function findSessionFileById(sessionId) {
  const projectsDir = getProjectsDir();
  for (const projectDir of readdirSync(projectsDir)) {
    const sessionFile = join(projectsDir, projectDir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) {
      return sessionFile;
    }
  }
  throw new Error(`Session not found: ${sessionId}`);
}

function findLatestSessionFileForCurrentDirectory() {
  const projectDirName = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = join(getProjectsDir(), projectDirName);
  if (!existsSync(projectDir)) {
    throw new Error(`No sessions for ${process.cwd()}`);
  }

  const sessionFiles = readdirSync(projectDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .map((fileName) => join(projectDir, fileName));
  if (sessionFiles.length === 0) {
    throw new Error(`No sessions for ${process.cwd()}`);
  }

  sessionFiles.sort((a, b) => getModifiedTime(b) - getModifiedTime(a));
  return sessionFiles[0];
}

function getProjectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(configDir, 'projects');
}

function getModifiedTime(file) {
  return statSync(file).mtimeMs;
}

function loadSubagents(sessionFile) {
  const sessionDir = join(dirname(sessionFile), basename(sessionFile, '.jsonl'));
  const subagentsDir = join(sessionDir, 'subagents');
  if (!existsSync(subagentsDir)) {
    return [];
  }

  const transcriptFileNames = readdirSync(subagentsDir).filter((fileName) => fileName.endsWith('.jsonl'));
  const subagents = transcriptFileNames.map((fileName) => loadSubagent(subagentsDir, fileName));
  subagents.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return subagents;
}

function loadSubagent(subagentsDir, transcriptFileName) {
  const name = basename(transcriptFileName, '.jsonl');
  const id = name.replace(/^agent-/, '');
  const meta = readMetaFile(join(subagentsDir, `${name}.meta.json`));
  const transcript = summarizeTranscript(join(subagentsDir, transcriptFileName));

  return {
    id,
    task: meta.description ?? getFirstLine(transcript.firstPrompt),
    agentType: meta.agentType ?? 'unknown',
    effort: meta.effort,
    parentId: meta.parentAgentId,
    ...transcript,
    children: [],
  };
}

function readMetaFile(metaFile) {
  if (!existsSync(metaFile)) {
    return {};
  }
  return JSON.parse(readFileSync(metaFile, 'utf8'));
}

function buildSubagentTree(subagents) {
  const subagentsById = new Map();
  for (const subagent of subagents) {
    subagentsById.set(subagent.id, subagent);
  }

  const rootSubagents = [];
  for (const subagent of subagents) {
    const parent = subagentsById.get(subagent.parentId);
    if (parent) {
      parent.children.push(subagent);
    } else {
      rootSubagents.push(subagent);
    }
  }
  return rootSubagents;
}

function summarizeTranscript(transcriptFile) {
  const entries = readJsonl(transcriptFile);
  const messages = getUniqueAssistantMessages(entries);
  const timestamps = entries.map((entry) => entry.timestamp).filter(Boolean);
  const startTime = timestamps[0] ?? '';
  const endTime = timestamps[timestamps.length - 1] ?? '';

  const models = new Set();
  let cost = 0;
  let hasUnpricedModel = false;
  for (const message of messages) {
    models.add(message.model);
    const messageCost = calculateMessageCost(message);
    if (messageCost === null) {
      hasUnpricedModel = true;
    } else {
      cost += messageCost;
    }
  }

  return {
    models: [...models],
    cost,
    hasUnpricedModel,
    startTime,
    durationMs: startTime ? Date.parse(endTime) - Date.parse(startTime) : 0,
    firstPrompt: findFirstPrompt(entries),
  };
}

function readJsonl(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const entries = [];
  for (const line of lines) {
    const entry = parseJson(line);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function getUniqueAssistantMessages(entries) {
  const messagesById = new Map();
  for (const entry of entries) {
    const message = entry.message;
    const isModelMessage = entry.type === 'assistant' && message?.usage && message.model && message.model !== '<synthetic>';
    if (isModelMessage) {
      messagesById.set(message.id ?? entry.uuid, message);
    }
  }
  return [...messagesById.values()];
}

function findFirstPrompt(entries) {
  for (const entry of entries) {
    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      return entry.message.content;
    }
  }
  return '';
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const FAST_MODE_MULTIPLIER = 2;

const PRICES_PER_MILLION_TOKENS = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { minTokens: 100_000, multiplier: 5 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

function calculateMessageCost(message) {
  const prices = findPrices(message.model);
  if (!prices) {
    return null;
  }

  const usage = message.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWrite1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cacheWrite5mTokens = (usage.cache_creation_input_tokens ?? 0) - cacheWrite1hTokens;

  const inputCost = inputTokens * prices.input;
  const outputCost = outputTokens * prices.output;
  const cacheReadCost = cacheReadTokens * prices.cacheRead;
  const cacheWriteCost =
    cacheWrite5mTokens * prices.input * CACHE_WRITE_5M_MULTIPLIER +
    cacheWrite1hTokens * prices.input * CACHE_WRITE_1H_MULTIPLIER;

  let multiplier = 1;
  if (usage.speed === 'fast') {
    multiplier *= FAST_MODE_MULTIPLIER;
  }
  const promptTokens = inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens;
  if (prices.longPrompt && promptTokens > prices.longPrompt.minTokens) {
    multiplier *= prices.longPrompt.multiplier;
  }

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return (totalCost * multiplier) / 1_000_000;
}

function findPrices(model) {
  let bestMatch = null;
  for (const modelPrefix of Object.keys(PRICES_PER_MILLION_TOKENS)) {
    const matches = model === modelPrefix || model.startsWith(`${modelPrefix}-`);
    if (matches && (!bestMatch || modelPrefix.length > bestMatch.length)) {
      bestMatch = modelPrefix;
    }
  }
  return bestMatch ? PRICES_PER_MILLION_TOKENS[bestMatch] : null;
}

function printSessionTotals(sessionFile, mainAgent, subagents) {
  let subagentsCost = 0;
  for (const subagent of subagents) {
    subagentsCost += subagent.cost;
  }

  console.log(`## Session \`${basename(sessionFile, '.jsonl')}\`\n`);
  console.log(`- Main agent: ${formatModels(mainAgent.models)}, ${formatCost(mainAgent.cost)}`);
  console.log(`- Subagents: ${subagents.length}, ${formatCost(subagentsCost)}`);
  console.log(`- Total: ${formatCost(mainAgent.cost + subagentsCost)} (estimate)\n`);
}

function printSubagentList(rootSubagents) {
  if (rootSubagents.length === 0) {
    return;
  }
  console.log('## Subagents\n');
  rootSubagents.forEach((subagent, index) => {
    printSubagent(subagent, `${index + 1}`, 0);
  });
}

function printSubagent(subagent, label, depth) {
  const indent = '  '.repeat(depth);
  const effort = subagent.effort ? `, effort ${subagent.effort}` : '';

  let cost = formatCost(subagent.cost);
  if (subagent.hasUnpricedModel) {
    cost += ' + unpriced model';
  }
  if (subagent.children.length > 0) {
    cost += ` (${formatCost(getCostWithChildren(subagent))} with nested)`;
  }

  console.log(`${indent}- **${label}. ${subagent.task}**`);
  console.log(`${indent}  - Agent: ${subagent.agentType} (\`${subagent.id}\`)`);
  console.log(`${indent}  - Model: ${formatModels(subagent.models)}${effort}`);
  console.log(`${indent}  - Cost: ${cost}`);
  console.log(`${indent}  - Duration: ${formatDuration(subagent.durationMs)}`);

  subagent.children.forEach((child, index) => {
    printSubagent(child, `${label}.${index + 1}`, depth + 1);
  });
}

function getCostWithChildren(subagent) {
  let cost = subagent.cost;
  for (const child of subagent.children) {
    cost += getCostWithChildren(child);
  }
  return cost;
}

function getFirstLine(text) {
  const firstLine = text.split('\n')[0] || '?';
  const maxLength = 80;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLength - 1)}…`;
}

function formatModels(models) {
  if (models.length === 0) {
    return '?';
  }
  return models.map((model) => model.replace(/^claude-/, '')).join(', ');
}

function formatCost(cost) {
  return `$${cost.toFixed(2)}`;
}

function formatDuration(durationMs) {
  if (durationMs >= 60_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }
  return `${Math.round(durationMs / 1000)}s`;
}

main();
