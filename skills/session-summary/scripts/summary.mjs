#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argument = process.argv[2];
if (argument === '--help' || argument === '-h') {
  console.log('Usage: node summary.mjs [session-id | path/to/session.jsonl]\n\nSummarize a Claude Code or Codex session. Without an argument, use the latest session in the current directory.');
} else {
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const codexFiles = ['sessions', 'archived_sessions'].flatMap((dir) => listFiles(join(codexHome, dir)));
    const file = selectSession(argument, codexFiles);
    const script = file && isCodex(file) ? 'codex.mjs' : 'claude.mjs';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...(file ? [file] : argument ? [argument] : [])], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function selectSession(value, codexFiles) {
  if (value?.endsWith('.jsonl')) return value;
  if (value) return codexFiles.find((file) => basename(file).endsWith(`${value}.jsonl`));
  const candidates = codexFiles.filter((file) => {
    const meta = readMeta(file);
    return meta?.cwd === process.cwd() && !meta.source?.subagent && meta.thread_source !== 'subagent';
  });
  const claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  if (existsSync(claudeDir)) {
    candidates.push(...readdirSync(claudeDir).filter((name) => name.endsWith('.jsonl')).map((name) => join(claudeDir, name)));
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates.length) throw new Error(`No sessions for ${process.cwd()}`);
  return candidates[0];
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : [];
  });
}

function readMeta(file) {
  try {
    const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0];
    const entry = JSON.parse(firstLine);
    return entry.type === 'session_meta' ? entry.payload : null;
  } catch {
    return null;
  }
}

function isCodex(file) {
  return Boolean(readMeta(file));
}
