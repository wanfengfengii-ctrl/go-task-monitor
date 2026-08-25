import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyPipelineFailure, createSerializedJsonWriter, isPipelineAutofillEligible, isRetryablePipelineStartError, isStaleQueuedPipelineReservation, MAX_PIPELINE_AUTO_RETRIES, MAX_PIPELINE_CONCURRENCY, pendingPipelineReplacementSources, pipelineAbandonmentState, pipelineAutofillStartCapacity, pipelineCentralPriority, pipelineOccupiedJobIds, pipelineResumeUsesExistingAdmission, pipelineRetryState, projectPlanCheckpointConsumed, queuePipelineManualRetry, reconcilePipelineCloudUpload, reopenPipelineAbandonmentForManualRetry, runWorkerPool, selectPipelineAutofillCandidates, shouldRegenerateGeneratedProject } from './pipeline-concurrency.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('pipeline worker pool respects the configured project concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const results = await runWorkerPool([...Array(12).keys()], 20, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(10);
    active -= 1;
    return value * 2;
  });

  assert.equal(MAX_PIPELINE_CONCURRENCY, 4);
  assert.equal(peak, MAX_PIPELINE_CONCURRENCY);
  assert.equal(results.every((result) => result.status === 'fulfilled'), true);
});

test('pipeline start resource gates are queued for retry', () => {
  assert.equal(isRetryablePipelineStartError(new Error('Docker 资源维护正在排空或执行，暂不启动新流水线')), true);
  assert.equal(isRetryablePipelineStartError(new Error('主机资源保护已启用：磁盘空间不足')), true);
  assert.equal(isRetryablePipelineStartError(new Error('compute-docker 资源池已满')), true);
  assert.equal(isRetryablePipelineStartError(new Error('任务数据不完整')), false);
});

test('an existing Bug workbench resume keeps its project admission under degraded capacity', () => {
  const existing = {
    status: 'waiting_resource',
    startedAt: '2026-08-24T01:00:00.000Z',
    bugExecution: { mode: 'workbench' },
  };
  assert.equal(pipelineResumeUsesExistingAdmission(existing, true), true);
  assert.equal(pipelineResumeUsesExistingAdmission(existing, false), false);
  assert.equal(pipelineResumeUsesExistingAdmission({
    ...existing,
    status: 'draft',
  }, true), false);
  assert.equal(pipelineResumeUsesExistingAdmission({
    status: 'waiting_resource',
    bugExecution: { mode: 'workbench' },
  }, true), false);
});

test('auto-fill restores existing workbenches even when the dynamic project limit shrinks', () => {
  const running = [
    { id: 'running-a', status: 'running' },
    { id: 'running-b', status: 'running' },
  ];
  const waiting = {
    id: 'waiting-existing',
    status: 'waiting_resource',
    startedAt: '2026-08-24T01:00:00.000Z',
    bugExecution: { mode: 'workbench' },
  };
  assert.equal(pipelineAutofillStartCapacity([...running, waiting], 1, 4), 1);
  assert.equal(pipelineAutofillStartCapacity(running, 1, 4), 0);
  assert.equal(pipelineAutofillStartCapacity([waiting], 4, 4), 4);
});

test('pipeline worker failure does not stop remaining projects', async () => {
  const visited = [];
  const results = await runWorkerPool([...Array(8).keys()], 4, async (value) => {
    visited.push(value);
    if (value === 2) throw new Error('expected failure');
    await delay(2);
    return value;
  });

  assert.deepEqual([...visited].sort((a, b) => a - b), [...Array(8).keys()]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results[2].reason.message, 'expected failure');
});

test('a consumed project plan is not rerun when a downstream stage already started', () => {
  assert.equal(projectPlanCheckpointConsumed({
    project: { project_slug: 'retained-project' },
    stages: [
      { id: 'project_plan', scope: 'project', status: 'failed' },
      { id: 'project_generate', scope: 'project', status: 'passed' },
    ],
  }), true);
  assert.equal(projectPlanCheckpointConsumed({
    project: { project_slug: 'new-project' },
    stages: [
      { id: 'project_plan', scope: 'project', status: 'failed' },
      { id: 'project_generate', scope: 'project', status: 'pending' },
    ],
  }), false);
  assert.equal(projectPlanCheckpointConsumed({
    project: { project_slug: 'new-project' },
    stages: [{ id: 'project_plan', scope: 'project', status: 'passed' }],
  }), false);
});

test('pipeline auto-fill selects drafts and failed jobs with a bounded automatic retry count', () => {
  const jobs = [
    { id: 'draft-new', status: 'draft', createdAt: '2026-08-15T03:00:00Z' },
    { id: 'failed-old', status: 'failed', createdAt: '2026-08-15T00:00:00Z' },
    { id: 'failed-requested', status: 'failed', retryRequestedAt: '2026-08-15T04:00:00Z', createdAt: '2026-08-15T02:30:00Z' },
    { id: 'failed-exhausted', status: 'failed', autoRetryCount: MAX_PIPELINE_AUTO_RETRIES, createdAt: '2026-08-15T00:15:00Z' },
    { id: 'waiting-cloud', status: 'failed', currentStage: 'bug1_cloud_upload', error: '请先连接轨迹云盘', createdAt: '2026-08-15T00:10:00Z' },
    { id: 'invalid-baseline', status: 'failed', error: '已发布 main 基线不合格，停止自动重试', createdAt: '2026-08-15T00:05:00Z' },
    { id: 'draft-active', status: 'draft', createdAt: '2026-08-15T00:30:00Z' },
    { id: 'stopped-old', status: 'stopped', createdAt: '2026-08-15T01:00:00Z' },
    { id: 'draft-old', status: 'draft', createdAt: '2026-08-15T02:00:00Z' },
  ];

  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, ['draft-active'], 2).map((job) => job.id),
    ['failed-requested', 'failed-old'],
  );
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, [], 0), []);
});

test('one runner slot can execute one admitted heavy validation stage', () => {
  const validating = {
    id: 'validating',
    status: 'draft',
    createdAt: '2026-08-15T00:00:00Z',
    stages: [
      { id: 'project_plan', status: 'passed' },
      { id: 'project_generate', status: 'passed' },
      { id: 'project_validate', status: 'pending' },
    ],
  };
  assert.deepEqual(selectPipelineAutofillCandidates([validating], [], 1).map((job) => job.id), ['validating']);
});

test('central queue prioritizes manual retry, delivery, existing bugs, validation, generation, then planning', () => {
  const jobs = [
    { id: 'planning', status: 'draft', createdAt: '2026-08-17T00:00:00Z', stages: [{ id: 'project_plan', status: 'pending' }] },
    { id: 'generation', status: 'draft', createdAt: '2026-08-17T00:00:01Z', stages: [{ id: 'project_generate', status: 'pending' }] },
    { id: 'validation', status: 'waiting_resource', currentStage: 'project_validate', waitingResource: { queuedAt: '2026-08-17T00:00:02Z' } },
    { id: 'bug', status: 'waiting_resource', currentStage: 'bug2_gold_fix', waitingResource: { queuedAt: '2026-08-17T00:00:03Z' } },
    { id: 'delivery', status: 'waiting_resource', currentStage: 'bug1_cloud_upload', waitingResource: { queuedAt: '2026-08-17T00:00:04Z' } },
    { id: 'manual', status: 'failed', currentStage: 'project_generate', manualRetryRequestedAt: '2026-08-17T00:00:05Z' },
  ];
  assert.deepEqual(jobs.map((job) => pipelineCentralPriority(job)), [50, 40, 30, 20, 10, 0]);
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, [], 2).map((job) => job.id), ['manual', 'delivery']);
});

test('verification coverage review is classified and prioritized as a delivery-stage check', () => {
  const job = {
    status: 'failed',
    currentStage: 'bug1_verification_coverage',
    error: '公开模型回归测试覆盖复核不通过',
  };
  assert.equal(classifyPipelineFailure(job), 'verification_coverage');
  assert.equal(pipelineCentralPriority({ ...job, status: 'waiting_resource' }), 10);
});

test('central queue retains an explicitly retried stopped job until resources are available', () => {
  const selected = selectPipelineAutofillCandidates([
    {
      id: 'stopped-manual',
      status: 'stopped',
      workflowVersion: 2,
      currentStage: 'bug2_claude_fix',
      manualRetryRequestedAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'new-draft',
      status: 'draft',
      workflowVersion: 2,
      currentStage: 'project_plan',
      createdAt: '2026-08-19T00:01:00Z',
    },
  ], new Set(), 1);
  assert.deepEqual(selected.map((job) => job.id), ['stopped-manual']);
});

test('central queue resumes stopped project generation before starting a new plan', () => {
  const selected = selectPipelineAutofillCandidates([
    {
      id: 'stopped-generation',
      status: 'stopped',
      workflowVersion: 3,
      currentStage: 'project_generate',
      project: { project_slug: 'retained-project' },
      createdAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'new-plan',
      status: 'draft',
      workflowVersion: 3,
      currentStage: 'project_plan',
      stages: [{ id: 'project_plan', status: 'pending' }],
      createdAt: '2026-08-18T00:01:00Z',
    },
  ], new Set(), 1);
  assert.deepEqual(selected.map((job) => job.id), ['stopped-generation']);
});

test('central queue leaves explicitly user-stopped projects paused', () => {
  const selected = selectPipelineAutofillCandidates([
    {
      id: 'user-stopped-generation',
      status: 'stopped',
      workflowVersion: 3,
      currentStage: 'project_generate',
      project: { project_slug: 'retained-project' },
      bugExecution: { lastAction: 'user_stopped' },
    },
    {
      id: 'user-stopped-planning',
      status: 'stopped',
      workflowVersion: 3,
      currentStage: 'project_plan',
      bugExecution: { lastAction: 'user_stopped' },
    },
  ], new Set(), 2);
  assert.deepEqual(selected, []);
});

test('central queue leaves manually held resource waiters paused', () => {
  const selected = selectPipelineAutofillCandidates([{
    id: 'held-waiter',
    status: 'waiting_resource',
    currentStage: 'project_generate',
    manualRetryRequestedAt: '2026-08-24T14:00:00.000Z',
    manualHold: true,
  }], new Set(), 1);
  assert.deepEqual(selected, []);
});

test('central queue resumes stopped project planning before creating a new plan', () => {
  const selected = selectPipelineAutofillCandidates([
    {
      id: 'stopped-plan',
      status: 'stopped',
      workflowVersion: 3,
      currentStage: 'project_plan',
      createdAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'new-plan',
      status: 'draft',
      workflowVersion: 3,
      currentStage: 'project_plan',
      stages: [{ id: 'project_plan', status: 'pending' }],
      createdAt: '2026-08-18T00:01:00Z',
    },
  ], new Set(), 1);
  assert.deepEqual(selected.map((job) => job.id), ['stopped-plan']);
  assert.equal(pipelineCentralPriority({ status: 'stopped', currentStage: 'project_plan' }), 45);
  assert.equal(pipelineCentralPriority({ status: 'draft', currentStage: 'project_plan' }), 50);
});

test('manual retry at capacity becomes a visible resource waiter and clears the stale failure', () => {
  const queuedAt = '2026-08-19T12:45:00.000Z';
  const updated = queuePipelineManualRetry({
    id: 'manual-retry',
    status: 'failed',
    currentStage: 'bug6_gold_fix',
    error: 'stale Gold validation error',
    runnerPid: 12345,
    finishedAt: '2026-08-19T12:30:00.000Z',
    bugExecution: {
      selectedBugIndex: 6,
      status: 'fast_lane_running',
      startedAt: '2026-08-19T12:00:00.000Z',
      currentStage: 'bug6_gold_fix',
    },
    stages: [{ id: 'bug6_gold_fix', status: 'failed', startedAt: 'old', finishedAt: 'old', error: 'stale Gold validation error' }],
  }, queuedAt);
  assert.equal(updated.status, 'waiting_resource');
  assert.equal(updated.error, '');
  assert.equal(updated.runnerPid, null);
  assert.equal(updated.finishedAt, null);
  assert.equal(updated.manualRetryRequestedAt, queuedAt);
  assert.equal(updated.bugExecution.startedAt, null);
  assert.equal(updated.bugExecution.status, 'fast_lane_queued');
  assert.deepEqual(updated.waitingResource, {
    stageId: 'bug6_gold_fix',
    pool: 'compute-heavy',
    limit: 2,
    queuedAt,
    reason: 'manual_retry_capacity',
  });
  assert.deepEqual(updated.stages[0], {
    id: 'bug6_gold_fix',
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    error: '',
  });
  assert.deepEqual(selectPipelineAutofillCandidates([updated], [], 1).map((job) => job.id), ['manual-retry']);
});

test('central queue is FIFO within the same priority and includes resource waiters', () => {
  const jobs = [
    { id: 'later', status: 'waiting_resource', currentStage: 'project_validate', waitingResource: { queuedAt: '2026-08-17T00:02:00Z' } },
    { id: 'earlier', status: 'waiting_resource', currentStage: 'project_validate', waitingResource: { queuedAt: '2026-08-17T00:01:00Z' } },
  ];
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, [], 2).map((job) => job.id), ['earlier', 'later']);
});

test('pipeline auto-fill can start two project planning jobs concurrently', () => {
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    id: `planning-${index}`,
    status: 'draft',
    createdAt: `2026-08-15T00:0${index}:00Z`,
    stages: [{ id: 'project_plan', status: 'pending' }],
  }));
  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 2).map((job) => job.id),
    ['planning-0', 'planning-1'],
  );
});

test('pipeline auto-fill skips blocked priority jobs and fills capacity from later drafts', () => {
  const jobs = [
    {
      id: 'failed-awaiting-triage',
      status: 'failed',
      currentStage: 'bug1_gold_fix',
      retryRequestedAt: '2026-08-17T00:04:00Z',
      createdAt: '2026-08-17T00:00:00Z',
    },
    {
      id: 'draft-ready',
      status: 'draft',
      createdAt: '2026-08-17T00:01:00Z',
      stages: [{ id: 'project_plan', status: 'pending' }],
    },
  ];

  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, {
      candidatePredicate: (job) => job.id !== 'failed-awaiting-triage',
    }).map((job) => job.id),
    ['draft-ready'],
  );
});

test('strict continuation priority does not let new project generation bypass a waiting bug stage', () => {
  const jobs = [
    {
      id: 'waiting-bug',
      status: 'waiting_resource',
      currentStage: 'bug3_bug_source_prepare',
      waitingResource: { queuedAt: '2026-08-18T04:02:41Z' },
    },
    {
      id: 'new-project',
      status: 'draft',
      createdAt: '2026-08-18T04:00:13Z',
      stages: [{ id: 'project_generate', status: 'pending' }],
    },
  ];
  const blockedByPool = (job) => job.id !== 'waiting-bug';

  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, { candidatePredicate: blockedByPool }).map((job) => job.id),
    ['new-project'],
  );
  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, {
      candidatePredicate: blockedByPool,
      continuationPredicate: () => true,
      preserveContinuationPriority: true,
    }),
    [],
  );
});

test('strict continuation priority ignores a continuation blocked by an offline dependency', () => {
  const jobs = [
    { id: 'offline-bug', status: 'waiting_resource', currentStage: 'bug1_gold_fix' },
    { id: 'new-project', status: 'draft', stages: [{ id: 'project_generate', status: 'pending' }] },
  ];
  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, {
      candidatePredicate: (job) => job.id === 'new-project',
      continuationPredicate: (job) => job.id !== 'offline-bug',
      preserveContinuationPriority: true,
    }).map((job) => job.id),
    ['new-project'],
  );
});

test('any resource waiter blocks brand-new project planning and generation', () => {
  const jobs = [
    {
      id: 'waiting-resource',
      status: 'waiting_resource',
      currentStage: 'bug2_gold_fix',
      waitingResource: { queuedAt: '2026-08-18T05:00:00Z' },
    },
    {
      id: 'new-project',
      status: 'draft',
      createdAt: '2026-08-18T04:00:00Z',
      stages: [{ id: 'project_generate', status: 'pending' }],
    },
  ];

  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, {
      blockNewProjectOnAnyResourceWait: true,
      candidatePredicate: (job) => job.id !== 'waiting-resource',
      continuationPredicate: () => false,
      preserveContinuationPriority: true,
    }),
    [],
  );
  assert.deepEqual(
    selectPipelineAutofillCandidates(jobs, [], 1, {
      blockNewProjectOnAnyResourceWait: true,
    }).map((job) => job.id),
    ['waiting-resource'],
  );
});

test('pipeline retry state distinguishes automatic retries, exhaustion, and cloud waits', () => {
  assert.equal(pipelineRetryState({ status: 'failed', autoRetryCount: 1 }).automaticRetryPending, true);
  assert.equal(pipelineRetryState({ status: 'failed', autoRetryCount: 2 }).exhausted, true);
  const cloud = pipelineRetryState({ status: 'failed', currentStage: 'bug1_cloud_upload', error: '请先连接轨迹云盘', autoRetryCount: 2 });
  assert.equal(cloud.waitingForCloud, true);
  assert.equal(cloud.exhausted, false);
  assert.equal(cloud.automaticRetryPending, false);
  const baseline = pipelineRetryState({ status: 'failed', error: '已发布 main 基线不合格，停止自动重试' });
  assert.equal(baseline.nonRetryable, true);
  assert.equal(baseline.automaticRetryPending, false);
  const localBaseline = pipelineRetryState({ status: 'failed', workflowVersion: 2, currentStage: 'main_freeze', error: '本地冻结 main 静态检查失败（exit=1）' });
  assert.equal(localBaseline.nonRetryable, false);
  assert.equal(localBaseline.automaticRetryPending, true);
});

test('terminal failures are abandoned and replaced exactly once', () => {
  assert.equal(pipelineAbandonmentState({ status: 'failed', autoRetryCount: MAX_PIPELINE_AUTO_RETRIES }).shouldAbandon, false);
  assert.equal(pipelineAbandonmentState({ status: 'failed', autoRetryCount: MAX_PIPELINE_AUTO_RETRIES }).awaitingCodexTriage, true);
  assert.equal(pipelineAbandonmentState({ status: 'failed', autoRetryCount: MAX_PIPELINE_AUTO_RETRIES, abandonmentApprovedAt: '2026-08-15T12:00:00Z' }).shouldAbandon, true);
  assert.equal(pipelineAbandonmentState({ status: 'failed', error: '已发布 main 基线不合格，停止自动重试' }).reason, 'non_retryable');
  assert.equal(pipelineAbandonmentState({ status: 'failed', currentStage: 'bug1_cloud_upload', error: '请先连接轨迹云盘', autoRetryCount: 9 }).shouldAbandon, false);
  const jobs = [
    { id: 'needs-replacement', status: 'abandoned' },
    { id: 'linked-source', status: 'abandoned', replacementJobId: 'replacement-a' },
    { id: 'source-with-created-job', status: 'abandoned' },
    { id: 'replacement-b', status: 'draft', request: { replacesPipelineJobId: 'source-with-created-job' } },
  ];
  assert.deepEqual(pendingPipelineReplacementSources(jobs).map((job) => job.id), ['needs-replacement']);
});

test('an explicit manual retry can revoke an automated abandonment', () => {
  const reopened = reopenPipelineAbandonmentForManualRetry({
    id: 'recovered',
    status: 'abandoned',
    currentStage: 'project_validate',
    error: 'incorrect hard-rule conclusion',
    autoRetryCount: 2,
    abandonedAt: '2026-08-24T04:00:00Z',
    abandonmentApprovedAt: '2026-08-24T04:00:00Z',
    abandonmentApprovalIncidentId: 'incident-1',
    abandonReason: 'codex_hard_rule',
    repositoryDisposition: 'retained_abandoned',
    replacementJobId: 'replacement-1',
  }, '2026-08-24T05:00:00Z');
  assert.equal(reopened.changed, true);
  assert.equal(reopened.job.status, 'failed');
  assert.equal(reopened.job.currentStage, 'project_validate');
  assert.equal(reopened.job.autoRetryCount, 0);
  assert.equal(reopened.job.replacementJobId, undefined);
  assert.equal(reopened.job.abandonmentApprovedAt, undefined);
  assert.equal(reopened.job.manualRetryRequestedAt, '2026-08-24T05:00:00Z');
});

test('pipeline failures classify the four recoverable production errors', () => {
  const cases = [
    [{ status: 'failed', currentStage: 'bug1_bug_discovery', error: 'Sol 返回的 Bug 记录不完整：user_query 少于 60 个字符' }, 'bug_record', false],
    [{ status: 'failed', currentStage: 'bug1_bug_discovery', error: '[system:natural_bug_finder] 自然 Bug 搜索分区失败（1 个）' }, 'natural_bug_finder_infrastructure', false],
    [{ status: 'failed', currentStage: 'project_validate', error: '项目与双架构 Docker 校验失败：no required module provides package yaml.v3' }, 'project_validation', false],
    [{ status: 'failed', currentStage: 'project_generate', error: "ENOENT: no such file or directory, open '/job/project/go.mod'" }, 'project_generation', true],
    [{ status: 'failed', currentStage: 'bug1_claude_fix', error: 'Claude 修复失败（exit=1）' }, 'claude_trajectory', false],
  ];
  for (const [job, category, regenerate] of cases) {
    assert.equal(classifyPipelineFailure(job), category);
    assert.equal(shouldRegenerateGeneratedProject(job), regenerate);
  }
  const dockerOutage = { currentStage: 'project_validate', error: 'Cannot connect to the Docker daemon' };
  assert.equal(classifyPipelineFailure(dockerOutage), 'docker_infrastructure');
  assert.equal(classifyPipelineFailure({
    currentStage: 'bug8_claude_fix',
    error: 'FAILURE_CLASS=hidden_target\nerror waiting for container: unexpected EOF',
  }), 'docker_infrastructure');
  assert.equal(classifyPipelineFailure({
    currentStage: 'project_validate',
    error: 'failed to solve: unable to lease content: lease does not exist: not found',
  }), 'docker_infrastructure');
  assert.equal(classifyPipelineFailure({
    currentStage: 'project_validate',
    error: 'failed to fetch anonymous token: Get registry-1.docker.io: i/o timeout',
  }), 'docker_infrastructure');
  assert.equal(shouldRegenerateGeneratedProject(dockerOutage), false);
  const gitOutage = { currentStage: 'bug3_claude_fix', error: 'Connection closed by 198.18.0.15 port 22\nfatal: Could not read from remote repository.' };
  assert.equal(classifyPipelineFailure(gitOutage), 'git_infrastructure');
  assert.equal(shouldRegenerateGeneratedProject(gitOutage), false);
  const resourceSlotRace = {
    status: 'failed',
    currentStage: 'bug28_bug_discovery',
    error: "ENOENT: no such file or directory, rename '/pipeline-refill/resource-slots/compute-heavy/slot-1/owner.json.81132.tmp' -> '/pipeline-refill/resource-slots/compute-heavy/slot-1/owner.json'",
  };
  assert.equal(classifyPipelineFailure(resourceSlotRace), 'runner_infrastructure');
  const localBaseline = { status: 'failed', currentStage: 'main_freeze', error: 'go vet failed' };
  assert.equal(classifyPipelineFailure(localBaseline), 'main_baseline_validation');
  assert.equal(shouldRegenerateGeneratedProject(localBaseline), true);
});

test('waiting stage transitions never regenerate an already validated project', () => {
  for (const currentStage of ['project_generate', 'main_freeze']) {
    const waiting = {
      status: 'waiting_resource',
      currentStage,
      error: '',
      stages: [{ id: currentStage, status: 'pending', error: '' }],
    };
    assert.equal(classifyPipelineFailure(waiting), 'other');
    assert.equal(shouldRegenerateGeneratedProject(waiting), false);
  }

  const staleErrorOnPendingStage = {
    status: 'failed',
    currentStage: 'main_freeze',
    error: 'go vet failed',
    stages: [{ id: 'main_freeze', status: 'pending', error: '' }],
  };
  assert.equal(shouldRegenerateGeneratedProject(staleErrorOnPendingStage), false);

  const realFailure = {
    status: 'failed',
    currentStage: 'main_freeze',
    error: 'go vet failed',
    stages: [{ id: 'main_freeze', status: 'failed', error: 'go vet failed' }],
  };
  assert.equal(shouldRegenerateGeneratedProject(realFailure), true);
});

test('snapshot infrastructure failures do not regenerate the Claude project', () => {
  for (const error of [
    '生成前数据快照失败（exit=1）：tar: lseek(SEEK_HOLE) failed: Resource deadlock avoided',
    '等待数据快照超时，拒绝启动 Claude 项目生成',
    'tar: (null)',
  ]) {
    const job = { currentStage: 'project_generate', status: 'failed', error };
    assert.equal(classifyPipelineFailure(job), 'snapshot_infrastructure');
    assert.equal(shouldRegenerateGeneratedProject(job), false);
  }
});

test('failure classification falls back to the current stage error', () => {
  const job = {
    status: 'failed',
    currentStage: 'project_generate',
    error: '',
    stages: [{ id: 'project_generate', error: '生成前数据快照失败：SEEK_HOLE' }],
  };
  assert.equal(classifyPipelineFailure(job), 'snapshot_infrastructure');
});

test('snapshot outage circuit breaker starts only one recovery probe', () => {
  const jobs = [
    { id: 'snapshot-a', status: 'failed', currentStage: 'project_generate', error: '生成前数据快照失败：SEEK_HOLE', createdAt: '2026-08-17T00:00:00Z' },
    { id: 'snapshot-b', status: 'failed', currentStage: 'project_generate', error: '等待数据快照超时', createdAt: '2026-08-17T00:01:00Z' },
    { id: 'draft-a', status: 'draft', createdAt: '2026-08-17T00:02:00Z', stages: [{ id: 'project_plan', status: 'pending' }] },
  ];
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, [], 4).map((job) => job.id), ['snapshot-a']);
  jobs.push({ id: 'active-probe', status: 'running', currentStage: 'project_generate', stages: [{ id: 'project_generate', startedAt: '2026-08-17T00:03:00Z' }] });
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, ['active-probe'], 3, { nowMs: Date.parse('2026-08-17T00:03:30Z') }).map((job) => job.id), ['draft-a']);
  jobs.at(-1).logs = [{ at: '2026-08-17T00:03:30Z', stageId: 'project_generate', message: '生成前数据快照已就绪：critical-test.tar.gz' }];
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, ['active-probe'], 3, { nowMs: Date.parse('2026-08-17T00:03:30Z') }).map((job) => job.id), ['snapshot-a']);
  assert.deepEqual(selectPipelineAutofillCandidates(jobs, ['active-probe'], 3, { snapshotInProgress: true, nowMs: Date.parse('2026-08-17T00:03:30Z') }).map((job) => job.id), ['draft-a']);
});

test('system-side trajectory failures are not mislabeled as Claude failures', () => {
  assert.equal(classifyPipelineFailure({
    currentStage: 'bug1_claude_fix',
    error: '[system:grader_collision] GRADER_COLLISION TestOne redeclared',
  }), 'grader_infrastructure');
  assert.equal(classifyPipelineFailure({
    currentStage: 'bug1_trajectory_validate',
    error: '[system:audit_infrastructure] mutation-audit 未记录 PostToolUse 审计快照',
  }), 'audit_infrastructure');
  assert.equal(classifyPipelineFailure({
    currentStage: 'bug1_claude_fix',
    error: 'Claude 修复失败: Cannot connect to the Docker daemon',
  }), 'docker_infrastructure');
});

test('auto-fill includes current jobs and only explicitly retried legacy jobs', () => {
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 2 }, 2), true);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 1 }, 2), false);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 1, retryRequestedAt: '2026-08-15T09:00:00Z' }, 2), false);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 1, legacyAutoRetryEnabled: true }, 2), true);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 2, verificationPolicyVersion: 0 }, 2, 5), false);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 2, verificationPolicyVersion: 5 }, 2, 5), true);
  assert.equal(isPipelineAutofillEligible({ workflowVersion: 2, verificationPolicyVersion: 0, legacyAutoRetryEnabled: true }, 2, 5), true);
});

test('pipeline occupied slots survive a monitor-server restart', () => {
  assert.deepEqual(
    [...pipelineOccupiedJobIds([
      { id: 'queued-job', status: 'queued' },
      { id: 'running-job', status: 'running' },
      { id: 'failed-job', status: 'failed' },
      { id: 'draft-job', status: 'draft' },
    ])].sort(),
    ['queued-job', 'running-job'],
  );
});

test('queued reservations without a scheduler lease or live Runner are stale', () => {
  assert.equal(isStaleQueuedPipelineReservation({ id: 'stale', status: 'queued', schedulerLease: null }), true);
  assert.equal(isStaleQueuedPipelineReservation({ id: 'starting', status: 'queued', schedulerLease: { stageId: 'main_freeze' } }), false);
  assert.equal(isStaleQueuedPipelineReservation({ id: 'adopted', status: 'queued', schedulerLease: null }, new Set(['adopted'])), false);
  assert.equal(isStaleQueuedPipelineReservation({ id: 'waiting', status: 'waiting_resource' }), false);
});

test('cloud upload reconciliation completes a one-bug pipeline without a runner slot', () => {
  const job = {
    id: 'pipeline-one',
    status: 'failed',
    currentStage: 'bug1_cloud_upload',
    error: '请先连接轨迹云盘',
    bugs: [{ bugIndex: 1, task: { taskName: 'task-one' } }],
    stages: [
      { id: 'project_plan', status: 'passed' },
      { id: 'bug1_cloud_upload', status: 'failed', error: '请先连接轨迹云盘' },
      { id: 'bug1_delivery_ready', status: 'pending' },
    ],
  };
  const updated = reconcilePipelineCloudUpload(job, [{ task: 'task-one', taskId: 'task-1', sessionId: 'session-1', signedUrl: 'https://cloud.test/trajectory.json' }], '2026-08-15T09:00:00.000Z');
  assert.equal(updated.status, 'passed');
  assert.equal(updated.currentStage, null);
  assert.equal(updated.stages.at(-2).status, 'passed');
  assert.equal(updated.stages.at(-1).result.trajectoryUrl, 'https://cloud.test/trajectory.json');
  assert.equal(job.status, 'failed');
});

test('cloud upload reconciliation completes a V5 verification-finalize stage for a qualified task', () => {
  const job = {
    id: 'pipeline-v5',
    status: 'failed',
    currentStage: 'bug1_verification_finalize',
    bugs: [{ bugIndex: 1, task: { taskName: 'task-v5' } }],
    stages: [
      { id: 'bug1_verification_coverage', status: 'passed' },
      { id: 'bug1_cloud_upload', status: 'passed' },
      { id: 'bug1_verification_finalize', status: 'pending' },
      { id: 'bug1_delivery_ready', status: 'passed' },
    ],
  };
  const updated = reconcilePipelineCloudUpload(
    job,
    [{ task: 'task-v5', taskId: 'task-v5-id', sessionId: 'session-v5', signedUrl: 'https://cloud.test/trajectory.jsonl' }],
    '2026-08-17T14:00:00.000Z',
    { verificationExportReadyTaskIds: new Set(['task-v5-id']) },
  );
  assert.equal(updated.status, 'passed');
  assert.equal(updated.currentStage, null);
  assert.equal(updated.stages[2].status, 'passed');
  assert.equal(updated.stages[2].result.reconciled, true);
});

test('V5 cloud recovery cannot skip a pending verification coverage review', () => {
  const job = {
    id: 'pipeline-v5-pending-coverage',
    status: 'failed',
    currentStage: 'bug1_verification_finalize',
    bugs: [{ bugIndex: 1, task: { taskName: 'task-v5' } }],
    stages: [
      { id: 'bug1_verification_coverage', status: 'pending' },
      { id: 'bug1_cloud_upload', status: 'passed' },
      { id: 'bug1_verification_finalize', status: 'pending' },
      { id: 'bug1_delivery_ready', status: 'pending' },
    ],
  };
  const updated = reconcilePipelineCloudUpload(
    job,
    [{ task: 'task-v5', taskId: 'task-v5-id', signedUrl: 'https://cloud.test/trajectory.jsonl' }],
    '2026-08-17T14:00:00.000Z',
    { verificationExportReadyTaskIds: new Set(['task-v5-id']) },
  );
  assert.equal(updated, null);
});

test('V5 cloud recovery requires the task to pass the Excel verification preflight', () => {
  const job = {
    id: 'pipeline-v5-invalid-export',
    status: 'failed',
    currentStage: 'bug1_verification_finalize',
    bugs: [{ bugIndex: 1, task: { taskName: 'task-v5' } }],
    stages: [
      { id: 'bug1_verification_coverage', status: 'passed' },
      { id: 'bug1_cloud_upload', status: 'passed' },
      { id: 'bug1_verification_finalize', status: 'pending' },
      { id: 'bug1_delivery_ready', status: 'pending' },
    ],
  };
  const updated = reconcilePipelineCloudUpload(
    job,
    [{ task: 'task-v5', taskId: 'task-v5-id', signedUrl: 'https://cloud.test/trajectory.jsonl' }],
    '2026-08-17T14:00:00.000Z',
    { verificationExportReadyTaskIds: new Set() },
  );
  assert.equal(updated, null);
});

test('cloud upload reconciliation queues remaining bug stages without consuming a model retry', () => {
  const job = {
    id: 'pipeline-two',
    status: 'failed',
    currentStage: 'bug1_cloud_upload',
    autoRetryCount: 2,
    bugs: [{ bugIndex: 1, task: { taskName: 'task-one' } }],
    stages: [
      { id: 'bug1_cloud_upload', status: 'failed' },
      { id: 'bug1_delivery_ready', status: 'pending' },
      { id: 'bug2_bug_discovery', status: 'pending' },
    ],
  };
  const updated = reconcilePipelineCloudUpload(job, [{ task: 'task-one', taskId: 'task-1', signedUrl: 'https://cloud.test/trajectory.json' }], '2026-08-15T09:00:00.000Z');
  assert.equal(updated.status, 'failed');
  assert.equal(updated.currentStage, 'bug2_bug_discovery');
  assert.equal(updated.autoRetryCount, 0);
  assert.equal(updated.retryRequestedAt, '2026-08-15T09:00:00.000Z');
  assert.equal(pipelineRetryState(updated).automaticRetryPending, true);
});

test('serialized manifest writer preserves call order without temporary files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-manifest-test-'));
  const filename = path.join(directory, 'manifest.json');
  const write = createSerializedJsonWriter(filename);
  try {
    await Promise.all([...Array(20).keys()].map((version) => write({ version })));
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { version: 19 });
    assert.deepEqual(await readdir(directory), ['manifest.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
