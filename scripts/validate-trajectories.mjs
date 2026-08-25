#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseMutationAudit } from '../src/trajectory-audit.js';
import { parseTrajectoryJson, validateDiagnosisReadOnlyEvents, validateTrajectoryIntegrityEvents } from '../src/trajectory-file-validator.js';
import { resolveTrajectoryManifestPrompt, validateTrajectoryManifest } from '../src/trajectory-v4.js';

export function parseArguments(args) {
  const options = {
    json: false,
    failOnWarning: false,
    maxWrites: 2,
    taskName: '',
    taskType: '',
    taskRoot: '',
    inputs: [],
  };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg === '--fail-on-warning') options.failOnWarning = true;
    else if (arg.startsWith('--max-writes=')) options.maxWrites = Number(arg.split('=', 2)[1]);
    else if (arg.startsWith('--task-name=')) options.taskName = arg.slice('--task-name='.length).trim();
    else if (arg.startsWith('--task-type=')) options.taskType = arg.slice('--task-type='.length).trim();
    else if (arg.startsWith('--task-root=')) options.taskRoot = path.resolve(arg.slice('--task-root='.length).trim());
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else options.inputs.push(arg);
  }
  if (!options.inputs.length) {
    throw new Error('用法：node scripts/validate-trajectories.mjs [--json] [--task-name=NAME] [--task-type=bugfix|diagnosis] [--task-root=DIR] <JSON/JSONL文件或目录> [...]');
  }
  if (options.taskType && !['bugfix', 'diagnosis'].includes(options.taskType)) throw new Error('--task-type 只能是 bugfix 或 diagnosis');
  return options;
}

async function collectJsonFiles(input) {
  const absolute = path.resolve(input);
  const stat = await fs.stat(absolute);
  if (stat.isFile()) return /\.jsonl?$/i.test(absolute) ? [absolute] : [];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    const target = path.join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectJsonFiles(target));
    else if (entry.isFile() && /^trajectory_.*\.jsonl?$/i.test(entry.name)) files.push(target);
  }
  return files;
}

async function loadTaskMetadata(events, explicitTaskRoot = '') {
  const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init');
  const workspaceRoot = init?.cwd || events.find((event) => typeof event?.cwd === 'string')?.cwd || '';
  const taskRoot = explicitTaskRoot || (workspaceRoot && path.basename(workspaceRoot) === 'workspace' ? path.dirname(workspaceRoot) : '');
  if (!taskRoot) return { workspaceRoot };
  const policyVersion = await fs.stat(path.join(taskRoot, '.trajectory-policy-v4')).then(() => 4)
    .catch(() => fs.stat(path.join(taskRoot, '.trajectory-policy-v3')).then(() => 3).catch(() => 2));
  try {
    const metadata = await fs.readFile(path.join(taskRoot, 'public.json'), 'utf8').then(JSON.parse);
    return {
      workspaceRoot,
      taskRoot,
      taskName: metadata.sample_id || path.basename(taskRoot),
      taskType: metadata.task_type || '',
      executionPolicyVersion: policyVersion,
    };
  } catch (error) {
    if (policyVersion >= 4) throw new Error(`V4 任务上下文读取失败：${error.message}`);
    return { workspaceRoot, taskName: path.basename(taskRoot), taskType: '', executionPolicyVersion: policyVersion };
  }
}

async function validateV4Manifest(taskRoot, filename, deliveryContent, events, metadata) {
  if (!taskRoot || !await fs.stat(path.join(taskRoot, '.trajectory-policy-v4')).catch(() => null)) return [];
  try {
    const trajectoryDir = path.join(taskRoot, 'trajectory');
    const manifest = JSON.parse(await fs.readFile(path.join(trajectoryDir, 'runner-manifest.json'), 'utf8'));
    if (path.basename(String(manifest.raw_filename || '')) !== manifest.raw_filename) throw new Error('runner manifest 的 raw_filename 不是安全文件名');
    if (path.basename(String(manifest.delivery_filename || '')) !== manifest.delivery_filename) throw new Error('runner manifest 的 delivery_filename 不是安全文件名');
    const [promptDocument, rawNativeContent, rawStreamContent, auditContent] = await Promise.all([
      fs.readFile(path.join(taskRoot, 'PROMPT.md'), 'utf8'),
      fs.readFile(path.join(trajectoryDir, manifest.raw_filename), 'utf8'),
      fs.readFile(path.join(trajectoryDir, 'trajectory.stream.jsonl'), 'utf8'),
      fs.readFile(path.join(trajectoryDir, 'mutation-audit.jsonl'), 'utf8'),
    ]);
    const prompt = resolveTrajectoryManifestPrompt(manifest, promptDocument);
    const rawEvents = parseTrajectoryJson(rawNativeContent);
    const sessionIds = [...new Set(events.map((event) => event?.sessionId || event?.session_id).filter(Boolean))];
    const result = validateTrajectoryManifest(manifest, {
      prompt,
      rawNativeContent,
      rawStreamContent,
      deliveryContent,
      auditContent,
      expectedSessionId: sessionIds.length === 1 ? sessionIds[0] : '',
      expectedTaskType: metadata.taskType,
      rawEventCount: rawEvents.length,
      deliveryEventCount: events.length,
    });
    if (manifest.delivery_filename !== path.basename(filename)) result.issues.push('runner manifest 的 delivery_filename 与交付文件不一致');
    return result.issues;
  } catch (error) {
    return [`V4 runner manifest 读取失败：${error.message}`];
  }
}

export async function validateFiles(options) {
  const files = [...new Set((await Promise.all(options.inputs.map(collectJsonFiles))).flat())].sort();
  if (!files.length) throw new Error('没有找到 trajectory_*.json 或 trajectory_*.jsonl 文件');

  const reports = [];
  for (const filename of files) {
    try {
      const content = await fs.readFile(filename, 'utf8');
      const events = parseTrajectoryJson(content);
      const discovered = Array.isArray(events) ? await loadTaskMetadata(events, options.taskRoot) : {};
      const metadata = {
        ...discovered,
        ...(options.taskName ? { taskName: options.taskName } : {}),
        ...(options.taskType ? { taskType: options.taskType } : {}),
      };
      const validation = validateTrajectoryIntegrityEvents(events, { filename, ...metadata });
      if (metadata.taskType === 'diagnosis') {
        const auditPath = metadata.taskRoot
          ? path.join(metadata.taskRoot, 'trajectory', 'mutation-audit.jsonl')
          : path.join(path.dirname(filename), 'mutation-audit.jsonl');
        const readOnly = validateDiagnosisReadOnlyEvents(events, {
          workspaceRoot: metadata.workspaceRoot || (metadata.taskRoot ? path.join(metadata.taskRoot, 'workspace') : ''),
          auditRecords: parseMutationAudit(await fs.readFile(auditPath, 'utf8')),
          requireAudit: true,
        });
        validation.errors.push(...readOnly.errors);
        validation.warnings.push(...readOnly.warnings);
        validation.stats.diagnosisReadOnly = readOnly.stats;
        validation.ok = validation.errors.length === 0;
      }
      const manifestIssues = await validateV4Manifest(metadata.taskRoot, filename, content, events, metadata);
      for (const message of manifestIssues) validation.errors.push({ level: 'error', code: 'runner-manifest', message });
      validation.ok = validation.errors.length === 0;
      reports.push({
        file: filename,
        filename: path.basename(filename),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content),
        ...validation,
      });
    } catch (error) {
      reports.push({
        file: filename,
        filename: path.basename(filename),
        ok: false,
        errors: [{ level: 'error', code: 'parse', message: `JSON 读取或解析失败：${error.message}` }],
        warnings: [],
        stats: { eventCount: 0 },
      });
    }
  }
  return {
    ok: reports.every((report) => report.ok && (!options.failOnWarning || !report.warnings.length)),
    summary: {
      total: reports.length,
      passed: reports.filter((report) => report.ok).length,
      failed: reports.filter((report) => !report.ok).length,
      warnings: reports.reduce((sum, report) => sum + report.warnings.length, 0),
    },
    reports,
  };
}

function printHuman(result) {
  for (const report of result.reports) {
    const status = report.ok ? 'PASS' : 'FAIL';
    const task = report.stats.taskName ? ` · ${report.stats.taskName}` : '';
    console.log(`${status} ${report.filename}${task}`);
    console.log(`  session=${report.stats.sessionId || '-'} events=${report.stats.eventCount} tools=${report.stats.toolUses || 0}/${report.stats.toolResults || 0} format=${report.stats.format || '-'}`);
    for (const item of report.errors) {
      console.log(`  [错误][${item.code}] ${item.message}`);
      if (item.evidence) console.log(`    依据：${item.evidence}`);
    }
    for (const item of report.warnings) {
      console.log(`  [提示][${item.code}] ${item.message}`);
      if (item.evidence) console.log(`    依据：${item.evidence}`);
    }
  }
  console.log(`\n汇总：${result.summary.passed}/${result.summary.total} 通过，${result.summary.failed} 不通过，${result.summary.warnings} 个复核提示。`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const result = await validateFiles(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
