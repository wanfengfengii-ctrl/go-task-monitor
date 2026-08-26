import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitDeliveryLayoutIssues, inspectRemoteGitDeliveryLayout, usesFixedGitCommitLayout } from './git-delivery-layout.js';

const redCommit = 'a'.repeat(40);
const greenCommit = 'b'.repeat(40);

function bugfix(overrides = {}) {
  return {
    bug_id: 'nyh-go-0300-bug-01',
    bug_index: 1,
    task_type: 'bugfix',
    red_branch: 'bug1_red',
    red_commit: redCommit,
    green_branch: 'bug1_green',
    test_model_fix_commit: greenCommit,
    git_commit_layout_policy_version: 1,
    ...overrides,
  };
}

test('bugfix requires exactly one Red commit and two Green commits', () => {
  const record = bugfix();
  assert.equal(usesFixedGitCommitLayout(record), true);
  assert.equal(usesFixedGitCommitLayout({ ...record, git_commit_layout_policy_version: 0 }), false);
  assert.equal(usesFixedGitCommitLayout({ ...record, green_branch: 'bug1/green' }), false);
  assert.deepEqual(gitDeliveryLayoutIssues(record, {
    heads: { bug1_red: redCommit, bug1_green: greenCommit },
    commitCounts: { bug1_red: 1, bug1_green: 2 },
  }), []);

  const issues = gitDeliveryLayoutIssues(record, {
    heads: { bug1_red: 'c'.repeat(40), bug1_green: 'd'.repeat(40) },
    commitCounts: { bug1_red: 2, bug1_green: 3 },
  });
  assert.match(issues.join('；'), /red_commit 不一致/);
  assert.match(issues.join('；'), /模型修复 commit 不一致/);
  assert.match(issues.join('；'), /bug1_red.*1 个 commit.*实际为 2/);
  assert.match(issues.join('；'), /bug1_green.*2 个 commit.*实际为 3/);
});

test('diagnosis requires one Red commit and forbids a Green branch', () => {
  const record = {
    bug_id: 'nyh-go-0300-bug-02',
    bug_index: 2,
    task_type: 'diagnosis',
    red_branch: 'bug2_red',
    red_commit: redCommit,
    green_branch: '',
    git_commit_layout_policy_version: 1,
  };
  assert.equal(usesFixedGitCommitLayout(record), true);
  assert.equal(usesFixedGitCommitLayout({ ...record, green_branch: 'bug2_green' }), false);
  assert.deepEqual(gitDeliveryLayoutIssues(record, {
    heads: { bug2_red: redCommit },
    commitCounts: { bug2_red: 1 },
  }), []);

  const issues = gitDeliveryLayoutIssues(record, {
    heads: { bug2_red: redCommit, bug2_green: greenCommit },
    commitCounts: { bug2_red: 2, bug2_green: 1 },
  });
  assert.match(issues.join('；'), /不得存在 bug2_green/);
  assert.match(issues.join('；'), /bug2_red.*1 个 commit.*实际为 2/);
});

test('remote inspection reads real branch heads and complete commit counts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-delivery-layout-test-'));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const git = (args, cwd = work) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '--quiet', work]);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);

    git(['switch', '--orphan', 'bug1_red']);
    await writeFile(path.join(work, 'service.go'), 'package sample\n');
    git(['add', 'service.go']);
    git(['commit', '--quiet', '-m', 'red']);
    const actualRed = git(['rev-parse', 'HEAD']);

    git(['switch', '--orphan', 'bug1_green']);
    await writeFile(path.join(work, 'service.go'), 'package sample\n');
    git(['add', 'service.go']);
    git(['commit', '--quiet', '-m', 'bug']);
    await writeFile(path.join(work, 'service.go'), 'package sample\n\nconst Fixed = true\n');
    git(['add', 'service.go']);
    git(['commit', '--quiet', '-m', 'fix']);
    const actualGreen = git(['rev-parse', 'HEAD']);

    execFileSync('git', ['init', '--bare', '--quiet', remote]);
    git(['remote', 'add', 'origin', remote]);
    git(['push', '--quiet', 'origin', 'bug1_red', 'bug1_green']);

    const snapshot = await inspectRemoteGitDeliveryLayout(bugfix({
      repository: remote,
      red_commit: actualRed,
      test_model_fix_commit: actualGreen,
    }));
    assert.equal(snapshot.heads.bug1_red, actualRed);
    assert.equal(snapshot.heads.bug1_green, actualGreen);
    assert.equal(snapshot.commitCounts.bug1_red, 1);
    assert.equal(snapshot.commitCounts.bug1_green, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
