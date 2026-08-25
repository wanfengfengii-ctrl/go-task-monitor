#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateFiles } from './validate-trajectories.mjs';

const monitorRoot = path.resolve(import.meta.dirname, '..');
const libraryRoot = path.resolve(monitorRoot, '../.task_work/go-task-library');
const tasksRoot = path.join(libraryRoot, 'tasks');
const jobsRoot = path.join(libraryRoot, 'pipeline-jobs');
const validationRoot = path.join(libraryRoot, 'validation');
const apiUrl = process.env.GO_TASK_MONITOR_API_URL || 'http://127.0.0.1:4174';
const apply = process.argv.includes('--apply');
const requestedTaskIds = new Set(process.argv
  .filter((arg) => arg.startsWith('--task-id='))
  .map((arg) => arg.slice('--task-id='.length).trim())
  .filter(Boolean));
const requestedBugIds = new Set(process.argv
  .filter((arg) => arg.startsWith('--bug-id='))
  .map((arg) => arg.slice('--bug-id='.length).trim())
  .filter(Boolean));

function now() {
  return new Date().toISOString();
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 10 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `${pathname} 返回 HTTP ${response.status}`);
  return payload;
}

function isHistoricalContentRejection(task) {
  const failureStage = String(task.pipelineFailureStage || '');
  const captureFailureRecordedAsClaude = failureStage.endsWith('claude_fix')
    && /轨迹累计\s*\d+\s*次仍未完成采集登记/.test(String(task.pipelineSkipReason || ''));
  const oldRejection = task.status === 'skipped'
    && (['trajectory_validate', 'sol_quality'].some((suffix) => failureStage.endsWith(suffix))
      || captureFailureRecordedAsClaude);
  const interruptedMigration = task.status === 'passed'
    && task.pipelineDisposition === 'revalidated'
    && task.reviewStatus !== 'qualified';
  const recoverableFinalizationFailure = task.status === 'passed'
    && task.pipelineDisposition === 'failed'
    && failureStage.endsWith('verification_finalize');
  return Boolean(task.sessionId) && (oldRejection || interruptedMigration || recoverableFinalizationFailure);
}

async function deliveryFile(task, taskRoot) {
  const trajectoryRoot = path.join(taskRoot, 'trajectory');
  const filenames = await fs.readdir(trajectoryRoot);
  const filename = filenames.find((item) => item === `trajectory_${task.sessionId}.jsonl`)
    || filenames.find((item) => item === `trajectory_${task.sessionId}.json`);
  if (!filename) throw new Error('找不到与 session_id 一致的交付轨迹');
  return path.join(trajectoryRoot, filename);
}

async function validateCandidate(task) {
  const taskRoot = path.join(tasksRoot, task.name);
  const filename = await deliveryFile(task, taskRoot);
  const result = await validateFiles({
    json: true,
    failOnWarning: false,
    maxWrites: 2,
    taskName: task.name,
    taskType: task.task_type,
    taskRoot,
    inputs: [filename],
  });
  const report = result.reports[0];
  return {
    task,
    taskRoot,
    filename,
    ok: report.ok,
    sessionId: report.stats.sessionId,
    eventCount: report.stats.eventCount,
    errors: report.errors.map((item) => item.message),
  };
}

function resetDeliveryStages(job, candidate, migratedAt) {
  const bugIndex = Number(candidate.task.bug_index);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  if (!bug || bug.task?.taskName !== candidate.task.name) throw new Error(`${job.id} 找不到 Bug ${bugIndex} 的任务记录`);

  const alreadyRevalidated = bug.disposition === 'revalidated';
  bug.disposition = 'revalidated';
  delete bug.skippedAt;
  delete bug.skipReason;
  if (!alreadyRevalidated && !(bug.attempts || []).some((item) => item.stage === 'historical_integrity_revalidation' && item.sessionId === candidate.sessionId)) {
    bug.attempts = [...(bug.attempts || []), {
      attempt: (bug.attempts || []).length + 1,
      status: 'passed',
      stage: 'historical_integrity_revalidation',
      sessionId: candidate.sessionId,
      finishedAt: migratedAt,
    }];
  }

  const updates = {
    [`bug${bugIndex}_trajectory_validate`]: {
      status: 'passed',
      finishedAt: migratedAt,
      sessionId: candidate.sessionId,
      reused: true,
      policy: 'integrity-originality-only',
    },
    [`bug${bugIndex}_sol_quality`]: {
      status: 'skipped',
      finishedAt: migratedAt,
      summary: '新规则暂停轨迹内容质检',
      policy: 'integrity-originality-only',
    },
    [`bug${bugIndex}_cloud_upload`]: { status: 'pending' },
    [`bug${bugIndex}_delivery_ready`]: { status: 'pending' },
  };
  for (const stage of job.stages || []) {
    const update = updates[stage.id];
    if (!update) continue;
    Object.assign(stage, update);
    delete stage.error;
    delete stage.reason;
    delete stage.result;
  }
  job.updatedAt = migratedAt;
  job.error = '';
}

function finishDelivery(job, candidate, uploaded, migratedAt) {
  const bugIndex = Number(candidate.task.bug_index);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  bug.disposition = 'delivered';
  bug.deliveredAt = migratedAt;
  bug.lastAction = 'delivery_completed';
  for (const key of ['failureDisposition', 'trajectoryDisposition', 'trajectorySkipReason', 'trajectorySkippedAt', 'skippedAt', 'skipReason']) {
    delete bug[key];
  }
  bug.workerExecution = {
    ...(bug.workerExecution || {}),
    status: 'fast_lane_completed',
    currentStage: '',
    currentAttempt: 0,
    blockedReason: '',
    lastAction: 'delivery_completed',
    updatedAt: migratedAt,
  };
  const cloud = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_cloud_upload`);
  const delivery = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_delivery_ready`);
  Object.assign(cloud, { status: 'passed', finishedAt: migratedAt, result: uploaded });
  Object.assign(delivery, {
    status: 'passed',
    finishedAt: migratedAt,
    taskId: candidate.task.id,
    sessionId: candidate.sessionId,
    trajectoryUrl: uploaded.signedUrl,
  });
  job.updatedAt = migratedAt;
}

async function main() {
  const status = await api('/api/run/status');
  const reviewRecords = await readJson(path.join(validationRoot, 'review_statuses.json')).catch(() => []);
  const manuallyRejected = new Set(reviewRecords
    .filter((item) => item.status === 'unqualified' && !String(item.source || '').startsWith('pipeline-'))
    .map((item) => item.taskId));
  const candidates = status.tasks.filter((task) => {
    const explicitlyRequested = requestedTaskIds.has(task.id) || requestedBugIds.has(task.bug_id);
    if (requestedTaskIds.size && !requestedTaskIds.has(task.id)) return false;
    if (requestedBugIds.size && !requestedBugIds.has(task.bug_id)) return false;
    const deliveredWithStaleState = explicitlyRequested
      && task.pipelineDisposition === 'delivered'
      && Boolean(task.sessionId);
    return (isHistoricalContentRejection(task) || deliveredWithStaleState) && !manuallyRejected.has(task.id);
  });
  const validations = [];
  for (const task of candidates) {
    try {
      validations.push(await validateCandidate(task));
    } catch (error) {
      validations.push({ task, ok: false, errors: [error.message] });
    }
  }

  const passed = validations.filter((item) => item.ok);
  const failed = validations.filter((item) => !item.ok);
  const preview = {
    policy: 'integrity-originality-only',
    mode: apply ? 'apply' : 'dry-run',
    checkedAt: now(),
    summary: { total: validations.length, passed: passed.length, failed: failed.length },
    passed: passed.map((item) => ({ taskId: item.task.id, bugId: item.task.bug_id, sessionId: item.sessionId, eventCount: item.eventCount })),
    failed: failed.map((item) => ({ taskId: item.task.id, bugId: item.task.bug_id, errors: item.errors })),
  };
  if (!apply || !passed.length) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const migrationId = `integrity-revalidation-${now().replace(/[:.]/g, '-')}`;
  const backupRoot = path.join(validationRoot, 'migrations', migrationId);
  const byJob = Map.groupBy(passed, (item) => item.task.pipelineJobId);
  for (const [jobId, items] of byJob) {
    const filename = path.join(jobsRoot, jobId, 'job.json');
    const job = await readJson(filename);
    await writeJsonAtomic(path.join(backupRoot, `${jobId}.before.json`), job);
    const migratedAt = now();
    for (const item of items) resetDeliveryStages(job, item, migratedAt);
    await writeJsonAtomic(filename, job);
  }

  await new Promise((resolve) => setTimeout(resolve, 11_000));
  await api('/api/tasks/review', {
    method: 'POST',
    body: JSON.stringify({ tasks: passed.map((item) => item.task.id), status: 'qualified', source: 'pipeline-integrity-originality' }),
  });
  const uploadPayload = await api('/api/cloud/upload', {
    method: 'POST',
    body: JSON.stringify({ tasks: passed.map((item) => item.task.id) }),
  });
  const uploads = new Map((uploadPayload.uploaded || []).map((item) => [item.taskId, item]));

  for (const [jobId, items] of byJob) {
    const filename = path.join(jobsRoot, jobId, 'job.json');
    const job = await readJson(filename);
    const migratedAt = now();
    for (const item of items) {
      const uploaded = uploads.get(item.task.id);
      if (!uploaded?.signedUrl) throw new Error(`${item.task.bug_id} 未返回云盘链接`);
      finishDelivery(job, item, uploaded, migratedAt);
    }
    await writeJsonAtomic(filename, job);
  }

  const result = {
    ...preview,
    migrationId,
    appliedAt: now(),
    uploaded: passed.map((item) => ({
      taskId: item.task.id,
      bugId: item.task.bug_id,
      signedUrl: uploads.get(item.task.id)?.signedUrl || '',
    })),
  };
  await writeJsonAtomic(path.join(backupRoot, 'result.json'), result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
