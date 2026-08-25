import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineRolloutDecision, rolloutEligibleJobs } from './pipeline-rollout.js';

test('V2 waits until every occupied legacy runner drains', () => {
  const jobs = [
    { id: 'legacy-running', status: 'running', workflowVersion: 1 },
    { id: 'v2-draft', status: 'draft', workflowVersion: 2, createdAt: '2026-08-15T00:00:00Z' },
  ];
  const blocked = pipelineRolloutDecision(jobs, 2, { mode: 'drain_to_v2' });
  assert.equal(blocked.mode, 'drain_to_v2');
  assert.equal(blocked.legacyActiveCount, 1);
  assert.deepEqual(blocked.allowJobIds, []);

  jobs[0].status = 'passed';
  const canary = pipelineRolloutDecision(jobs, 2, { mode: 'drain_to_v2' });
  assert.equal(canary.mode, 'v2_canary');
  assert.equal(canary.canaryJobId, 'v2-draft');
  assert.deepEqual(canary.allowJobIds, ['v2-draft']);
});

test('V3 does not inherit the single-project V2 canary gate', () => {
  const decision = pipelineRolloutDecision([
    { id: 'running-v3', status: 'running', workflowVersion: 3 },
    { id: 'draft-v3', status: 'draft', workflowVersion: 3 },
  ], 3, { mode: 'v2_canary', canaryJobId: 'running-v3' });
  assert.equal(decision.mode, 'v2_live');
  assert.equal(decision.allowJobIds, null);
  assert.equal(decision.transition, 'rollout_disabled_for_v3');
  assert.deepEqual(rolloutEligibleJobs([
    { id: 'running-v3', status: 'running', workflowVersion: 3 },
    { id: 'draft-v3', status: 'draft', workflowVersion: 3 },
  ], decision).map((job) => job.id), ['running-v3', 'draft-v3']);
});

test('draining records a V2 canary that was already started by the previous scheduler', () => {
  const decision = pipelineRolloutDecision([
    { id: 'legacy', status: 'running', workflowVersion: 1 },
    { id: 'early-canary', status: 'running', workflowVersion: 2 },
  ], 2, { mode: 'drain_to_v2' });
  assert.equal(decision.mode, 'drain_to_v2');
  assert.equal(decision.canaryJobId, 'early-canary');
  assert.equal(decision.transition, 'canary_detected');
});

test('only the canary runs until it passes', () => {
  const jobs = [
    { id: 'canary', status: 'running', workflowVersion: 2, createdAt: '2026-08-15T00:00:00Z' },
    { id: 'later', status: 'draft', workflowVersion: 2, createdAt: '2026-08-15T00:01:00Z' },
  ];
  const running = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'canary' });
  assert.deepEqual(running.allowJobIds, ['canary']);
  jobs[0].status = 'passed';
  const live = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'canary' });
  assert.equal(live.mode, 'v2_live');
  assert.equal(live.transition, 'canary_passed');
  assert.equal(live.allowJobIds, null);
});

test('canary mode admits an explicit manual recovery without opening automatic rollout', () => {
  const jobs = [
    { id: 'canary', status: 'running', workflowVersion: 2, createdAt: '2026-08-15T00:00:00Z' },
    { id: 'manual-recovery', status: 'failed', workflowVersion: 2, manualRetryRequestedAt: '2026-08-19T00:00:00Z' },
    { id: 'automatic-draft', status: 'draft', workflowVersion: 2, createdAt: '2026-08-15T00:01:00Z' },
  ];
  const decision = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'canary' });
  assert.deepEqual(decision.allowJobIds, ['canary', 'manual-recovery']);
  assert.deepEqual(rolloutEligibleJobs(jobs, decision).map((job) => job.id), ['canary', 'manual-recovery']);
});

test('canary mode admits an explicitly retried stopped job', () => {
  const jobs = [
    { id: 'canary', status: 'running', workflowVersion: 2, createdAt: '2026-08-15T00:00:00Z' },
    { id: 'stopped-recovery', status: 'stopped', workflowVersion: 2, manualRetryRequestedAt: '2026-08-19T00:00:00Z' },
    { id: 'automatic-draft', status: 'draft', workflowVersion: 2, createdAt: '2026-08-15T00:01:00Z' },
  ];
  const decision = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'canary' });
  assert.deepEqual(decision.allowJobIds, ['canary', 'stopped-recovery']);
  assert.deepEqual(rolloutEligibleJobs(jobs, decision).map((job) => job.id), ['canary', 'stopped-recovery']);
});

test('an abandoned canary follows its one-to-one replacement', () => {
  const jobs = [
    { id: 'canary', status: 'abandoned', workflowVersion: 2, replacementJobId: 'replacement' },
    { id: 'replacement', status: 'draft', workflowVersion: 2 },
  ];
  const decision = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'canary' });
  assert.equal(decision.canaryJobId, 'replacement');
  assert.deepEqual(decision.allowJobIds, ['replacement']);
});

test('a failed canary with exhausted retries yields to a waiting project', () => {
  const jobs = [
    { id: 'failed-canary', status: 'failed', workflowVersion: 2, autoRetryCount: 2, createdAt: '2026-08-15T00:00:00Z' },
    { id: 'waiting', status: 'waiting_resource', workflowVersion: 2, createdAt: '2026-08-15T00:01:00Z' },
  ];
  const decision = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'failed-canary' });
  assert.equal(decision.canaryJobId, 'waiting');
  assert.deepEqual(decision.allowJobIds, ['waiting']);
  assert.equal(decision.transition, 'canary_replaced');
});

test('a retryable failed canary keeps its slot until automatic retries are exhausted', () => {
  const jobs = [
    { id: 'retryable-canary', status: 'failed', workflowVersion: 2, autoRetryCount: 1, createdAt: '2026-08-15T00:00:00Z' },
    { id: 'later', status: 'draft', workflowVersion: 2, createdAt: '2026-08-15T00:01:00Z' },
  ];
  const decision = pipelineRolloutDecision(jobs, 2, { mode: 'v2_canary', canaryJobId: 'retryable-canary' });
  assert.equal(decision.canaryJobId, 'retryable-canary');
  assert.deepEqual(decision.allowJobIds, ['retryable-canary']);
});

test('canary allow-list is applied before scheduler priority selection', () => {
  const jobs = [
    { id: 'manual-waiter', status: 'waiting_resource' },
    { id: 'failed-canary', status: 'failed' },
  ];
  const eligible = rolloutEligibleJobs(jobs, { allowJobIds: ['failed-canary'] });
  assert.deepEqual(eligible.map((job) => job.id), ['failed-canary']);
});

test('canary mode lets an admitted waiting project continue but still blocks a new draft', () => {
  const jobs = [
    { id: 'canary', status: 'running' },
    { id: 'admitted', status: 'waiting_resource' },
    { id: 'new-draft', status: 'draft' },
  ];
  const eligible = rolloutEligibleJobs(jobs, { mode: 'v2_canary', allowJobIds: ['canary'] });
  assert.deepEqual(eligible.map((job) => job.id), ['canary', 'admitted']);
});

test('an exhausted canary without a replacement releases the stale allow-list', () => {
  const decision = pipelineRolloutDecision([
    { id: 'failed-canary', status: 'failed', workflowVersion: 2, autoRetryCount: 2 },
  ], 2, { mode: 'v2_canary', canaryJobId: 'failed-canary' });
  assert.equal(decision.canaryJobId, '');
  assert.deepEqual(decision.allowJobIds, []);
});
