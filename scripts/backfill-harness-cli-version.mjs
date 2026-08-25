#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseTrajectoryJson } from '../src/trajectory-file-validator.js';
import {
  extractClaudeCodeVersion,
  getClaudeHarnessIssues,
  normalizeClaudeCodeVersion,
  upsertClaudeCodeHarness,
} from '../src/harness-rules.js';

const writeChanges = process.argv.includes('--write');
const rootArg = process.argv.find((arg) => arg.startsWith('--work-root='));
const workRoot = path.resolve(rootArg?.slice('--work-root='.length) || path.resolve(import.meta.dirname, '../../.task_work'));

async function exists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

async function taskRoots() {
  const roots = [];
  for (const entry of await fs.readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== 'go-task-library' && !entry.name.startsWith('go-batch-'))) continue;
    const tasks = path.join(workRoot, entry.name, 'tasks');
    if (await exists(tasks)) roots.push(tasks);
  }
  return roots;
}

async function trajectoryCandidates(taskDir) {
  const trajectoryDir = path.join(taskDir, 'trajectory');
  const entries = await fs.readdir(trajectoryDir).catch(() => []);
  const preferred = ['trajectory.stream.jsonl', 'raw.stream.jsonl'];
  const current = [...new Set([
    ...preferred.filter((name) => entries.includes(name)),
    ...entries.filter((name) => /^raw\.native\..+\.jsonl$/i.test(name)).sort(),
    ...entries.filter((name) => /^trajectory_.+\.jsonl?$/i.test(name)).sort(),
  ])].map((name) => path.join(trajectoryDir, name));
  const archived = [];
  const archiveRoots = [
    path.join(taskDir, 'history'),
    path.join(workRoot, 'go-task-library', 'retry-history', path.basename(taskDir)),
  ];
  async function collect(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const target = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (!['workspace', 'pristine', 'gold', 'grader', 'node_modules'].includes(child.name)) await collect(target);
      } else if (/^(?:raw(?:\.native)?|trajectory)[^/]*\.jsonl?$/i.test(child.name)) {
        archived.push(target);
      }
    }
  }
  for (const root of archiveRoots) await collect(root);
  return [...current, ...archived.sort()];
}

async function versionFromTrajectory(taskDir) {
  const candidates = await trajectoryCandidates(taskDir);
  for (const candidate of candidates) {
    try {
      const version = extractClaudeCodeVersion(parseTrajectoryJson(await fs.readFile(candidate, 'utf8')));
      if (version) return { evidence: { version, source: path.relative(workRoot, candidate) }, candidateCount: candidates.length };
    } catch {}
  }
  return { evidence: null, candidateCount: candidates.length };
}

async function scan() {
  const changes = [];
  const unchanged = [];
  const pending = [];
  const failures = [];
  for (const tasksRoot of await taskRoots()) {
    const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const taskDir = path.join(tasksRoot, entry.name);
      const publicPath = path.join(taskDir, 'public.json');
      if (!await exists(publicPath)) continue;
      try {
        const original = await fs.readFile(publicPath, 'utf8');
        const metadata = JSON.parse(original);
        if (!getClaudeHarnessIssues(metadata.harness).length) {
          unchanged.push(path.relative(workRoot, publicPath));
          continue;
        }
        const trajectory = await versionFromTrajectory(taskDir);
        const recordedVersion = normalizeClaudeCodeVersion(String(metadata.harness || '').match(/target_cli_version\s*=\s*([^;]+)/i)?.[1]);
        const evidence = trajectory.evidence || (recordedVersion ? { version: recordedVersion, source: 'existing-harness' } : null);
        if (!evidence) {
          if (trajectory.candidateCount === 0) {
            pending.push({ task: entry.name, reason: '任务尚未生成完整轨迹，完成后由运行器自动写入版本' });
            continue;
          }
          failures.push({ task: entry.name, reason: '原始轨迹和现有 harness 均没有可信 Claude Code 版本' });
          continue;
        }
        metadata.harness = upsertClaudeCodeHarness(metadata.harness, evidence.version);
        const updated = `${JSON.stringify(metadata, null, 2)}\n`;
        if (updated !== original) changes.push({ publicPath, original, updated, task: entry.name, version: evidence.version, source: evidence.source });
      } catch (error) {
        failures.push({ task: entry.name, reason: error.message });
      }
    }
  }
  return { changes, unchanged, pending, failures };
}

async function writeAtomic(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, target);
}

const result = await scan();
let backupPath = '';
if (writeChanges && result.changes.length) {
  const validationDir = path.join(workRoot, 'go-task-library', 'validation');
  await fs.mkdir(validationDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = path.join(validationDir, `harness-cli-backfill-${stamp}.json`);
  await writeAtomic(backupPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    workRoot,
    changes: result.changes.map(({ publicPath, original, task, version, source }) => ({
      publicPath: path.relative(workRoot, publicPath), original, task, version, source,
    })),
  }, null, 2)}\n`);
  for (const change of result.changes) await writeAtomic(change.publicPath, change.updated);
}

process.stdout.write(`${JSON.stringify({
  mode: writeChanges ? 'write' : 'dry-run',
  workRoot,
  changed: result.changes.length,
  unchanged: result.unchanged.length,
  pending: result.pending.length,
  failed: result.failures.length,
  backupPath,
  changes: result.changes.map(({ publicPath, task, version, source }) => ({ publicPath: path.relative(workRoot, publicPath), task, version, source })),
  pendingTasks: result.pending,
  failures: result.failures,
}, null, 2)}\n`);
