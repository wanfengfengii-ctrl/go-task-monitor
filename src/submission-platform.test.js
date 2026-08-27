import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlatformReviewSnapshot,
  buildSubmissionActivityStats,
  extractPlatformFields,
  extractPlatformSubmissionTotal,
  findPlatformSubmissionByBugId,
  findPlatformSubmissionForRecord,
  deferredPlatformBugIndexes,
  isLegacyDeliveredPlatformBackfill,
  isSubmissionPlatformUnavailableError,
  isReadmeOnlyPlatformRepairReason,
  reopenDeferredPlatformSubmissions,
  mergePlatformSubmissionReview,
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
  repo_url: 'https://github.com/example/nyh-go-0300/tree/bug1_green',
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

test('platform payload maps an underscored session field to the canonical Excel session', () => {
  const underscored = {
    data: {
      fields: schema.data.fields.map((field) => field.field_key === 'session id'
        ? { ...field, field_key: 'session_id' }
        : field),
    },
  };
  const submission = preparePlatformSubmission({ ...record, 'session  id': '', sessionId: mainSession }, underscored);
  assert.equal(submission.data.session_id, mainSession);
});

test('legacy platform backfill accepts only an immutable delivered checkpoint', () => {
  const legacyJob = {
    submissionPlatformPolicyVersion: 0,
    bugs: [{ bugIndex: 4, disposition: 'delivered' }],
    stages: [{ id: 'bug4_delivery_ready', status: 'passed' }],
  };
  assert.equal(isLegacyDeliveredPlatformBackfill(legacyJob, 4), true);
  assert.equal(isLegacyDeliveredPlatformBackfill({ ...legacyJob, submissionPlatformPolicyVersion: 1 }, 4), false);
  assert.equal(isLegacyDeliveredPlatformBackfill({
    ...legacyJob,
    bugs: [{ bugIndex: 4, disposition: 'failed' }],
  }, 4), false);
  assert.equal(isLegacyDeliveredPlatformBackfill({ ...legacyJob, stages: [] }, 4), false);
});

test('platform outage detection defers connectivity failures but not invalid task data', () => {
  assert.equal(isSubmissionPlatformUnavailableError('质检提交平台维护中，等待统一补交'), true);
  assert.equal(isSubmissionPlatformUnavailableError('提交平台返回 HTTP 503'), true);
  assert.equal(isSubmissionPlatformUnavailableError('请在任务系统中连接一次提交平台以启用自动登录'), true);
  assert.equal(isSubmissionPlatformUnavailableError('提交平台必填字段 user_query 缺失'), false);
  assert.equal(isSubmissionPlatformUnavailableError('题目难度不达标'), false);
});

test('deferred platform submissions reopen only the platform delivery tail', () => {
  const job = {
    id: 'pipeline-test',
    status: 'passed',
    repositoryDisposition: 'delivered',
    finishedAt: '2026-08-27T08:00:00.000Z',
    bugExecution: { mode: 'workbench', status: 'fast_lane_completed' },
    pendingBugRetries: [4],
    bugs: [{
      bugIndex: 2,
      disposition: 'delivered',
      deliveredAt: '2026-08-27T08:00:00.000Z',
      workerExecution: { status: 'fast_lane_completed', currentStage: '' },
    }],
    stages: [
      { id: 'bug2_verification_finalize', stage: 'verification_finalize', bugIndex: 2, status: 'passed' },
      {
        id: 'bug2_platform_submit',
        stage: 'platform_submit',
        bugIndex: 2,
        status: 'skipped',
        deferred: true,
        deferredAt: '2026-08-27T08:00:00.000Z',
        result: { deferred: true },
      },
      { id: 'bug2_delivery_ready', stage: 'delivery_ready', bugIndex: 2, status: 'passed', result: { taskId: 'task-2' } },
    ],
  };
  assert.deepEqual(deferredPlatformBugIndexes(job), [2]);
  const reopened = reopenDeferredPlatformSubmissions(job, '2026-08-27T09:00:00.000Z');
  assert.equal(reopened.changed, true);
  assert.deepEqual(reopened.bugIndexes, [2]);
  assert.deepEqual(reopened.job.pendingBugRetries, [2, 4]);
  assert.equal(reopened.job.currentStage, 'bug2_platform_submit');
  assert.equal(reopened.job.stages[0].status, 'passed');
  assert.equal(reopened.job.stages[1].status, 'pending');
  assert.equal(reopened.job.stages[1].deferred, undefined);
  assert.equal(reopened.job.stages[2].status, 'pending');
  assert.equal(reopened.job.bugs[0].disposition, undefined);
  assert.equal(reopened.job.bugs[0].workerExecution.lastAction, 'platform_backfill_queued');
});

test('platform payload stops when dynamic schema omits a system identity field', () => {
  const incomplete = { data: { fields: schema.data.fields.filter((field) => field.field_key !== 'repo_url') } };
  assert.throws(() => preparePlatformSubmission(record, incomplete), /动态表单缺少系统字段 repo_url/);
});

test('platform payload rejects branches without an explicit red or green role', () => {
  assert.throws(
    () => preparePlatformSubmission({
      ...record,
      repo_url: 'https://github.com/example/nyh-go-0300/tree/bug-01/test_model_fix',
    }, schema),
    /无法识别红绿角色/,
  );
  assert.throws(
    () => preparePlatformSubmission({
      ...record,
      task_type: 'diagnosis',
      repo_url: 'https://github.com/example/nyh-go-0300/tree/bug1_green',
      verify_result: { pre_fix: record.verify_result.pre_fix },
    }, schema),
    /显式 red/,
  );
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
  const summaryOnly = findPlatformSubmissionByBugId({ items: [{ id: 'submission-2', summary: `${record.bug_id} | 问题摘要` }] }, record.bug_id);
  assert.equal(summaryOnly.id, 'submission-2');
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
    submissionPlatformReviewStatus: '',
    submissionPlatformReviewLabel: '',
    submissionPlatformReviewReason: '',
    submissionPlatformReviewUpdatedAt: null,
    submissionPlatformCurrentVersion: null,
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
    submissionPlatformReviewStatus: '',
    submissionPlatformReviewLabel: '',
    submissionPlatformReviewReason: '',
    submissionPlatformReviewUpdatedAt: null,
    submissionPlatformCurrentVersion: null,
  });
  assert.equal(platformImportState({ status: 'failed', error: 'HTTP 503' }).submissionPlatformImported, false);
});

test('platform review reconciliation preserves import state and records repair feedback', () => {
  const merged = mergePlatformSubmissionReview({
    taskId: 'task-1',
    bugId: 'bug-1',
    status: 'submitted',
    submittedAt: '2026-08-25T06:00:00.000Z',
  }, {
    id: 11514,
    status: 'PENDING_FIX',
    reject_reason: '测试断言被削弱',
    current_version: 2,
  }, { observedAt: '2026-08-25T07:00:00.000Z' });
  assert.equal(merged.status, 'submitted');
  assert.equal(merged.platformReviewStatus, 'PENDING_FIX');
  assert.equal(merged.platformReviewLabel, '待返修');
  assert.equal(merged.platformReviewReason, '测试断言被削弱');
  assert.equal(merged.platformCurrentVersion, 2);
  assert.equal(merged.platformReviewUpdatedAt, '2026-08-25T07:00:00.000Z');

  const imported = platformImportState(merged);
  assert.equal(imported.submissionPlatformImported, true);
  assert.equal(imported.submissionPlatformImportStatus, 'imported');
  assert.equal(imported.submissionPlatformReviewStatus, 'PENDING_FIX');
  assert.equal(imported.submissionPlatformError, '测试断言被削弱');
});

test('README-only repair override excludes mixed or unrelated rejections', () => {
  const readmeOnly = `[云质检]
结论：打回
打回原因：
1. BENZHI_README.md 顶部项目简介不合格：未明确说明项目类型。
2. 问题归属：项目说明文件；对应规则：必须提供一句话项目简介。
关键证据：
1. BENZHI_README.md 项目简介原文：本 Git 项目来自 workspace。`;
  assert.equal(isReadmeOnlyPlatformRepairReason(readmeOnly), true);
  assert.equal(isReadmeOnlyPlatformRepairReason(
    readmeOnly.replace('\n关键证据：', '\n3. 最终版本编译失败。\n关键证据：'),
  ), false);
  assert.equal(isReadmeOnlyPlatformRepairReason('1.【题目过于简单】修改内容过小'), false);
  assert.equal(isReadmeOnlyPlatformRepairReason('1. BENZHI_README.md 不合格\n2. 修复后测试仍然失败'), false);
});

test('platform submission totals accept nested list envelopes', () => {
  assert.equal(extractPlatformSubmissionTotal({ data: { total: 369, items: [{}] } }), 369);
  assert.equal(extractPlatformSubmissionTotal({ items: [{}, {}] }), 2);
});

test('platform review reconciliation selects the exact submission before duplicate bug ids', () => {
  const payload = { items: [
    { id: 10, summary: 'nyh-go-0300-bug-01 | old', status: '待返修' },
    { id: 20, summary: 'nyh-go-0300-bug-01 | current', status: '初审通过' },
  ] };
  assert.equal(findPlatformSubmissionForRecord(payload, {
    bugId: 'nyh-go-0300-bug-01',
    platformSubmissionId: '20',
  }).id, 20);
  assert.equal(findPlatformSubmissionForRecord(payload, { bugId: 'nyh-go-0300-bug-01' }).id, 10);
});

test('platform review snapshot counts every remote submission including duplicate bug ids', () => {
  const snapshot = buildPlatformReviewSnapshot([
    { id: 10, summary: 'nyh-go-0300-bug-01 | old', status: '待返修', current_version: 1 },
    { id: 20, summary: 'nyh-go-0300-bug-01 | current', status: '初审通过', current_version: 2 },
    { id: 30, summary: 'nyh-go-0301-bug-02 | current', status: '待返修', current_version: 1 },
  ], { observedAt: '2026-08-26T04:00:00.000Z' });
  assert.deepEqual(snapshot.reviewCounts, { PENDING_FIX: 2, FIRST_PASSED: 1 });
  assert.deepEqual(snapshot.submissions.map((record) => record.submissionId), ['10', '20', '30']);
  assert.equal(snapshot.submissions[0].bugId, 'nyh-go-0300-bug-01');
});

test('daily submission activity uses Beijing calendar boundaries and qualified backlog', () => {
  const stats = buildSubmissionActivityStats([
    { taskId: 'task-1', bugId: 'bug-1', status: 'submitted', submittedAt: '2026-08-24T16:00:00.000Z', platformSubmissionId: 'submission-1' },
    { taskId: 'task-2', bugId: 'bug-2', status: 'failed', startedAt: '2026-08-25T01:00:00.000Z', failedAt: '2026-08-25T01:01:00.000Z', error: 'HTTP 503' },
    { taskId: 'task-old', bugId: 'bug-old', status: 'submitted', submittedAt: '2026-08-24T15:59:59.000Z' },
  ], [
    { taskId: 'task-1', status: 'qualified', updatedAt: '2026-08-24T16:00:00.000Z' },
    { taskId: 'task-2', status: 'qualified', updatedAt: '2026-08-25T01:00:00.000Z' },
    { taskId: 'task-old', status: 'qualified', updatedAt: '2026-08-24T15:59:59.000Z' },
    { taskId: 'task-rejected', status: 'unqualified', updatedAt: '2026-08-25T02:00:00.000Z' },
  ], { now: new Date('2026-08-25T04:00:00.000Z') });

  assert.equal(stats.date, '2026-08-25');
  assert.deepEqual(stats.today, { qualified: 2, uploaded: 1, failed: 1, submitting: 0, pendingUpload: 1 });
  assert.deepEqual(stats.allTime, { qualified: 3, uploaded: 2, failed: 1, submitting: 0 });
  assert.deepEqual(stats.recent.map((item) => item.taskId), ['task-2', 'task-1']);
});
