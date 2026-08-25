#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DISTRIBUTED_WORKER_PROTOCOL_VERSION,
  hydrateRemoteRepairJob,
} from '../src/distributed-workers.js';

const execFileAsync = promisify(execFile);
const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controllerUrl = String(process.env.GO_TASK_MONITOR_API_URL || '').replace(/\/+$/, '');
const workerToken = String(process.env.GO_PIPELINE_WORKER_TOKEN || '').trim();
const workerId = String(process.env.GO_PIPELINE_WORKER_ID || `${os.hostname()}-repair`).trim();
const workerRoot = path.resolve(process.env.GO_PIPELINE_WORKER_ROOT || path.join(monitorRoot, '.task_work', 'remote-repair-worker'));
const pollIntervalMs = Math.max(2_000, Number(process.env.GO_PIPELINE_WORKER_POLL_INTERVAL_MS || 10_000));
const heartbeatIntervalMs = Math.max(5_000, Number(process.env.GO_PIPELINE_WORKER_HEARTBEAT_INTERVAL_MS || 15_000));
const snapshotIntervalMs = Math.max(2_000, Number(process.env.GO_PIPELINE_WORKER_SNAPSHOT_INTERVAL_MS || 5_000));
const pipelineRunnerPath = path.join(monitorRoot, 'scripts', 'run-production-pipeline.mjs');
const jobsRoot = path.join(workerRoot, 'go-task-library', 'pipeline-jobs');
const tasksRoot = path.join(workerRoot, 'go-task-library', 'tasks');
const stopState = { requested: false, child: null };

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function validateConfiguration() {
  if (!/^https?:\/\//i.test(controllerUrl)) throw new Error('GO_TASK_MONITOR_API_URL 必须是 A 电脑的 HTTP(S) API 地址');
  if (workerToken.length < 32) throw new Error('GO_PIPELINE_WORKER_TOKEN 必须与 A 电脑一致且至少 32 字符');
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(workerId)) throw new Error('GO_PIPELINE_WORKER_ID 格式不合法');
  const protectionRoot = path.dirname(workerRoot);
  if (protectionRoot === path.parse(protectionRoot).root || protectionRoot === path.resolve(os.homedir())) {
    throw new Error('GO_PIPELINE_WORKER_ROOT 必须位于专用运行目录的下一层，不能直接放在文件系统根目录或用户主目录下');
  }
}

async function validateRuntimeCommands() {
  const required = ['git', 'tar', 'bash', 'jq', 'rsync', 'go', 'docker'];
  required.push(process.env.GO_PIPELINE_CLAUDE_BIN || 'claude');
  required.push(process.env.GO_PIPELINE_CODEX_BIN || 'codex');
  if (process.platform === 'linux') required.push('bwrap');
  const missing = [];
  for (const command of required) {
    try {
      if (path.isAbsolute(command)) await fsp.access(command, fs.constants.X_OK);
      else await execFileAsync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'worker-preflight', command], { timeout: 10_000 });
    } catch {
      missing.push(command);
    }
  }
  if (missing.length) throw new Error(`B 电脑缺少运行依赖：${missing.join('、')}`);
}

async function codeVersion() {
  if (process.env.GO_PIPELINE_RELEASE_ID) return String(process.env.GO_PIPELINE_RELEASE_ID);
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: monitorRoot, timeout: 15_000 });
    return String(result.stdout || '').trim();
  } catch {
    return 'unknown';
  }
}

async function apiJson(pathname, { method = 'GET', body = null, timeoutMs = 2 * 60_000 } = {}) {
  const response = await fetch(`${controllerUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${workerToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `A 电脑 API 请求失败（HTTP ${response.status}）`);
    error.code = payload.code || `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function workerEnvelope(version, extra = {}) {
  return {
    workerId,
    role: 'repair-worker',
    protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
    hostname: os.hostname(),
    platform: `${process.platform}/${process.arch}`,
    codeVersion: version,
    ...extra,
  };
}

async function runGit(args, cwd = monitorRoot) {
  try {
    return await execFileAsync('git', args, { cwd, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    const detail = `${error.stderr || ''}\n${error.stdout || ''}`.trim().slice(-2000);
    throw new Error(`Git ${args[0]} 失败${detail ? `：${detail}` : ''}`);
  }
}

async function checkoutAt(directory, cloneUrl, commit) {
  const currentHead = await runGit(['rev-parse', 'HEAD'], directory).then((result) => String(result.stdout).trim()).catch(() => '');
  if (currentHead === commit) return;
  const parent = path.dirname(directory);
  await fsp.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(directory)}-${crypto.randomUUID()}`);
  await fsp.rm(temporary, { recursive: true, force: true });
  await runGit(['clone', '--quiet', '--no-checkout', cloneUrl, temporary], parent);
  try {
    await runGit(['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'], temporary);
    await runGit(['switch', '--detach', commit], temporary);
    const resolved = String((await runGit(['rev-parse', 'HEAD'], temporary)).stdout || '').trim();
    if (resolved !== commit) throw new Error(`Git checkout 提交不匹配：需要 ${commit}，得到 ${resolved}`);
    const previous = `${directory}.previous`;
    await fsp.rm(previous, { recursive: true, force: true });
    if (await fsp.stat(directory).catch(() => null)) await fsp.rename(directory, previous);
    try {
      await fsp.rename(temporary, directory);
      await fsp.rm(previous, { recursive: true, force: true });
    } catch (error) {
      if (await fsp.stat(previous).catch(() => null)) await fsp.rename(previous, directory).catch(() => {});
      throw error;
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeJsonAtomic(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function packageRequestHeaders(assignment) {
  return {
    authorization: `Bearer ${workerToken}`,
    'x-go-pipeline-worker-id': workerId,
    'x-go-pipeline-worker-protocol': String(DISTRIBUTED_WORKER_PROTOCOL_VERSION),
    'x-go-pipeline-lease-id': assignment.leaseId,
  };
}

async function restoreTaskCheckpoint(assignment, taskName) {
  const target = path.join(tasksRoot, taskName);
  if (await fsp.stat(target).catch(() => null)) return { restored: false, reason: 'local-checkpoint-exists' };
  const response = await fetch(
    `${controllerUrl}/api/pipeline/workers/jobs/${encodeURIComponent(assignment.job.id)}/tasks/${encodeURIComponent(taskName)}/package`,
    {
      method: 'GET',
      headers: packageRequestHeaders(assignment),
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );
  if (response.status === 404) return { restored: false, reason: 'controller-checkpoint-missing' };
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || `远程任务检查点下载失败（HTTP ${response.status}）`);
  }
  const restoreRoot = await fsp.mkdtemp(path.join(workerRoot, 'task-restore-'));
  const archivePath = path.join(restoreRoot, 'task.tar.gz');
  const extractedRoot = path.join(restoreRoot, 'extracted');
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archivePath, { mode: 0o600 }));
    await fsp.mkdir(extractedRoot, { recursive: true });
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractedRoot], { cwd: restoreRoot, timeout: 20 * 60_000 });
    const restoredTask = path.join(extractedRoot, taskName);
    if (!await fsp.stat(path.join(restoredTask, 'public.json')).catch(() => null)) throw new Error('A 电脑任务检查点缺少 public.json');
    await fsp.rename(restoredTask, target);
    return { restored: true };
  } finally {
    await fsp.rm(restoreRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function uploadTaskCheckpoint(assignment, task) {
  const taskDir = String(task?.taskDir || '');
  const taskName = String(task?.taskName || '');
  if (!taskDir || !taskName || !await fsp.stat(path.join(taskDir, 'public.json')).catch(() => null)) return { uploaded: false };
  const archiveRoot = await fsp.mkdtemp(path.join(workerRoot, 'task-upload-'));
  const archivePath = path.join(archiveRoot, `${taskName}.tar.gz`);
  try {
    await execFileAsync('tar', [
      '-czf', archivePath,
      '--exclude=.verification-cache',
      '--exclude=node_modules',
      '-C', path.dirname(taskDir),
      taskName,
    ], { cwd: path.dirname(taskDir), timeout: 20 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    const stat = await fsp.stat(archivePath);
    const response = await fetch(
      `${controllerUrl}/api/pipeline/workers/jobs/${encodeURIComponent(assignment.job.id)}/tasks/${encodeURIComponent(taskName)}/package`,
      {
        method: 'PUT',
        headers: {
          ...packageRequestHeaders(assignment),
          'content-type': 'application/gzip',
          'content-length': String(stat.size),
        },
        body: fs.createReadStream(archivePath),
        duplex: 'half',
        signal: AbortSignal.timeout(30 * 60_000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `远程任务检查点上传失败（HTTP ${response.status}）`);
    return { uploaded: true, bytes: stat.size };
  } finally {
    await fsp.rm(archiveRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const durableCheckpointStages = new Set([
  'task_prepare',
  'claude_fix',
  'trajectory_validate',
  'test_author',
  'pre_verify',
  'post_verify',
  'docker_validation',
  'git_publication',
  'verification_finalize',
  'delivery_ready',
]);

async function syncChangedTaskCheckpoints(assignment, job, signatures, { force = false } = {}) {
  for (const bug of job.bugs || []) {
    if (!bug.task?.taskName) continue;
    const stages = (job.stages || []).filter((stage) => Number(stage.bugIndex) === Number(bug.bugIndex)
      && durableCheckpointStages.has(String(stage.stage || String(stage.id || '').replace(/^bug\d+_/, '')))
      && ['passed', 'failed'].includes(stage.status));
    const signature = stages.map((stage) => `${stage.id}:${stage.status}:${stage.finishedAt || ''}`).join('|');
    if (!force && (!signature || signatures.get(Number(bug.bugIndex)) === signature)) continue;
    await uploadTaskCheckpoint(assignment, bug.task);
    signatures.set(Number(bug.bugIndex), signature);
  }
}

async function prepareAssignment(assignment) {
  const remoteJob = assignment.job;
  const jobDir = path.join(jobsRoot, remoteJob.id);
  const projectDir = path.join(jobDir, 'project');
  await fsp.mkdir(jobDir, { recursive: true });
  await fsp.mkdir(tasksRoot, { recursive: true });
  await checkoutAt(projectDir, remoteJob.request.cloneUrl, remoteJob.mainCommit);
  for (const bug of remoteJob.bugs || []) {
    if (!bug.bugBaseCommit || bug.disposition === 'skipped') continue;
    await checkoutAt(path.join(jobDir, `bug-base-bug${Number(bug.bugIndex)}`), remoteJob.request.cloneUrl, bug.bugBaseCommit);
  }
  for (const bug of remoteJob.bugs || []) {
    if (bug.task?.taskName) await restoreTaskCheckpoint(assignment, bug.task.taskName);
  }
  const localJob = hydrateRemoteRepairJob(remoteJob, { jobDir, tasksRoot });
  const jobFile = path.join(jobDir, 'job.json');
  await writeJsonAtomic(jobFile, localJob);
  return { jobFile, jobDir, localJob };
}

async function readJob(jobFile) {
  return JSON.parse(await fsp.readFile(jobFile, 'utf8'));
}

async function pushSnapshot(version, assignment, jobFile) {
  const job = await readJob(jobFile);
  return apiJson(`/api/pipeline/workers/jobs/${encodeURIComponent(job.id)}/snapshot`, {
    method: 'PUT',
    body: workerEnvelope(version, { leaseId: assignment.leaseId, job }),
  });
}

async function heartbeat(version, assignment) {
  return apiJson(`/api/pipeline/workers/jobs/${encodeURIComponent(assignment.job.id)}/heartbeat`, {
    method: 'POST',
    body: workerEnvelope(version, { leaseId: assignment.leaseId }),
  });
}

function stopChild(reason) {
  const child = stopState.child;
  if (!child || !child.pid) return;
  log(`停止远程 Runner ${child.pid}：${reason}`);
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
}

async function completeAssignment(version, assignment, jobFile, outcome) {
  const job = await readJob(jobFile).catch(() => assignment.job);
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      return await apiJson(`/api/pipeline/workers/jobs/${encodeURIComponent(assignment.job.id)}/complete`, {
        method: 'POST',
        body: workerEnvelope(version, { leaseId: assignment.leaseId, outcome, job }),
      });
    } catch (error) {
      lastError = error;
      if (error.code === 'REMOTE_LEASE_LOST') throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, attempt * 3_000)));
    }
  }
  throw lastError;
}

async function executeAssignment(version, assignment) {
  log(`领取 ${assignment.job.id}，从 ${assignment.job.currentStage} 开始远程修复`);
  const { jobFile } = await prepareAssignment(assignment);
  const child = spawn(process.execPath, [pipelineRunnerPath, jobFile], {
    cwd: monitorRoot,
    env: {
      ...process.env,
      GO_PIPELINE_EXECUTION_ROLE: 'repair-worker',
      GO_PIPELINE_WORKER_ID: workerId,
      GO_PIPELINE_WORKER_TOKEN: workerToken,
      GO_PIPELINE_REMOTE_LEASE_ID: assignment.leaseId,
      GO_TASK_MONITOR_API_URL: controllerUrl,
      GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'local',
    },
    stdio: 'inherit',
    detached: true,
  });
  stopState.child = child;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
  let cancelled = false;
  let leaseLost = false;
  let heartbeatBusy = false;
  let snapshotBusy = false;
  const taskCheckpointSignatures = new Map();
  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    heartbeat(version, assignment)
      .then((result) => {
        if (result.cancelRequested) {
          cancelled = true;
          stopChild(result.cancelReason || 'A 电脑请求停止');
        }
      })
      .catch((error) => {
        if (error.code === 'REMOTE_LEASE_LOST') {
          leaseLost = true;
          stopChild('远程租约已失效');
        } else log(`心跳暂时失败：${error.message}`);
      })
      .finally(() => { heartbeatBusy = false; });
  }, heartbeatIntervalMs);
  const snapshotTimer = setInterval(() => {
    if (snapshotBusy) return;
    snapshotBusy = true;
    pushSnapshot(version, assignment, jobFile)
      .then(async () => syncChangedTaskCheckpoints(assignment, await readJob(jobFile), taskCheckpointSignatures))
      .catch((error) => {
        if (error.code === 'REMOTE_CANCEL_REQUESTED') {
          cancelled = true;
          stopChild(error.message);
        } else if (error.code === 'REMOTE_LEASE_LOST') {
          leaseLost = true;
          stopChild(error.message);
        } else log(`状态同步暂时失败：${error.message}`);
      })
      .finally(() => { snapshotBusy = false; });
  }, snapshotIntervalMs);
  let result;
  try {
    await pushSnapshot(version, assignment, jobFile).catch((error) => log(`初始状态同步暂时失败：${error.message}`));
    result = await exitPromise;
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(snapshotTimer);
  }
  stopState.child = null;
  const finalJob = await readJob(jobFile).catch(() => null);
  if (!leaseLost && finalJob) {
    await syncChangedTaskCheckpoints(assignment, finalJob, taskCheckpointSignatures, { force: true })
      .catch((error) => log(`最终任务检查点同步失败：${error.message}`));
  }
  const outcome = cancelled ? 'stopped' : result.code === 0 && finalJob?.status === 'passed' ? 'passed' : 'failed';
  if (!leaseLost) await completeAssignment(version, assignment, jobFile, outcome);
  log(`${assignment.job.id} 远程 Runner 结束：${outcome}（exit=${result.code ?? 'none'} signal=${result.signal || 'none'}）`);
}

async function main() {
  validateConfiguration();
  await validateRuntimeCommands();
  await fsp.mkdir(workerRoot, { recursive: true });
  const version = await codeVersion();
  await apiJson('/api/pipeline/workers/register', {
    method: 'POST',
    body: workerEnvelope(version),
  });
  log(`repair-worker ${workerId} 已连接 A 电脑，协议 V${DISTRIBUTED_WORKER_PROTOCOL_VERSION}，代码 ${version}`);
  while (!stopState.requested) {
    try {
      const payload = await apiJson('/api/pipeline/workers/claim', {
        method: 'POST',
        body: workerEnvelope(version),
      });
      if (payload.assignment) await executeAssignment(version, payload.assignment);
      else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      log(`Worker 循环暂时失败：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopState.requested = true;
    stopChild(signal);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
