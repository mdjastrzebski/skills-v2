import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./link-skills.mjs', import.meta.url));

test('links every skill and does nothing on the second run', () => {
  const { repo, agentsDir, claudeDir } = setup();
  const first = run(repo, agentsDir, claudeDir);
  assert.equal(first.status, 0);
  assert.equal(readlinkSync(join(agentsDir, 'alpha')), join(repo, 'skills', 'alpha'));
  assert.equal(readlinkSync(join(claudeDir, 'alpha')), join('..', 'agents', 'alpha'));
  assert.ok(existsSync(join(claudeDir, 'beta', 'SKILL.md')));

  const second = run(repo, agentsDir, claudeDir);
  assert.equal(second.status, 0);
  assert.doesNotMatch(second.stdout, /link /);
});

test('links skills from the main repo when run in a worktree', () => {
  const { repo, root, agentsDir, claudeDir } = setup();
  const worktree = join(root, 'worktree');
  git(repo, ['worktree', 'add', '-q', worktree]);
  const result = run(worktree, agentsDir, claudeDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /running in a worktree/);
  assert.equal(readlinkSync(join(agentsDir, 'alpha')), join(repo, 'skills', 'alpha'));
});

test('removes links of skills that are no longer in the repo', () => {
  const { repo, agentsDir, claudeDir } = setup();
  run(repo, agentsDir, claudeDir);
  rmSync(join(repo, 'skills', 'beta'), { recursive: true });
  const result = run(repo, agentsDir, claudeDir);
  assert.equal(result.status, 0);
  assert.ok(!existsLink(join(agentsDir, 'beta')));
  assert.ok(!existsLink(join(claudeDir, 'beta')));
  assert.ok(existsLink(join(agentsDir, 'alpha')));
});

test('keeps links that belong to other repos', () => {
  const { repo, root, agentsDir, claudeDir } = setup();
  symlinkSync(join(root, 'other-repo', 'alpha'), join(agentsDir, 'alpha'));
  symlinkSync(join(root, 'other-repo', 'gamma'), join(agentsDir, 'gamma'));
  const result = run(repo, agentsDir, claudeDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not to this repo; use --force/);
  assert.equal(readlinkSync(join(agentsDir, 'alpha')), join(root, 'other-repo', 'alpha'));
  assert.ok(existsLink(join(agentsDir, 'gamma')));
});

test('replaces links of other repos with --force', () => {
  const { repo, root, agentsDir, claudeDir } = setup();
  symlinkSync(join(root, 'other-repo', 'alpha'), join(agentsDir, 'alpha'));
  const result = run(repo, agentsDir, claudeDir, ['--force']);
  assert.equal(result.status, 0);
  assert.equal(readlinkSync(join(agentsDir, 'alpha')), join(repo, 'skills', 'alpha'));
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'link-skills-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  copyFileSync(script, join(repo, 'scripts', 'link-skills.mjs'));
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(repo, 'skills', name), { recursive: true });
    writeFileSync(join(repo, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init']);

  const agentsDir = join(root, 'home', 'agents');
  const claudeDir = join(root, 'home', 'claude');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  return { root, repo, agentsDir, claudeDir };
}

function run(checkout, agentsDir, claudeDir, args = []) {
  return spawnSync('node', [join(checkout, 'scripts', 'link-skills.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTS_SKILLS_DIR: agentsDir, CLAUDE_SKILLS_DIR: claudeDir },
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function existsLink(linkPath) {
  try {
    readlinkSync(linkPath);
    return true;
  } catch {
    return false;
  }
}
