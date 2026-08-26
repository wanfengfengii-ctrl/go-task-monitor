import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVerificationExportMetadata, verificationExportMetadataIssues } from './verification-export-rules.js';
import { directPublicVerifyCommandIssues, isConcurrencyVerificationRecord, verificationCommandsSha256 } from './verification-proof.js';

const commands = [
  "go test ./internal/sample -run '^TestRegression$' -count=1 -v",
];
const commandsSha256 = verificationCommandsSha256(commands);

function proof(phase, sessionId, result) {
  return {
    trajectory_url: `https://cos.example.test/trajectory_${sessionId}.jsonl`,
    session_id: sessionId,
    result,
    verify_cmds_sha256: commandsSha256,
    local_manifest: `verification/${phase}/attempt-1/manifest.json`,
  };
}

function metadata(overrides = {}) {
  const preFix = proof('pre_fix', '11111111-1111-4111-8111-111111111111', 'red');
  const postFix = proof('post_fix', '22222222-2222-4222-8222-222222222222', 'green');
  return {
    bug_id: 'sample-bug-01',
    task_type: 'bugfix',
    verification_policy_version: 5,
    test_model_fix_session_id: '33333333-3333-4333-8333-333333333333',
    verify_cmds: commands,
    verification_evidence: { pre_fix: preFix, post_fix: postFix },
    verify_result: JSON.stringify({
      pre_fix: {
        trajectory_url: preFix.trajectory_url,
        session_id: preFix.session_id,
        result: preFix.result,
      },
      post_fix: {
        trajectory_url: postFix.trajectory_url,
        session_id: postFix.session_id,
        result: postFix.result,
      },
    }),
    ...overrides,
  };
}

test('V5 Excel metadata binds the untouched command array to both bugfix proofs', () => {
  const checked = assertVerificationExportMetadata(metadata(), { aggregatedVerifyCmds: commands });
  assert.deepEqual(checked.phases, ['pre_fix', 'post_fix']);
  assert.equal(checked.verifyCmdsSha256, commandsSha256);
});

test('concurrency export requires race repeats and a documented deterministic strategy', () => {
  const raceCommands = [
    "go test -race ./internal/sample -run '^TestRegression$' -count=20 -v",
  ];
  const value = metadata({
    bug_category: 'concurrency',
    verify_cmds: raceCommands,
    success_criteria: "确定性复现策略使用同步屏障固定协程起跑顺序，并通过 go test -race ./internal/sample -run '^TestRegression$' -count=20 -v 卡住稳定性下限。",
  });
  const hash = verificationCommandsSha256(raceCommands);
  value.verification_evidence.pre_fix.verify_cmds_sha256 = hash;
  value.verification_evidence.post_fix.verify_cmds_sha256 = hash;
  assert.deepEqual(verificationExportMetadataIssues(value).issues, []);

  const weak = metadata({
    bug_category: 'concurrency',
    success_criteria: '并发功能需要通过。',
  });
  const issues = verificationExportMetadataIssues(weak).issues.join(';');
  assert.match(issues, /-race/);
  assert.match(issues, /确定性复现策略/);
  assert.match(issues, /go test -race -count=N/);
});

test('diagnosis Excel metadata requires only the pre-fix proof', () => {
  const value = metadata({ task_type: 'diagnosis' });
  delete value.verification_evidence.post_fix;
  const parsed = JSON.parse(value.verify_result);
  delete parsed.post_fix;
  value.verify_result = JSON.stringify(parsed);
  assert.deepEqual(assertVerificationExportMetadata(value).phases, ['pre_fix']);
});

test('diagnosis Excel metadata blocks the private fixture intermediate state until Git publication', () => {
  const value = metadata({
    task_type: 'diagnosis',
    verification_test_overlay: 'private-fixture',
    verification_test_files: ['internal/sample/model_diagnosis_test.go'],
    verification_fixture_sha256: 'a'.repeat(64),
    verification_fixture_materialized: false,
    verification_fixture_published: false,
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: true,
  });
  delete value.verification_evidence.post_fix;
  const parsed = JSON.parse(value.verify_result);
  delete parsed.post_fix;
  value.verify_result = JSON.stringify(parsed);
  assert.match(verificationExportMetadataIssues(value).issues.join(';'), /中间态.*发布到 red 分支/);

  value.verification_test_overlay = 'repository-tests';
  value.verification_fixture_published = true;
  value.verification_test_published = true;
  value.verification_test_storage = 'repository-red-branch';
  assert.deepEqual(assertVerificationExportMetadata(value).phases, ['pre_fix']);
});

test('historical diagnosis evidence with MODEL_REPRO exports using the canonical command', () => {
  const raw = ["MODEL_REPRO=1 go test ./internal/sample -run '^TestRegression$' -count=1 -v"];
  const canonical = ["go test ./internal/sample -run '^TestRegression$' -count=1 -v"];
  const value = metadata({
    task_type: 'diagnosis',
    verify_cmds: raw,
    verification_evidence: {
      pre_fix: proof('pre_fix', '11111111-1111-4111-8111-111111111111', 'red'),
    },
  });
  value.verification_evidence.pre_fix.verify_cmds_sha256 = verificationCommandsSha256(raw);
  const parsed = JSON.parse(value.verify_result);
  delete parsed.post_fix;
  value.verify_result = JSON.stringify(parsed);
  const checked = assertVerificationExportMetadata(value, { aggregatedVerifyCmds: canonical });
  assert.equal(checked.verifyCmdsSha256, verificationCommandsSha256(canonical));
});

test('Excel metadata rejects pre-V5 tasks and commands containing undefined', () => {
  assert.throws(
    () => assertVerificationExportMetadata(metadata({ verification_policy_version: 4 })),
    /sample-bug-01[\s\S]*旧任务没有可核验的独立红绿证明/,
  );
  const invalidCommands = [...commands, "go test undefined -run '^undefined$'"];
  const result = verificationExportMetadataIssues(metadata({ verify_cmds: invalidCommands }));
  assert.match(result.issues.join(';'), /完整单词 undefined/);
});

test('Excel metadata rejects broad tests and wrapper commands', () => {
  assert.match(
    verificationExportMetadataIssues(metadata({ verify_cmds: ['go test ./... -count=1'] })).issues.join(';'),
    /至少包含一条目标 Bug 复现命令/,
  );
  assert.match(
    verificationExportMetadataIssues(metadata({ verify_cmds: ['./verify_cmds.sh pre_fix'] })).issues.join(';'),
    /定向 go test|包装脚本/,
  );
  assert.match(
    directPublicVerifyCommandIssues(["go test ./... -run '^TestRegression$' -count=1"], 'bugfix').join(';'),
    /必须明确写出目标包/,
  );
});

test('V5 rejects grader-only verification test overlays', () => {
  const result = verificationExportMetadataIssues(metadata({
    verification_test_overlay: 'gold-tests',
    verification_test_files: ['internal/sample_regression_test.go'],
  }));
  assert.match(result.issues.join(';'), /不能只存在于 grader 覆盖层/);
});

test('direct verification allows regex alternation inside a quoted -run value', () => {
  assert.deepEqual(directPublicVerifyCommandIssues([
    "go test ./internal/service -run '^(TestRollback|TestRetry)$' -count=1 -v",
  ]), []);
  assert.match(
    directPublicVerifyCommandIssues(["go test ./internal/service -run '^TestRollback$' -count=1 | tee result.log"]).join(';'),
    /管道/,
  );
});

test('version and idempotency prose does not make a record a concurrency task', () => {
  const record = {
    bug_category: 'error',
    runtime_mechanisms: ['state_machine_transition', 'idempotency_or_duplicate_delivery'],
    failure_mechanism: '旧版本请求跨过并发控制边界并推进状态。',
  };
  assert.equal(isConcurrencyVerificationRecord(record), false);
  assert.deepEqual(directPublicVerifyCommandIssues([
    "go test ./internal/service -run '^TestInstrumentRetrySequence$' -count=1",
  ], 'diagnosis', { concurrency: isConcurrencyVerificationRecord(record) }), []);
  assert.equal(isConcurrencyVerificationRecord({
    ...record,
    runtime_mechanisms: [...record.runtime_mechanisms, 'concurrency_race'],
  }), true);
});

test('diagnosis accepts a direct targeted test or real public go run command', () => {
  assert.deepEqual(directPublicVerifyCommandIssues([
    "go test ./cmd/server -run '^TestCLIHelp$' -count=1 -v",
  ], 'diagnosis'), []);
  assert.deepEqual(directPublicVerifyCommandIssues(['go run ./cmd/server -h'], 'diagnosis'), []);
  assert.match(
    directPublicVerifyCommandIssues(["MODEL_REPRO=1 go test ./cmd/server -run '^TestCLIHelp$' -count=1 -v"], 'diagnosis').join(';'),
    /MODEL_REPRO/,
  );
  assert.match(directPublicVerifyCommandIssues(['go run ./cmd/server -h'], 'bugfix').join(';'), /只允许用于 diagnosis/);
});

test('diagnosis rejects prose HTTP/API instructions as public commands', () => {
  assert.match(
    directPublicVerifyCommandIssues(['POST `/v1/tasks/{id}/lock` 两次'], 'diagnosis').join(';'),
    /HTTP\/API 操作说明/,
  );
  assert.match(
    directPublicVerifyCommandIssues(['HTTP 场景：完成 POST /v1/tasks/{id}/lock'], 'diagnosis').join(';'),
    /场景说明当作命令/,
  );
  assert.match(
    directPublicVerifyCommandIssues(['httptest 场景：对 POST /tasks 连续提交相同 JSON'], 'diagnosis').join(';'),
    /场景说明当作命令/,
  );
  assert.match(
    directPublicVerifyCommandIssues(['With a short configured lease TTL, reopen the DSN and inspect the lease state'], 'diagnosis').join(';'),
    /英文操作步骤当作命令/,
  );
  assert.match(
    directPublicVerifyCommandIssues(['Inject one seam, submit a valid reading, then inspect the result'], 'diagnosis').join(';'),
    /英文操作步骤当作命令/,
  );
});

test('direct verification accepts multiple commands and safe Docker commands without wrappers', () => {
  assert.deepEqual(directPublicVerifyCommandIssues([
    "go test ./internal/service -run '^TestRollback$' -count=1 -v",
    'go test ./... -count=1',
    'go vet ./...',
  ], 'bugfix'), []);
  assert.deepEqual(directPublicVerifyCommandIssues([
    'docker build --platform linux/amd64 -f benzhi.Dockerfile -t sample .',
    `docker run --rm --network none --platform linux/amd64 -v "$(pwd):/workspace:ro" -w /workspace sample bash -c 'GOTOOLCHAIN=local go run ./cmd/server -h'`,
    'docker image rm -f sample',
  ], 'diagnosis'), []);
  assert.match(
    directPublicVerifyCommandIssues([
      'docker build --platform linux/amd64 -f workspace/benzhi.Dockerfile -t sample workspace',
      'docker run --rm --network none sample /grader/run_target.sh /app',
    ], 'diagnosis').join(';'),
    /包装脚本/,
  );
  assert.match(
    directPublicVerifyCommandIssues([
      `docker run --rm --network none sample bash -c "go test ./internal/sample -run '^TestRegression$' -count=1; echo masked"`,
    ], 'bugfix').join(';'),
    /只能执行一条直接命令/,
  );
});

test('Excel metadata rejects aggregate mutation and stale evidence hashes', () => {
  assert.match(
    verificationExportMetadataIssues(metadata(), { aggregatedVerifyCmds: [...commands, 'go test ./...'] }).issues.join(';'),
    /任务聚合后的 verify_cmds 与 public.json 原始命令数组不一致/,
  );
  const value = metadata();
  value.verification_evidence.post_fix.verify_cmds_sha256 = '0'.repeat(64);
  assert.match(
    verificationExportMetadataIssues(value).issues.join(';'),
    /post_fix evidence 未绑定 public.json.verify_cmds/,
  );
});

test('bugfix Excel metadata rejects a missing post-fix proof', () => {
  const value = metadata();
  delete value.verification_evidence.post_fix;
  assert.match(verificationExportMetadataIssues(value).issues.join(';'), /post_fix 缺少本地证明 manifest/);
});
