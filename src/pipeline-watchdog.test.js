import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PIPELINE_PROJECT_THROUGHPUT_STALL_MS,
  pipelineErrorFingerprint,
  pipelineProjectThroughputMonitor,
  pipelineStageTimeouts,
  pipelineWatchdogObservation,
  recoverInterruptedPipelineTriages,
} from './pipeline-watchdog.js';

test('watchdog requeues Codex triage interrupted by a service restart', () => {
  const original = {
    updatedAt: '2026-08-15T11:00:00Z',
    incidents: [
      { id: 'waiting', status: 'open' },
      { id: 'interrupted', status: 'triaging', triageAttempts: 1 },
      { id: 'done', status: 'triaged' },
    ],
  };
  const recovered = recoverInterruptedPipelineTriages(original, { now: '2026-08-15T12:00:00Z' });
  assert.equal(recovered.recoveredCount, 1);
  assert.equal(recovered.state.updatedAt, '2026-08-15T12:00:00Z');
  assert.deepEqual(recovered.state.incidents.map((item) => item.status), ['open', 'open', 'triaged']);
  assert.equal(recovered.state.incidents[1].triageAttempts, 1);
  assert.equal(recovered.state.incidents[1].triageInterruptedAt, '2026-08-15T12:00:00Z');
  assert.equal(original.incidents[1].status, 'triaging');
});

test('watchdog uses stage-specific soft and hard limits', () => {
  assert.deepEqual(pipelineStageTimeouts('project_generate'), { softMs: Infinity, hardMs: Infinity });
  assert.deepEqual(pipelineStageTimeouts('bug5_claude_fix'), { softMs: Infinity, hardMs: Infinity });
  assert.deepEqual(pipelineStageTimeouts('project_validate'), { softMs: 900_000, hardMs: Infinity });
  assert.deepEqual(pipelineStageTimeouts('bug4_docker_validation'), { softMs: 900_000, hardMs: Infinity });
  assert.deepEqual(pipelineStageTimeouts('bug1_bug_discovery'), { softMs: 900_000, hardMs: Infinity });
  assert.equal(pipelineStageTimeouts('bug1_cloud_upload').softMs, Infinity);
});

test('watchdog leaves active Claude fix lifetime to the activity-aware runner', () => {
  const observation = pipelineWatchdogObservation({
    id: 'long-claude-fix',
    status: 'running',
    currentStage: 'bug8_claude_fix',
    updatedAt: '2026-08-15T10:00:00Z',
    stages: [{ id: 'bug8_claude_fix', status: 'running', startedAt: '2026-08-15T10:00:00Z' }],
  }, { nowMs: Date.parse('2026-08-15T12:00:00Z'), heartbeat: { at: '2026-08-15T12:00:00Z', pid: 42 } });
  assert.equal(observation, null);
});

test('watchdog does not terminate active Bug discovery by cumulative stage age', () => {
  const observation = pipelineWatchdogObservation({
    id: 'long-discovery',
    status: 'running',
    currentStage: 'bug1_bug_discovery',
    updatedAt: '2026-08-15T11:59:30Z',
    stages: [{ id: 'bug1_bug_discovery', status: 'running', startedAt: '2026-08-15T10:00:00Z' }],
    logs: [{ at: '2026-08-15T11:59:30Z', message: '增量注入规划继续补剩余候选' }],
  }, { nowMs: Date.parse('2026-08-15T12:00:00Z'), heartbeat: { at: '2026-08-15T12:00:00Z', pid: 42 } });
  assert.equal(observation, null);
});

test('watchdog still reports silent Bug discovery for triage', () => {
  const observation = pipelineWatchdogObservation({
    id: 'silent-discovery',
    status: 'running',
    currentStage: 'bug1_bug_discovery',
    updatedAt: '2026-08-15T10:00:00Z',
    stages: [{ id: 'bug1_bug_discovery', status: 'running', startedAt: '2026-08-15T10:00:00Z' }],
  }, { nowMs: Date.parse('2026-08-15T12:00:00Z'), heartbeat: { at: '2026-08-15T12:00:00Z', pid: 42 } });
  assert.equal(observation.type, 'stalled');
  assert.equal(observation.heartbeatState, 'alive');
});

test('watchdog does not apply a previous attempt age to a newly started runner', () => {
  const observation = pipelineWatchdogObservation({
    id: 'retried-project',
    status: 'running',
    currentStage: 'project_generate',
    startedAt: '2026-08-15T10:00:00Z',
    runStartedAt: '2026-08-15T12:59:30Z',
    updatedAt: '2026-08-15T12:59:30Z',
    stages: [{ id: 'project_generate', status: 'running', startedAt: '2026-08-15T10:00:00Z' }],
  }, { nowMs: Date.parse('2026-08-15T13:00:00Z'), heartbeat: { at: '2026-08-15T13:00:00Z', pid: 42 } });
  assert.equal(observation, null);
});

test('watchdog does not charge Runner age to a newly queued resource stage', () => {
  const observation = pipelineWatchdogObservation({
    id: 'parallel-resource-wait',
    status: 'running',
    currentStage: 'bug4_docker_validation',
    startedAt: '2026-08-15T10:00:00Z',
    runStartedAt: '2026-08-15T10:20:00Z',
    updatedAt: '2026-08-15T11:59:30Z',
    stages: [{ id: 'bug4_docker_validation', status: 'pending', startedAt: null }],
    logs: [{ at: '2026-08-15T11:59:30Z', message: 'Docker 验证等待 compute-docker 内部资源' }],
  }, { nowMs: Date.parse('2026-08-15T12:00:00Z'), heartbeat: { at: '2026-08-15T12:00:00Z', pid: 42 } });
  assert.equal(observation, null);
});

test('watchdog flags stalled non-generation jobs and sends cloud waits to Codex triage', () => {
  const nowMs = Date.parse('2026-08-15T12:00:00Z');
  const stalled = pipelineWatchdogObservation({
    id: 'job-1',
    status: 'running',
    currentStage: 'project_validate',
    updatedAt: '2026-08-15T11:20:00Z',
    stages: [{ id: 'project_validate', startedAt: '2026-08-15T11:30:00Z' }],
  }, { nowMs, heartbeat: { at: '2026-08-15T11:59:50Z', pid: 123 } });
  assert.equal(stalled.type, 'stalled');
  assert.equal(stalled.heartbeatState, 'alive');
  const cloud = pipelineWatchdogObservation({ id: 'cloud', status: 'failed', currentStage: 'bug1_cloud_upload', error: '请先连接轨迹云盘' }, { nowMs });
  assert.equal(cloud.codexTriage, true);
  assert.equal(cloud.failureCategory, 'cloud_upload');
  const platform = pipelineWatchdogObservation({ id: 'platform', status: 'failed', currentStage: 'bug1_platform_submit', error: '提交平台返回 HTTP 503' }, { nowMs });
  assert.equal(platform.codexTriage, false);
  assert.equal(platform.failureCategory, 'submission_platform');
});

test('new failures receive a stable redacted fingerprint for Codex triage', () => {
  const left = pipelineErrorFingerprint({ currentStage: 'project_generate', error: 'open /tmp/job-12345678/project/go.mod failed at 42' });
  const right = pipelineErrorFingerprint({ currentStage: 'project_generate', error: 'open /tmp/job-abcdef12/project/go.mod failed at 99' });
  assert.equal(left, right);
  const failure = pipelineWatchdogObservation({ id: 'job-2', status: 'failed', currentStage: 'project_generate', error: 'unknown generation failure' });
  assert.equal(failure.codexTriage, true);
  assert.equal(failure.failureCategory, 'project_generation');
  const snapshot = pipelineWatchdogObservation({ id: 'snapshot', status: 'failed', currentStage: 'project_generate', error: '生成前数据快照失败：SEEK_HOLE' });
  assert.equal(snapshot.failureCategory, 'snapshot_infrastructure');
  assert.equal(snapshot.severity, 'critical');
  const stageOnly = pipelineWatchdogObservation({
    id: 'stage-only',
    status: 'failed',
    currentStage: 'project_generate',
    error: '',
    stages: [{ id: 'project_generate', error: '生成前数据快照失败：SEEK_HOLE' }],
  });
  assert.equal(stageOnly.failureCategory, 'snapshot_infrastructure');
  assert.equal(stageOnly.message, '生成前数据快照失败：SEEK_HOLE');
  assert.notEqual(pipelineErrorFingerprint({ currentStage: 'project_generate', error: '', stages: [{ id: 'project_generate', error: stageOnly.message }] }), 'project_generate:no-error');
});

test('project throughput monitor alerts only after a continuous zero-output window', () => {
  const nowMs = Date.parse('2026-08-15T13:15:00Z');
  const jobs = [{
    id: 'generating',
    status: 'running',
    currentStage: 'project_generate',
    stages: [{ id: 'project_generate', status: 'running' }],
  }, { id: 'waiting', status: 'draft', stages: [{ id: 'project_plan', status: 'pending' }] }];
  const first = pipelineProjectThroughputMonitor(jobs, {}, { nowMs });
  assert.equal(first.state.status, 'monitoring');
  assert.equal(first.observation, null);
  const stalled = pipelineProjectThroughputMonitor(jobs, first.state, {
    nowMs: nowMs + PIPELINE_PROJECT_THROUGHPUT_STALL_MS,
  });
  assert.equal(stalled.state.status, 'stalled');
  assert.equal(stalled.observation.type, 'throughput_stall');
  assert.match(stalled.observation.message, /连续 75 分钟/);
});

test('project throughput monitor resets after a generated project succeeds', () => {
  const startMs = Date.parse('2026-08-15T12:00:00Z');
  const previous = {
    windowStartedAt: new Date(startMs).toISOString(),
    lastGeneratedAt: null,
  };
  const finishedAt = '2026-08-15T13:14:00Z';
  const result = pipelineProjectThroughputMonitor([{
    id: 'completed-generation',
    status: 'running',
    currentStage: 'project_validate',
    stages: [{ id: 'project_generate', status: 'passed', finishedAt }],
  }], previous, { nowMs: Date.parse('2026-08-15T13:15:00Z') });
  assert.equal(result.state.status, 'monitoring');
  assert.equal(result.state.elapsedMs, 0);
  assert.equal(result.state.lastGeneratedAt, finishedAt);
  assert.equal(result.observation, null);
});
