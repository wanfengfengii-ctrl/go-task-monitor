#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  finalizeVerificationResult,
  persistVerificationManifest,
} from './run-production-pipeline.mjs';
import { verificationProofPrompt } from '../src/verification-proof.js';

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

function managedTaskId(taskName) {
  return `task-${crypto.createHash('sha256').update(`go-task-library/${taskName}`).digest('hex').slice(0, 16)}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function git(repository, args) {
  const result = await execFileAsync('git', ['-C', repository, ...args], {
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
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
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

async function nextProofDirectory(taskDir, phase) {
  const root = path.join(taskDir, 'verification', phase);
  await fsp.mkdir(root, { recursive: true });
  const attempts = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('attempt-'.length)))
    .filter(Number.isInteger);
  return path.join(root, `attempt-${Math.max(0, ...attempts) + 1}`);
}

async function materializeTest(taskDir, metadata, testFile, contents) {
  const candidates = [
    metadata.verification_test_source_dir,
    path.join(taskDir, 'workspace'),
    path.join(taskDir, '.post-fix-checkpoint', 'workspace'),
    path.join(taskDir, 'grader', 'model-tests'),
  ].filter(Boolean);
  const updated = [];
  for (const root of new Set(candidates.map((candidate) => path.resolve(candidate)))) {
    const destination = path.join(root, testFile);
    if (!await fsp.stat(destination).catch(() => null) && root !== path.resolve(metadata.verification_test_source_dir || '')) continue;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, contents);
    updated.push(path.relative(taskDir, destination));
  }
  return updated;
}

async function prepareMetadata(taskDir, before) {
  const layoutPath = path.join(taskDir, '.git-layout.json');
  const layout = await readJson(layoutPath);
  const repository = path.resolve(layout.repository || path.join(taskDir, '.git-layout'));
  const testFile = String(before.verification_test_files?.[0] || layout.test_file || '');
  if (!testFile.endsWith('_test.go')) throw new Error(`${before.bug_id} 缺少独立验证测试`);
  const redCommit = await git(repository, ['rev-parse', layout.red_branch]);
  const greenCommit = await git(repository, ['rev-parse', layout.green_branch]);
  const redTest = await execFileAsync('git', ['-C', repository, 'show', `${redCommit}:${testFile}`], {
    encoding: 'buffer', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024,
  }).then((result) => result.stdout);
  const greenTest = await execFileAsync('git', ['-C', repository, 'show', `${greenCommit}:${testFile}`], {
    encoding: 'buffer', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024,
  }).then((result) => result.stdout);
  const testSha = sha256(redTest);
  if (testSha !== sha256(greenTest)) throw new Error(`${before.bug_id} Red/Green 独立测试字节不一致`);

  const materialized = await materializeTest(taskDir, before, testFile, redTest);
  const metadata = {
    ...before,
    red_commit: redCommit,
    red_pushed: true,
    green_fix_commit: greenCommit,
    test_model_fix_commit: greenCommit,
    test_model_fix_pushed: true,
    verification_test_sha256: testSha,
    verification_test_manifest: [{ path: testFile, sha256: testSha }],
  };
  const publicationChanged = before.red_commit !== redCommit
    || before.test_model_fix_commit !== greenCommit
    || before.verification_test_sha256 !== testSha;
  if (publicationChanged) {
    delete metadata.verification_evidence;
    delete metadata.verify_result;
  }
  await writeJsonAtomic(path.join(taskDir, 'public.json'), metadata);
  await writeJsonAtomic(layoutPath, {
    ...layout,
    red_commit: redCommit,
    green_commit: greenCommit,
    test_file: testFile,
    test_sha256: testSha,
    repaired_at: new Date().toISOString(),
  });
  return { metadata, layout: { ...layout, repository }, redCommit, greenCommit, testFile, testSha, materialized };
}

async function runProof(taskDir, phase, repository, branch) {
  const current = await readJson(path.join(taskDir, 'public.json'));
  const expectedCommit = phase === 'pre_fix'
    ? Number(current.git_commit_layout_policy_version || 0) >= 1 ? current.red_commit : current.bug_base_commit
    : current.test_model_fix_commit;
  const expectedPromptSha = sha256(`${verificationProofPrompt(phase, current.verify_cmds)}\n`);
  const existing = current.verification_evidence?.[phase];
  if (existing?.source_commit === expectedCommit && existing?.local_manifest) {
    const manifestPath = path.join(taskDir, existing.local_manifest);
    const manifest = await readJson(manifestPath).catch(() => null);
    if (manifest?.result === (phase === 'pre_fix' ? 'red' : 'green')
      && manifest.prompt_sha256 === expectedPromptSha) {
      let proofUrl = existing.trajectory_url || '';
      if (!proofUrl) {
        const artifactKind = phase === 'pre_fix' ? 'verify_pre' : 'verify_post';
        const upload = await postJson('/api/cloud/upload-proof', {
          taskId: managedTaskId(path.basename(taskDir)),
          artifactKind,
        });
        proofUrl = upload.uploaded?.url || upload.uploaded?.signedUrl || '';
      }
      return {
        manifest,
        evidence: existing,
        proofDirectory: path.relative(libraryRoot, path.dirname(manifestPath)),
        proofUrl,
        reused: true,
      };
    }
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cloneRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `go-bugfix-${phase}-`));
    const sourceDir = path.join(cloneRoot, 'source');
    const proofDir = await nextProofDirectory(taskDir, phase);
    try {
      await execFileAsync('git', ['clone', '--quiet', '--single-branch', '--branch', branch, repository, sourceDir], {
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      await execFileAsync('/bin/bash', [verificationRunner, taskDir, phase, sourceDir, proofDir], {
        cwd: monitorRoot,
        timeout: 60 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GO_PIPELINE_MONITOR_ROOT: monitorRoot },
      });
      const manifestPath = path.join(proofDir, 'manifest.json');
      const manifest = await readJson(manifestPath);
      const evidence = await persistVerificationManifest(taskDir, phase, manifest, manifestPath);
      const artifactKind = phase === 'pre_fix' ? 'verify_pre' : 'verify_post';
      const upload = await postJson('/api/cloud/upload-proof', {
        taskId: managedTaskId(path.basename(taskDir)),
        artifactKind,
      });
      return {
        manifest,
        evidence,
        proofDirectory: path.relative(libraryRoot, proofDir),
        proofUrl: upload.uploaded?.url || upload.uploaded?.signedUrl || '',
      };
    } catch (error) {
      lastError = error;
    } finally {
      await fsp.rm(cloneRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastError || new Error(`${phase} 证明连续 3 个新 Session 失败`);
}

async function repairOne(bugId, platformRecords, { resubmit }) {
  const { taskDir, metadata: before } = await taskByBugId(bugId);
  if (before.task_type !== 'bugfix') throw new Error(`${bugId} 不是 bugfix`);
  const prepared = await prepareMetadata(taskDir, before);
  const preFix = await runProof(taskDir, 'pre_fix', prepared.layout.repository, prepared.layout.red_branch);
  const postFix = await runProof(taskDir, 'post_fix', prepared.layout.repository, prepared.layout.green_branch);
  const mainSessionId = String(await fsp.readFile(path.join(taskDir, 'trajectory', 'session_id.txt'), 'utf8')).trim();
  await finalizeVerificationResult(taskDir, mainSessionId);

  const jobFile = path.join(jobsRoot, String(before.pipeline_job_id || ''), 'job.json');
  const job = await readJson(jobFile, null);
  if (job) {
    const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === Number(before.bug_index));
    if (bug) bug.verificationEvidence = { pre_fix: preFix.manifest, post_fix: postFix.manifest };
    await writeJsonAtomic(jobFile, job);
  }

  const platformRecord = platformRecords.find((record) => record.bugId === bugId);
  let resubmission = null;
  if (resubmit) {
    if (!platformRecord?.platformSubmissionId) throw new Error(`${bugId} 缺少原平台 submission ID`);
    resubmission = await postJson('/api/submission-platform/resubmit', {
      taskId: managedTaskId(path.basename(taskDir)),
      submissionId: String(platformRecord.platformSubmissionId),
    });
  }
  return {
    bugId,
    submissionId: platformRecord?.platformSubmissionId || '',
    previousRedCommit: before.red_commit,
    previousGreenCommit: before.test_model_fix_commit,
    redCommit: prepared.redCommit,
    greenCommit: prepared.greenCommit,
    testFile: prepared.testFile,
    testSha256: prepared.testSha,
    materialized: prepared.materialized,
    preFix: { sessionId: preFix.manifest.session_id, proofDirectory: preFix.proofDirectory, proofUrl: preFix.proofUrl },
    postFix: { sessionId: postFix.manifest.session_id, proofDirectory: postFix.proofDirectory, proofUrl: postFix.proofUrl },
    resubmitted: Boolean(resubmission),
  };
}

export async function main(args = process.argv.slice(2)) {
  const resubmit = !args.includes('--no-resubmit');
  const bugIds = args.filter((value) => !value.startsWith('--'));
  if (!bugIds.length) throw new Error('用法：node scripts/repair-bugfix-verification-tests.mjs <bug-id...> [--no-resubmit]');
  const platformRecords = await readJson(platformRecordsPath, []);
  const audit = { startedAt: new Date().toISOString(), resubmit, bugIds, results: [] };
  const auditPath = path.join(libraryRoot, 'validation', `bugfix_verification_test_repair_${Date.now()}.json`);
  for (const bugId of bugIds) {
    try {
      const result = await repairOne(bugId, platformRecords, { resubmit });
      audit.results.push({ status: 'repaired', ...result });
      await writeJsonAtomic(auditPath, { ...audit, updatedAt: new Date().toISOString() });
      process.stdout.write(`${bugId}: repaired ${result.redCommit.slice(0, 12)} -> ${result.greenCommit.slice(0, 12)}${resubmit ? ' and resubmitted' : ''}\n`);
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
