const MIN_ATTEMPTS = 3;
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*/;
const TRAILING_PIPE_TAIL = /\s*\|\s*(?:tail|head|grep)\b[^|]*$/;
const TRAILING_STDERR_MERGE = /\s*2>&1$/;

export function findFeedbackLoops(agents) {
  const loops = agents.flatMap((agent) => findAgentLoops(agent));
  return loops.toSorted((a, b) => b.runs.length - a.runs.length || b.totalMs - a.totalMs);
}

export function normalizeCommand(command) {
  let text = command.trim();
  while (LEADING_CD.test(text)) {
    text = text.replace(LEADING_CD, '');
  }
  while (TRAILING_PIPE_TAIL.test(text)) {
    text = text.replace(TRAILING_PIPE_TAIL, '');
  }
  return text.replace(TRAILING_STDERR_MERGE, '').replace(/\s+/g, ' ').trim();
}

function findAgentLoops(agent) {
  const loops = [];
  for (const [command, group] of groupShellRuns(agent.calls)) {
    if (group.runs.length >= MIN_ATTEMPTS) {
      loops.push(describeLoop(agent, command, group.runs));
    }
  }
  return loops;
}

function groupShellRuns(calls) {
  const groups = new Map();
  for (const [index, call] of calls.entries()) {
    const command = call.shellCommand ? normalizeCommand(call.shellCommand) : '';
    if (command === '') {
      continue;
    }
    const group = groups.get(command) ?? { runs: [], lastIndex: -2 };
    const hasCallBetween = group.lastIndex !== index - 1;
    if (hasCallBetween) {
      group.runs.push({ call, index });
    }
    group.lastIndex = index;
    groups.set(command, group);
  }
  return groups;
}

function describeLoop(agent, command, runs) {
  const calls = runs.map((run) => run.call);
  const cycleTimes = calls.slice(1).map((call, index) => call.startMs - calls[index].startMs);
  const runTimes = calls
    .filter((call) => call.endMs !== null)
    .map((call) => call.endMs - call.startMs);
  const lastCall = calls.at(-1);
  const endMs = lastCall.endMs ?? lastCall.startMs;
  return {
    agent,
    command,
    runs: calls,
    results: calls.map(getResult),
    cycleAverageMs: average(cycleTimes),
    cycleLongestMs: Math.max(...cycleTimes),
    runAverageMs: runTimes.length > 0 ? average(runTimes) : null,
    changedFiles: findChangedFiles(agent.calls, runs[0].index, runs.at(-1).index),
    totalMs: endMs - calls[0].startMs,
  };
}

function getResult(call) {
  if (call.failed) {
    return 'fail';
  }
  return call.endMs === null ? '?' : 'pass';
}

function findChangedFiles(calls, firstIndex, lastIndex) {
  const files = new Set();
  for (const call of calls.slice(firstIndex + 1, lastIndex)) {
    if (!call.failed) {
      call.editedFiles.forEach((file) => files.add(file));
    }
  }
  return [...files];
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
