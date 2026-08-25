import path from 'node:path';

export const DISTRIBUTED_WORKER_PROTOCOL_VERSION = 1;
export const PIPELINE_NODE_ROLES = new Set(['all-in-one', 'producer', 'repair-worker']);
export const REMOTE_REPAIR_POOL = 'remote-repair';

export function normalizePipelineNodeRole(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return PIPELINE_NODE_ROLES.has(normalized) ? normalized : 'all-in-one';
}

export function formatWorkerSubmissionStats(snapshot = {}) {
  const today = snapshot.today || {};
  const allTime = snapshot.allTime || {};
  return `A 数据统计（${snapshot.date || '日期未知'}，北京时间）：合格完成 ${Number(today.qualified || 0)} 条，上传成功 ${Number(today.uploaded || 0)} 条，待上传 ${Number(today.pendingUpload || 0)} 条，上传失败 ${Number(today.failed || 0)} 条，处理中 ${Number(today.submitting || 0)} 条；累计上传 ${Number(allTime.uploaded || 0)} 条`;
}

export function pipelineStageExecutionRole(stageId = '') {
  const stage = String(stageId || '');
  if (!stage) return 'producer';
  if (stage.startsWith('project_') || stage.startsWith('main_')) return 'producer';
  if (/_bug_discovery$|_bug_source_prepare$|_user_query_review$/.test(stage)) return 'producer';
  return 'repair-worker';
}

export function nodeRoleCanExecuteStage(nodeRole, stageId) {
  const normalized = normalizePipelineNodeRole(nodeRole);
  return normalized === 'all-in-one' || normalized === pipelineStageExecutionRole(stageId);
}

export function prepareRemoteRepairHandoff(job, stageId, handedOffAt = new Date().toISOString()) {
  const updated = structuredClone(job || {});
  if (pipelineStageExecutionRole(stageId) !== 'repair-worker') {
    throw new Error(`阶段 ${stageId || '(empty)'} 不是远程修复阶段`);
  }
  updated.status = 'waiting_resource';
  updated.currentStage = String(stageId);
  updated.runnerPid = null;
  updated.schedulerLease = null;
  updated.finishedAt = null;
  updated.error = '';
  updated.updatedAt = handedOffAt;
  updated.waitingResource = {
    stageId: String(stageId),
    pool: REMOTE_REPAIR_POOL,
    queuedAt: handedOffAt,
    reason: '等待 B 电脑 repair-worker 领取',
  };
  updated.remoteExecution = {
    protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
    requiredRole: 'repair-worker',
    status: 'waiting',
    attempt: Math.max(0, Number(updated.remoteExecution?.attempt || 0)),
    handedOffAt,
    updatedAt: handedOffAt,
  };
  return updated;
}

export function remoteLeaseExpired(remoteExecution, nowMs = Date.now()) {
  const expiresAt = Date.parse(remoteExecution?.expiresAt || '');
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

export function remoteRepairClaimable(job, nowMs = Date.now(), maxAutoRetries = 2) {
  if (!job || job.manualHold || ['passed', 'abandoned', 'stopped'].includes(String(job.status || ''))) return false;
  const nextStage = String(job.currentStage || '');
  if (pipelineStageExecutionRole(nextStage) !== 'repair-worker') return false;
  const remote = job.remoteExecution || {};
  if (remote.requiredRole && remote.requiredRole !== 'repair-worker') return false;
  if (['leased', 'running', 'cancel_requested'].includes(remote.status) && !remoteLeaseExpired(remote, nowMs)) return false;
  if (job.status === 'failed' && Number(job.autoRetryCount || 0) >= Math.max(0, Number(maxAutoRetries) || 0)) return false;
  return job.status === 'waiting_resource' || job.status === 'failed';
}

export function claimRemoteRepairJob(job, {
  workerId,
  leaseId,
  now = new Date(),
  leaseTtlMs = 90_000,
} = {}) {
  if (!workerId || !leaseId) throw new Error('workerId 和 leaseId 必填');
  if (!remoteRepairClaimable(job, now.getTime())) throw new Error('项目当前不能由远程修复 Worker 领取');
  const claimedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(30_000, Number(leaseTtlMs) || 90_000)).toISOString();
  const updated = structuredClone(job);
  updated.remoteExecution = {
    ...(updated.remoteExecution || {}),
    protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
    requiredRole: 'repair-worker',
    status: 'leased',
    workerId: String(workerId),
    leaseId: String(leaseId),
    attempt: Math.max(0, Number(updated.remoteExecution?.attempt || 0)) + 1,
    claimedAt,
    lastHeartbeatAt: claimedAt,
    expiresAt,
    updatedAt: claimedAt,
  };
  updated.status = 'waiting_resource';
  updated.runnerPid = null;
  updated.schedulerLease = null;
  updated.finishedAt = null;
  updated.error = '';
  updated.updatedAt = claimedAt;
  updated.waitingResource = {
    stageId: String(updated.currentStage || ''),
    pool: REMOTE_REPAIR_POOL,
    queuedAt: String(updated.waitingResource?.queuedAt || claimedAt),
    reason: `已由 ${workerId} 领取，等待远程 Runner 启动`,
  };
  if (job.status === 'failed') updated.autoRetryCount = Math.max(0, Number(job.autoRetryCount || 0)) + 1;
  return updated;
}

export function renewRemoteRepairLease(job, {
  workerId,
  leaseId,
  now = new Date(),
  leaseTtlMs = 90_000,
  status = 'running',
} = {}) {
  assertRemoteLeaseOwner(job, workerId, leaseId);
  const heartbeatAt = now.toISOString();
  const updated = structuredClone(job);
  updated.remoteExecution = {
    ...updated.remoteExecution,
    status: updated.remoteExecution?.status === 'cancel_requested' ? 'cancel_requested' : status,
    lastHeartbeatAt: heartbeatAt,
    expiresAt: new Date(now.getTime() + Math.max(30_000, Number(leaseTtlMs) || 90_000)).toISOString(),
    updatedAt: heartbeatAt,
  };
  updated.updatedAt = heartbeatAt;
  return updated;
}

export function assertRemoteLeaseOwner(job, workerId, leaseId) {
  const remote = job?.remoteExecution || {};
  if (!workerId || remote.workerId !== workerId || !leaseId || remote.leaseId !== leaseId) {
    const error = new Error('远程 Worker 租约不存在或已被其他 Worker 接管');
    error.code = 'REMOTE_LEASE_LOST';
    throw error;
  }
  return remote;
}

function centralTaskPath(tasksRoot, task) {
  const taskName = String(task?.taskName || '');
  if (!tasksRoot || !taskName || path.basename(taskName) !== taskName) return '';
  return path.join(tasksRoot, taskName);
}

function rewriteMachinePaths(value, mappings) {
  if (Array.isArray(value)) return value.map((item) => rewriteMachinePaths(item, mappings));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteMachinePaths(item, mappings)]));
  }
  if (typeof value !== 'string') return value;
  for (const [source, target] of mappings) {
    if (!source || !target) continue;
    const normalizedSource = path.resolve(source);
    if (value === normalizedSource) return path.resolve(target);
    if (value.startsWith(`${normalizedSource}${path.sep}`)) {
      return path.join(path.resolve(target), path.relative(normalizedSource, value));
    }
  }
  return value;
}

export function mergeRemoteJobSnapshot(currentJob, workerSnapshot, {
  workerId,
  leaseId,
  receivedAt = new Date().toISOString(),
} = {}) {
  assertRemoteLeaseOwner(currentJob, workerId, leaseId);
  if (!workerSnapshot || workerSnapshot.id !== currentJob.id) throw new Error('远程快照的 pipeline id 不匹配');
  if (workerSnapshot.request?.repository !== currentJob.request?.repository
    || workerSnapshot.request?.cloneUrl !== currentJob.request?.cloneUrl
    || workerSnapshot.mainCommit !== currentJob.mainCommit) {
    throw new Error('远程快照试图改变已冻结的仓库或 main 提交');
  }
  const merged = rewriteMachinePaths(structuredClone(workerSnapshot), [
    [workerSnapshot.jobDir, currentJob.jobDir],
    [workerSnapshot.tasksRoot, currentJob.tasksRoot],
  ]);
  merged.request = structuredClone(currentJob.request);
  merged.jobDir = currentJob.jobDir;
  merged.tasksRoot = currentJob.tasksRoot;
  merged.runnerPid = null;
  merged.schedulerLease = null;
  merged.updatedAt = receivedAt;
  const centralBugs = new Map((currentJob.bugs || []).map((bug) => [Number(bug.bugIndex), bug]));
  for (const bug of merged.bugs || []) {
    const centralBug = centralBugs.get(Number(bug.bugIndex));
    if (centralBug?.bugBaseDir) bug.bugBaseDir = centralBug.bugBaseDir;
    if (bug.task) {
      const taskDir = centralTaskPath(currentJob.tasksRoot, bug.task);
      if (taskDir) bug.task.taskDir = taskDir;
    }
  }
  const workerStatus = String(workerSnapshot.status || '');
  const running = ['queued', 'running', 'waiting_resource'].includes(workerStatus);
  merged.remoteExecution = {
    ...currentJob.remoteExecution,
    status: currentJob.remoteExecution?.status === 'cancel_requested'
      ? 'cancel_requested'
      : running ? 'running' : workerStatus === 'passed' ? 'completed' : workerStatus === 'stopped' ? 'cancelled' : 'failed',
    lastSnapshotAt: receivedAt,
    updatedAt: receivedAt,
  };
  if (running) {
    merged.status = 'waiting_resource';
    merged.finishedAt = null;
    merged.waitingResource = {
      stageId: String(workerSnapshot.currentStage || currentJob.currentStage || ''),
      pool: REMOTE_REPAIR_POOL,
      queuedAt: String(currentJob.waitingResource?.queuedAt || receivedAt),
      reason: `B 电脑 ${workerId} 正在执行`,
    };
  } else {
    delete merged.waitingResource;
  }
  return merged;
}

export function completeRemoteRepairJob(job, {
  workerId,
  leaseId,
  outcome = 'failed',
  completedAt = new Date().toISOString(),
} = {}) {
  assertRemoteLeaseOwner(job, workerId, leaseId);
  const updated = structuredClone(job);
  const normalizedOutcome = outcome === 'passed' ? 'passed' : outcome === 'stopped' ? 'stopped' : 'failed';
  updated.status = normalizedOutcome;
  updated.runnerPid = null;
  updated.schedulerLease = null;
  updated.finishedAt = completedAt;
  updated.updatedAt = completedAt;
  delete updated.waitingResource;
  updated.remoteExecution = {
    ...updated.remoteExecution,
    status: normalizedOutcome === 'passed' ? 'completed' : normalizedOutcome === 'stopped' ? 'cancelled' : 'failed',
    completedAt,
    updatedAt: completedAt,
  };
  return updated;
}

export function hydrateRemoteRepairJob(job, {
  jobDir,
  tasksRoot,
  workerPid = null,
  startedAt = new Date().toISOString(),
} = {}) {
  if (!jobDir || !tasksRoot) throw new Error('远程 Worker 本地 jobDir 和 tasksRoot 必填');
  const hydrated = rewriteMachinePaths(structuredClone(job), [
    [job.jobDir, jobDir],
    [job.tasksRoot, tasksRoot],
  ]);
  hydrated.jobDir = path.resolve(jobDir);
  hydrated.tasksRoot = path.resolve(tasksRoot);
  hydrated.status = 'queued';
  hydrated.runnerPid = workerPid;
  hydrated.finishedAt = null;
  hydrated.error = '';
  delete hydrated.waitingResource;
  const stageId = String(hydrated.currentStage || '');
  hydrated.schedulerLease = { stageId, admittedAt: startedAt, runnerPid: workerPid };
  for (const stage of hydrated.stages || []) {
    if (stage.status !== 'running') continue;
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
  }
  for (const bug of hydrated.bugs || []) {
    bug.bugBaseDir = path.join(hydrated.jobDir, `bug-base-bug${Number(bug.bugIndex)}`);
    if (bug.task?.taskName) bug.task.taskDir = path.join(hydrated.tasksRoot, bug.task.taskName);
  }
  return hydrated;
}
