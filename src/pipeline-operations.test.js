import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectHostResourceSnapshot,
  normalizePipelineControlMode,
  nextPipelineStage,
  parseDockerBuildxReclaimableBytes,
  parseDockerSize,
  parsePipelineRunnerProcesses,
  parseOrphanedPipelineProcesses,
  pipelineDailyBudget,
  pipelineDependencyServiceForIncident,
  pipelineDockerBusyJobIds,
  pipelineDockerMaintenanceAction,
  pipelineDiskCleanupPlan,
  pipelineJobStartBlockers,
  pipelineHardStallTerminationScope,
  pipelineHeavyLane,
  pipelineOccupiedWeight,
  pipelineRepairWorkerLimit,
  pipelineResourcePoolState,
  pipelineResourcePolicy,
  pipelineStageHealthBlockers,
  pipelineStageRequiredServices,
  pipelineStageResourceProfile,
  pipelineStageStartCapacity,
  pipelineStageUsesDocker,
  pipelineStageWeight,
  pipelineStructuredCodexLimit,
  selectPipelineDisplayStage,
  shouldQueuePipelineRetry,
  triageActionPlan,
} from './pipeline-operations.js';

test('repair concurrency defaults to six workers and supports an eight-worker sprint override', () => {
  assert.equal(pipelineRepairWorkerLimit({}), 6);
  assert.equal(pipelineRepairWorkerLimit({ GO_PIPELINE_REPAIR_WORKER_LIMIT: '8' }), 8);
  assert.equal(pipelineRepairWorkerLimit({ GO_PIPELINE_REPAIR_WORKER_LIMIT: '99' }), 8);
  assert.equal(pipelineRepairWorkerLimit({ GO_PIPELINE_REPAIR_WORKER_LIMIT: 'invalid' }), 6);
});

test('structured Codex work uses four slots and contracts only under extreme host load', () => {
  assert.equal(pipelineStructuredCodexLimit({ configuredLimit: 4, loadAverage: 8, cpuCount: 10 }), 4);
  assert.equal(pipelineStructuredCodexLimit({ configuredLimit: 4, loadAverage: 30, cpuCount: 10 }), 4);
  assert.equal(pipelineStructuredCodexLimit({ configuredLimit: 4, loadAverage: 50, cpuCount: 10 }), 2);
  assert.equal(pipelineStructuredCodexLimit({ configuredLimit: 4, loadAverage: 70, cpuCount: 10 }), 1);
});

test('pipeline display ignores a stale completed discovery cursor', () => {
  const stages = [
    { id: 'bug3_bug_discovery', status: 'passed', label: 'Sol 优先寻找自然 Bug' },
    { id: 'bug5_claude_fix', status: 'running', label: 'Claude 修复并生成公开回归测试' },
  ];
  assert.equal(selectPipelineDisplayStage(stages, { currentStage: 'bug3_bug_discovery' }).id, 'bug5_claude_fix');
});

test('pipeline display prefers the real running repair over a stale BUG_BASE workbench entry', () => {
  const stages = [
    { id: 'bug8_bug_source_prepare', status: 'passed', label: '确定独立 BUG_BASE' },
    { id: 'bug1_claude_fix', status: 'running', label: 'Claude 修复并生成公开回归测试' },
  ];
  const staleBug = { workbench: { currentStage: 'bug8_bug_source_prepare' } };
  assert.equal(selectPipelineDisplayStage(stages, { currentStage: 'bug1_claude_fix' }, staleBug).id, 'bug1_claude_fix');
});

test('pipeline display ignores a pending retry cursor while the project is running', () => {
  const stages = [
    { id: 'bug2_bug_source_prepare', status: 'pending', label: '确定独立 BUG_BASE' },
    { id: 'bug1_bug_source_prepare', status: 'failed', label: '注入候选失败' },
  ];
  assert.equal(selectPipelineDisplayStage(stages, {
    status: 'running',
    currentStage: 'bug2_bug_source_prepare',
  }).id, 'bug1_bug_source_prepare');
});

test('pipeline display falls forward to the next pending stage during a resource handoff', () => {
  const stages = [
    { id: 'bug1_trajectory_validate', status: 'passed', label: '主轨迹采集登记' },
    { id: 'bug1_pre_verify', status: 'pending', label: '修复前红测' },
  ];
  assert.equal(selectPipelineDisplayStage(stages, {
    status: 'running',
    currentStage: 'bug1_trajectory_validate',
  }).id, 'bug1_pre_verify');
});

test('pipeline control mode preserves explicit pause and supports legacy scheduler state', () => {
  assert.equal(normalizePipelineControlMode('draining'), 'draining');
  assert.equal(normalizePipelineControlMode('', false), 'paused');
  assert.equal(normalizePipelineControlMode('', true), 'running');
});

test('workbench-selected Bug determines scheduler admission before global pending stages', () => {
  const job = {
    status: 'stopped',
    currentStage: 'bug9_gold_fix',
    bugExecution: { selectedBugIndex: 9, currentStage: 'bug9_gold_fix' },
    stages: [
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'pending' },
      { id: 'bug9_gold_fix', bugIndex: 9, status: 'failed' },
      { id: 'bug9_task_prepare', bugIndex: 9, status: 'pending' },
    ],
  };
  assert.equal(nextPipelineStage(job), 'bug9_gold_fix');
  job.currentStage = 'bug3_claude_fix';
  job.bugExecution.currentStage = '';
  assert.equal(nextPipelineStage(job), 'bug9_gold_fix');
});

test('selected Bug remains authoritative when an earlier discovery stage is pending', () => {
  assert.equal(nextPipelineStage({
    status: 'running',
    currentStage: 'bug3_claude_fix',
    bugExecution: { selectedBugIndex: 3, currentStage: 'bug3_claude_fix', status: 'fast_lane_running' },
    stages: [
      { id: 'bug1_bug_discovery', phase: 'selection', stage: 'bug_discovery', status: 'pending' },
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'running' },
    ],
  }), 'bug3_claude_fix');
});

test('selected Bug resumes at its first pending stage after a stale cursor', () => {
  assert.equal(nextPipelineStage({
    status: 'waiting_resource',
    currentStage: 'bug3_verification_coverage',
    bugExecution: { selectedBugIndex: 3, currentStage: 'bug3_verification_coverage' },
    stages: [
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'pending' },
      { id: 'bug3_verification_coverage', bugIndex: 3, status: 'pending' },
    ],
  }), 'bug3_claude_fix');
});

test('batch user-query review never preempts unfinished Bug discovery after a restart', () => {
  const job = {
    status: 'stopped',
    currentStage: 'bug1_user_query_review',
    bugExecution: { selectedBugIndex: null },
    stages: [
      { id: 'project_plan', scope: 'project', status: 'passed' },
      { id: 'bug1_bug_discovery', phase: 'selection', stage: 'bug_discovery', status: 'passed' },
      { id: 'bug1_bug_source_prepare', phase: 'selection', stage: 'bug_source_prepare', status: 'passed' },
      { id: 'bug1_user_query_review', phase: 'selection', stage: 'user_query_review', status: 'pending' },
      { id: 'bug2_bug_discovery', phase: 'selection', stage: 'bug_discovery', status: 'pending' },
      { id: 'bug2_bug_source_prepare', phase: 'selection', stage: 'bug_source_prepare', status: 'pending' },
      { id: 'bug2_user_query_review', phase: 'selection', stage: 'user_query_review', status: 'pending' },
      { id: 'main_publish', scope: 'project', status: 'pending' },
    ],
  };
  assert.equal(nextPipelineStage(job), 'bug2_bug_discovery');
  job.stages[3].status = 'skipped';
  job.stages[4].status = 'passed';
  assert.equal(nextPipelineStage(job), 'bug2_bug_source_prepare');
  job.stages[5].status = 'passed';
  assert.equal(nextPipelineStage(job), 'bug2_user_query_review');
});

test('stage prerequisites gate only the services used by the next stage', () => {
  assert.deepEqual(pipelineStageRequiredServices('project_generate'), ['claude']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_claude_fix'), ['claude']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_test_author'), ['codex']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_red_green'), ['docker']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_docker_validation'), ['docker']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_pre_verify'), ['claude', 'docker']);
  assert.deepEqual(pipelineStageRequiredServices('bug2_verification_coverage'), ['codex']);
  const health = { updatedAt: '2026-08-15T12:00:00Z', services: { claude: { name: 'Claude CLI', status: 'offline' }, docker: { status: 'online' } } };
  assert.deepEqual(pipelineStageHealthBlockers('project_generate', health, { nowMs: Date.parse('2026-08-15T12:01:00Z') }), ['Claude CLI 离线']);
  assert.deepEqual(pipelineStageHealthBlockers('project_validate', health, { nowMs: Date.parse('2026-08-15T12:01:00Z') }), []);
});

test('dependency waits fall back to the service required by the failed stage', () => {
  assert.equal(pipelineDependencyServiceForIncident({ stageId: 'project_generate', message: '系统健康状态过期' }), 'claude');
  assert.equal(pipelineDependencyServiceForIncident({ stageId: 'project_generate', failureCategory: 'snapshot_infrastructure', message: 'tar: lseek(SEEK_HOLE) failed' }), 'host');
  assert.equal(pipelineDependencyServiceForIncident({ stageId: 'project_validate', message: 'TLS handshake timeout' }), 'docker');
  assert.equal(pipelineDependencyServiceForIncident({ stageId: 'unknown', message: '系统健康状态过期' }), 'host');
});

test('resource policy blocks critical disk pressure and reduces concurrency for warnings', () => {
  assert.equal(pipelineResourcePolicy({ diskUsedPercent: 86, freeMemoryBytes: 16 * 1024 ** 3, totalMemoryBytes: 32 * 1024 ** 3 }).canStart, false);
  const warning = pipelineResourcePolicy({ diskUsedPercent: 80, diskFreeBytes: 80 * 1024 ** 3, freeMemoryBytes: 16 * 1024 ** 3, totalMemoryBytes: 32 * 1024 ** 3 });
  assert.equal(warning.status, 'degraded');
  assert.equal(warning.effectiveMaxConcurrency, 2);
  const recoveredDisk = pipelineResourcePolicy({ diskUsedPercent: 89.5, diskFreeBytes: 96 * 1024 ** 3, memoryAvailablePercent: 50 });
  assert.equal(recoveredDisk.status, 'degraded');
  assert.equal(recoveredDisk.effectiveMaxConcurrency, 4);
  const largeDisk = pipelineResourcePolicy({ diskUsedPercent: 80, diskFreeBytes: 180 * 1024 ** 3, freeMemoryBytes: 16 * 1024 ** 3, totalMemoryBytes: 32 * 1024 ** 3 });
  assert.equal(largeDisk.status, 'healthy');
  assert.equal(largeDisk.effectiveMaxConcurrency, 4);
  assert.equal(parseDockerSize('38.88GB (86%)'), 38_880_000_000);
  assert.equal(parseDockerBuildxReclaimableBytes('Shared:\t12.3GB\nPrivate:\t12.44GB\nReclaimable:\t24.74GB\nTotal:\t24.74GB'), 24_740_000_000);
  assert.equal(pipelineResourcePolicy({ diskUsedPercent: 20, freeMemoryBytes: 128e6, totalMemoryBytes: 32 * 1024 ** 3, memoryAvailablePercent: 50 }).canStart, true);
  assert.equal(pipelineResourcePolicy({ loadRatio: 1.1, memoryAvailablePercent: 50 }).effectiveMaxConcurrency, 4);
  assert.equal(pipelineResourcePolicy({ loadRatio: 2.6, memoryAvailablePercent: 50 }).effectiveMaxConcurrency, 2);
  assert.equal(pipelineResourcePolicy({ loadRatio: 3.1, memoryAvailablePercent: 50 }).effectiveMaxConcurrency, 1);
});

test('disk cleanup plan uses pressure tiers and includes dedicated Buildx cache', () => {
  const snapshot = collectHostResourceSnapshot({
    statfs: { blocks: 500, bavail: 119, bsize: 1024 ** 3 },
    dockerSystemReclaimableBytes: 4.6e9,
    dockerBuilderReclaimableBytes: 24.74e9,
    memoryAvailablePercent: 50,
  });
  assert.equal(snapshot.dockerReclaimableBytes, 29.34e9);
  assert.equal(snapshot.dockerSystemReclaimableBytes, 4.6e9);
  assert.equal(snapshot.dockerBuilderReclaimableBytes, 24.74e9);
  assert.equal(pipelineResourcePolicy(snapshot).cleanupRecommended, true);
  assert.deepEqual(pipelineDiskCleanupPlan(snapshot), {
    mode: 'pressure',
    targetFreeBytes: 120 * 1024 ** 3,
    builderMaxUsedSpace: '8GB',
    builderReservedSpace: '6GB',
    imageMaxAgeHours: 168,
    tempMaxAgeHours: 48,
  });
  assert.equal(pipelineDiskCleanupPlan({ diskFreeBytes: 70 * 1024 ** 3, dockerReclaimableBytes: 3e9 }).mode, 'critical');
  assert.equal(pipelineDiskCleanupPlan({ diskFreeBytes: 180 * 1024 ** 3, dockerReclaimableBytes: 35e9 }).mode, 'preventive');
  assert.equal(pipelineDiskCleanupPlan({ diskFreeBytes: 180 * 1024 ** 3, dockerReclaimableBytes: 5e9 }).mode, 'none');
  assert.equal(pipelineDiskCleanupPlan({ diskFreeBytes: 180 * 1024 ** 3, dockerReclaimableBytes: 5e9 }, { force: true }).mode, 'manual');
});

test('Docker maintenance drains only for real disk pressure and otherwise waits for natural idle', () => {
  const healthyDisk = { diskFreeBytes: 150 * 1024 ** 3, dockerReclaimableBytes: 67e9 };
  assert.deepEqual(
    pipelineDockerMaintenanceAction(healthyDisk, { status: 'idle' }, { occupiedCount: 3 }),
    { action: 'none', mode: 'wait-for-idle' },
  );
  assert.deepEqual(
    pipelineDockerMaintenanceAction(healthyDisk, { status: 'idle' }, { occupiedCount: 0 }),
    { action: 'request', mode: 'routine' },
  );
  assert.deepEqual(
    pipelineDockerMaintenanceAction(healthyDisk, { status: 'pending' }, { occupiedCount: 3 }),
    { action: 'cancel', mode: 'stale' },
  );

  const pressuredDisk = { diskFreeBytes: 80 * 1024 ** 3, dockerReclaimableBytes: 15e9 };
  assert.deepEqual(
    pipelineDockerMaintenanceAction(pressuredDisk, { status: 'idle' }, { occupiedCount: 2 }),
    { action: 'request', mode: 'urgent' },
  );
  assert.deepEqual(
    pipelineDockerMaintenanceAction(pressuredDisk, { status: 'pending' }, { occupiedCount: 2 }),
    { action: 'wait', mode: 'urgent' },
  );
  assert.deepEqual(
    pipelineDockerMaintenanceAction({ diskFreeBytes: 150 * 1024 ** 3, dockerReclaimableBytes: 37e9 }, { status: 'pending' }, { occupiedCount: 3 }),
    { action: 'cancel', mode: 'stale' },
  );
  assert.deepEqual(
    pipelineDockerMaintenanceAction({ diskFreeBytes: 119 * 1024 ** 3, dockerReclaimableBytes: 29e9 }, { status: 'idle' }, { occupiedCount: 2 }),
    { action: 'request', mode: 'urgent' },
  );
});

test('Docker maintenance can run while active projects are in non-Docker stages', () => {
  assert.equal(pipelineStageUsesDocker('project_validate'), true);
  assert.equal(pipelineStageUsesDocker('bug2_red_green'), true);
  assert.equal(pipelineStageUsesDocker('bug2_claude_fix'), false);
  assert.equal(pipelineStageUsesDocker('bug2_trajectory_validate'), false);
  assert.equal(pipelineStageUsesDocker('bug2_cloud_upload'), false);
  const busy = pipelineDockerBusyJobIds([
    { id: 'analysis', status: 'running', currentStage: 'bug1_bug_discovery', stages: [{ id: 'bug1_bug_discovery', status: 'running' }] },
    { id: 'validation', status: 'running', currentStage: 'project_validate', stages: [{ id: 'project_validate', status: 'running' }] },
    { id: 'finished', status: 'passed', currentStage: 'bug1_docker_validation', stages: [] },
  ]);
  assert.deepEqual([...busy], ['validation']);
});

test('runner process parser adopts only the exact pipeline runner command', () => {
  const runner = '/Users/example/New project/scripts/run-production-pipeline.mjs';
  const parsed = parsePipelineRunnerProcesses(` 123 node ${runner} /tmp/pipeline-job-a/job.json\n 456 node other.mjs /tmp/pipeline-job-b/job.json`, runner);
  assert.deepEqual([...parsed.keys()], ['pipeline-job-a']);
  assert.equal(parsed.get('pipeline-job-a').pid, 123);
});

test('runner process parser adopts legacy relative runner paths after a monitor restart', () => {
  const runner = '/Users/example/New project/scripts/run-production-pipeline.mjs';
  const parsed = parsePipelineRunnerProcesses(
    ' 789 node task-monitor/scripts/run-production-pipeline.mjs .task_work/pipeline-jobs/pipeline-job-relative/job.json',
    runner,
  );
  assert.equal(parsed.get('pipeline-job-relative').pid, 789);
});

test('orphan parser finds snapshot shells but ignores unrelated commands', () => {
  const output = [
    ' 95326 1 95326 /tmp/task-monitor/pipeline-jobs/pipeline-20260821-a1/artifacts/runner-snapshots/bug1.sh /tmp/task',
    ' 95327 1 95327 /tmp/task-monitor/pipeline-jobs/pipeline-20260821-a1/job.json',
    ' 95328 1 95328 /tmp/other/pipeline-jobs/pipeline-20260821-a1/artifacts/runner-snapshots/bug2.sh',
  ].join('\n');
  assert.deepEqual(parseOrphanedPipelineProcesses(output), [
    {
      jobId: 'pipeline-20260821-a1',
      pid: 95326,
      ppid: 1,
      pgid: 95326,
      command: '/tmp/task-monitor/pipeline-jobs/pipeline-20260821-a1/artifacts/runner-snapshots/bug1.sh /tmp/task',
    },
    {
      jobId: 'pipeline-20260821-a1',
      pid: 95328,
      ppid: 1,
      pgid: 95328,
      command: '/tmp/other/pipeline-jobs/pipeline-20260821-a1/artifacts/runner-snapshots/bug2.sh',
    },
  ]);
});

test('daily budget and start blockers prevent unlimited project creation', () => {
  const jobs = Array.from({ length: 2 }, (_, index) => ({ id: String(index), createdAt: '2026-08-15T01:00:00Z' }));
  const budget = pipelineDailyBudget(jobs, { now: new Date('2026-08-15T12:00:00Z'), projectLimit: 2 });
  assert.equal(budget.canCreateProject, false);
  const blockers = pipelineJobStartBlockers({ status: 'draft', stages: [{ id: 'project_plan', status: 'pending' }] }, {
    updatedAt: '2026-08-15T12:00:00Z', services: { codex: { status: 'online' } },
  }, { canStart: true }, budget);
  assert.match(blockers.join(';'), /预算/);
});

test('daily project and trajectory counters are unlimited by default', () => {
  const jobs = Array.from({ length: 200 }, (_, index) => ({
    id: String(index),
    createdAt: '2026-08-15T01:00:00Z',
    stages: [{ id: `bug${index}_delivery_ready`, status: 'passed', finishedAt: '2026-08-15T02:00:00Z' }],
  }));
  const budget = pipelineDailyBudget(jobs, { now: new Date('2026-08-15T12:00:00Z') });
  assert.equal(budget.projectLimit, null);
  assert.equal(budget.trajectoryLimit, null);
  assert.equal(budget.createdProjects, 200);
  assert.equal(budget.deliveredTrajectories, 200);
  assert.equal(budget.canCreateProject, true);
});

test('pipeline stages reserve capacity according to their resource cost', () => {
  assert.deepEqual(pipelineStageResourceProfile('project_plan'), { pool: 'codex-structured', limit: 4, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('project_bootstrap'), { pool: 'project-bootstrap', limit: 1, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('codex_injection_plan'), { pool: 'codex-structured', limit: 4, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('codex_injection'), { pool: 'codex-structured', limit: 4, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('project_generate'), { pool: 'project-generation', limit: 4, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_bug_discovery'), { pool: 'compute-analysis', limit: 6, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_bug_source_prepare'), { pool: 'compute-analysis', limit: 6, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_claude_fix'), { pool: 'compute-repair', limit: 6, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_test_author'), { pool: 'codex-structured', limit: 4, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_red_green'), { pool: 'compute-docker', limit: 2, weight: 1 });
  assert.deepEqual(pipelineStageResourceProfile('bug1_docker_validation'), { pool: 'compute-docker', limit: 2, weight: 1 });
  assert.equal(pipelineStageWeight('bug1_pre_verify'), 1);
  assert.equal(pipelineStageWeight('bug1_cloud_upload'), 1);
  assert.equal(pipelineOccupiedWeight([
    { status: 'running', currentStage: 'project_generate' },
    { status: 'queued', currentStage: 'bug1_cloud_upload' },
    { status: 'failed', currentStage: 'bug2_cloud_upload' },
  ]), 2);
});

test('one bootstrap lane serializes project generation and validation while Bugs keep running', () => {
  const jobs = [
    { status: 'running', currentStage: 'project_validate' },
    { status: 'running', currentStage: 'bug2_claude_fix' },
  ];
  assert.deepEqual(pipelineResourcePoolState(jobs, 4)['project-bootstrap'], {
    pool: 'project-bootstrap', limit: 1, occupied: 1, available: 0,
  });
  assert.deepEqual(pipelineStageStartCapacity(jobs, 'project_generate', 4), {
    allowed: false,
    pool: 'project-bootstrap',
    occupied: 1,
    limit: 1,
    available: 0,
  });
  assert.equal(pipelineStageStartCapacity([jobs[1]], 'project_generate', 4).allowed, true);
});

test('live bootstrap leases remain authoritative during stage handoff', () => {
  const capacity = pipelineStageStartCapacity([
    { status: 'running', currentStage: 'bug1_claude_fix' },
  ], 'project_validate', 4, {
    activeLeaseCounts: { 'project-bootstrap': 1, 'compute-docker': 0 },
  });
  assert.deepEqual(capacity, {
    allowed: false,
    pool: 'project-bootstrap',
    occupied: 1,
    limit: 1,
    available: 0,
  });
});

test('occupied weight follows the next pending stage instead of a stale completed stage', () => {
  assert.equal(pipelineOccupiedWeight([{
    status: 'running',
    currentStage: 'bug1_cloud_upload',
    stages: [
      { id: 'bug1_cloud_upload', status: 'passed' },
      { id: 'bug2_pre_verify', status: 'pending' },
    ],
  }]), 1);
});

test('two legacy Gold-heavy jobs still leave two global runner slots for project generation', () => {
  const jobs = [
    { status: 'running', currentStage: 'bug1_gold_fix' },
    { status: 'running', currentStage: 'bug2_gold_fix' },
  ];
  const pools = pipelineResourcePoolState(jobs, 4);
  assert.deepEqual(pools['codex-structured'], {
    pool: 'codex-structured', limit: 4, occupied: 0, available: 4,
  });
  assert.deepEqual(pools['compute-heavy'], {
    pool: 'compute-heavy', limit: 2, occupied: 2, available: 0,
  });
  assert.equal(pipelineStageStartCapacity(jobs, 'project_plan', 4).allowed, true);
  assert.equal(pipelineStageStartCapacity(jobs, 'project_generate', 4).allowed, true);
  assert.equal(pipelineStageStartCapacity(jobs, 'bug3_gold_fix', 4).allowed, false);
});

test('two Sol Bug discovery stages use the lightweight analysis pool', () => {
  const jobs = [
    { status: 'running', currentStage: 'bug1_bug_discovery' },
    { status: 'running', currentStage: 'bug1_bug_source_prepare' },
  ];
  const pools = pipelineResourcePoolState(jobs, 2);
  assert.deepEqual(pools['compute-analysis'], {
    pool: 'compute-analysis', limit: 6, occupied: 2, available: 4,
  });
  assert.equal(pipelineStageStartCapacity(jobs, 'bug2_bug_discovery', 2).allowed, false);
  assert.equal(pipelineStageWeight('bug1_bug_discovery'), 1);
});

test('two Claude repair stages use the lightweight repair pool', () => {
  const jobs = [
    { status: 'running', currentStage: 'bug1_claude_fix' },
    { status: 'running', currentStage: 'bug2_claude_fix' },
  ];
  const pools = pipelineResourcePoolState(jobs, 2);
  assert.deepEqual(pools['compute-repair'], {
    pool: 'compute-repair', limit: 6, occupied: 2, available: 4,
  });
  assert.equal(pipelineStageStartCapacity(jobs, 'bug3_claude_fix', 2).allowed, false);
  assert.equal(pipelineStageWeight('bug1_claude_fix'), 1);
});

test('an existing project resume skips only the global admission check', () => {
  const jobs = [
    { status: 'running', currentStage: 'bug1_claude_fix' },
    { status: 'running', currentStage: 'bug2_test_author' },
  ];
  assert.deepEqual(pipelineStageStartCapacity(jobs, 'bug3_docker_validation', 2), {
    allowed: false,
    pool: 'global',
    occupied: 2,
    limit: 2,
    available: 0,
  });
  assert.deepEqual(pipelineStageStartCapacity(jobs, 'bug3_docker_validation', 2, {
    reuseExistingAdmission: true,
    activeLeaseCounts: { 'compute-docker': 1 },
  }), {
    allowed: true,
    pool: 'compute-docker',
    occupied: 1,
    limit: 2,
    available: 1,
  });
});

test('stopped workbench cursors do not reserve the Claude repair pool', () => {
  const pools = pipelineResourcePoolState([{
    status: 'running',
    currentStage: 'bug4_test_author',
    bugs: [
      {
        bugIndex: 1,
        workerExecution: {
          status: 'fast_lane_stopped',
          resourceStage: 'bug1_claude_fix',
        },
      },
      {
        bugIndex: 2,
        workerExecution: {
          status: 'fast_lane_running',
          currentStage: 'bug2_test_author',
          resourceStage: 'bug2_claude_fix',
        },
      },
    ],
  }], 2);
  assert.deepEqual(pools['compute-repair'], {
    pool: 'compute-repair', limit: 6, occupied: 0, available: 6,
  });
  assert.deepEqual(pools['codex-structured'], {
    pool: 'codex-structured', limit: 4, occupied: 1, available: 3,
  });
});

test('queued Bug workers do not reserve test-author capacity before they run', () => {
  const pools = pipelineResourcePoolState([{
    status: 'running',
    currentStage: 'bug2_test_author',
    bugs: [
      {
        bugIndex: 2,
        workerExecution: { status: 'fast_lane_running', currentStage: 'bug2_test_author' },
      },
      {
        bugIndex: 3,
        workerExecution: { status: 'fast_lane_queued', currentStage: 'bug3_test_author' },
      },
      {
        bugIndex: 4,
        workerExecution: { status: 'fast_lane_queued', currentStage: 'bug4_test_author' },
      },
    ],
  }], 2);
  assert.deepEqual(pools['codex-structured'], {
    pool: 'codex-structured', limit: 4, occupied: 1, available: 3,
  });
});

test('proof and Docker work use independent per-project pools', () => {
  assert.deepEqual(pipelineStageResourceProfile('project_validate'), {
    pool: 'compute-docker', limit: 2, weight: 1,
  });
  assert.deepEqual(pipelineStageResourceProfile('bug1_pre_verify'), {
    pool: 'compute-proof', limit: 4, weight: 1,
  });
  assert.deepEqual(pipelineStageResourceProfile('bug1_post_verify'), {
    pool: 'compute-proof', limit: 4, weight: 1,
  });
  assert.deepEqual(pipelineStageResourceProfile('bug1_verification_coverage'), {
    pool: 'compute-analysis', limit: 2, weight: 1,
  });
  const jobs = [
    { status: 'running', currentStage: 'project_validate' },
    { status: 'running', currentStage: 'bug1_pre_verify' },
  ];
  assert.deepEqual(pipelineResourcePoolState(jobs, 2)['compute-docker'], {
    pool: 'compute-docker', limit: 2, occupied: 1, available: 1,
  });
  assert.deepEqual(pipelineResourcePoolState(jobs, 2)['compute-proof'], {
    pool: 'compute-proof', limit: 4, occupied: 1, available: 3,
  });
  assert.equal(pipelineStageStartCapacity([jobs[0]], 'bug2_post_verify', 2).allowed, true);
});

test('main freeze can run while a compute-heavy analysis stage is occupied', () => {
  const jobs = [
    { status: 'running', currentStage: 'bug1_bug_discovery' },
  ];
  const capacity = pipelineStageStartCapacity(jobs, 'main_freeze', 2);
  assert.equal(pipelineStageResourceProfile('main_freeze').pool, '');
  assert.equal(capacity.allowed, true);
  assert.equal(capacity.pool, 'general');
});

test('project pools cannot bypass the global dynamic limit', () => {
  const jobs = Array.from({ length: 4 }, () => ({
    status: 'running',
    currentStage: 'project_plan',
  }));
  assert.equal(pipelineStageStartCapacity(jobs, 'project_plan', 4).allowed, false);
  assert.equal(pipelineStageStartCapacity(jobs, 'project_generate', 4).allowed, false);
  assert.deepEqual(pipelineResourcePoolState(jobs, 2)['codex-structured'], {
    pool: 'codex-structured', limit: 4, occupied: 4, available: 0,
  });
});

test('resource pool reporting uses live cross-runner leases and separates waiters', () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    id: `repair-${index + 1}`,
    status: 'running',
    currentStage: `bug${index + 1}_claude_fix`,
  }));
  assert.deepEqual(pipelineResourcePoolState(jobs, 4, { 'compute-repair': 2 })['compute-repair'], {
    pool: 'compute-repair', limit: 6, occupied: 2, available: 4, waiting: 2,
  });
});

test('stage admission uses live leases instead of counting internal waiters as occupied', () => {
  const jobs = Array.from({ length: 3 }, (_, jobIndex) => ({
    id: `analysis-${jobIndex + 1}`,
    status: 'running',
    currentStage: `bug${jobIndex + 1}_bug_source_prepare`,
    bugs: Array.from({ length: 2 }, (_, bugIndex) => ({
      workerExecution: {
        status: 'fast_lane_running',
        currentStage: `bug${jobIndex * 2 + bugIndex + 1}_bug_source_prepare`,
      },
    })),
  }));

  assert.equal(pipelineStageStartCapacity(jobs, 'bug9_bug_source_prepare', 4).allowed, false);
  const capacity = pipelineStageStartCapacity(jobs, 'bug9_bug_source_prepare', 4, {
    activeLeaseCounts: { 'compute-analysis': 2 },
  });
  assert.equal(capacity.allowed, true);
  assert.equal(capacity.occupied, 2);
  assert.equal(capacity.available, 4);
});

test('independent verification and Gold pools no longer need cross-lane fairness', () => {
  assert.equal(pipelineHeavyLane('project_validate'), 'verification');
  assert.equal(pipelineHeavyLane('bug1_gold_fix'), 'analysis');
  const activeAnalysis = { status: 'running', currentStage: 'bug1_bug_discovery' };
  const waitingAnalysis = { status: 'waiting_resource', currentStage: 'bug2_gold_fix' };
  const waitingValidation = { status: 'waiting_resource', currentStage: 'project_validate' };
  assert.equal(pipelineStageStartCapacity([activeAnalysis], 'bug2_gold_fix', 4, {
    waitingJobs: [waitingAnalysis, waitingValidation],
  }).allowed, true);
  assert.equal(pipelineStageStartCapacity([activeAnalysis], 'project_validate', 4, {
    waitingJobs: [waitingAnalysis, waitingValidation],
  }).allowed, true);
  assert.equal(pipelineStageStartCapacity([activeAnalysis], 'bug2_gold_fix', 4, {
    waitingJobs: [waitingAnalysis],
  }).allowed, true);
});

test('triage actions execute only hard stalls and terminal recommendations', () => {
  assert.equal(triageActionPlan({ type: 'stalled' }, { recommended_action: 'retry_stage', project_disposition: 'retry' }).type, 'observe');
  assert.equal(triageActionPlan({ type: 'hard_stall' }, { recommended_action: 'retry_stage', project_disposition: 'retry' }).type, 'terminate_and_retry');
  assert.equal(triageActionPlan({ type: 'hard_stall' }, { recommended_action: 'abandon_project', project_disposition: 'abandon' }).type, 'terminate_and_abandon');
  assert.equal(triageActionPlan({ type: 'failure' }, { recommended_action: 'abandon_project', project_disposition: 'abandon' }).type, 'approve_abandonment');
  assert.equal(triageActionPlan({ type: 'failure' }, { recommended_action: 'fix_pipeline', project_disposition: 'retry' }).type, 'pause_scheduler');
  assert.equal(triageActionPlan({ type: 'throughput_stall' }, { recommended_action: 'fix_pipeline', project_disposition: 'retry' }).type, 'observe');
});

test('hard-stall termination is allowed only for the sole matching active stage', () => {
  const single = pipelineHardStallTerminationScope({
    stages: [{ id: 'bug4_docker_validation', status: 'running' }],
  }, 'bug4_docker_validation');
  assert.equal(single.safe, true);

  const parallel = pipelineHardStallTerminationScope({
    stages: [
      { id: 'bug3_claude_fix', status: 'running' },
      { id: 'bug4_docker_validation', status: 'running' },
    ],
  }, 'bug4_docker_validation');
  assert.equal(parallel.safe, false);
  assert.deepEqual(parallel.activeStageIds, ['bug3_claude_fix', 'bug4_docker_validation']);

  const stale = pipelineHardStallTerminationScope({
    stages: [{ id: 'bug5_claude_fix', status: 'running' }],
  }, 'bug4_docker_validation');
  assert.equal(stale.safe, false);
});

test('stale triage cannot overwrite an active pipeline runner', () => {
  assert.equal(shouldQueuePipelineRetry({ processActive: true }), false);
  assert.equal(shouldQueuePipelineRetry({ processActive: false }), true);
  assert.equal(shouldQueuePipelineRetry({ processActive: true, terminated: true }), true);
});
