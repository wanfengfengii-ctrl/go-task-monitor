#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  finalizeV3DiagnosisImmutableDelivery,
  finalizeVerificationResult,
  persistVerificationManifest,
} from './run-production-pipeline.mjs';

const execFileAsync = promisify(execFile);
const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libraryRoot = path.resolve(process.env.GO_TASK_LIBRARY_ROOT
  || path.join(monitorRoot, '..', '.task_work', 'go-task-library'));
const tasksRoot = path.join(libraryRoot, 'tasks');
const jobsRoot = path.join(libraryRoot, 'pipeline-jobs');
const platformRecordsPath = path.join(libraryRoot, 'validation', 'platform_submissions.json');
const apiBase = String(process.env.GO_PIPELINE_MONITOR_API_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');
const verificationRunner = path.join(monitorRoot, 'run_verify_claude.sh');

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch (error) {
    if (fallback !== null && error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

async function taskByBugId(bugId) {
  for (const entry of await fsp.readdir(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(tasksRoot, entry.name);
    const metadata = await readJson(path.join(taskDir, 'public.json')).catch(() => null);
    if (metadata?.bug_id === bugId) return { taskDir, metadata };
  }
  throw new Error(`${bugId} 不存在于任务库`);
}

async function restoreDiagnosisReadmesFromSource(taskDir, repository, sourceCommit) {
  if (!/^[a-f0-9]{40}$/i.test(String(sourceCommit || ''))) return [];
  const sourceReadme = await execFileAsync(
    'git',
    ['-C', repository, 'show', `${sourceCommit}:BENZHI_README.md`],
    { encoding: 'buffer', timeout: 2 * 60_000, maxBuffer: 2 * 1024 * 1024 },
  ).then((result) => result.stdout).catch(() => null);
  if (!sourceReadme) return [];
  const restored = [];
  for (const relative of ['pristine/BENZHI_README.md', 'workspace/BENZHI_README.md', '.git-layout/BENZHI_README.md']) {
    const filename = path.join(taskDir, relative);
    const stat = await fsp.stat(filename).catch(() => null);
    if (!stat) continue;
    const current = await fsp.readFile(filename);
    if (current.equals(sourceReadme)) continue;
    await fsp.chmod(filename, 0o644).catch(() => {});
    await fsp.writeFile(filename, sourceReadme);
    await fsp.chmod(filename, stat.mode & 0o777).catch(() => {});
    restored.push(relative);
  }
  return restored;
}

function taskId(taskName) {
  return `task-${crypto.createHash('sha256').update(`go-task-library/${taskName}`).digest('hex').slice(0, 16)}`;
}

async function postJson(route, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `${route} 返回 HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw lastError;
}

async function nextProofDirectory(taskDir) {
  const root = path.join(taskDir, 'verification', 'pre_fix');
  await fsp.mkdir(root, { recursive: true });
  const attempts = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('attempt-'.length)))
    .filter(Number.isInteger);
  return path.join(root, `attempt-${Math.max(0, ...attempts) + 1}`);
}

async function regenerateProof(taskDir, bugBaseDir) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const proofDir = await nextProofDirectory(taskDir);
    try {
      await execFileAsync('/bin/bash', [verificationRunner, taskDir, 'pre_fix', bugBaseDir, proofDir], {
        cwd: monitorRoot,
        timeout: 60 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GO_PIPELINE_MONITOR_ROOT: monitorRoot },
      });
      return { proofDir, manifest: await readJson(path.join(proofDir, 'manifest.json')) };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw lastError;
}

async function repairOne(bugId, platformRecords, { resubmit }) {
  const { taskDir, metadata: before } = await taskByBugId(bugId);
  if (before.task_type !== 'diagnosis') throw new Error(`${bugId} 不是 diagnosis`);
  const testFile = String(before.verification_test_files?.[0] || '');
  const fixtureDir = String(before.verification_fixture_dir || before.verification_test_source_dir || '');
  if (!testFile.endsWith('_test.go') || !fixtureDir) throw new Error(`${bugId} 缺少系统验证测试`);
  const jobFile = path.join(jobsRoot, String(before.pipeline_job_id || ''), 'job.json');
  const job = await readJson(jobFile);
  const bugIndex = Number(before.bug_index);
  const jobBug = job?.bugs?.find((bug) => Number(bug.bugIndex) === bugIndex);
  if (!jobBug) {
    throw new Error(`${bugId} 在 ${before.pipeline_job_id} 中缺少 Bug ${bugIndex}`);
  }

  const restoredReadmes = await restoreDiagnosisReadmesFromSource(
    taskDir,
    jobBug.bugBaseDir,
    jobBug.diagnosisSourceCommit || jobBug.redCommit || jobBug.bugBaseCommit,
  );
  const publication = await finalizeV3DiagnosisImmutableDelivery(jobFile, bugIndex, fixtureDir, testFile);
  const id = taskId(path.basename(taskDir));
  const afterPublication = await readJson(path.join(taskDir, 'public.json'));
  const reusableEvidence = afterPublication.verification_evidence?.pre_fix;
  let proofDir = reusableEvidence?.local_manifest
    ? path.dirname(path.join(taskDir, reusableEvidence.local_manifest))
    : '';
  let manifest = null;
  let upload = { uploaded: { url: reusableEvidence?.trajectory_url || '' } };
  if (reusableEvidence?.source_commit === publication.redCommit && reusableEvidence?.local_manifest) {
    manifest = await readJson(path.join(proofDir, 'manifest.json'));
    if (!reusableEvidence.trajectory_url) {
      upload = await postJson('/api/cloud/upload-proof', { taskId: id, artifactKind: 'verify_pre' });
      const mainSessionId = String(await fsp.readFile(path.join(taskDir, 'trajectory', 'session_id.txt'), 'utf8')).trim();
      await finalizeVerificationResult(taskDir, mainSessionId);
    }
  } else {
    const regenerated = await regenerateProof(
      taskDir,
      job.bugs.find((bug) => Number(bug.bugIndex) === bugIndex).bugBaseDir,
    );
    proofDir = regenerated.proofDir;
    const manifestPath = path.join(proofDir, 'manifest.json');
    manifest = regenerated.manifest;
    await persistVerificationManifest(taskDir, 'pre_fix', manifest, manifestPath);
    upload = await postJson('/api/cloud/upload-proof', { taskId: id, artifactKind: 'verify_pre' });
    const mainSessionId = String(await fsp.readFile(path.join(taskDir, 'trajectory', 'session_id.txt'), 'utf8')).trim();
    await finalizeVerificationResult(taskDir, mainSessionId);
  }

  const platformRecord = platformRecords.find((record) => record.bugId === bugId);
  let resubmission = null;
  if (resubmit) {
    if (!platformRecord?.platformSubmissionId) throw new Error(`${bugId} 缺少原平台 submission ID`);
    resubmission = await postJson('/api/submission-platform/resubmit', {
      taskId: id,
      submissionId: String(platformRecord.platformSubmissionId),
    });
  }
  return {
    bugId,
    taskId: id,
    submissionId: platformRecord?.platformSubmissionId || '',
    previousRedCommit: before.red_commit || before.bug_base_commit,
    redCommit: publication.redCommit,
    testFile,
    restoredReadmes,
    proofSessionId: manifest.session_id,
    proofDirectory: path.relative(libraryRoot, proofDir),
    proofUrl: upload.uploaded?.url || upload.uploaded?.signedUrl || '',
    resubmitted: Boolean(resubmission),
  };
}

export async function main(args = process.argv.slice(2)) {
  const resubmit = !args.includes('--no-resubmit');
  const bugIds = args.filter((value) => !value.startsWith('--'));
  if (!bugIds.length) throw new Error('用法：node scripts/repair-diagnosis-red-publication.mjs <bug-id...> [--no-resubmit]');
  const platformRecords = await readJson(platformRecordsPath, []);
  const audit = {
    startedAt: new Date().toISOString(),
    resubmit,
    bugIds,
    results: [],
  };
  const auditPath = path.join(libraryRoot, 'validation', `diagnosis_red_publication_repair_${Date.now()}.json`);
  for (const bugId of bugIds) {
    try {
      const result = await repairOne(bugId, platformRecords, { resubmit });
      audit.results.push({ status: 'repaired', ...result });
      await writeJsonAtomic(auditPath, { ...audit, updatedAt: new Date().toISOString() });
      process.stdout.write(`${bugId}: repaired ${result.redCommit.slice(0, 12)}${resubmit ? ' and resubmitted' : ''}\n`);
    } catch (error) {
      audit.results.push({ bugId, status: 'failed', error: error.message });
      await writeJsonAtomic(auditPath, { ...audit, failedAt: new Date().toISOString() });
      throw error;
    }
  }
  audit.finishedAt = new Date().toISOString();
  await writeJsonAtomic(auditPath, audit);
  process.stdout.write(`audit: ${auditPath}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
