import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractTrajectorySessionId,
  requireUniquePassedTaskForSession,
  selectPermanentSignedUrl,
} from './trajectory-upload-rules.js';

test('trajectory filename yields its normalized session ID', () => {
  assert.equal(
    extractTrajectorySessionId('trajectory_D5889C13-4327-499D-BEA1-5F3DA042AEE5.json'),
    'd5889c13-4327-499d-bea1-5f3da042aee5',
  );
  assert.equal(
    extractTrajectorySessionId('trajectory_D5889C13-4327-499D-BEA1-5F3DA042AEE5.jsonl'),
    'd5889c13-4327-499d-bea1-5f3da042aee5',
  );
  assert.throws(
    () => extractTrajectorySessionId('trajectory.json'),
    /trajectory_<session-id>\.json/,
  );
});

test('permanent signed URL prefers explicit signed fields and requires HTTPS', () => {
  assert.equal(
    selectPermanentSignedUrl({ signedUrl: 'https://upload.example.com/signed/abc', directUrl: 'https://upload.example.com/direct/abc' }),
    'https://upload.example.com/signed/abc',
  );
  assert.equal(
    selectPermanentSignedUrl({ url: 'https://upload.example.com/signed/abc', directUrl: 'https://upload.example.com/direct/abc' }),
    'https://upload.example.com/signed/abc',
  );
  assert.equal(
    selectPermanentSignedUrl({ url: '/signed/abc' }, 'https://upload.example.com'),
    'https://upload.example.com/signed/abc',
  );
  assert.throws(
    () => selectPermanentSignedUrl({ url: 'http://upload.example.com/signed/abc' }),
    /必须使用 HTTPS/,
  );
  assert.throws(() => selectPermanentSignedUrl({}), /未返回有效的永久签名链接/);
});

test('session ID maps to exactly one passed task', () => {
  const sessionId = 'd5889c13-4327-499d-bea1-5f3da042aee5';
  const task = { id: 'batch--sample', status: 'passed', sessionId };
  assert.equal(requireUniquePassedTaskForSession([task], sessionId), task);
  assert.throws(
    () => requireUniquePassedTaskForSession([{ ...task, status: 'failed' }], sessionId, 'trajectory_sample.json'),
    /找不到 session ID 对应的已通过题目/,
  );
  assert.throws(
    () => requireUniquePassedTaskForSession([task, { ...task, id: 'batch-2--sample' }], sessionId, 'trajectory_sample.json'),
    /对应多道题目/,
  );
});
