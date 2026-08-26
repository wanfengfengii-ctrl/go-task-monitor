import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const GIT_COMMIT_LAYOUT_POLICY_VERSION = 1;

function text(value) {
  return String(value ?? '').trim();
}

function expectedBranches(record = {}) {
  const bugIndex = Number(record.bug_index ?? record.bugIndex);
  if (!Number.isInteger(bugIndex) || bugIndex < 1) throw new Error('Git 交付缺少有效 bug_index');
  return {
    red: `bug${bugIndex}_red`,
    green: `bug${bugIndex}_green`,
  };
}

function repositoryUrl(record = {}) {
  const repository = text(record.clone_url || record.cloneUrl || record.repository);
  if (!repository || /\s/.test(repository)) throw new Error('Git 交付缺少有效远端仓库地址');
  return repository.replace(/\/tree\/.*$/i, '');
}

export function usesFixedGitCommitLayout(record = {}) {
  if (Number(record.git_commit_layout_policy_version ?? record.gitCommitLayoutPolicyVersion ?? 0)
    < GIT_COMMIT_LAYOUT_POLICY_VERSION) return false;
  const bugIndex = Number(record.bug_index ?? record.bugIndex);
  if (!Number.isInteger(bugIndex) || bugIndex < 1) return false;
  const taskType = text(record.task_type || record.taskType).toLowerCase();
  const redBranch = text(record.red_branch || record.redBranch);
  const greenBranch = text(record.green_branch || record.greenBranch);
  if (redBranch !== `bug${bugIndex}_red`) return false;
  if (taskType === 'diagnosis') return greenBranch === '';
  return taskType === 'bugfix' && greenBranch === `bug${bugIndex}_green`;
}

export function gitDeliveryLayoutIssues(record = {}, snapshot = {}) {
  const issues = [];
  const taskType = text(record.task_type || record.taskType).toLowerCase();
  const branches = expectedBranches(record);
  const heads = snapshot.heads || {};
  const commitCounts = snapshot.commitCounts || {};
  const redHead = text(heads[branches.red]);
  const greenHead = text(heads[branches.green]);
  const redCount = Number(commitCounts[branches.red]);
  const greenCount = Number(commitCounts[branches.green]);
  const expectedRedCommit = text(record.red_commit || record.redCommit);

  if (text(record.red_branch || record.redBranch) !== branches.red) {
    issues.push(`red_branch 必须为 ${branches.red}`);
  }
  if (!redHead) issues.push(`远端缺少 ${branches.red}`);
  if (!GIT_SHA_PATTERN.test(expectedRedCommit)) issues.push('red_commit 必须是 40 位 Git commit SHA');
  if (redHead && GIT_SHA_PATTERN.test(expectedRedCommit) && redHead !== expectedRedCommit) {
    issues.push(`远端 ${branches.red} 分支头与 red_commit 不一致`);
  }

  if (taskType === 'bugfix') {
    if (text(record.green_branch || record.greenBranch) !== branches.green) {
      issues.push(`green_branch 必须为 ${branches.green}`);
    }
    if (!greenHead) issues.push(`远端缺少 ${branches.green}`);
    const expectedGreenCommit = text(record.test_model_fix_commit
      || record.testModelFixCommit
      || record.green_fix_commit
      || record.greenFixCommit);
    if (!GIT_SHA_PATTERN.test(expectedGreenCommit)) issues.push('模型修复 commit 必须是 40 位 Git commit SHA');
    if (greenHead && GIT_SHA_PATTERN.test(expectedGreenCommit) && greenHead !== expectedGreenCommit) {
      issues.push(`远端 ${branches.green} 分支头与模型修复 commit 不一致`);
    }
    if (redHead && redCount !== 1) issues.push(`${branches.red} 必须且只能包含 1 个 commit，实际为 ${redCount}`);
    if (greenHead && greenCount !== 2) issues.push(`${branches.green} 必须且只能包含 2 个 commit，实际为 ${greenCount}`);
  } else if (taskType === 'diagnosis') {
    if (text(record.green_branch || record.greenBranch)) issues.push('diagnosis 不得记录 green_branch');
    if (greenHead) issues.push(`diagnosis 远端不得存在 ${branches.green}`);
    if (redHead && redCount !== 1) issues.push(`${branches.red} 必须且只能包含 1 个 commit，实际为 ${redCount}`);
  } else {
    issues.push(`不支持的 task_type：${taskType || '空'}`);
  }

  return issues;
}

function parseRemoteHeads(output) {
  return Object.fromEntries(text(output).split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, ref] = line.split(/\s+/);
    return [text(ref).replace(/^refs\/heads\//, ''), text(commit)];
  }));
}

async function runGit(args, { cwd, timeoutMs }) {
  return execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function inspectRemoteGitDeliveryLayout(record = {}, {
  timeoutMs = 90_000,
  gitRunner = runGit,
} = {}) {
  const repository = repositoryUrl(record);
  const branches = expectedBranches(record);
  const refs = [`refs/heads/${branches.red}`, `refs/heads/${branches.green}`];
  const remote = await gitRunner(['ls-remote', '--heads', repository, ...refs], { timeoutMs });
  const heads = parseRemoteHeads(remote.stdout);
  const commitCounts = {};
  const existingBranches = Object.keys(heads);
  if (!existingBranches.length) return { repository, heads, commitCounts };

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-git-layout-audit-'));
  try {
    await gitRunner(['init', '--bare', '--quiet', temporary], { timeoutMs });
    const refspecs = existingBranches.map((branch) => `+refs/heads/${branch}:refs/heads/${branch}`);
    await gitRunner(['fetch', '--quiet', '--no-tags', '--filter=blob:none', repository, ...refspecs], {
      cwd: temporary,
      timeoutMs,
    });
    for (const branch of existingBranches) {
      const count = await gitRunner(['rev-list', '--count', `refs/heads/${branch}`], { cwd: temporary, timeoutMs });
      commitCounts[branch] = Number(text(count.stdout));
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return { repository, heads, commitCounts };
}

export async function assertRemoteGitDeliveryLayout(record = {}, options = {}) {
  const snapshot = await inspectRemoteGitDeliveryLayout(record, options);
  const issues = gitDeliveryLayoutIssues(record, snapshot);
  if (issues.length) {
    const bugId = text(record.bug_id || record.bugId) || '当前任务';
    throw new Error(`${bugId} 的远端 Red/Green 结构不合格：${issues.join('；')}`);
  }
  return snapshot;
}
