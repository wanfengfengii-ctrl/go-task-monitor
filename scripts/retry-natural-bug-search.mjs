#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

function usage() {
  throw new Error('用法：node scripts/retry-natural-bug-search.mjs <job.json> [--retain-prepared]');
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
  delete stage.reason;
  delete stage.result;
  delete stage.reviewStartedAt;
}

const args = process.argv.slice(2);
if (!args[0]) usage();
const jobFile = path.resolve(args[0]);
const retainPrepared = args.includes('--retain-prepared');
const jobDir = path.dirname(jobFile);
const job = JSON.parse(await fsp.readFile(jobFile, 'utf8'));
if (['running', 'queued'].includes(String(job.status || ''))) {
  throw new Error(`${job.id} 仍在运行，必须先通过监控服务正常停止 Runner`);
}

const preparedIndexes = new Set(retainPrepared
  ? (job.bugs || [])
    .filter((bug) => {
      const discovery = (job.stages || []).find((stage) => stage.id === `bug${bug.bugIndex}_bug_discovery`);
      const source = (job.stages || []).find((stage) => stage.id === `bug${bug.bugIndex}_bug_source_prepare`);
      return discovery?.status === 'passed'
        && source?.status === 'passed'
        && bug?.discovery?.found === true
        && Boolean(bug?.bugBaseCommit)
        && Boolean(bug?.bugBaseDir);
    })
    .map((bug) => Number(bug.bugIndex))
  : []);
const retryIndexes = Array.from({ length: Number(job.request?.bugCount || 0) }, (_, index) => index + 1)
  .filter((bugIndex) => !preparedIndexes.has(bugIndex));
if (!retryIndexes.length) throw new Error(`${job.id} 没有可重新搜索的 Bug 槽位`);

const migratedAt = new Date().toISOString();
const timestamp = migratedAt.replace(/[:.]/g, '-');
const historyDir = path.join(jobDir, 'history', `natural-search-recovery-${timestamp}`);
await fsp.mkdir(historyDir, { recursive: true });
await fsp.copyFile(jobFile, path.join(historyDir, 'job.before.json'));
await writeJsonAtomic(path.join(historyDir, 'selection.before.json'), {
  migratedAt,
  retainedPreparedBugIndexes: [...preparedIndexes].sort((left, right) => left - right),
  retryBugIndexes: retryIndexes,
  naturalBugBatch: job.naturalBugBatch || null,
  injectionPlan: job.injectionPlan || null,
});

job.bugs = (job.bugs || []).filter((bug) => preparedIndexes.has(Number(bug.bugIndex)));
for (const bug of job.bugs) {
  delete bug.workerExecution;
  delete bug.disposition;
  delete bug.failureDisposition;
  delete bug.firstFailure;
  delete bug.lastFailure;
}

for (const stage of job.stages || []) {
  const bugIndex = Number(stage.bugIndex);
  if (!Number.isInteger(bugIndex)) continue;
  if (!preparedIndexes.has(bugIndex)) {
    resetStage(stage);
    continue;
  }
  if (stage.stage === 'bug_discovery' || stage.stage === 'bug_source_prepare') continue;
  if (!['passed', 'skipped'].includes(stage.status)) resetStage(stage);
}

const publishStage = (job.stages || []).find((stage) => stage.id === 'main_publish');
if (publishStage && publishStage.status !== 'pending') resetStage(publishStage);

job.naturalBugRecoveryHistory = [...(job.naturalBugRecoveryHistory || []), {
  migratedAt,
  historyDir,
  retainedPreparedBugIndexes: [...preparedIndexes].sort((left, right) => left - right),
  retryBugIndexes: retryIndexes,
  previousNaturalBugBatchKey: job.naturalBugBatch?.key || '',
  previousInjectionPlanKey: job.injectionPlan?.key || '',
}].slice(-20);
delete job.naturalBugBatch;
delete job.injectionPlan;
delete job.injectionReviewPending;
delete job.pendingFatalFailure;
delete job.waitingResource;
delete job.schedulerLease;
delete job.manualRetryRequestedAt;
delete job.retryRequestedAt;
delete job.finishedAt;
job.naturalBugOnly = true;
job.naturalBugRetryNonce = `${Date.now()}-${crypto.randomUUID()}`;
job.bugSearch = {
  ...(job.bugSearch || {}),
  mode: 'natural_only_recovery',
  retainedPreparedBugIndexes: [...preparedIndexes].sort((left, right) => left - right),
  retryBugIndexes: retryIndexes,
  restartedAt: migratedAt,
};
job.status = 'stopped';
job.currentStage = `bug${retryIndexes[0]}_bug_discovery`;
job.error = '';
job.runnerPid = null;
job.autoRetryCount = 0;
job.updatedAt = migratedAt;
job.bugExecution = {
  ...(job.bugExecution || {}),
  selectedBugIndex: null,
  status: 'bug_ready',
  startedAt: null,
  currentStage: job.currentStage,
  currentAttempt: 0,
  blockedReason: '',
  lastAction: 'natural_bug_search_recovery',
  updatedAt: migratedAt,
};
job.logs = [...(job.logs || []), {
  at: migratedAt,
  level: 'info',
  stageId: job.currentStage,
  message: `保留项目与已通过 BUG_BASE，重新执行自然 Bug 批量搜索；保留槽位 ${[...preparedIndexes].join('、') || '无'}，重搜槽位 ${retryIndexes.join('、')}，本轮禁止自动注入`,
}].slice(-300);

await writeJsonAtomic(jobFile, job);
process.stdout.write(`${JSON.stringify({
  jobId: job.id,
  historyDir,
  retainedPreparedBugIndexes: [...preparedIndexes].sort((left, right) => left - right),
  retryBugIndexes: retryIndexes,
  currentStage: job.currentStage,
}, null, 2)}\n`);
