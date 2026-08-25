import fsp from 'node:fs/promises';
import path from 'node:path';
import { nextPipelineStage, pipelineStageResourceProfile } from './pipeline-operations.js';

// Bound the new planning and generation flow to four concurrent projects.
export const MAX_PIPELINE_CONCURRENCY = 4;
export const MAX_PIPELINE_AUTO_RETRIES = 2;

export function classifyPipelineFailure(job = {}) {
  const stage = String(job.currentStage || '');
  const stageRecord = (job.stages || []).find((item) => item?.id === stage);
  const stageError = stageRecord?.error;
  const error = String(job.error || stageError || '');
  const failedStage = job.status === 'failed' || stageRecord?.status === 'failed';
  // Resource-slot ownership files are managed by the pipeline itself. Classify
  // these errors before stage-specific rules so a slot race cannot look like a
  // malformed Bug record or a failed cloud upload.
  if (/resource-slots[\\/][^\s]*owner\.json|owner\.json\.\d+\.tmp/i.test(error)) return 'runner_infrastructure';
  if (/云盘/.test(error) || stage.endsWith('_cloud_upload')) return 'cloud_upload';
  if (/提交平台|质检平台/.test(error) || stage.endsWith('_platform_submit')) return 'submission_platform';
  if (/生成前数据快照|等待数据快照超时|SEEK_HOLE|lseek\s*\([^)]*SEEK_HOLE|snapshot lock|快照锁|tar:\s*\(null\)/i.test(error)) return 'snapshot_infrastructure';
  if (/\[system:grader_collision\]|GRADER_COLLISION|grader[_ -]collision/i.test(error)) return 'grader_infrastructure';
  if (/\[system:audit_infrastructure\]|mutation-audit[\s\S]*(?:未记录\s*(?:PreToolUse|PostToolUse)|baseline.*missing)/i.test(error)) return 'audit_infrastructure';
  if (/\[system:runner_infrastructure\]/i.test(error)) return 'runner_infrastructure';
  if (/\[system:natural_bug_finder\]|自然 Bug 搜索基础设施失败|自然 Bug 搜索分区失败/i.test(error)) return 'natural_bug_finder_infrastructure';
  if (/\[system:git_infrastructure\]|(?:Connection closed by|Connection timed out|Could not resolve host|Failed to connect to)[^\n]*|fatal:\s+Could not read from remote repository/i.test(error)) return 'git_infrastructure';
  if (/\[system:docker_infrastructure\]|error waiting for container:\s*unexpected EOF|Docker (?:Desktop|daemon)|Cannot connect to the Docker daemon|context deadline exceeded|TLS handshake timeout|error during connect|no space left on device|connection reset by peer|unable to lease content|lease does not exist|failed to solve[^\n]*(?:rpc|connection)|failed to fetch anonymous token|(?:docker|buildx|failed to solve)[\s\S]{0,200}(?:i\/o timeout|unexpected EOF)|content digest[^\n]*not found|Docker[^\n]*(?:校验|build|构建)[\s\S]{0,200}(?:超时|未产生子进程事件)/i.test(error)) return 'docker_infrastructure';
  if (stage.endsWith('_verification_coverage')) return 'verification_coverage';
  if (/Claude 修复失败|轨迹完整性与原始性校验/.test(error) || stage.endsWith('_claude_fix') || stage.endsWith('_trajectory_validate') || stage.endsWith('_sol_quality')) return 'claude_trajectory';
  if (/Sol 返回的 Bug 记录不完整|找 Bug 必须明确|Bug record|Bug injection/.test(error) || stage.endsWith('_bug_discovery') || stage.endsWith('_bug_source_prepare')) return 'bug_record';
  if (/项目与双架构 Docker 校验失败|项目静态校验未通过/.test(error) || (failedStage && stage === 'project_validate')) return 'project_validation';
  if (/ENOENT.*project.*go\.mod|Claude 项目生成|go\.mod 缺少 go 语言版本/.test(error) || (failedStage && stage === 'project_generate')) return 'project_generation';
  if (/(?:本地冻结|已发布) main (?:全量测试|静态检查)失败|main 基线不合格/.test(error) || (failedStage && stage === 'main_freeze')) return 'main_baseline_validation';
  if (/远端 main 已存在且不是本作业提交|Remote .* points to|远端 .* 已存在且指向|Local generated project must be frozen/.test(error)) return 'git_baseline_conflict';
  return 'other';
}

export function shouldRegenerateGeneratedProject(job = {}) {
  if (job?.status !== 'failed' || !String(job?.error || '').trim()) return false;
  const currentStage = String(job.currentStage || '');
  const stageRecord = (job.stages || []).find((stage) => stage?.id === currentStage);
  if (stageRecord && stageRecord.status !== 'failed') return false;
  return ['project_generation', 'main_baseline_validation'].includes(classifyPipelineFailure(job));
}

// A resumed runner must never regenerate the planning document after any
// downstream project stage has started.  The project plan is the immutable
// input for generation, validation, and Bug discovery; re-running it after a
// later retry can replace a valid plan with a new model response (and make an
// already-generated project fail a policy gate retroactively).
export function projectPlanCheckpointConsumed(job = {}) {
  const planStage = (job.stages || []).find((stage) => stage?.id === 'project_plan');
  if (!planStage || planStage.status === 'passed') return false;
  if (!job?.project?.project_slug) return false;
  return (job.stages || []).some((stage) => stage?.id !== 'project_plan'
    && stage?.scope === 'project'
    && ['running', 'passed', 'failed'].includes(stage?.status));
}

export function pipelineRetryState(job) {
  const retryCount = Math.max(0, Number(job?.autoRetryCount || 0));
  const failed = job?.status === 'failed';
  const waitingForCloud = failed
    && String(job?.currentStage || '').endsWith('_cloud_upload')
    && /请先连接轨迹云盘/.test(String(job?.error || ''));
  const waitingForPlatform = failed
    && String(job?.currentStage || '').endsWith('_platform_submit')
    && /请在任务系统中连接一次提交平台|请重新连接|钥匙串中没有找到提交平台凭据/.test(String(job?.error || ''));
  const failureCategory = classifyPipelineFailure(job);
  const legacyPublishedBaseline = Number(job?.workflowVersion || 1) < 2 && failureCategory === 'main_baseline_validation';
  const nonRetryable = failed && (failureCategory === 'git_baseline_conflict' || legacyPublishedBaseline);
  return {
    retryCount,
    maxRetries: MAX_PIPELINE_AUTO_RETRIES,
    failureCategory,
    waitingForCloud,
    waitingForPlatform,
    nonRetryable,
    exhausted: failed && !waitingForCloud && !waitingForPlatform && !nonRetryable && retryCount >= MAX_PIPELINE_AUTO_RETRIES,
    automaticRetryPending: failed && !waitingForCloud && !waitingForPlatform && !nonRetryable && retryCount < MAX_PIPELINE_AUTO_RETRIES,
  };
}

export function pipelineAbandonmentState(job) {
  const retry = pipelineRetryState(job);
  const terminalFailure = job?.status === 'failed'
    && !retry.waitingForCloud
    && !retry.waitingForPlatform
    && retry.failureCategory !== 'submission_platform'
    && (retry.nonRetryable || retry.exhausted);
  const approved = Boolean(job?.abandonmentApprovedAt);
  return {
    shouldAbandon: terminalFailure && approved,
    awaitingCodexTriage: terminalFailure && !approved,
    reason: retry.nonRetryable ? 'non_retryable' : retry.exhausted ? 'retry_exhausted' : '',
    failureCategory: retry.failureCategory,
  };
}

export function reopenPipelineAbandonmentForManualRetry(job, reopenedAt = new Date().toISOString()) {
  const updated = structuredClone(job || {});
  if (updated.status !== 'abandoned') return { changed: false, job: updated };
  updated.status = 'failed';
  updated.error = '';
  updated.finishedAt = null;
  updated.autoRetryCount = 0;
  updated.updatedAt = reopenedAt;
  updated.manualRetryRequestedAt = reopenedAt;
  updated.retryRequestedAt = reopenedAt;
  delete updated.abandonedAt;
  delete updated.abandonmentApprovedAt;
  delete updated.abandonmentApprovalIncidentId;
  delete updated.abandonReason;
  delete updated.failureCategory;
  delete updated.repositoryDisposition;
  delete updated.replacementJobId;
  updated.logs = [...(updated.logs || []), {
    at: reopenedAt,
    level: 'warn',
    stageId: updated.currentStage || null,
    message: '用户明确请求重试，已撤销自动分诊的项目废弃结论并从未通过阶段恢复',
  }].slice(-300);
  return { changed: true, job: updated };
}

export function pendingPipelineReplacementSources(jobs) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const replacementSources = new Set(allJobs
    .map((job) => String(job?.request?.replacesPipelineJobId || ''))
    .filter(Boolean));
  return allJobs.filter((job) => job?.status === 'abandoned'
    && !job?.historicalArchived
    && !job.replacementJobId
    && !replacementSources.has(job.id));
}

export function pipelineOccupiedJobIds(jobs) {
  return new Set((jobs || [])
    .filter((job) => job && ['queued', 'running'].includes(job.status))
    .map((job) => job.id));
}

export function pipelineResumeUsesExistingAdmission(job = {}, externalResume = false) {
  return externalResume === true
    && Boolean(job?.startedAt)
    && job?.bugExecution?.mode === 'workbench'
    && ['stopped', 'waiting_resource', 'failed'].includes(String(job?.status || ''));
}

export function pipelineAutofillStartCapacity(
  jobs = [],
  effectiveMaxConcurrency = MAX_PIPELINE_CONCURRENCY,
  configuredMaxConcurrency = MAX_PIPELINE_CONCURRENCY,
) {
  const occupied = pipelineOccupiedJobIds(jobs).size;
  const dynamicCapacity = Math.max(0, Number(effectiveMaxConcurrency || 0) - occupied);
  const existingResumeCount = (jobs || [])
    .filter((job) => pipelineResumeUsesExistingAdmission(job, true))
    .length;
  const existingResumeCapacity = Math.min(
    existingResumeCount,
    Math.max(0, Number(configuredMaxConcurrency || 0) - occupied),
  );
  return Math.max(dynamicCapacity, existingResumeCapacity);
}

export function isStaleQueuedPipelineReservation(job = {}, liveRunnerJobIds = new Set()) {
  const liveIds = liveRunnerJobIds instanceof Set ? liveRunnerJobIds : new Set(liveRunnerJobIds || []);
  return job?.status === 'queued'
    && !job.schedulerLease
    && !liveIds.has(job.id);
}

export function isPipelineAutofillEligible(job, currentWorkflowVersion, currentVerificationPolicyVersion = 0) {
  if (job?.legacyAutoRetryEnabled) return true;
  const currentPolicy = Number(currentVerificationPolicyVersion || 0);
  return Number(job?.workflowVersion || 1) >= Number(currentWorkflowVersion)
    && (!currentPolicy || Number(job?.verificationPolicyVersion || 0) >= currentPolicy);
}

export function isRetryablePipelineStartError(error) {
  const message = String(error?.message || error || '');
  return /并发上限|容量(?:上限|已满)|资源池.*已满|资源保护|资源维护|任务队列正在运行/.test(message);
}

export function pipelineCentralPriority(job = {}) {
  if (job.manualRetryRequestedAt) return 0;
  // A stopped planning job already owns a persisted request and planning
  // history. Resume it before admitting a brand-new project plan, while
  // keeping downstream generation and delivery stages ahead of planning.
  if (isStoppedProjectPlanning(job)) return 45;
  const stage = String(nextPipelineStage(job) || job.currentStage || '');
  if (/^bug\d+_(?:post_verify|verification_coverage|cloud_upload|verification_finalize|platform_submit|delivery_ready)$/.test(stage)) return 10;
  if (/^bug\d+_/.test(stage)) return 20;
  if (['project_validate', 'main_freeze', 'main_publish'].includes(stage)) return 30;
  if (stage === 'project_generate') return 40;
  return 50;
}

export function queuePipelineManualRetry(job, queuedAt = new Date().toISOString(), reason = 'manual_retry_capacity') {
  const updated = structuredClone(job || {});
  const stageId = nextPipelineStage(updated);
  const profile = pipelineStageResourceProfile(stageId);
  const enteredAt = String(updated.waitingResource?.queuedAt || updated.manualRetryRequestedAt || updated.retryRequestedAt || queuedAt);
  const stage = (updated.stages || []).find((item) => item.id === stageId);
  if (stage && stage.status === 'failed') {
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
  }
  updated.status = 'waiting_resource';
  updated.currentStage = stageId;
  updated.error = '';
  updated.finishedAt = null;
  updated.runnerPid = null;
  updated.schedulerLease = null;
  updated.retryRequestedAt = queuedAt;
  updated.manualRetryRequestedAt = queuedAt;
  updated.updatedAt = queuedAt;
  updated.waitingResource = {
    stageId,
    pool: profile.pool || 'general',
    limit: profile.limit || null,
    queuedAt: enteredAt,
    reason,
  };
  if (updated.bugExecution && typeof updated.bugExecution === 'object') {
    updated.bugExecution = {
      ...updated.bugExecution,
      status: 'fast_lane_queued',
      startedAt: null,
      currentStage: stageId,
      blockedReason: '等待中央调度资源',
      updatedAt: queuedAt,
    };
  }
  updated.logs = [...(updated.logs || []), {
    at: queuedAt,
    level: 'info',
    stageId,
    message: '人工重试已进入中央调度队列，等待资源后从当前阶段继续',
  }].slice(-300);
  return updated;
}

function pipelineQueueEnteredAt(job = {}) {
  return String(job.waitingResource?.queuedAt || job.manualRetryRequestedAt || job.retryRequestedAt || job.createdAt || '');
}

function isNewProjectCandidate(job = {}) {
  if (job.status !== 'draft') return false;
  const stage = String(nextPipelineStage(job) || job.currentStage || '');
  return stage === 'project_plan' || stage === 'project_generate';
}

function isStoppedProjectGeneration(job = {}) {
  if (job?.status !== 'stopped' || !job?.project) return false;
  if (job?.bugExecution?.lastAction === 'user_stopped') return false;
  const stage = String(nextPipelineStage(job) || job.currentStage || '');
  return stage === 'project_generate';
}

function isStoppedProjectPlanning(job = {}) {
  if (job?.status !== 'stopped') return false;
  if (job?.bugExecution?.lastAction === 'user_stopped') return false;
  const stage = String(nextPipelineStage(job) || job.currentStage || '');
  return stage === 'project_plan';
}

export function selectPipelineAutofillCandidates(jobs, activeJobIds, availableSlots, {
  snapshotInProgress = false,
  nowMs = Date.now(),
  candidatePredicate = () => true,
  continuationPredicate = () => true,
  preserveContinuationPriority = false,
  blockNewProjectOnAnyResourceWait = false,
} = {}) {
  const active = new Set(activeJobIds || []);
  const allJobs = [...(jobs || [])];
  const slots = Math.max(0, Math.min(MAX_PIPELINE_CONCURRENCY, Number(availableSlots) || 0));
  const resourceWaitPending = blockNewProjectOnAnyResourceWait
    && allJobs.some((job) => job?.status === 'waiting_resource');
  let candidates = allJobs
    .filter((job) => {
      if (!job || active.has(job.id)) return false;
      if (job.manualHold === true) return false;
      if (['passed', 'abandoned'].includes(job.status)) return false;
      if (job.status === 'draft' || job.status === 'waiting_resource') return true;
      if (job.status === 'stopped' && (job.manualRetryRequestedAt
        || isStoppedProjectGeneration(job)
        || isStoppedProjectPlanning(job))) return true;
      return pipelineRetryState(job).automaticRetryPending;
    });
  const continuationPending = preserveContinuationPriority
    && candidates.some((job) => pipelineCentralPriority(job) <= 30 && continuationPredicate(job));
  candidates = candidates
    .filter((job) => !continuationPending || pipelineCentralPriority(job) <= 30)
    .filter((job) => !resourceWaitPending || !isNewProjectCandidate(job))
    .filter((job) => candidatePredicate(job))
    .sort((left, right) => {
      return pipelineCentralPriority(left) - pipelineCentralPriority(right)
      || Number(Boolean(right.retryRequestedAt)) - Number(Boolean(left.retryRequestedAt))
      || pipelineQueueEnteredAt(left).localeCompare(pipelineQueueEnteredAt(right))
      || String(left.id || '').localeCompare(String(right.id || ''));
    });
  const selected = [];
  let remaining = slots;
  // A shared snapshot outage affects every project-generation runner. Let one
  // failed job probe recovery first instead of consuming all four slots with
  // the same host-level failure.
  const snapshotRecovery = candidates.find((candidate) => candidate.status === 'failed'
    && classifyPipelineFailure(candidate) === 'snapshot_infrastructure');
  if (snapshotRecovery) {
    const recoveryProbeActive = allJobs.some((job) => {
      if (!active.has(job?.id) || nextPipelineStage(job) !== 'project_generate') return false;
      const stageStartedAt = Date.parse((job.stages || []).find((stage) => stage?.id === 'project_generate')?.startedAt || '') || 0;
      const snapshotReady = (job.logs || []).some((entry) => entry?.stageId === 'project_generate'
        && /数据快照已就绪/.test(String(entry.message || ''))
        && (Date.parse(entry.at || '') || 0) >= stageStartedAt);
      // The lock is authoritative. The short grace period covers the gap
      // between spawning a runner and its acquisition of the shared lock.
      return !snapshotReady && (!stageStartedAt || nowMs - stageStartedAt < 2 * 60_000);
    });
    if (!snapshotInProgress && !recoveryProbeActive) {
      return remaining >= 1 ? [snapshotRecovery] : [];
    }
    candidates = candidates.filter((candidate) => candidate.status !== 'failed'
      || classifyPipelineFailure(candidate) !== 'snapshot_infrastructure');
  }
  for (const candidate of candidates) {
    if (remaining < 1) continue;
    selected.push(candidate);
    remaining -= 1;
    if (!remaining) break;
  }
  return selected;
}

export function reconcilePipelineCloudUpload(job, uploadRecords, reconciledAt = new Date().toISOString(), { verificationExportReadyTaskIds = new Set() } = {}) {
  if (job?.status !== 'failed') return null;
  const matched = String(job.currentStage || '').match(/^bug(\d+)_(?:cloud_upload|verification_finalize)$/);
  if (!matched) return null;
  const bugIndex = Number(matched[1]);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  const taskName = bug?.task?.taskName;
  if (!taskName) return null;
  const upload = (uploadRecords || []).find((record) => record?.task === taskName);
  if (!upload?.signedUrl) return null;

  const updated = structuredClone(job);
  const verificationCoverageStage = updated.stages?.find((stage) => stage.id === `bug${bugIndex}_verification_coverage`);
  const cloudStage = updated.stages?.find((stage) => stage.id === `bug${bugIndex}_cloud_upload`);
  const verificationFinalizeStage = updated.stages?.find((stage) => stage.id === `bug${bugIndex}_verification_finalize`);
  const deliveryStage = updated.stages?.find((stage) => stage.id === `bug${bugIndex}_delivery_ready`);
  if (!cloudStage || !deliveryStage) return null;
  // V5 recovery must not infer delivery readiness from a cloud upload alone.
  // The task has to pass the same coverage and proof checks used by Excel
  // export, otherwise recovery can hide an unfinished coverage review until
  // the user tries to export the row.
  if (verificationFinalizeStage && verificationCoverageStage?.status !== 'passed') return null;
  if (verificationFinalizeStage && !verificationExportReadyTaskIds.has(upload.taskId)) return null;
  cloudStage.status = 'passed';
  cloudStage.error = '';
  cloudStage.finishedAt = reconciledAt;
  cloudStage.result = { taskId: upload.taskId, signedUrl: upload.signedUrl, skipped: true };
  if (verificationFinalizeStage) {
    verificationFinalizeStage.status = 'passed';
    verificationFinalizeStage.error = '';
    verificationFinalizeStage.finishedAt = reconciledAt;
    verificationFinalizeStage.result = { taskId: upload.taskId, reconciled: true };
  }
  deliveryStage.status = 'passed';
  deliveryStage.error = '';
  deliveryStage.finishedAt = reconciledAt;
  deliveryStage.result = { taskId: upload.taskId, sessionId: upload.sessionId || null, trajectoryUrl: upload.signedUrl };
  updated.logs = [...(updated.logs || []), {
    at: reconciledAt,
    level: 'success',
    stageId: deliveryStage.id,
    message: `Bug ${bugIndex} 已根据云盘上传记录自动回填交付状态`,
  }].slice(-300);
  updated.updatedAt = reconciledAt;
  updated.error = '';
  delete updated.retryRequestedAt;

  const nextStage = (updated.stages || []).find((stage) => !['passed', 'skipped'].includes(stage.status));
  if (!nextStage) {
    updated.status = 'passed';
    updated.currentStage = null;
    updated.finishedAt = reconciledAt;
  } else {
    updated.status = 'failed';
    updated.currentStage = nextStage.id;
    updated.error = '轨迹已上传并回填，等待继续后续 Bug';
    updated.autoRetryCount = 0;
    updated.retryRequestedAt = reconciledAt;
    updated.finishedAt = null;
  }
  return updated;
}

export function createSerializedJsonWriter(filename) {
  let tail = Promise.resolve();
  let sequence = 0;

  return (value) => {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    sequence += 1;
    const temporary = `${filename}.${process.pid}.${sequence}.tmp`;
    const operation = tail.then(async () => {
      await fsp.mkdir(path.dirname(filename), { recursive: true });
      await fsp.writeFile(temporary, content, 'utf8');
      await fsp.rename(temporary, filename);
    });
    tail = operation.catch(() => {});
    return operation;
  };
}

export async function runWorkerPool(items, requestedConcurrency, worker) {
  const concurrency = Math.min(
    MAX_PIPELINE_CONCURRENCY,
    Math.max(1, Number.isInteger(requestedConcurrency) ? requestedConcurrency : MAX_PIPELINE_CONCURRENCY),
    items.length,
  );
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: concurrency }, (_, workerIndex) => (async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index, workerIndex) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  })());

  await Promise.allSettled(workers);
  return results;
}
