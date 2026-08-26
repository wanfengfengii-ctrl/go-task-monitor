import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyTrajectoryAttemptFailure, goldTestNamespace, isSystemTrajectoryFailure, repairGoldTestCollision } from './grader-guards.js';

test('gold test namespace is deterministic and unique per bug slot', () => {
  const first = goldTestNamespace(1, 'sample-bug-one');
  assert.match(first.prefix, /^TestGoldB1_[a-f0-9]{8}_$/);
  assert.deepEqual(first, goldTestNamespace(1, 'sample-bug-one'));
  assert.notEqual(first.prefix, goldTestNamespace(2, 'sample-bug-one').prefix);
  assert.notEqual(first.prefix, goldTestNamespace(1, 'sample-bug-two').prefix);
});

test('trajectory attempt failures distinguish system faults from model output', () => {
  assert.equal(classifyTrajectoryAttemptFailure('GRADER_COLLISION: TestOne redeclared'), 'grader_collision');
  assert.equal(classifyTrajectoryAttemptFailure('mutation-audit: 未记录 PostToolUse 审计快照'), 'audit_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Cannot connect to the Docker daemon'), 'docker_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('error waiting for container: unexpected EOF'), 'docker_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('failed to solve: unable to lease content: lease does not exist: not found'), 'docker_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Docker system-side acceptance failed; #2 resolve image config for docker-image://docker.io/docker/dockerfile:1.7; build 已超时'), 'docker_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure([
    'diagnosis target reproduced as expected on linux/arm64 (exit=1)',
    'grader_b3_b6d78e43_test.go:127: RegisterArtifact() error = <nil>',
    'FAILURE_CLASS=public_full',
  ].join('\n')), 'diagnosis_grader_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('/task-monitor/run_one_claude.sh: line 184: syntax error near unexpected token'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('/pipeline-jobs/job/artifacts/runner-snapshots/bug6-claude-attempt-1.sh: line 398: rg: command not found'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('/pipeline-jobs/job/artifacts/runner-snapshots/bug6-claude-attempt-1.sh: line 586: /Users/niuyuhang/Documents/New: Permission denied'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure([
    'Claude 修复失败（exit=2）：',
    'CLAUDE_PROGRESS',
    'awk: nonterminated character class (^|\\/)[^',
    ' source line number 2',
  ].join('\n')), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude 修复失败（exit=2）：\nrunner-snapshots/bug2.sh: line 297: syntax error near unexpected token'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude 修复失败（exit=none，signal=SIGTERM）：\n运行被调度器终止'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('人工停止（SIGINT），本次尝试已停止'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('trajectory already exists in /tmp/task/trajectory'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('bug_index must be an integer from 1 to 5'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude 修复失败（exit=75）：\nClaude task runner already active for /tmp/task (pid=67809)'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('rm: /tmp/go-task-git-publish.x/repository/api.go: Permission denied'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Connection closed by 198.18.0.15 port 22\nfatal: Could not read from remote repository.'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('fatal: Could not read from remote repository.\nPlease make sure you have the correct access rights'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly\nremote end hung up unexpectedly'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('/task-monitor/publish_test_model_fix.sh: line 60: 30003 Terminated: 15 git clone --quiet https://example.invalid/repo.git /tmp/repository'), 'git_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('green_branch must be bug1_green\nvalidated checkpoint Git publication failed (3/3)'), 'git_infrastructure');
  assert.equal(isSystemTrajectoryFailure('FAILURE_CLASS=git_publication'), true);
  assert.equal(classifyTrajectoryAttemptFailure("invalid_json_schema: Invalid schema for response_format 'codex_output_schema'"), 'codex_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('post-fix compile preflight failed (exit=1): go: go.mod requires go >= 1.25 (running go 1.23.4; GOTOOLCHAIN=local)'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('FAST_VERIFICATION_GATE: fixed Go 1.25.6 is not installed locally; refusing host toolchain auto-download'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude CLI: API Error: 504 {"type":"error","error":{"type":"server_error"}}'), 'model_gateway_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('{"type":"system","subtype":"api_retry","error_status":504,"error_type":"server_error"}'), 'model_gateway_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude stream guard reached (3 consecutive Claude API retries); terminating Session'), 'model_gateway_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('CLAUDE_CLI_EMPTY_FAILURE=1\nClaude CLI exited non-zero without a terminal result or stderr'), 'model_gateway_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude 修复失败（exit=1）：\nCLAUDE_PROGRESS\nCLAUDE_PROGRESS'), 'model_gateway_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('Claude 修复失败（exit=1）：\nCLAUDE_PROGRESS\ngo test failed'), 'model_attempt');
  assert.equal(isSystemTrajectoryFailure('Claude API gateway returned 504 server_error after retries'), true);
  assert.equal(classifyTrajectoryAttemptFailure('go test failed: expected HTTP 504 from the business service, got 500'), 'model_attempt');
  assert.equal(classifyTrajectoryAttemptFailure('go test failed: not enough arguments'), 'model_attempt');
});

test('live workspace snapshot races are runner infrastructure failures', () => {
  assert.equal(classifyTrajectoryAttemptFailure('连续 900 秒未产生真实文件进展，已提前终止'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('连续 20 分钟未产生子进程事件，已提前终止'), 'runner_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('运行超过 3600 秒总上限，已终止'), 'runner_infrastructure');
  assert.equal(isSystemTrajectoryFailure('连续 20 分钟未产生子进程事件，已提前终止'), true);
  assert.equal(isSystemTrajectoryFailure('运行超过 7200 秒总上限，已终止'), true);
  assert.equal(classifyTrajectoryAttemptFailure('/tmp/go-task-claude.ABC/workspace/vendor/foo.go: No such file or directory'), 'runner_infrastructure');
});

test('legacy macOS Docker grader failures do not consume Claude attempts', () => {
  assert.equal(classifyTrajectoryAttemptFailure('sed: 1: "s/^[[:space:]]*FROM/": RE error: repetition-operator operand invalid'), 'docker_infrastructure');
  assert.equal(classifyTrajectoryAttemptFailure('FAILURE_CLASS=docker_toolchain'), 'docker_infrastructure');
  assert.equal(isSystemTrajectoryFailure('FAILURE_CLASS=docker_toolchain'), true);
});

test('grader collision repair namespaces only the hidden target test', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grader-guard-'));
  const taskDir = path.join(root, 'task');
  const workspace = path.join(root, 'workspace');
  try {
    await mkdir(path.join(taskDir, 'grader/gold-tests/pkg'), { recursive: true });
    await mkdir(path.join(workspace, 'pkg'), { recursive: true });
    await writeFile(path.join(taskDir, 'public.json'), JSON.stringify({ bug_index: 1, bug_id: 'sample-bug' }));
    await writeFile(path.join(taskDir, 'grader/v4-context.json'), JSON.stringify({ gold_test_name: 'TestVisibleRegression' }));
    await writeFile(path.join(taskDir, 'grader/test-files.txt'), 'pkg/grader_test.go\n');
    await writeFile(path.join(taskDir, 'grader/gold-tests/pkg/grader_test.go'), 'package pkg\nfunc TestVisibleRegression(t *testing.T) {}\n');
    await writeFile(path.join(taskDir, 'grader/run_target.sh'), "go test ./pkg -run '^TestVisibleRegression$'\n");
    await chmod(path.join(taskDir, 'grader/run_target.sh'), 0o755);
    await writeFile(path.join(workspace, 'pkg/model_test.go'), 'package pkg\nfunc TestVisibleRegression(t *testing.T) {}\n');

    const result = await repairGoldTestCollision(taskDir, workspace);
    assert.equal(result.repaired, true);
    assert.match(result.testName, /^TestGoldB1_[a-f0-9]{8}_VisibleRegression$/);
    assert.match(await readFile(path.join(taskDir, 'grader/gold-tests/pkg/grader_test.go'), 'utf8'), new RegExp(`func ${result.testName}\\(`));
    assert.match(await readFile(path.join(taskDir, 'grader/run_target.sh'), 'utf8'), new RegExp(result.testName));
    assert.equal((await stat(path.join(taskDir, 'grader/run_target.sh'))).mode & 0o777, 0o755);
    assert.match(await readFile(path.join(taskDir, 'grader/v4-context.json'), 'utf8'), new RegExp(result.testName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
