import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./prepare-worktree.mjs', import.meta.url));

test('creates a new branch from origin default branch', () => {
  const { repo, root } = setupRepo();
  const output = run(repo, ['feat/new-thing']);
  assert.match(output, /Mode: new \(created new branch from origin\/main\)/);
  assert.match(output, new RegExp(`Worktree: ${join(root, 'app-worktrees', 'feat-new-thing')}`));
});

test('tracks a branch that exists only on origin', () => {
  const { repo, origin } = setupRepo();
  git(origin, ['branch', 'remote-only', 'main']);
  const output = run(repo, ['origin/remote-only']);
  assert.match(output, /Mode: remote/);
  const worktree = output.match(/Worktree: (.*)/)[1];
  assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/remote-only');
});

test('checks out an existing local branch and reuses it on the second run', () => {
  const { repo } = setupRepo();
  git(repo, ['branch', 'local-only']);
  assert.match(run(repo, ['local-only']), /Mode: local/);
  assert.match(run(repo, ['local-only']), /Mode: reused/);
});

test('prunes a stale worktree whose folder was deleted and creates it again', () => {
  const { repo } = setupRepo();
  git(repo, ['branch', 'stale']);
  const worktree = run(repo, ['stale']).match(/Worktree: (.*)/)[1];
  rmSync(worktree, { recursive: true, force: true });
  const output = run(repo, ['stale']);
  assert.match(output, /Note: removed a stale worktree record for stale/);
  assert.match(output, /Mode: local/);
  assert.ok(existsSync(worktree));
});

test('reports main-checkout when the branch is checked out in the main checkout', () => {
  const { repo } = setupRepo();
  git(repo, ['checkout', '--quiet', '-b', 'feat/x']);
  const output = run(repo, ['feat/x']);
  assert.match(output, /Mode: main-checkout/);
  assert.match(output, new RegExp(`Worktree: ${repo}\\n`));
  assert.match(output, /Note: feat\/x is checked out in the main checkout/);
});

function setupRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prepare-worktree-')));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'app');
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(root, ['clone', '--quiet', origin, repo]);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  git(repo, ['push', '--quiet', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  return { root, origin, repo };
}

function run(cwd, args) {
  return execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
