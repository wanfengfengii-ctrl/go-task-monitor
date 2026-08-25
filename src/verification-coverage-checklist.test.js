import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildVerificationCoverageChecklist,
  formatVerificationCoverageChecklist,
  verificationCoverageChecklistIssues,
} from './verification-coverage-checklist.js';

const task = {
  userQuery: '预约后确认解冻或完成分装时，状态应依次为 reserved、thawed、aliquoting、depleted，终局 finalized 或 quarantined 保持原语义；重启后仍一致，并确保并发、幂等和事务回滚不受影响。',
  successCriteria: '所有生命周期边界和恢复读取均通过。',
};

const incompleteTest = `package aggregate_test
import "testing"
// TestModel_Lifecycle covers reserved, thawed, aliquoting, depleted, finalized,
// restart/reopen, concurrency, idempotency and rollback/checkpoint behavior.
func TestModel_Lifecycle(t *testing.T) {}
`;

async function runFastGateFixture({
  pristineValue = 1,
  workspaceValue = 2,
  command = "go test . -run '^TestModel_Value$' -count=1 -v",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-fast-gate-'));
  try {
    const pristine = path.join(root, 'pristine');
    const workspace = path.join(root, 'workspace');
    await mkdir(pristine, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const goMod = 'module example.test/fastgate\n\ngo 1.23\n';
    await writeFile(path.join(pristine, 'go.mod'), goMod);
    await writeFile(path.join(workspace, 'go.mod'), goMod);
    await writeFile(path.join(pristine, 'value.go'), `package fastgate\nfunc Value() int { return ${pristineValue} }\n`);
    await writeFile(path.join(workspace, 'value.go'), `package fastgate\nfunc Value() int { return ${workspaceValue} }\n`);
    await writeFile(path.join(workspace, 'value_model_test.go'), `package fastgate
import "testing"
func TestModel_Value(t *testing.T) { if Value() != 2 { t.Fatalf("got %d", Value()) } }
`);
    const preflightPath = path.join(root, 'preflight.json');
    await writeFile(preflightPath, `${JSON.stringify({ plan: {
      verify_cmds: [command],
      verification_test_files: ['value_model_test.go'],
    } })}\n`);
    const script = path.resolve(import.meta.dirname, '../scripts/run-model-verification-fast-gate.mjs');
    return spawnSync(process.execPath, [script, pristine, workspace, preflightPath], { encoding: 'utf8' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('builds an early checklist from explicit user-query lifecycle requirements', () => {
  const checklist = buildVerificationCoverageChecklist(task);
  const ids = checklist.entries.map((entry) => entry.id);
  for (const expected of ['status_reserved', 'status_thawed', 'status_aliquoting', 'status_depleted', 'status_finalized', 'status_quarantined', 'restart', 'idempotency', 'rollback']) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  assert.equal(ids.includes('concurrency'), false);
  assert.match(formatVerificationCoverageChecklist(checklist), /status_quarantined/);
});

test('keeps issue-specific concurrency scenarios in the hard preflight checklist', () => {
  const checklist = buildVerificationCoverageChecklist({
    userQuery: '两个 goroutine 并发提交同一修订时会发生丢更新，请补充可控交错测试并修复。',
  });
  assert.ok(checklist.entries.some((entry) => entry.id === 'concurrency' && entry.preflight));
  assert.deepEqual(
    verificationCoverageChecklistIssues(checklist, [{ path: 'internal/store/update_test.go', content: 'func TestModel_Update(t *testing.T) {}' }]),
    ['[concurrency] 并发/竞态行为'],
  );
});

test('success criteria can clarify but cannot add a hard checklist item', () => {
  const checklist = buildVerificationCoverageChecklist({
    userQuery: '未知龄期请求不应返回成功，请修复。',
    successCriteria: '还要验证重启、并发和完整正常流程。',
  });
  const ids = checklist.entries.map((entry) => entry.id);
  assert.equal(ids.includes('restart'), false);
  assert.equal(ids.includes('concurrency'), false);
  assert.equal(ids.includes('normal_path'), false);
  assert.ok(checklist.entries.every((entry) => entry.source === 'user_query'));
});

test('old checklists do not block on a generic concurrency preservation clause', () => {
  const oldChecklist = {
    user_query: '修复状态持久化问题，并确保并发访问不受影响。',
    entries: [{
      id: 'concurrency',
      label: '并发/竞态行为',
      source: 'user_query',
      requirement: '公开测试必须直接覆盖并发行为。',
      match_terms: ['并发', 'concurr'],
      preflight: true,
    }],
  };
  assert.deepEqual(verificationCoverageChecklistIssues(oldChecklist, []), []);
});

test('preflight flags an explicitly named terminal state missing from TestModel sources', () => {
  const checklist = buildVerificationCoverageChecklist(task);
  const missing = verificationCoverageChecklistIssues(checklist, [{ path: 'internal/aggregate/lifecycle_test.go', content: incompleteTest }]);
  assert.deepEqual(missing, ['[status_quarantined] quarantined/隔离终态']);

  const complete = incompleteTest.replace('finalized,', 'finalized, quarantined,');
  assert.deepEqual(verificationCoverageChecklistIssues(checklist, [{ path: 'internal/aggregate/lifecycle_test.go', content: complete }]), []);
});

test('model verification precheck fails before Docker and passes after the missing test evidence is added', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-precheck-'));
  try {
    const pristine = path.join(root, 'pristine');
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(pristine, 'internal/aggregate'), { recursive: true });
    await mkdir(path.join(workspace, 'internal/aggregate'), { recursive: true });
    const checklistPath = path.join(root, 'checklist.json');
    await writeFile(checklistPath, `${JSON.stringify(buildVerificationCoverageChecklist(task))}\n`);
    const testPath = path.join(workspace, 'internal/aggregate/lifecycle_test.go');
    await writeFile(testPath, incompleteTest);

    const script = path.resolve(import.meta.dirname, '../scripts/precheck-model-verification.mjs');
    const failed = spawnSync(process.execPath, [script, pristine, workspace, checklistPath], { encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /COVERAGE_PREFLIGHT.*quarantined/);

    await writeFile(testPath, incompleteTest.replace('finalized,', 'finalized, quarantined,'));
    const passed = spawnSync(process.execPath, [script, pristine, workspace, checklistPath], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model verification fast gate proves one red and one green before Docker', async () => {
  const result = await runFastGateFixture();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.notEqual(report.fast_gate.red_exit_code, 0);
  assert.equal(report.fast_gate.green_exit_code, 0);
  assert.equal(report.stability_gate, undefined);
});

test('model verification fast gate rejects a BUG_BASE that already passes', async () => {
  const result = await runFastGateFixture({ pristineValue: 2 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BUG_BASE fast red gate unexpectedly passed/);
});

test('model verification fast gate rejects a post-fix workspace that remains red', async () => {
  const result = await runFastGateFixture({ workspaceValue: 3 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /post-fix fast green gate failed/);
});

test('model verification fast gate requires the original count-one replay command', async () => {
  const result = await runFastGateFixture({ command: "go test . -run '^TestModel_Value$' -v" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /original -count=1 replay setting/);
});
