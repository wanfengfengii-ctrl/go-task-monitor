import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelinePerformanceSnapshot } from './pipeline-performance.js';

test('performance metrics only include current workflow and verification policy jobs', () => {
  const nowMs = Date.parse('2026-08-17T12:00:00Z');
  const current = {
    workflowVersion: 2,
    verificationPolicyVersion: 5,
    status: 'passed',
    createdAt: '2026-08-17T08:00:00Z',
    startedAt: '2026-08-17T08:10:00Z',
    finishedAt: '2026-08-17T11:00:00Z',
    autoRetryCount: 1,
    stages: [
      { id: 'project_generate', status: 'passed', startedAt: '2026-08-17T08:10:00Z', finishedAt: '2026-08-17T08:30:00Z' },
      { id: 'bug1_claude_fix', stage: 'claude_fix', status: 'passed', startedAt: '2026-08-17T09:00:00Z', finishedAt: '2026-08-17T09:08:00Z' },
      { id: 'bug1_delivery_ready', stage: 'delivery_ready', status: 'passed', startedAt: '2026-08-17T10:59:00Z', finishedAt: '2026-08-17T11:00:00Z' },
    ],
  };
  const legacy = {
    ...current,
    verificationPolicyVersion: 4,
    stages: [{ id: 'bug1_delivery_ready', stage: 'delivery_ready', status: 'passed', finishedAt: '2026-08-17T11:00:00Z' }],
  };
  const result = pipelinePerformanceSnapshot([current, legacy], { nowMs });
  assert.equal(result.eligibleJobs, 1);
  assert.equal(result.delivered24h, 1);
  assert.equal(result.completedProjects24h, 1);
  assert.equal(result.autoRetries, 1);
  assert.equal(result.queueWait.p50Minutes, 10);
  assert.equal(result.stages.project_generate.p50Minutes, 20);
  assert.equal(result.stages.bug_claude_fix.p90Minutes, 8);
});

test('performance percentiles tolerate incomplete running stages', () => {
  const result = pipelinePerformanceSnapshot([{
    workflowVersion: 2,
    verificationPolicyVersion: 5,
    status: 'running',
    stages: [
      { id: 'project_generate', status: 'running', startedAt: '2026-08-17T08:00:00Z' },
      { id: 'project_plan', status: 'passed', startedAt: 'invalid', finishedAt: '2026-08-17T08:10:00Z' },
    ],
  }], { nowMs: Date.parse('2026-08-17T12:00:00Z') });
  assert.deepEqual(result.stages, {});
  assert.equal(result.queueWait.p50Minutes, null);
});

test('performance metrics include all completed attempts instead of only the last retry', () => {
  const result = pipelinePerformanceSnapshot([{
    workflowVersion: 2,
    verificationPolicyVersion: 5,
    status: 'passed',
    stages: [{
      id: 'project_validate',
      status: 'passed',
      startedAt: '2026-08-17T11:50:00Z',
      finishedAt: '2026-08-17T12:00:00Z',
      cumulativeDurationMs: 70 * 60_000,
      attempts: [
        { status: 'failed', startedAt: '2026-08-17T10:00:00Z', finishedAt: '2026-08-17T11:00:00Z' },
        { status: 'passed', startedAt: '2026-08-17T11:50:00Z', finishedAt: '2026-08-17T12:00:00Z' },
      ],
    }],
  }], { nowMs: Date.parse('2026-08-17T12:00:00Z') });

  assert.equal(result.stages.project_validate.p50Minutes, 70);
});
