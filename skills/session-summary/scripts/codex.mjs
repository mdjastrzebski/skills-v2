#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { calculateCost } from './codex-pricing.mjs';

const rootFile = process.argv[2];
const root = readSession(rootFile);
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const files = ['sessions', 'archived_sessions'].flatMap((dir) => listFiles(join(codexHome, dir)));
const sessions = files.filter((file) => file !== rootFile).map(readSession).filter(Boolean);
const descendants = [];
function addChildren(parent) {
  for (const child of sessions.filter((session) => session.parentId === parent.id)) {
    if (descendants.includes(child)) continue;
    descendants.push(child);
    parent.children.push(child);
    addChildren(child);
  }
}
addChildren(root);
console.log(`## Session \`${root.id}\`\n`);
console.log(`- Main agent: ${root.models.join(', ') || '?'}, ${formatCost(root)}`);
const subagentTotal = descendants.length ? sumCosts(descendants) : { cost: 0, hasUsage: true, hasUnpricedUsage: false };
console.log(`- Subagents: ${descendants.length}, ${formatCost(subagentTotal)}`);
console.log(`- Total: ${formatCost(sumCosts([root, ...descendants]))} (API-rate estimate)\n`);
if (descendants.length) {
  console.log('## Subagents\n');
  root.children.forEach((child, index) => printAgent(child, `${index + 1}`, 0));
}

function readSession(file) {
  const entries = readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const meta = entries.find((entry) => entry.type === 'session_meta')?.payload;
  if (!meta) return null;
  const spawn = meta.source?.subagent?.thread_spawn;
  const contexts = entries.filter((entry) => entry.type === 'turn_context');
  const models = [...new Set(contexts.map((entry) => entry.payload.model).filter(Boolean))];
  const times = entries.map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite);
  const cost = getSessionCost(entries, meta.id ?? meta.session_id);
  return {
    id: meta.id ?? meta.session_id,
    parentId: spawn?.parent_thread_id,
    task: spawn?.agent_path?.split('/').pop() ?? spawn?.agent_nickname ?? 'Unknown task',
    type: spawn?.agent_role ?? 'subagent',
    effort: contexts.find((entry) => entry.payload.reasoning_effort)?.payload.reasoning_effort,
    models,
    ...cost,
    durationMs: times.length ? Math.max(...times) - Math.min(...times) : 0,
    children: [],
  };
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : [];
  });
}

function printAgent(agent, label, depth) {
  const indent = '  '.repeat(depth);
  const duration = agent.durationMs >= 60_000 ? `${Math.round(agent.durationMs / 60_000)}m` : `${Math.round(agent.durationMs / 1000)}s`;
  console.log(`${indent}- **${label}. ${agent.task}**`);
  console.log(`${indent}  - Agent: ${agent.type} (\`${agent.id}\`)`);
  console.log(`${indent}  - Model: ${agent.models.join(', ') || '?'}${agent.effort ? `, effort ${agent.effort}` : ''}`);
  console.log(`${indent}  - Cost: ${formatCost(agent)}${agent.children.length ? ` (${formatCost(sumCosts(getDescendants(agent)))} with nested)` : ''}`);
  console.log(`${indent}  - Duration: ${duration}`);
  agent.children.forEach((child, index) => printAgent(child, `${label}.${index + 1}`, depth + 1));
}

function getSessionCost(entries, sessionId) {
  const records = entries.filter((entry) => entry.type === 'token_usage_record' && (!entry.payload.thread_id || entry.payload.thread_id === sessionId));
  const modelsByTurn = new Map();
  let currentModel;
  let previousTotal = null;
  let total = 0;
  let priced = 0;
  let missing = false;
  for (const entry of entries) {
    if (entry.type === 'turn_context') {
      currentModel = entry.payload.model;
      modelsByTurn.set(entry.payload.turn_id, currentModel);
    }
    let usage;
    let model = currentModel;
    if (records.length && entry.type === 'token_usage_record' && (!entry.payload.thread_id || entry.payload.thread_id === sessionId)) {
      usage = entry.payload.usage;
      model = modelsByTurn.get(entry.payload.turn_id) ?? currentModel;
    } else if (!records.length && entry.type === 'event_msg' && entry.payload.type === 'token_count' && entry.payload.info?.total_token_usage) {
      const cumulative = entry.payload.info.total_token_usage;
      usage = usageDifference(cumulative, previousTotal);
      previousTotal = cumulative;
    }
    if (!usage) continue;
    const cost = calculateCost(model, usage);
    if (cost === null) missing = true;
    else {
      total += cost;
      priced++;
    }
  }
  return { cost: total, hasUnpricedUsage: missing, hasUsage: priced > 0 };
}

function usageDifference(current, previous) {
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
  const result = {};
  for (const field of fields) {
    const value = current[field] ?? 0;
    const before = previous?.[field] ?? 0;
    if (value < before) return null;
    result[field] = value - before;
  }
  return result;
}

function sumCosts(agents) {
  return {
    cost: agents.reduce((sum, agent) => sum + agent.cost, 0),
    hasUsage: agents.some((agent) => agent.hasUsage),
    hasUnpricedUsage: agents.some((agent) => agent.hasUnpricedUsage || !agent.hasUsage),
  };
}

function formatCost(agent) {
  if (!agent.hasUsage) return agent.hasUnpricedUsage ? 'unavailable (unpriced usage)' : 'unavailable (no usage)';
  return `$${agent.cost.toFixed(2)}${agent.hasUnpricedUsage ? ' + unpriced or missing usage' : ''}`;
}

function getDescendants(agent) {
  return [agent, ...agent.children.flatMap(getDescendants)];
}
