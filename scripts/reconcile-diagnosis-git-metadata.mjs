#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { directPublicVerifyCommandIssues } from '../src/verification-proof.js';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

async function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

async function remoteHead(cwd, cloneUrl, branch) {
  const { stdout } = await git(cwd, ['ls-remote', cloneUrl, `refs/heads/${branch}`]);
  return String(stdout || '').trim().split(/\s+/)[0] || '';
}

function safeTestFiles(metadata) {
  const files = Array.isArray(metadata.verification_test_files)
    ? metadata.verification_test_files.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  return files.length > 0 && files.every((filename) => !path.isAbsolute(filename)
    && !filename.split(/[\\/]/).includes('..')
    && filename.endsWith('_test.go'));
}

async function inspectBug(job, bug) {
  const metadataPath = bug?.task?.taskDir ? path.join(bug.task.taskDir, 'public.json') : '';
  if (job.request?.taskType !== 'diagnosis' || bug?.disposition !== 'delivered' || !metadataPath) {
    return { bugIndex: Number(bug?.bugIndex), action: 'skipped', reason: 'not_delivered_diagnosis' };
  }
  const metadata = await readJson(metadataPath);
  const redBranch = String(bug.redBranch || metadata.red_branch || `bug${bug.bugIndex}_red`);
  const redCommit = String(bug.redCommit || metadata.red_commit || '');
  const evidence = metadata.verification_evidence?.pre_fix;
  const issues = [];
  if (Number(metadata.workflow_policy_version || 0) < 4 || Number(metadata.verification_policy_version || 0) < 5) issues.push('not_policy_4_v5');
  if (!SHA_PATTERN.test(redCommit)) issues.push('invalid_red_commit');
  if (redBranch !== `bug${Number(bug.bugIndex)}_red`) issues.push('invalid_red_branch');
  if (!safeTestFiles(metadata)) issues.push('missing_safe_repository_test');
  if (directPublicVerifyCommandIssues(metadata.verify_cmds, 'diagnosis').length) issues.push('invalid_direct_verify_command');
  if (evidence?.result !== 'red' || evidence?.source_commit !== redCommit || !String(evidence?.trajectory_url || '').trim()) issues.push('incomplete_red_proof');
  if (issues.length) return { bugIndex: Number(bug.bugIndex), action: 'skipped', reason: issues.join(',') };

  for (const filename of metadata.verification_test_files) {
    await git(bug.bugBaseDir, ['cat-file', '-e', `${redCommit}:${filename}`]);
  }
  const remoteCommit = await remoteHead(bug.bugBaseDir, job.request.cloneUrl || metadata.clone_url, redBranch);
  if (remoteCommit !== redCommit) {
    return { bugIndex: Number(bug.bugIndex), action: 'skipped', reason: `remote_mismatch:${remoteCommit || 'missing'}` };
  }
  const repository = String(metadata.repository || '').replace(/\.git$/i, '').replace(/\/$/, '');
  const updated = {
    ...metadata,
    bug_base_branch: '',
    bug_base_commit: redCommit,
    red_branch: redBranch,
    red_commit: redCommit,
    red_pushed: true,
    test_model_fix_branch: redBranch,
    test_model_fix_base_commit: redCommit,
    test_model_fix_commit: redCommit,
    test_model_fix_pushed: true,
    repo_url: `${repository}/tree/${redBranch}`,
    verification_fixture_published: true,
  };
  return { bugIndex: Number(bug.bugIndex), action: 'repair', metadataPath, updated, redCommit, redBranch };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const jobFiles = args.filter((value) => value !== '--apply').map((value) => path.resolve(value));
  if (!jobFiles.length) throw new Error('用法：node scripts/reconcile-diagnosis-git-metadata.mjs [--apply] <job.json> [...]');
  const report = [];
  for (const jobFile of jobFiles) {
    const job = await readJson(jobFile);
    const results = [];
    for (const bug of job.bugs || []) {
      const result = await inspectBug(job, bug).catch((error) => ({
        bugIndex: Number(bug?.bugIndex),
        action: 'skipped',
        reason: `verification_failed:${error.message}`,
      }));
      if (apply && result.action === 'repair') {
        await writeJsonAtomic(result.metadataPath, result.updated);
        bug.redPushed = true;
      }
      results.push({ bugIndex: result.bugIndex, action: result.action, reason: result.reason || '', redCommit: result.redCommit || '' });
    }
    if (apply && results.some((item) => item.action === 'repair')) {
      const repairedAt = new Date().toISOString();
      job.diagnosisGitMetadataReconciledAt = repairedAt;
      job.logs = [...(job.logs || []), {
        at: repairedAt,
        level: 'info',
        stageId: 'metadata_reconciliation',
        message: `校正 diagnosis red-only Git 元数据：${results.filter((item) => item.action === 'repair').map((item) => `Bug ${item.bugIndex}`).join('、')}`,
      }].slice(-300);
      job.updatedAt = repairedAt;
      await writeJsonAtomic(jobFile, job);
    }
    report.push({ jobId: job.id, apply, results });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
