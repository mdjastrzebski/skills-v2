#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const repoRoot = findMainRepoRoot(scriptRepoRoot);
const skillsRoot = path.join(repoRoot, 'skills');
const agentsSkillsDir =
  process.env.AGENTS_SKILLS_DIR ?? path.join(os.homedir(), '.agents', 'skills');
const claudeSkillsDir =
  process.env.CLAUDE_SKILLS_DIR ?? path.join(os.homedir(), '.claude', 'skills');
const force = process.argv.includes('--force');

main();

function main() {
  if (repoRoot !== scriptRepoRoot) {
    console.log(`note   running in a worktree; linking skills from the main repo ${repoRoot}`);
  }

  fs.mkdirSync(agentsSkillsDir, { recursive: true });
  fs.mkdirSync(claudeSkillsDir, { recursive: true });

  const skillNames = listSkillNames();
  let allLinked = true;
  for (const skillName of skillNames) {
    if (!linkSkill(skillName)) {
      allLinked = false;
    }
  }
  pruneRemovedSkills(skillNames);

  if (allLinked) {
    console.log(`All skills linked from ${repoRoot}`);
  }
  process.exitCode = allLinked ? 0 : 1;
}

function findMainRepoRoot(fallbackRoot) {
  let commonGitDir;
  try {
    commonGitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: fallbackRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return fallbackRoot;
  }

  if (path.basename(commonGitDir) !== '.git') {
    console.error(
      `error  ${commonGitDir} has no main checkout; run this script from a normal clone`,
    );
    process.exit(1);
  }
  return fs.realpathSync(path.dirname(commonGitDir));
}

function listSkillNames() {
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .toSorted();
}

function linkSkill(skillName) {
  const agentsLink = path.join(agentsSkillsDir, skillName);
  const claudeLink = path.join(claudeSkillsDir, skillName);

  const agentsLinked = linkOrSkip(path.join(skillsRoot, skillName), agentsLink, isInsideSkillsRoot);
  if (!agentsLinked) {
    return false;
  }

  const pointsToAgentsLink = (resolvedTarget) => resolvedTarget === agentsLink;
  return linkOrSkip(path.relative(claudeSkillsDir, agentsLink), claudeLink, pointsToAgentsLink);
}

function pruneRemovedSkills(skillNames) {
  for (const entryName of listSymlinkNames(agentsSkillsDir)) {
    if (skillNames.includes(entryName)) {
      continue;
    }

    const agentsLink = path.join(agentsSkillsDir, entryName);
    if (!isInsideSkillsRoot(resolveLinkTarget(agentsLink))) {
      continue;
    }
    removeLink(agentsLink);

    const claudeLink = path.join(claudeSkillsDir, entryName);
    if (isSymlink(claudeLink) && resolveLinkTarget(claudeLink) === agentsLink) {
      removeLink(claudeLink);
    }
  }
}

function linkOrSkip(target, linkPath, isOwnedTarget) {
  if (!entryExists(linkPath)) {
    createLink(target, linkPath);
    return true;
  }

  if (!isSymlink(linkPath)) {
    console.error(`skip   ${linkPath} is a real folder or file; remove it first`);
    return false;
  }

  const currentTarget = fs.readlinkSync(linkPath);
  if (currentTarget === target) {
    return true;
  }

  if (!isOwnedTarget(resolveLinkTarget(linkPath)) && !force) {
    console.error(
      `skip   ${linkPath} points to ${currentTarget}, not to this repo; use --force to replace it`,
    );
    return false;
  }

  fs.unlinkSync(linkPath);
  console.log(`relink ${linkPath} (was -> ${currentTarget})`);
  createLink(target, linkPath);
  return true;
}

function createLink(target, linkPath) {
  fs.symlinkSync(target, linkPath);
  console.log(`link   ${linkPath} -> ${target}`);
}

function removeLink(linkPath) {
  fs.unlinkSync(linkPath);
  console.log(`remove ${linkPath} (skill no longer in repo)`);
}

function listSymlinkNames(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name);
}

function isInsideSkillsRoot(resolvedTarget) {
  return resolvedTarget.startsWith(skillsRoot + path.sep);
}

function resolveLinkTarget(linkPath) {
  return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
}

function entryExists(entryPath) {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(entryPath) {
  return entryExists(entryPath) && fs.lstatSync(entryPath).isSymbolicLink();
}
