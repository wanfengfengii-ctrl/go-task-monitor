function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * ratio)];
}

function stageFamily(stageId = '') {
  return String(stageId).replace(/^bug\d+_/, 'bug_');
}

function durationMinutes(stage) {
  const cumulativeDurationMs = Number(stage?.cumulativeDurationMs);
  if (Number.isFinite(cumulativeDurationMs) && cumulativeDurationMs > 0) {
    return cumulativeDurationMs / 60_000;
  }
  const attemptDurations = (Array.isArray(stage?.attempts) ? stage.attempts : []).flatMap((attempt) => {
    const startedAt = timestamp(attempt?.startedAt);
    const finishedAt = timestamp(attempt?.finishedAt);
    return startedAt != null && finishedAt != null && finishedAt >= startedAt
      ? [finishedAt - startedAt]
      : [];
  });
  if (attemptDurations.length) return attemptDurations.reduce((total, duration) => total + duration, 0) / 60_000;
  const startedAt = timestamp(stage?.startedAt);
  const finishedAt = timestamp(stage?.finishedAt);
  if (startedAt == null || finishedAt == null || finishedAt < startedAt) return null;
  return (finishedAt - startedAt) / 60_000;
}

function rounded(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

export function pipelinePerformanceSnapshot(jobs = [], {
  workflowVersion = 2,
  verificationPolicyVersion = 5,
  nowMs = Date.now(),
} = {}) {
  const eligible = (jobs || []).filter((job) => Number(job?.workflowVersion || 0) >= workflowVersion
    && Number(job?.verificationPolicyVersion || 0) >= verificationPolicyVersion);
  const stageDurations = new Map();
  const queueMinutes = [];
  let delivered12h = 0;
  let delivered24h = 0;
  let completedProjects24h = 0;
  let autoRetries = 0;

  for (const job of eligible) {
    autoRetries += Math.max(0, Number(job.autoRetryCount || 0));
    const createdAt = timestamp(job.createdAt);
    const startedAt = timestamp(job.startedAt);
    if (createdAt != null && startedAt != null && startedAt >= createdAt) queueMinutes.push((startedAt - createdAt) / 60_000);
    const finishedAt = timestamp(job.finishedAt);
    if (job.status === 'passed' && finishedAt != null && nowMs - finishedAt <= 24 * 60 * 60_000) completedProjects24h += 1;
    for (const stage of job.stages || []) {
      if (stage.status !== 'passed') continue;
      const duration = durationMinutes(stage);
      if (duration != null) {
        const family = stageFamily(stage.id);
        if (!stageDurations.has(family)) stageDurations.set(family, []);
        stageDurations.get(family).push(duration);
      }
      if (stage.stage !== 'delivery_ready' && !/_delivery_ready$/.test(String(stage.id || ''))) continue;
      const deliveredAt = timestamp(stage.finishedAt);
      if (deliveredAt == null) continue;
      if (nowMs - deliveredAt <= 24 * 60 * 60_000) delivered24h += 1;
      if (nowMs - deliveredAt <= 12 * 60 * 60_000) delivered12h += 1;
    }
  }

  const stages = Object.fromEntries([...stageDurations.entries()].map(([family, values]) => [family, {
    samples: values.length,
    p50Minutes: rounded(percentile(values, 0.5)),
    p90Minutes: rounded(percentile(values, 0.9)),
  }]));
  return {
    computedAt: new Date(nowMs).toISOString(),
    scope: `workflow>=${workflowVersion}; verification>=${verificationPolicyVersion}`,
    eligibleJobs: eligible.length,
    delivered12h,
    delivered24h,
    deliveredPerHour12h: rounded(delivered12h / 12),
    completedProjects24h,
    autoRetries,
    queueWait: {
      samples: queueMinutes.length,
      p50Minutes: rounded(percentile(queueMinutes, 0.5)),
      p90Minutes: rounded(percentile(queueMinutes, 0.9)),
    },
    stages,
  };
}
