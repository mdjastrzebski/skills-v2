import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./exclude-spec.mjs', import.meta.url));
const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adds the entry once', () => {
  const { root, repo } = setupRepo();
  const first = run(repo, root);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^added:/);

  const second = run(repo, root);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /^unchanged:/);

  const lines = readExclude(repo).split('\n');
  assert.equal(lines.filter((line) => line === '/SPEC.md').length, 1);
});

test('adds a newline before the entry when the file does not end with one', () => {
  const { root, repo } = setupRepo();
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.log');
  run(repo, root);
  assert.equal(readExclude(repo), '*.log\n/SPEC.md\n');
});

test('creates the exclude file when it is missing', () => {
  const { root, repo } = setupRepo();
  rmSync(join(repo, '.git', 'info'), { recursive: true, force: true });
  const result = run(repo, root);
  assert.equal(result.status, 0);
  assert.equal(readExclude(repo), '/SPEC.md\n');
});

test('writes to the main repo exclude file from a worktree', () => {
  const { root, repo } = setupRepo();
  git(repo, root, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  const worktree = join(root, 'worktree');
  git(repo, root, ['worktree', 'add', '-q', worktree]);
  const result = run(worktree, root);
  assert.equal(result.status, 0);
  assert.match(readExclude(repo), /^\/SPEC\.md$/m);
});

test('skips outside a git repository', () => {
  const root = makeRoot();
  const folder = join(root, 'plain');
  mkdirSync(folder);
  const result = run(folder, root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^skipped:/);
});

function setupRepo() {
  const root = makeRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, root, ['init', '-q', '-b', 'main']);
  return { root, repo };
}

function makeRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exclude-spec-')));
  tempRoots.push(root);
  mkdirSync(join(root, 'home'));
  return root;
}

function readExclude(repo) {
  return readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
}

function run(cwd, root) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv(root),
  });
}

function git(cwd, root, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: isolatedEnv(root) }).trim();
}

function isolatedEnv(root) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...env,
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
  };
}
