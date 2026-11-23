import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

const CHUNK_SIZE = 64 * 1024;
const NEWLINE = 0x0a;

export function readTranscript(file) {
  let entries;
  try {
    entries = readJsonl(file);
  } catch (error) {
    throw new Error(`Cannot read transcript file ${file}: ${error.message}`, { cause: error });
  }
  if (entries.length === 0) {
    throw new Error(`Bad transcript file ${file}: no valid JSON lines`);
  }
  return entries;
}

export function readJsonl(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const entries = [];
  for (const line of lines) {
    const entry = parseJsonObject(line);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export function readFirstJsonLine(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const chunks = [];
    const buffer = Buffer.alloc(CHUNK_SIZE);
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newlineIndex = chunk.indexOf(NEWLINE);
      if (newlineIndex !== -1) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(chunk);
    }
    return parseJsonObject(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function readJsonFile(file) {
  if (!existsSync(file)) {
    return {};
  }
  return parseJsonObject(readFileSync(file, 'utf8')) ?? {};
}

export function listJsonlFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files;
}

export function parseTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function oneLine(text, maxLength = 100) {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.slice(0, maxLength - 1)}…`;
}

export function summarizeError(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return '(no error text)';
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (lines.length === 1) {
    return oneLine(first, 120);
  }
  return `${oneLine(first, 50)} … ${oneLine(last, 70)}`;
}

export function createAgent(label, isMain) {
  return {
    label,
    isMain,
    startMs: null,
    endMs: null,
    tokens: 0,
    cacheReadTokens: 0,
    calls: [],
    steps: [],
  };
}

export function noteTime(agent, timeMs) {
  if (agent.startMs === null || timeMs < agent.startMs) {
    agent.startMs = timeMs;
  }
  if (agent.endMs === null || timeMs > agent.endMs) {
    agent.endMs = timeMs;
  }
}

function parseJsonObject(text) {
  if (text.trim() === '') {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
