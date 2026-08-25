#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createSerializedJsonWriter, MAX_PIPELINE_CONCURRENCY, runWorkerPool } from '../src/pipeline-concurrency.js';
import { DEFAULT_BUG_COUNT } from '../src/pipeline-rules.js';

const apiBase = String(process.env.GO_TASK_MONITOR_API_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');
const pollIntervalMs = Number(process.env.GO_PIPELINE_BATCH_POLL_MS || 15_000);
const maxPipelineRetries = Number(process.env.GO_PIPELINE_BATCH_RETRIES || 2);
const requestedBatchConcurrency = Number(process.env.GO_PIPELINE_BATCH_CONCURRENCY || MAX_PIPELINE_CONCURRENCY);
const batchConcurrency = Number.isInteger(requestedBatchConcurrency)
  ? Math.min(MAX_PIPELINE_CONCURRENCY, Math.max(1, requestedBatchConcurrency))
  : MAX_PIPELINE_CONCURRENCY;

function now() {
  return new Date().toISOString();
}

function log(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: now(), event, ...detail })}\n`);
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function api(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
  try {
    const response = await fetch(`${apiBase}${pathname}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} 返回 ${response.status}：${payload.message || JSON.stringify(payload)}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listJobs() {
  return (await api('/api/pipeline/jobs')).jobs || [];
}

async function createDrafts(specs, manifest, writeManifest) {
  let jobs = await listJobs();
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const bugCount = Number(spec.bugCount ?? DEFAULT_BUG_COUNT);
    const recorded = manifest.jobs.find((item) => item.key === spec.key);
    let job = recorded ? jobs.find((item) => item.id === recorded.jobId) : null;
    job ||= jobs.find((item) => item.request?.projectBrief === spec.projectBrief);
    if (!job) {
      log('draft_create_start', { index: index + 1, total: specs.length, key: spec.key, taskType: spec.taskType });
      const created = await api('/api/pipeline/jobs', {
        method: 'POST',
        body: {
          projectBrief: spec.projectBrief,
          bugCount,
          taskType: spec.taskType,
          maxTrajectoryAttempts: 3,
          creator: 'niuyuhang',
        },
      });
      job = created.job;
      jobs = [job, ...jobs];
      log('draft_created', { index: index + 1, key: spec.key, jobId: job.id, repository: job.request?.repository });
    } else {
      log('draft_reused', { index: index + 1, key: spec.key, jobId: job.id, repository: job.request?.repository });
    }
    const entry = {
      index: index + 1,
      key: spec.key,
      taskType: spec.taskType,
      bugCount,
      jobId: job.id,
      repository: job.request?.repository || '',
      status: job.status,
      retries: recorded?.retries || 0,
    };
    manifest.jobs = manifest.jobs.filter((item) => item.key !== spec.key);
    manifest.jobs.push(entry);
    manifest.jobs.sort((a, b) => a.index - b.index);
    manifest.updatedAt = now();
    await writeManifest(manifest);
  }
}

async function waitForTerminal(jobId, previousStage = '') {
  let lastStage = previousStage;
  let lastHeartbeat = 0;
  while (true) {
    const job = (await listJobs()).find((item) => item.id === jobId);
    if (!job) throw new Error(`流水线作业不存在：${jobId}`);
    if (job.currentStage !== lastStage || Date.now() - lastHeartbeat >= 60_000) {
      const current = job.stages?.find((stage) => stage.id === job.currentStage);
      log('pipeline_progress', {
        jobId,
        repository: job.request?.repository,
        status: job.status,
        stage: job.currentStage || '',
        stageLabel: current?.label || '',
        passedStages: job.stages?.filter((stage) => stage.status === 'passed').length || 0,
        totalStages: job.stages?.length || 0,
      });
      lastStage = job.currentStage;
      lastHeartbeat = Date.now();
    }
    if (['passed', 'failed', 'stopped'].includes(job.status) && !job.processActive) return job;
    await sleep(pollIntervalMs);
  }
}

async function runEntry(entry, manifest, writeManifest) {
  let job = (await listJobs()).find((item) => item.id === entry.jobId);
  if (!job) throw new Error(`批次记录对应的作业不存在：${entry.jobId}`);
  if (job.status === 'passed') {
    entry.status = 'passed';
    log('pipeline_already_passed', { index: entry.index, jobId: entry.jobId, repository: entry.repository });
    await writeManifest(manifest);
    return job;
  }
  while (true) {
    if (job.processActive) {
      entry.status = 'running';
      await writeManifest(manifest);
      log('pipeline_attached', { index: entry.index, jobId: entry.jobId, repository: entry.repository, stage: job.currentStage || '' });
      job = await waitForTerminal(entry.jobId, job.currentStage);
    } else {
      const action = ['failed', 'stopped'].includes(job.status) ? 'retry' : 'start';
      if (action === 'retry') {
        if (entry.retries >= maxPipelineRetries) throw new Error(`${entry.jobId} 已达到批次级重试上限 ${maxPipelineRetries}：${job.error || 'unknown error'}`);
        entry.retries += 1;
      }
      entry.status = action === 'retry' ? 'retrying' : 'starting';
      manifest.updatedAt = now();
      await writeManifest(manifest);
      log('pipeline_start', { index: entry.index, total: manifest.jobs.length, jobId: entry.jobId, repository: entry.repository, action, retry: entry.retries });
      await api(`/api/pipeline/jobs/${encodeURIComponent(entry.jobId)}/${action}`, { method: 'POST' });
      job = await waitForTerminal(entry.jobId, job.currentStage);
    }
    entry.status = job.status;
    entry.error = job.error || '';
    entry.finishedAt = job.finishedAt || null;
    manifest.updatedAt = now();
    await writeManifest(manifest);
    if (job.status === 'passed') {
      log('pipeline_passed', { index: entry.index, jobId: entry.jobId, repository: entry.repository, finishedAt: job.finishedAt });
      return job;
    }
    log('pipeline_failed', { index: entry.index, jobId: entry.jobId, repository: entry.repository, error: job.error, retry: entry.retries });
  }
}

async function runJobs(manifest, writeManifest, concurrency = batchConcurrency) {
  const entries = [...manifest.jobs].sort((a, b) => a.index - b.index);
  const results = await runWorkerPool(entries, concurrency, (entry) => runEntry(entry, manifest, writeManifest));
  const failures = results
    .map((result, index) => ({ result, entry: entries[index] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, entry } of failures) {
    entry.status = 'failed';
    entry.error = result.reason?.message || String(result.reason);
    log('pipeline_abandoned', { index: entry.index, jobId: entry.jobId, repository: entry.repository, error: entry.error });
  }
  if (failures.length) await writeManifest(manifest);
  return failures;
}

async function main(args = process.argv.slice(2)) {
  if (args.length < 1 || args.length > 2) throw new Error('用法：node scripts/run-pipeline-batch.mjs <batch.json> [manifest.json]');
  const specPath = path.resolve(args[0]);
  const manifestPath = path.resolve(args[1] || path.join(path.dirname(specPath), `${path.basename(specPath, '.json')}.manifest.json`));
  const specs = await readJson(specPath);
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('批次清单必须是非空数组');
  const keys = new Set();
  for (const spec of specs) {
    if (!spec?.key || keys.has(spec.key)) throw new Error(`批次 key 缺失或重复：${spec?.key || '(empty)'}`);
    if (!['bugfix', 'diagnosis'].includes(spec.taskType)) throw new Error(`${spec.key} 的 taskType 不合法`);
    const bugCount = Number(spec.bugCount ?? DEFAULT_BUG_COUNT);
    if (!Number.isInteger(bugCount) || bugCount < 1 || bugCount > 5) throw new Error(`${spec.key} 的 bugCount 必须是 1-5 的整数`);
    if (String(spec.projectBrief || '').trim().length < 20) throw new Error(`${spec.key} 的 projectBrief 少于 20 字符`);
    keys.add(spec.key);
  }
  const manifest = await readJson(manifestPath, { batch: path.basename(specPath), createdAt: now(), updatedAt: now(), jobs: [] });
  const writeManifest = createSerializedJsonWriter(manifestPath);
  log('batch_start', { specs: specs.length, manifestPath, apiBase, concurrency: batchConcurrency });
  await createDrafts(specs, manifest, writeManifest);
  log('drafts_ready', { count: manifest.jobs.length, repositories: manifest.jobs.map((item) => item.repository) });
  manifest.status = 'running';
  manifest.updatedAt = now();
  await writeManifest(manifest);
  const failures = await runJobs(manifest, writeManifest);
  if (failures.length) {
    manifest.status = 'failed';
    manifest.updatedAt = now();
    await writeManifest(manifest);
    throw new AggregateError(failures.map(({ result }) => result.reason), `${failures.length} 个流水线作业在重试后仍失败`);
  }
  manifest.status = 'passed';
  manifest.finishedAt = now();
  manifest.updatedAt = manifest.finishedAt;
  await writeManifest(manifest);
  log('batch_passed', { count: manifest.jobs.length, manifestPath });
}

main().catch((error) => {
  log('batch_failed', { error: error.stack || error.message });
  process.exitCode = 1;
});
