import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./collect-changes.mjs', import.meta.url));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default target includes staged, unstaged, and untracked changes', () => {
  const { root, repo } = setupRepo();
  const base = git(repo, root, ['rev-parse', 'HEAD']);
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'committed.txt', 'one\n', 'add committed file');
  writeFileSync(join(repo, 'staged.txt'), 'a\nb\n');
  git(repo, root, ['add', 'staged.txt']);
  writeFileSync(join(repo, 'README.md'), 'hello\nchanged\n');
  writeFileSync(join(repo, 'untracked.txt'), 'x\ny\nz');

  const result = runJson(repo, root);

  assert.equal(result.target.kind, 'current');
  assert.equal(result.base, base);
  assert.equal(result.baseRef, 'main');
  assert.equal(result.head, 'WORKTREE');
  assert.equal(result.uncommitted, true);
  assert.equal(result.pr, null);
  assert.equal(result.prLookup.status, 'not_found');
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ['add committed file'],
  );
  assert.deepEqual(byPath(result.files), {
    'README.md': { status: 'M', added: 1, removed: 0, untracked: false },
    'committed.txt': { status: 'A', added: 1, removed: 0, untracked: false },
    'staged.txt': { status: 'A', added: 2, removed: 0, untracked: false },
    'untracked.txt': { status: 'A', added: 3, removed: 0, untracked: true },
  });
  assert.deepEqual(result.totals, { files: 4, added: 7, removed: 0, excludedFiles: 0 });
});

test('default target on the default branch with no commits ahead shows only uncommitted changes', () => {
  const { root, repo } = setupRepo();
  writeFileSync(join(repo, 'README.md'), 'hello\nmore\n');

  const result = runJson(repo, root);

  assert.deepEqual(result.commits, []);
  assert.equal(result.uncommitted, true);
  assert.deepEqual(Object.keys(byPath(result.files)), ['README.md']);
});

test('default target includes PR data when gh finds a PR', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'a.txt', 'a\n', 'add a');
  installFakeGh(root, pullRequestJson({ number: 5, headRefName: 'feature' }));

  const result = runJson(repo, root);

  assert.equal(result.pr.number, 5);
  assert.deepEqual(result.prLookup, { status: 'found' });
  assert.equal(result.pr.title, 'Add a');
  assert.deepEqual(result.pr.linkedIssues, [{ number: 9, url: 'https://example.com/issues/9' }]);
});

test('default target continues without PR data when gh is missing', () => {
  const { root, repo } = setupRepo();
  const result = runJson(repo, root, { withoutGh: true });
  assert.equal(result.pr, null);
  assert.equal(result.prLookup.status, 'error');
  assert.match(result.prLookup.message, /ENOENT/);
});

test('default target reports a gh lookup failure', () => {
  const { root, repo } = setupRepo();
  writeFakeGh(root, 'echo "authentication failed" >&2\nexit 1\n');
  const result = runJson(repo, root);
  assert.deepEqual(result.prLookup, { status: 'error', message: 'authentication failed' });
});

test('branch target diffs from the merge-base and ignores uncommitted changes of another branch', () => {
  const { root, repo } = setupRepo();
  const base = git(repo, root, ['rev-parse', 'HEAD']);
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'feature.txt', 'f\n', 'add feature');
  git(repo, root, ['switch', '-q', 'main']);
  commitFile(repo, root, 'later.txt', 'l\n', 'later on main');
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');

  const result = runJson(repo, root, { args: ['feature'] });

  assert.equal(result.target.kind, 'branch');
  assert.equal(result.target.input, 'feature');
  assert.equal(result.base, base);
  assert.equal(result.head, git(repo, root, ['rev-parse', 'feature']));
  assert.equal(result.uncommitted, false);
  assert.deepEqual(Object.keys(byPath(result.files)), ['feature.txt']);
});

test('branch target includes uncommitted changes when it is the current branch', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'feature.txt', 'f\n', 'add feature');
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');

  const result = runJson(repo, root, { args: ['feature'] });

  assert.equal(result.head, 'WORKTREE');
  assert.deepEqual(Object.keys(byPath(result.files)), ['dirty.txt', 'feature.txt']);
});

test('range target diffs that range exactly with no uncommitted changes', () => {
  const { root, repo } = setupRepo();
  const first = commitFile(repo, root, 'one.txt', '1\n', 'one');
  commitFile(repo, root, 'two.txt', '2\n', 'two');
  const third = commitFile(repo, root, 'three.txt', '3\n', 'three');
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');

  const result = runJson(repo, root, { args: [`${first}..${third}`] });

  assert.equal(result.target.kind, 'range');
  assert.equal(result.base, first);
  assert.equal(result.head, third);
  assert.equal(result.uncommitted, false);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ['two', 'three'],
  );
  assert.deepEqual(Object.keys(byPath(result.files)), ['three.txt', 'two.txt']);
});

test('detects renames', () => {
  const { root, repo } = setupRepo();
  commitFile(repo, root, 'old-name.txt', 'line 1\nline 2\nline 3\nline 4\n', 'add file');
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  git(repo, root, ['mv', 'old-name.txt', 'new-name.txt']);
  commitStaged(repo, root, 'rename');

  const result = runJson(repo, root, { args: ['feature'] });

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], {
    path: 'new-name.txt',
    oldPath: 'old-name.txt',
    status: 'R',
    added: 0,
    removed: 0,
    kind: 'code',
    untracked: false,
  });
});

test('detects an unstaged rename of a tracked file to an untracked file', () => {
  const { root, repo } = setupRepo();
  commitFile(repo, root, 'old-name.txt', 'line 1\nline 2\nline 3\nline 4\n', 'add file');
  renameSync(join(repo, 'old-name.txt'), join(repo, 'new-name.txt'));

  const result = runJson(repo, root);

  assert.deepEqual(result.files, [
    {
      path: 'new-name.txt',
      oldPath: 'old-name.txt',
      status: 'R',
      added: 0,
      removed: 0,
      kind: 'code',
      untracked: true,
    },
  ]);
  assert.deepEqual(result.totals, { files: 1, added: 0, removed: 0, excludedFiles: 0 });
  assert.equal(git(repo, root, ['status', '--porcelain']), 'D old-name.txt\n?? new-name.txt');
});

test('--diff on the default target shows staged, unstaged, and untracked content', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'committed.txt', 'committed line\n', 'add committed file');
  writeFileSync(join(repo, 'staged.txt'), 'staged line\n');
  git(repo, root, ['add', 'staged.txt']);
  writeFileSync(join(repo, 'README.md'), 'hello\nunstaged line\n');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked line\n');

  const result = run(repo, root, { args: ['--diff'] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^diff --git a\/README\.md b\/README\.md$/m);
  assert.match(result.stdout, /^\+committed line$/m);
  assert.match(result.stdout, /^\+staged line$/m);
  assert.match(result.stdout, /^\+unstaged line$/m);
  assert.match(result.stdout, /^diff --git a\/untracked\.txt b\/untracked\.txt$/m);
  assert.match(result.stdout, /^\+untracked line$/m);
});

test('--diff shows an unstaged mv as a rename', () => {
  const { root, repo } = setupRepo();
  commitFile(repo, root, 'old-name.txt', 'line 1\nline 2\nline 3\nline 4\n', 'add file');
  renameSync(join(repo, 'old-name.txt'), join(repo, 'new-name.txt'));

  const result = run(repo, root, { args: ['--diff'] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^rename from old-name\.txt$/m);
  assert.match(result.stdout, /^rename to new-name\.txt$/m);
});

test('--diff leaves the real index and work tree unchanged', () => {
  const { root, repo } = setupRepo();
  writeFileSync(join(repo, 'staged.txt'), 'staged\n');
  git(repo, root, ['add', 'staged.txt']);
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
  const statusBefore = git(repo, root, ['status', '--porcelain']);
  const indexBefore = readFileSync(join(repo, '.git', 'index'));

  const result = run(repo, root, { args: ['--diff'] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\+untracked$/m);
  assert.equal(git(repo, root, ['status', '--porcelain']), statusBefore);
  assert.equal(statusBefore, 'A  staged.txt\n?? untracked.txt');
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
});

test('--diff with a range target matches git diff -M A B', () => {
  const { root, repo } = setupRepo();
  const first = commitFile(repo, root, 'one.txt', '1\n', 'one');
  commitFile(repo, root, 'two.txt', '2\n', 'two');
  const third = commitFile(repo, root, 'three.txt', '3\n', 'three');
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  const expected = execFileSync('git', ['diff', '-M', first, third], {
    cwd: repo,
    encoding: 'utf8',
    env: isolatedEnv(root, false),
  });

  const result = run(repo, root, { args: ['--diff', `${first}..${third}`] });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(expected, '');
  assert.equal(result.stdout, expected);
});

test('--diff prints nothing and exits 0 for an empty diff', () => {
  const { root, repo } = setupRepo();
  const result = run(repo, root, { args: ['--diff'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('--diff still fails on an unknown ref', () => {
  const { root, repo } = setupRepo();
  const result = run(repo, root, { args: ['--diff', 'no-such-branch'] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Unknown ref: no-such-branch\n$/);
});

test('--diff leaves out the files that are not code', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  const files = {
    'src/index.js': 'code',
    'src/min.js.txt': 'code',
    'src/distance.js': 'code',
    'pnpm-lock.yaml': 'lockfile',
    'packages/app/package-lock.json': 'lockfile',
    'src/__snapshots__/view.test.js.snap': 'snapshot',
    'src/other.snap': 'snapshot',
    'dist/bundle.js': 'generated',
    'packages/app/__generated__/types.ts': 'generated',
    'src/schema.generated.ts': 'generated',
    'src/app.min.js': 'generated',
    'src/app.min.css': 'generated',
    'src/app.js.map': 'generated',
    'vendor/lib.js': 'vendored',
    'packages/app/third_party/lib.js': 'vendored',
  };
  for (const path of Object.keys(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), `${path}\n`);
  }
  git(repo, root, ['add', '.']);
  commitStaged(repo, root, 'mixed');
  writeFileSync(join(repo, 'untracked.js'), 'untracked\n');
  writeFileSync(join(repo, 'yarn.lock'), 'untracked lock\n');

  const json = runJson(repo, root);
  const result = run(repo, root, { args: ['--diff'] });

  assert.equal(result.status, 0, result.stderr);
  const kinds = Object.fromEntries(json.files.map((file) => [file.path, file.kind]));
  assert.deepEqual(kinds, { ...files, 'untracked.js': 'code', 'yarn.lock': 'lockfile' });
  const codePaths = json.files.filter((file) => file.kind === 'code').map((file) => file.path);
  assert.deepEqual(diffPaths(result.stdout).toSorted(), codePaths.toSorted());
});

test('--diff -- <path> shows only the given files, also files that are not code', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'pnpm-lock.yaml', 'lock\n', 'add lock');
  commitFile(repo, root, 'one.txt', 'one\n', 'add one');
  writeFileSync(join(repo, 'two.txt'), 'two\n');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');

  const result = run(repo, root, {
    args: ['--diff', '--', 'pnpm-lock.yaml', 'untracked.txt'],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(diffPaths(result.stdout), ['pnpm-lock.yaml', 'untracked.txt']);
});

test('--diff -- <path> matches paths literally', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'a*.txt', 'star\n', 'add star');
  commitFile(repo, root, 'ab.txt', 'ab\n', 'add ab');
  writeFileSync(join(repo, '--help'), 'dash\n');
  git(repo, root, ['add', '--', '--help']);
  commitStaged(repo, root, 'add dash');

  const result = run(repo, root, { args: ['--diff', 'feature', '--', 'a*.txt', '--help'] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(diffPaths(result.stdout).toSorted(), ['--help', 'a*.txt']);
});

test('paths after -- need --diff and at least one path', () => {
  const { root, repo } = setupRepo();
  const cases = [
    { args: ['--', 'README.md'], message: /^Paths after -- need --diff\n$/ },
    { args: ['--diff', '--'], message: /^Expected at least one path after --\n$/ },
  ];
  for (const { args, message } of cases) {
    const result = run(repo, root, { args });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  }
});

test('unknown option fails with a non-zero exit', () => {
  const { root, repo } = setupRepo();
  for (const args of [['--bogus'], ['--diff', '--bogus'], ['-x']]) {
    const result = run(repo, root, { args });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Unknown option: /);
  }
});

test('lists a file removed from the index but kept in the work tree at most once', () => {
  const { root, repo } = setupRepo();
  commitFile(repo, root, 'keep.txt', 'keep\n', 'add keep');
  commitFile(repo, root, 'edit.txt', 'one\n', 'add edit');
  git(repo, root, ['rm', '-q', '--cached', 'keep.txt', 'edit.txt']);
  writeFileSync(join(repo, 'edit.txt'), 'one\ntwo\n');

  const result = runJson(repo, root);

  assert.equal(result.uncommitted, true);
  assert.deepEqual(byPath(result.files), {
    'edit.txt': { status: 'M', added: 1, removed: 0, untracked: true },
  });
  assert.deepEqual(result.totals, { files: 1, added: 1, removed: 0, excludedFiles: 0 });
});

test('classifies lockfiles, snapshots, and generated files and excludes them from totals', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  mkdirSync(join(repo, 'src', '__snapshots__'), { recursive: true });
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'src', '__snapshots__', 'view.test.js.snap'), 's\n');
  writeFileSync(join(repo, 'src', 'other.snap'), 's\n');
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'b\n');
  writeFileSync(join(repo, 'src', 'index.js'), 'code\nmore\n');
  git(repo, root, ['add', '.']);
  commitStaged(repo, root, 'mixed');

  const result = runJson(repo, root, { args: ['feature'] });

  const kinds = Object.fromEntries(result.files.map((file) => [file.path, file.kind]));
  assert.deepEqual(kinds, {
    'dist/bundle.js': 'generated',
    'pnpm-lock.yaml': 'lockfile',
    'src/__snapshots__/view.test.js.snap': 'snapshot',
    'src/index.js': 'code',
    'src/other.snap': 'snapshot',
  });
  assert.deepEqual(result.totals, { files: 1, added: 2, removed: 0, excludedFiles: 4 });
});

test('binary files have null line counts', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 0, 3]));
  writeFileSync(join(repo, 'untracked.bin'), Buffer.from([0, 9, 0]));
  git(repo, root, ['add', 'image.bin']);
  commitStaged(repo, root, 'binary');

  const result = runJson(repo, root);

  const files = byPath(result.files);
  assert.equal(files['image.bin'].added, null);
  assert.equal(files['image.bin'].removed, null);
  assert.equal(files['untracked.bin'].added, null);
  assert.deepEqual(result.totals, { files: 2, added: 0, removed: 0, excludedFiles: 0 });
});

test('uses origin/HEAD as the default branch when it exists', () => {
  const { root, repo } = setupRepo({ branch: 'trunk' });
  git(repo, root, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
  git(repo, root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  git(repo, root, ['switch', '-q', '-c', 'feature']);

  const result = runJson(repo, root);

  assert.equal(result.baseRef, 'origin/trunk');
});

test('falls back to main when origin/HEAD is missing', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  commitFile(repo, root, 'a.txt', 'a\n', 'add a');

  const result = runJson(repo, root);

  assert.equal(result.baseRef, 'main');
  assert.equal(result.commits.length, 1);
});

test('fails when there is no default branch', () => {
  const { root, repo } = setupRepo({ branch: 'trunk' });
  const result = run(repo, root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /default branch/);
});

test('unknown ref fails with a non-zero exit', () => {
  const { root, repo } = setupRepo();
  for (const target of ['no-such-branch', 'main..no-such-branch']) {
    const result = run(repo, root, { args: [target] });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Unknown ref: no-such-branch\n$/);
  }
});

test('empty diff gives empty files', () => {
  const { root, repo } = setupRepo();
  const result = runJson(repo, root);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.commits, []);
  assert.equal(result.uncommitted, false);
  assert.equal(result.head, git(repo, root, ['rev-parse', 'HEAD']));
  assert.deepEqual(result.totals, { files: 0, added: 0, removed: 0, excludedFiles: 0 });
});

test('PR target uses gh data and diffs from the merge-base, without uncommitted changes', () => {
  const { root, repo } = setupRepo();
  const base = git(repo, root, ['rev-parse', 'HEAD']);
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  const head = commitFile(repo, root, 'a.txt', 'a\n', 'add a');
  git(repo, root, ['switch', '-q', 'main']);
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  installFakeGh(
    root,
    pullRequestJson({ number: 5, headRefName: 'feature', headRefOid: head, baseRefOid: base }),
  );

  const result = runJson(repo, root, { args: ['5'] });

  assert.equal(result.target.kind, 'pr');
  assert.equal(result.base, base);
  assert.equal(result.baseRef, 'main');
  assert.equal(result.head, head);
  assert.equal(result.uncommitted, false);
  assert.equal(result.pr.url, 'https://github.com/owner/repo/pull/5');
  assert.deepEqual(Object.keys(byPath(result.files)), ['a.txt']);
});

test('PR target includes uncommitted changes when the PR head is checked out', () => {
  const { root, repo } = setupRepo();
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  const head = commitFile(repo, root, 'a.txt', 'a\n', 'add a');
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  installFakeGh(root, pullRequestJson({ number: 5, headRefName: 'feature', headRefOid: head }));

  const result = runJson(repo, root, { args: ['https://github.com/owner/repo/pull/5'] });

  assert.equal(result.target.kind, 'pr');
  assert.equal(result.head, 'WORKTREE');
  assert.deepEqual(Object.keys(byPath(result.files)), ['a.txt', 'dirty.txt']);
});

test('PR target from a fork with the same branch name as the current branch ignores the checkout', () => {
  const { root, repo: upstream } = setupRepo({ name: 'upstream' });
  git(upstream, root, ['switch', '-q', '-c', 'fork-main']);
  const head = commitFile(upstream, root, 'a.txt', 'a\n', 'add a');
  git(upstream, root, ['update-ref', 'refs/pull/7/head', head]);
  git(upstream, root, ['switch', '-q', 'main']);
  git(upstream, root, ['branch', '-q', '-D', 'fork-main']);
  const clone = join(root, 'clone');
  git(root, root, ['clone', '-q', upstream, clone]);
  git(clone, root, ['fetch', '-q', 'origin', 'refs/pull/7/head']);
  writeFileSync(join(clone, 'dirty.txt'), 'dirty\n');
  installFakeGh(root, pullRequestJson({ number: 7, headRefName: 'main', headRefOid: head }));

  const result = runJson(clone, root, { args: ['7'] });

  assert.equal(result.head, head);
  assert.equal(result.uncommitted, false);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ['add a'],
  );
  assert.deepEqual(Object.keys(byPath(result.files)), ['a.txt']);
});

test('PR target uses the PR head when the local branch is behind it', () => {
  const { root, repo } = setupRepo();
  const base = git(repo, root, ['rev-parse', 'HEAD']);
  git(repo, root, ['switch', '-q', '-c', 'feature']);
  const behind = commitFile(repo, root, 'a.txt', 'a\n', 'add a');
  const head = commitFile(repo, root, 'b.txt', 'b\n', 'add b');
  git(repo, root, ['update-ref', 'refs/remotes/origin/feature', head]);
  git(repo, root, ['reset', '-q', '--hard', behind]);
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  installFakeGh(
    root,
    pullRequestJson({ number: 5, headRefName: 'feature', headRefOid: head, baseRefOid: base }),
  );

  const result = runJson(repo, root, { args: ['5'] });

  assert.equal(result.head, head);
  assert.equal(result.uncommitted, false);
  assert.deepEqual(
    result.commits.map((commit) => commit.subject),
    ['add a', 'add b'],
  );
  assert.deepEqual(Object.keys(byPath(result.files)), ['a.txt', 'b.txt']);
});

test('PR target reports a missing head without fetching it', () => {
  const { root, repo: upstream } = setupRepo({ name: 'upstream' });
  git(upstream, root, ['switch', '-q', '-c', 'feature']);
  const head = commitFile(upstream, root, 'a.txt', 'a\n', 'add a');
  git(upstream, root, ['update-ref', 'refs/pull/7/head', head]);
  git(upstream, root, ['switch', '-q', 'main']);
  git(upstream, root, ['branch', '-q', '-D', 'feature']);
  const clone = join(root, 'clone');
  git(root, root, ['clone', '-q', '--no-local', upstream, clone]);
  installFakeGh(root, pullRequestJson({ number: 7, headRefName: 'feature', headRefOid: head }));

  const result = run(clone, root, { args: ['7'] });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not local; run git fetch origin refs\/pull\/7\/head and try again/);
  assert.notEqual(
    spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], {
      cwd: clone,
      env: isolatedEnv(root, false),
    }).status,
    0,
  );
});

test('PR target fails with a clear message when gh is missing', () => {
  const { root, repo } = setupRepo();
  const result = run(repo, root, { args: ['5'], withoutGh: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^gh is not installed/);
});

test('PR target fails when gh fails', () => {
  const { root, repo } = setupRepo();
  const result = run(repo, root, { args: ['5'] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^gh pr view 5 failed: no pull requests found\n$/);
});

test('fails outside a git repository', () => {
  const root = makeRoot();
  const folder = join(root, 'plain');
  mkdirSync(folder);
  const result = run(folder, root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^Not inside a git work tree\n$/);
});

function setupRepo({ branch = 'main', name = 'repo' } = {}) {
  const root = makeRoot();
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, root, ['init', '-q', '-b', branch]);
  commitFile(repo, root, 'README.md', 'hello\n', 'init');
  return { root, repo };
}

function makeRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'collect-changes-')));
  tempRoots.push(root);
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'no-gh-bin'));
  symlinkSync(realGit, join(root, 'bin', 'git'));
  symlinkSync(realGit, join(root, 'no-gh-bin', 'git'));
  writeFileSync(join(root, 'gh-output.json'), '');
  writeFakeGh(root, 'echo "no pull requests found" >&2\nexit 1\n');
  return root;
}

function installFakeGh(root, json) {
  writeFileSync(join(root, 'gh-output.json'), JSON.stringify(json));
  writeFakeGh(root, `cat "${join(root, 'gh-output.json')}"\n`);
}

function writeFakeGh(root, body) {
  const ghPath = join(root, 'bin', 'gh');
  writeFileSync(ghPath, `#!/bin/sh\n${body}`);
  chmodSync(ghPath, 0o755);
}

function pullRequestJson({ number, headRefName, headRefOid = '', baseRefOid = '' }) {
  return {
    number,
    title: 'Add a',
    body: 'Adds a.',
    url: `https://github.com/owner/repo/pull/${number}`,
    baseRefName: 'main',
    baseRefOid,
    headRefName,
    headRefOid,
    closingIssuesReferences: [{ number: 9, url: 'https://example.com/issues/9' }],
  };
}

function commitFile(repo, root, path, content, message) {
  writeFileSync(join(repo, path), content);
  git(repo, root, ['add', path]);
  return commitStaged(repo, root, message);
}

function commitStaged(repo, root, message) {
  git(repo, root, ['commit', '-q', '-m', message]);
  return git(repo, root, ['rev-parse', 'HEAD']);
}

function byPath(files) {
  return Object.fromEntries(
    files.map((file) => [
      file.path,
      { status: file.status, added: file.added, removed: file.removed, untracked: file.untracked },
    ]),
  );
}

function diffPaths(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(.*)$/gm)].map((match) => match[1]);
}

function runJson(cwd, root, options = {}) {
  const result = run(cwd, root, options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function run(cwd, root, { args = [], withoutGh = false } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv(root, withoutGh),
  });
}

function git(cwd, root, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: isolatedEnv(root, false) }).trim();
}

function isolatedEnv(root, withoutGh) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') && !name.startsWith('GH_') && name !== 'GITHUB_TOKEN',
    ),
  );
  const path = withoutGh ? join(root, 'no-gh-bin') : `${join(root, 'bin')}:/usr/bin:/bin`;
  return {
    ...env,
    HOME: join(root, 'home'),
    PATH: path,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}
