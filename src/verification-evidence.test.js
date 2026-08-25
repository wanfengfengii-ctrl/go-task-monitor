import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVerificationResult,
  normalizeVerificationResult,
  normalizeVerifyCommands,
  serializeVerificationResult,
  verificationResultIssues,
} from './verification-evidence.js';

const pre = {
  trajectory_url: 'https://cos.example.com/trajectory_11111111-1111-4111-8111-111111111111.jsonl',
  session_id: '11111111-1111-4111-8111-111111111111',
  result: 'red',
};
const post = {
  trajectory_url: 'https://cos.example.com/trajectory_22222222-2222-4222-8222-222222222222.jsonl',
  session_id: '22222222-2222-4222-8222-222222222222',
  result: 'green',
};

test('bugfix verification result requires independent red and green proof sessions', () => {
  const value = buildVerificationResult({ taskType: 'bugfix', preFix: pre, postFix: post });
  assert.deepEqual(value, { pre_fix: pre, post_fix: post });
  assert.equal(verificationResultIssues(value, { taskType: 'bugfix' }).length, 0);
  assert.match(serializeVerificationResult(value, { taskType: 'bugfix' }), /^\{"pre_fix"/);
});

test('diagnosis verification result accepts only the model-before red proof', () => {
  assert.deepEqual(normalizeVerificationResult({ pre_fix: pre }, { taskType: 'diagnosis' }), { pre_fix: pre });
  assert.match(verificationResultIssues({ pre_fix: pre, post_fix: post }, { taskType: 'diagnosis' }).join(';'), /只能上传/);
});

test('verification sessions cannot reuse the main task session', () => {
  assert.match(verificationResultIssues({ pre_fix: pre, post_fix: post }, {
    taskType: 'bugfix',
    mainSessionId: pre.session_id,
  }).join(';'), /互不重复/);
});

test('verify commands normalize arrays and newline text consistently', () => {
  assert.deepEqual(normalizeVerifyCommands([' go test ./... ', '', 'go vet ./...']), ['go test ./...', 'go vet ./...']);
  assert.deepEqual(normalizeVerifyCommands('go test ./...\n\ngo vet ./...'), ['go test ./...', 'go vet ./...']);
});
