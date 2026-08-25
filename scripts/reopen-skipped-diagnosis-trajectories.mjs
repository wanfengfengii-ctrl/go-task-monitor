#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { classifyTrajectoryAttemptFailure } from '../src/grader-guards.js';
import { prepareTrajectoryRetry } from './run-production-pipeline.mjs';

function usage() {
  throw new Error('用法：node scripts/reopen-skipped-diagnosis-trajectories.mjs [--apply] <job.json> <bug-index> [...]');
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

function resetStage(stage, status, at) {
  stage.status = status;
  stage.startedAt = null;
  stage.finishedAt = status === 'skipped' ? at : null;
  for (const key of ['error', 'reason', 'result', 'summary', 'attempt', 'sessionId', 'reportPath', 'policy']) delete stage[key];
}

async function completedAcceptanceFailures(taskDir) {
  const taskName = path.basename(taskDir);
  const libraryRoot = path.dirname(path.dirname(taskDir));
  const retryRoot = path.join(libraryRoot, 'retry-history', taskName);
  const attemptRoots = [];
  for (const entry of await fs.readdir(retryRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith('pipeline-retry-')) attemptRoots.push(path.join(retryRoot, entry.name));
  }
  attemptRoots.sort();
  attemptRoots.push(taskDir);

  const failures = [];
  for (const root of attemptRoots) {
    const trajectoryPath = path.join(root, 'trajectory/raw.stream.jsonl');
    const validationPath = path.join(root, 'trajectory/system-validation.log');
    const [trajectory, validation] = await Promise.all([
      fs.readFile(trajectoryPath, 'utf8').catch(() => ''),
      fs.readFile(validationPath, 'utf8').catch(() => ''),
    ]);
    if (!trajectory || !validation || classifyTrajectoryAttemptFailure(validation) === 'model_attempt') continue;
    const events = trajectory.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const results = events.filter((event) => event?.type === 'result');
    if (results.length !== 1 || results[0]?.subtype !== 'success' || results[0]?.is_error !== false) continue;
    failures.push({
      sessionId: results[0].session_id,
      category: classifyTrajectoryAttemptFailure(validation),
      validationPath,
    });
  }
  return failures;
}

async function repairVerificationBaselineMetadata(task) {
  if (!task?.taskDir) return;
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath).catch(() => null);
  if (!metadata || metadata.verification_test_only_commit !== true) return;
  if (metadata.bug_base_parent_commit === metadata.main_commit) return;
  const files = Array.isArray(metadata.verification_test_only_files)
    ? metadata.verification_test_only_files.map(String).filter(Boolean)
    : [];
  if (!files.length || files.some((filename) => filename.startsWith('/') || filename.split(/[\\/]/).includes('..') || !filename.endsWith('_test.go'))) {
    throw new Error(`${task.taskName} 的验证测试文件清单不安全，不能自动恢复元数据`);
  }
  metadata.bug_base_parent_commit = metadata.main_commit;
  await writeJsonAtomic(publicPath, metadata);
}

function reopenBug(job, bugIndex, at, acceptanceFailures = []) {
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  if (!bug) throw new Error(`${job.id} 不存在 Bug ${bugIndex}`);
  if (bug.disposition === 'delivered') throw new Error(`${job.id} Bug ${bugIndex} 已交付，不能重开`);
  if (!bug.task?.taskDir || !bug.task?.taskName) throw new Error(`${job.id} Bug ${bugIndex} 缺少任务目录`);

  const failures = (bug.attempts || []).map((attempt) => ({
    ...attempt,
    category: classifyTrajectoryAttemptFailure(attempt?.error),
  }));
  const modelFailures = failures.filter((attempt) => attempt.category === 'model_attempt');
  if (modelFailures.length && acceptanceFailures.length >= modelFailures.length
    && modelFailures.every((attempt) => /已超时/.test(String(attempt.error || '')))) {
    for (const attempt of modelFailures) attempt.category = 'post_claude_acceptance_infrastructure';
  }
  const unresolvedModelFailures = failures.filter((attempt) => attempt.category === 'model_attempt');
  if (unresolvedModelFailures.length) {
    throw new Error(`${job.id} Bug ${bugIndex} 包含 ${unresolvedModelFailures.length} 次真实模型失败，不能按系统误判自动恢复`);
  }

  bug.systemFailures = [
    ...(bug.systemFailures || []),
    ...failures.map((attempt) => ({
      at: attempt.finishedAt || at,
      recoveredAt: at,
      stage: attempt.stage || `bug${bugIndex}_claude_fix`,
      category: attempt.category,
      error: attempt.error,
      recoveredFromAttemptBudget: true,
    })),
  ].slice(-20);
  bug.attempts = [];
  for (const key of ['disposition', 'skippedAt', 'skipReason', 'trajectoryDisposition', 'trajectorySkipReason', 'trajectorySkippedAt']) delete bug[key];

  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== bugIndex) continue;
    const suffix = String(stage.id || '').replace(`bug${bugIndex}_`, '');
    if (['claude_fix', 'trajectory_validate', 'sol_quality', 'verification_coverage', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready'].includes(suffix)) {
      resetStage(stage, 'pending', at);
    } else if (suffix === 'post_verify') {
      resetStage(stage, 'skipped', at);
      stage.reason = 'diagnosis 只需要模型运行前的 pre_fix:red 证明';
    }
  }
  return bug;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const values = args.filter((arg) => arg !== '--apply');
  if (values.length < 2) usage();
  const jobFile = path.resolve(values[0]);
  const indexes = [...new Set(values.slice(1).map(Number))];
  if (indexes.some((value) => !Number.isInteger(value) || value < 1)) usage();

  const job = await readJson(jobFile);
  if (['running', 'queued'].includes(job.status)) throw new Error(`${job.id} 正在运行，不能重开轨迹`);
  if (job.request?.taskType !== 'diagnosis') throw new Error(`${job.id} 不是 diagnosis 流水线`);
  const at = new Date().toISOString();
  const selected = [];
  for (const index of indexes) {
    const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
    const acceptanceFailures = bug?.task?.taskDir ? await completedAcceptanceFailures(bug.task.taskDir) : [];
    selected.push(reopenBug(job, index, at, acceptanceFailures));
  }
  const preview = {
    apply,
    jobId: job.id,
    bugs: selected.map((bug) => ({ bugIndex: bug.bugIndex, taskName: bug.task.taskName })),
    nextStage: (job.stages || []).find((stage) => !['passed', 'skipped'].includes(stage.status))?.id || null,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }

  // Archive failed runtime files and rebuild each workspace from pristine. The
  // already uploaded pre_fix evidence is retained for diagnosis tasks.
  for (const bug of selected) {
    await repairVerificationBaselineMetadata(bug.task);
    await prepareTrajectoryRetry(job, bug.task, '旧 Diagnosis runner 将 Gold 红测试带入全量测试，属于系统侧误判；使用修正后的 grader 重新生成主轨迹。');
  }

  job.status = 'failed';
  job.currentStage = preview.nextStage;
  job.error = `Bug ${indexes.join(', ')} 的主轨迹已恢复，等待中央调度重跑`;
  job.finishedAt = at;
  job.updatedAt = at;
  job.autoRetryCount = 0;
  job.retryRequestedAt = at;
  job.manualRetryRequestedAt = at;
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: preview.nextStage,
    message: `已恢复 Diagnosis Bug ${indexes.join(', ')}：旧 runner 的 Gold 测试污染按系统故障处理，保留 pre_fix 证明并重跑主轨迹`,
  }].slice(-300);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${JSON.stringify({ ...preview, queuedAt: at }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
