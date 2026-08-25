import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPlatformFields,
  findPlatformSubmissionByBugId,
  mergePlatformCookies,
  platformImportState,
  platformCsrfToken,
  platformSubmissionFingerprint,
  preparePlatformSubmission,
} from './submission-platform.js';

const mainSession = '11111111-1111-4111-8111-111111111111';
const record = {
  'session  id': mainSession,
  verification_policy_version: 5,
  bug_id: 'nyh-go-0300-bug-01',
  task_type: 'bugfix',
  bug_category: 'error',
  repo_url: 'https://github.com/example/nyh-go-0300/tree/bug-01/test_model_fix',
  go_version: 'go1.25.6; go.mod go 1.23',
  go_mod_version: '1.23',
  repro_determinism: '',
  user_query: '请修复空输入触发的异常，并补充回归测试。',
  trajectory: `https://upload.example.com/trajectory_${mainSession}.jsonl`,
  verify_cmds: "go test ./internal/sample -run '^TestRegression$' -count=1 -v",
  gold_root_cause: 'internal/sample/sample.go 中的 sample.Run 根本原因是空输入时直接访问索引，导致运行时 panic 并中断请求。',
  success_criteria: '空输入不再触发异常，定向测试、全量测试和静态检查均通过。',
  verify_result: {
    pre_fix: {
      trajectory_url: 'https://upload.example.com/trajectory_22222222-2222-4222-8222-222222222222.jsonl',
      session_id: '22222222-2222-4222-8222-222222222222',
      result: 'red',
    },
    post_fix: {
      trajectory_url: 'https://upload.example.com/trajectory_33333333-3333-4333-8333-333333333333.jsonl',
      session_id: '33333333-3333-4333-8333-333333333333',
      result: 'green',
    },
  },
  harness: 'backend=docker-target; isolation=workspace-without-.git; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code);',
  generator_model: '',
};

const schema = {
  data: {
    fields: [
      { field_key: 'bug_id', required: true },
      { field_key: 'session id', required: true },
      { field_key: 'task_type', required: true, options: ['bugfix', 'diagnosis'] },
      { field_key: 'bug_category', required: true, options: ['error异常错误', '其他问题'] },
      { field_key: 'repo_url', required: true },
      { field_key: 'go_version', required: true },
      { field_key: 'repro_determinism', required: true, options: ['deterministic', 'flaky'] },
      { field_key: 'user_query', required: true },
      { field_key: 'verify_cmds', required: true },
      { field_key: 'gold_root_cause', required: true },
      { field_key: 'success_criteria', required: true },
      { field_key: 'verify_result', required: true },
      { field_key: 'harness', required: true },
      { field_key: 'generator_model', required: true },
      { field_key: 'trajectory', required: true, field_type: 'file' },
    ],
  },
};

test('platform payload reuses strict export rules and maps whitespace aliases', () => {
  const submission = preparePlatformSubmission(record, schema);
  assert.equal(submission.data['session id'], mainSession);
  assert.equal(submission.data.bug_category, 'error异常错误');
  assert.equal(submission.data.repro_determinism, 'deterministic');
  assert.equal(submission.data.generator_model, 'model_hub/glm-52-coding');
  assert.equal(submission.trajectoryUrl, record.trajectory);
  assert.equal('trajectory' in submission.data, false);
});

test('platform payload stops when dynamic schema omits a system identity field', () => {
  const incomplete = { data: { fields: schema.data.fields.filter((field) => field.field_key !== 'repo_url') } };
  assert.throws(() => preparePlatformSubmission(record, incomplete), /动态表单缺少系统字段 repo_url/);
});

test('platform payload fingerprint is stable across object key order', () => {
  const first = platformSubmissionFingerprint({ data: { bug_id: 'bug-1', task_type: 'bugfix' }, trajectoryUrl: 'https://upload.example/one.jsonl' });
  const second = platformSubmissionFingerprint({ data: { task_type: 'bugfix', bug_id: 'bug-1' }, trajectoryUrl: 'https://upload.example/one.jsonl' });
  assert.equal(first, second);
});

test('platform cookies merge rotations and expose the CSRF token', () => {
  const merged = mergePlatformCookies('session=old; keep=yes', [
    'session=new; Path=/; HttpOnly',
    'go_qa_csrf=token%2Fvalue; Path=/',
  ]);
  assert.equal(merged, 'session=new; keep=yes; go_qa_csrf=token%2Fvalue');
  assert.equal(platformCsrfToken(merged), 'token/value');
});

test('platform response helpers accept nested API envelopes', () => {
  assert.equal(extractPlatformFields(schema).length, schema.data.fields.length);
  const found = findPlatformSubmissionByBugId({ data: { items: [{ id: 'submission-1', data: { bug_id: record.bug_id } }] } }, record.bug_id);
  assert.equal(found.id, 'submission-1');
});

test('platform import state is imported only after a confirmed submission', () => {
  assert.deepEqual(platformImportState(null), {
    submissionPlatformImported: false,
    submissionPlatformImportStatus: 'not_imported',
    submissionPlatformStatus: 'not_submitted',
    submissionPlatformSubmissionId: '',
    submissionPlatformSubmittedAt: null,
    submissionPlatformUrl: '',
    submissionPlatformError: '',
  });
  assert.deepEqual(platformImportState({
    status: 'submitted',
    platformSubmissionId: 'submission-1',
    submittedAt: '2026-08-25T06:00:00.000Z',
    platformUrl: 'https://go.jzxhnh.com/u/submissions',
  }), {
    submissionPlatformImported: true,
    submissionPlatformImportStatus: 'imported',
    submissionPlatformStatus: 'submitted',
    submissionPlatformSubmissionId: 'submission-1',
    submissionPlatformSubmittedAt: '2026-08-25T06:00:00.000Z',
    submissionPlatformUrl: 'https://go.jzxhnh.com/u/submissions',
    submissionPlatformError: '',
  });
  assert.equal(platformImportState({ status: 'failed', error: 'HTTP 503' }).submissionPlatformImported, false);
});
