import os from 'node:os';

export const PIPELINE_CONTROL_MODES = new Set(['running', 'paused', 'draining', 'emergency_stopped']);

export function normalizePipelineControlMode(value, autoFillEnabled = true) {
  if (PIPELINE_CONTROL_MODES.has(value)) return value;
  return autoFillEnabled === false ? 'paused' : 'running';
}

export function pipelineStageRequiredServices(stageId = '') {
  const stage = String(stageId);
  if (stage.endsWith('_user_query_review')) return [];
  if (stage === 'project_plan' || stage.endsWith('_bug_discovery') || stage.endsWith('_bug_source_prepare')
    || stage.endsWith('_gold_fix') || stage.endsWith('_sol_quality')) return ['codex'];
  if (stage === 'project_generate') return ['claude'];
  if (stage === 'project_validate' || stage.endsWith('_trajectory_validate')) return ['docker'];
  if (stage === 'main_publish') return ['git'];
  if (stage.endsWith('_claude_fix')) return ['claude'];
  // The post-trajectory acceptance-test author is an isolated Codex Session,
  // not the Claude repair gateway. Requiring Claude here can park a healthy
  // Codex stage indefinitely during an unrelated Claude outage.
  if (stage.endsWith('_test_author')) return ['codex'];
  if (stage.endsWith('_red_green') || stage.endsWith('_docker_validation')) return ['docker'];
  if (stage.endsWith('_pre_verify') || stage.endsWith('_post_verify')) return ['claude', 'docker'];
  if (stage.endsWith('_verification_coverage')) return ['codex'];
  if (stage.endsWith('_cloud_upload') || stage.endsWith('_verification_finalize')) return ['cloud'];
  return [];
}

export function pipelineDependencyServiceForIncident(incident = {}) {
  const stageId = String(incident.stageId || '');
  const text = `${stageId} ${incident.failureCategory || ''} ${incident.message || ''}`;
  if (/snapshot|快照|SEEK_HOLE|lseek|tar:\s*\(null\)/i.test(text)) return 'host';
  if (/cloud|云盘/i.test(text)) return 'cloud';
  if (/docker|buildx|container|proxy\.golang|TLS/i.test(text)) return 'docker';
  if (/git|github|push|remote/i.test(text)) return 'git';
  if (/claude/i.test(text)) return 'claude';
  if (/codex|sol/i.test(text)) return 'codex';
  return pipelineStageRequiredServices(stageId)[0] || 'host';
}

export function nextPipelineStage(job = {}) {
  const stages = job.stages || [];
  // A workbench selection is authoritative for a resumed Bug. Without this
  // branch, the global first-pending-stage scan can admit Bug N while the
  // runner is executing the user-selected Bug M, causing an endless resource
  // hand-off loop and a frozen workbench timer.
  const selectedBugIndex = Number(job?.bugExecution?.selectedBugIndex);
  if (Number.isInteger(selectedBugIndex) && selectedBugIndex > 0) {
    const selectedPrefix = `bug${selectedBugIndex}_`;
    const current = String(job.currentStage || '');
    if (current.startsWith(selectedPrefix)) {
      const currentRecord = stages.find((stage) => stage.id === current);
      if (!currentRecord || ['running', 'failed'].includes(currentRecord.status)) return current;
    }
    const selectedStage = stages.find((stage) => String(stage.id || '').startsWith(selectedPrefix)
      && !['passed', 'skipped'].includes(stage.status));
    if (selectedStage) return String(selectedStage.id);
  }
  const pendingTechnicalSelection = stages.find((stage) => stage.phase === 'selection'
    && ['bug_discovery', 'bug_source_prepare'].includes(stage.stage)
    && !['passed', 'skipped'].includes(stage.status));
  if (pendingTechnicalSelection) {
    const technicalIndex = stages.indexOf(pendingTechnicalSelection);
    const unmetProjectPrerequisite = stages.slice(0, technicalIndex).find((stage) => stage.stage !== 'user_query_review'
      && !['passed', 'skipped'].includes(stage.status));
    if (unmetProjectPrerequisite) return String(unmetProjectPrerequisite.id);
    return String(pendingTechnicalSelection.id);
  }
  if (job.status === 'failed' && job.currentStage) return String(job.currentStage);
  return String(stages.find((stage) => !['passed', 'skipped'].includes(stage.status))?.id || job.currentStage || '');
}

// A persisted cursor can briefly point at a completed discovery stage while
// the runner hands off to another Bug. Do not expose that stale stage as the
// current work in the pipeline list.
export function selectPipelineDisplayStage(stages = [], job = {}, activeWorkbenchBug = null) {
  const list = Array.isArray(stages) ? stages : [];
  const activeStage = activeWorkbenchBug?.workbench?.currentStage
    ? list.find((stage) => stage.id === activeWorkbenchBug.workbench.currentStage
      && ['running', 'failed'].includes(stage.status))
    : null;
  const persistedStage = list.find((stage) => stage.id === job.currentStage
    && ['running', 'failed'].includes(stage.status));
  const pendingCursorStage = ['queued', 'waiting_resource', 'waiting_review', 'draft'].includes(String(job?.status || ''))
    ? list.find((stage) => stage.id === job.currentStage && stage.status === 'pending')
    : null;
  // A running job can briefly have no active stage while the completed worker
  // hands off to the next resource. Show the next pending stage instead of
  // leaving the card on a stale completed cursor.
  const nextPendingStage = ['running', 'queued', 'waiting_resource'].includes(String(job?.status || ''))
    ? list.find((stage) => stage.status === 'pending')
    : null;
  return activeStage
    || persistedStage
    || list.find((stage) => stage.status === 'running')
    || list.find((stage) => stage.status === 'failed')
    || pendingCursorStage
    || nextPendingStage
    || null;
}

export function pipelineStageWeight(stageId = '') {
  return pipelineStageResourceProfile(stageId).weight;
}

export function pipelineRepairWorkerLimit(environment = globalThis.process?.env || {}) {
  const configured = Number(environment.GO_PIPELINE_REPAIR_WORKER_LIMIT || 2);
  return Math.max(1, Math.min(8, Number.isFinite(configured) ? configured : 2));
}

export function pipelineStructuredCodexLimit({
  configuredLimit = 2,
  loadAverage = os.loadavg()[0],
  cpuCount = os.cpus().length,
} = {}) {
  const limit = Math.max(1, Math.min(2, Number(configuredLimit) || 2));
  const normalizedCpuCount = Math.max(1, Number(cpuCount) || 1);
  const loadRatio = Number(loadAverage || 0) / normalizedCpuCount;
  return loadRatio >= 1.2 ? 1 : limit;
}

export function pipelineStageResourceProfile(stageId = '') {
  const stage = String(stageId || '');
  if (stage.endsWith('_user_query_review')) return { pool: '', limit: 0, weight: 0 };
  if (stage === 'project_plan' || stage === 'codex_injection_plan' || stage === 'codex_injection'
    || stage.endsWith('_test_author')) {
    return { pool: 'codex-structured', limit: 2, weight: 1 };
  }
  if (stage === 'project_generate') return { pool: 'project-generation', limit: 4, weight: 1 };
  // Bug discovery/source preparation can use four lightweight analysis slots.
  // Each Runner dynamically reduces its internal fan-out when projects compete,
  // keeping the host-wide finder/writer count bounded by this pool.
  const analysis = stage.endsWith('_bug_discovery') || stage.endsWith('_bug_source_prepare');
  if (analysis) return { pool: 'compute-analysis', limit: 4, weight: 1 };
  // Claude's production fix is independently bounded from validation and proof
  // work. The worker limit is temporarily overridable for repair sprints.
  if (stage.endsWith('_claude_fix')) {
    return { pool: 'compute-repair', limit: pipelineRepairWorkerLimit(), weight: 1 };
  }
  // Direct proof sessions have isolated source/output directories and can use
  // all four Bug workers. Docker-backed validation remains separately bounded
  // because its builds and cross-platform containers are host-heavy.
  if (stage.endsWith('_pre_verify') || stage.endsWith('_post_verify')) {
    return { pool: 'compute-proof', limit: 4, weight: 1 };
  }
  const dockerValidation = stage === 'project_validate'
    || stage.endsWith('_red_green')
    || stage.endsWith('_docker_validation');
  if (dockerValidation) return { pool: 'compute-docker', limit: 2, weight: 1 };
  if (stage.endsWith('_verification_coverage')) return { pool: 'compute-analysis', limit: 2, weight: 1 };
  const heavy = stage.endsWith('_gold_fix');
  return heavy
    ? { pool: 'compute-heavy', limit: 2, weight: 2 }
    : { pool: '', limit: 0, weight: 1 };
}

export function pipelineStageUsesDocker(stageId = '') {
  return pipelineStageResourceProfile(stageId).pool === 'compute-docker';
}

export function pipelineDockerBusyJobIds(jobs = []) {
  return new Set((jobs || [])
    .filter((job) => ['queued', 'running'].includes(job?.status))
    .filter((job) => pipelineStageUsesDocker(nextPipelineStage(job) || job.currentStage))
    .map((job) => String(job.id || ''))
    .filter(Boolean));
}

export function pipelineHeavyLane(stageId = '') {
  const stage = String(stageId || '');
  if (stage === 'project_validate' || stage === 'main_freeze'
    || stage.endsWith('_pre_verify') || stage.endsWith('_claude_fix') || stage.endsWith('_post_verify')) return 'verification';
  if (stage.endsWith('_bug_discovery') || stage.endsWith('_bug_source_prepare') || stage.endsWith('_gold_fix')) return 'analysis';
  return '';
}

export function pipelineOccupiedWeight(jobs = []) {
  return jobs.filter((job) => ['queued', 'running'].includes(job?.status))
    .reduce((sum, job) => sum + pipelineStageWeight(nextPipelineStage(job) || job.currentStage), 0);
}

export function pipelineResourcePoolState(jobs = [], effectiveMaxConcurrency = 4, activeLeaseCounts = null) {
  const effectiveMax = Math.max(0, Number(effectiveMaxConcurrency) || 0);
  const definitions = [
    ['codex-structured', 'project_plan'],
    ['project-generation', 'project_generate'],
    ['compute-analysis', 'bug1_bug_discovery'],
    ['compute-repair', 'bug1_claude_fix'],
    ['compute-proof', 'bug1_pre_verify'],
    ['compute-docker', 'project_validate'],
    ['compute-heavy', 'bug1_gold_fix'],
  ];
  const pools = Object.fromEntries(definitions.map(([pool, exampleStage]) => {
    const profile = pipelineStageResourceProfile(exampleStage);
    // The global limit counts project runners, while compute pools count Bug
    // workers inside those runners. Preserve internal capacity once a project
    // is admitted; project bootstrap pools still follow the project limit.
    const projectBootstrapPool = pool === 'codex-structured' || pool === 'project-generation';
    const limit = effectiveMax === 0
      ? 0
      : projectBootstrapPool
        ? Math.min(profile.limit, Math.floor(effectiveMax / profile.weight))
        : profile.limit;
    return [pool, { pool, limit, occupied: 0, available: limit }];
  }));

  for (const job of jobs) {
    if (!['queued', 'running'].includes(job?.status)) continue;
    // A workbench keeps the last resourceStage for display and audit after a
    // Bug is stopped or completed.  That historical cursor must not reserve a
    // live slot; only workers that are actually running or switching can
    // contribute to pool occupancy.
    // A project runner may keep several Bug workers queued behind the two
    // active workers.  Queued workers do not own a compute slot yet; counting
    // them makes a pool appear over capacity (for example 3/2 test-author
    // slots) and can starve an unrelated project indefinitely.
    const workerStages = (job.bugs || [])
      .filter((bug) => ['fast_lane_running', 'fast_lane_switching']
        .includes(String(bug?.workerExecution?.status || '')))
      // currentStage is advanced on every phase hand-off.  Prefer it over the
      // retained resource cursor, which can lag during the test-author and
      // delivery hand-offs; fall back to resourceStage for older snapshots.
      .map((bug) => String(bug?.workerExecution?.currentStage
        || bug?.workerExecution?.resourceStage || ''))
      .filter(Boolean);
    const resourceStages = workerStages.length
      ? workerStages
      : [String(job?.bugExecution?.resourceStage || nextPipelineStage(job) || job.currentStage || '')];
    for (const stageId of resourceStages) {
      const profile = pipelineStageResourceProfile(stageId);
      if (profile.pool && pools[profile.pool]) pools[profile.pool].occupied += 1;
    }
  }
  for (const pool of Object.values(pools)) {
    const contenders = pool.occupied;
    const hasLeaseCount = activeLeaseCounts instanceof Map
      ? activeLeaseCounts.has(pool.pool)
      : activeLeaseCounts && Object.hasOwn(activeLeaseCounts, pool.pool);
    const leaseCount = activeLeaseCounts instanceof Map
      ? activeLeaseCounts.get(pool.pool)
      : activeLeaseCounts?.[pool.pool];
    const authoritativeOccupied = hasLeaseCount && Number.isFinite(Number(leaseCount))
      ? Math.max(0, Number(leaseCount))
      : contenders;
    pool.occupied = Math.min(pool.limit, authoritativeOccupied);
    pool.available = Math.max(0, pool.limit - pool.occupied);
    const waiting = Math.max(0, contenders - pool.occupied);
    if (waiting > 0) pool.waiting = waiting;
  }
  return pools;
}

export function pipelineStageStartCapacity(jobs = [], stageId = '', effectiveMaxConcurrency = 4, {
  waitingJobs = jobs,
  activeLeaseCounts = null,
  reuseExistingAdmission = false,
} = {}) {
  const limit = Math.max(0, Number(effectiveMaxConcurrency) || 0);
  const occupied = (jobs || []).filter((job) => ['queued', 'running'].includes(job?.status)).length;
  if (!reuseExistingAdmission && occupied + 1 > limit) {
    return {
      allowed: false,
      pool: 'global',
      occupied,
      limit,
      available: Math.max(0, limit - occupied),
    };
  }

  const profile = pipelineStageResourceProfile(stageId);
  if (profile.pool) {
    const pool = pipelineResourcePoolState(jobs, effectiveMaxConcurrency, activeLeaseCounts)[profile.pool];
    const requestedLane = profile.pool === 'compute-heavy' ? pipelineHeavyLane(stageId) : '';
    if (requestedLane && pool?.available) {
      const activeInLane = (jobs || []).filter((job) => ['queued', 'running'].includes(job?.status)
        && pipelineHeavyLane(nextPipelineStage(job) || job.currentStage) === requestedLane).length;
      const otherLaneWaiting = (waitingJobs || []).some((job) => (job?.status === 'waiting_resource'
        || (job?.status === 'failed' && job?.manualRetryRequestedAt))
        && pipelineStageResourceProfile(nextPipelineStage(job)).pool === 'compute-heavy'
        && pipelineHeavyLane(nextPipelineStage(job))
        && pipelineHeavyLane(nextPipelineStage(job)) !== requestedLane);
      if (activeInLane >= 1 && otherLaneWaiting) {
        return {
          allowed: false,
          pool: `${profile.pool}-fair-share`,
          occupied: pool.occupied,
          limit: pool.limit,
          available: pool.available,
        };
      }
    }
    return {
      allowed: Boolean(pool?.available),
      pool: profile.pool,
      occupied: pool?.occupied || 0,
      limit: pool?.limit || 0,
      available: pool?.available || 0,
    };
  }

  return {
    allowed: true,
    pool: 'general',
    occupied,
    limit,
    available: Math.max(0, limit - occupied),
  };
}

export function pipelineStageHealthBlockers(stageId, health = {}, { nowMs = Date.now(), maxAgeMs = 3 * 60_000 } = {}) {
  const blockers = [];
  const required = pipelineStageRequiredServices(stageId);
  if (!required.length) return blockers;
  const checkedAt = Date.parse(health.updatedAt || '');
  if (!Number.isFinite(checkedAt) || nowMs - checkedAt > maxAgeMs) {
    blockers.push('系统健康状态过期');
    return blockers;
  }
  for (const key of required) {
    const service = health.services?.[key];
    if (service?.status !== 'online') blockers.push(`${service?.name || key} ${service?.status === 'degraded' ? '需要恢复' : '离线'}`);
  }
  return blockers;
}

export function parseDockerSize(value = '') {
  const match = String(value).trim().replace(/\s*\([^)]*\)\s*$/, '').match(/^([0-9.]+)\s*([kmgtp]?b)$/i);
  if (!match) return 0;
  const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };
  return Math.round(Number(match[1]) * (units[match[2].toLowerCase()] || 1));
}

export function parseDockerBuildxReclaimableBytes(output = '') {
  let reclaimableBytes = 0;
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^Reclaimable:\s*(.+?)\s*$/i);
    if (match) reclaimableBytes = parseDockerSize(match[1]);
  }
  return reclaimableBytes;
}

export function parsePipelineRunnerProcesses(output, runnerPath) {
  const found = new Map();
  // Runners started by older monitor processes may retain a relative argv
  // (for example `node task-monitor/scripts/run-production-pipeline.mjs`),
  // while current starts use the absolute path. Match the script component
  // with path/whitespace boundaries so both forms can be adopted safely.
  const runnerName = String(runnerPath || '').split(/[\\/]/).pop() || 'run-production-pipeline.mjs';
  const runnerPattern = new RegExp(`(?:^|[\\\\\\s/])${runnerName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|$)`);
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !runnerPattern.test(match[2])) continue;
    const jobMatch = match[2].match(/(pipeline-[a-z0-9-]+)\/job\.json(?:\s|$)/i);
    if (!jobMatch) continue;
    found.set(jobMatch[1], { pid: Number(match[1]), command: match[2] });
  }
  return found;
}

// A runner can die after spawning a Claude snapshot shell. The shell then
// becomes an orphan and no longer contains run-production-pipeline.mjs in its
// command line, so the normal runner scan cannot adopt or stop it. Keep the
// parser pure so the monitor can safely reconcile these descendants on boot.
export function parseOrphanedPipelineProcesses(output) {
  const found = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidText, ppidText, pgidText, command] = match;
    if (!/pipeline-jobs[\\/]pipeline-[a-z0-9-]+[\\/]artifacts[\\/]runner-snapshots[\\/]/i.test(command)) continue;
    const jobMatch = command.match(/pipeline-jobs[\\/](pipeline-[a-z0-9-]+)[\\/]/i);
    if (!jobMatch) continue;
    found.push({
      jobId: jobMatch[1],
      pid: Number(pidText),
      ppid: Number(ppidText),
      pgid: Number(pgidText),
      command,
    });
  }
  return found;
}

export function pipelineResourcePolicy(snapshot = {}, { configuredMax = 4 } = {}) {
  const diskUsedPercent = Number(snapshot.diskUsedPercent || 0);
  const diskFreeBytes = Number(snapshot.diskFreeBytes || 0);
  const freeMemoryBytes = Number(snapshot.freeMemoryBytes || 0);
  const totalMemoryBytes = Number(snapshot.totalMemoryBytes || 0);
  const memoryAvailablePercent = Number(snapshot.memoryAvailablePercent);
  const loadRatio = Number(snapshot.loadRatio || 0);
  let effectiveMaxConcurrency = Math.max(1, Math.min(4, Number(configuredMax) || 4));
  const warnings = [];
  const blockers = [];

  if (diskUsedPercent >= 90 && diskFreeBytes < 25 * 1024 ** 3) blockers.push(`磁盘使用率 ${diskUsedPercent.toFixed(1)}%，且可用空间不足 25 GiB`);
  else if (diskUsedPercent >= 85 && diskFreeBytes < 50 * 1024 ** 3) blockers.push(`磁盘使用率 ${diskUsedPercent.toFixed(1)}%，且可用空间不足 50 GiB`);
  else if (diskUsedPercent >= 75 && diskFreeBytes < 100 * 1024 ** 3) {
    warnings.push(`磁盘使用率 ${diskUsedPercent.toFixed(1)}%`);
    effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 2);
  }

  if (Number.isFinite(memoryAvailablePercent)) {
    if (memoryAvailablePercent < 10) blockers.push(`系统可用内存比例 ${memoryAvailablePercent.toFixed(0)}%`);
    else if (memoryAvailablePercent < 20) {
      warnings.push(`系统可用内存比例 ${memoryAvailablePercent.toFixed(0)}%`);
      effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 1);
    } else if (memoryAvailablePercent < 35) {
      warnings.push(`系统可用内存比例 ${memoryAvailablePercent.toFixed(0)}%`);
      effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 2);
    }
  } else if (totalMemoryBytes > 0 && freeMemoryBytes < 2 * 1024 ** 3) blockers.push('可用内存不足 2 GiB');
  else if (totalMemoryBytes > 0 && freeMemoryBytes < 4 * 1024 ** 3) {
    warnings.push('可用内存不足 4 GiB');
    effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 1);
  } else if (totalMemoryBytes > 0 && freeMemoryBytes < 8 * 1024 ** 3) {
    warnings.push('可用内存不足 8 GiB');
    effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 2);
  }

  if (loadRatio >= 3) {
    warnings.push(`系统负载为 CPU 核数的 ${loadRatio.toFixed(2)} 倍`);
    effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 1);
  } else if (loadRatio >= 2.5) {
    warnings.push(`系统负载为 CPU 核数的 ${loadRatio.toFixed(2)} 倍`);
    effectiveMaxConcurrency = Math.min(effectiveMaxConcurrency, 2);
  }

  return {
    status: blockers.length ? 'blocked' : warnings.length ? 'degraded' : 'healthy',
    canCreate: blockers.length === 0,
    canStart: blockers.length === 0,
    effectiveMaxConcurrency: blockers.length ? 0 : effectiveMaxConcurrency,
    blockers,
    warnings,
    cleanupRecommended: pipelineDiskCleanupPlan(snapshot).mode !== 'none',
  };
}

export function pipelineDiskCleanupPlan(snapshot = {}, { force = false } = {}) {
  const gib = 1024 ** 3;
  const diskFreeBytes = Number(snapshot?.diskFreeBytes || 0);
  const reclaimableBytes = Number(snapshot?.dockerReclaimableBytes || 0);
  const plan = (mode, builderMaxUsedSpace, builderReservedSpace, tempMaxAgeHours) => ({
    mode,
    targetFreeBytes: 120 * gib,
    builderMaxUsedSpace,
    builderReservedSpace,
    imageMaxAgeHours: 168,
    tempMaxAgeHours,
  });

  if (diskFreeBytes > 0 && diskFreeBytes < 80 * gib && reclaimableBytes >= 2e9) {
    return plan('critical', '4GB', '4GB', 24);
  }
  if (diskFreeBytes > 0 && diskFreeBytes < 120 * gib && reclaimableBytes >= 5e9) {
    return plan('pressure', '8GB', '6GB', 48);
  }
  if (reclaimableBytes >= 30e9) return plan('preventive', '12GB', '8GB', 168);
  if (force) return plan('manual', '12GB', '8GB', 168);
  return plan('none', null, null, null);
}

export function pipelineDockerMaintenanceAction(snapshot = {}, state = {}, {
  occupiedCount = 0,
  nowMs = Date.now(),
  lastMaintenanceAt = null,
  cooldownMs = 6 * 60 * 60_000,
} = {}) {
  const status = String(state?.status || 'idle');
  const cleanupPlan = pipelineDiskCleanupPlan(snapshot);
  const urgent = ['critical', 'pressure'].includes(cleanupPlan.mode);
  const routine = cleanupPlan.mode === 'preventive';
  const retryAt = Number(state?.retryAfter || 0);
  const lastMaintenanceMs = Date.parse(lastMaintenanceAt || '');
  const cooldownReady = (!retryAt || nowMs >= retryAt)
    && (!Number.isFinite(lastMaintenanceMs) || nowMs - lastMaintenanceMs >= cooldownMs);

  if (status === 'running') return { action: 'wait', mode: 'running' };
  if (status === 'pending') {
    if ((!urgent && !routine) || (!urgent && occupiedCount > 0)) return { action: 'cancel', mode: 'stale' };
    return occupiedCount > 0
      ? { action: 'wait', mode: 'urgent' }
      : { action: 'run', mode: urgent ? 'urgent' : 'routine' };
  }
  if (!cooldownReady) return { action: 'none', mode: 'cooldown' };
  if (urgent) return { action: 'request', mode: 'urgent' };
  if (routine && occupiedCount === 0) return { action: 'request', mode: 'routine' };
  return { action: 'none', mode: routine ? 'wait-for-idle' : 'not-needed' };
}

export function collectHostResourceSnapshot({
  statfs,
  loadAverage = os.loadavg()[0],
  cpuCount = os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  memoryAvailablePercent,
  dockerReclaimableBytes = null,
  dockerSystemReclaimableBytes = 0,
  dockerBuilderReclaimableBytes = 0,
} = {}) {
  const blocks = Number(statfs?.blocks || 0);
  const available = Number(statfs?.bavail || statfs?.bfree || 0);
  const diskUsedPercent = blocks > 0 ? ((blocks - available) / blocks) * 100 : 0;
  const systemReclaimableBytes = Number(dockerSystemReclaimableBytes || 0);
  const builderReclaimableBytes = Number(dockerBuilderReclaimableBytes || 0);
  const totalDockerReclaimableBytes = dockerReclaimableBytes == null
    ? systemReclaimableBytes + builderReclaimableBytes
    : Number(dockerReclaimableBytes || 0);
  return {
    diskUsedPercent,
    diskFreeBytes: available * Number(statfs?.bsize || 0),
    freeMemoryBytes,
    totalMemoryBytes,
    memoryAvailablePercent: Number.isFinite(Number(memoryAvailablePercent)) ? Number(memoryAvailablePercent) : null,
    loadAverage,
    cpuCount,
    loadRatio: cpuCount > 0 ? loadAverage / cpuCount : 0,
    dockerReclaimableBytes: totalDockerReclaimableBytes,
    dockerSystemReclaimableBytes: systemReclaimableBytes,
    dockerBuilderReclaimableBytes: builderReclaimableBytes,
  };
}

const shanghaiDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pipelineDailyBudget(jobs, { now = new Date(), projectLimit = null, trajectoryLimit = null } = {}) {
  const dayKey = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return shanghaiDayFormatter.format(date);
  };
  const day = dayKey(now);
  const createdProjects = (jobs || []).filter((job) => dayKey(job.createdAt) === day).length;
  const deliveredTrajectories = (jobs || []).reduce((sum, job) => sum + (job.stages || []).filter((stage) =>
    stage.status === 'passed' && String(stage.id || '').endsWith('_delivery_ready') && dayKey(stage.finishedAt) === day).length, 0);
  const normalizedProjectLimit = Number.isFinite(Number(projectLimit)) && Number(projectLimit) > 0 ? Math.floor(Number(projectLimit)) : null;
  const normalizedTrajectoryLimit = Number.isFinite(Number(trajectoryLimit)) && Number(trajectoryLimit) > 0 ? Math.floor(Number(trajectoryLimit)) : null;
  return {
    day,
    projectLimit: normalizedProjectLimit,
    trajectoryLimit: normalizedTrajectoryLimit,
    createdProjects,
    deliveredTrajectories,
    canCreateProject: (normalizedProjectLimit == null || createdProjects < normalizedProjectLimit)
      && (normalizedTrajectoryLimit == null || deliveredTrajectories < normalizedTrajectoryLimit),
  };
}

export function pipelineJobStartBlockers(job, health, resourcePolicy, budget) {
  const blockers = [];
  if (!resourcePolicy?.canStart) blockers.push(...(resourcePolicy?.blockers || ['主机资源不足']));
  blockers.push(...pipelineStageHealthBlockers(nextPipelineStage(job), health));
  if (job?.status === 'draft' && budget && !budget.canCreateProject) blockers.push('已达到当日项目或轨迹预算');
  return [...new Set(blockers)];
}

export function triageActionPlan(incident = {}, triage = {}) {
  const action = String(triage.recommended_action || 'manual_review');
  if (incident.type === 'throughput_stall') return { type: 'observe', action, reason: '系统级零产出事件只做只读分诊，由单任务监控执行具体恢复动作' };
  if (triage.project_disposition === 'abandon') {
    return incident.type === 'hard_stall'
      ? { type: 'terminate_and_abandon', action }
      : { type: 'approve_abandonment', action };
  }
  if (incident.type === 'stalled') return { type: 'observe', action, reason: '软卡点只告警，不自动终止' };
  if (incident.type === 'hard_stall' && ['retry_stage', 'regenerate_project'].includes(action)) return { type: 'terminate_and_retry', action };
  if (['retry_stage', 'regenerate_project'].includes(action)) return { type: 'queue_retry', action };
  if (action === 'wait_dependency') return { type: 'wait_dependency', action };
  if (action === 'fix_pipeline' || action === 'manual_review') return { type: 'pause_scheduler', action };
  return { type: 'observe', action, reason: '无需自动执行' };
}

export function pipelineHardStallTerminationScope(job = {}, stageId = '') {
  const activeStageIds = (job.stages || [])
    .filter((stage) => stage?.status === 'running')
    .map((stage) => String(stage.id || ''))
    .filter(Boolean);
  const safe = activeStageIds.length === 1 && activeStageIds[0] === String(stageId || '');
  return {
    safe,
    activeStageIds,
    reason: safe
      ? ''
      : `硬卡点不能终止整项目：告警节点 ${stageId || '未知'}，当前运行节点 ${activeStageIds.join(', ') || '无'}`,
  };
}

export function shouldQueuePipelineRetry({ processActive = false, terminated = false } = {}) {
  return terminated || !processActive;
}
