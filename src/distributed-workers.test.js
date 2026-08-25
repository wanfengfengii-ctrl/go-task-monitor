import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  claimRemoteRepairJob,
  completeRemoteRepairJob,
  hydrateRemoteRepairJob,
  mergeRemoteJobSnapshot,
  nodeRoleCanExecuteStage,
  pipelineStageExecutionRole,
  prepareRemoteRepairHandoff,
  remoteLeaseExpired,
  remoteRepairClaimable,
} from './distributed-workers.js';

function baseJob() {
  return {
    id: 'pipeline-remote-001',
    status: 'running',
    currentStage: 'main_publish',
    jobDir: '/controller/jobs/pipeline-remote-001',
    tasksRoot: '/controller/tasks',
    request: { repository: 'go-1001', cloneUrl: 'git@github.com:example/go-1001.git' },
    mainCommit: 'a'.repeat(40),
    stages: [
      { id: 'main_publish', status: 'passed' },
      { id: 'bug1_task_prepare', status: 'pending' },
    ],
    bugs: [{ bugIndex: 1, bugBaseDir: '/controller/jobs/pipeline-remote-001/bug-base-bug1' }],
  };
}

test('producer owns project and Bug selection while repair worker owns delivery', () => {
  for (const stage of ['project_plan', 'project_generate', 'project_validate', 'main_freeze', 'bug1_bug_discovery', 'bug1_bug_source_prepare', 'bug1_user_query_review', 'main_publish']) {
    assert.equal(pipelineStageExecutionRole(stage), 'producer');
    assert.equal(nodeRoleCanExecuteStage('producer', stage), true);
    assert.equal(nodeRoleCanExecuteStage('repair-worker', stage), false);
  }
  for (const stage of ['bug1_task_prepare', 'bug1_claude_fix', 'bug1_test_author', 'bug1_pre_verify', 'bug1_git_publication', 'bug1_delivery_ready']) {
    assert.equal(pipelineStageExecutionRole(stage), 'repair-worker');
    assert.equal(nodeRoleCanExecuteStage('repair-worker', stage), true);
    assert.equal(nodeRoleCanExecuteStage('producer', stage), false);
  }
  assert.equal(nodeRoleCanExecuteStage('all-in-one', 'bug1_claude_fix'), true);
});

test('main publication hands a project to the remote repair pool', () => {
  const handedOff = prepareRemoteRepairHandoff(baseJob(), 'bug1_task_prepare', '2026-08-25T01:00:00.000Z');
  assert.equal(handedOff.status, 'waiting_resource');
  assert.equal(handedOff.waitingResource.pool, 'remote-repair');
  assert.equal(handedOff.remoteExecution.status, 'waiting');
  assert.equal(handedOff.runnerPid, null);
  assert.equal(remoteRepairClaimable(handedOff, Date.parse('2026-08-25T01:00:01.000Z')), true);
});

test('a live remote lease is exclusive and becomes claimable after expiry', () => {
  const waiting = prepareRemoteRepairHandoff(baseJob(), 'bug1_task_prepare', '2026-08-25T01:00:00.000Z');
  const leased = claimRemoteRepairJob(waiting, {
    workerId: 'repair-b',
    leaseId: 'lease-1',
    now: new Date('2026-08-25T01:00:10.000Z'),
    leaseTtlMs: 90_000,
  });
  assert.equal(remoteRepairClaimable(leased, Date.parse('2026-08-25T01:01:00.000Z')), false);
  assert.equal(remoteLeaseExpired(leased.remoteExecution, Date.parse('2026-08-25T01:01:41.000Z')), true);
  assert.equal(remoteRepairClaimable(leased, Date.parse('2026-08-25T01:01:41.000Z')), true);
  assert.equal(remoteRepairClaimable({ ...leased, status: 'failed', autoRetryCount: 2 }, Date.parse('2026-08-25T01:01:41.000Z')), false);
});

test('remote snapshots cannot change repository identity and keep controller paths', () => {
  const waiting = prepareRemoteRepairHandoff(baseJob(), 'bug1_task_prepare', '2026-08-25T01:00:00.000Z');
  const leased = claimRemoteRepairJob(waiting, {
    workerId: 'repair-b', leaseId: 'lease-1', now: new Date('2026-08-25T01:00:10.000Z'),
  });
  const snapshot = structuredClone(leased);
  snapshot.status = 'running';
  snapshot.currentStage = 'bug1_claude_fix';
  snapshot.jobDir = '/worker/jobs/pipeline-remote-001';
  snapshot.tasksRoot = '/worker/tasks';
  snapshot.bugs[0].bugBaseDir = '/worker/jobs/pipeline-remote-001/bug-base-bug1';
  snapshot.bugs[0].task = { taskName: 'go-1001-bug-01', taskDir: '/worker/tasks/go-1001-bug-01' };
  snapshot.bugs[0].verificationTestAuthor = { sourceDir: '/worker/tasks/go-1001-bug-01/test-author' };
  const merged = mergeRemoteJobSnapshot(leased, snapshot, {
    workerId: 'repair-b', leaseId: 'lease-1', receivedAt: '2026-08-25T01:00:20.000Z',
  });
  assert.equal(merged.status, 'waiting_resource');
  assert.equal(merged.currentStage, 'bug1_claude_fix');
  assert.equal(merged.jobDir, '/controller/jobs/pipeline-remote-001');
  assert.equal(merged.bugs[0].bugBaseDir, '/controller/jobs/pipeline-remote-001/bug-base-bug1');
  assert.equal(merged.bugs[0].task.taskDir, path.join('/controller/tasks', 'go-1001-bug-01'));
  assert.equal(merged.bugs[0].verificationTestAuthor.sourceDir, path.join('/controller/tasks', 'go-1001-bug-01/test-author'));
  const tampered = structuredClone(snapshot);
  tampered.request.cloneUrl = 'git@github.com:attacker/other.git';
  assert.throws(() => mergeRemoteJobSnapshot(leased, tampered, {
    workerId: 'repair-b', leaseId: 'lease-1',
  }), /已冻结的仓库/);
});

test('worker hydration rewrites every machine-local root and completion closes the lease', () => {
  const waiting = prepareRemoteRepairHandoff(baseJob(), 'bug1_task_prepare', '2026-08-25T01:00:00.000Z');
  const leased = claimRemoteRepairJob(waiting, {
    workerId: 'repair-b', leaseId: 'lease-1', now: new Date('2026-08-25T01:00:10.000Z'),
  });
  leased.bugs[0].task = { taskName: 'go-1001-bug-01', taskDir: '/controller/tasks/go-1001-bug-01' };
  leased.bugs[0].verificationTestAuthor = { sourceDir: '/controller/tasks/go-1001-bug-01/test-author' };
  const hydrated = hydrateRemoteRepairJob(leased, {
    jobDir: '/worker/jobs/pipeline-remote-001', tasksRoot: '/worker/tasks', workerPid: 123,
  });
  assert.equal(hydrated.status, 'queued');
  assert.equal(hydrated.bugs[0].bugBaseDir, path.resolve('/worker/jobs/pipeline-remote-001/bug-base-bug1'));
  assert.equal(hydrated.bugs[0].task.taskDir, path.resolve('/worker/tasks/go-1001-bug-01'));
  assert.equal(hydrated.bugs[0].verificationTestAuthor.sourceDir, path.resolve('/worker/tasks/go-1001-bug-01/test-author'));
  const completed = completeRemoteRepairJob(leased, {
    workerId: 'repair-b', leaseId: 'lease-1', outcome: 'passed', completedAt: '2026-08-25T02:00:00.000Z',
  });
  assert.equal(completed.status, 'passed');
  assert.equal(completed.remoteExecution.status, 'completed');
});
