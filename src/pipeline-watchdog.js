import { classifyPipelineFailure } from './pipeline-concurrency.js';

export const PIPELINE_WATCHDOG_INTERVAL_MS = 15_000;
export const PIPELINE_HEALTH_INTERVAL_MS = 60_000;
export const PIPELINE_HEARTBEAT_STALE_MS = 45_000;
export const PIPELINE_PROJECT_THROUGHPUT_STALL_MS = 75 * 60_000;

const MINUTE = 60_000;

export function recoverInterruptedPipelineTriages(value = {}, { now = new Date().toISOString() } = {}) {
  let recoveredCount = 0;
  const incidents = (Array.isArray(value.incidents) ? value.incidents : []).map((incident) => {
    if (incident?.status !== 'triaging') return incident;
    recoveredCount += 1;
    return {
      ...incident,
      status: 'open',
      retryAfter: null,
      triageInterruptedAt: now,
      error: '服务重启中断上次 Codex 分诊，已重新排队',
    };
  });
  return {
    recoveredCount,
    state: {
      ...value,
      incidents,
      updatedAt: recoveredCount ? now : value.updatedAt || null,
    },
  };
}

export function pipelineStageTimeouts(stageId = '') {
  const stage = String(stageId);
  if (stage.endsWith('_cloud_upload')) return { softMs: Infinity, hardMs: Infinity };
  // Claude fix sessions have their own activity-aware watchdog and a bounded
  // command timeout. A second stage-age timeout cannot see tool/file activity
  // and used to SIGTERM healthy sessions merely because they ran for an hour.
  if (/^bug\d+_claude_fix$/.test(stage)) return { softMs: Infinity, hardMs: Infinity };
  // Generation can involve several long Claude sessions and project-local
  // test/repair cycles. It must not be terminated merely because the clock
  // passed a stage threshold; heartbeat and explicit process failures remain
  // observable through the runner and throughput monitor.
  if (stage === 'project_generate') return { softMs: Infinity, hardMs: Infinity };
  // Project validation is split into static/architecture checkpoints and its
  // child process has an output-aware idle timeout. Keep soft observability,
  // but do not let a second wall-clock cap discard a healthy Docker build.
  if (stage === 'project_validate') return { softMs: 15 * MINUTE, hardMs: Infinity };
  // Per-Bug Docker delivery runs under the runner's output/activity-aware
  // command watchdog. A wall-clock hard limit here terminates the whole
  // project Runner and discards healthy sibling Bug workers.
  if (/^bug\d+_docker_validation$/.test(stage)) {
    return { softMs: 15 * MINUTE, hardMs: Infinity };
  }
  if (stage === 'main_freeze' || stage === 'main_publish') {
    return { softMs: 10 * MINUTE, hardMs: 40 * MINUTE };
  }
  // Discovery is composed of independently bounded finder, reviewer, and
  // injection-planner calls. Its total wall time grows with the requested Bug
  // count, so a second stage-age cap can terminate a healthy later batch and
  // discard in-memory progress. Keep silence detection, while leaving process
  // termination to the activity-aware child-command limits.
  if (/^bug\d+_bug_discovery$/.test(stage)) {
    return { softMs: 15 * MINUTE, hardMs: Infinity };
  }
  return { softMs: 15 * MINUTE, hardMs: 60 * MINUTE };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function pipelineErrorFingerprint(job = {}) {
  const stageError = (job.stages || []).find((stage) => stage?.id === job.currentStage)?.error;
  const raw = String(job.error || stageError || '');
  // Historical Claude/Docker failures can be large. Fingerprints only need a
  // bounded prefix and suffix; processing the full payload every watchdog tick
  // can otherwise monopolize the monitor process.
  const bounded = raw.length > 8_000 ? `${raw.slice(0, 6_000)}\n...[truncated]...\n${raw.slice(-2_000)}` : raw;
  const normalized = bounded
    .replace(/\/[A-Za-z0-9_./ -]+/g, '<path>')
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return `${job.currentStage || 'unknown'}:${normalized || 'no-error'}`;
}

export function pipelineWatchdogObservation(job, { nowMs = Date.now(), heartbeat = null } = {}) {
  if (!job || !['running', 'failed'].includes(job.status)) return null;
  const failureCategory = classifyPipelineFailure(job);
  if (job.status === 'failed') {
    const stageError = (job.stages || []).find((stage) => stage?.id === job.currentStage)?.error;
    return {
      jobId: job.id,
      type: 'failure',
      severity: ['docker_infrastructure', 'snapshot_infrastructure', 'git_baseline_conflict'].includes(failureCategory) ? 'critical' : 'warning',
      stageId: job.currentStage || '',
      failureCategory,
      fingerprint: pipelineErrorFingerprint(job),
      message: String(job.error || stageError || '流水线失败').slice(0, 2000),
      codexTriage: true,
      // Used to reopen the same incident after an automatic retry writes a
      // newer failure. Without this marker a stable fingerprint would leave
      // the incident in `triaged` forever and suppress the next Codex pass.
      failureAt: job.updatedAt || job.finishedAt || null,
    };
  }

  const stage = (job.stages || []).find((item) => item.id === job.currentStage);
  const progressAt = Math.max(
    timestamp(job.updatedAt),
    timestamp(stage?.startedAt),
    ...(job.logs || []).map((entry) => timestamp(entry.at)),
  );
  // A parallel worker may point currentStage at a queued resource stage before
  // runStage records startedAt. In that window, charging the whole Runner age
  // to the new stage can terminate every sibling Bug as a false hard stall.
  const recordedStageStartedAt = timestamp(stage?.startedAt);
  const stageStartedAt = recordedStageStartedAt
    ? Math.max(recordedStageStartedAt, timestamp(job.runStartedAt))
    : progressAt;
  const progressAgeMs = progressAt ? Math.max(0, nowMs - progressAt) : 0;
  const stageAgeMs = stageStartedAt ? Math.max(0, nowMs - stageStartedAt) : 0;
  const heartbeatAt = timestamp(heartbeat?.at);
  const heartbeatState = !heartbeatAt ? 'unknown' : nowMs - heartbeatAt <= PIPELINE_HEARTBEAT_STALE_MS ? 'alive' : 'stale';
  const limits = pipelineStageTimeouts(job.currentStage);
  if (stageAgeMs >= limits.hardMs) {
    return {
      jobId: job.id,
      type: 'hard_stall',
      severity: 'critical',
      stageId: job.currentStage || '',
      failureCategory: 'stalled_process',
      fingerprint: `${job.currentStage}:hard-stall`,
      message: `阶段已运行 ${Math.round(stageAgeMs / MINUTE)} 分钟，超过 ${Math.round(limits.hardMs / MINUTE)} 分钟硬上限`,
      codexTriage: true,
      heartbeatState,
      heartbeatPid: Number(heartbeat?.pid) || null,
      progressAgeMs,
      stageAgeMs,
    };
  }
  if (progressAgeMs >= limits.softMs) {
    return {
      jobId: job.id,
      type: 'stalled',
      severity: 'warning',
      stageId: job.currentStage || '',
      failureCategory: 'stalled_process',
      fingerprint: `${job.currentStage}:soft-stall`,
      message: `阶段连续 ${Math.round(progressAgeMs / MINUTE)} 分钟没有状态进展，已请求 Codex 只读排查`,
      codexTriage: true,
      heartbeatState,
      heartbeatPid: Number(heartbeat?.pid) || null,
      progressAgeMs,
      stageAgeMs,
    };
  }
  return null;
}

export function pipelineProjectThroughputMonitor(jobs = [], previous = {}, {
  nowMs = Date.now(),
  enabled = true,
  thresholdMs = PIPELINE_PROJECT_THROUGHPUT_STALL_MS,
} = {}) {
  const candidates = (jobs || []).filter((job) => ['draft', 'waiting_resource', 'queued', 'running'].includes(job?.status));
  const active = candidates.filter((job) => ['queued', 'running'].includes(job?.status));
  const completed = (jobs || []).flatMap((job) => (job.stages || [])
    .filter((stage) => stage?.id === 'project_generate' && stage.status === 'passed' && timestamp(stage.finishedAt))
    .map((stage) => ({ jobId: job.id, finishedAt: stage.finishedAt, atMs: timestamp(stage.finishedAt) })));
  completed.sort((left, right) => right.atMs - left.atMs);
  const latest = completed[0] || null;
  const progressChanged = String(previous.lastGeneratedAt || '') !== String(latest?.finishedAt || '');
  const monitoring = enabled && candidates.length > 0;
  const previousStartedMs = timestamp(previous.windowStartedAt);
  const windowStartedMs = monitoring && !progressChanged && previousStartedMs
    ? previousStartedMs
    : nowMs;
  const elapsedMs = monitoring ? Math.max(0, nowMs - windowStartedMs) : 0;
  const stageCounts = Object.fromEntries([...new Set(active.map((job) => String(job.currentStage || 'waiting')))]
    .map((stage) => [stage, active.filter((job) => String(job.currentStage || 'waiting') === stage).length]));
  const state = {
    status: !monitoring ? 'idle' : elapsedMs >= thresholdMs ? 'stalled' : 'monitoring',
    windowStartedAt: new Date(windowStartedMs).toISOString(),
    lastGeneratedAt: latest?.finishedAt || null,
    lastGeneratedJobId: latest?.jobId || null,
    elapsedMs,
    thresholdMs,
    backlogCount: candidates.length,
    activeCount: active.length,
    stageCounts,
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (state.status !== 'stalled') return { state, observation: null };
  const minutes = Math.round(elapsedMs / 60_000);
  return {
    state,
    observation: {
      jobId: 'system-project-throughput',
      type: 'throughput_stall',
      severity: 'warning',
      stageId: 'project_generate',
      failureCategory: 'throughput_stall',
      fingerprint: 'project-generate-throughput',
      message: `流水线连续 ${minutes} 分钟没有任何项目完成生成；当前积压 ${candidates.length} 个、运行 ${active.length} 个，阶段分布 ${JSON.stringify(stageCounts)}。请排查模型网关、生成超时、快照、资源槽和项目复杂度。`,
      codexTriage: true,
      elapsedMs,
      backlogCount: candidates.length,
      activeCount: active.length,
    },
  };
}
