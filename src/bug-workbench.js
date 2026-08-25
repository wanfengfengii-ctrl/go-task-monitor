export const BUG_WORKBENCH_STATUSES = new Set([
  'bug_ready',
  'fast_lane_queued',
  'fast_lane_running',
  'fast_lane_switching',
  'fast_lane_stopped',
  'fast_lane_failed',
  'fast_lane_completed',
  'delivered',
]);

const text = (value) => String(value ?? '').trim();

export function normalizeBugExecution(value = {}) {
  const selected = Number(value.selectedBugIndex);
  return {
    mode: text(value.mode) || 'workbench',
    selectedBugIndex: Number.isInteger(selected) && selected > 0 ? selected : null,
    autoContinue: value.autoContinue !== false,
    status: BUG_WORKBENCH_STATUSES.has(value.status) ? value.status : 'bug_ready',
    startedAt: value.startedAt || null,
    updatedAt: value.updatedAt || null,
    currentAttempt: Number(value.currentAttempt) > 0 ? Number(value.currentAttempt) : 0,
    currentStage: text(value.currentStage),
    subphase: text(value.subphase),
    resourceStage: text(value.resourceStage),
    lastHeartbeatAt: value.lastHeartbeatAt || null,
    blockedReason: text(value.blockedReason),
    lastAction: text(value.lastAction),
  };
}

// A retry requested while another Bug worker owns the project runner must be
// persisted separately from the global workbench cursor.  The cursor belongs
// to the currently running worker; this queue is consumed when that worker
// batch yields back to the runner.
export function enqueueBugRetry(job, bugIndex, at = new Date().toISOString()) {
  const index = Number(bugIndex);
  if (!Number.isInteger(index) || index < 1) throw new Error('Bug 编号不合法');
  const pending = Array.isArray(job?.pendingBugRetries) ? job.pendingBugRetries : [];
  job.pendingBugRetries = [...new Set([...pending.map(Number).filter((item) => Number.isInteger(item) && item > 0), index])]
    .sort((left, right) => left - right);
  job.updatedAt = at;
  return job.pendingBugRetries;
}

export function takeBugRetryQueue(job) {
  const pending = Array.isArray(job?.pendingBugRetries)
    ? [...new Set(job.pendingBugRetries.map(Number).filter((item) => Number.isInteger(item) && item > 0))]
    : [];
  if (job && Object.prototype.hasOwnProperty.call(job, 'pendingBugRetries')) delete job.pendingBugRetries;
  return pending.sort((left, right) => left - right);
}

export function bugExecutionSubphaseLabel(value = '') {
  const phase = text(value);
  const labels = {
    source_locating: '源码定位',
    first_source_edit: '首次修改完成',
    claude_capture_finalize: '修复轨迹整理',
    claude_repair_checkpoint_saved: 'Claude 修复完成',
    claude_repair_checkpoint_restored: '恢复 Claude 修复检查点',
    diagnosis_repair_checkpoint_saved: '诊断分析完成',
    independent_test_authoring: '独立测试编写',
    independent_test_authoring_complete: '独立测试编写完成',
    test_author_checkpoint_saved: '独立测试完成',
    test_author_checkpoint_restored: '恢复独立测试检查点',
    red_green_validation: '红绿验证',
    red_green_checkpoint_saved: '红绿验证完成',
    red_green_checkpoint_restored: '恢复红绿检查点',
    docker_validation: 'Docker 验证',
    docker_checkpoint_saved: 'Docker 验证完成',
    package_validation: '项目包装校验',
    git_publication: 'Git 发布',
    git_publication_complete: 'Git 发布完成',
  };
  return labels[phase] || phase;
}

// The worker keeps checkpoint subphases after it hands the Bug to the next
// resource.  Map those checkpoints to the next visible workbench phase so a
// stale subphase cannot fall through to the first phase (源码定位).
export function bugExecutionPhaseIndex(value = '', stage = '') {
  const phase = text(value);
  const stageId = text(stage);
  if (/git_publication|git_publication_complete|cloud_upload|verification_finalize|delivery_ready/.test(phase)
    || /(?:^|_)git_publication(?:$|_)|(?:^|_)(?:cloud_upload|verification_finalize|delivery_ready)(?:$|_)/.test(stageId)) return 5;
  if (/docker_checkpoint|docker|package_validation/.test(phase)
    || /(?:^|_)docker_validation(?:$|_)|(?:^|_)package_validation(?:$|_)/.test(stageId)) return 4;
  if (/red_green_checkpoint|red_green|pre_verify|post_verify/.test(phase)
    || /(?:^|_)(?:red_green|pre_verify|post_verify)(?:$|_)/.test(stageId)) return 3;
  // A repair or independent-test checkpoint means the next visible phase is
  // red/green validation, even when the persisted resource stage is stale.
  if (/diagnosis_repair_checkpoint|claude_repair_checkpoint|test_author_checkpoint|independent_test_authoring_complete/.test(phase)) return 3;
  if (/test_author|independent_test_authoring/.test(phase)
    || /(?:^|_)test_author(?:$|_)/.test(stageId)) return 2;
  if (/first_source_edit|claude_capture|claude_repair/.test(phase)
    || /(?:^|_)claude_fix(?:$|_)/.test(stageId)) return 1;
  if (/source_locating/.test(phase)
    || /(?:^|_)(?:bug_discovery|bug_source_prepare|task_prepare)(?:$|_)/.test(stageId)) return 0;
  return phase || stageId ? 0 : -1;
}

export function isBugDeliveryComplete(job, bugIndex) {
  const index = Number(bugIndex);
  return (job?.stages || []).some((stage) => stage.id === `bug${index}_delivery_ready`
    && ['passed', 'skipped'].includes(stage.status)
    && stage.status === 'passed');
}

export function isBugSkipped(job, bugIndex) {
  const bug = (job?.bugs || []).find((item) => Number(item?.bugIndex) === Number(bugIndex));
  return bug?.disposition === 'skipped'
    || (!isBugFailed(job, bugIndex)
      && (job?.stages || []).some((stage) => stage.id === `bug${Number(bugIndex)}_delivery_ready` && stage.status === 'skipped'));
}

export function isBugFailed(job, bugIndex) {
  const bug = (job?.bugs || []).find((item) => Number(item?.bugIndex) === Number(bugIndex));
  return bug?.disposition === 'failed' || bug?.failureDisposition === 'auto_continued';
}

export function nextIncompleteBugIndex(job, fromIndex = 1) {
  const bugs = [...(job?.bugs || [])]
    .map((bug) => Number(bug?.bugIndex))
    .filter((index) => Number.isInteger(index) && index >= 1)
    .sort((a, b) => a - b);
  const eligible = bugs.filter((index) => !isBugDeliveryComplete(job, index) && !isBugSkipped(job, index) && !isBugFailed(job, index));
  return eligible.find((index) => index >= Number(fromIndex || 1)) || eligible[0] || null;
}

export function bugAttemptDurationMs(attempt, nowMs = Date.now()) {
  const started = Date.parse(attempt?.startedAt || '');
  if (!Number.isFinite(started)) return 0;
  const finished = Date.parse(attempt?.finishedAt || '') || Number(nowMs);
  return Math.max(0, finished - started);
}

export function summarizeBugAttempts(bug, nowMs = Date.now()) {
  const attempts = Array.isArray(bug?.attempts) ? bug.attempts : [];
  const failures = attempts.filter((attempt) => attempt?.status === 'failed');
  const firstFailure = bug?.firstFailure || failures[0] || null;
  const lastFailure = bug?.lastFailure || failures.at(-1) || null;
  const current = attempts.findLast((attempt) => attempt?.status === 'running') || null;
  return {
    count: attempts.filter((attempt) => attempt?.status !== 'system').length,
    totalDurationMs: attempts.reduce((sum, attempt) => sum + bugAttemptDurationMs(attempt, nowMs), 0),
    currentDurationMs: current ? bugAttemptDurationMs(current, nowMs) : 0,
    currentAttempt: current?.attempt || 0,
    firstFailure,
    lastFailure,
    current,
  };
}

function publicBugAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return null;
  const {
    taskDir,
    goldDir,
    ...visible
  } = attempt;
  return visible;
}

export function beginBugAttempt(bug, {
  attempt,
  stage = '',
  sessionId = '',
  model = '',
  claudeCodeVersion = '',
  action = 'automatic_retry',
  startedAt = new Date().toISOString(),
} = {}) {
  const next = structuredClone(bug || {});
  const item = {
    attempt: Number(attempt) || (Array.isArray(next.attempts) ? next.attempts.length + 1 : 1),
    status: 'running',
    stage: text(stage),
    startedAt,
    finishedAt: null,
    durationMs: 0,
    sessionId: text(sessionId),
    model: text(model),
    claudeCodeVersion: text(claudeCodeVersion),
    exitCode: null,
    failureCategory: '',
    error: '',
    action: text(action) || 'automatic_retry',
  };
  next.attempts = [...(next.attempts || []), item];
  next.currentAttempt = item.attempt;
  next.attemptStartedAt = startedAt;
  return next;
}

export function finishBugAttempt(bug, result = {}, finishedAt = new Date().toISOString()) {
  const next = structuredClone(bug || {});
  const attempts = [...(next.attempts || [])];
  const index = [...attempts].reverse().findIndex((attempt) => attempt?.status === 'running');
  const targetIndex = index < 0 ? attempts.length - 1 : attempts.length - 1 - index;
  if (targetIndex < 0) return next;
  const target = attempts[targetIndex];
  target.status = result.status || 'failed';
  target.finishedAt = finishedAt;
  target.durationMs = bugAttemptDurationMs({ ...target, finishedAt }, Date.parse(finishedAt) || Date.now());
  Object.assign(target, {
    stage: text(result.stage || target.stage),
    sessionId: text(result.sessionId || target.sessionId),
    model: text(result.model || target.model),
    claudeCodeVersion: text(result.claudeCodeVersion || target.claudeCodeVersion),
    exitCode: result.exitCode ?? target.exitCode ?? null,
    failureCategory: text(result.failureCategory || target.failureCategory),
    error: text(result.error || ''),
    action: text(result.action || target.action),
  });
  next.attempts = attempts;
  next.currentAttempt = 0;
  next.attemptStartedAt = null;
  if (target.status === 'failed') {
    next.lastFailure = target;
    if (!next.firstFailure) next.firstFailure = target;
  }
  return next;
}

export function publicBugWorkbench(job, bugIndex, nowMs = Date.now()) {
  const index = Number(bugIndex);
  const bug = (job?.bugs || []).find((item) => Number(item?.bugIndex) === index) || {};
  const execution = normalizeBugExecution(job?.bugExecution);
  const workerExecution = bug?.workerExecution && typeof bug.workerExecution === 'object'
    ? bug.workerExecution
    : {};
  const summary = summarizeBugAttempts(bug, nowMs);
  const delivery = isBugDeliveryComplete(job, index);
  const failed = isBugFailed(job, index);
  const skipped = isBugSkipped(job, index);
  const executionStageId = workerExecution.currentStage
    || (execution.selectedBugIndex === index && execution.currentStage ? execution.currentStage : job?.currentStage);
  // A persisted cursor may point at the next pending stage while the runner
  // is planning a retry. A pending stage is not active work and must not be
  // presented as the current worker stage.
  const selectedStage = (job?.stages || []).find((item) => item.id === executionStageId
    && Number(item?.bugIndex) === index
    && ['running', 'failed'].includes(item.status));
  const fallbackStage = (job?.stages || []).find((item) => Number(item?.bugIndex) === index && ['running', 'failed'].includes(item.status));
  const stage = selectedStage || fallbackStage;
  const failureStage = summary.lastFailure?.stage
    ? (job?.stages || []).find((item) => item.id === summary.lastFailure.stage && Number(item?.bugIndex) === index)
    : null;
  const workerStage = (job?.stages || []).find((item) => item.id === workerExecution.currentStage
    && Number(item?.bugIndex) === index);
  const currentAttemptStage = summary.current
    ? (job?.stages || []).find((item) => item.id === summary.current.stage && Number(item?.bugIndex) === index)
    : null;
  const currentAttemptIsActive = Boolean(summary.current && currentAttemptStage?.status === 'running');
  const terminalJob = ['abandoned', 'stopped'].includes(String(job?.status || ''));
  const executionStage = (job?.stages || []).find((item) => item.id === execution.currentStage
    && Number(item?.bugIndex) === index);
  const executionIsQueued = execution.selectedBugIndex === index
    && job?.status === 'waiting_resource'
    && ['fast_lane_queued', 'fast_lane_running', 'fast_lane_switching'].includes(execution.status)
    && (!job?.waitingResource?.stageId || job.waitingResource.stageId === execution.currentStage)
    && executionStage?.status === 'pending';
  const executionIsActive = execution.selectedBugIndex === index
    && (Boolean(job?.processActive) || ['queued', 'running'].includes(job?.status))
    && executionStage?.status === 'running'
    && ['fast_lane_running', 'fast_lane_switching'].includes(execution.status);
  const pendingRetryQueued = Array.isArray(job?.pendingBugRetries)
    && job.pendingBugRetries.map(Number).includes(index);
  const workerIsQueued = workerExecution.status === 'fast_lane_queued'
    && (job?.status === 'waiting_resource' || pendingRetryQueued)
    && workerStage?.status === 'pending';
  const workerIsActive = Boolean(job?.processActive || ['queued', 'running', 'waiting_resource'].includes(job?.status))
    && workerStage?.status === 'running'
    && ['fast_lane_queued', 'fast_lane_running', 'fast_lane_switching'].includes(workerExecution.status);
  const effectiveExecutionActive = executionIsActive || workerIsActive;
  const effectiveExecutionQueued = executionIsQueued || workerIsQueued;
  const resumableWorkerStop = workerExecution.status === 'fast_lane_stopped'
    && ['queued', 'running', 'waiting_resource'].includes(String(job?.status || ''))
    && !delivery
    && !failed
    && !skipped
    && (job?.stages || []).some((item) => Number(item?.bugIndex) === index && item.status === 'pending');
  const persistedWorkerStatus = ['fast_lane_failed', 'fast_lane_stopped', 'fast_lane_completed', 'delivered'].includes(workerExecution.status)
    && !resumableWorkerStop
    ? workerExecution.status
    : '';
  const persistedExecutionStatus = execution.selectedBugIndex === index
    && ['fast_lane_failed', 'fast_lane_stopped', 'fast_lane_completed', 'delivered'].includes(execution.status)
    ? execution.status
    : '';
  const status = delivery ? 'delivered'
    : terminalJob ? 'fast_lane_stopped'
    : failed ? 'fast_lane_failed'
      : skipped ? 'fast_lane_stopped'
      : currentAttemptIsActive ? 'fast_lane_running'
        : effectiveExecutionQueued ? 'fast_lane_queued'
          : effectiveExecutionActive || stage?.status === 'running' ? 'fast_lane_running'
        : stage?.status === 'failed' || summary.lastFailure ? 'fast_lane_failed'
        : persistedWorkerStatus || persistedExecutionStatus || 'bug_ready';
  // A skipped or delivered Bug has already completed discovery. Do not expose
  // a stale selection-stage label from a previous runner snapshot.
  const visibleStage = (delivery || skipped) && !currentAttemptIsActive && !effectiveExecutionActive
    ? null
    : stage || (effectiveExecutionQueued ? workerStage || executionStage : null) || (failed ? failureStage : null);
  const attempts = (bug?.attempts || []).map(publicBugAttempt).filter(Boolean);
  const currentAttempt = currentAttemptIsActive ? summary.current : null;
  // Queue time is scheduling latency, not Bug execution time. The runner
  // publishes a fresh startedAt only after it has actually been admitted.
  const executionStartedAt = effectiveExecutionActive && !effectiveExecutionQueued
    ? workerExecution.startedAt || execution.startedAt
    : null;
  const executionElapsedMs = executionStartedAt
    ? bugAttemptDurationMs({ startedAt: executionStartedAt }, nowMs)
    : 0;
  const exposeLiveCheckpoint = effectiveExecutionActive || effectiveExecutionQueued;
  // A queued retry can retain the previous worker's last subphase. Showing it
  // would make a finalization-only retry appear to jump back to test authoring.
  const liveSubphase = effectiveExecutionActive
    ? text(workerExecution.subphase || (execution.selectedBugIndex === index ? execution.subphase : ''))
    : '';
  const subphaseIndex = bugExecutionPhaseIndex(liveSubphase);
  const visibleStageIndex = bugExecutionPhaseIndex('', visibleStage?.id);
  const checkpointSubphase = /checkpoint_(?:saved|restored)$/.test(liveSubphase);
  const preferLiveSubphase = effectiveExecutionActive
    && liveSubphase
    && (!checkpointSubphase || visibleStage?.status !== 'running')
    && (checkpointSubphase ? subphaseIndex > visibleStageIndex : subphaseIndex >= visibleStageIndex);
  return {
    status,
    selected: effectiveExecutionActive || effectiveExecutionQueued,
    currentStage: visibleStage?.id || '',
    currentStageLabel: preferLiveSubphase
      ? bugExecutionSubphaseLabel(liveSubphase)
      : visibleStage?.label || '',
    subphase: liveSubphase,
    resourceStage: exposeLiveCheckpoint
      ? text(workerExecution.resourceStage || (execution.selectedBugIndex === index ? execution.resourceStage : ''))
      : text(failed ? summary.lastFailure?.stage : ''),
    elapsedMs: effectiveExecutionQueued ? 0 : summary.currentDurationMs || executionElapsedMs,
    totalDurationMs: summary.totalDurationMs,
    attemptCount: summary.count,
    currentAttempt: currentAttemptIsActive ? summary.currentAttempt : 0,
    startedAt: effectiveExecutionQueued ? null : currentAttempt?.startedAt || bug?.attemptStartedAt || executionStartedAt,
    updatedAt: workerExecution.updatedAt || bug?.updatedAt || (execution.selectedBugIndex === index ? execution.updatedAt : null),
    blockedReason: delivery
      ? ''
      : resumableWorkerStop
        ? ''
        : text(workerExecution.blockedReason || (execution.selectedBugIndex === index ? execution.blockedReason : bug?.blockedReason)),
    lastAction: delivery
      ? 'delivered'
      : text(workerExecution.lastAction || (execution.selectedBugIndex === index ? execution.lastAction : bug?.lastAction)),
    lastHeartbeatAt: workerExecution.lastHeartbeatAt || (execution.selectedBugIndex === index ? execution.lastHeartbeatAt : null),
    attempts,
    firstFailure: summary.firstFailure || null,
    lastFailure: summary.lastFailure || null,
  };
}
