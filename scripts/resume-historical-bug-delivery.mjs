#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  throw new Error('usage: node scripts/resume-historical-bug-delivery.mjs JOB_JSON BUG_INDEX');
}

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
  if (status === 'passed') {
    stage.startedAt = at;
    stage.finishedAt = at;
  }
}

async function main() {
  const [jobInput, indexInput] = process.argv.slice(2);
  const bugIndex = Number(indexInput);
  if (!jobInput || !Number.isInteger(bugIndex) || bugIndex < 1) usage();
  const jobFile = path.resolve(jobInput);
  const job = await readJson(jobFile);
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
  if (!bug?.task?.taskDir || !bug.task.taskName) throw new Error(`Bug ${bugIndex} 缺少任务目录`);
  const metadata = await readJson(path.join(bug.task.taskDir, 'public.json'));
  const sessionId = String(metadata.test_model_fix_session_id || '').trim();
  const commit = String(metadata.test_model_fix_commit || '').trim();
  if (!sessionId || !commit) throw new Error(`${metadata.bug_id} 缺少恢复后的提交或 Session`);
  const at = new Date().toISOString();
  const task = bug.task;

  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== bugIndex) continue;
    const suffix = String(stage.id || '').replace(`bug${bugIndex}_`, '');
    if (suffix === 'claude_fix') {
      resetStage(stage, 'passed', at);
      stage.result = { recoveredHistoricalTrajectory: true, sessionId, commit };
    } else if (['trajectory_validate', 'pre_verify', 'post_verify', 'verification_coverage', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready'].includes(suffix)) {
      resetStage(stage, 'pending');
    } else if (suffix === 'sol_quality') {
      resetStage(stage, 'pending');
    }
  }
  bug.trajectoryDisposition = null;
  bug.trajectorySkipReason = '';
  bug.historicalRecovery = {
    recoveredAt: at,
    source: 'retry-history-successful-run',
    trajectorySessionId: sessionId,
    testModelFixCommit: commit,
    note: '旧覆盖复核误判，恢复原始成功轨迹并重新生成 V5 独立证明',
  };
  const execution = job.bugExecution || {};
  job.bugExecution = {
    ...execution,
    mode: execution.mode || 'workbench',
    selectedBugIndex: bugIndex,
    autoContinue: false,
    status: 'fast_lane_running',
    currentAttempt: 0,
    currentStage: `bug${bugIndex}_trajectory_validate`,
    updatedAt: at,
    lastAction: 'historical_delivery_recovery',
    blockedReason: '',
  };
  job.status = 'failed';
  job.currentStage = `bug${bugIndex}_trajectory_validate`;
  job.finishedAt = at;
  job.error = `${metadata.bug_id} 已恢复历史成功轨迹，等待独立红绿证明与云盘回填`;
  job.autoRetryCount = 0;
  job.retryRequestedAt = at;
  job.manualRetryRequestedAt = at;
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: `bug${bugIndex}_trajectory_validate`,
    message: `${metadata.bug_id} 已恢复原始成功主轨迹（session=${sessionId}、commit=${commit}），保留失败历史，重新执行 V5 证明上传`,
  }].slice(-300);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${JSON.stringify({ jobId: job.id, bugIndex, bugId: metadata.bug_id, sessionId, commit, nextStage: job.currentStage }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
