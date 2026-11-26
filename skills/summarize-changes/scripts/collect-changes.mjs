#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const HELP = `Usage: node collect-changes.mjs [target]

Prints the data of a change as JSON. Does no analysis.

Targets:
- nothing: current branch against its merge-base with the default branch, plus uncommitted changes
- <number> or <GitHub PR URL>: the PR (needs gh)
- <A>..<B> or <A>...<B>: that git range, with no uncommitted changes
- <branch>: merge-base(default branch, branch)..branch`;

const PR_FIELDS =
  'number,title,body,url,baseRefName,baseRefOid,headRefName,headRefOid,closingIssuesReferences';
const GH_TIMEOUT_MS = 60_000;
const WORKTREE = 'WORKTREE';

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'flake.lock',
  'packages.lock.json',
]);
const VENDORED_FOLDERS = new Set(['vendor', 'vendored', 'third_party', 'node_modules']);
const GENERATED_FOLDERS = new Set(['dist', '__generated__']);
const SNAPSHOT_FOLDERS = new Set(['__snapshots__']);

function main() {
  const input = parseArguments(process.argv.slice(2));
  const root = findRepoRoot();
  const target = classifyTarget(input);
  const resolved = resolveTarget(target, root);
  const commits = listCommits(resolved.base, resolved.headCommit, root);
  const files = collectFiles(resolved, root);
  const result = {
    target: { kind: target.kind, input: input ?? '' },
    base: resolved.base,
    baseRef: resolved.baseRef,
    head: resolved.uncommitted ? WORKTREE : resolved.headCommit,
    uncommitted: resolved.uncommitted,
    pr: resolved.pr,
    commits,
    files,
    totals: computeTotals(files),
  };
  console.log(JSON.stringify(result, null, 2));
}

function parseArguments(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.length > 1) {
    throw new Error(`Expected at most one target, got ${args.length}: ${args.join(' ')}`);
  }
  if (args.length === 1 && args[0].trim() === '') {
    throw new Error('Target is empty');
  }
  return args[0];
}

function findRepoRoot() {
  const result = runGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (result.status !== 0) {
    throw new Error('Not inside a git work tree');
  }
  return result.stdout.trim();
}

function classifyTarget(input) {
  if (input === undefined) {
    return { kind: 'current' };
  }
  const numberMatch = /^#?(\d+)$/.exec(input);
  if (numberMatch) {
    return { kind: 'pr', ghArgument: numberMatch[1] };
  }
  if (/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/.test(input)) {
    return { kind: 'pr', ghArgument: input };
  }
  if (input.includes('...')) {
    const [from, to] = splitRange(input, '...');
    return { kind: 'range', from, to, symmetric: true };
  }
  if (input.includes('..')) {
    const [from, to] = splitRange(input, '..');
    return { kind: 'range', from, to, symmetric: false };
  }
  return { kind: 'branch', name: input };
}

function splitRange(input, separator) {
  const parts = input.split(separator);
  if (parts.length !== 2) {
    throw new Error(`Invalid range: ${input}`);
  }
  return parts.map((part) => (part === '' ? 'HEAD' : part));
}

function resolveTarget(target, root) {
  if (target.kind === 'pr') {
    return resolvePullRequest(target, root);
  }
  if (target.kind === 'range') {
    return resolveRange(target, root);
  }
  if (target.kind === 'branch') {
    return resolveBranch(target, root);
  }
  return resolveCurrent(root);
}

function resolvePullRequest(target, root) {
  const data = viewPullRequest(target.ghArgument, root);
  const checkout = readCheckout(root);
  const isCheckedOut = checkout.commit !== null && checkout.commit === data.headRefOid;
  const headCommit = isCheckedOut ? checkout.commit : ensurePullRequestHead(data, root);
  const baseRef = findPullRequestBase(data, root);
  return {
    base: mergeBase(baseRef.commit, headCommit, root),
    baseRef: baseRef.name,
    headCommit,
    uncommitted: isCheckedOut && hasUncommittedChanges(root),
    pr: toPullRequestSummary(data),
  };
}

function resolveRange(target, root) {
  const fromCommit = resolveCommit(target.from, root);
  const toCommit = resolveCommit(target.to, root);
  return {
    base: target.symmetric ? mergeBase(fromCommit, toCommit, root) : fromCommit,
    baseRef: target.from,
    headCommit: toCommit,
    uncommitted: false,
    pr: null,
  };
}

function resolveBranch(target, root) {
  const headCommit = resolveCommit(target.name, root);
  const defaultBranch = findDefaultBranch(root);
  const checkout = readCheckout(root);
  const fullName = git(['rev-parse', '--symbolic-full-name', target.name], root).trim();
  const isCurrent = checkout.branch !== null && fullName === `refs/heads/${checkout.branch}`;
  return {
    base: mergeBase(defaultBranch.commit, headCommit, root),
    baseRef: defaultBranch.name,
    headCommit,
    uncommitted: isCurrent && hasUncommittedChanges(root),
    pr: null,
  };
}

function resolveCurrent(root) {
  const checkout = readCheckout(root);
  if (checkout.commit === null) {
    throw new Error('HEAD has no commit yet; make a first commit');
  }
  const defaultBranch = findDefaultBranch(root);
  return {
    base: mergeBase(defaultBranch.commit, checkout.commit, root),
    baseRef: defaultBranch.name,
    headCommit: checkout.commit,
    uncommitted: hasUncommittedChanges(root),
    pr: checkout.branch === null ? null : findCurrentPullRequest(root),
  };
}

function viewPullRequest(ghArgument, root) {
  const result = runGh(['pr', 'view', ghArgument, '--json', PR_FIELDS], root);
  if (result.error?.code === 'ENOENT') {
    throw new Error('gh is not installed; give a branch name instead of a PR');
  }
  if (result.error) {
    throw new Error(`gh pr view ${ghArgument} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`gh pr view ${ghArgument} failed: ${firstLine(result.stderr)}`);
  }
  return parsePullRequestJson(result.stdout, ghArgument);
}

function findCurrentPullRequest(root) {
  const result = runGh(['pr', 'view', '--json', PR_FIELDS], root);
  if (result.error || result.status !== 0) {
    return null;
  }
  return toPullRequestSummary(parsePullRequestJson(result.stdout, 'for the current branch'));
}

function parsePullRequestJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gh pr view ${label} did not print valid JSON`);
  }
}

function toPullRequestSummary(data) {
  const issues = Array.isArray(data.closingIssuesReferences) ? data.closingIssuesReferences : [];
  return {
    number: data.number,
    title: data.title ?? '',
    body: data.body ?? '',
    url: data.url ?? '',
    linkedIssues: issues.map((issue) => ({ number: issue.number, url: issue.url ?? '' })),
  };
}

function ensurePullRequestHead(data, root) {
  if (!data.headRefOid) {
    throw new Error(`gh did not return a head commit for PR ${data.number}`);
  }
  if (commitExists(data.headRefOid, root)) {
    return data.headRefOid;
  }
  const fetch = runGit(
    ['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${data.number}/head`],
    root,
  );
  if (fetch.status !== 0) {
    throw new Error(`Cannot fetch PR ${data.number} from origin: ${firstLine(fetch.stderr)}`);
  }
  if (!commitExists(data.headRefOid, root)) {
    throw new Error(
      `PR ${data.number} head ${data.headRefOid} is not on origin; the PR may have changed, run again`,
    );
  }
  return data.headRefOid;
}

function findPullRequestBase(data, root) {
  const name = data.baseRefName;
  if (data.baseRefOid && commitExists(data.baseRefOid, root)) {
    return { name, commit: data.baseRefOid };
  }
  for (const candidate of [`origin/${name}`, name]) {
    const commit = tryResolveCommit(candidate, root);
    if (commit !== null) {
      return { name: candidate, commit };
    }
  }
  throw new Error(`Base branch ${name} of PR ${data.number} is not local; run git fetch origin`);
}

function findDefaultBranch(root) {
  const symbolic = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
  const candidates = symbolic.status === 0 ? [symbolic.stdout.trim()] : [];
  candidates.push('main', 'master');
  for (const candidate of candidates) {
    const commit = tryResolveCommit(candidate, root);
    if (commit !== null) {
      return { name: candidate, commit };
    }
  }
  throw new Error('Cannot find the default branch: no origin/HEAD, main, or master');
}

function readCheckout(root) {
  const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  return {
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    commit: tryResolveCommit('HEAD', root),
  };
}

function hasUncommittedChanges(root) {
  const status = git(
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    root,
  );
  return status !== '';
}

function mergeBase(first, second, root) {
  const result = runGit(['merge-base', first, second], root);
  if (result.status !== 0) {
    throw new Error(`No merge-base between ${first} and ${second}`);
  }
  return result.stdout.trim();
}

function listCommits(base, headCommit, root) {
  const output = git(
    [
      'log',
      '--reverse',
      '--no-color',
      '--no-show-signature',
      '--format=%H%x00%s%x00',
      `${base}..${headCommit}`,
    ],
    root,
  );
  const parts = output.split('\0');
  const commits = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    commits.push({ sha: parts[index].trim(), subject: parts[index + 1] });
  }
  return commits;
}

function collectFiles(resolved, root) {
  const files = readChanges(resolved, root);
  return files.toSorted((first, second) => first.path.localeCompare(second.path));
}

function readChanges(resolved, root) {
  if (!resolved.uncommitted) {
    return readDiff([resolved.base, resolved.headCommit], new Set(), root, process.env);
  }
  const untrackedPaths = listUntrackedPaths(root);
  if (untrackedPaths.length === 0) {
    return readDiff([resolved.base], new Set(), root, process.env);
  }
  return withTemporaryIndex(root, (env) => {
    addIntentToAdd(untrackedPaths, root, env);
    return readDiff([resolved.base], new Set(untrackedPaths), root, env);
  });
}

function listUntrackedPaths(root) {
  const output = git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  return output
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => (path.endsWith('/') ? path.slice(0, -1) : path));
}

function withTemporaryIndex(root, action) {
  const realIndex = resolve(root, git(['rev-parse', '--git-path', 'index'], root).trim());
  const folder = mkdtempSync(join(tmpdir(), 'collect-changes-'));
  try {
    const temporaryIndex = join(folder, 'index');
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, temporaryIndex);
    }
    return action({ ...process.env, GIT_INDEX_FILE: temporaryIndex });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function addIntentToAdd(paths, root, env) {
  const result = runGit(
    [
      '-c',
      'core.splitIndex=false',
      '-c',
      'advice.addEmbeddedRepo=false',
      '--literal-pathspecs',
      'add',
      '--intent-to-add',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ],
    root,
    { env, input: paths.join('\0') },
  );
  if (result.status !== 0) {
    throw new Error(`git add --intent-to-add failed: ${firstLine(result.stderr)}`);
  }
}

function readDiff(range, untrackedPaths, root, env) {
  const diffArguments = ['diff', '-M', '--no-color', '--no-ext-diff', '-z'];
  const statuses = parseNameStatus(
    git([...diffArguments, '--name-status', ...range, '--'], root, env),
  );
  const counts = parseNumstat(git([...diffArguments, '--numstat', ...range, '--'], root, env));
  return statuses.map((entry) => {
    const count = counts.get(entry.path) ?? { added: null, removed: null };
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      added: count.added,
      removed: count.removed,
      kind: classifyPath(entry.path),
      untracked: untrackedPaths.has(entry.path),
    };
  });
}

function parseNameStatus(output) {
  const parts = output.split('\0');
  const entries = [];
  let index = 0;
  while (index < parts.length && parts[index] !== '') {
    const code = parts[index][0];
    if (code === 'R' || code === 'C') {
      entries.push({
        status: normalizeStatus(code),
        oldPath: parts[index + 1],
        path: parts[index + 2],
      });
      index += 3;
    } else {
      entries.push({ status: normalizeStatus(code), oldPath: null, path: parts[index + 1] });
      index += 2;
    }
  }
  return entries;
}

function normalizeStatus(code) {
  if (code === 'A' || code === 'C') {
    return 'A';
  }
  if (code === 'D' || code === 'R') {
    return code;
  }
  return 'M';
}

function parseNumstat(output) {
  const parts = output.split('\0');
  const counts = new Map();
  let index = 0;
  while (index < parts.length && parts[index] !== '') {
    const [added, removed, path] = parts[index].split('\t');
    const count = { added: toCount(added), removed: toCount(removed) };
    if (path === '') {
      counts.set(parts[index + 2], count);
      index += 3;
    } else {
      counts.set(path, count);
      index += 1;
    }
  }
  return counts;
}

function toCount(value) {
  return value === '-' ? null : Number(value);
}

function classifyPath(path) {
  const segments = path.split('/');
  const folders = segments.slice(0, -1);
  const name = basename(path);
  if (folders.some((folder) => VENDORED_FOLDERS.has(folder))) {
    return 'vendored';
  }
  if (LOCKFILES.has(name)) {
    return 'lockfile';
  }
  if (name.endsWith('.snap') || folders.some((folder) => SNAPSHOT_FOLDERS.has(folder))) {
    return 'snapshot';
  }
  if (isGeneratedName(name) || folders.some((folder) => GENERATED_FOLDERS.has(folder))) {
    return 'generated';
  }
  return 'code';
}

function isGeneratedName(name) {
  return (
    /\.generated\./.test(name) ||
    name.endsWith('.min.js') ||
    name.endsWith('.min.css') ||
    name.endsWith('.map')
  );
}

function computeTotals(files) {
  const totals = { files: 0, added: 0, removed: 0, excludedFiles: 0 };
  for (const file of files) {
    if (file.kind !== 'code') {
      totals.excludedFiles += 1;
      continue;
    }
    totals.files += 1;
    totals.added += file.added ?? 0;
    totals.removed += file.removed ?? 0;
  }
  return totals;
}

function resolveCommit(ref, root) {
  const commit = tryResolveCommit(ref, root);
  if (commit === null) {
    throw new Error(`Unknown ref: ${ref}`);
  }
  return commit;
}

function tryResolveCommit(ref, root) {
  if (ref.startsWith('-')) {
    return null;
  }
  const result = runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    root,
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function commitExists(sha, root) {
  return runGit(['cat-file', '-e', `${sha}^{commit}`], root).status === 0;
}

function git(args, root, env = process.env) {
  const result = runGit(args, root, { env });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${firstLine(result.stderr)}`);
  }
  return result.stdout;
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`Cannot run git: ${result.error.message}`);
  }
  return result;
}

function runGh(args, cwd) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
}

function firstLine(text) {
  const line = (text ?? '').split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? 'no error message' : line.trim();
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
