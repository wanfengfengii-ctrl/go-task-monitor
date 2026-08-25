import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { assessProjectComplexity } from '../src/project-complexity.js';
import { assessGeneratedProjectPlan } from '../src/generated-project-quality.js';
import { assessProjectDomain } from '../src/project-domain-rules.js';

const jobFile = process.argv[2];
if (!jobFile) throw new Error('usage: node scripts/restore-abandoned-project.mjs <job.json>');

const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
if (job.status !== 'abandoned' || job.abandonReason !== 'codex_hard_rule') {
  throw new Error('only a project abandoned by a Codex hard-rule decision can be restored');
}
const artifactsDir = path.join(path.dirname(jobFile), 'artifacts');
const candidates = ['project-plan.json', 'project-plan-simplified.json'];
let plan;
let complexity;
let domainPolicy;
let quality;
for (const name of candidates) {
  const candidate = JSON.parse(await fs.readFile(path.join(artifactsDir, name), 'utf8'));
  const candidateComplexity = assessProjectComplexity(candidate);
  const candidateDomain = assessProjectDomain(candidate);
  const candidateQuality = assessGeneratedProjectPlan({
    ...candidate,
    project_tier: job.request?.projectTier || 'standard',
    frontend_required: Boolean(job.request?.frontendRequired),
  });
  if (candidateDomain.ok && candidateQuality.ok) {
    plan = candidate;
    complexity = candidateComplexity;
    domainPolicy = candidateDomain;
    quality = candidateQuality;
    break;
  }
}
if (!plan) throw new Error('no retained plan satisfies the domain and code-size gates');

const readThreadId = async (name) => {
  const content = await fs.readFile(path.join(artifactsDir, name), 'utf8');
  return content.match(/"thread_id":"([^"]+)"/)?.[1] || '';
};
const planningSessionId = await readThreadId('project-plan.codex.jsonl');
const simplificationSessionId = await readThreadId('project-plan-simplified.codex.jsonl');
const now = new Date().toISOString();
job.project = {
  ...plan,
  project_tier: job.request?.projectTier || 'standard',
  frontend_required: Boolean(job.request?.frontendRequired),
  planningSessionId,
  ...(simplificationSessionId ? { simplificationSessionId } : {}),
  complexity,
  domainPolicy,
};
const projectPlanStage = (job.stages || []).find((stage) => stage.id === 'project_plan');
if (!projectPlanStage) throw new Error('project_plan stage is missing');
projectPlanStage.status = 'passed';
projectPlanStage.error = '';
projectPlanStage.finishedAt = now;
projectPlanStage.result = {
  projectSlug: plan.project_slug,
  sessionId: planningSessionId,
  simplificationSessionId,
  complexity,
};
job.status = 'failed';
job.currentStage = 'project_generate';
job.error = '';
job.finishedAt = null;
job.updatedAt = now;
job.autoRetryCount = 0;
job.repositoryDisposition = 'provisioned';
for (const field of [
  'abandonedAt',
  'abandonmentApprovedAt',
  'abandonmentApprovalIncidentId',
  'abandonReason',
  'failureCategory',
]) delete job[field];
job.schedulerLease = null;
job.waitingResource = null;
job.runStartedAt = null;
job.runnerPid = null;
job.lastAutoRetryAt = null;
job.logs = [...(job.logs || []), {
  at: now,
  level: 'info',
  stageId: 'project_generate',
  message: '已按新规则恢复原项目规划：复杂度维度不再作为硬门禁，项目进入生成队列。',
}].slice(-300);
await fs.writeFile(jobFile, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ id: job.id, status: job.status, currentStage: job.currentStage, project: job.project.project_slug, dimensions: complexity.dimensions }));
