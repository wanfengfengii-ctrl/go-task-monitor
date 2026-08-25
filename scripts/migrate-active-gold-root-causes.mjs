#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { discoveryRootCauseDescriptor } from './run-production-pipeline.mjs';

const jobsRoot = path.resolve(process.argv[2]
  || process.env.GO_PIPELINE_JOBS_ROOT
  || '/Users/niuyuhang/Documents/New project/.task_work/go-task-library/pipeline-jobs');
const activeStatuses = new Set(['running', 'queued', 'waiting']);

async function readJson(filename, fallback = null) {
  return fsp.readFile(filename, 'utf8').then(JSON.parse).catch(() => fallback);
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

const summary = { jobs: 0, tasks: 0, changed: 0, unchanged: 0, skipped: [] };
for (const entry of await fsp.readdir(jobsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const job = await readJson(path.join(jobsRoot, entry.name, 'job.json'));
  if (!job || !activeStatuses.has(job.status)) continue;
  summary.jobs += 1;

  for (const bug of job.bugs || []) {
    if (!bug.task?.taskDir || !bug.discovery?.found) continue;
    summary.tasks += 1;
    const publicPath = path.join(bug.task.taskDir, 'public.json');
    const current = await readJson(publicPath);
    if (!current) {
      summary.skipped.push({ job: entry.name, bug: bug.bugIndex, reason: 'public.json 不存在' });
      continue;
    }
    if (String(current.pipeline_job_id || '') !== String(job.id)
      || Number(current.bug_index) !== Number(bug.bugIndex)) {
      summary.skipped.push({ job: entry.name, bug: bug.bugIndex, reason: '任务归属不匹配' });
      continue;
    }

    const rootCause = discoveryRootCauseDescriptor(bug.discovery).gold_root_cause;
    if (current.gold_root_cause === rootCause) {
      summary.unchanged += 1;
      continue;
    }

    // Re-read immediately before the atomic replacement so proof or upload
    // fields written earlier in the pipeline are retained.
    const latest = await readJson(publicPath);
    if (!latest) {
      summary.skipped.push({ job: entry.name, bug: bug.bugIndex, reason: 'public.json 在迁移期间消失' });
      continue;
    }
    latest.gold_root_cause = rootCause;
    await writeJsonAtomic(publicPath, latest);
    summary.changed += 1;
  }
}

console.log(JSON.stringify(summary, null, 2));
