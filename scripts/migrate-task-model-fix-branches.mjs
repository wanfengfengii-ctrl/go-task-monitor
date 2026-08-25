#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/i;

function canonicalBranch(bugIndex, actor) {
  return `bug-${String(bugIndex).padStart(2, '0')}/${actor}_model_fix`;
}

async function remoteHead(cloneUrl, branch) {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', cloneUrl, `refs/heads/${branch}`]);
  return stdout.trim().split(/\s+/, 1)[0] || '';
}

async function ensureCommitExists(repoDir, commit) {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repoDir });
  } catch {
    throw new Error(`远端仓库中找不到提交 ${commit}`);
  }
}

async function ensureBranch(repoDir, cloneUrl, branch, commit) {
  const current = await remoteHead(cloneUrl, branch);
  if (current && current !== commit) throw new Error(`${branch} 已指向 ${current}，不能覆盖为 ${commit}`);
  if (!current) await execFileAsync('git', ['push', 'origin', `${commit}:refs/heads/${branch}`], { cwd: repoDir });
  const published = await remoteHead(cloneUrl, branch);
  if (published !== commit) throw new Error(`${branch} 远端校验失败：期望 ${commit}，实际 ${published || '不存在'}`);
}

async function publishBranches(cloneUrl, branches) {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'task-model-fix-migrate-'));
  const repoDir = path.join(temporaryRoot, 'repository');
  try {
    await execFileAsync('git', ['clone', '--no-checkout', cloneUrl, repoDir]);
    for (const { commit } of branches) await ensureCommitExists(repoDir, commit);
    for (const { branch, commit } of branches) await ensureBranch(repoDir, cloneUrl, branch, commit);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function migrateTask(taskDir) {
  const publicPath = path.join(path.resolve(taskDir), 'public.json');
  const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
  const bugIndex = Number(metadata.bug_index);
  if (!Number.isInteger(bugIndex) || bugIndex < 1 || bugIndex > 5) throw new Error(`${publicPath} 的 bug_index 不合法`);
  if (!shaPattern.test(String(metadata.test_model_fix_commit || ''))) throw new Error(`${publicPath} 缺少 test_model_fix_commit`);
  if (!shaPattern.test(String(metadata.gold_model_fix_commit || ''))) throw new Error(`${publicPath} 缺少 gold_model_fix_commit`);
  const cloneUrl = String(metadata.clone_url || metadata.repository || '').trim();
  const repository = String(metadata.repository || '').replace(/\.git$/i, '').replace(/\/$/, '');
  if (!cloneUrl || !/^https:\/\/[^\s]+$/i.test(repository)) throw new Error(`${publicPath} 缺少 Git 仓库地址`);

  const testBranch = canonicalBranch(bugIndex, 'test');
  const goldBranch = canonicalBranch(bugIndex, 'gold');
  await publishBranches(cloneUrl, [
    { branch: testBranch, commit: metadata.test_model_fix_commit },
    { branch: goldBranch, commit: metadata.gold_model_fix_commit },
  ]);

  metadata.test_model_fix_branch = testBranch;
  metadata.gold_model_fix_branch = goldBranch;
  metadata.repo_url = `${repository}/tree/${testBranch}`;
  const temporary = `${publicPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, publicPath);
  process.stdout.write(`${metadata.bug_id}\t${metadata.repo_url}\n`);
}

const taskDirs = process.argv.slice(2);
if (!taskDirs.length) throw new Error('用法：node scripts/migrate-task-model-fix-branches.mjs <task-dir> [...]');
for (const taskDir of taskDirs) await migrateTask(taskDir);
