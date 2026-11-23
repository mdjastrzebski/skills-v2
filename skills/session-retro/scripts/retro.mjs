#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { findClaudeSessionById, listClaudeSessions, readClaudeSession } from './claude.mjs';
import {
  findCodexSessionById,
  isCodexTranscript,
  listCodexMainSessions,
  readCodexSession,
} from './codex.mjs';

const TOP_ITEMS = 5;
const CHARS_PER_TOKEN = 4;

const HELP = `Usage: node retro.mjs [session-id | path/to/session.jsonl]

Prints retro signals for a Claude Code or Codex session and its subagents:
failed tool calls, repeats, token hotspots, and time hotspots.

Without an argument, it uses the latest main session of the current directory.
It shows the top ${TOP_ITEMS} items for each signal.`;

main();

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  try {
    const sessionFile = selectSessionFile(args);
    const session = readSession(sessionFile);
    console.log(formatReport(session));
  } catch (error) {
    console.error(`session-retro: ${error.message}`);
    process.exitCode = 1;
  }
}

function selectSessionFile(args) {
  if (args.length > 1) {
    throw new Error(`Too many arguments: ${args.join(' ')}. See --help.`);
  }
  const argument = args[0];
  if (argument === undefined || argument === '') {
    return findLatestSessionFile(process.cwd());
  }
  if (argument.startsWith('-')) {
    throw new Error(`Unknown option: ${argument}. See --help.`);
  }
  if (argument.endsWith('.jsonl')) {
    if (!existsSync(argument)) {
      throw new Error(`Session file not found: ${argument}`);
    }
    return resolve(argument);
  }
  const sessionFile = findCodexSessionById(argument) ?? findClaudeSessionById(argument);
  if (!sessionFile) {
    throw new Error(`Unknown session ID: ${argument} (no Claude Code or Codex transcript)`);
  }
  return sessionFile;
}

function findLatestSessionFile(cwd) {
  const candidates = [...listCodexMainSessions(cwd), ...listClaudeSessions(cwd)];
  if (candidates.length === 0) {
    throw new Error(`No Claude Code or Codex session found for the current directory: ${cwd}`);
  }
  const sorted = candidates.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return sorted[0];
}

function readSession(sessionFile) {
  if (isCodexTranscript(sessionFile)) {
    return readCodexSession(sessionFile);
  }
  return readClaudeSession(sessionFile);
}

function formatReport(session) {
  const subagentCount = session.agents.length - 1;
  const lines = [
    `Session: ${session.id}`,
    `Harness: ${session.harness}`,
    `Agents: main + ${subagentCount} subagent${subagentCount === 1 ? '' : 's'}`,
    `Top ${TOP_ITEMS} items per signal. ~tokens = chars / ${CHARS_PER_TOKEN}.`,
    '',
    ...formatFailedCalls(session.agents),
    '',
    ...formatRepeats(session.agents),
    '',
    ...formatTokenHotspots(session.agents),
    '',
    ...formatTimeHotspots(session.agents),
  ];
  return lines.join('\n');
}

function formatFailedCalls(agents) {
  const failed = getAllCalls(agents)
    .filter(({ call }) => call.failed)
    .toSorted((a, b) => a.call.startMs - b.call.startMs);
  const lines = [`## Failed tool calls (${failed.length})`];
  const items = failed
    .slice(0, TOP_ITEMS)
    .map(({ agent, call }) => `- ${formatAgent(agent)} ${formatCall(call)} -> ${call.error}`);
  lines.push(...orNone(items));
  if (failed.length > TOP_ITEMS) {
    lines.push(`- (+${failed.length - TOP_ITEMS} more)`);
  }
  return lines;
}

function formatRepeats(agents) {
  const repeats = [];
  for (const agent of agents) {
    const groups = new Map();
    for (const call of agent.calls) {
      const group = groups.get(call.repeatKey) ?? [];
      group.push(call);
      groups.set(call.repeatKey, group);
    }
    for (const calls of groups.values()) {
      if (calls.length > 1) {
        repeats.push({ agent, calls });
      }
    }
  }
  repeats.sort((a, b) => b.calls.length - a.calls.length);
  const items = repeats.slice(0, TOP_ITEMS).map(({ agent, calls }) => {
    const failedCount = calls.filter((call) => call.failed).length;
    const failedText = failedCount > 0 ? ` (${failedCount} failed)` : '';
    return `- ${calls.length}x ${formatAgent(agent)} ${formatCall(calls[0])}${failedText}`;
  });
  return ['## Repeats', ...orNone(items)];
}

function formatTokenHotspots(agents) {
  const largestResults = getAllCalls(agents)
    .filter(({ call }) => call.outputChars > 0)
    .toSorted((a, b) => b.call.outputChars - a.call.outputChars)
    .slice(0, TOP_ITEMS)
    .map(
      ({ agent, call }) =>
        `- ${formatCount(call.outputChars)} chars (~${formatCount(call.outputChars / CHARS_PER_TOKEN)} tokens) ${formatAgent(agent)} ${formatCall(call)}`,
    );
  const subagentsByTokens = agents
    .filter((agent) => !agent.isMain && agent.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_ITEMS)
    .map((agent) => `- ${formatCount(agent.tokens)} tokens ${formatAgent(agent)}`);
  const mainAgent = agents.find((agent) => agent.isMain);
  return [
    '## Token hotspots',
    'Largest tool results:',
    ...orNone(largestResults),
    `Subagents by token use (main: ${formatCount(mainAgent.tokens)} tokens):`,
    ...orNone(subagentsByTokens),
  ];
}

function formatTimeHotspots(agents) {
  const longestCalls = getAllCalls(agents)
    .filter(({ call }) => call.endMs !== null && call.endMs > call.startMs)
    .toSorted((a, b) => b.call.endMs - b.call.startMs - (a.call.endMs - a.call.startMs))
    .slice(0, TOP_ITEMS)
    .map(
      ({ agent, call }) =>
        `- ${formatDuration(call.endMs - call.startMs)} ${formatAgent(agent)} ${formatCall(call)}`,
    );
  const longestGaps = agents
    .flatMap((agent) => findModelGaps(agent).map((gap) => ({ agent, gap })))
    .toSorted((a, b) => b.gap.durationMs - a.gap.durationMs)
    .slice(0, TOP_ITEMS)
    .map(
      ({ agent, gap }) =>
        `- ${formatDuration(gap.durationMs)} ${formatAgent(agent)} at ${formatClock(gap.startMs)}, before ${gap.label}`,
    );
  const slowestSubagents = agents
    .filter((agent) => !agent.isMain && agent.startMs !== null && agent.endMs > agent.startMs)
    .toSorted((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .slice(0, TOP_ITEMS)
    .map((agent) => `- ${formatDuration(agent.endMs - agent.startMs)} ${formatAgent(agent)}`);
  return [
    '## Time hotspots',
    'Longest tool calls:',
    ...orNone(longestCalls),
    'Longest gaps between steps (model time or idle; tool runs and user waits excluded):',
    ...orNone(longestGaps),
    'Slowest subagents:',
    ...orNone(slowestSubagents),
  ];
}

function findModelGaps(agent) {
  const gaps = [];
  const steps = agent.steps.toSorted((a, b) => a.timeMs - b.timeMs);
  let index = 0;
  while (index < steps.length) {
    if (steps[index].kind !== 'model' || index === 0) {
      index += 1;
      continue;
    }
    const previous = steps[index - 1];
    let runEnd = index;
    while (runEnd + 1 < steps.length && steps[runEnd + 1].kind === 'model') {
      runEnd += 1;
    }
    const run = steps.slice(index, runEnd + 1);
    const firstCall = run.find((step) => step.call)?.call;
    const label = firstCall ? formatCall(firstCall) : 'reply';
    const durationMs = steps[runEnd].timeMs - previous.timeMs;
    if (durationMs > 0) {
      gaps.push({ startMs: previous.timeMs, durationMs, label });
    }
    index = runEnd + 1;
  }
  return gaps;
}

function getAllCalls(agents) {
  return agents.flatMap((agent) => agent.calls.map((call) => ({ agent, call })));
}

function orNone(items) {
  return items.length > 0 ? items : ['none'];
}

function formatAgent(agent) {
  return agent.isMain ? '[main]' : `[subagent: ${agent.label}]`;
}

function formatCall(call) {
  return `${call.tool}: \`${call.input}\``;
}

function formatCount(value) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function formatDuration(durationMs) {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (totalSeconds === 0) {
    return `${durationMs}ms`;
  }
  return `${seconds}s`;
}

function formatClock(timeMs) {
  return `${new Date(timeMs).toISOString().slice(11, 19)} UTC`;
}
