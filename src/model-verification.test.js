import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertModelVerificationPlan,
  buildModelVerificationPlan,
  isTableDrivenGoTest,
  modelVerificationPlanIssues,
  verificationTestNamesFromCommand,
  verificationTestPackage,
} from './model-verification.js';

const sources = [
  {
    path: 'internal/sample/model_regression_test.go',
    content: `package sample
import "testing"
func TestModel_RejectsEmpty(t *testing.T) {}
func TestModel_KeepsValid(t *testing.T) {}
`,
  },
];

test('builds one direct command from public model regression tests', () => {
  const plan = buildModelVerificationPlan(sources);
  assert.deepEqual(plan.verify_cmds, ["go test ./internal/sample -run '^(TestModel_KeepsValid|TestModel_RejectsEmpty)$' -count=1 -v"]);
  assert.deepEqual(verificationTestNamesFromCommand(plan.verify_cmds[0]), ['TestModel_KeepsValid', 'TestModel_RejectsEmpty']);
  assert.deepEqual(assertModelVerificationPlan({ ...plan, model_verification_policy_version: 1 }, sources), { ...plan, model_verification_policy_version: 1 });
});

test('concurrency verification always uses the race detector and a stable repeat floor', () => {
  const plan = buildModelVerificationPlan(sources, { concurrency: true });
  assert.deepEqual(plan.verify_cmds, ["go test -race ./internal/sample -run '^(TestModel_KeepsValid|TestModel_RejectsEmpty)$' -count=20 -v"]);
  assert.equal(plan.concurrency_verification, true);
  assert.equal(plan.verification_repeat_count, 20);
  assert.deepEqual(modelVerificationPlanIssues({
    ...plan,
    model_verification_policy_version: 1,
  }, sources, { concurrency: true }), []);

  const issues = modelVerificationPlanIssues({
    ...plan,
    verify_cmds: ["go test ./internal/sample -run '^(TestModel_KeepsValid|TestModel_RejectsEmpty)$' -count=1 -v"],
    model_verification_policy_version: 1,
  }, sources, { concurrency: true }).join(';');
  assert.match(issues, /-race/);
  assert.match(issues, /-count=N/);
});

test('rejects hidden-only or stale test names', () => {
  const plan = buildModelVerificationPlan(sources);
  plan.verification_test_names = ['TestModel_HiddenOnly'];
  assert.match(modelVerificationPlanIssues({ ...plan, model_verification_policy_version: 1 }, sources).join(';'), /测试名称|不在公开模型/);
});

test('requires the stable public model test prefix', () => {
  assert.throws(() => buildModelVerificationPlan([{ path: 'sample_test.go', content: 'package sample\nfunc TestRegression(t *testing.T) {}\n' }]), /TestModel_/);
});

test('recognizes table-driven tests that use named case structs', () => {
  const namedCases = `package sample
import "testing"
func TestModel_NamedCases(t *testing.T) {
  type testCase struct { name string }
  tests := []testCase{{name: "first"}}
  for _, tt := range tests { t.Run(tt.name, func(t *testing.T) {}) }
}`;
  assert.equal(isTableDrivenGoTest(namedCases), true);
  assert.equal(isTableDrivenGoTest('func TestModel_One(t *testing.T) { t.Run("one", func(t *testing.T) {}) }'), false);
});

test('derives the Go package from a nested test file instead of trusting a model placeholder', () => {
  assert.equal(verificationTestPackage('cmd/torquechain/main_restart_test.go'), './cmd/torquechain');
  assert.equal(verificationTestPackage('internal/ledger/model_claim_test.go'), './internal/ledger');
  assert.equal(verificationTestPackage('root_model_test.go'), '.');
  const plan = buildModelVerificationPlan([{
    path: 'cmd/torquechain/main_restart_test.go',
    content: 'package main\nimport "testing"\nfunc TestModel_Restart(t *testing.T) {}\n',
  }]);
  assert.equal(plan.verify_cmds[0], "go test ./cmd/torquechain -run '^TestModel_Restart$' -count=1 -v");
  assert.match(
    modelVerificationPlanIssues({ ...plan, verify_cmds: ["go test . -run '^TestModel_Restart$' -count=1 -v"] }, [{
      path: 'cmd/torquechain/main_restart_test.go',
      content: 'package main\nimport "testing"\nfunc TestModel_Restart(t *testing.T) {}\n',
    }]).join(';'),
    /Go 包与测试文件路径不一致/,
  );
});
