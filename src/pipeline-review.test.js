import assert from 'node:assert/strict';
import test from 'node:test';
import { isInjectionReviewStale, isUserQueryReviewStale, INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS, USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS, userQueryReviewAgeMs } from './pipeline-review.js';

test('user query review is not stale before five minutes', () => {
  const now = Date.parse('2026-08-21T00:10:00.000Z');
  const stage = { stage: 'user_query_review', status: 'pending', reviewStartedAt: '2026-08-21T00:05:01.000Z' };
  assert.equal(userQueryReviewAgeMs(stage, now), USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS - 1000);
  assert.equal(isUserQueryReviewStale(stage, now), false);
});

test('user query review becomes stale at five minutes', () => {
  const now = Date.parse('2026-08-21T00:10:00.000Z');
  const stage = { stage: 'user_query_review', status: 'pending', reviewStartedAt: '2026-08-21T00:05:00.000Z' };
  assert.equal(isUserQueryReviewStale(stage, now), true);
  assert.equal(isUserQueryReviewStale({ ...stage, status: 'passed' }, now), false);
});

test('injection review uses an independent five-minute timeout', () => {
  const now = Date.parse('2026-08-21T00:10:00.000Z');
  const job = { status: 'waiting_review', injectionReviewPending: { bugIndexes: [9], requestedAt: '2026-08-21T00:05:00.000Z' } };
  assert.equal(INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS, USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS);
  assert.equal(isInjectionReviewStale(job, now), true);
  assert.equal(isInjectionReviewStale({ ...job, injectionReviewPending: { ...job.injectionReviewPending, bugIndexes: [] } }, now), false);
  assert.equal(isInjectionReviewStale({ ...job, status: 'queued' }, now), false);
});
