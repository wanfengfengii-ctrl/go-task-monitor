#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifyTrajectoryAttemptFailure } from '../src/grader-guards.js';
import { prepareTrajectoryRetry } from './run-production-pipeline.mjs';

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

function resetStage(stage, status = 'pending', at) {
  stage.status = status;
  for (const key of ['startedAt', 'finishedAt', 'error', 'reason', 'result', 'summary', 'attempt', 'sessionId', 'reportPath', 'policy']) delete stage[key];
  if (status === 'skipped') {
    stage.finishedAt = at;
  }
}

export function reopenBug(job, bugIndex, at, { allowModelFailures = false } = {}) {
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  if (!bug) throw new Error(`${job.id} 不存在 Bug ${bugIndex}`);
  if (bug.disposition === 'delivered') throw new Error(`${job.id} Bug ${bugIndex} 已交付，不能重开`);
  const taskReady = Boolean(bug.task?.taskDir && bug.task?.taskName);
  const failedStage = String(bug.failureStage || bug.lastFailure?.stage || '');
  const taskPreparationFailure = failedStage === `bug${bugIndex}_task_prepare`;
  if (!taskReady && !taskPreparationFailure) throw new Error(`${job.id} Bug ${bugIndex} 缺少任务目录，且不是 task_prepare 失败`);
  if (!taskReady && bug.stageAutoRetries && Object.keys(bug.stageAutoRetries).length) {
    bug.stageAutoRetryBudgetHistory = [...(bug.stageAutoRetryBudgetHistory || []), {
      resetAt: at,
      reason: 'task_prepare_flow_migration',
      retries: bug.stageAutoRetries,
    }].slice(-10);
    delete bug.stageAutoRetries;
  }

  const attempts = (bug.attempts || [])
    .filter((attempt) => attempt?.status === 'failed')
    .map((attempt) => ({
      ...attempt,
      category: classifyTrajectoryAttemptFailure(attempt?.error),
    }));
  const modelAttempts = attempts.filter((attempt) => attempt.category === 'model_attempt');
  if (modelAttempts.length > 1 && !allowModelFailures) {
    throw new Error(`${job.id} Bug ${bugIndex} 包含 ${modelAttempts.length} 次真实模型失败，不能自动恢复`);
  }
  bug.systemFailures = [
    ...(bug.systemFailures || []),
    ...attempts.filter((attempt) => attempt.category !== 'model_attempt').map((attempt) => ({
      at: attempt.finishedAt || at,
      recoveredAt: at,
      stage: attempt.stage || `bug${bugIndex}_claude_fix`,
      category: attempt.category,
      error: attempt.error,
      recoveredFromAttemptBudget: true,
    })),
  ].slice(-20);
  // Keep a genuine model failure visible in history, while returning its
  // budget to the retry cycle after system-side failures are removed.
  bug.attempts = allowModelFailures
    ? []
    : modelAttempts.map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
  for (const key of ['disposition', 'failureDisposition', 'failedAt', 'failureStage', 'failureReason', 'skippedAt', 'skipReason', 'trajectoryDisposition', 'trajectorySkipReason', 'trajectorySkippedAt']) delete bug[key];

  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== bugIndex || stage.phase !== 'delivery') continue;
    // A task_prepare failure occurs before the task directory exists. Reopen
    // that stage so the next Runner can materialize a fresh task from the
    // retained BUG_BASE. Existing tasks still preserve their passed prepare
    // checkpoint and only reopen downstream delivery stages.
    if (taskReady && ['gold_fix', 'task_prepare'].includes(stage.stage)) continue;
    if (!taskReady && stage.stage === 'gold_fix') continue;
    if (Number(stage.bugIndex) === bugIndex && stage.stage === 'post_verify' && job.request?.taskType === 'diagnosis') {
      resetStage(stage, 'skipped', at);
      stage.reason = 'diagnosis 只需要模型运行前的 pre_fix:red 证明';
      continue;
    }
    resetStage(stage, 'pending', at);
  }
  return bug;
}

function usage() {
  throw new Error('用法：node scripts/reopen-skipped-bug.mjs [--apply] [--force-model-retry] <job.json> <bug-index> [反馈文本]');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const forceModelRetry = args.includes('--force-model-retry');
  const flags = new Set(['--apply', '--force-model-retry']);
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index >= 0) args.splice(index, 1);
  }
  const jobFileInput = args.shift();
  const bugIndex = Number(args.shift());
  if (!jobFileInput || !Number.isInteger(bugIndex) || bugIndex < 1) usage();
  const jobFile = path.resolve(jobFileInput);
  const job = await readJson(jobFile);
  if (['running', 'queued'].includes(job.status)) throw new Error(`${job.id} 正在运行，不能重开轨迹`);
  const at = new Date().toISOString();
  const bug = reopenBug(job, bugIndex, at, { allowModelFailures: forceModelRetry });
  const feedback = args.join(' ').trim() || '请新增或修改聚焦的 TestModel_ 回归测试，直接覆盖 user_query 中每个可观察行为，并将唯一目标复现写成可直接执行的定向 go test 命令（包含目标包、TestModel_ 测试名和 -count=1），不得使用包装脚本或空 verify_cmds。';
  const preview = {
    apply,
    jobId: job.id,
    bugIndex,
    bugId: bug.task?.bugId || '',
    taskName: bug.task?.taskName || null,
    retainedModelAttempts: bug.attempts.length,
    forceModelRetry,
    nextStage: !bug.task?.taskDir || !bug.task?.taskName
      ? `bug${bugIndex}_task_prepare`
      : (job.stages || []).find((stage) => stage.status === 'pending')?.id || null,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }
  if (bug.task?.taskDir && bug.task?.taskName) {
    await prepareTrajectoryRetry(job, bug.task, feedback);
  }
  job.status = bug.task?.taskDir && bug.task?.taskName ? 'failed' : 'waiting_resource';
  job.currentStage = preview.nextStage;
  job.error = bug.task?.taskDir && bug.task?.taskName
    ? `Bug ${bugIndex} 主轨迹已恢复，等待中央调度重跑`
    : `Bug ${bugIndex} task_prepare 已恢复，等待中央调度从 BUG_BASE 创建任务`;
  job.finishedAt = bug.task?.taskDir && bug.task?.taskName ? at : null;
  job.updatedAt = at;
  job.autoRetryCount = 0;
  job.retryRequestedAt = at;
  job.manualRetryRequestedAt = at;
  job.runnerPid = null;
  job.schedulerLease = null;
  if (!bug.task?.taskDir || !bug.task?.taskName) {
    const pending = [...new Set([...(job.pendingBugRetries || []), bugIndex]
      .map(Number)
      .filter((index) => Number.isInteger(index) && index > 0))]
      .sort((left, right) => left - right);
    job.pendingBugRetries = pending;
    const selectedBugIndex = pending[0] || bugIndex;
    const selectedStage = `bug${selectedBugIndex}_task_prepare`;
    job.currentStage = selectedStage;
    job.waitingResource = {
      stageId: selectedStage,
      pool: 'general',
      limit: null,
      queuedAt: at,
      reason: 'task_prepare_failure_recovery',
    };
    job.bugExecution = {
      ...(job.bugExecution || {}),
      selectedBugIndex,
      status: 'fast_lane_queued',
      currentStage: selectedStage,
      currentAttempt: 0,
      blockedReason: '等待中央调度从 BUG_BASE 创建任务',
      lastAction: 'task_prepare_failure_recovery',
      updatedAt: at,
    };
    bug.workerExecution = {
      ...(bug.workerExecution || {}),
      status: 'fast_lane_queued',
      currentStage: preview.nextStage || `bug${bugIndex}_task_prepare`,
      startedAt: null,
      currentAttempt: 0,
      updatedAt: at,
      blockedReason: '等待中央调度从 BUG_BASE 创建任务',
      lastAction: 'task_prepare_failure_recovery',
    };
    job.bugExecution.resourceStage = selectedStage;
    job.bugExecution.startedAt = null;
  }
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: preview.nextStage,
    message: `已恢复 Bug ${bugIndex}：${feedback}`,
  }].slice(-300);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${JSON.stringify({ ...preview, queuedAt: at }, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
