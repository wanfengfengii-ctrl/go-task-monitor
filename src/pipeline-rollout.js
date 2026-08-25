import { pipelineRetryState } from './pipeline-concurrency.js';

export const PIPELINE_ROLLOUT_MODES = new Set(['drain_to_v2', 'v2_canary', 'v2_live']);

function createdOrder(left, right) {
  return String(left?.createdAt || '').localeCompare(String(right?.createdAt || ''))
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function canBecomeCanary(job) {
  if (job?.manualRetryRequestedAt && !['passed', 'abandoned'].includes(job?.status)) return true;
  if (['draft', 'waiting_resource', 'queued', 'running'].includes(job?.status)) return true;
  if (job?.status !== 'failed') return false;
  return pipelineRetryState(job).automaticRetryPending;
}

export function normalizePipelineRolloutState(value = {}) {
  return {
    mode: PIPELINE_ROLLOUT_MODES.has(value.mode) ? value.mode : 'drain_to_v2',
    canaryJobId: String(value.canaryJobId || ''),
    updatedAt: value.updatedAt || null,
  };
}

// Restrict the launch pool before priority sorting/slicing. Applying this
// after selection can consume the only scheduler slot with a non-canary job
// and then filter it out, leaving a failed canary stranded indefinitely.
export function rolloutEligibleJobs(jobs = [], rollout = {}) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  if (!Array.isArray(rollout?.allowJobIds)) return allJobs;
  const allowed = new Set(rollout.allowJobIds.map((id) => String(id)));
  return allJobs.filter((job) => (
    allowed.has(String(job?.id || ''))
    || (rollout.mode === 'v2_canary' && job?.status === 'waiting_resource')
  ));
}

export function pipelineRolloutDecision(jobs, currentWorkflowVersion, rolloutState = {}) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const state = normalizePipelineRolloutState(rolloutState);
  const occupied = allJobs.filter((job) => ['queued', 'running'].includes(job?.status));
  const legacyOccupied = occupied.filter((job) => Number(job?.workflowVersion || 1) < Number(currentWorkflowVersion));
  const currentJobs = allJobs.filter((job) => Number(job?.workflowVersion || 1) >= Number(currentWorkflowVersion));
  const currentOccupied = occupied.filter((job) => Number(job?.workflowVersion || 1) >= Number(currentWorkflowVersion));

  // V3 is the current production workflow. The canary rollout was a one-time
  // V2 migration guard and must not serialize otherwise independent V3 jobs.
  // Keep the legacy decision behavior below for callers/tests that explicitly
  // evaluate V1 -> V2 migration, but once the current workflow is V3 or newer
  // every eligible current job may use the normal concurrency slots.
  if (Number(currentWorkflowVersion) >= 3) {
    return {
      mode: 'v2_live',
      canaryJobId: '',
      updatedAt: state.updatedAt,
      legacyActiveCount: legacyOccupied.length,
      allowJobIds: null,
      transition: state.mode === 'v2_live' ? null : 'rollout_disabled_for_v3',
    };
  }

  if (state.mode === 'v2_live') {
    return { ...state, legacyActiveCount: legacyOccupied.length, allowJobIds: null, transition: null };
  }

  if (state.mode === 'drain_to_v2' && legacyOccupied.length) {
    const canaryJobId = state.canaryJobId || currentOccupied.sort(createdOrder)[0]?.id || '';
    return {
      ...state,
      canaryJobId,
      legacyActiveCount: legacyOccupied.length,
      allowJobIds: [],
      transition: canaryJobId && canaryJobId !== state.canaryJobId ? 'canary_detected' : null,
    };
  }

  let canary = currentJobs.find((job) => job.id === state.canaryJobId);
  if (canary?.status === 'abandoned' && canary.replacementJobId) {
    canary = currentJobs.find((job) => job.id === canary.replacementJobId) || canary;
  }
  if (state.mode === 'v2_canary' && canary?.status === 'passed') {
    return {
      mode: 'v2_live',
      canaryJobId: canary.id,
      updatedAt: state.updatedAt,
      legacyActiveCount: legacyOccupied.length,
      allowJobIds: null,
      transition: 'canary_passed',
    };
  }
  const failedCanaryRetry = canary?.status === 'failed' ? pipelineRetryState(canary) : null;
  const canaryCannotRetry = Boolean(failedCanaryRetry?.exhausted || failedCanaryRetry?.nonRetryable);
  const needsCanaryReplacement = !canary || canaryCannotRetry || ['passed', 'abandoned', 'stopped'].includes(canary.status);
  if (needsCanaryReplacement) {
    const previousCanaryId = canary?.id || state.canaryJobId;
    canary = currentJobs
      .filter((job) => job.id !== previousCanaryId && canBecomeCanary(job))
      .sort(createdOrder)[0] || null;
  }

  const canaryJobId = canary?.id || (needsCanaryReplacement ? '' : state.canaryJobId);
  const manualRecoveryIds = currentJobs
    .filter((job) => job.id !== canaryJobId && job.manualRetryRequestedAt && canBecomeCanary(job))
    .map((job) => job.id);
  return {
    mode: 'v2_canary',
    canaryJobId,
    updatedAt: state.updatedAt,
    legacyActiveCount: legacyOccupied.length,
    // Canary mode blocks automatic rollout, but an explicit user recovery
    // must still reach central priority sorting instead of waiting for an
    // unrelated multi-Bug canary project to finish end to end.
    allowJobIds: [...new Set([...(canaryJobId ? [canaryJobId] : []), ...manualRecoveryIds])],
    transition: state.mode === 'drain_to_v2' ? 'legacy_drained' : canaryJobId !== state.canaryJobId ? 'canary_replaced' : null,
  };
}
