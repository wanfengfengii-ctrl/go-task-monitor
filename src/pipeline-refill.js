import { isPipelineAutofillEligible, pendingPipelineReplacementSources, pipelineOccupiedJobIds, pipelineRetryState, selectPipelineAutofillCandidates } from './pipeline-concurrency.js';
import { assessProjectDomain, inferProjectDomainFamily, PROJECT_DOMAIN_FAMILIES, projectDomainFamily } from './project-domain-rules.js';
import { assignFrontendFlags } from './bug-policy.js';
import { pipelineBugQuota } from './pipeline-rules.js';

export const PIPELINE_REFILL_BATCH_SIZE = 2;
export const PIPELINE_REFILL_BUG_COUNT = 10;
export const PIPELINE_REFILL_FAILURE_COOLDOWN_MS = 60_000;
// Match the four-project scheduler so the final healthy slot can be planned
// instead of remaining idle behind a lower work-in-progress ceiling.
export const PIPELINE_INCOMPLETE_PROJECT_LIMIT = 4;
export const PIPELINE_TASK_TYPE_POLICY_VERSION = 3;
export const PIPELINE_TASK_TYPE_RATIO = Object.freeze({ bugfix: 7, diagnosis: 3 });
export const PIPELINE_LARGE_PROJECT_CANARY_LIMIT = 10;

// A project remains part of the work-in-progress budget until it reaches a
// terminal delivery state. Failed projects are intentionally counted while
// Codex triage/retry is pending so refill cannot outrun recovery.
export function isPipelineProjectIncomplete(job = {}) {
  // A user-held project is intentionally outside the runnable supply. Its
  // Runner can race with the stop request and persist `failed` after the API
  // has set manualHold, but that residue must not consume a refill slot.
  return Boolean(job
    && job.manualHold !== true
    && !['passed', 'abandoned', 'stopped'].includes(String(job.status || '')));
}

export function countIncompletePipelineProjects(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).filter(isPipelineProjectIncomplete).length;
}

export function pipelineRefillCapacity(jobs = [], limit = PIPELINE_INCOMPLETE_PROJECT_LIMIT) {
  return Math.max(0, Math.floor(Number(limit) || PIPELINE_INCOMPLETE_PROJECT_LIMIT) - countIncompletePipelineProjects(jobs));
}

// Automatic refill stays standard by default. A persisted canary budget can
// promote the next successful projects to the large tier without changing the
// long-term refill policy.
export function autoRefillProjectTiers(count = PIPELINE_REFILL_BATCH_SIZE, { largeCount = 0 } = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const promoted = Math.min(total, Math.max(0, Math.floor(Number(largeCount) || 0)));
  return Array.from({ length: total }, (_, index) => index < promoted ? 'large' : 'standard');
}

export function normalizeLargeProjectCanary(value = {}) {
  const targetCount = Math.min(
    PIPELINE_LARGE_PROJECT_CANARY_LIMIT,
    Math.max(0, Math.floor(Number(value?.targetCount) || 0)),
  );
  const createdJobIds = [...new Set(
    (Array.isArray(value?.createdJobIds) ? value.createdJobIds : [])
      .map(text)
      .filter(Boolean),
  )].slice(0, targetCount);
  const remainingCount = Math.max(0, targetCount - createdJobIds.length);
  return {
    id: text(value?.id),
    status: targetCount === 0 ? 'idle' : remainingCount === 0 ? 'completed' : 'armed',
    targetCount,
    remainingCount,
    createdJobIds,
    requestedAt: value?.requestedAt || null,
    updatedAt: value?.updatedAt || null,
    finishedAt: remainingCount === 0 && targetCount > 0 ? (value?.finishedAt || value?.updatedAt || null) : null,
  };
}

export function reconcileLargeProjectCanary(value = {}, jobs = []) {
  const canary = normalizeLargeProjectCanary(value);
  if (!canary.id || canary.targetCount === 0) return canary;
  const discoveredJobIds = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => text(job?.request?.largeProjectCanaryId) === canary.id)
    .map((job) => text(job?.id))
    .filter(Boolean);
  return normalizeLargeProjectCanary({
    ...canary,
    createdJobIds: [...canary.createdJobIds, ...discoveredJobIds],
  });
}

export function recordLargeProjectCanaryJob(value = {}, jobId = '') {
  const canary = normalizeLargeProjectCanary(value);
  const normalizedJobId = text(jobId);
  if (!canary.id || !normalizedJobId || canary.remainingCount === 0) return canary;
  return normalizeLargeProjectCanary({
    ...canary,
    createdJobIds: [...canary.createdJobIds, normalizedJobId],
  });
}

function elapsedStageMs(stage = {}) {
  const cumulative = Number(stage.cumulativeDurationMs);
  if (Number.isFinite(cumulative) && cumulative > 0) return cumulative;
  const attempts = (Array.isArray(stage.attempts) ? stage.attempts : []).reduce((total, attempt) => {
    const startedAt = Date.parse(attempt?.startedAt || '');
    const finishedAt = Date.parse(attempt?.finishedAt || '');
    return total + (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
      ? finishedAt - startedAt
      : 0);
  }, 0);
  if (attempts > 0) return attempts;
  const startedAt = Date.parse(stage.startedAt || '');
  const finishedAt = Date.parse(stage.finishedAt || '');
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? finishedAt - startedAt
    : 0;
}

export function largeProjectCanaryBenchmark(value = {}, jobs = [], { nowMs = Date.now() } = {}) {
  const canary = reconcileLargeProjectCanary(value, jobs);
  const byId = new Map((Array.isArray(jobs) ? jobs : []).map((job) => [text(job?.id), job]));
  const runs = canary.createdJobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    if (!job) return [];
    const createdMs = Date.parse(job.createdAt || '');
    const startedMs = Date.parse(job.startedAt || job.runStartedAt || '');
    const finishedMs = Date.parse(job.finishedAt || '');
    const passed = job.status === 'passed' && Number.isFinite(finishedMs);
    const effectiveEndMs = passed ? finishedMs : nowMs;
    return [{
      jobId,
      status: String(job.status || ''),
      currentStage: String(job.currentStage || ''),
      createdAt: job.createdAt || null,
      startedAt: job.startedAt || job.runStartedAt || null,
      finishedAt: passed ? job.finishedAt : null,
      queueMs: Number.isFinite(createdMs) && Number.isFinite(startedMs) && startedMs >= createdMs ? startedMs - createdMs : null,
      runElapsedMs: Number.isFinite(startedMs) && effectiveEndMs >= startedMs ? effectiveEndMs - startedMs : null,
      wallElapsedMs: Number.isFinite(createdMs) && effectiveEndMs >= createdMs ? effectiveEndMs - createdMs : null,
      projectGenerateMs: elapsedStageMs((job.stages || []).find((stage) => stage.id === 'project_generate')),
      projectValidateMs: elapsedStageMs((job.stages || []).find((stage) => stage.id === 'project_validate')),
      deliveredBugCount: (job.bugs || []).filter((bug) => bug?.disposition === 'delivered').length,
      requestedBugCount: Math.max(0, Number(job.request?.bugCount || 0)),
    }];
  });
  const passedCount = runs.filter((run) => run.status === 'passed').length;
  const failedCount = runs.filter((run) => ['failed', 'abandoned', 'stopped'].includes(run.status)).length;
  const createdTimes = runs.map((run) => Date.parse(run.createdAt || '')).filter(Number.isFinite);
  const finishedTimes = runs.map((run) => Date.parse(run.finishedAt || '')).filter(Number.isFinite);
  const benchmarkStartedMs = createdTimes.length ? Math.min(...createdTimes) : null;
  const benchmarkFinishedMs = passedCount === canary.targetCount && finishedTimes.length === canary.targetCount
    ? Math.max(...finishedTimes)
    : null;
  return {
    status: canary.targetCount === 0
      ? 'idle'
      : runs.length < canary.targetCount
        ? 'waiting_creation'
        : passedCount === canary.targetCount
          ? 'completed'
          : failedCount > 0
            ? 'needs_attention'
            : 'running',
    targetCount: canary.targetCount,
    createdCount: runs.length,
    passedCount,
    failedCount,
    activeCount: runs.filter((run) => ['draft', 'queued', 'running', 'waiting_resource', 'waiting_review'].includes(run.status)).length,
    startedAt: benchmarkStartedMs == null ? null : new Date(benchmarkStartedMs).toISOString(),
    finishedAt: benchmarkFinishedMs == null ? null : new Date(benchmarkFinishedMs).toISOString(),
    wallElapsedMs: benchmarkStartedMs == null
      ? 0
      : (benchmarkFinishedMs == null ? nowMs : benchmarkFinishedMs) - benchmarkStartedMs,
    runs,
  };
}

export function normalizePipelineTaskTypeCounts(value = {}) {
  return {
    bugfix: Math.max(0, Math.floor(Number(value?.bugfix) || 0)),
    diagnosis: Math.max(0, Math.floor(Number(value?.diagnosis) || 0)),
  };
}

export function applyPipelineTaskTypePolicy(state = {}) {
  if (Number(state.taskTypePolicyVersion || 0) === PIPELINE_TASK_TYPE_POLICY_VERSION) {
    return {
      ...state,
      taskTypeCounts: normalizePipelineTaskTypeCounts(state.taskTypeCounts),
    };
  }
  const counts = { bugfix: 0, diagnosis: 0 };
  return {
    ...state,
    taskTypePolicyVersion: PIPELINE_TASK_TYPE_POLICY_VERSION,
    taskTypeCounts: counts,
    taskTypeCountsBeforeBatch: counts,
  };
}

export function pipelineCommittedTaskTypeCounts(jobs = []) {
  const counts = { bugfix: 0, diagnosis: 0 };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (['abandoned', 'stopped'].includes(String(job?.status || ''))) continue;
    const taskType = String(job?.request?.taskType || '');
    if (taskType !== 'bugfix' && taskType !== 'diagnosis') continue;
    const bugCount = Math.max(0, Math.floor(Number(job?.request?.bugCount) || 0));
    counts[taskType] += bugCount;
  }
  return counts;
}

// Standard-only callers retain the deterministic project sequence. Refill
// planning supplies questionCounts so a 30-question project carries three
// times the balancing weight of a standard 10-question project.
export function allocatePipelineTaskTypes(count = PIPELINE_REFILL_BATCH_SIZE, currentCounts = {}, questionCounts = []) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const counts = normalizePipelineTaskTypeCounts(currentCounts);
  const weighted = Array.isArray(questionCounts) && questionCounts.length >= total;
  const assigned = [];
  for (let index = 0; index < total; index += 1) {
    const weight = weighted ? Math.max(1, Math.floor(Number(questionCounts[index]) || 1)) : 1;
    const nextTotal = counts.bugfix + counts.diagnosis + weight;
    let taskType;
    if (weighted) {
      const targetBugfix = PIPELINE_TASK_TYPE_RATIO.bugfix * nextTotal
        / (PIPELINE_TASK_TYPE_RATIO.bugfix + PIPELINE_TASK_TYPE_RATIO.diagnosis);
      const bugfixDistance = Math.abs(counts.bugfix + weight - targetBugfix);
      const diagnosisDistance = Math.abs(counts.bugfix - targetBugfix);
      taskType = bugfixDistance <= diagnosisDistance ? 'bugfix' : 'diagnosis';
    } else {
      taskType = (counts.bugfix * (PIPELINE_TASK_TYPE_RATIO.bugfix + PIPELINE_TASK_TYPE_RATIO.diagnosis)
        < PIPELINE_TASK_TYPE_RATIO.bugfix * nextTotal) ? 'bugfix' : 'diagnosis';
    }
    assigned.push(taskType);
    counts[taskType] += weight;
  }
  return assigned;
}

export function advancePipelineTaskTypeCounts(currentCounts = {}, taskTypes = [], questionCounts = []) {
  const counts = normalizePipelineTaskTypeCounts(currentCounts);
  const values = Array.isArray(taskTypes) ? taskTypes : [];
  const weighted = Array.isArray(questionCounts) && questionCounts.length >= values.length;
  for (let index = 0; index < values.length; index += 1) {
    const taskType = values[index];
    const weight = weighted ? Math.max(1, Math.floor(Number(questionCounts[index]) || 1)) : 1;
    if (taskType === 'bugfix' || taskType === 'diagnosis') counts[taskType] += weight;
  }
  return counts;
}

export function allocateProjectDomainFamilies(jobs = [], count = PIPELINE_REFILL_BATCH_SIZE) {
  const recentJobs = [...(Array.isArray(jobs) ? jobs : [])]
    .sort((left, right) => String(right?.createdAt || '').localeCompare(String(left?.createdAt || '')))
    .slice(0, 60);
  const usage = new Map(PROJECT_DOMAIN_FAMILIES.map((family) => [family.id, {
    count: 0,
    recentIndex: Number.POSITIVE_INFINITY,
  }]));
  recentJobs.forEach((job, index) => {
    const family = inferProjectDomainFamily({
      projectDomain: job?.request?.projectDomain,
      title: job?.request?.autoRefillTitle || job?.project?.title,
      projectBrief: job?.request?.projectBrief,
      overview: job?.project?.overview,
    });
    const entry = usage.get(family?.id);
    if (!entry) return;
    entry.count += 1;
    entry.recentIndex = Math.min(entry.recentIndex, index);
  });

  const assigned = [];
  const total = Math.max(0, Math.floor(Number(count) || 0));
  while (assigned.length < total) {
    const roundStart = Math.floor(assigned.length / PROJECT_DOMAIN_FAMILIES.length) * PROJECT_DOMAIN_FAMILIES.length;
    const usedThisRound = new Set(assigned.slice(roundStart).map((family) => family.id));
    const candidates = PROJECT_DOMAIN_FAMILIES.filter((family) => !usedThisRound.has(family.id));
    candidates.sort((left, right) => {
      const leftUsage = usage.get(left.id);
      const rightUsage = usage.get(right.id);
      return leftUsage.count - rightUsage.count
        || rightUsage.recentIndex - leftUsage.recentIndex
        || left.id.localeCompare(right.id);
    });
    const selected = candidates[0];
    assigned.push(selected);
    const selectedUsage = usage.get(selected.id);
    selectedUsage.count += 1;
    selectedUsage.recentIndex = -assigned.length;
  }
  return assigned;
}

function text(value) {
  return String(value || '').trim();
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''));
}

export function normalizePipelineRefillPlan(value, {
  count = PIPELINE_REFILL_BATCH_SIZE,
  taskTypes = [],
  projectTiers = autoRefillProjectTiers(count),
  frontendFlags = assignFrontendFlags(count),
  projectDomains = PROJECT_DOMAIN_FAMILIES.slice(0, count),
} = {}) {
  const questions = Array.isArray(value?.questions) ? value.questions : [];
  if (questions.length !== count) {
    throw new Error(`Codex 必须一次返回 ${count} 个项目题目，实际为 ${questions.length} 个`);
  }

  const normalized = questions.map((question, index) => {
    const title = text(question?.title);
    const projectBrief = text(question?.projectBrief);
    const requestedDomain = projectDomains[index];
    const projectDomain = projectDomainFamily(question?.projectDomain);
    const issues = [];
    if (title.length < 6) issues.push('标题少于 6 个字符');
    if (!hasChinese(title)) issues.push('标题必须包含中文');
    if (projectBrief.length < 60) issues.push('项目要求少于 60 个字符');
    if (!hasChinese(projectBrief)) issues.push('项目要求必须使用中文');
    if (!projectDomain) issues.push('projectDomain 不属于系统分配的领域类别');
    if (requestedDomain && projectDomain?.id !== requestedDomain.id) {
      issues.push(`projectDomain 必须使用系统分配的 ${requestedDomain.id}`);
    }
    const domain = assessProjectDomain({ title, projectBrief });
    if (!domain.ok) issues.push(...domain.issues);
    if (issues.length) throw new Error(`Codex 第 ${index + 1} 题不完整：${issues.join('；')}`);
    const projectTier = text(projectTiers[index] || 'standard');
    if (!['standard', 'large'].includes(projectTier)) {
      throw new Error(`系统为第 ${index + 1} 题分配了不支持的项目规模：${projectTier || '空'}`);
    }
    const bugCount = pipelineBugQuota(projectTier);
    return {
      index: index + 1,
      title,
      projectBrief,
      projectDomain: projectDomain.id,
      projectDomainLabel: projectDomain.label,
      taskType: taskTypes[index] || (
        index < Math.ceil(count * PIPELINE_TASK_TYPE_RATIO.bugfix
          / (PIPELINE_TASK_TYPE_RATIO.bugfix + PIPELINE_TASK_TYPE_RATIO.diagnosis))
          ? 'bugfix'
          : 'diagnosis'
      ),
      bugCount,
      projectTier,
      frontendRequired: Boolean(frontendFlags[index]),
      maxTrajectoryAttempts: 3,
    };
  });

  const uniqueTitles = new Set(normalized.map((question) => question.title));
  const uniqueBriefs = new Set(normalized.map((question) => question.projectBrief));
  if (uniqueTitles.size !== normalized.length || uniqueBriefs.size !== normalized.length) {
    throw new Error(`Codex 自动补充的 ${count} 个题目必须互不重复`);
  }
  return normalized;
}

export function pipelineSupplySnapshot(jobs, currentWorkflowVersion, currentVerificationPolicyVersion = 0) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const occupiedJobIds = pipelineOccupiedJobIds(allJobs);
  const managedJobs = allJobs.filter((job) => isPipelineAutofillEligible(job, currentWorkflowVersion, currentVerificationPolicyVersion));
  const runnable = selectPipelineAutofillCandidates(managedJobs, occupiedJobIds, PIPELINE_REFILL_BATCH_SIZE);
  const waitingForCloud = managedJobs.filter((job) => pipelineRetryState(job).waitingForCloud);
  const waitingForPlatform = managedJobs.filter((job) => pipelineRetryState(job).waitingForPlatform);
  const replacementSources = pendingPipelineReplacementSources(allJobs).slice(0, PIPELINE_REFILL_BATCH_SIZE);
  return {
    occupiedCount: occupiedJobIds.size,
    runnableCount: runnable.length,
    waitingForCloudCount: waitingForCloud.length,
    waitingForPlatformCount: waitingForPlatform.length,
    replacementCount: replacementSources.length,
    replacementSourceJobIds: replacementSources.map((job) => job.id),
    idle: occupiedJobIds.size === 0 && runnable.length === 0 && waitingForCloud.length === 0 && waitingForPlatform.length === 0,
    depleted: runnable.length === 0 && waitingForCloud.length === 0 && waitingForPlatform.length === 0,
  };
}

export function reconcilePipelineRefillCreatedJobs(refillState = {}, jobs = []) {
  const batchId = text(refillState.batchId);
  const validJobIds = new Set(
    (Array.isArray(jobs) ? jobs : [])
      .filter((job) => !batchId || text(job?.request?.autoRefillBatchId) === batchId)
      .map((job) => text(job?.id))
      .filter(Boolean),
  );
  const createdJobIds = [...new Set(
    (Array.isArray(refillState.createdJobIds) ? refillState.createdJobIds : [])
      .map(text)
      .filter((jobId) => jobId && validJobIds.has(jobId)),
  )];
  return { ...refillState, createdJobIds };
}

export function shouldStartPipelineRefill(jobs, {
  autoFillEnabled,
  currentWorkflowVersion,
  currentVerificationPolicyVersion = 0,
  refillState = {},
  nowMs = Date.now(),
} = {}) {
  const supply = pipelineSupplySnapshot(jobs, currentWorkflowVersion, currentVerificationPolicyVersion);
  const incompleteCount = countIncompletePipelineProjects(jobs);
  const capacity = pipelineRefillCapacity(jobs);
  const withBudget = (result) => ({ ...result, incompleteCount, incompleteLimit: PIPELINE_INCOMPLETE_PROJECT_LIMIT, capacity });
  if (!autoFillEnabled) return { start: false, reason: 'disabled', supply };
  if (capacity <= 0) return withBudget({ start: false, reason: 'incomplete-project-limit', supply });
  if (refillState.status === 'failed' && Number(refillState.retryAfter || 0) > nowMs) {
    return withBudget({ start: false, reason: 'failure-cooldown', supply });
  }
  const persistedTargetCount = Number(refillState.targetCount || refillState.specs?.length || 0);
  const persistedCreatedCount = Number(refillState.createdJobIds?.length || 0);
  const resumable = ['planning', 'provisioning'].includes(refillState.status)
    || (refillState.status === 'failed' && persistedTargetCount > Number(refillState.createdJobIds?.length || 0));
  if (resumable) {
    return withBudget({
      start: true,
      reason: 'resume-incomplete-batch',
      targetCount: Math.min(persistedTargetCount || PIPELINE_REFILL_BATCH_SIZE, persistedCreatedCount + capacity),
      replacementSourceJobIds: refillState.replacementSourceJobIds || [],
      supply,
    });
  }
  if (supply.replacementCount > 0) {
    return withBudget({
      start: true,
      reason: 'replace-abandoned',
      targetCount: Math.min(supply.replacementCount, capacity),
      replacementSourceJobIds: supply.replacementSourceJobIds.slice(0, capacity),
      supply,
    });
  }
  if (!supply.depleted) return withBudget({ start: false, reason: 'pipeline-supply-available', supply });
  return withBudget({
    start: true,
    reason: 'supply-empty',
    targetCount: Math.min(PIPELINE_REFILL_BATCH_SIZE, capacity),
    replacementSourceJobIds: [],
    supply,
  });
}

export function publicPipelineRefillState(state = {}, jobs = [], options = {}) {
  const largeProjectCanary = normalizeLargeProjectCanary(state.largeProjectCanary);
  return {
    status: state.status || 'idle',
    batchId: state.batchId || '',
    requestedAt: state.requestedAt || null,
    updatedAt: state.updatedAt || null,
    finishedAt: state.finishedAt || null,
    retryAfter: state.retryAfter || null,
    plannedCount: Array.isArray(state.specs) ? state.specs.length : 0,
    createdCount: Array.isArray(state.createdJobIds) ? state.createdJobIds.length : 0,
    mode: state.mode || 'batch',
    taskTypePolicyVersion: Number(state.taskTypePolicyVersion || 0),
    taskTypeCounts: normalizePipelineTaskTypeCounts(state.taskTypeCounts),
    largeProjectCanary: {
      ...largeProjectCanary,
      benchmark: largeProjectCanaryBenchmark(largeProjectCanary, jobs, options),
    },
    replacementCount: Array.isArray(state.replacementSourceJobIds) ? state.replacementSourceJobIds.length : 0,
    error: state.error || '',
  };
}
