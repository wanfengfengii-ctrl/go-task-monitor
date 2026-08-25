import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCurrentArchivedExportPolicy, mergeArchivedTaskRecords } from './task-archive.js';

test('archived records restore queue metadata without becoming runnable workspaces', () => {
  const [task] = mergeArchivedTaskRecords([], [{
    id: 'task-0123456789abcdef',
    name: 'restored-task',
    bug_id: 'nyh-go-0001-bug-01',
    status: 'passed',
    reviewStatus: 'qualified',
    sessionId: 'session-one',
    archiveExportReady: true,
    archiveTrajectoryPath: 'validation/archived-trajectories/task-0123456789abcdef/trajectory_session-one.jsonl',
  }]);

  assert.equal(task.archived, true);
  assert.equal(task.status, 'passed');
  assert.equal(task.reviewStatus, 'qualified');
  assert.equal(task.workspaceAvailable, false);
  assert.equal(task.productionFlowEligible, false);
  assert.equal(task.taskDir, null);
  assert.equal(task.archiveExportReady, true);
  assert.match(task.archiveTrajectoryPath, /archived-trajectories/);
});

test('a live task supersedes its historical archive record', () => {
  const live = [{ id: 'task-live', name: 'same-task', bug_id: 'bug-01' }];
  const merged = mergeArchivedTaskRecords(live, [{
    id: 'task-0123456789abcdef',
    name: 'same-task',
    bug_id: 'bug-01',
    status: 'passed',
  }]);

  assert.deepEqual(merged, live);
});

test('invalid and duplicate archive records are ignored', () => {
  const archived = {
    id: 'task-fedcba9876543210',
    name: 'restored-task',
    bug_id: 'bug-02',
    status: 'passed',
  };
  const merged = mergeArchivedTaskRecords([], [{ name: 'missing identity' }, archived, archived]);
  assert.equal(merged.length, 1);
});

test('cloud-restored archives must meet the current verification policy before export', () => {
  assert.equal(hasCurrentArchivedExportPolicy({ archiveExportReady: true, verification_policy_version: 5 }, 5), true);
  assert.equal(hasCurrentArchivedExportPolicy({ archiveExportReady: true, verification_policy_version: 4 }, 5), false);
  assert.equal(hasCurrentArchivedExportPolicy({ archiveExportReady: false, verification_policy_version: 5 }, 5), false);
});
