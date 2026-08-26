import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySubmissionQualityIncident,
  isContributorQualityBlocked,
  recordSubmissionQualityIncident,
} from './submission-quality.js';

test('infrastructure failures are not quality incidents', () => {
  assert.equal(classifySubmissionQualityIncident({ status: 'failed', currentStage: 'project_validate', error: 'Cannot connect to the Docker daemon' }), null);
  assert.equal(classifySubmissionQualityIncident({ status: 'failed', currentStage: 'project_validate', error: '项目生成前数据快照失败 SEEK_HOLE' }), null);
  assert.equal(classifySubmissionQualityIncident({
    status: 'failed',
    currentStage: 'bug3_cloud_upload',
    error: 'pre_fix 验证证明不完整或绑定失效：pre_fix 证明源码 commit 与任务元数据不一致',
  }), null);
  assert.equal(classifySubmissionQualityIncident({
    status: 'failed',
    currentStage: 'bug9_cloud_upload',
    error: 'pre_fix 验证证明不完整或绑定失效：pre_fix 证明提示词与系统固定提示不一致',
  }), null);
});

test('actual red-green behavior failures remain quality incidents', () => {
  const incident = classifySubmissionQualityIncident({
    status: 'failed',
    currentStage: 'bug3_pre_verify',
    error: 'BUG_BASE 目标回归测试没有失败，pre_fix 红测失败',
  });
  assert.equal(incident?.type, 'red_green_invalid');
});

test('two different deterministic project quality failures block a contributor', () => {
  let state = {};
  const first = recordSubmissionQualityIncident(state, { contributorId: 'person-a', jobId: 'job-1', type: 'project_unrunnable' });
  state = first.state;
  assert.equal(first.blocked, false);
  const second = recordSubmissionQualityIncident(state, { contributorId: 'person-a', jobId: 'job-2', type: 'red_green_invalid' });
  assert.equal(second.blocked, true);
  assert.equal(isContributorQualityBlocked(second.state, 'person-a'), true);
});

test('the same project failure is recorded only once', () => {
  const first = recordSubmissionQualityIncident({}, { contributorId: 'person-a', jobId: 'job-1', type: 'unrelated_verify_cmds' });
  const second = recordSubmissionQualityIncident(first.state, { contributorId: 'person-a', jobId: 'job-1', type: 'unrelated_verify_cmds' });
  assert.equal(second.added, false);
  assert.equal(second.state.incidents.length, 1);
});
