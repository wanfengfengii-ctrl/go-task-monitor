#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CURRENT_PROJECT_PACKAGE_POLICY_VERSION, validateProjectPackagePlan } from '../src/project-package-policy.js';

const execFileAsync = promisify(execFile);
const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libraryRoot = path.resolve(process.env.GO_TASK_LIBRARY_ROOT
  || path.join(monitorRoot, '..', '.task_work', 'go-task-library'));
const tasksRoot = path.join(libraryRoot, 'tasks');
const apiBase = String(process.env.GO_PIPELINE_MONITOR_API_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

async function pathExists(filename) {
  return fsp.access(filename).then(() => true).catch(() => false);
}

function withIntroduction(content, summary) {
  const normalized = String(content || '').replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (/^基于 Go 实现的/u.test(lines[0] || '')) lines[0] = summary;
  else lines.unshift(summary);
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

async function taskByBugId(bugId) {
  for (const entry of await fsp.readdir(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(tasksRoot, entry.name);
    const metadata = await readJson(path.join(taskDir, 'public.json')).catch(() => null);
    if (metadata?.bug_id === bugId) return { taskDir, metadata };
  }
  throw new Error(`${bugId} 不存在于活动任务库`);
}

function repositoryUrl(metadata) {
  const value = String(metadata.repository || metadata.repo_url || '').trim();
  return value.replace(/\/tree\/[^/]+$/, '');
}

async function publishBranchReadme(repository, branch, summary) {
  const checkout = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-readme-repair-'));
  try {
    await execFileAsync('git', ['clone', '--quiet', '--depth=1', '--single-branch', '--branch', branch, repository, checkout], {
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const readme = path.join(checkout, 'BENZHI_README.md');
    if (!await pathExists(readme)) throw new Error(`${repository} ${branch} 缺少 BENZHI_README.md`);
    const before = await fsp.readFile(readme, 'utf8');
    const after = withIntroduction(before, summary);
    if (after !== before) {
      await fsp.writeFile(readme, after, 'utf8');
      await execFileAsync('git', ['-C', checkout, 'add', '--', 'BENZHI_README.md']);
      await execFileAsync('git', [
        '-C', checkout,
        '-c', 'user.name=Go Task Monitor',
        '-c', 'user.email=go-task-monitor@local.invalid',
        'commit', '--quiet', '-m', 'docs: update project introduction',
      ]);
      await execFileAsync('git', ['-C', checkout, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
        timeout: 5 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
    const { stdout } = await execFileAsync('git', ['-C', checkout, 'rev-parse', 'HEAD']);
    return { branch, commit: stdout.trim(), changed: after !== before };
  } finally {
    await fsp.rm(checkout, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateTaskReadmes(taskDir, summary) {
  const updated = [];
  for (const relative of ['pristine/BENZHI_README.md', 'workspace/BENZHI_README.md', '.git-layout/BENZHI_README.md']) {
    const filename = path.join(taskDir, relative);
    if (!await pathExists(filename)) continue;
    const stat = await fsp.stat(filename);
    const before = await fsp.readFile(filename, 'utf8');
    const after = withIntroduction(before, summary);
    if (after !== before) {
      await fsp.chmod(filename, 0o644).catch(() => {});
      await fsp.writeFile(filename, after, 'utf8');
      await fsp.chmod(filename, stat.mode & 0o777).catch(() => {});
      updated.push(relative);
    }
  }
  return updated;
}

async function postJson(route, body) {
  const response = await fetch(`${apiBase}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `${route} 返回 HTTP ${response.status}`);
  return payload;
}

function parseArgs(args) {
  const summaryIndex = args.indexOf('--summary');
  if (summaryIndex < 0 || !args[summaryIndex + 1]) {
    throw new Error('用法：node scripts/repair-platform-readme-introductions.mjs --summary <简介> <bug-id=submission-id...>');
  }
  const summary = args[summaryIndex + 1];
  const specs = args.filter((value, index) => index !== summaryIndex && index !== summaryIndex + 1)
    .map((value) => {
      const separator = value.lastIndexOf('=');
      if (separator <= 0) throw new Error(`参数 ${value} 必须为 bug-id=submission-id`);
      return { bugId: value.slice(0, separator), submissionId: value.slice(separator + 1) };
    });
  if (!specs.length) throw new Error('至少提供一个 bug-id=submission-id');
  const assessment = validateProjectPackagePlan({
    project_type: 'web',
    project_summary: summary,
    project_package_policy_version: CURRENT_PROJECT_PACKAGE_POLICY_VERSION,
  });
  if (assessment.issues.length) throw new Error(`项目简介不合格：${assessment.issues.join('；')}`);
  return { summary, specs };
}

export async function main(args = process.argv.slice(2)) {
  const { summary, specs } = parseArgs(args);
  const audit = { startedAt: new Date().toISOString(), summary, results: [] };
  const auditPath = path.join(libraryRoot, 'validation', `platform_readme_repair_${Date.now()}.json`);
  for (const spec of specs) {
    const { taskDir, metadata } = await taskByBugId(spec.bugId);
    const branches = [...new Set([metadata.red_branch, metadata.green_branch].filter(Boolean))];
    const publications = [];
    for (const branch of branches) publications.push(await publishBranchReadme(repositoryUrl(metadata), branch, summary));
    const localReadmes = await updateTaskReadmes(taskDir, summary);
    await writeJsonAtomic(path.join(taskDir, 'public.json'), {
      ...metadata,
      project_type: 'web',
      project_summary: summary,
      project_package_policy_version: Number(metadata.project_package_policy_version || 0),
    });
    await postJson('/api/submission-platform/resubmit', {
      taskId: `task-${crypto.createHash('sha256').update(`go-task-library/${path.basename(taskDir)}`).digest('hex').slice(0, 16)}`,
      submissionId: spec.submissionId,
    });
    audit.results.push({ ...spec, publications, localReadmes, status: 'resubmitted' });
    await writeJsonAtomic(auditPath, { ...audit, updatedAt: new Date().toISOString() });
    process.stdout.write(`${spec.bugId}: README repaired and submission ${spec.submissionId} resubmitted\n`);
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
