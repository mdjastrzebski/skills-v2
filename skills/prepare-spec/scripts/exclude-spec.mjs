#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ENTRY = '/SPEC.md';

function main() {
  const commonDir = findGitCommonDir();
  if (!commonDir) {
    console.log('skipped: not inside a git repository');
    return;
  }
  const excludePath = join(commonDir, 'info', 'exclude');
  if (hasEntry(excludePath)) {
    console.log(`unchanged: ${ENTRY} is already in ${excludePath}`);
    return;
  }
  appendEntry(excludePath);
  console.log(`added: ${ENTRY} to ${excludePath}`);
}

function findGitCommonDir() {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function hasEntry(excludePath) {
  if (!existsSync(excludePath)) {
    return false;
  }
  const lines = readFileSync(excludePath, 'utf8').split(/\r?\n/);
  return lines.some((line) => line.trim() === ENTRY);
}

function appendEntry(excludePath) {
  mkdirSync(dirname(excludePath), { recursive: true });
  const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  appendFileSync(excludePath, `${separator}${ENTRY}\n`);
}

main();
