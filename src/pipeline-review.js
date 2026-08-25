export const USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
// Injection review is a separate human gate from user_query review. Keep the
// same five-minute operational timeout, but give it its own predicate so the
// UI and scheduler cannot accidentally treat an injection failure as a topic
// confirmation.
export const INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS = 5 * 60 * 1000;

export function userQueryReviewAgeMs(stage, nowMs = Date.now()) {
  const startedAt = Date.parse(stage?.reviewStartedAt || stage?.startedAt || '');
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, nowMs - startedAt);
}

export function isUserQueryReviewStale(stage, nowMs = Date.now()) {
  return stage?.stage === 'user_query_review'
    && !['passed', 'skipped'].includes(stage?.status)
    && userQueryReviewAgeMs(stage, nowMs) >= USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS;
}

export function isInjectionReviewStale(job, nowMs = Date.now()) {
  const pending = job?.injectionReviewPending;
  if (job?.status !== 'waiting_review' || !Array.isArray(pending?.bugIndexes) || !pending.bugIndexes.length) return false;
  const requestedAt = Date.parse(pending.requestedAt || '');
  return Number.isFinite(requestedAt)
    && nowMs - requestedAt >= INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS;
}
