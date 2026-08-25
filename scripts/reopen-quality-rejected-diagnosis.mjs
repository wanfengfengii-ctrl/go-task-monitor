#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { enqueueBugRetry, normalizeBugExecution } from '../src/bug-workbench.js';
import { pipelineStageResourceProfile } from '../src/pipeline-operations.js';
import { prepareTrajectoryRetry } from './run-production-pipeline.mjs';

const REOPENED_STAGES = new Set([
  'claude_fix',
  'trajectory_validate',
  'test_author',
  'pre_verify',
  'cloud_upload',
  'verification_finalize',
  'delivery_ready',
]);

const RETIRED_DIAGNOSIS_STAGES = new Map([
  ['sol_quality', '新规则暂停轨迹内容质检'],
  ['post_verify', 'diagnosis 只需要模型运行前的 pre_fix:red 证明'],
  ['docker_validation', 'diagnosis 不执行修复后 Docker 验证'],
  ['git_publication', 'diagnosis 不发布模型修复分支'],
  ['verification_coverage', 'V5 使用独立红测证明，不再运行旧题面覆盖复核'],
]);

const PUBLIC_VERIFICATION_FIELDS = [
  'verify_result',
  'verification_test_author',
  'verification_test_author_session_id',
  'verification_test_author_files',
  'verification_test_source_dir',
  'verification_test_sha256',
  'verification_fixture_dir',
  'verification_fixture_sha256',
  'verification_fixture_published',
  'verification_fixture_materialized',
  'verification_test_published',
  'verification_test_storage',
  'model_verification_policy_version',
  'model_verification_pre_fix',
  'model_verification_post_fix',
  'concurrency_verification',
  'verification_repeat_count',
  'verification_coverage',
];

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function resetStage(stage, at) {
  const suffix = String(stage.id || '').replace(`bug${stage.bugIndex}_`, '');
  if (!REOPENED_STAGES.has(suffix) && !RETIRED_DIAGNOSIS_STAGES.has(suffix)) return;
  stage.status = RETIRED_DIAGNOSIS_STAGES.has(suffix) ? 'skipped' : 'pending';
  stage.startedAt = null;
  stage.finishedAt = stage.status === 'skipped' ? at : null;
  stage.error = '';
  stage.attempts = [];
  for (const key of [
    'result', 'summary', 'attempt', 'sessionId', 'reportPath', 'policy',
    'retryCount', 'maxRetries', 'cumulativeDurationMs', 'taskId',
    'trajectoryUrl', 'verificationResult',
  ]) delete stage[key];
  if (stage.status === 'skipped') stage.reason = RETIRED_DIAGNOSIS_STAGES.get(suffix);
  else delete stage.reason;
}

export function reopenQualityRejectedBug(job, bugIndex, at, reason) {
  const index = Number(bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
  if (!bug?.task?.taskDir || !bug?.task?.taskName) throw new Error(`${job.id} Bug ${index} 缺少任务目录`);
  if (bug.disposition !== 'delivered') throw new Error(`${job.id} Bug ${index} 不是已交付数据，不能按质检退回重开`);

  const affectedStages = (job.stages || []).filter((stage) => Number(stage.bugIndex) === index);
  bug.qualityRejectionHistory = [...(bug.qualityRejectionHistory || []), {
    rejectedAt: at,
    reason,
    disposition: bug.disposition,
    deliveredAt: bug.deliveredAt || null,
    attempts: structuredClone(bug.attempts || []),
    verificationTestAuthor: structuredClone(bug.verificationTestAuthor || null),
    verificationEvidence: structuredClone(bug.verificationEvidence || null),
    stages: structuredClone(affectedStages),
  }].slice(-10);

  bug.attempts = [];
  bug.attemptBudgetResetAt = at;
  for (const key of [
    'disposition', 'deliveredAt', 'failureDisposition', 'failedAt', 'failureStage',
    'failureReason', 'trajectoryDisposition', 'trajectorySkipReason',
    'trajectorySkippedAt', 'verificationTestAuthor', 'verificationEvidence',
    'stageAutoRetries', 'firstFailure', 'lastFailure', 'currentAttempt',
    'attemptStartedAt', 'cloudUpload',
  ]) delete bug[key];
  for (const stage of affectedStages) resetStage(stage, at);

  bug.workerExecution = {
    ...(bug.workerExecution || {}),
    status: 'fast_lane_queued',
    currentStage: `bug${index}_claude_fix`,
    subphase: '',
    resourceStage: `bug${index}_claude_fix`,
    startedAt: null,
    currentAttempt: 0,
    updatedAt: at,
    blockedReason: '等待中央调度重跑质检退回数据',
    lastAction: 'quality_rejection_recovery',
  };
  return bug;
}

function applyPatchToBug(bug, patchValue = {}) {
  if (typeof patchValue.user_query === 'string' && patchValue.user_query.trim()) {
    bug.discovery.user_query = patchValue.user_query.trim();
    bug.userQueryDraft = patchValue.user_query.trim();
  }
  if (typeof patchValue.success_criteria === 'string' && patchValue.success_criteria.trim()) {
    bug.discovery.success_criteria = patchValue.success_criteria.trim();
  }
}

async function archiveTaskQualityState(job, bug, at, reason) {
  const stamp = at.replace(/[:.]/g, '-');
  const archiveRoot = path.join(
    path.dirname(job.tasksRoot),
    'retry-history',
    bug.task.taskName,
    `quality-rejection-${stamp}`,
  );
  await fsp.mkdir(archiveRoot, { recursive: true });
  await writeJsonAtomic(path.join(archiveRoot, 'rejection.json'), {
    jobId: job.id,
    bugIndex: bug.bugIndex,
    bugId: bug.task.bugId,
    rejectedAt: at,
    reason,
  });
  const entries = await fsp.readdir(bug.task.taskDir, { withFileTypes: true });
  const archiveNames = new Set([
    '.repair-checkpoint', '.test-author-checkpoint', '.red-green-checkpoint',
    '.publish-checkpoint', '.post-fix-checkpoint', 'verification',
  ]);
  for (const entry of entries) {
    if (!archiveNames.has(entry.name)
      && !entry.name.startsWith('codex-diagnosis-test-')
      && !entry.name.startsWith('verification-test-')) continue;
    await fsp.rename(path.join(bug.task.taskDir, entry.name), path.join(archiveRoot, entry.name));
  }
  return archiveRoot;
}

async function resetTaskMetadata(task, patchValue = {}) {
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  Object.assign(metadata, {
    verify_cmds: [],
    verification_evidence: {},
    verification_test_overlay: 'none',
    verification_test_files: [],
    verification_test_names: [],
    verification_test_manifest: [],
  });
  for (const field of PUBLIC_VERIFICATION_FIELDS) delete metadata[field];
  for (const field of ['user_query', 'success_criteria', 'gold_root_cause']) {
    if (typeof patchValue[field] === 'string' && patchValue[field].trim()) metadata[field] = patchValue[field].trim();
  }
  if (!String(metadata.user_query || '').trim()) throw new Error(`${task.taskName} 缺少 user_query`);
  await writeJsonAtomic(publicPath, metadata);
  await fsp.writeFile(path.join(task.taskDir, 'PROMPT.md'), `${metadata.user_query.trim()}\n`, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const patchArg = args.find((value) => value.startsWith('--patch-file='));
  const reasonArg = args.find((value) => value.startsWith('--reason='));
  const values = args.filter((value) => value !== '--apply'
    && !value.startsWith('--patch-file=')
    && !value.startsWith('--reason='));
  if (values.length < 2) {
    throw new Error('用法：node scripts/reopen-quality-rejected-diagnosis.mjs [--apply] [--patch-file=patches.json] [--reason=原因] <job.json> <bug-index> [...]');
  }
  const jobFile = path.resolve(values[0]);
  const indexes = [...new Set(values.slice(1).map(Number))].sort((left, right) => left - right);
  if (indexes.some((index) => !Number.isInteger(index) || index < 1)) throw new Error('Bug 编号不合法');
  const reason = reasonArg?.slice('--reason='.length).trim() || '外部质检退回：重新生成只读 Diagnosis 主轨迹和独立红测证明';
  const patches = patchArg ? await readJson(path.resolve(patchArg.slice('--patch-file='.length))) : {};
  const job = await readJson(jobFile);
  if (['running', 'queued'].includes(job.status)) throw new Error(`${job.id} 正在运行，不能重开历史交付`);
  if (job.request?.taskType !== 'diagnosis') throw new Error(`${job.id} 不是 diagnosis 流水线`);
  const at = new Date().toISOString();
  const selected = indexes.map((index) => {
    const bug = reopenQualityRejectedBug(job, index, at, reason);
    applyPatchToBug(bug, patches[bug.task.bugId]);
    return bug;
  });
  const preview = {
    apply,
    jobId: job.id,
    bugs: selected.map((bug) => ({ bugIndex: bug.bugIndex, bugId: bug.task.bugId })),
    nextStage: `bug${indexes[0]}_claude_fix`,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }

  const snapshotPath = path.join(
    path.dirname(jobFile),
    'quality-rejection-history',
    `${job.id}-${at.replace(/[:.]/g, '-')}.json`,
  );
  await writeJsonAtomic(snapshotPath, await readJson(jobFile));
  for (const bug of selected) {
    const patchValue = patches[bug.task.bugId] || {};
    await archiveTaskQualityState(job, bug, at, reason);
    await prepareTrajectoryRetry(job, bug.task, reason);
    await resetTaskMetadata(bug.task, patchValue);
    enqueueBugRetry(job, Number(bug.bugIndex), at);
  }

  const firstStage = `bug${indexes[0]}_claude_fix`;
  const profile = pipelineStageResourceProfile(firstStage);
  job.status = 'waiting_resource';
  job.repositoryDisposition = 'partial';
  job.currentStage = firstStage;
  job.error = '';
  job.finishedAt = null;
  job.runnerPid = null;
  job.schedulerLease = null;
  job.retryRequestedAt = at;
  job.manualRetryRequestedAt = at;
  job.updatedAt = at;
  job.waitingResource = {
    stageId: firstStage,
    pool: profile.pool || 'claude',
    limit: profile.limit || null,
    queuedAt: at,
    reason: 'quality_rejection_recovery',
  };
  job.bugExecution = normalizeBugExecution({
    ...job.bugExecution,
    selectedBugIndex: indexes[0],
    status: 'fast_lane_queued',
    startedAt: null,
    currentAttempt: 0,
    currentStage: firstStage,
    subphase: '',
    resourceStage: firstStage,
    blockedReason: '等待中央调度重跑质检退回数据',
    lastAction: 'quality_rejection_recovery',
    updatedAt: at,
  });
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: firstStage,
    message: `质检退回后重开 Diagnosis Bug ${indexes.join(', ')}；旧交付已归档并重新生成主轨迹与红测证明`,
  }].slice(-300);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${JSON.stringify({ ...preview, snapshotPath, queuedAt: at }, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
