#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { buildModelVerificationPlan } from '../src/model-verification.js';

const exec = promisify(execFile);

function usage() {
  throw new Error('usage: node scripts/restore-historical-delivery.mjs TASK_DIR ARCHIVE_DIR COMMIT SESSION_ID');
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

async function filesUnder(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return result.sort();
}

async function treeHash(root) {
  const hash = crypto.createHash('sha256');
  for (const relative of await filesUnder(root)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function changedModelTests(pristine, fixed) {
  const candidates = new Set([
    ...(await filesUnder(pristine)).filter((filename) => filename.endsWith('_test.go')),
    ...(await filesUnder(fixed)).filter((filename) => filename.endsWith('_test.go')),
  ]);
  const changed = [];
  for (const filename of [...candidates].sort()) {
    const [before, after] = await Promise.all([
      fs.readFile(path.join(pristine, filename)).catch(() => null),
      fs.readFile(path.join(fixed, filename)).catch(() => null),
    ]);
    if (!after || (before && before.equals(after))) continue;
    changed.push({ path: filename, content: after.toString('utf8') });
  }
  return changed;
}

async function main() {
  const [taskInput, archiveInput, expectedCommit, expectedSession] = process.argv.slice(2);
  if (!taskInput || !archiveInput || !/^[a-f0-9]{40}$/i.test(expectedCommit || '')
    || !/^[0-9a-f-]{36}$/i.test(expectedSession || '')) usage();

  const taskDir = path.resolve(taskInput);
  const archiveDir = path.resolve(archiveInput);
  const archiveWorkspace = path.join(archiveDir, 'workspace');
  const archiveTrajectory = path.join(archiveDir, 'trajectory');
  const publicPath = path.join(taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  if (metadata.task_type !== 'bugfix') throw new Error('historical delivery restore currently supports bugfix tasks only');

  const manifest = await readJson(path.join(archiveTrajectory, 'runner-manifest.json'));
  const recordedSession = String(await fs.readFile(path.join(archiveTrajectory, 'session_id.txt'), 'utf8')).trim();
  if (manifest.session_id !== expectedSession || recordedSession !== expectedSession) {
    throw new Error(`archive session mismatch: ${manifest.session_id}/${recordedSession} != ${expectedSession}`);
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-delivery-'));
  const remoteClone = path.join(temporaryRoot, 'repository');
  try {
    await exec('git', ['clone', '--quiet', '--branch', metadata.test_model_fix_branch, '--single-branch', metadata.repository, remoteClone]);
    const { stdout } = await exec('git', ['-C', remoteClone, 'rev-parse', 'HEAD']);
    const actualCommit = stdout.trim();
    if (actualCommit !== expectedCommit) throw new Error(`remote commit mismatch: ${actualCommit} != ${expectedCommit}`);
    const [remoteHash, archiveHash] = await Promise.all([treeHash(remoteClone), treeHash(archiveWorkspace)]);
    if (remoteHash !== archiveHash) throw new Error(`archive workspace does not match remote commit ${expectedCommit}`);

    const modelTests = await changedModelTests(path.join(taskDir, 'pristine'), archiveWorkspace);
    if (!modelTests.length) throw new Error('archive contains no changed public Go regression tests');
    const context = await readJson(path.join(taskDir, 'grader/v4-context.json')).catch(() => ({}));
    const plan = buildModelVerificationPlan(modelTests, { concurrency: Boolean(context.concurrency) });

    const backupRoot = path.join(path.dirname(path.dirname(taskDir)), 'validation', 'historical-repair-backups', path.basename(taskDir));
    const backupDir = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(publicPath, path.join(backupDir, 'public.json'));
    const currentTrajectory = path.join(taskDir, 'trajectory');
    if (await fs.stat(currentTrajectory).catch(() => null)) {
      await fs.cp(currentTrajectory, path.join(backupDir, 'trajectory'), { recursive: true });
    }

    await Promise.all([
      fs.rm(path.join(taskDir, 'workspace'), { recursive: true, force: true }),
      fs.rm(currentTrajectory, { recursive: true, force: true }),
    ]);
    await Promise.all([
      fs.cp(archiveWorkspace, path.join(taskDir, 'workspace'), { recursive: true }),
      fs.cp(archiveTrajectory, currentTrajectory, { recursive: true }),
    ]);

    const stream = await fs.readFile(path.join(currentTrajectory, 'trajectory.stream.jsonl'), 'utf8');
    const init = stream.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .find((event) => event?.type === 'system' && event?.subtype === 'init') || {};
    metadata.test_model_fix_commit = expectedCommit;
    metadata.test_model_fix_pushed = true;
    metadata.test_model_fix_session_id = expectedSession;
    metadata.repo_url = `${String(metadata.repository).replace(/\.git$/, '').replace(/\/$/, '')}/tree/${metadata.test_model_fix_branch}`;
    metadata.generator_model = init.model || 'claude-code-cli';
    metadata.verify_cmds = plan.verify_cmds;
    metadata.verification_test_overlay = plan.verification_test_overlay;
    metadata.verification_test_files = plan.verification_test_files;
    metadata.verification_test_names = plan.verification_test_names;
    metadata.verification_test_manifest = plan.verification_test_manifest;
    metadata.model_verification_policy_version = plan.policy_version;
    metadata.verification_evidence = {};
    metadata.verify_result = '';
    metadata.harness = `backend=docker-target; isolation=independent-workspace-without-.git + read-only-external-hidden-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=Claude Code CLI; target_cli_version=${init.claude_code_version || 'unknown'} (Claude Code); go=go1.25.6; hidden_target_runs=20/20`;
    for (const field of ['trajectory', 'trajectory_uploaded_at', 'verification_coverage', 'model_verification_pre_fix', 'model_verification_post_fix']) {
      delete metadata[field];
    }
    await writeJsonAtomic(publicPath, metadata);
    await fs.rm(path.join(taskDir, '.retry-feedback'), { force: true });

    process.stdout.write(`${JSON.stringify({
      task: path.basename(taskDir),
      bug_id: metadata.bug_id,
      restored_commit: expectedCommit,
      restored_session: expectedSession,
      verify_cmds: plan.verify_cmds,
      test_files: plan.verification_test_files,
      backup: backupDir,
    }, null, 2)}\n`);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
