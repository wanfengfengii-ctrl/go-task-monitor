import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advancePipelineTaskTypeCounts,
  allocatePipelineTaskTypes,
  autoRefillProjectTiers,
  allocateProjectDomainFamilies,
  countIncompletePipelineProjects,
  pipelineRefillCapacity,
  largeProjectCanaryBenchmark,
  normalizePipelineRefillPlan,
  normalizeLargeProjectCanary,
  pipelineCommittedTaskTypeCounts,
  recordLargeProjectCanaryJob,
  reconcileLargeProjectCanary,
  pipelineSupplySnapshot,
  reconcilePipelineRefillCreatedJobs,
  shouldStartPipelineRefill,
} from './pipeline-refill.js';

test('new task-type allocation starts from zero and keeps a cumulative 6/4 split', () => {
  const firstTen = allocatePipelineTaskTypes(10);
  assert.equal(firstTen.filter((taskType) => taskType === 'bugfix').length, 6);
  assert.equal(firstTen.filter((taskType) => taskType === 'diagnosis').length, 4);
  assert.deepEqual(advancePipelineTaskTypeCounts({}, firstTen), { bugfix: 6, diagnosis: 4 });
});

test('small replacement batches continue the new ratio without reading history', () => {
  const first = allocatePipelineTaskTypes(2);
  const counts = advancePipelineTaskTypeCounts({}, first);
  const second = allocatePipelineTaskTypes(2, counts);
  assert.deepEqual(first, ['bugfix', 'bugfix']);
  assert.deepEqual(second, ['diagnosis', 'bugfix']);
  assert.deepEqual(advancePipelineTaskTypeCounts(counts, second), { bugfix: 3, diagnosis: 1 });
});

test('task-type allocation weights standard and large projects by their question counts', () => {
  const taskTypes = allocatePipelineTaskTypes(4, {}, [30, 30, 10, 10]);
  assert.deepEqual(taskTypes, ['bugfix', 'diagnosis', 'bugfix', 'bugfix']);
  assert.deepEqual(
    advancePipelineTaskTypeCounts({}, taskTypes, [30, 30, 10, 10]),
    { bugfix: 50, diagnosis: 30 },
  );
});

test('task-type policy seeds its question counts from non-abandoned project commitments', () => {
  assert.deepEqual(pipelineCommittedTaskTypeCounts([
    { status: 'passed', request: { taskType: 'bugfix', bugCount: 10 } },
    { status: 'running', request: { taskType: 'diagnosis', bugCount: 30 } },
    { status: 'stopped', request: { taskType: 'diagnosis', bugCount: 10 } },
    { status: 'abandoned', request: { taskType: 'bugfix', bugCount: 30 } },
  ]), { bugfix: 10, diagnosis: 30 });
});

function plan() {
  const domains = [
    'industrial-manufacturing',
    'infrastructure-utilities',
    'transportation-safety',
    'scientific-instrumentation',
    'agriculture-food',
    'environment-geoscience',
    'healthcare-life-science',
    'culture-archives',
    'communications-security',
    'aerospace-marine',
  ];
  return {
    questions: Array.from({ length: 10 }, (_, index) => ({
      title: `中文项目题目${index + 1}`,
      projectBrief: `设计一个面向场景${index + 1}的原创 Go 服务，需要包含并发状态管理、持久化、错误恢复、HTTP 接口和可确定复现的公开测试，并明确边界行为与双架构容器验证要求。`,
      projectDomain: domains[index],
    })),
  };
}

test('pipeline refill plan creates ten distinct standard questions with a deterministic 6/4 task split', () => {
  const questions = normalizePipelineRefillPlan(plan(), { count: 10 });
  assert.equal(questions.length, 10);
  assert.equal(questions.filter((item) => item.taskType === 'bugfix').length, 6);
  assert.equal(questions.filter((item) => item.taskType === 'diagnosis').length, 4);
  assert.equal(questions.filter((item) => item.projectTier === 'large').length, 0);
  assert.equal(questions.filter((item) => item.projectTier === 'standard').length, 10);
  assert.deepEqual(questions.map((item) => item.bugCount), Array(10).fill(10));
  assert.equal(questions.filter((item) => item.frontendRequired).length, 3);
});

test('automatic refill is standard by default and can promote a bounded canary prefix', () => {
  assert.deepEqual(autoRefillProjectTiers(1), ['standard']);
  assert.deepEqual(autoRefillProjectTiers(2), ['standard', 'standard']);
  assert.deepEqual(autoRefillProjectTiers(3), ['standard', 'standard', 'standard']);
  assert.deepEqual(autoRefillProjectTiers(3, { largeCount: 2 }), ['large', 'large', 'standard']);
});

test('large-project canary derives remaining capacity from persisted and discovered jobs', () => {
  const armed = normalizeLargeProjectCanary({ id: 'canary-1', targetCount: 2 });
  assert.equal(armed.status, 'armed');
  assert.equal(armed.remainingCount, 2);
  const reconciled = reconcileLargeProjectCanary(armed, [
    { id: 'large-1', request: { largeProjectCanaryId: 'canary-1' } },
    { id: 'other', request: { largeProjectCanaryId: 'canary-2' } },
  ]);
  assert.deepEqual(reconciled.createdJobIds, ['large-1']);
  assert.equal(reconciled.remainingCount, 1);
});

test('large-project canary records a created job from its public job id', () => {
  const completed = recordLargeProjectCanaryJob({ id: 'canary-1', targetCount: 1 }, 'large-1');
  assert.deepEqual(completed.createdJobIds, ['large-1']);
  assert.equal(completed.remainingCount, 0);
  assert.equal(completed.status, 'completed');
});

test('large-project canary benchmark reports wall time and per-stage elapsed time', () => {
  const benchmark = largeProjectCanaryBenchmark({
    id: 'canary-1',
    targetCount: 2,
    createdJobIds: ['large-1', 'large-2'],
  }, [{
    id: 'large-1',
    status: 'passed',
    createdAt: '2026-08-24T00:00:00.000Z',
    startedAt: '2026-08-24T00:10:00.000Z',
    finishedAt: '2026-08-24T02:00:00.000Z',
    request: { bugCount: 30, largeProjectCanaryId: 'canary-1' },
    stages: [{ id: 'project_validate', cumulativeDurationMs: 30 * 60_000 }],
    bugs: [{ disposition: 'delivered' }],
  }, {
    id: 'large-2',
    status: 'running',
    currentStage: 'project_generate',
    createdAt: '2026-08-24T00:30:00.000Z',
    startedAt: '2026-08-24T00:40:00.000Z',
    request: { bugCount: 30, largeProjectCanaryId: 'canary-1' },
  }], { nowMs: Date.parse('2026-08-24T03:00:00.000Z') });
  assert.equal(benchmark.status, 'running');
  assert.equal(benchmark.passedCount, 1);
  assert.equal(benchmark.activeCount, 1);
  assert.equal(benchmark.wallElapsedMs, 3 * 60 * 60_000);
  assert.equal(benchmark.runs[0].projectValidateMs, 30 * 60_000);
  assert.equal(benchmark.runs[0].deliveredBugCount, 1);
});

test('pipeline refill plan rejects duplicate or incomplete Codex output', () => {
  const duplicated = plan();
  duplicated.questions[9] = {
    ...duplicated.questions[9],
    title: duplicated.questions[0].title,
    projectBrief: duplicated.questions[0].projectBrief,
  };
  assert.throws(() => normalizePipelineRefillPlan(duplicated, { count: 10 }), /互不重复/);
  assert.throws(() => normalizePipelineRefillPlan({ questions: [] }, { count: 10 }), /必须一次返回 10/);
});

test('automatic refill assigns low-frequency domains and does not repeat within a batch', () => {
  const jobs = [{
    createdAt: '2026-08-19T00:00:00.000Z',
    request: { projectDomain: 'agriculture-food' },
  }];
  const assigned = allocateProjectDomainFamilies(jobs, 4);
  assert.equal(new Set(assigned.map((item) => item.id)).size, 4);
  assert.equal(assigned.some((item) => item.id === 'agriculture-food'), false);
});

test('pipeline refill rejects a model-selected domain that differs from the assigned domain', () => {
  const input = plan();
  input.questions[0].projectDomain = 'culture-archives';
  assert.throws(() => normalizePipelineRefillPlan(input, { count: 10 }), /必须使用系统分配的 industrial-manufacturing/);
});

test('refill preserves assigned project tiers and recalculates Bug counts from tier', () => {
  const replacementPlan = { questions: plan().questions.slice(0, 2) };
  const questions = normalizePipelineRefillPlan(replacementPlan, {
    count: 2,
    taskTypes: ['diagnosis', 'bugfix'],
    projectTiers: ['large', 'standard'],
    bugCounts: [5, 5],
    frontendFlags: [true, false],
  });
  assert.deepEqual(questions.map((item) => item.taskType), ['diagnosis', 'bugfix']);
  assert.deepEqual(questions.map((item) => [item.projectTier, item.bugCount, item.frontendRequired]), [['large', 30, true], ['standard', 10, false]]);
});

test('pipeline refill starts when runnable supply is empty, even while the last project is running', () => {
  const options = { autoFillEnabled: true, currentWorkflowVersion: 2, refillState: {} };
  assert.equal(shouldStartPipelineRefill([{ id: 'done', status: 'passed', workflowVersion: 2 }], options).start, true);
  assert.equal(shouldStartPipelineRefill([{ id: 'draft', status: 'draft', workflowVersion: 2 }], options).start, false);
  assert.equal(shouldStartPipelineRefill([], options).targetCount, 2);
  assert.equal(shouldStartPipelineRefill([
    { id: 'one', status: 'running' },
    { id: 'two', status: 'failed' },
    { id: 'three', status: 'waiting_resource' },
    { id: 'four', status: 'draft' },
  ], options).reason, 'incomplete-project-limit');
  assert.equal(shouldStartPipelineRefill([
    { id: 'one', status: 'running' },
    { id: 'two', status: 'failed' },
  ], options).capacity, 2);
  const runningOnly = shouldStartPipelineRefill([{ id: 'running', status: 'running', workflowVersion: 2 }], options);
  assert.equal(runningOnly.start, true);
  assert.equal(runningOnly.reason, 'supply-empty');
  assert.equal(runningOnly.supply.idle, false);
  assert.equal(runningOnly.supply.depleted, true);
  assert.equal(shouldStartPipelineRefill([{ id: 'cloud', status: 'failed', workflowVersion: 2, currentStage: 'bug1_cloud_upload', error: '请先连接轨迹云盘' }], options).start, false);
  assert.equal(pipelineSupplySnapshot([{ id: 'done', status: 'passed', workflowVersion: 2 }], 2).idle, true);
  const replacement = shouldStartPipelineRefill([
    { id: 'running', status: 'running', workflowVersion: 2 },
    { id: 'abandoned', status: 'abandoned', workflowVersion: 2, request: { taskType: 'diagnosis' } },
  ], options);
  assert.equal(replacement.start, true);
  assert.equal(replacement.reason, 'replace-abandoned');
  assert.equal(replacement.targetCount, 1);
  assert.deepEqual(replacement.replacementSourceJobIds, ['abandoned']);
});

test('pipeline refill resumes a stopped project plan instead of creating a new plan', () => {
  const result = shouldStartPipelineRefill([
    {
      id: 'stopped-plan',
      status: 'stopped',
      workflowVersion: 3,
      currentStage: 'project_plan',
      stages: [{ id: 'project_plan', status: 'pending' }],
    },
  ], {
    autoFillEnabled: true,
    currentWorkflowVersion: 3,
    refillState: {},
  });
  assert.equal(result.start, false);
  assert.equal(result.reason, 'pipeline-supply-available');
  assert.equal(result.supply.runnableCount, 1);
});

test('incomplete project budget counts failed work until it is abandoned', () => {
  const jobs = [
    { status: 'passed' },
    { status: 'abandoned' },
    { status: 'stopped' },
    { status: 'draft' },
    { status: 'failed' },
    { status: 'failed', manualHold: true },
  ];
  assert.equal(countIncompletePipelineProjects(jobs), 2);
  assert.equal(pipelineRefillCapacity(jobs), 2);
});

test('pipeline refill ignores historical drafts that predate the current verification policy', () => {
  const result = shouldStartPipelineRefill([
    { id: 'legacy-draft', status: 'draft', workflowVersion: 2, verificationPolicyVersion: 0 },
  ], {
    autoFillEnabled: true,
    currentWorkflowVersion: 2,
    currentVerificationPolicyVersion: 5,
    refillState: {},
  });
  assert.equal(result.start, true);
  assert.equal(result.reason, 'supply-empty');
  assert.equal(result.supply.runnableCount, 0);
});

test('pipeline refill honors failure cooldown and can resume an incomplete persisted batch', () => {
  const jobs = [{ id: 'done', status: 'passed', workflowVersion: 2 }];
  const cooling = shouldStartPipelineRefill(jobs, {
    autoFillEnabled: true,
    currentWorkflowVersion: 2,
    refillState: { status: 'failed', retryAfter: 2000 },
    nowMs: 1000,
  });
  assert.equal(cooling.start, false);
  assert.equal(cooling.reason, 'failure-cooldown');
  const resume = shouldStartPipelineRefill(jobs, {
    autoFillEnabled: true,
    currentWorkflowVersion: 2,
    refillState: { status: 'provisioning' },
    nowMs: 3000,
  });
  assert.equal(resume.start, true);
  assert.equal(resume.reason, 'resume-incomplete-batch');
});

test('pipeline refill recovery removes job ids that no longer exist in the active batch', () => {
  const refill = reconcilePipelineRefillCreatedJobs({
    batchId: 'batch-current',
    createdJobIds: ['existing', 'missing', 'other-batch', 'existing'],
  }, [
    { id: 'existing', request: { autoRefillBatchId: 'batch-current' } },
    { id: 'other-batch', request: { autoRefillBatchId: 'batch-old' } },
  ]);
  assert.deepEqual(refill.createdJobIds, ['existing']);
});
