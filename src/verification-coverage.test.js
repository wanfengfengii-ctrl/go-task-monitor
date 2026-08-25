import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertVerificationCoverage,
  createVerificationCoverageAttestation,
  verificationCoverageAttestationIssues,
  verificationCoverageHashes,
} from './verification-coverage.js';

const verifyCmds = ["go test ./internal/sample -run '^TestRegression$' -count=1 -v"];
const goldTests = [{
  path: 'internal/sample/regression_test.go',
  content: `package sample_test
func TestRegression(t *testing.T) {
  t.Run("rejects empty input", func(t *testing.T) { if Run("") == nil { t.Fatal("want error") } })
  t.Run("keeps valid input", func(t *testing.T) { if Run("ok") != nil { t.Fatal("want success") } })
}
`,
}];
const report = {
  approved: true,
  summary: '目标测试覆盖空输入拒绝、状态保护和正常输入不回归。',
  test_names: ['TestRegression'],
  test_files: ['internal/sample/regression_test.go'],
  requirements: [
    {
      source: 'user_query',
      category: 'target_behavior',
      requirement: '空输入必须返回错误且不得改变状态',
      status: 'covered',
      evidence: 'internal/sample/regression_test.go TestRegression/rejects empty input 断言错误结果。',
    },
    {
      source: 'success_criteria',
      category: 'target_behavior',
      requirement: '合法输入必须保持成功行为',
      status: 'covered',
      evidence: 'internal/sample/regression_test.go TestRegression/keeps valid input 断言成功结果。',
    },
    {
      source: 'both',
      category: 'process_constraint',
      requirement: '全量测试与静态检查必须通过',
      status: 'covered',
      evidence: '系统 Gold 红绿验收阶段执行全量测试和 go vet。',
    },
  ],
  issues: [],
};

function metadata(attestation) {
  return {
    bug_id: 'sample-bug',
    verification_coverage_policy_version: 2,
    user_query: '请修复空输入错误，并保持合法输入行为。',
    success_criteria: '空输入失败且状态不变；合法输入继续成功；全量测试通过。',
    verify_cmds: verifyCmds,
    verification_coverage: attestation,
  };
}

test('coverage attestation binds query, criteria, command and exact Gold tests', () => {
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report,
    reviewerSessionId: '11111111-1111-4111-8111-111111111111',
  });
  assert.deepEqual(assertVerificationCoverage(metadata(value), { goldTests, report }), value);
  assert.deepEqual(
    Object.keys(verificationCoverageHashes({
      userQuery: metadata().user_query,
      successCriteria: metadata().success_criteria,
      verifyCmds,
      goldTests,
    })).sort(),
    ['model_tests_sha256', 'success_criteria_sha256', 'user_query_sha256', 'verify_cmds_sha256'],
  );
});

test('diagnosis public commands use the reported repository test names as their semantic oracle', () => {
  const diagnosisCmds = ['go run ./cmd/sample -h'];
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds: diagnosisCmds,
    goldTests,
    report,
  });
  assert.deepEqual(value.test_names, ['TestRegression']);
  assert.deepEqual(assertVerificationCoverage({
    ...metadata(value),
    verify_cmds: diagnosisCmds,
  }, { goldTests, report }), value);
});

test('coverage collects targeted test names from all verify commands', () => {
  const multiTests = [{
    path: 'internal/sample/regression_test.go',
    content: `${goldTests[0].content}\nfunc TestRetainedBehavior(t *testing.T) {}\n`,
  }];
  const multiCommands = [
    "go test ./internal/sample -run '^TestRegression$' -count=1 -v",
    "go test ./internal/sample -run '^TestRetainedBehavior$' -count=1 -v",
  ];
  const multiReport = structuredClone(report);
  multiReport.test_names = ['TestRegression', 'TestRetainedBehavior'];
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds: multiCommands,
    goldTests: multiTests,
    report: multiReport,
  });
  assert.deepEqual(value.test_names, ['TestRegression', 'TestRetainedBehavior']);
});

test('coverage gate rejects an uncovered user-query behavior', () => {
  const incomplete = structuredClone(report);
  incomplete.approved = false;
  incomplete.requirements[1].status = 'not_covered';
  incomplete.issues.push({ message: '合法输入正常路径没有断言' });
  assert.throws(
    () => createVerificationCoverageAttestation({
      userQuery: metadata().user_query,
      successCriteria: metadata().success_criteria,
      verifyCmds,
      goldTests,
      report: incomplete,
    }),
    /未完整覆盖题面/,
  );
});

test('structured contract levels keep supplemental review findings non-blocking', () => {
  const supplemental = structuredClone(report);
  supplemental.approved = false;
  supplemental.requirements.push({
    source: 'success_criteria',
    category: 'target_behavior',
    contract_level: 'supplemental',
    requirement: '验证额外的历史兼容模式仍然成功',
    status: 'not_covered',
    evidence: 'internal/sample/regression_test.go 未包含该补充场景。',
  });
  supplemental.issues.push({
    category: 'target_behavior',
    contract_level: 'supplemental',
    message: 'An optional compatibility scenario is not repeated.',
    evidence: 'No compatibility subtest.',
  });
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report: supplemental,
  });
  assert.equal(value.approved, true);
});

test('structured hard findings remain blocking even when their text resembles an optional expansion', () => {
  const hard = structuredClone(report);
  hard.requirements.push({
    source: 'user_query',
    category: 'target_behavior',
    contract_level: 'hard',
    requirement: '所有目录字段变化均必须被拒绝',
    status: 'not_covered',
    evidence: 'internal/sample/regression_test.go 只覆盖空输入，没有目录字段变化断言。',
  });
  assert.throws(() => createVerificationCoverageAttestation({
    userQuery: '所有目录字段变化均必须被拒绝。',
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report: hard,
  }), /未完整覆盖题面/);
});

test('generic concurrency preservation clauses are non-blocking even when the reviewer marks them hard', () => {
  const preservation = structuredClone(report);
  preservation.approved = false;
  preservation.requirements.push({
    source: 'user_query',
    category: 'target_behavior',
    contract_level: 'hard',
    requirement: 'Concurrency behavior must remain unaffected by the status synchronization fix.',
    status: 'not_covered',
    evidence: 'No focused public test starts concurrent operations.',
  });
  preservation.issues.push({
    category: 'target_behavior',
    contract_level: 'hard',
    message: 'The user explicitly requires concurrency behavior to remain unaffected, but the focused public regression tests contain no concurrent-operation scenario.',
    evidence: 'The focused tests execute service operations sequentially.',
  });
  const value = createVerificationCoverageAttestation({
    userQuery: '请修复母管状态持久化问题，并确保并发、幂等和事务回滚不受影响。',
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report: preservation,
  });
  assert.equal(value.approved, true);
});

test('an uncovered concurrency trigger remains blocking', () => {
  const concurrency = structuredClone(report);
  concurrency.approved = false;
  concurrency.requirements.push({
    source: 'user_query',
    category: 'target_behavior',
    contract_level: 'hard',
    requirement: '两个 goroutine 并发提交相同修订会发生丢更新，必须只提交其中一个结果。',
    status: 'not_covered',
    evidence: 'internal/sample/regression_test.go 仅顺序调用，没有并发交错断言。',
  });
  concurrency.issues.push({
    category: 'target_behavior',
    contract_level: 'hard',
    message: 'The focused tests do not reproduce the two-goroutine lost-update interleaving.',
    evidence: 'No concurrent operations are started.',
  });
  assert.throws(() => createVerificationCoverageAttestation({
    userQuery: '两个 goroutine 并发提交相同修订会发生丢更新，请修复并补充可控交错测试。',
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report: concurrency,
  }), /未完整覆盖题面/);
});

test('coverage gate ignores process-only review gaps from the read-only auditor', () => {
  const processOnly = structuredClone(report);
  processOnly.approved = false;
  processOnly.requirements[2].status = 'not_covered';
  processOnly.issues.push({
    category: 'process_constraint',
    message: '只读复核环境无法创建 Go 临时构建目录',
    evidence: 'review sandbox',
  });
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report: processOnly,
  });
  assert.equal(value.approved, true);
});

test('coverage accepts representative permutations without a Cartesian product of assertions', () => {
  const representative = structuredClone(report);
  representative.approved = false;
  representative.requirements.push(
    {
      source: 'both',
      category: 'target_behavior',
      requirement: '每一种等价 children 排列都重复断言完整返回载荷和全部持久化字段',
      status: 'not_covered',
      evidence: 'internal/sample/regression_test.go TestRegression 已遍历代表性排列，完整状态断言由共享子测试验证。',
    },
    {
      source: 'success_criteria',
      category: 'target_behavior',
      requirement: '每个目录字段差异都分别重复冲突和无写入断言',
      status: 'not_covered',
      evidence: 'internal/sample/regression_test.go TestRegression 已覆盖字段差异等价类。',
    },
  );
  representative.issues.push(
    {
      category: 'target_behavior',
      message: 'The requirement that every semantically equivalent children permutation replay the complete original success result is not fully asserted.',
      evidence: 'Only one permutation repeats every returned-field assertion.',
    },
    {
      category: 'target_behavior',
      message: 'Coverage does not establish the required conflict behavior for every catalog field that can differ.',
      evidence: 'Representative catalog fields are covered.',
    },
  );
  const value = createVerificationCoverageAttestation({
    userQuery: '调整 children 数组排列时应重放原结果，真正内容变化仍冲突且不产生新写入。',
    successCriteria: '所有等价排列均应重放，所有目录字段变化均应冲突。',
    verifyCmds,
    goldTests,
    report: representative,
  });
  assert.equal(value.approved, true);
});

test('coverage does not make success-criteria-only normal flow a hard task failure', () => {
  const supplemental = structuredClone(report);
  supplemental.approved = false;
  supplemental.requirements.push(
    {
      source: 'success_criteria',
      category: 'target_behavior',
      requirement: '正常完整流程必须额外执行到最终完成状态',
      status: 'not_covered',
      evidence: 'internal/sample/regression_test.go 当前目标测试验证修复边界，但没有重复整条正常完整流程。',
    },
    {
      source: 'success_criteria',
      category: 'target_behavior',
      requirement: '未预留窗口时必须额外证明租约和占用均为空',
      status: 'not_covered',
      evidence: 'internal/sample/regression_test.go 当前目标测试覆盖已持有租约后的释放边界。',
    },
  );
  supplemental.issues.push(
    {
      category: 'target_behavior',
      message: 'The success criterion requiring the normal complete flow is not covered by the listed public regression tests.',
      evidence: 'No end-to-end completion subtest.',
    },
    {
      category: 'target_behavior',
      message: 'The required release-nothing boundary before a window is reserved is not concretely verified.',
      evidence: 'No pre-window lease query.',
    },
  );
  const value = createVerificationCoverageAttestation({
    userQuery: '取消已经排程并持有窗口租约的请求后，应立即释放资源，并验证重新排程和重启行为。',
    successCriteria: '另需验证正常完整流程以及未预留窗口时释放为空。',
    verifyCmds,
    goldTests,
    report: supplemental,
  });
  assert.equal(value.approved, true);
});

test('coverage gate invalidates attestation after query, command or Gold test mutation', () => {
  const value = createVerificationCoverageAttestation({
    userQuery: metadata().user_query,
    successCriteria: metadata().success_criteria,
    verifyCmds,
    goldTests,
    report,
  });
  assert.match(
    verificationCoverageAttestationIssues({ ...metadata(value), user_query: '新的题面行为' }, { goldTests, report }).join(';'),
    /user_query_sha256/,
  );
  assert.match(
    verificationCoverageAttestationIssues(metadata(value), {
      goldTests: [{ ...goldTests[0], content: `${goldTests[0].content}\n// changed\n` }],
      report,
    }).join(';'),
    /model_tests_sha256/,
  );
});

test('legacy tasks without coverage policy remain exportable by the legacy path', () => {
  assert.deepEqual(verificationCoverageAttestationIssues({ verification_coverage_policy_version: 0 }), []);
});
