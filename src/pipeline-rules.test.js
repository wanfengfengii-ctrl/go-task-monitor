import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPipelineStages,
  CURRENT_BUG_POLICY_VERSION,
  CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
  CURRENT_VERIFICATION_POLICY_VERSION,
  CURRENT_WORKFLOW_POLICY_VERSION,
  CURRENT_WORKFLOW_VERSION,
  DEFAULT_BUG_COUNT,
  isPipelineBugDeliveryComplete,
  isSkippedPipelineBug,
  markPipelineBugFailed,
  markPipelineBugSkipped,
  markPipelineTrajectorySkippedPendingVerification,
  MAX_BUG_STAGE_AUTO_RETRIES,
  MAX_BUG_TRAJECTORY_ATTEMPTS,
  countedBugTrajectoryAttempts,
  MAX_GOLD_CONTRACT_REVIEW_RETRIES,
  PARALLEL_BUG_WORKFLOW_VERSION,
  pipelineBugQuota,
  pipelineProjectDeliverySummary,
  pipelineUserQueryReadiness,
  pipelineTaskOutcome,
  publicPipelineJob,
  pipelineStageLayoutMatches,
  queuePipelineBugStageRetry,
  queuePipelineGoldContractRetry,
  remainingBugTrajectoryAttempts,
  upgradeSubmissionPlatformStageLayout,
  upgradeUnfinishedPipelineBugQuota,
  validatePipelineRequest,
  invalidatePipelineVerificationAfterMissingTestAuthor,
  reactivatePipelineBug,
  reactivateFailedPipelineBugsForManualRetry,
  rewindPipelineBugAfterMissingTrajectory,
} from './pipeline-rules.js';

test('user-query readiness does not treat a partial parallel Bug batch as complete', () => {
  const stages = [];
  const bugs = [];
  for (let index = 1; index <= 10; index += 1) {
    stages.push({ id: `bug${index}_bug_source_prepare`, stage: 'bug_source_prepare', bugIndex: index, status: index <= 7 ? 'passed' : 'pending' });
    stages.push({ id: `bug${index}_user_query_review`, stage: 'user_query_review', bugIndex: index, status: 'pending' });
    if (index <= 7) bugs.push({ bugIndex: index, discovery: { found: true, user_query: `题面 ${index}` } });
  }

  const partial = pipelineUserQueryReadiness({ request: { bugCount: 10 }, bugs, stages });
  assert.equal(partial.ready, false);
  assert.equal(partial.preparedBugCount, 7);
  assert.deepEqual(partial.missingBugIndexes, [8, 9, 10]);
  assert.deepEqual(partial.unpreparedBugIndexes, [8, 9, 10]);

  const complete = pipelineUserQueryReadiness({
    request: { bugCount: 10 },
    bugs: Array.from({ length: 10 }, (_, offset) => ({ bugIndex: offset + 1, discovery: { found: true, user_query: `题面 ${offset + 1}` } })),
    stages: stages.map((stage) => ({ ...stage, status: stage.stage === 'user_query_review' ? 'pending' : 'passed' })),
  });
  assert.equal(complete.ready, true);
  assert.equal(complete.preparedBugCount, 10);
  assert.deepEqual(complete.pendingReviewIndexes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('skipped injection slots do not block batch user-query confirmation', () => {
  const stages = [];
  const bugs = [];
  for (let index = 1; index <= 3; index += 1) {
    const skipped = index === 2;
    stages.push({ id: `bug${index}_bug_source_prepare`, stage: 'bug_source_prepare', bugIndex: index, status: skipped ? 'skipped' : 'passed' });
    stages.push({ id: `bug${index}_user_query_review`, stage: 'user_query_review', bugIndex: index, status: skipped ? 'skipped' : 'pending' });
    bugs.push({ bugIndex: index, disposition: skipped ? 'skipped' : undefined, discovery: { found: !skipped, user_query: skipped ? '' : `题面 ${index}` } });
  }
  const readiness = pipelineUserQueryReadiness({ request: { bugCount: 3 }, bugs, stages });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.skippedBugIndexes, [2]);
  assert.deepEqual(readiness.pendingReviewIndexes, [1, 3]);
  assert.equal(readiness.activeBugCount, 2);
});

test('reactivating a skipped Bug clears stale trajectory disposition', () => {
  const job = {
    bugs: [{
      bugIndex: 3,
      disposition: 'skipped',
      trajectoryDisposition: 'skipped_pending_verification',
      trajectorySkipReason: 'old system failure',
      trajectorySkippedAt: '2026-08-20T00:00:00Z',
    }],
    stages: [{ id: 'bug3_claude_fix', bugIndex: 3, status: 'skipped', reason: 'old system failure' }],
  };
  reactivatePipelineBug(job, 3);
  assert.equal(job.bugs[0].disposition, undefined);
  assert.equal(job.bugs[0].trajectoryDisposition, undefined);
  assert.equal(job.stages[0].status, 'pending');
  assert.equal(job.stages[0].reason, undefined);
});

test('project-level manual retry queues failed V3 Bugs instead of starting an empty runner', () => {
  const job = {
    workflowVersion: 3,
    status: 'stopped',
    error: '项目仅交付 1/3 个合格 Bug',
    retryBlockedReason: '流水线阶段连续失败，等待人工重试',
    finishedAt: '2026-08-25T00:00:00.000Z',
    bugs: [
      { bugIndex: 1, disposition: 'delivered' },
      { bugIndex: 2, disposition: 'failed', failureStage: 'bug2_test_author', failureReason: 'timeout', stageAutoRetries: { bug2_test_author: { retryCount: 3, maxRetries: 3, exhausted: true } } },
      { bugIndex: 3, disposition: 'failed', failureStage: 'bug3_platform_submit', failureReason: 'network' },
    ],
    stages: [
      { id: 'bug2_test_author', bugIndex: 2, status: 'failed', retryCount: 3, maxRetries: 3 },
      { id: 'bug3_platform_submit', bugIndex: 3, status: 'failed' },
    ],
  };

  const reactivated = reactivateFailedPipelineBugsForManualRetry(job, '2026-08-25T01:00:00.000Z');

  assert.deepEqual(reactivated, [2, 3]);
  assert.deepEqual(job.pendingBugRetries, [2, 3]);
  assert.equal(job.bugs[0].disposition, 'delivered');
  assert.equal(job.bugs[1].disposition, undefined);
  assert.equal(job.bugs[1].workerExecution.status, 'fast_lane_queued');
  assert.equal(job.bugs[1].stageAutoRetries, undefined);
  assert.equal(job.bugs[1].stageAutoRetryBudgetHistory.length, 1);
  assert.equal(job.stages[0].retryCount, undefined);
  assert.equal(job.bugs[2].workerExecution.currentStage, 'bug3_platform_submit');
  assert.equal(job.currentStage, 'bug2_test_author');
  assert.equal(job.error, '');
  assert.equal(job.retryBlockedReason, undefined);
  assert.equal(job.finishedAt, null);
});

test('pipeline requests default to ten bugs per standard generated project', () => {
  const result = validatePipelineRequest({
    projectBrief: '生成一个包含任务调度、持久化和 HTTP API 的 Go 服务项目。',
  });
  assert.equal(result.ok, true);
  assert.equal(DEFAULT_BUG_COUNT, 10);
  assert.equal(result.value.bugCount, 10);
  assert.equal(CURRENT_BUG_POLICY_VERSION, 4);
  assert.equal(result.value.bugPolicyVersion, CURRENT_BUG_POLICY_VERSION);
  assert.equal(createPipelineStages(result.value.bugCount).filter((stage) => stage.scope === 'bug').length, 80);
  const firstBugStages = createPipelineStages(1).filter((stage) => stage.scope === 'bug');
  assert.deepEqual(firstBugStages.slice(-3).map((stage) => [stage.stage, stage.label]), [
    ['sol_quality', '轨迹内容质检（已暂停）'],
    ['cloud_upload', '上传轨迹云盘并回填链接'],
    ['delivery_ready', '交付字段就绪'],
  ]);
});

test('pipeline resume recognizes completed Bug delivery and leaves unfinished Bugs runnable', () => {
  const job = { stages: createPipelineStages(3) };
  job.stages.find((stage) => stage.id === 'bug1_delivery_ready').status = 'passed';
  job.stages.find((stage) => stage.id === 'bug2_cloud_upload').status = 'passed';
  assert.equal(isPipelineBugDeliveryComplete(job, 1), true);
  assert.equal(isPipelineBugDeliveryComplete(job, 2), false);
  assert.equal(isPipelineBugDeliveryComplete(job, 3), false);
});

test('bug difficulty policy applies only to new requests', () => {
  const historical = {
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    status: 'failed',
    request: { projectTier: 'standard', bugCount: 10, bugPolicyVersion: 2 },
    stages: createPipelineStages(10, CURRENT_WORKFLOW_VERSION),
    bugs: [],
  };
  const result = upgradeUnfinishedPipelineBugQuota(historical);
  assert.equal(result.job.request.bugPolicyVersion, 2);
});

test('pipeline request assigns repositories outside user input and applies tier bug quotas', () => {
  const valid = validatePipelineRequest({
    projectBrief: '生成一个包含任务调度、持久化和 HTTP API 的 Go 服务项目。',
    repository: 'https://attacker.example.com/ignored',
    cloneUrl: 'https://attacker.example.com/ignored.git',
    bugCount: 10,
    maxTrajectoryAttempts: 3,
    taskType: 'bugfix',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.maxTrajectoryAttempts, 3);
  assert.equal(MAX_BUG_TRAJECTORY_ATTEMPTS, 3);
  assert.equal('repository' in valid.value, false);
  assert.equal('cloneUrl' in valid.value, false);
  assert.equal(createPipelineStages(10).filter((stage) => stage.scope === 'bug').length, 80);
  assert.equal(pipelineBugQuota('standard'), 10);
  assert.equal(pipelineBugQuota('large'), 30);
  assert.equal(validatePipelineRequest({ ...valid.value, bugCount: 5 }).value.bugCount, 10);
  const large = validatePipelineRequest({ ...valid.value, projectTier: 'large', bugCount: 5 });
  assert.equal(large.ok, true);
  assert.deepEqual(large.issues, []);
  assert.equal(large.value.bugCount, 30);
  assert.equal(validatePipelineRequest({ ...valid.value, projectTier: 'standard', bugCount: 30 }).value.bugCount, 10);
});

test('unfinished V2 projects expand old five-slot jobs to their fixed tier quota', () => {
  const originalStages = createPipelineStages(5, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION);
  for (const stage of originalStages) stage.status = 'passed';
  const job = {
    id: 'pipeline-standard-five',
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    status: 'failed',
    currentStage: 'bug1_gold_fix',
    schedulerLease: { stageId: 'bug1_gold_fix' },
    waitingResource: { pool: 'compute-heavy' },
    request: { projectTier: 'standard', bugCount: 5 },
    stages: originalStages,
    bugs: Array.from({ length: 5 }, (_, index) => ({ bugIndex: index + 1 })),
  };
  const upgraded = upgradeUnfinishedPipelineBugQuota(job);
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.job.request.bugCount, 10);
  assert.deepEqual(upgraded.addedBugSlots, [6, 7, 8, 9, 10]);
  assert.equal(upgraded.job.bugs.length, 5);
  assert.equal(upgraded.job.stages.find((stage) => stage.id === 'bug5_bug_source_prepare').status, 'passed');
  assert.equal(upgraded.job.stages.find((stage) => stage.id === 'bug6_bug_discovery').status, 'pending');
  assert.equal(upgraded.job.stages.find((stage) => stage.id === 'bug10_delivery_ready').status, 'pending');
  assert.equal(upgraded.job.stages.find((stage) => stage.id === 'main_publish').status, 'pending');
  assert.equal(upgraded.job.currentStage, 'bug6_bug_discovery');
  assert.equal(upgraded.job.schedulerLease, null);
  assert.equal('waitingResource' in upgraded.job, false);
});

test('unfinished large projects expand to thirty while completed history is immutable', () => {
  const unfinished = upgradeUnfinishedPipelineBugQuota({
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    status: 'stopped',
    request: { projectTier: 'large', bugCount: 5 },
    stages: createPipelineStages(5, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION),
    bugs: [],
  });
  assert.equal(unfinished.changed, true);
  assert.equal(unfinished.job.request.bugCount, 30);
  assert.equal(unfinished.job.stages.some((stage) => stage.id === 'bug30_delivery_ready'), true);

  const passed = {
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    status: 'passed',
    request: { projectTier: 'standard', bugCount: 5 },
    stages: createPipelineStages(5, CURRENT_WORKFLOW_VERSION),
  };
  const historical = upgradeUnfinishedPipelineBugQuota(passed);
  assert.equal(historical.changed, false);
  assert.equal(historical.job, passed);
  assert.equal(historical.job.request.bugCount, 5);
});

test('quota expansion keeps an earlier failed project stage ahead of new Bug slots', () => {
  const result = upgradeUnfinishedPipelineBugQuota({
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    status: 'failed',
    currentStage: 'project_plan',
    request: { projectTier: 'standard', bugCount: 5 },
    stages: createPipelineStages(5, CURRENT_WORKFLOW_VERSION),
  });
  assert.equal(result.job.currentStage, 'project_plan');
});

test('trajectory attempt budget is global per bug across pipeline restarts', () => {
  assert.equal(remainingBugTrajectoryAttempts({ attempts: [] }), 3);
  assert.equal(remainingBugTrajectoryAttempts({ attempts: [{}, {}] }), 1);
  assert.equal(remainingBugTrajectoryAttempts({ attempts: [{}, {}, {}] }), 0);
  assert.equal(remainingBugTrajectoryAttempts({ attempts: [{}, {}, {}, {}] }), 0);
});

test('stopped trajectory attempts do not consume model budget', () => {
  const bug = { attempts: [
    { status: 'stopped', action: 'user_stopped' },
    { status: 'system', failureCategory: 'runner_infrastructure' },
    { status: 'failed' },
  ] };
  assert.equal(countedBugTrajectoryAttempts(bug), 1);
  assert.equal(remainingBugTrajectoryAttempts(bug), 2);
});

test('reactivating a bug can reset attempts while preserving audit history', () => {
  const job = {
    bugs: [{
      bugIndex: 5,
      disposition: 'skipped',
      skippedAt: '2026-08-21T00:00:00.000Z',
      skipReason: 'previous exhaustion',
      attempts: [{ status: 'stopped' }],
      stageAutoRetries: {
        bug5_test_author: { retryCount: 3, maxRetries: 3, exhausted: true },
      },
    }],
    stages: [{ id: 'bug5_claude_fix', bugIndex: 5, status: 'skipped' }],
  };
  const updated = reactivatePipelineBug(job, 5, { resetAttempts: true });
  assert.equal(updated.bugs[0].attempts.length, 0);
  assert.equal(updated.bugs[0].trajectoryAttemptHistory.length, 1);
  assert.equal(updated.bugs[0].stageAutoRetries, undefined);
  assert.equal(updated.bugs[0].stageAutoRetryBudgetHistory.length, 1);
  assert.equal(updated.bugs[0].disposition, undefined);
  assert.equal(updated.bugs[0].skippedAt, undefined);
  assert.equal(updated.bugs[0].skipReason, undefined);
  assert.equal(updated.stages[0].status, 'pending');
});

test('missing trajectory capture rewinds a false-positive Claude stage', () => {
  const evidence = { pre_fix: { result: 'red' } };
  const job = {
    bugs: [{ bugIndex: 10, verificationEvidence: evidence, stageAutoRetries: { bug10_trajectory_validate: { retryCount: 3 } } }],
    stages: [
      { id: 'bug10_task_prepare', bugIndex: 10, status: 'passed' },
      { id: 'bug10_claude_fix', bugIndex: 10, status: 'passed', finishedAt: '2026-08-24T00:00:00Z' },
      { id: 'bug10_trajectory_validate', bugIndex: 10, status: 'failed', retryCount: 3, error: 'ENOENT' },
      { id: 'bug10_test_author', bugIndex: 10, status: 'passed', result: { testFile: 'seal_test.go' } },
      { id: 'bug10_delivery_ready', bugIndex: 10, status: 'pending' },
    ],
  };

  assert.equal(rewindPipelineBugAfterMissingTrajectory(job, 10, '2026-08-24T01:00:00Z'), true);
  assert.equal(job.stages[0].status, 'passed');
  for (const stage of job.stages.slice(1)) {
    assert.equal(stage.status, 'pending');
    assert.equal(stage.startedAt, null);
    assert.equal(stage.finishedAt, null);
    assert.equal(stage.retryCount, undefined);
    assert.equal(stage.result, undefined);
  }
  assert.equal(job.bugs[0].verificationEvidence, undefined);
  assert.deepEqual(job.bugs[0].verificationEvidenceHistory[0].evidence, evidence);
  assert.equal(job.bugs[0].stageAutoRetries, undefined);
});

test('missing live trajectory preserves a durable repair checkpoint after cloud upload failure', () => {
  const evidence = {
    pre_fix: { result: 'red', session_id: 'pre-proof' },
    post_fix: { result: 'green', session_id: 'post-proof' },
  };
  const job = {
    bugs: [{ bugIndex: 3, verificationEvidence: evidence }],
    stages: [
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'passed', finishedAt: '2026-08-26T02:04:35Z' },
      { id: 'bug3_trajectory_validate', bugIndex: 3, status: 'passed' },
      { id: 'bug3_test_author', bugIndex: 3, status: 'passed', result: { testFile: 'model_bug3_test.go' } },
      { id: 'bug3_pre_verify', bugIndex: 3, status: 'passed', result: { result: 'red' } },
      { id: 'bug3_post_verify', bugIndex: 3, status: 'passed', result: { result: 'green' } },
      { id: 'bug3_docker_validation', bugIndex: 3, status: 'passed' },
      { id: 'bug3_git_publication', bugIndex: 3, status: 'passed' },
      { id: 'bug3_cloud_upload', bugIndex: 3, status: 'failed', error: 'proof upload failed' },
      { id: 'bug3_delivery_ready', bugIndex: 3, status: 'pending' },
    ],
  };

  assert.equal(rewindPipelineBugAfterMissingTrajectory(job, 3, '2026-08-26T03:00:00Z'), false);
  assert.equal(job.stages[0].status, 'passed');
  assert.equal(job.stages[7].status, 'failed');
  assert.deepEqual(job.bugs[0].verificationEvidence, evidence);
  assert.equal(job.bugs[0].verificationEvidenceHistory, undefined);
});

test('missing independent test author invalidates stale downstream verification checkpoints', () => {
  const oldEvidence = { pre_fix: { result: 'red', session_id: 'old-proof' } };
  const job = {
    request: { taskType: 'diagnosis' },
    bugs: [{ bugIndex: 1, verificationEvidence: oldEvidence }],
    stages: [
      { id: 'bug1_trajectory_validate', bugIndex: 1, status: 'passed' },
      { id: 'bug1_test_author', bugIndex: 1, status: 'pending', startedAt: '2026-08-23T00:30:00Z' },
      { id: 'bug1_pre_verify', bugIndex: 1, status: 'passed', result: { result: 'red' } },
      { id: 'bug1_cloud_upload', bugIndex: 1, status: 'passed', result: { uploaded: true } },
      { id: 'bug1_verification_finalize', bugIndex: 1, status: 'pending' },
      { id: 'bug1_delivery_ready', bugIndex: 1, status: 'pending' },
    ],
  };

  assert.equal(invalidatePipelineVerificationAfterMissingTestAuthor(job, 1, '2026-08-23T01:00:00Z'), true);
  assert.equal(job.stages.find((stage) => stage.id === 'bug1_trajectory_validate').status, 'passed');
  for (const suffix of ['test_author', 'pre_verify', 'cloud_upload', 'verification_finalize', 'delivery_ready']) {
    const stage = job.stages.find((item) => item.id === `bug1_${suffix}`);
    assert.equal(stage.status, 'pending');
    assert.equal(stage.startedAt, null);
    assert.equal(stage.result, undefined);
  }
  assert.equal(job.bugs[0].verificationEvidence, undefined);
  assert.deepEqual(job.bugs[0].verificationEvidenceHistory, [{
    invalidatedAt: '2026-08-23T01:00:00Z',
    reason: 'independent_test_author_artifact_missing',
    evidence: oldEvidence,
  }]);
});

test('existing independent test author keeps completed verification checkpoints reusable', () => {
  const job = {
    bugs: [{ bugIndex: 2, verificationTestAuthor: { sourceDir: '/tmp/source', testFile: 'api/model_test.go' } }],
    stages: [
      { id: 'bug2_test_author', bugIndex: 2, status: 'passed' },
      { id: 'bug2_pre_verify', bugIndex: 2, status: 'passed' },
    ],
  };
  assert.equal(invalidatePipelineVerificationAfterMissingTestAuthor(job, 2), false);
  assert.equal(job.stages[1].status, 'passed');
});

test('trajectory exhaustion can resume at independent verification without rerunning Claude', () => {
  const job = {
    status: 'running',
    currentStage: 'bug1_claude_fix',
    error: 'old failure',
    bugs: [{ bugIndex: 1 }],
    stages: [
      { id: 'bug1_claude_fix', phase: 'delivery', bugIndex: 1, status: 'failed', error: 'old failure' },
      { id: 'bug1_trajectory_validate', phase: 'delivery', bugIndex: 1, status: 'pending' },
      { id: 'bug1_sol_quality', phase: 'delivery', bugIndex: 1, status: 'pending' },
      { id: 'bug1_pre_verify', phase: 'delivery', bugIndex: 1, status: 'pending' },
    ],
  };
  markPipelineTrajectorySkippedPendingVerification(job, 1, '主轨迹耗尽', '2026-08-19T00:00:00.000Z');
  assert.equal(job.bugs[0].trajectoryDisposition, 'skipped_pending_verification');
  assert.deepEqual(job.stages.slice(0, 3).map((stage) => stage.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(job.stages[3].status, 'pending');
  assert.equal(job.currentStage, null);
  assert.equal(job.error, '');
});

test('V2 selects every independent bug baseline before publishing Git', () => {
  const stages = createPipelineStages(5, PARALLEL_BUG_WORKFLOW_VERSION);
  const publishIndex = stages.findIndex((stage) => stage.id === 'main_publish');
  assert.ok(publishIndex > stages.findIndex((stage) => stage.id === 'bug5_bug_source_prepare'));
  assert.ok(publishIndex < stages.findIndex((stage) => stage.id === 'bug1_gold_fix'));
  assert.equal(stages.filter((stage) => stage.stage === 'bug_source_prepare').length, 5);
  assert.equal(stages.filter((stage) => stage.stage === 'user_query_review').length, 0);
  assert.equal(stages.filter((stage) => stage.scope === 'bug').length, 45);
  assert.equal(stages.find((stage) => stage.id === 'main_freeze').label, '本地冻结初始 main commit');
});

test('V5 adds independent pre/post verification stages without changing legacy jobs', () => {
  const legacy = createPipelineStages(1, PARALLEL_BUG_WORKFLOW_VERSION);
  assert.equal(legacy.some((stage) => stage.stage === 'pre_verify'), false);
  const stages = createPipelineStages(1, PARALLEL_BUG_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION);
  const names = stages.filter((stage) => stage.scope === 'bug').map((stage) => stage.stage);
  assert.ok(names.indexOf('claude_fix') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('trajectory_validate') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('verification_coverage') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('post_verify') > names.indexOf('trajectory_validate'));
  assert.ok(names.indexOf('verification_coverage') < names.indexOf('cloud_upload'));
  assert.ok(names.indexOf('verification_finalize') < names.indexOf('delivery_ready'));
});

test('submission platform checkpoint is enabled only for jobs carrying the new policy', () => {
  const existing = createPipelineStages(
    1,
    CURRENT_WORKFLOW_VERSION,
    CURRENT_VERIFICATION_POLICY_VERSION,
    'bugfix',
    CURRENT_WORKFLOW_POLICY_VERSION,
  );
  assert.equal(existing.some((stage) => stage.stage === 'platform_submit'), false);

  const future = createPipelineStages(
    1,
    CURRENT_WORKFLOW_VERSION,
    CURRENT_VERIFICATION_POLICY_VERSION,
    'bugfix',
    CURRENT_WORKFLOW_POLICY_VERSION,
    CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
  );
  const names = future.filter((stage) => stage.scope === 'bug').map((stage) => stage.stage);
  assert.ok(names.indexOf('verification_finalize') < names.indexOf('platform_submit'));
  assert.ok(names.indexOf('platform_submit') < names.indexOf('delivery_ready'));
  assert.equal(pipelineStageLayoutMatches({
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    submissionPlatformPolicyVersion: CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
    request: { bugCount: 1, taskType: 'bugfix' },
    stages: future,
  }), true);
});

test('submission platform stage migration inserts only missing checkpoints and preserves progress', () => {
  const legacyStages = createPipelineStages(
    2,
    CURRENT_WORKFLOW_VERSION,
    CURRENT_VERIFICATION_POLICY_VERSION,
    'bugfix',
    CURRENT_WORKFLOW_POLICY_VERSION,
  );
  legacyStages.find((stage) => stage.id === 'bug1_verification_finalize').status = 'passed';
  legacyStages.find((stage) => stage.id === 'bug2_cloud_upload').status = 'running';
  const originalDelivery = legacyStages.find((stage) => stage.id === 'bug1_delivery_ready');
  const result = upgradeSubmissionPlatformStageLayout({
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    submissionPlatformPolicyVersion: CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
    request: { bugCount: 2, taskType: 'bugfix' },
    stages: legacyStages,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.addedStageIds, ['bug1_platform_submit', 'bug2_platform_submit']);
  assert.equal(result.job.stages.find((stage) => stage.id === 'bug1_verification_finalize').status, 'passed');
  assert.equal(result.job.stages.find((stage) => stage.id === 'bug2_cloud_upload').status, 'running');
  assert.equal(result.job.stages.find((stage) => stage.id === 'bug1_delivery_ready'), originalDelivery);
  assert.ok(result.job.stages.findIndex((stage) => stage.id === 'bug1_platform_submit')
    < result.job.stages.findIndex((stage) => stage.id === 'bug1_delivery_ready'));
});

test('submission platform stage migration leaves legacy-policy jobs unchanged', () => {
  const job = {
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    submissionPlatformPolicyVersion: 0,
    request: { bugCount: 1, taskType: 'bugfix' },
    stages: createPipelineStages(1, CURRENT_WORKFLOW_VERSION),
  };
  const result = upgradeSubmissionPlatformStageLayout(job);
  assert.equal(result.changed, false);
  assert.equal(result.job, job);
});

test('V3 diagnosis runs its single pre-fix proof after the read-only model session', () => {
  const stages = createPipelineStages(1, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION, 'diagnosis');
  const names = stages.filter((stage) => stage.scope === 'bug').map((stage) => stage.stage);
  assert.ok(names.indexOf('claude_fix') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('trajectory_validate') < names.indexOf('test_author'));
  assert.ok(names.indexOf('test_author') < names.indexOf('git_publication'));
  assert.ok(names.indexOf('git_publication') < names.indexOf('pre_verify'));
  assert.equal(names.includes('post_verify'), false);
  assert.equal(names.includes('verification_coverage'), false);
});

test('workflow policy 4 keeps bugfix red and green after Claude', () => {
  const stages = createPipelineStages(
    1,
    CURRENT_WORKFLOW_VERSION,
    CURRENT_VERIFICATION_POLICY_VERSION,
    'bugfix',
    CURRENT_WORKFLOW_POLICY_VERSION,
  );
  const names = stages.filter((stage) => stage.scope === 'bug').map((stage) => stage.stage);
  assert.ok(names.indexOf('claude_fix') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('post_verify') > names.indexOf('trajectory_validate'));
  assert.equal(names.includes('verification_coverage'), false);
  assert.equal(names.includes('sol_quality'), false);
});

test('V3 delegates the only Bug fix to Claude and has no Gold stage', () => {
  const stages = createPipelineStages(1, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION, 'bugfix');
  const names = stages.filter((stage) => stage.scope === 'bug').map((stage) => stage.stage);
  assert.equal(names.includes('gold_fix'), false);
  assert.ok(names.indexOf('bug_source_prepare') < names.indexOf('user_query_review'));
  assert.ok(stages.findIndex((stage) => stage.id === 'bug1_user_query_review') < stages.findIndex((stage) => stage.id === 'main_publish'));
  assert.ok(names.indexOf('task_prepare') < names.indexOf('claude_fix'));
  assert.ok(names.indexOf('trajectory_validate') < names.indexOf('test_author'));
  assert.ok(names.includes('test_author'));
  assert.ok(names.indexOf('test_author') < names.indexOf('pre_verify'));
  assert.ok(names.indexOf('pre_verify') < names.indexOf('post_verify'));
  assert.ok(names.indexOf('post_verify') < names.indexOf('delivery_ready'));
  assert.ok(names.indexOf('claude_fix') < names.indexOf('post_verify'));
});

test('stage layout migration detects retired delivery stages even when policy version matches', () => {
  const current = {
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    request: { bugCount: 1, taskType: 'bugfix' },
    stages: createPipelineStages(1, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION, 'bugfix', CURRENT_WORKFLOW_POLICY_VERSION),
  };
  assert.equal(pipelineStageLayoutMatches(current), true);
  const legacy = {
    ...current,
    stages: current.stages.map((stage) => stage.id === 'bug1_task_prepare'
      ? { ...stage, id: 'bug1_gold_fix' }
      : stage),
  };
  assert.equal(pipelineStageLayoutMatches(legacy), false);
});

test('V3 batches user_query review after every Bug source is prepared', () => {
  const stages = createPipelineStages(5, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION, 'bugfix');
  const reviews = stages.filter((stage) => stage.stage === 'user_query_review');
  assert.equal(reviews.length, 5);
  assert.deepEqual(reviews.map((stage) => stage.bugIndex), [1, 2, 3, 4, 5]);
  const publishIndex = stages.findIndex((stage) => stage.id === 'main_publish');
  assert.ok(reviews.every((stage) => stages.findIndex((candidate) => candidate.id === stage.id) < publishIndex));
});

test('one failed V2 bug can be skipped without discarding completed work or later bugs', () => {
  const stages = createPipelineStages(3, PARALLEL_BUG_WORKFLOW_VERSION);
  stages.find((stage) => stage.id === 'bug2_gold_fix').status = 'passed';
  stages.find((stage) => stage.id === 'bug2_claude_fix').status = 'running';
  const job = {
    currentStage: 'bug2_claude_fix',
    error: 'trajectory failed',
    pendingBugRetries: [2, 3],
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }, { bugIndex: 3 }],
    stages,
  };

  markPipelineBugSkipped(job, 2, '人工跳过', '2026-08-16T00:00:00.000Z');

  assert.equal(isSkippedPipelineBug(job.bugs[1]), true);
  assert.equal(job.bugs[1].skipReason, '人工跳过');
  assert.equal(job.stages.find((stage) => stage.id === 'bug2_gold_fix').status, 'passed');
  assert.equal(job.stages.find((stage) => stage.id === 'bug2_claude_fix').status, 'skipped');
  assert.equal(job.stages.find((stage) => stage.id === 'bug3_gold_fix').status, 'pending');
  assert.deepEqual(job.pendingBugRetries, [3]);
  assert.equal(job.currentStage, null);
  assert.equal(job.error, '');
});

test('Bug-scoped failure is recorded and later Bug stages remain runnable', () => {
  const job = {
    status: 'failed',
    currentStage: 'bug1_gold_fix',
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }],
    stages: [
      { id: 'bug1_bug_discovery', bugIndex: 1, phase: 'selection', status: 'passed' },
      { id: 'bug1_gold_fix', bugIndex: 1, phase: 'delivery', status: 'failed' },
      { id: 'bug1_delivery_ready', bugIndex: 1, phase: 'delivery', status: 'pending' },
      { id: 'bug2_gold_fix', bugIndex: 2, phase: 'delivery', status: 'pending' },
    ],
  };
  markPipelineBugFailed(job, 1, { stage: 'bug1_gold_fix', error: 'Gold 失败', failureCategory: 'other' });
  assert.equal(job.bugs[0].disposition, 'failed');
  assert.equal(job.bugs[0].failureDisposition, 'auto_continued');
  assert.equal(job.bugs[0].lastFailure.error, 'Gold 失败');
  assert.equal(job.stages.find((stage) => stage.id === 'bug1_gold_fix').status, 'skipped');
  assert.equal(job.stages.find((stage) => stage.id === 'bug2_gold_fix').status, 'pending');
  assert.equal(isSkippedPipelineBug(job.bugs[0]), true);
  reactivatePipelineBug(job, 1);
  assert.equal(job.bugs[0].disposition, undefined);
  assert.equal(job.stages.find((stage) => stage.id === 'bug1_gold_fix').status, 'pending');
  assert.equal(job.bugs[0].lastFailure.error, 'Gold 失败');
});

test('project delivery passes only when every requested Bug is delivered', () => {
  const job = {
    request: { bugCount: 3 },
    bugs: [
      { bugIndex: 1, disposition: 'delivered' },
      { bugIndex: 2, disposition: 'failed' },
      { bugIndex: 3, disposition: 'skipped' },
    ],
    stages: [
      { id: 'bug1_delivery_ready', status: 'passed' },
      { id: 'bug2_delivery_ready', status: 'skipped' },
      { id: 'bug3_delivery_ready', status: 'skipped' },
    ],
  };
  const partial = pipelineProjectDeliverySummary(job);
  assert.equal(partial.passed, false);
  assert.deepEqual(partial.deliveredBugIndexes, [1]);
  assert.deepEqual(partial.failedBugIndexes, [2]);
  assert.deepEqual(partial.skippedBugIndexes, [3]);

  job.stages[1].status = 'passed';
  job.stages[2].status = 'passed';
  assert.equal(pipelineProjectDeliverySummary(job).passed, true);
});

test('a false delivered marker can reopen only when the independent test artifact is missing', () => {
  const job = {
    bugs: [{ bugIndex: 5, disposition: 'delivered', deliveredAt: 'old' }],
    stages: [
      { id: 'bug5_test_author', bugIndex: 5, status: 'pending' },
      { id: 'bug5_pre_verify', bugIndex: 5, status: 'passed' },
      { id: 'bug5_delivery_ready', bugIndex: 5, status: 'passed' },
    ],
  };
  reactivatePipelineBug(job, 5);
  assert.equal(job.bugs[0].disposition, undefined);
  assert.equal(job.bugs[0].deliveredAt, undefined);
  assert.deepEqual(job.stages.map((stage) => stage.status), ['pending', 'pending', 'pending']);

  const complete = structuredClone(job);
  complete.bugs[0].disposition = 'delivered';
  complete.bugs[0].verificationTestAuthor = { sourceDir: '/tmp/test-author', testFile: 'model_test.go' };
  assert.throws(() => reactivatePipelineBug(complete, 5), /已交付，不能重试/);
});

test('Bug stage failures retry the failed stage three times without clearing passed checkpoints', () => {
  const job = {
    status: 'running',
    currentStage: 'bug1_verification_finalize',
    bugExecution: { selectedBugIndex: 1, status: 'fast_lane_running' },
    bugs: [{ bugIndex: 1, workerExecution: { status: 'fast_lane_running' } }],
    stages: [
      { id: 'bug1_claude_fix', bugIndex: 1, status: 'passed', result: { sessionId: 'repair' } },
      { id: 'bug1_post_verify', bugIndex: 1, status: 'passed', result: { result: 'green' } },
      { id: 'bug1_verification_finalize', bugIndex: 1, status: 'failed', error: 'fetch failed' },
      { id: 'bug1_delivery_ready', bugIndex: 1, status: 'pending' },
    ],
  };

  for (let retry = 1; retry <= MAX_BUG_STAGE_AUTO_RETRIES; retry += 1) {
    const result = queuePipelineBugStageRetry(job, 1, {
      stage: 'bug1_verification_finalize',
      error: 'fetch failed',
      failureCategory: 'cloud_upload',
      at: `2026-08-23T00:00:0${retry}.000Z`,
    });
    assert.equal(result.queued, true);
    assert.equal(result.retryCount, retry);
    assert.equal(job.stages[2].status, 'pending');
    assert.equal(job.stages[0].status, 'passed');
    assert.equal(job.stages[0].result.sessionId, 'repair');
    assert.equal(job.stages[1].status, 'passed');
    assert.equal(job.bugs[0].workerExecution.status, 'fast_lane_queued');
    assert.equal(job.bugs[0].workerExecution.currentAttempt, retry);
    job.stages[2].status = 'failed';
  }

  const exhausted = queuePipelineBugStageRetry(job, 1, {
    stage: 'bug1_verification_finalize',
    error: 'fetch failed again',
    failureCategory: 'cloud_upload',
    at: '2026-08-23T00:00:04.000Z',
  });
  assert.equal(exhausted.queued, false);
  assert.equal(exhausted.retryCount, MAX_BUG_STAGE_AUTO_RETRIES);
  assert.equal(exhausted.failureCount, MAX_BUG_STAGE_AUTO_RETRIES + 1);
  assert.equal(job.stages[2].status, 'failed');
  assert.equal(job.bugs[0].stageAutoRetries.bug1_verification_finalize.exhausted, true);
  assert.equal(job.bugs[0].stageRetryHistory.length, MAX_BUG_STAGE_AUTO_RETRIES + 1);
});

test('manual Bug retry reset clears persisted stage retry counters', () => {
  const job = {
    workflowVersion: 3,
    bugs: [{
      bugIndex: 3,
      attempts: [{ status: 'failed', stage: 'bug3_test_author' }],
      stageAutoRetries: {
        bug3_test_author: { retryCount: 3, maxRetries: 3, exhausted: true },
      },
      disposition: 'failed',
    }],
    stages: [
      { id: 'bug3_test_author', bugIndex: 3, status: 'pending', retryCount: 3, maxRetries: 3 },
      { id: 'bug3_delivery_ready', bugIndex: 3, status: 'pending' },
    ],
  };

  reactivatePipelineBug(job, 3, { resetAttempts: true });

  const stage = job.stages[0];
  assert.equal(stage.retryCount, undefined);
  assert.equal(stage.maxRetries, undefined);
  assert.equal(job.bugs[0].stageAutoRetries, undefined);
  assert.equal(job.bugs[0].attempts.length, 0);
});

test('Gold contract review retries preserve the current Bug and production candidate', () => {
  const job = {
    status: 'failed',
    currentStage: 'bug1_gold_fix',
    stages: [
      { id: 'bug1_gold_fix', bugIndex: 1, status: 'failed', error: 'contract conflict' },
      { id: 'bug2_gold_fix', bugIndex: 2, status: 'pending' },
    ],
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }],
  };
  const result = queuePipelineGoldContractRetry(job, 1, {
    candidateDir: 'history/gold-bug1-contract-retry-1',
    error: 'GOLD_PUBLIC_CONTRACT_CONFLICT',
    at: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(result.queued, true);
  assert.equal(result.attempt, 1);
  assert.equal(job.status, 'waiting_resource');
  assert.equal(job.currentStage, 'bug1_gold_fix');
  assert.equal(job.bugs[0].disposition, undefined);
  assert.equal(job.bugs[0].goldContractRetry.candidateDir, 'history/gold-bug1-contract-retry-1');
  assert.equal(job.stages[0].status, 'pending');
  assert.equal(job.stages[1].status, 'pending');
  assert.equal(job.bugExecution.startedAt, null);
  assert.equal(job.bugExecution.status, 'fast_lane_queued');

  const exhausted = queuePipelineGoldContractRetry(job, 1, {
    candidateDir: 'history/gold-bug1-contract-retry-4',
    error: 'still over-specified',
    at: '2026-08-20T00:01:00.000Z',
    maxAttempts: 1,
  });
  assert.equal(exhausted.queued, false);
  assert.equal(job.status, 'stopped');
  assert.equal(job.bugs[0].failureDisposition, 'manual_review');
  assert.equal(MAX_GOLD_CONTRACT_REVIEW_RETRIES, 3);
});

test('task outcome exposes the final pipeline skip reason instead of the raw Claude status', () => {
  const job = {
    bugs: [{
      bugIndex: 2,
      disposition: 'skipped',
      skippedAt: '2026-08-16T00:00:00.000Z',
      skipReason: '轨迹累计 3 次仍未通过规范',
      task: { taskName: 'sample-bug-2' },
      attempts: [
        { attempt: 1, status: 'failed', stage: 'bug2_trajectory_validate', error: '第一次失败' },
        { attempt: 3, status: 'failed', stage: 'bug2_sol_quality', error: '最终质检失败' },
      ],
    }],
  };

  assert.deepEqual(pipelineTaskOutcome(job, { taskName: 'sample-bug-2', bugIndex: 2 }), {
    bugIndex: 2,
    disposition: 'skipped',
    skippedAt: '2026-08-16T00:00:00.000Z',
    skipReason: '轨迹累计 3 次仍未通过规范',
    failureStage: 'bug2_sol_quality',
    failureReason: '最终质检失败',
    attemptCount: 2,
  });
});

test('public pipeline job does not expose clone credentials or local job directory', () => {
  const visible = publicPipelineJob({
    id: 'job-1',
    jobDir: '/private/job-1',
    tasksRoot: '/private/tasks',
    stages: [{ id: 'project_validate', result: { reportPath: '/private/report.json', platforms: ['linux/arm64'] } }],
    bugs: [{ goldDir: '/private/gold', task: { taskDir: '/private/task', taskName: 'visible-name' } }],
    request: {
      projectBrief: 'A sufficiently long generated Go project requirement.',
      repository: 'https://git.example.com/team/project',
      cloneUrl: 'https://secret@git.example.com/team/project.git',
      bugCount: 1,
      replacesPipelineJobId: 'pipeline-source',
    },
  });
  assert.equal('jobDir' in visible, false);
  assert.equal('tasksRoot' in visible, false);
  assert.equal('cloneUrl' in visible.request, false);
  assert.equal(visible.request.replacesPipelineJobId, 'pipeline-source');
  assert.equal('reportPath' in visible.stages[0].result, false);
  assert.equal('goldDir' in visible.bugs[0], false);
  assert.equal('taskDir' in visible.bugs[0].task, false);
  assert.equal(visible.bugs[0].task.taskName, 'visible-name');
});

test('historical repair placeholders are not exposed or counted as skipped Bugs', () => {
  const job = {
    id: 'historical-repair',
    status: 'stopped',
    request: { bugCount: 3 },
    bugs: [
      { bugIndex: 1, disposition: 'skipped', failureDisposition: 'historical_recovery_placeholder' },
      { bugIndex: 2, disposition: 'delivered' },
      { bugIndex: 3, disposition: 'skipped', skipReason: '候选题与公开契约冲突' },
    ],
    stages: [
      { id: 'bug1_delivery_ready', bugIndex: 1, status: 'skipped' },
      { id: 'bug2_delivery_ready', bugIndex: 2, status: 'passed' },
      { id: 'bug3_delivery_ready', bugIndex: 3, status: 'skipped' },
    ],
  };
  const summary = pipelineProjectDeliverySummary(job);
  assert.deepEqual(summary.notApplicableBugIndexes, [1]);
  assert.deepEqual(summary.skippedBugIndexes, [3]);

  const visible = publicPipelineJob(job);
  assert.deepEqual(visible.notApplicableBugIndexes, [1]);
  assert.deepEqual(visible.bugs.map((bug) => bug.bugIndex), [2, 3]);
  assert.deepEqual(visible.stages.map((stage) => stage.bugIndex), [2, 3]);
});

test('public pipeline job shows the current stage failure when the top-level error is empty', () => {
  const visible = publicPipelineJob({
    id: 'job-stage-error',
    status: 'failed',
    currentStage: 'bug2_cloud_upload',
    error: '',
    stages: [{ id: 'bug2_cloud_upload', status: 'failed', error: '云盘证明上传失败' }],
    request: {},
  });
  assert.equal(visible.error, '云盘证明上传失败');
});
