#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { enqueueBugRetry, normalizeBugExecution } from '../src/bug-workbench.js';
import { nextPipelineStage, pipelineStageResourceProfile } from '../src/pipeline-operations.js';
import { reactivatePipelineBug } from '../src/pipeline-rules.js';
import { prepareTrajectoryRetry } from './run-production-pipeline.mjs';

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function resetStage(stage) {
  stage.status = 'pending';
  stage.startedAt = null;
  stage.finishedAt = null;
  stage.error = '';
  for (const key of ['reason', 'result', 'summary', 'attempt', 'sessionId', 'reportPath', 'policy']) delete stage[key];
}

async function reopenProofMismatch(job, bug) {
  const metadataPath = path.join(bug.task.taskDir, 'public.json');
  const metadata = await readJson(metadataPath);
  const redCommit = String(bug.redCommit || metadata.red_commit || '');
  const proofCommit = String(metadata.verification_evidence?.pre_fix?.source_commit || '');
  if (!/^[a-f0-9]{40}$/i.test(redCommit) || !proofCommit || proofCommit === redCommit) {
    throw new Error(`Bug ${bug.bugIndex} 不是可恢复的 red proof 提交错配`);
  }
  delete bug.disposition;
  delete bug.deliveredAt;
  delete bug.failureDisposition;
  for (const stage of job.stages || []) {
    if (Number(stage.bugIndex) !== Number(bug.bugIndex)) continue;
    const suffix = String(stage.id || '').replace(`bug${bug.bugIndex}_`, '');
    if (['pre_verify', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready'].includes(suffix)) resetStage(stage);
  }
  if (metadata.verification_evidence?.pre_fix) delete metadata.verification_evidence.pre_fix;
  delete metadata.verify_result;
  await writeJsonAtomic(metadataPath, metadata);
  return { mode: 'proof_commit_mismatch', redCommit, proofCommit };
}

async function reopenMissingTest(job, bug) {
  reactivatePipelineBug(job, Number(bug.bugIndex));
  await prepareTrajectoryRetry(
    job,
    bug.task,
    '历史交付缺少独立 repository test；保留 Claude 诊断检查点，从 test_author 重新生成红测和交付证明。',
  );
  return { mode: 'missing_independent_test' };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const values = args.filter((value) => value !== '--apply');
  if (values.length < 2) throw new Error('用法：node scripts/reopen-incomplete-diagnosis-deliveries.mjs [--apply] <job.json> <bug-index> [...]');
  const jobFile = path.resolve(values[0]);
  const indexes = [...new Set(values.slice(1).map(Number))].sort((left, right) => left - right);
  if (indexes.some((index) => !Number.isInteger(index) || index < 1)) throw new Error('Bug 编号不合法');
  const job = await readJson(jobFile);
  if (['running', 'queued'].includes(job.status)) throw new Error(`${job.id} 正在运行，不能恢复历史交付`);
  if (job.request?.taskType !== 'diagnosis') throw new Error(`${job.id} 不是 diagnosis 流水线`);

  const planned = [];
  for (const index of indexes) {
    const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
    if (!bug?.task?.taskDir || bug.disposition !== 'delivered') throw new Error(`Bug ${index} 不是带任务目录的历史交付`);
    const metadata = await readJson(path.join(bug.task.taskDir, 'public.json'));
    const missingTest = !bug.verificationTestAuthor?.sourceDir
      || !bug.verificationTestAuthor?.testFile
      || !Array.isArray(metadata.verification_test_files)
      || metadata.verification_test_files.length === 0;
    const redCommit = String(bug.redCommit || metadata.red_commit || '');
    const proofCommit = String(metadata.verification_evidence?.pre_fix?.source_commit || '');
    if (missingTest) planned.push({ bugIndex: index, mode: 'missing_independent_test' });
    else if (redCommit && proofCommit && redCommit !== proofCommit) planned.push({ bugIndex: index, mode: 'proof_commit_mismatch', redCommit, proofCommit });
    else throw new Error(`Bug ${index} 的交付证明完整，禁止重开`);
  }
  if (!apply) {
    process.stdout.write(`${JSON.stringify({ apply, jobId: job.id, planned }, null, 2)}\n`);
    return;
  }

  const recovered = [];
  for (const plan of planned) {
    const bug = job.bugs.find((item) => Number(item.bugIndex) === plan.bugIndex);
    recovered.push({ bugIndex: plan.bugIndex, ...(plan.mode === 'missing_independent_test'
      ? await reopenMissingTest(job, bug)
      : await reopenProofMismatch(job, bug)) });
    enqueueBugRetry(job, plan.bugIndex);
  }
  const at = new Date().toISOString();
  const firstIndex = indexes[0];
  const execution = normalizeBugExecution({
    ...job.bugExecution,
    selectedBugIndex: firstIndex,
    status: 'fast_lane_queued',
    startedAt: null,
    currentAttempt: 0,
    blockedReason: '等待中央调度恢复不完整交付',
    lastAction: 'incomplete_delivery_recovery',
    updatedAt: at,
  });
  const stageId = nextPipelineStage({ ...job, currentStage: `bug${firstIndex}_test_author`, bugExecution: execution });
  const profile = pipelineStageResourceProfile(stageId);
  execution.currentStage = stageId;
  job.bugExecution = execution;
  job.status = 'waiting_resource';
  job.repositoryDisposition = 'partial';
  job.currentStage = stageId;
  job.error = '';
  job.finishedAt = null;
  job.runnerPid = null;
  job.schedulerLease = null;
  job.retryRequestedAt = at;
  job.manualRetryRequestedAt = at;
  job.updatedAt = at;
  job.waitingResource = {
    stageId,
    pool: profile.pool || 'general',
    limit: profile.limit || null,
    queuedAt: at,
    reason: 'incomplete_diagnosis_delivery_recovery',
  };
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId,
    message: `撤销不完整 diagnosis 交付并恢复：${recovered.map((item) => `Bug ${item.bugIndex} (${item.mode})`).join('、')}`,
  }].slice(-300);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${JSON.stringify({ apply, jobId: job.id, recovered, nextStage: stageId, queuedAt: at }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
