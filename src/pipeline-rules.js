import { BUG_POLICY_VERSION, TASK_SUBTYPES, BUG_MECHANISMS, normalizeTaskType } from './bug-policy.js';
import { assessProjectDomain, projectDomainFamily } from './project-domain-rules.js';
import { normalizeBugExecution, nextIncompleteBugIndex, publicBugWorkbench, summarizeBugAttempts } from './bug-workbench.js';

export const PIPELINE_STATUS = new Set(['draft', 'waiting_review', 'waiting_resource', 'queued', 'running', 'passed', 'failed', 'abandoned', 'stopped']);
export const PIPELINE_STAGE_STATUS = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
export const DEFAULT_BUG_COUNT = 10;
export const MAX_BUG_COUNT = 30;
export const MAX_BUG_TRAJECTORY_ATTEMPTS = 3;
// Bug-scoped stages that do not own a more specific retry budget are retried
// from their last durable checkpoint before the Bug is marked failed. This is
// a retry count, so the initial run plus these retries may execute four times.
export const MAX_BUG_STAGE_AUTO_RETRIES = 3;
// Large projects are available through the explicit manual-entry control and
// bounded automatic-refill canaries configured in pipeline-refill state.
export const LARGE_PROJECTS_ENABLED = true;
// A Gold public-contract review is a quality correction, not a production Bug
// failure. Keep a bounded retry so an over-constrained generated test cannot
// silently skip the Bug forever.
export const MAX_GOLD_CONTRACT_REVIEW_RETRIES = 3;
export const PARALLEL_BUG_WORKFLOW_VERSION = 2;
export const CURRENT_WORKFLOW_VERSION = 3;
export const CURRENT_WORKFLOW_POLICY_VERSION = 4;
export const CURRENT_VERIFICATION_POLICY_VERSION = 5;
export const CURRENT_BUG_POLICY_VERSION = BUG_POLICY_VERSION;
export const PIPELINE_PROJECT_STAGES = [
  ['project_plan', 'Sol 规划并扩写项目文档'],
  ['project_generate', 'Claude 生成项目'],
  ['project_validate', '项目与双架构 Docker 验证'],
  ['main_publish', '发布 Git main'],
];
export const PIPELINE_BUG_STAGES = [
  ['bug_discovery', 'Sol 独立寻找 Bug'],
  ['gold_fix', 'Sol 修复并验证红绿与题面覆盖'],
  ['task_prepare', '创建 Claude 隔离任务'],
  ['claude_fix', 'Claude 独立修复'],
  ['trajectory_validate', '轨迹采集登记'],
  ['sol_quality', '轨迹内容质检（已暂停）'],
  ['cloud_upload', '上传轨迹云盘并回填链接'],
  ['delivery_ready', '交付字段就绪'],
];
export const PIPELINE_V2_PROJECT_PREPARE_STAGES = [
  ['project_plan', 'Sol 规划并扩写项目文档'],
  ['project_generate', 'Claude 生成项目'],
  ['project_validate', '项目与双架构 Docker 验证'],
  ['main_freeze', '本地冻结初始 main commit'],
];
export const PIPELINE_V2_BUG_SELECTION_STAGES = [
  ['bug_discovery', 'Sol 优先寻找自然 Bug'],
  ['bug_source_prepare', '确定独立 BUG_BASE'],
];
export const PIPELINE_V3_BUG_SELECTION_STAGES = [
  ...PIPELINE_V2_BUG_SELECTION_STAGES,
  ['user_query_review', '人工编辑并确认 user_query'],
];
export const PIPELINE_V2_BUG_DELIVERY_STAGES = PIPELINE_BUG_STAGES.filter(([stage]) => stage !== 'bug_discovery');
export const PIPELINE_V5_BUG_DELIVERY_STAGES = [
  ['gold_fix', 'Sol Gold 修复与内部红绿验证'],
  ['task_prepare', '创建 Claude 隔离任务'],
  ['claude_fix', 'Claude 纯生产修复（完成后由独立 Session 生成测试）'],
  ['trajectory_validate', '主轨迹采集登记'],
  ['sol_quality', '轨迹内容质检（已暂停）'],
  ['verification_coverage', 'verify_cmds 题面覆盖预检'],
  ['pre_verify', 'Claude 新 Session 执行修复前验证'],
  ['post_verify', 'Claude 新 Session 执行修复后验证'],
  ['cloud_upload', '上传主轨迹与红绿证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];
export const PIPELINE_V5_DIAGNOSIS_DELIVERY_STAGES = [
  ['gold_fix', 'Sol Gold 修复与内部红绿验证'],
  ['task_prepare', '创建 Claude 隔离任务'],
  ['pre_verify', 'Claude 新 Session 执行修复前验证'],
  ['claude_fix', 'Claude 独立完成修复或诊断'],
  ['trajectory_validate', '主轨迹采集登记'],
  ['sol_quality', '轨迹内容质检（已暂停）'],
  ['post_verify', '诊断任务不需要修复后证明'],
  ['verification_coverage', '验证命令覆盖复核'],
  ['cloud_upload', '上传主轨迹与红绿证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];
export const PIPELINE_V6_BUG_DELIVERY_STAGES = [
  ['task_prepare', '创建 Claude 隔离任务并冻结私有验证夹具'],
  ['pre_verify', '修复前红测证明'],
  ['claude_fix', 'Claude 独立修复'],
  ['trajectory_validate', '基础轨迹完整性校验'],
  ['post_verify', '修复后绿测证明'],
  ['cloud_upload', '上传主轨迹与红绿证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];
export const PIPELINE_V6_DIAGNOSIS_DELIVERY_STAGES = [
  ['task_prepare', '创建 Claude 隔离任务并冻结私有验证夹具'],
  ['pre_verify', '公开复现红测证明'],
  ['claude_fix', 'Claude 独立完成诊断'],
  ['trajectory_validate', '基础轨迹完整性校验'],
  ['cloud_upload', '上传主轨迹与红绿证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];
// V3 uses the restored post-repair red/green flow. The red side is evaluated
// against the original BUG_BASE after Claude and trajectory validation; the
// green side is evaluated against the locally frozen G2 before final Git push.
export const PIPELINE_V3_COMPAT_BUG_DELIVERY_STAGES = [
  ['task_prepare', '创建 Claude 隔离任务'],
  ['claude_fix', 'Claude 独立修复'],
  ['trajectory_validate', '主轨迹完整性校验'],
  ['test_author', 'Codex 独立编写回归测试'],
  ['pre_verify', '修复前红测证明'],
  ['post_verify', '修复后绿测证明'],
  ['docker_validation', '修复后双架构 Docker 验证'],
  ['git_publication', 'Git G2/R1 发布'],
  ['cloud_upload', '上传主轨迹与红绿证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];

export const PIPELINE_V3_DIAGNOSIS_DELIVERY_STAGES = [
  ['task_prepare', '创建 Claude 隔离任务'],
  ['claude_fix', 'Claude 独立完成诊断'],
  ['trajectory_validate', '主轨迹完整性校验'],
  ['test_author', 'Codex 独立编写诊断回归测试'],
  ['pre_verify', '公开复现红测证明'],
  ['cloud_upload', '上传主轨迹与红测证明'],
  ['verification_finalize', '回填 verify_result 验证证明'],
  ['delivery_ready', '交付字段就绪'],
];

export function isSkippedPipelineBug(bug) {
  return bug?.disposition === 'skipped' || bug?.disposition === 'failed' || bug?.failureDisposition === 'auto_continued';
}

export function isPipelineBugDeliveryComplete(job, bugIndex) {
  const normalizedIndex = Number(bugIndex);
  return (job?.stages || []).some((stage) => stage.id === `bug${normalizedIndex}_delivery_ready` && stage.status === 'passed');
}

export function pipelineProjectDeliverySummary(job = {}) {
  const requested = Math.max(0, Number(job?.request?.bugCount) || 0);
  const bugByIndex = new Map((job?.bugs || []).map((bug) => [Number(bug?.bugIndex), bug]));
  const deliveredBugIndexes = [];
  const failedBugIndexes = [];
  const skippedBugIndexes = [];
  const incompleteBugIndexes = [];
  for (let bugIndex = 1; bugIndex <= requested; bugIndex += 1) {
    const bug = bugByIndex.get(bugIndex);
    if (isPipelineBugDeliveryComplete(job, bugIndex)) deliveredBugIndexes.push(bugIndex);
    else if (bug?.disposition === 'failed' || bug?.failureDisposition === 'auto_continued') failedBugIndexes.push(bugIndex);
    else if (bug?.disposition === 'skipped') skippedBugIndexes.push(bugIndex);
    else incompleteBugIndexes.push(bugIndex);
  }
  return {
    requested,
    deliveredBugIndexes,
    failedBugIndexes,
    skippedBugIndexes,
    incompleteBugIndexes,
    passed: requested > 0 && deliveredBugIndexes.length === requested,
  };
}

// User-query review is a project-level gate. A partial bug array can be
// visible while parallel source preparation is still running, but it must
// never be treated as a complete review batch.
export function pipelineUserQueryReadiness(job = {}) {
  const bugs = Array.isArray(job?.bugs) ? job.bugs : [];
  const requested = Math.max(0, Number(job?.request?.bugCount) || bugs.length);
  const bugByIndex = new Map(bugs.map((bug) => [Number(bug?.bugIndex), bug]));
  const skippedBugIndexes = [];
  const missingBugIndexes = [];
  const unpreparedBugIndexes = [];
  for (let index = 1; index <= requested; index += 1) {
    const bug = bugByIndex.get(index);
    if (isSkippedPipelineBug(bug)) {
      skippedBugIndexes.push(index);
      continue;
    }
    const source = (job?.stages || []).find((stage) => stage.id === `bug${index}_bug_source_prepare`);
    if (!bug) missingBugIndexes.push(index);
    if (!bug || bug?.discovery?.found === false || source?.status !== 'passed') unpreparedBugIndexes.push(index);
  }
  const reviewStages = (job?.stages || []).filter((stage) => stage.stage === 'user_query_review'
    && !skippedBugIndexes.includes(Number(stage.bugIndex)));
  const pendingReviewIndexes = reviewStages
    .filter((stage) => !['passed', 'skipped'].includes(stage.status))
    .map((stage) => Number(stage.bugIndex))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const preparedBugIndexes = Array.from({ length: requested }, (_, offset) => offset + 1)
    .filter((index) => !skippedBugIndexes.includes(index) && !unpreparedBugIndexes.includes(index));
  return {
    requestedBugCount: requested,
    activeBugCount: requested - skippedBugIndexes.length,
    preparedBugCount: preparedBugIndexes.length,
    reviewStageCount: reviewStages.length,
    skippedBugIndexes,
    missingBugIndexes,
    unpreparedBugIndexes,
    pendingReviewIndexes,
    ready: requested > 0
      && reviewStages.length > 0
      && missingBugIndexes.length === 0
      && unpreparedBugIndexes.length === 0
      && reviewStages.length === requested - skippedBugIndexes.length,
  };
}

export function remainingBugTrajectoryAttempts(bug) {
  return Math.max(0, MAX_BUG_TRAJECTORY_ATTEMPTS - countedBugTrajectoryAttempts(bug));
}

// A process interruption does not produce a Claude trajectory and must not
// consume the bounded model-attempt budget. This covers explicit workbench
// stops, scheduler hand-offs, and service restarts.
export function countedBugTrajectoryAttempts(bug) {
  return (Array.isArray(bug?.attempts) ? bug.attempts : [])
    .filter((attempt) => attempt?.status !== 'stopped' && attempt?.status !== 'system')
    .length;
}

export function markPipelineTrajectorySkippedPendingVerification(job, bugIndex, reason, at = new Date().toISOString()) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  bug.trajectoryDisposition = 'skipped_pending_verification';
  bug.trajectorySkipReason = String(reason || '主轨迹采集登记未完成').trim();
  bug.trajectorySkippedAt = at;
  for (const suffix of ['claude_fix', 'trajectory_validate', 'sol_quality']) {
    const stage = (job.stages || []).find((item) => item.id === `bug${normalizedIndex}_${suffix}`);
    if (!stage || stage.status === 'passed') continue;
    stage.status = 'skipped';
    stage.finishedAt = at;
    stage.error = '';
    stage.reason = bug.trajectorySkipReason;
  }
  if ((job.stages || []).find((stage) => stage.id === job.currentStage)?.bugIndex === normalizedIndex) job.currentStage = null;
  job.error = '';
  job.updatedAt = at;
  return job;
}

export function markPipelineBugSkipped(job, bugIndex, reason, at = new Date().toISOString()) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  if (bug.disposition === 'delivered') throw new Error(`Bug ${normalizedIndex} 已交付，不能跳过`);

  bug.disposition = 'skipped';
  bug.skippedAt = at;
  bug.skipReason = String(reason || '轨迹连续未通过规范，人工决定跳过').trim();
  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== normalizedIndex || stage.phase !== 'delivery' || stage.status === 'passed') continue;
    stage.status = 'skipped';
    stage.finishedAt = at;
    stage.error = '';
    stage.reason = bug.skipReason;
  }
  if ((job.stages || []).find((stage) => stage.id === job.currentStage)?.bugIndex === normalizedIndex) job.currentStage = null;
  job.error = '';
  job.updatedAt = at;
  return job;
}

// A Bug-scoped failure is terminal for the current automatic pass, but must not
// stop the project runner. Keep its evidence visible and skip only its
// unfinished Bug stages so the next Bug can be admitted.
export function markPipelineBugFailed(job, bugIndex, {
  stage = '',
  error = '',
  failureCategory = '',
  at = new Date().toISOString(),
} = {}) {
  const normalizedIndex = Number(bugIndex);
  let bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) {
    job.bugs ||= [];
    bug = { bugIndex: normalizedIndex, attempts: [] };
    job.bugs.push(bug);
  }
  if (bug.disposition === 'delivered') throw new Error(`Bug ${normalizedIndex} 已交付，不能标记失败`);

  const failure = {
    status: 'failed',
    stage: String(stage || '').trim(),
    failureCategory: String(failureCategory || '').trim(),
    error: String(error || 'Bug 阶段失败').trim(),
    startedAt: bug.attemptStartedAt || null,
    finishedAt: at,
    durationMs: 0,
    action: 'automatic_continue',
  };
  bug.disposition = 'failed';
  bug.failureDisposition = 'auto_continued';
  bug.failedAt = at;
  bug.failureStage = failure.stage;
  bug.failureReason = failure.error;
  const previousFailure = bug.lastFailure
    || [...(Array.isArray(bug.attempts) ? bug.attempts : [])].reverse().find((attempt) => attempt?.status === 'failed');
  bug.lastFailure = previousFailure
    ? {
      ...previousFailure,
      stage: failure.stage || previousFailure.stage,
      failureCategory: failure.failureCategory || previousFailure.failureCategory,
      error: failure.error,
      finishedAt: at,
      action: 'automatic_continue',
    }
    : failure;
  if (!bug.firstFailure) bug.firstFailure = failure;
  for (const stageRecord of job.stages || []) {
    if (Number(stageRecord.bugIndex) !== normalizedIndex || stageRecord.status === 'passed') continue;
    stageRecord.status = 'skipped';
    stageRecord.finishedAt = at;
    stageRecord.error = '';
    stageRecord.reason = `Bug 阶段失败后自动继续：${failure.error}`;
  }
  if ((job.stages || []).find((item) => item.id === job.currentStage)?.bugIndex === normalizedIndex) job.currentStage = null;
  job.error = '';
  job.updatedAt = at;
  return job;
}

export function queuePipelineBugStageRetry(job, bugIndex, {
  stage = '',
  error = '',
  failureCategory = '',
  at = new Date().toISOString(),
  maxRetries = MAX_BUG_STAGE_AUTO_RETRIES,
} = {}) {
  const normalizedIndex = Number(bugIndex);
  const stageId = String(stage || '').trim();
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  if (!stageId || !stageId.startsWith(`bug${normalizedIndex}_`)) {
    throw new Error(`Bug ${normalizedIndex} 阶段不合法：${stageId || '空阶段'}`);
  }
  if (bug.disposition === 'delivered') throw new Error(`Bug ${normalizedIndex} 已交付，不能自动重试`);

  const limit = Math.max(1, Number(maxRetries) || MAX_BUG_STAGE_AUTO_RETRIES);
  const previous = bug.stageAutoRetries?.[stageId] || {};
  const previousRetryCount = Math.max(0, Number(previous.retryCount) || 0);
  const failureCount = Math.max(previousRetryCount, Number(previous.failureCount) || 0) + 1;
  const queued = previousRetryCount < limit;
  const retryCount = queued ? previousRetryCount + 1 : previousRetryCount;
  const normalizedError = String(error || 'Bug 阶段失败').trim();
  const retryRecord = {
    retryCount,
    failureCount,
    maxRetries: limit,
    failureCategory: String(failureCategory || '').trim(),
    lastError: normalizedError,
    lastFailedAt: at,
    exhausted: !queued,
    ...(queued ? { queuedAt: at } : { exhaustedAt: at }),
  };
  bug.stageAutoRetries = {
    ...(bug.stageAutoRetries || {}),
    [stageId]: retryRecord,
  };
  bug.stageRetryHistory = [...(bug.stageRetryHistory || []), {
    stage: stageId,
    retryCount,
    failureCount,
    maxRetries: limit,
    failureCategory: retryRecord.failureCategory,
    error: normalizedError,
    at,
    action: queued ? 'automatic_stage_retry' : 'automatic_stage_retry_exhausted',
  }].slice(-50);

  if (!queued) {
    job.updatedAt = at;
    return { queued: false, retryCount, failureCount, maxRetries: limit, job };
  }

  const stageRecord = (job.stages || []).find((item) => item.id === stageId);
  if (stageRecord && stageRecord.status !== 'passed') {
    stageRecord.status = 'pending';
    stageRecord.startedAt = null;
    stageRecord.finishedAt = null;
    stageRecord.error = '';
    stageRecord.reason = `阶段自动重试 ${retryCount}/${limit}`;
    stageRecord.retryCount = retryCount;
    stageRecord.maxRetries = limit;
    delete stageRecord.result;
    delete stageRecord.failureCategory;
  }
  delete bug.disposition;
  delete bug.failureDisposition;
  delete bug.failedAt;
  delete bug.failureStage;
  delete bug.failureReason;
  bug.workerExecution = {
    ...(bug.workerExecution || {}),
    status: 'fast_lane_queued',
    currentStage: stageId,
    currentAttempt: retryCount,
    updatedAt: at,
    lastAction: 'automatic_stage_retry',
    blockedReason: `阶段自动重试 ${retryCount}/${limit}`,
  };
  const execution = normalizeBugExecution(job.bugExecution);
  job.bugExecution = {
    ...execution,
    selectedBugIndex: normalizedIndex,
    status: 'fast_lane_queued',
    currentStage: stageId,
    currentAttempt: retryCount,
    updatedAt: at,
    lastAction: 'automatic_stage_retry',
    blockedReason: `阶段自动重试 ${retryCount}/${limit}`,
  };
  job.status = 'running';
  job.currentStage = stageId;
  job.error = '';
  job.finishedAt = null;
  job.updatedAt = at;
  return { queued: true, retryCount, failureCount, maxRetries: limit, job };
}

export function queuePipelineGoldContractRetry(job, bugIndex, {
  candidateDir = '',
  error = '',
  at = new Date().toISOString(),
  maxAttempts = MAX_GOLD_CONTRACT_REVIEW_RETRIES,
} = {}) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  if (bug.disposition === 'delivered') throw new Error(`Bug ${normalizedIndex} 已交付，不能重做 Gold`);

  const previousAttempt = Number(bug.goldContractRetry?.attempt || 0);
  const attempt = previousAttempt + 1;
  const stageId = `bug${normalizedIndex}_gold_fix`;
  const stage = (job.stages || []).find((item) => item.id === stageId);
  if (attempt > Math.max(1, Number(maxAttempts) || MAX_GOLD_CONTRACT_REVIEW_RETRIES)) {
    bug.disposition = 'failed';
    bug.failureDisposition = 'manual_review';
    bug.failureStage = stageId;
    bug.failureReason = `Gold 公共契约复核连续 ${previousAttempt} 次不通过，需要人工修正 Gold 测试`;
    bug.lastFailure = {
      status: 'failed',
      stage: stageId,
      failureCategory: 'gold_contract_review',
      error: String(error || bug.failureReason).trim(),
      finishedAt: at,
      action: 'manual_review',
    };
    bug.goldContractRetry = {
      ...(bug.goldContractRetry || {}),
      attempt: previousAttempt,
      candidateDir: String(candidateDir || bug.goldContractRetry?.candidateDir || ''),
      error: String(error || '').trim(),
      exhausted: true,
      exhaustedAt: at,
    };
    job.status = 'stopped';
    job.currentStage = stageId;
    job.error = bug.failureReason;
    job.finishedAt = at;
    job.waitingResource = null;
    job.schedulerLease = null;
    job.updatedAt = at;
    return { queued: false, attempt, job };
  }

  bug.goldContractRetry = {
    attempt,
    candidateDir: String(candidateDir || '').trim(),
    error: String(error || '').trim(),
    queuedAt: at,
  };
  if (stage && stage.status !== 'passed') {
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
    delete stage.result;
  }
  job.status = 'waiting_resource';
  job.currentStage = stageId;
  job.error = '';
  job.finishedAt = null;
  job.runnerPid = null;
  job.schedulerLease = null;
  job.waitingResource = {
    stageId,
    pool: 'compute-heavy',
    limit: 2,
    queuedAt: at,
    reason: 'gold_contract_review_retry',
  };
  const execution = normalizeBugExecution(job.bugExecution);
  job.bugExecution = {
    ...execution,
    selectedBugIndex: normalizedIndex,
    status: 'fast_lane_queued',
    startedAt: null,
    currentStage: stageId,
    blockedReason: '等待中央调度资源',
    updatedAt: at,
  };
  job.updatedAt = at;
  return { queued: true, attempt, job };
}

const INDEPENDENT_TEST_DEPENDENT_STAGES = new Set([
  'test_author',
  'pre_verify',
  'post_verify',
  'docker_validation',
  'git_publication',
  'verification_coverage',
  'cloud_upload',
  'verification_finalize',
  'delivery_ready',
]);

export function invalidatePipelineVerificationAfterMissingTestAuthor(job, bugIndex, at = new Date().toISOString()) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job?.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  const testAuthorStage = (job?.stages || []).find((stage) => stage.id === `bug${normalizedIndex}_test_author`);
  const authored = bug?.verificationTestAuthor;
  if (!bug || !testAuthorStage || (authored?.sourceDir && authored?.testFile)) return false;

  let invalidated = false;
  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== normalizedIndex || stage.status === 'skipped') continue;
    const suffix = String(stage.id || '').replace(`bug${normalizedIndex}_`, '');
    if (!INDEPENDENT_TEST_DEPENDENT_STAGES.has(suffix)) continue;
    if (stage.status !== 'pending' || stage.startedAt || stage.finishedAt || stage.error || stage.result) invalidated = true;
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
    delete stage.result;
    delete stage.reason;
  }
  if (bug.verificationEvidence && Object.keys(bug.verificationEvidence).length) {
    bug.verificationEvidenceHistory = [...(bug.verificationEvidenceHistory || []), {
      invalidatedAt: at,
      reason: 'independent_test_author_artifact_missing',
      evidence: bug.verificationEvidence,
    }].slice(-10);
    delete bug.verificationEvidence;
    invalidated = true;
  }
  return invalidated;
}

export function reactivatePipelineBug(job, bugIndex, { resetAttempts = false } = {}) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  const invalidatedIncompleteDelivery = invalidatePipelineVerificationAfterMissingTestAuthor(job, normalizedIndex);
  if (bug.disposition === 'delivered' && !invalidatedIncompleteDelivery) {
    throw new Error(`Bug ${normalizedIndex} 已交付，不能重试`);
  }
  delete bug.disposition;
  delete bug.deliveredAt;
  delete bug.failureDisposition;
  delete bug.failedAt;
  delete bug.failureStage;
  delete bug.failureReason;
  delete bug.goldContractRetry;
  delete bug.skippedAt;
  delete bug.skipReason;
  // These fields describe only the previous trajectory-exhaustion decision.
  // Clear them so a manual retry can reuse the prepared workspace while
  // retaining the historical attempts for audit.
  delete bug.trajectoryDisposition;
  delete bug.trajectorySkipReason;
  delete bug.trajectorySkippedAt;
  if (!invalidatedIncompleteDelivery) invalidatePipelineVerificationAfterMissingTestAuthor(job, normalizedIndex);
  if (resetAttempts) {
    const history = Array.isArray(bug.trajectoryAttemptHistory) ? bug.trajectoryAttemptHistory : [];
    bug.trajectoryAttemptHistory = [...history, ...(Array.isArray(bug.attempts) ? bug.attempts : [])];
    if (bug.stageAutoRetries && Object.keys(bug.stageAutoRetries).length) {
      bug.stageAutoRetryBudgetHistory = [...(bug.stageAutoRetryBudgetHistory || []), {
        resetAt: new Date().toISOString(),
        retries: bug.stageAutoRetries,
      }].slice(-10);
    }
    bug.attempts = [];
    delete bug.stageAutoRetries;
    delete bug.firstFailure;
    delete bug.lastFailure;
    delete bug.attemptStartedAt;
    delete bug.currentAttempt;
    bug.attemptBudgetResetAt = new Date().toISOString();
  }
  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== normalizedIndex) continue;
    // Stage retry counters are a separate persisted view of the Bug-level
    // budget. A manual reset must clear both, otherwise the stage can remain
    // stuck at "3/3" and be rejected immediately after it is re-queued.
    if (resetAttempts) {
      delete stage.retryCount;
      delete stage.maxRetries;
    }
    // These stages are intentionally retired under the V5 workflow. A manual
    // retry must never resurrect them, otherwise the scheduler can wait on a
    // non-runnable Sol/coverage stage instead of continuing to proof upload.
    if (stage.id === `bug${normalizedIndex}_sol_quality`) {
      stage.status = 'skipped';
      stage.finishedAt ||= new Date().toISOString();
      stage.error = '';
      stage.reason ||= '新规则暂停轨迹内容质检';
      continue;
    }
    if (stage.id === `bug${normalizedIndex}_verification_coverage`
      && Number(job.workflowVersion || 1) >= 3) {
      stage.status = 'skipped';
      stage.finishedAt ||= new Date().toISOString();
      stage.error = '';
      stage.reason ||= '旧 verify_cmds 题面语义覆盖复核已停用；保留 V5 独立红绿证明校验';
      continue;
    }
    if (stage.status !== 'skipped') continue;
    stage.status = 'pending';
    stage.finishedAt = null;
    stage.error = '';
    delete stage.reason;
  }
  job.error = '';
  job.finishedAt = null;
  job.updatedAt = new Date().toISOString();
  return job;
}

export function rewindPipelineBugAfterMissingTrajectory(job, bugIndex, at = new Date().toISOString()) {
  const normalizedIndex = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === normalizedIndex);
  if (!bug) throw new Error(`Bug ${normalizedIndex} 不存在`);
  const claudeStage = (job.stages || []).find((stage) => stage.id === `bug${normalizedIndex}_claude_fix`);
  if (claudeStage?.status !== 'passed') return false;

  const resetSuffixes = new Set([
    'claude_fix', 'trajectory_validate', 'test_author', 'pre_verify',
    'cloud_upload', 'verification_finalize', 'delivery_ready',
  ]);
  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== normalizedIndex) continue;
    const suffix = String(stage.id || '').replace(`bug${normalizedIndex}_`, '');
    if (!resetSuffixes.has(suffix)) continue;
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
    delete stage.result;
    delete stage.reason;
    delete stage.retryCount;
    delete stage.maxRetries;
  }
  if (bug.verificationEvidence && Object.keys(bug.verificationEvidence).length) {
    bug.verificationEvidenceHistory = [...(bug.verificationEvidenceHistory || []), {
      invalidatedAt: at,
      reason: 'trajectory_capture_missing',
      evidence: bug.verificationEvidence,
    }].slice(-10);
    delete bug.verificationEvidence;
  }
  delete bug.stageAutoRetries;
  return true;
}

// A pre-v4 V3 bugfix can be marked auto-continued before task preparation
// freezes its private verification fixture. Once the policy is migrated, that
// specific infrastructure failure is safe to retry from task_prepare. Keep
// the predicate narrow so genuine model, test, Docker, or Git failures remain
// terminal until an operator explicitly reactivates them.
export function reactivateFrozenVerificationFailures(job, at = new Date().toISOString()) {
  if (Number(job?.workflowVersion || 1) < 3
    || Number(job?.workflowPolicyVersion || 0) < 4) {
    return { job, reactivated: [] };
  }
  const reactivated = [];
  for (const bug of job.bugs || []) {
    if (bug?.disposition !== 'failed' && bug?.failureDisposition !== 'auto_continued') continue;
    const failureText = [bug.failureReason, bug.lastFailure?.error, bug.firstFailure?.error]
      .filter(Boolean)
      .join('\n');
    if (!failureText.includes('缺少在 Claude 前冻结的可执行验证命令')) continue;
    reactivatePipelineBug(job, Number(bug.bugIndex), { resetAttempts: false });
    reactivated.push(Number(bug.bugIndex));
  }
  if (reactivated.length) {
    job.updatedAt = at;
    job.error = '';
  }
  return { job, reactivated };
}

export function pipelineTaskOutcome(job, { taskName = '', bugIndex = null } = {}) {
  if (!job || !Array.isArray(job.bugs)) return null;
  const normalizedTaskName = String(taskName || '').trim();
  const normalizedBugIndex = Number(bugIndex);
  const bug = job.bugs.find((item) => normalizedTaskName && item?.task?.taskName === normalizedTaskName)
    || job.bugs.find((item) => Number.isInteger(normalizedBugIndex) && Number(item?.bugIndex) === normalizedBugIndex);
  if (!bug) return null;
  const attempts = Array.isArray(bug.attempts) ? bug.attempts : [];
  const lastFailure = [...attempts].reverse().find((attempt) => attempt?.status === 'failed') || bug.lastFailure || null;
  const delivered = bug.disposition === 'delivered';
  return {
    bugIndex: Number(bug.bugIndex) || null,
    disposition: String(bug.disposition || ''),
    skippedAt: bug.skippedAt || null,
    skipReason: String(bug.skipReason || ''),
    // Keep lastFailure on the Job for audit, but do not present a recovered,
    // delivered task as if the historical failure were still active.
    failureStage: delivered ? '' : String(lastFailure?.stage || bug.failureStage || ''),
    failureReason: delivered ? '' : String(lastFailure?.error || bug.failureReason || ''),
    attemptCount: attempts.length,
  };
}

function text(value) {
  return String(value || '').trim();
}

export function pipelineBugQuota(projectTier = 'standard') {
  return text(projectTier) === 'large' ? MAX_BUG_COUNT : DEFAULT_BUG_COUNT;
}

export function normalizeRepositoryUrl(value) {
  return text(value).replace(/\.git$/i, '').replace(/\/$/, '');
}

export function validatePipelineRequest(input = {}) {
  const issues = [];
  const projectBrief = text(input.projectBrief);
  const maxTrajectoryAttempts = MAX_BUG_TRAJECTORY_ATTEMPTS;
  const taskType = text(input.taskType || 'bugfix');
  if (projectBrief.length < 20) issues.push('项目要求至少填写 20 个字符');
  const domainAssessment = assessProjectDomain({ title: input.autoRefillTitle, projectBrief });
  if (!domainAssessment.ok) issues.push(...domainAssessment.issues);
  const projectDomain = text(input.projectDomain);
  if (projectDomain && !projectDomainFamily(projectDomain)) issues.push('projectDomain 不属于系统领域类别');
  const projectTier = text(input.projectTier || 'standard');
  const bugCount = pipelineBugQuota(projectTier);
  if (!['bugfix', 'diagnosis'].includes(taskType)) issues.push('taskType 只能是 bugfix 或 diagnosis');
  if (!['standard', 'large'].includes(projectTier)) issues.push('projectTier 只能是 standard 或 large');
  if (projectTier === 'large' && !LARGE_PROJECTS_ENABLED) issues.push('大型项目暂时停用，流程稳定后再开放');
  const taskSubtype = text(input.taskSubtype || '');
  if (taskSubtype && !TASK_SUBTYPES[normalizeTaskType(taskType)]?.includes(taskSubtype)) issues.push('taskSubtype 不属于 taskType 的允许分类');
  const bugCategory = text(input.bugCategory || '');
  if (bugCategory && !BUG_MECHANISMS.includes(bugCategory)) issues.push('bugCategory 缺陷机制不合法');
  return {
    ok: issues.length === 0,
    issues,
    value: {
      projectBrief,
      bugCount,
      maxTrajectoryAttempts,
      taskType,
      projectTier,
      ...(projectDomain ? { projectDomain } : {}),
      ...(taskSubtype ? { taskSubtype } : {}),
      ...(bugCategory ? { bugCategory } : {}),
      frontendRequired: Boolean(input.frontendRequired),
      contributorId: text(input.contributorId || input.creator || 'niuyuhang') || 'niuyuhang',
      bugPolicyVersion: CURRENT_BUG_POLICY_VERSION,
    },
  };
}

export function upgradeUnfinishedPipelineBugQuota(job) {
  const workflowVersion = Number(job?.workflowVersion || 1);
  const terminal = ['passed', 'abandoned'].includes(String(job?.status || ''));
  const projectTier = text(job?.request?.projectTier || 'standard');
  const quota = pipelineBugQuota(projectTier);
  const previousBugCount = Number(job?.request?.bugCount || 0);
  if (!job || workflowVersion < PARALLEL_BUG_WORKFLOW_VERSION || terminal || previousBugCount >= quota) {
    return { changed: false, job, previousBugCount, bugCount: previousBugCount, addedBugSlots: [] };
  }

  const existingStages = new Map((job.stages || []).map((stage) => [stage.id, stage]));
  const stages = createPipelineStages(quota, workflowVersion, job.verificationPolicyVersion, job.request?.taskType, job.workflowPolicyVersion)
    .map((stage) => ({ ...stage, ...(existingStages.get(stage.id) || {}) }));
  const mainPublish = stages.find((stage) => stage.id === 'main_publish');
  if (mainPublish) {
    mainPublish.status = 'pending';
    mainPublish.error = '';
    mainPublish.startedAt = null;
    mainPublish.finishedAt = null;
    delete mainPublish.result;
  }
  const firstAddedBug = Math.max(1, previousBugCount + 1);
  const addedBugSlots = Array.from({ length: quota - previousBugCount }, (_, index) => firstAddedBug + index);
  const nextSelectionStage = `bug${firstAddedBug}_bug_discovery`;
  const firstPendingStage = stages.find((stage) => !['passed', 'skipped'].includes(stage.status));
  const updated = {
    ...job,
    request: { ...job.request, projectTier, bugCount: quota },
    stages,
    currentStage: firstPendingStage?.id || nextSelectionStage,
    schedulerLease: null,
    bugQuotaUpgrade: {
      from: previousBugCount,
      to: quota,
      addedBugSlots,
    },
  };
  delete updated.waitingResource;
  delete updated.dependencyWaitService;
  delete updated.finishedAt;
  return { changed: true, job: updated, previousBugCount, bugCount: quota, addedBugSlots };
}

export function createPipelineStages(bugCount, workflowVersion = 1, verificationPolicyVersion = 0, taskType = 'bugfix', workflowPolicyVersion = 0) {
  if (Number(workflowVersion) >= PARALLEL_BUG_WORKFLOW_VERSION) {
    const stages = PIPELINE_V2_PROJECT_PREPARE_STAGES.map(([id, label]) => ({ id, label, scope: 'project', status: 'pending' }));
    const selectionStages = Number(workflowVersion) >= CURRENT_WORKFLOW_VERSION
      ? PIPELINE_V3_BUG_SELECTION_STAGES
      : PIPELINE_V2_BUG_SELECTION_STAGES;
    for (let index = 1; index <= bugCount; index += 1) {
      for (const [stage, label] of selectionStages) stages.push({ id: `bug${index}_${stage}`, stage, label, scope: 'bug', phase: 'selection', bugIndex: index, status: 'pending' });
    }
    stages.push({ id: 'main_publish', label: '发布 Git main 与独立 BUG_BASE', scope: 'project', status: 'pending' });
    // V3 is the restored August 21 workflow.  Workflow policy v4 records the
    // Git-era metadata only; it must not route jobs into the retired Codex
    // private-fixture flow.  Existing private-fixture tasks remain readable by
    // their persisted metadata, but all newly materialized V3 stages use the
    // frozen-test -> red -> Claude -> integrity -> green order.
    const deliveryStages = Number(workflowVersion) >= CURRENT_WORKFLOW_VERSION
      ? taskType === 'diagnosis' ? PIPELINE_V3_DIAGNOSIS_DELIVERY_STAGES : PIPELINE_V3_COMPAT_BUG_DELIVERY_STAGES
      : Number(verificationPolicyVersion) >= CURRENT_VERIFICATION_POLICY_VERSION
        ? taskType === 'diagnosis' ? PIPELINE_V5_DIAGNOSIS_DELIVERY_STAGES : PIPELINE_V5_BUG_DELIVERY_STAGES
      : PIPELINE_V2_BUG_DELIVERY_STAGES;
    for (let index = 1; index <= bugCount; index += 1) {
      for (const [stage, label] of deliveryStages) stages.push({ id: `bug${index}_${stage}`, stage, label, scope: 'bug', phase: 'delivery', bugIndex: index, status: 'pending' });
    }
    return stages;
  }
  const stages = PIPELINE_PROJECT_STAGES.map(([id, label]) => ({ id, label, scope: 'project', status: 'pending' }));
  for (let index = 1; index <= bugCount; index += 1) {
    for (const [stage, label] of PIPELINE_BUG_STAGES) stages.push({ id: `bug${index}_${stage}`, stage, label, scope: 'bug', bugIndex: index, status: 'pending' });
  }
  return stages;
}

// A persisted policy marker alone is not enough to prove that a job has the
// current workflow.  Older jobs can carry the same version marker while their
// stage array still contains retired Gold/private-fixture stages.  Compare the
// ordered stage IDs so the runner can migrate those jobs while preserving the
// status of stages that still exist in the current template.
export function pipelineStageLayoutMatches(job = {}) {
  const expected = createPipelineStages(
    Number(job?.request?.bugCount || job?.bugs?.length || DEFAULT_BUG_COUNT),
    Number(job?.workflowVersion || 1),
    Number(job?.verificationPolicyVersion || 0),
    job?.request?.taskType || 'bugfix',
    Number(job?.workflowPolicyVersion || 0),
  );
  const actual = Array.isArray(job?.stages) ? job.stages : [];
  return expected.length === actual.length && expected.every((stage, index) => actual[index]?.id === stage.id);
}

export function publicPipelineJob(job) {
  const { jobDir, tasksRoot, request, ...visible } = job;
  const privateKeys = new Set(['jobDir', 'tasksRoot', 'taskDir', 'bugBaseDir', 'goldDir', 'sourceDir', 'reportPath', 'outputPath', 'eventsPath', 'rawPath', 'filename', 'trajectory', 'verification_fixture_dir', 'verificationFixture', 'fixtureDir', 'directory']);
  const stripPrivatePaths = (value) => {
    if (Array.isArray(value)) return value.map(stripPrivatePaths);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !privateKeys.has(key))
      .map(([key, item]) => [key, stripPrivatePaths(item)]));
  };
  const currentStageError = (job.stages || []).find((stage) => stage?.id === job.currentStage)?.error;
  const effectiveError = job.status === 'failed' ? text(job.error || currentStageError) : text(job.error);
  const legacyStageMatch = String(job?.currentStage || '').match(/^bug(\d+)_/);
  const rawExecution = job?.bugExecution || null;
  const inferLegacyExecution = Boolean(legacyStageMatch)
    && (!rawExecution || (rawExecution.selectedBugIndex == null && rawExecution.status === 'bug_ready'));
  const execution = normalizeBugExecution({
    ...(rawExecution || {}),
    ...(inferLegacyExecution ? {
      selectedBugIndex: Number(legacyStageMatch[1]),
      status: job.status === 'failed' ? 'fast_lane_failed' : job.status === 'stopped' ? 'fast_lane_stopped' : 'fast_lane_running',
      currentStage: job.currentStage,
    } : {}),
  });
  if (['abandoned', 'stopped'].includes(String(job.status || ''))) {
    execution.status = 'fast_lane_stopped';
    execution.selectedBugIndex = null;
    execution.currentStage = '';
    execution.currentAttempt = 0;
    execution.blockedReason = '';
  }
  const workbenchJob = { ...job, bugExecution: execution };
  const publicBugs = (visible.bugs || []).map((bug) => {
    const summary = summarizeBugAttempts(bug);
    return {
      ...bug,
      workbench: publicBugWorkbench(workbenchJob, bug.bugIndex),
      attemptSummary: {
        count: summary.count,
        totalDurationMs: summary.totalDurationMs,
        currentDurationMs: summary.currentDurationMs,
        currentAttempt: summary.currentAttempt,
      },
      firstFailure: summary.firstFailure || null,
      lastFailure: summary.lastFailure || null,
    };
  });
  return {
    ...stripPrivatePaths({ ...visible, bugs: publicBugs, bugExecution: execution }),
    bugWorkbench: {
      ...execution,
      nextBugIndex: nextIncompleteBugIndex(workbenchJob, execution.selectedBugIndex || 1),
      selectedBug: execution.selectedBugIndex ? publicBugWorkbench(workbenchJob, execution.selectedBugIndex) : null,
    },
    error: effectiveError,
    verificationPolicyVersion: Number(job.verificationPolicyVersion || 0),
    projectPackagePolicyVersion: Number(job.projectPackagePolicyVersion || 0),
    request: {
      projectBrief: request?.projectBrief || '',
      repository: request?.repository || '',
      bugCount: request?.bugCount || pipelineBugQuota(request?.projectTier),
      maxTrajectoryAttempts: request?.maxTrajectoryAttempts || 3,
      taskType: request?.taskType || 'bugfix',
      taskSubtype: request?.taskSubtype || '',
      bugCategory: request?.bugCategory || '',
      projectTier: request?.projectTier || '',
      frontendRequired: Boolean(request?.frontendRequired),
      contributorId: request?.contributorId || request?.creator || '',
      bugPolicyVersion: Number(request?.bugPolicyVersion || 0),
      autoRefillBatchId: request?.autoRefillBatchId || '',
      autoRefillQuestionIndex: request?.autoRefillQuestionIndex || null,
      autoRefillTitle: request?.autoRefillTitle || '',
      replacesPipelineJobId: request?.replacesPipelineJobId || '',
    },
  };
}
