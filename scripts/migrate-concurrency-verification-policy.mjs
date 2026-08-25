#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelVerificationPlan } from '../src/model-verification.js';

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libraryRoot = process.env.GO_TASK_LIBRARY_ROOT
  || path.resolve(monitorRoot, '../.task_work/go-task-library');
const jobsRoot = path.join(libraryRoot, 'pipeline-jobs');
const backupRoot = path.join(libraryRoot, 'pipeline-refill/job-backups');
const migrationId = 'concurrency-verification-race-count20-v1';
const migratedAt = new Date().toISOString();

const targets = [
  {
    jobId: 'pipeline-20260823153352-803044df',
    bugIndex: 2,
    taskName: 'aircipher-sector-resync-bug2-concurrency-resources-1',
    successCriteria: "并发执行适配器脚本设置或重置与挑战发送或重试时必须正确同步，不能出现 fatal map panic，并保留现有脚本 Remaining 语义。确定性复现策略使用同步起跑屏障同时释放脚本控制与挑战发送协程，并按固定并发轮次核对成功次数和 Remaining 计数；执行 go test -race ./adapter -run '^TestModel_ScriptedAdapterConcurrentControlAndDispatch$' -count=20 -v，必须连续通过且不得报告竞态。",
    goldRootCause: "adapter/scripted.go、api/adapter_control.go、service/challenges.go、api/api.go 中的 adapter.Scripted 根本原因是控制接口并发调用 Set、SetByTerminal、Reset 修改共享脚本表时，SendChallenge 同时读取并删除 Remaining 条目；脚本表使用未加锁的 map，最终产生数据竞态、不稳定脚本结果或 fatal concurrent map writes。确定性复现策略由测试中的同步起跑屏障固定并发交错，再以 go test -race ./adapter -run '^TestModel_ScriptedAdapterConcurrentControlAndDispatch$' -count=20 -v 重复验证竞态消失和 Remaining 计数不变。",
  },
  {
    jobId: 'pipeline-20260823105248-15508c0f',
    bugIndex: 8,
    taskName: 'dnssec-rotation-closure-bug8-8',
    successCriteria: "租约获取必须在一次原子账簿调用中包含 HSM 槽位和所有冻结的权威服务器；第二个开放任务只要共享任一权威服务器就必须收到 ErrLeaseConflict，互不相关的资源行为保持不变。确定性复现策略采用固定资源裁定顺序：先让第一个轮换获取共享服务器租约，再让使用不同 HSM 槽但共享服务器的第二个轮换申请租约；执行 go test -race ./internal/service -run '^TestModel_AcquireLeasesRejectsSharedAuthoritativeServerAtomically$' -count=20 -v，每轮都必须得到相同冲突结果。",
    goldRootCause: "internal/service/rotation.go 中的 (*RotationService).AcquireLeases 根本原因是构造租约资源时只加入 HSM slot，没有把 rt.LockDigest.AuthoritativeServers 追加为 ResourceAuthoritativeServer；该缺陷最终导致两个使用不同 HSM 槽位但共享权威服务器的开放轮换会同时获取不完整租约并进入 signing，破坏服务器资源互斥。确定性复现策略使用固定资源裁定顺序验证共享服务器冲突，并以 go test -race ./internal/service -run '^TestModel_AcquireLeasesRejectsSharedAuthoritativeServerAtomically$' -count=20 -v 固定稳定性下限。",
  },
];

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function resetStage(stage) {
  stage.status = 'pending';
  stage.startedAt = null;
  stage.finishedAt = null;
  stage.error = '';
  delete stage.result;
  delete stage.taskId;
  delete stage.sessionId;
  delete stage.trajectoryUrl;
  delete stage.verificationResult;
}

async function migrateTarget(target) {
  const taskDir = path.join(libraryRoot, 'tasks', target.taskName);
  const publicPath = path.join(taskDir, 'public.json');
  const jobPath = path.join(jobsRoot, target.jobId, 'job.json');
  const jobBackupPath = path.join(backupRoot, `${target.jobId}.json`);
  const [metadata, job] = await Promise.all([readJson(publicPath), readJson(jobPath)]);
  const bug = job.bugs?.find((item) => Number(item.bugIndex) === target.bugIndex);
  if (!bug?.verificationTestAuthor?.sourceDir || !bug.verificationTestAuthor.testFile) {
    throw new Error(`${target.jobId} Bug ${target.bugIndex} 缺少冻结的独立回归测试`);
  }
  if (metadata.bug_category !== 'concurrency' || bug.discovery?.bug_category !== 'concurrency') {
    throw new Error(`${metadata.bug_id || target.taskName} 不是并发题，拒绝迁移`);
  }

  const sourcePath = path.join(bug.verificationTestAuthor.sourceDir, bug.verificationTestAuthor.testFile);
  const source = await fsp.readFile(sourcePath, 'utf8');
  const plan = buildModelVerificationPlan([{
    path: bug.verificationTestAuthor.testFile,
    content: source,
  }], { concurrency: true });
  const command = plan.verify_cmds[0];
  if (!/-race\b/.test(command) || !/-count=20\b/.test(command)) {
    throw new Error(`${metadata.bug_id || target.taskName} 未生成合格的并发验证命令`);
  }
  if (metadata.verification_policy_migration?.id === migrationId
    && metadata.verify_cmds?.[0] === command) {
    return {
      jobId: target.jobId,
      bugIndex: target.bugIndex,
      bugId: metadata.bug_id,
      command,
      skipped: true,
    };
  }

  const migrationBackupDir = path.join(
    libraryRoot,
    'pipeline-refill/migrations',
    migrationId,
    migratedAt.replaceAll(':', '-'),
    target.jobId,
  );
  await Promise.all([
    writeJsonAtomic(path.join(migrationBackupDir, 'public.before.json'), metadata),
    writeJsonAtomic(path.join(migrationBackupDir, 'job.before.json'), job),
  ]);

  const oldVerifyCmds = Array.isArray(metadata.verify_cmds) ? [...metadata.verify_cmds] : [];
  const oldEvidence = metadata.verification_evidence || {};
  Object.assign(metadata, {
    success_criteria: target.successCriteria,
    gold_root_cause: target.goldRootCause,
    verify_cmds: plan.verify_cmds,
    concurrency_verification: true,
    verification_repeat_count: plan.verification_repeat_count,
    verification_test_overlay: plan.verification_test_overlay,
    verification_test_files: plan.verification_test_files,
    verification_test_names: plan.verification_test_names,
    verification_test_manifest: plan.verification_test_manifest,
    model_verification_policy_version: plan.policy_version,
    verification_evidence: {},
    verification_policy_migration: {
      id: migrationId,
      migrated_at: migratedAt,
      previous_verify_cmds: oldVerifyCmds,
      reason: '并发题必须使用 go test -race -count=20 并记录确定性复现策略',
    },
  });
  delete metadata.verify_result;

  bug.discovery.success_criteria = target.successCriteria;
  bug.verificationTestAuthor.command = command;
  bug.verificationEvidenceHistory = [
    ...(Array.isArray(bug.verificationEvidenceHistory) ? bug.verificationEvidenceHistory : []),
    {
      migration_id: migrationId,
      archived_at: migratedAt,
      verify_cmds: oldVerifyCmds,
      evidence: bug.verificationEvidence || oldEvidence,
    },
  ].slice(-10);
  delete bug.verificationEvidence;
  delete bug.disposition;
  delete bug.deliveredAt;
  delete bug.failureDisposition;
  delete bug.trajectoryDisposition;
  bug.lastAction = 'concurrency_verification_policy_migrated';
  bug.workerExecution = {
    ...(bug.workerExecution || {}),
    status: 'fast_lane_queued',
    currentStage: `bug${target.bugIndex}_pre_verify`,
    startedAt: null,
    blockedReason: '等待重新采集 -race -count=20 红绿证明',
    lastAction: 'concurrency_verification_policy_migrated',
    updatedAt: migratedAt,
  };

  for (const stage of job.stages || []) {
    if (stage.id === `bug${target.bugIndex}_test_author` && stage.result) {
      stage.result.command = command;
      stage.result.verify_cmds = plan.verify_cmds;
    }
    if ([
      `bug${target.bugIndex}_pre_verify`,
      `bug${target.bugIndex}_post_verify`,
      `bug${target.bugIndex}_cloud_upload`,
      `bug${target.bugIndex}_verification_finalize`,
      `bug${target.bugIndex}_delivery_ready`,
    ].includes(stage.id)) resetStage(stage);
  }

  job.status = 'stopped';
  job.currentStage = `bug${target.bugIndex}_pre_verify`;
  job.runnerPid = null;
  job.schedulerLease = null;
  job.waitingResource = null;
  job.finishedAt = migratedAt;
  job.updatedAt = migratedAt;
  job.error = `Bug ${target.bugIndex} 已迁移并发验证规则，等待重新采集红绿证明`;
  job.bugExecution = {
    ...(job.bugExecution || {}),
    selectedBugIndex: target.bugIndex,
    autoContinue: false,
    status: 'fast_lane_queued',
    startedAt: null,
    currentStage: `bug${target.bugIndex}_pre_verify`,
    blockedReason: '等待重新采集 -race -count=20 红绿证明',
    lastAction: 'concurrency_verification_policy_migrated',
    updatedAt: migratedAt,
  };
  job.logs = [...(job.logs || []), {
    at: migratedAt,
    level: 'warn',
    stageId: `bug${target.bugIndex}_pre_verify`,
    message: `Bug ${target.bugIndex} 的旧并发证明仅使用 -count=1，已归档并按 -race -count=20 规则重开`,
  }].slice(-300);

  await writeJsonAtomic(publicPath, metadata);
  await writeJsonAtomic(jobPath, job);
  await writeJsonAtomic(jobBackupPath, job);
  return { jobId: target.jobId, bugIndex: target.bugIndex, bugId: metadata.bug_id, command };
}

const migrated = [];
for (const target of targets) migrated.push(await migrateTarget(target));
process.stdout.write(`${JSON.stringify({ migrationId, migratedAt, migrated }, null, 2)}\n`);
