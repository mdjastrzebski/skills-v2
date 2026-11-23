#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const HELP = `Usage: node prepare-worktree.mjs <branch> [--base <ref>]

Creates a worktree at ../<repo>-worktrees/<branch-slug> next to the main checkout.

- Local branch exists: checks it out.
- Branch exists only on origin: creates a local branch that tracks it.
- Branch does not exist: creates it from --base (default: latest origin/<default-branch>).
- Branch already checked out in a worktree: reuses that worktree.`;

function main() {
  const { branchInput, base } = parseArguments(process.argv.slice(2));
  const branch = normalizeBranchName(branchInput);
  const mainRoot = findMainWorktreeRoot();
  const worktreePath = join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`, slugify(branch));

  git(['fetch', '--quiet', '--prune', 'origin'], mainRoot);

  const existingPath = findWorktreeForBranch(branch, mainRoot);
  if (existingPath && !existsSync(existingPath)) {
    git(['worktree', 'prune'], mainRoot);
    console.log(`Note: removed a stale worktree record for ${branch}. Its folder did not exist: ${existingPath}`);
  } else if (existingPath === mainRoot) {
    report('main-checkout', branch, mainRoot, 'branch is checked out in the main checkout');
    console.log(`Note: ${branch} is checked out in the main checkout, so it cannot have a second worktree. To work in parallel, switch the main checkout to a different branch and run again, or use a different branch name.`);
    return;
  } else if (existingPath) {
    report('reused', branch, existingPath, 'branch is already checked out in this worktree');
    return;
  }
  if (existsSync(worktreePath)) {
    throw new Error(`Path already exists and is not a worktree for ${branch}: ${worktreePath}`);
  }
  mkdirSync(dirname(worktreePath), { recursive: true });

  if (refExists(`refs/heads/${branch}`, mainRoot)) {
    git(['worktree', 'add', '--quiet', worktreePath, branch], mainRoot);
    report('local', branch, worktreePath, 'checked out existing local branch');
    return;
  }
  if (refExists(`refs/remotes/origin/${branch}`, mainRoot)) {
    git(['worktree', 'add', '--quiet', '--track', '-b', branch, worktreePath, `origin/${branch}`], mainRoot);
    report('remote', branch, worktreePath, `created local branch tracking origin/${branch}`);
    return;
  }
  const baseRef = base ?? findDefaultRemoteBranch(mainRoot);
  git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, worktreePath, baseRef], mainRoot);
  report('new', branch, worktreePath, `created new branch from ${baseRef}`);
  console.log(`Note: no local or origin branch named ${branch} existed. If you expected an existing branch, check the name.`);
}

function parseArguments(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }
  let branchInput;
  let base;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--base') {
      base = args[++index];
      if (!base) throw new Error('--base needs a value');
    } else if (!branchInput) {
      branchInput = args[index];
    } else {
      throw new Error(`Unexpected argument: ${args[index]}`);
    }
  }
  if (!branchInput) throw new Error('Branch name is required');
  return { branchInput, base };
}

function normalizeBranchName(input) {
  const branch = input.replace(/^refs\/heads\//, '').replace(/^(refs\/remotes\/)?origin\//, '');
  return git(['check-ref-format', '--branch', branch], process.cwd());
}

function findMainWorktreeRoot() {
  const firstLine = git(['worktree', 'list', '--porcelain'], process.cwd()).split('\n')[0];
  return firstLine.replace(/^worktree /, '');
}

function findWorktreeForBranch(branch, cwd) {
  const blocks = git(['worktree', 'list', '--porcelain'], cwd).split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return lines[0].replace(/^worktree /, '');
    }
  }
  return null;
}

function findDefaultRemoteBranch(cwd) {
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  } catch {
    for (const candidate of ['main', 'master']) {
      if (refExists(`refs/remotes/origin/${candidate}`, cwd)) return `origin/${candidate}`;
    }
    throw new Error('Cannot find the default branch on origin. Pass --base <ref>.');
  }
}

function slugify(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function refExists(ref, cwd) {
  try {
    git(['show-ref', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function report(mode, branch, path, message) {
  console.log(`Mode: ${mode} (${message})`);
  console.log(`Branch: ${branch}`);
  console.log(`Worktree: ${path}`);
}

try {
  main();
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
