import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const publisher = path.resolve(import.meta.dirname, '../publish_test_model_fix.sh');

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

test('publisher fetches only the task BUG_BASE and does not check out remote blobs', async () => {
  const source = await fs.readFile(publisher, 'utf8');
  assert.match(source, /git clone --quiet --no-checkout --filter=blob:none --no-tags --single-branch/);
  assert.match(source, /--branch "\$bug_base_branch" "\$clone_url" "\$delivery_repo"/);
  assert.match(source, /chmod -R u\+w "\$delivery_repo"/);
  assert.match(source, /git -C "\$delivery_repo" read-tree "\$bug_base_commit"/);
  assert.doesNotMatch(source, /git clone --quiet "\$clone_url"/);
  assert.doesNotMatch(source, /checkout --quiet -B "\$canonical_test_branch"/);
});

test('publisher creates a numbered test-model branch beyond the legacy five bug slots', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const task = path.join(root, 'task');
  const fixed = path.join(root, 'fixed');
  await fs.mkdir(seed);
  await fs.mkdir(task);
  await fs.mkdir(fixed);
  await git(root, 'init', '--bare', remote);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/generated\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'counter.go'), 'package generated\n\nfunc Next(value int) int { return value - 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'generated main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');

  const bugBaseCommit = mainCommit;
  await git(seed, 'push', 'origin', 'HEAD:bug6_main');
  await git(seed, 'push', 'origin', 'HEAD:BUG_BASE6');

  await git(seed, 'switch', '-c', 'gold_model_fix6');
  await fs.writeFile(path.join(seed, 'counter.go'), 'package generated\n\nfunc Next(value int) int { return value + 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'gold fix');
  const goldCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'gold_model_fix6');

  await fs.cp(path.join(seed, 'go.mod'), path.join(fixed, 'go.mod'));
  await fs.writeFile(path.join(fixed, 'counter.go'), 'package generated\n\nfunc Next(value int) int { return value + 2 - 1 }\n');
  await fs.writeFile(path.join(fixed, 'counter_model_test.go'), 'package generated\n\nimport \"testing\"\n\nfunc TestModel_CounterIncrements(t *testing.T) { if Next(1) != 2 { t.Fatal(\"want increment\") } }\n');
  const metadata = {
    bug_id: 'generated-counter-next',
    title: '计数器递增方向错误',
    task_type: 'bugfix',
    verification_policy_version: 5,
    bug_base_branch: 'BUG_BASE6',
    go_mod_version: '1.23',
    verify_result: 'verification-owned-by-pipeline',
    gold_root_cause: 'counter.go 的 Next 使用减法，导致递增调用返回更小的值。',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/generated-counter',
    clone_url: remote,
    bug_index: 6,
    main_branch: 'main',
    main_commit: mainCommit,
    bug_main_branch: 'bug6_main',
    bug_main_commit: mainCommit,
    bug_base_branch: 'BUG_BASE6',
    bug_base_commit: bugBaseCommit,
    test_model_fix_branch: 'test_model_fix6',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: bugBaseCommit,
    gold_model_fix_branch: 'gold_model_fix6',
    gold_model_fix_commit: goldCommit,
  };
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  const { stdout } = await execFileAsync('/bin/bash', [publisher, task, fixed, 'session-test-123']);
  const testCommit = stdout.trim();
  assert.match(testCommit, /^[0-9a-f]{40}$/);
  const updated = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  assert.equal(updated.test_model_fix_commit, testCommit);
  assert.equal(updated.test_model_fix_pushed, true);
  assert.equal(updated.test_model_fix_session_id, 'session-test-123');
  assert.equal(updated.test_model_fix_branch, 'bug-06/test_model_fix');
  assert.equal(updated.gold_model_fix_branch, 'bug-06/gold_model_fix');
  assert.equal(updated.repo_url, 'https://git.example.com/team/generated-counter/tree/bug-06/test_model_fix');
  assert.equal(updated.verify_result, '');
  assert.equal(await git(seed, 'ls-remote', remote, 'refs/heads/bug-06/test_model_fix').then((value) => value.split(/\s+/)[0]), testCommit);
  assert.equal(await git(seed, 'ls-remote', remote, 'refs/heads/bug-06/gold_model_fix').then((value) => value.split(/\s+/)[0]), goldCommit);
  const parent = await git(seed, '--git-dir', remote, 'rev-parse', `${testCommit}^`);
  assert.equal(parent, bugBaseCommit);
});

test('V3 publisher pushes Claude fix without requiring or creating a Gold branch', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-v3-test-'));
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
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/claudeonly\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'counter.go'), 'package claudeonly\n\nfunc Next(value int) int { return value - 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'generated main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'switch', '--orphan', 'bug1_green');
  await git(seed, 'read-tree', 'main');
  await git(seed, 'checkout-index', '-a');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'init green snapshot');
  const greenCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'HEAD:bug1_green');
  await git(seed, 'switch', 'main');

  await fs.cp(path.join(seed, 'go.mod'), path.join(fixed, 'go.mod'));
  await fs.writeFile(path.join(fixed, 'counter.go'), 'package claudeonly\n\nfunc Next(value int) int { return value + 1 }\n');
  await fs.writeFile(path.join(fixed, 'counter_model_test.go'), 'package claudeonly\n\nimport "testing"\n\nfunc TestModel_Next(t *testing.T) { if Next(1) != 2 { t.Fatal("want increment") } }\n');
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify({
    workflow_version: 3,
    bug_id: 'claude-only-next',
    task_type: 'bugfix',
    verification_policy_version: 5,
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/claude-only',
    clone_url: remote,
    bug_index: 1,
    main_branch: 'main',
    main_commit: mainCommit,
    bug_base_branch: 'bug1_green',
    bug_base_commit: greenCommit,
    bug_base_root: true,
    bug_base_source_commit: mainCommit,
    green_branch: 'bug1_green',
    green_baseline_commit: greenCommit,
    green_baseline_pushed: true,
    red_branch: 'bug1_red',
    model_input_branch: 'bug1_green',
    model_input_commit: greenCommit,
    model_input_snapshot: 'single-branch-single-commit-no-tests',
    bug_base_pushed: true,
    main_unchanged: true,
    bug_source: 'natural',
    test_model_fix_branch: 'bug1_green',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: greenCommit,
  }, null, 2)}\n`);

  const { stdout } = await execFileAsync('/bin/bash', [publisher, task, fixed, 'session-v3']);
  const testCommit = stdout.trim();
  const updated = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  assert.equal(updated.test_model_fix_commit, testCommit);
  assert.equal(updated.test_model_fix_branch, 'bug1_green');
  assert.equal(updated.green_branch, 'bug1_green');
  assert.equal(updated.red_branch, 'bug1_red');
  assert.equal('gold_model_fix_branch' in updated, false);
  assert.equal('gold_model_fix_commit' in updated, false);
  assert.equal('gold_patch' in updated, false);
  assert.equal(await git(seed, 'ls-remote', remote, 'refs/heads/bug1_red').then((value) => value.split(/\s+/)[0]), updated.red_commit);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-list', '--parents', '-n', '1', updated.red_commit).then((value) => value.trim().split(/\s+/).length), 1);
  assert.equal(await git(seed, 'ls-remote', remote, 'refs/heads/bug-01/gold_model_fix'), '');
});

test('historical V3 diagnosis publisher keeps its immutable BUG_BASE branch layout', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-diagnosis-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const task = path.join(root, 'task');
  const workspace = path.join(root, 'workspace');
  await Promise.all([fs.mkdir(seed), fs.mkdir(task), fs.mkdir(workspace)]);
  await git(root, 'init', '--bare', remote);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.name', 'Fixture');
  await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/diagnosis\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'service.go'), 'package diagnosis\n\nfunc Value() int { return 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'generated main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'push', 'origin', 'HEAD:bug2_main');
  await git(seed, 'push', 'origin', 'HEAD:BUG_BASE2');

  await fs.writeFile(path.join(workspace, 'go.mod'), 'module example.test/diagnosis\n\ngo 1.23\n');
  await fs.writeFile(path.join(workspace, 'service.go'), 'package diagnosis\n\nfunc Value() int { return 1 }\n');
  await fs.writeFile(path.join(workspace, 'service_model_test.go'), 'package diagnosis\n\nimport "testing"\n\nfunc TestModel_DiagnosisValue(t *testing.T) { if Value() != 2 { t.Fatal("unexpected value") } }\n');
  const metadata = {
    workflow_version: 3,
    production_flow: 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix',
    bug_id: 'diagnose-value',
    title: '值计算结果异常',
    task_type: 'diagnosis',
    verify_result: 'verification-owned-by-pipeline',
    gold_root_cause: 'service.go 的 Value 符号返回了错误常量，导致结果不符合接口约定。',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/diagnosis',
    clone_url: remote,
    bug_index: 2,
    main_branch: 'main',
    main_commit: mainCommit,
    bug_main_branch: 'bug2_main',
    bug_main_commit: mainCommit,
    bug_base_branch: 'BUG_BASE2',
    bug_base_commit: mainCommit,
    verify_cmds: ["go test . -run '^TestModel_DiagnosisValue$' -count=1 -v"],
    verification_test_overlay: 'none',
    verification_test_files: [],
    verification_test_names: [],
    test_model_fix_branch: 'bug-02/test_model_fix',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: mainCommit,
  };
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  const { stdout } = await execFileAsync('/bin/bash', [publisher, task, workspace, 'diagnosis-session-123']);
  const testCommit = stdout.trim();
  assert.match(testCommit, /^[0-9a-f]{40}$/);
  const updated = JSON.parse(await fs.readFile(path.join(task, 'public.json'), 'utf8'));
  assert.equal(updated.test_model_fix_commit, testCommit);
  assert.equal(updated.verification_test_only_commit, true);
  assert.equal(updated.bug_base_parent_commit, mainCommit);
  assert.equal(updated.test_model_fix_session_id, 'diagnosis-session-123');
  assert.equal(updated.repo_url, 'https://git.example.com/team/diagnosis/tree/bug-02/test_model_fix');
  assert.equal(updated.verify_result, 'verification-owned-by-pipeline');
  assert.equal(updated.verification_test_overlay, 'repository-tests');
  assert.deepEqual(updated.verification_test_files, ['service_model_test.go']);
  assert.deepEqual(updated.verification_test_names, ['TestModel_DiagnosisValue']);
  assert.match(updated.verification_test_manifest[0].sha256, /^[a-f0-9]{64}$/);
  const remoteTestCommit = await git(seed, 'ls-remote', remote, 'refs/heads/bug-02/test_model_fix').then((value) => value.split(/\s+/)[0]);
  assert.equal(remoteTestCommit, testCommit);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-list', '--count', 'refs/heads/bug-02/test_model_fix'), '2');
  assert.equal('green_branch' in updated, false);
  assert.equal('red_branch' in updated, false);
});

test('new V3 publisher still rejects missing green/red metadata', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-v3-invalid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = path.join(root, 'task');
  const workspace = path.join(root, 'workspace');
  await Promise.all([fs.mkdir(task), fs.mkdir(workspace)]);
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify({
    workflow_version: 3,
    production_flow: 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/invalid-v3',
    clone_url: 'https://git.example.com/team/invalid-v3.git',
    bug_index: 1,
    main_branch: 'main',
    bug_base_branch: 'bug1_green',
    test_model_fix_branch: 'bug1_green',
  }, null, 2)}\n`);
  await assert.rejects(
    execFileAsync('/bin/bash', [publisher, task, workspace, 'invalid-v3-session']),
    /green_branch must be bug1_green/,
  );
});

test('publisher accepts an injected BUG_BASE only when it is a direct child of main', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-publish-injected-test-'));
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
  await fs.writeFile(path.join(seed, 'go.mod'), 'module example.test/injected\n\ngo 1.23\n');
  await fs.writeFile(path.join(seed, 'value.go'), 'package injected\n\nfunc Value() int { return 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'generated main');
  const mainCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'push', 'origin', 'HEAD:bug1_main');

  await git(seed, 'switch', '-c', 'BUG_BASE1');
  await fs.writeFile(path.join(seed, 'value.go'), 'package injected\n\nfunc Value() int { return -1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'chore: prepare benchmark baseline slot 01');
  const bugBaseCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'BUG_BASE1');

  await git(seed, 'switch', '-c', 'gold_model_fix1');
  await fs.writeFile(path.join(seed, 'value.go'), 'package injected\n\nfunc Value() int { return 1 }\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'gold fix');
  const goldCommit = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', 'origin', 'gold_model_fix1');

  await fs.writeFile(path.join(fixed, 'go.mod'), 'module example.test/injected\n\ngo 1.23\n');
  await fs.writeFile(path.join(fixed, 'value.go'), 'package injected\n\nfunc Value() int { return 1 }\n');
  await fs.writeFile(path.join(fixed, 'value_model_test.go'), 'package injected\n\nimport \"testing\"\n\nfunc TestModel_Value(t *testing.T) { if Value() != 1 { t.Fatal(\"want one\") } }\n');
  const metadata = {
    bug_id: 'injected-negative-value',
    title: '值计算结果异常',
    task_type: 'bugfix',
    verification_policy_version: 5,
    go_mod_version: '1.23',
    gold_root_cause: 'value.go 的 Value 返回了错误负值，导致结果违反接口约定。',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/injected',
    clone_url: remote,
    bug_index: 1,
    bug_source: 'injected',
    main_branch: 'main',
    main_commit: mainCommit,
    bug_main_branch: 'bug1_main',
    bug_main_commit: mainCommit,
    bug_base_branch: 'BUG_BASE1',
    bug_base_commit: bugBaseCommit,
    test_model_fix_branch: 'bug-01/test_model_fix',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: bugBaseCommit,
    gold_model_fix_branch: 'gold_model_fix1',
    gold_model_fix_commit: goldCommit,
  };
  await fs.writeFile(path.join(task, 'public.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const { stdout } = await execFileAsync('/bin/bash', [publisher, task, fixed, 'injected-session-123']);
  const testCommit = stdout.trim();
  assert.equal(await git(seed, '--git-dir', remote, 'rev-parse', `${testCommit}^`), bugBaseCommit);
  assert.equal(await git(seed, '--git-dir', remote, 'rev-parse', `${bugBaseCommit}^`), mainCommit);
});
