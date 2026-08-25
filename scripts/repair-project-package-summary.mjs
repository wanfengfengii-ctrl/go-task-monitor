#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateProjectPackagePlan, validateReadmeProjectIntroduction } from '../src/project-package-policy.js';

const [jobFileArgument, summaryArgument] = process.argv.slice(2);
if (!jobFileArgument || !summaryArgument) {
  throw new Error('用法：node scripts/repair-project-package-summary.mjs <job.json> <project_summary>');
}

const jobFile = path.resolve(jobFileArgument);
const jobDir = path.dirname(jobFile);
const job = JSON.parse(await fsp.readFile(jobFile, 'utf8'));
const summary = String(summaryArgument || '').trim();
const policyVersion = Number(job.projectPackagePolicyVersion || job.project?.project_package_policy_version || 1);
const assessment = validateProjectPackagePlan({
  ...job.project,
  project_summary: summary,
  project_package_policy_version: policyVersion,
}, {
  policyVersion,
  frontendRequired: Boolean(job.request?.frontendRequired || job.project?.frontend_required),
});

if (!assessment.ok) throw new Error(`新项目简介未通过 V2 校验：${assessment.issues.join('；')}`);
if (job.status === 'running' || Number(job.runnerPid || 0) > 1) {
  throw new Error('任务仍有活跃 Runner，请先停止任务再执行迁移');
}

async function pathIsFile(filename) {
  return (await fsp.stat(filename).catch(() => null))?.isFile() === true;
}

async function writeTextAtomic(filename, content) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  try {
    await fsp.writeFile(temporary, content, 'utf8');
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

const readmeCandidates = [
  path.join(jobDir, 'project', 'BENZHI_README.md'),
  path.join(jobDir, 'project-generation-checkpoint', 'BENZHI_README.md'),
];
const planCandidates = [
  path.join(jobDir, 'artifacts', 'project-plan.json'),
  path.join(jobDir, 'artifacts', 'project-plan-simplified.json'),
];
const filesToRepair = [jobFile];
for (const filename of [...readmeCandidates, ...planCandidates]) {
  if (await pathIsFile(filename)) filesToRepair.push(filename);
}
const timestamp = new Date().toISOString();
const backupRoot = path.join(jobDir, 'migrations', 'project-summary-v2', timestamp.replaceAll(/[:.]/g, '-'));
for (const filename of filesToRepair) {
  const relative = path.relative(jobDir, filename);
  const backup = path.join(backupRoot, relative);
  await fsp.mkdir(path.dirname(backup), { recursive: true });
  await fsp.copyFile(filename, backup);
}

for (const filename of planCandidates) {
  if (!(await pathIsFile(filename))) continue;
  const plan = JSON.parse(await fsp.readFile(filename, 'utf8'));
  plan.project_summary = summary;
  await writeTextAtomic(filename, `${JSON.stringify(plan, null, 2)}\n`);
}

const repairedReadmes = [];
for (const filename of readmeCandidates) {
  if (!(await pathIsFile(filename))) continue;
  const content = await fsp.readFile(filename, 'utf8');
  const normalized = content.replace(/^\uFEFF/, '');
  const separator = normalized.indexOf('\n');
  const repaired = separator >= 0 ? `${summary}${normalized.slice(separator)}` : `${summary}\n`;
  const readmeAssessment = validateReadmeProjectIntroduction(repaired, {
    projectPackagePolicyVersion: policyVersion,
    projectType: assessment.projectType,
    projectSummary: summary,
  });
  if (!readmeAssessment.ok) throw new Error(`${path.relative(jobDir, filename)} 修复后校验失败：${readmeAssessment.issues.join('；')}`);
  await writeTextAtomic(filename, repaired);
  repairedReadmes.push(path.relative(jobDir, filename));
}
if (!repairedReadmes.length) throw new Error('没有找到 BENZHI_README.md，未修改任务元数据');

const repairedAt = new Date().toISOString();
const previousSummary = String(job.project?.project_summary || '');
job.project = { ...job.project, project_summary: summary };
job.projectSummaryRepair = {
  version: 2,
  repairedAt,
  previousSummary,
  summary,
  backupRoot,
};
job.logs = [...(job.logs || []), {
  at: repairedAt,
  level: 'info',
  stageId: 'project_package_policy',
  message: '已按 V2 严格单句规则修复项目简介，并同步 BENZHI_README.md 与规划产物。',
}].slice(-300);
job.updatedAt = repairedAt;
const jobContent = `${JSON.stringify(job, null, 2)}\n`;
await writeTextAtomic(jobFile, jobContent);

const jobsRoot = path.dirname(jobDir);
const mirrorFile = path.join(path.dirname(jobsRoot), 'pipeline-refill', 'job-backups', `${job.id}.json`);
await writeTextAtomic(mirrorFile, jobContent);

process.stdout.write(`${JSON.stringify({
  jobId: job.id,
  status: job.status,
  projectSummary: summary,
  repairedReadmes,
  backupRoot,
  mirrorFile,
}, null, 2)}\n`);
