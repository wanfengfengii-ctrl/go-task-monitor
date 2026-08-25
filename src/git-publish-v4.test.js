import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const publisher = path.resolve(import.meta.dirname, '../scripts/publish-v4-git-layout.sh');

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

test('policy 4 publisher creates orphan G2/R1 from one private fixture', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-v4-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const task = path.join(root, 'task');
  const fixed = path.join(root, 'fixed');
  const fixture = path.join(task, 'private-verification-bug1');
  await Promise.all([fs.mkdir(seed), fs.mkdir(task), fs.mkdir(fixed)]);
  await fs.mkdir(fixture, { recursive: true });
  await git(root, 'init', '--bare', remote);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/v4\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'value.go'), 'package v4\n\nfunc Value() int { return 0 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'switch', '--orphan', 'bug1_green');
  await git(seed, 'read-tree', 'main');
  await git(seed, 'checkout-index', '-a');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'G1');
  const g1 = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'HEAD:bug1_green');
  const testFile = 'value_model_test.go';
  const testSource = 'package v4\n\nimport "testing"\n\nfunc TestModel_Value(t *testing.T) { if Value() != 1 { t.Fatal("want one") } }\n';
  await fs.writeFile(path.join(fixture, testFile), testSource);
  await fs.writeFile(path.join(fixed, 'go.mod'), 'module example.test/v4\n\ngo 1.23\n');
  await fs.writeFile(path.join(fixed, 'value.go'), 'package v4\n\nfunc Value() int { return 1 }\n');
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify({
    workflow_version: 3,
    workflow_policy_version: 4,
    verification_policy_version: 5,
    task_type: 'bugfix',
    bug_id: 'v4-bug-01',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://github.com/example/v4',
    clone_url: remote,
    main_branch: 'main',
    main_commit: mainCommit,
    bug_index: 1,
    bug_base_branch: 'bug1_green',
    bug_base_commit: g1,
    green_branch: 'bug1_green',
    red_branch: 'bug1_red',
    test_model_fix_branch: 'bug1_green',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: g1,
    verification_test_overlay: 'private-fixture',
    verification_test_files: [testFile],
    verification_fixture_dir: fixture,
    verification_fixture_sha256: 'b'.repeat(64),
  }, null, 2)}\n`);
  const actualHash = (await execFileAsync('shasum', ['-a', '256', path.join(fixture, testFile)])).stdout.split(/\s+/)[0];
  const metadata = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  metadata.verification_fixture_sha256 = actualHash;
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  let publishResult;
  try {
    publishResult = await execFileAsync('/bin/bash', [publisher, task, fixed, 'session-v4']);
  } catch (error) {
    console.error(error.stderr || error.stdout || error);
    throw error;
  }
  const { stdout } = publishResult;
  const g2 = stdout.trim();
  const updated = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  assert.equal(updated.repo_url, 'https://github.com/example/v4/tree/bug1_green');
  assert.equal(updated.test_model_fix_commit, g2);
  assert.equal(updated.red_pushed, true);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-list', '--parents', '-n', '1', g2).then((value) => value.split(/\s+/).length), 2);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-list', '--parents', '-n', '1', updated.red_commit).then((value) => value.split(/\s+/).length), 1);
  assert.equal(await git(seed, '--git-dir', remote, 'show', `${g2}:${testFile}`), testSource.trimEnd());
  assert.equal(await git(seed, '--git-dir', remote, 'show', `${updated.red_commit}:${testFile}`), testSource.trimEnd());
});

test('policy 4 diagnosis publishes only an orphan red branch', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-v4-diagnosis-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const task = path.join(root, 'task');
  const fixed = path.join(root, 'fixed');
  await Promise.all([fs.mkdir(seed), fs.mkdir(task), fs.mkdir(fixed)]);
  await git(root, 'init', '--bare', remote);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  const source = [
    'module example.test/diagnosis',
    '',
    'go 1.23',
    '',
    'package diagnosis',
    '',
    'func Value() int { return 0 }',
    '',
  ].join('\n');
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/diagnosis\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'value.go'), source.split('\n').slice(4).join('\n'));
  const testSource = 'package diagnosis\n\nimport "testing"\n\nfunc TestValue(t *testing.T) { if Value() != 0 { t.Fatal("unexpected value") } }\n';
  await fs.writeFile(path.join(seed, 'value_test.go'), testSource);
  const unrelatedTestSource = 'package diagnosis\n\nimport "testing"\n\nfunc TestUnrelated(t *testing.T) { t.Helper() }\n';
  await fs.writeFile(path.join(seed, 'unrelated_test.go'), unrelatedTestSource);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'switch', '--orphan', 'bug1_red');
  await git(seed, 'read-tree', 'main');
  await git(seed, 'checkout-index', '-a', '-f');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'R1');
  const redBaseline = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'HEAD:bug1_red');
  await fs.writeFile(path.join(fixed, 'go.mod'), 'module example.test/diagnosis\n\ngo 1.23\n');
  await fs.writeFile(path.join(fixed, 'value.go'), source.split('\n').slice(4).join('\n'));
  await fs.writeFile(path.join(fixed, 'value_test.go'), testSource);
  await fs.writeFile(path.join(fixed, 'unrelated_test.go'), unrelatedTestSource);
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify({
    workflow_version: 3,
    workflow_policy_version: 4,
    verification_policy_version: 5,
    task_type: 'diagnosis',
    bug_id: 'diagnosis-bug-01',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://github.com/example/diagnosis',
    clone_url: remote,
    main_branch: 'main',
    main_commit: mainCommit,
    main_pushed: true,
    bug_index: 1,
    bug_base_commit: redBaseline,
    bug_base_branch: '',
    main_unchanged: true,
    red_branch: 'bug1_red',
    test_model_fix_branch: 'bug1_red',
    verification_test_overlay: 'repository-tests',
    verification_test_files: ['value_test.go'],
  }, null, 2)}\n`);

  const red = (await execFileAsync('/bin/bash', [publisher, task, fixed, 'diagnosis-session'])).stdout.trim();
  const updated = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  assert.equal(updated.repo_url, 'https://github.com/example/diagnosis/tree/bug1_red');
  assert.equal(updated.test_model_fix_branch, 'bug1_red');
  assert.equal(updated.red_branch, 'bug1_red');
  assert.equal(updated.green_branch, '');
  assert.equal(updated.model_input_branch, '');
  assert.equal(updated.red_commit, red);
  assert.equal(red, redBaseline);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-list', '--parents', '-n', '1', red).then((value) => value.split(/\s+/).length), 1);
  assert.equal(await git(seed, '--git-dir', remote, 'show', `${red}:value_test.go`), testSource.trimEnd());
  assert.equal(await git(seed, '--git-dir', remote, 'show', `${red}:unrelated_test.go`), unrelatedTestSource.trimEnd());
  assert.equal(await git(seed, 'ls-remote', remote, 'refs/heads/bug1_green'), '');
});
