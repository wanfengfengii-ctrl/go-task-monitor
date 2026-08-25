#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildGoldRootCause, isChineseDescription, naturalizeGoldRootCause, stripMarkdownBackticks } from '../src/export-rules.js';
import { getGoldRootCauseRuleIssues } from '../src/review-rules.js';
import { createPackageSupportFiles } from '../src/package-build-rules.js';
import { goEmbeddedDistDirectories } from '../src/embedded-assets.js';
import { findFrontendDir, scanAnswerLeakage } from '../src/package-rules.js';
import {
  CURRENT_PROJECT_PACKAGE_POLICY_VERSION,
  isBugReproPath,
  projectPackageRuleOptions,
  validateProjectPackagePlan,
} from '../src/project-package-policy.js';
import { classifyPipelineFailure, projectPlanCheckpointConsumed, shouldRegenerateGeneratedProject } from '../src/pipeline-concurrency.js';
import { classifyTrajectoryAttemptFailure, goldTestNamespace, isSystemTrajectoryFailure } from '../src/grader-guards.js';
import {
  createPipelineStages,
  CURRENT_WORKFLOW_VERSION,
  CURRENT_WORKFLOW_POLICY_VERSION,
  PARALLEL_BUG_WORKFLOW_VERSION,
  isPipelineBugDeliveryComplete,
  isSkippedPipelineBug,
  pipelineProjectDeliverySummary,
  markPipelineBugFailed,
  markPipelineBugSkipped,
  markPipelineTrajectorySkippedPendingVerification,
  invalidatePipelineVerificationAfterMissingTestAuthor,
  reactivateFrozenVerificationFailures,
  MAX_BUG_TRAJECTORY_ATTEMPTS,
  MAX_BUG_STAGE_AUTO_RETRIES,
  countedBugTrajectoryAttempts,
  queuePipelineBugStageRetry,
  queuePipelineGoldContractRetry,
  remainingBugTrajectoryAttempts,
  upgradeUnfinishedPipelineBugQuota,
} from '../src/pipeline-rules.js';
import { beginBugAttempt, finishBugAttempt, nextIncompleteBugIndex, normalizeBugExecution, takeBugRetryQueue } from '../src/bug-workbench.js';
import { nextPipelineStage, pipelineResourcePolicy, pipelineStageHealthBlockers, pipelineStageRequiredServices, pipelineStageResourceProfile, pipelineStructuredCodexLimit } from '../src/pipeline-operations.js';
import {
  DISTRIBUTED_WORKER_PROTOCOL_VERSION,
  normalizePipelineNodeRole,
  PIPELINE_NODE_ROLES,
  pipelineStageExecutionRole,
  prepareRemoteRepairHandoff,
} from '../src/distributed-workers.js';
import { assertProtectedSnapshotPath, claudeGenerationSandbox, criticalSnapshotTarOptions } from '../src/data-protection.js';
import { assessProjectComplexity, PROJECT_COMPLEXITY_LIMITS } from '../src/project-complexity.js';
import {
  assessGeneratedProjectPlan,
  assessGeneratedProjectQuality,
  GENERATED_PROJECT_SPEC_FILE,
  GENERATED_PROJECT_QUALITY_LIMITS,
  LEGACY_GENERATED_PROJECT_QUALITY_LIMITS,
  PROJECT_QUALITY_POLICY_VERSION,
  renderGeneratedProjectSpec,
} from '../src/generated-project-quality.js';
import {
  BUG_AFFECTED_LAYERS,
  BUG_DIFFICULTY_POLICY_VERSION,
  BUG_QUERY_POLICY_VERSION,
  BUG_MECHANISMS,
  BUG_RUNTIME_MECHANISMS,
  BUG_TAXONOMY_POLICY_VERSION,
  TASK_SUBTYPES,
  bugDifficultyPolicyText,
  normalizeBugCategory,
  userQueryAuthoringPolicyText,
  validateBugDifficulty,
  validateBugTaxonomy,
  validateRootCauseFileConcentration,
} from '../src/bug-policy.js';
import { assessProjectDomain, prohibitedProjectDomainPolicyText } from '../src/project-domain-rules.js';
import { buildVerificationResult, VERIFICATION_POLICY_VERSION } from '../src/verification-evidence.js';
import { directPublicVerifyCommandIssues, isConcurrencyVerificationRecord, verificationCommandsSha256 } from '../src/verification-proof.js';
import { verificationTestNamesFromCommand, buildModelVerificationPlan, goTestNames, isTableDrivenGoTest, modelVerificationPlanIssues, verificationTestPackage } from '../src/model-verification.js';
import { normalizeDiagnosisPublicCommand, normalizeDiagnosisVerificationSource } from '../src/diagnosis-verification.js';
import {
  createVerificationCoverageAttestation,
  VERIFICATION_COVERAGE_POLICY_VERSION,
} from '../src/verification-coverage.js';
import {
  buildVerificationCoverageChecklist,
  formatVerificationCoverageChecklist,
  verificationCoverageChecklistIssues,
  VERIFICATION_COVERAGE_CHECKLIST_VERSION,
} from '../src/verification-coverage-checklist.js';
import { withFileLock } from '../src/file-lock.js';
import { parseMutationAudit } from '../src/trajectory-audit.js';
import { validateDiagnosisReadOnlyEvents, validateTrajectoryIntegrityEvents } from '../src/trajectory-file-validator.js';
import { selectClaudeGateway } from './select-claude-gateway.mjs';

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectValidatorPath = path.join(monitorRoot, 'scripts/validate-go-package.mjs');
const trajectoryValidatorPath = path.join(monitorRoot, 'scripts/validate-trajectories.mjs');
const taskRunnerPath = path.join(monitorRoot, 'run_one_claude.sh');
const verificationRunnerPath = path.join(monitorRoot, 'run_verify_claude.sh');
const codexBin = process.env.GO_PIPELINE_CODEX_BIN || 'codex';
const claudeBin = process.env.GO_PIPELINE_CLAUDE_BIN
  || (process.platform === 'darwin' ? '/Users/niuyuhang/.npm-global/bin/claude' : 'claude');
const maxCommandOutput = 2 * 1024 * 1024;
// The monitor's cloud uploader may perform four 90-second requests plus
// backoff and an authentication refresh.  Keep the caller deadline longer
// than that server-side retry window so a completed proof is not reported as
// failed merely because the outer request timed out first.
const PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS = 12 * 60 * 1000;
const execFileAsync = promisify(execFile);
const DETERMINISTIC_TEST_RUNS = 20;
const configuredProjectBugWorkerLimit = Number(process.env.GO_PIPELINE_PROJECT_BUG_WORKER_LIMIT || 4);
const PROJECT_BUG_MAX_WORKER_LIMIT = Math.max(1, Math.min(4,
  Number.isFinite(configuredProjectBugWorkerLimit) ? configuredProjectBugWorkerLimit : 4));
const configuredProjectBugMinWorkerLimit = Number(process.env.GO_PIPELINE_PROJECT_BUG_MIN_WORKER_LIMIT || 1);
const PROJECT_BUG_MIN_WORKER_LIMIT = Math.max(1, Math.min(PROJECT_BUG_MAX_WORKER_LIMIT,
  Number.isFinite(configuredProjectBugMinWorkerLimit) ? configuredProjectBugMinWorkerLimit : 1));
const configuredBugSourceWorkerLimit = Number(process.env.GO_PIPELINE_BUG_SOURCE_WORKER_LIMIT || 4);
const PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT = Math.max(2, Math.min(4,
  Number.isFinite(configuredBugSourceWorkerLimit) ? configuredBugSourceWorkerLimit : 4));
const configuredDockerRunCpuLimit = Number(process.env.GO_PIPELINE_DOCKER_RUN_CPUS || 4);
export const DOCKER_RUN_CPU_LIMIT = Math.max(1, Math.min(4,
  Number.isFinite(configuredDockerRunCpuLimit) ? configuredDockerRunCpuLimit : 4));
const MAX_INJECTION_SLOT_ATTEMPTS = 3;
const monitorApiUrl = process.env.GO_TASK_MONITOR_API_URL || `http://127.0.0.1:${process.env.GO_TASK_MONITOR_API_PORT || 4174}`;
const configuredPipelineExecutionRole = String(process.env.GO_PIPELINE_EXECUTION_ROLE || '').trim().toLowerCase();
if (configuredPipelineExecutionRole && !PIPELINE_NODE_ROLES.has(configuredPipelineExecutionRole)) {
  throw new Error(`GO_PIPELINE_EXECUTION_ROLE 不合法：${configuredPipelineExecutionRole}`);
}
const pipelineExecutionRole = normalizePipelineNodeRole(configuredPipelineExecutionRole);
const remoteWorkerId = String(process.env.GO_PIPELINE_WORKER_ID || '').trim();
const remoteWorkerToken = String(process.env.GO_PIPELINE_WORKER_TOKEN || '').trim();
const remoteWorkerLeaseId = String(process.env.GO_PIPELINE_REMOTE_LEASE_ID || '').trim();
// Project generation is deliberately not bounded by a wall-clock deadline.
// A large generated project can spend a long time compiling and repairing its
// own tests; terminating the Claude session while it is making progress only
// discards useful work and forces another session to repeat it. A timeout of
// zero is the runCommand sentinel for "no total timeout".
const PROJECT_GENERATION_BUDGET_MS = Infinity;
const PROJECT_FOUNDATION_TIMEOUT_MS = 0;
const PROJECT_COMPLETION_TIMEOUT_MS = 0;
const PROJECT_REPAIR_TIMEOUT_MS = 0;
const PROJECT_FIRST_FILE_TIMEOUT_MS = 0;
const PROJECT_GENERATION_IDLE_TIMEOUT_MS = 15 * 60_000;
const configuredProjectGenerationProgressTimeoutMs = Number(process.env.GO_PIPELINE_PROJECT_GENERATION_PROGRESS_TIMEOUT_MS || 12 * 60_000);
const PROJECT_GENERATION_PROGRESS_TIMEOUT_MS = Number.isFinite(configuredProjectGenerationProgressTimeoutMs)
  && configuredProjectGenerationProgressTimeoutMs > 0
  ? configuredProjectGenerationProgressTimeoutMs
  : 12 * 60_000;
const configuredProjectGenerationActiveWorkGraceMs = Number(process.env.GO_PIPELINE_PROJECT_GENERATION_ACTIVE_WORK_GRACE_MS || 5 * 60_000);
const PROJECT_GENERATION_ACTIVE_WORK_GRACE_MS = Number.isFinite(configuredProjectGenerationActiveWorkGraceMs)
  && configuredProjectGenerationActiveWorkGraceMs > 0
  ? configuredProjectGenerationActiveWorkGraceMs
  : 5 * 60_000;
const PROJECT_VALIDATION_PLATFORMS = ['linux/arm64', 'linux/amd64'];
const PROJECT_VALIDATION_INFRA_RETRIES = 2;
const PROJECT_VALIDATION_IDLE_TIMEOUT_MS = 15 * 60_000;

function bugWorkerOrder(job, execution = normalizeBugExecution(job?.bugExecution)) {
  const queuedRetries = [...new Set((job?.pendingBugRetries || [])
    .map(Number)
    .filter((index) => Number.isInteger(index) && index > 0))]
    .filter((index) => !isPipelineBugDeliveryComplete(job, index)
      && !isSkippedPipelineBug(job?.bugs?.find((item) => Number(item.bugIndex) === index)))
    .sort((left, right) => left - right);
  const persistedSelection = Number(execution.selectedBugIndex);
  const persistedBug = job?.bugs?.find((item) => Number(item.bugIndex) === persistedSelection);
  const persistedSelectionIsRunnable = Number.isInteger(persistedSelection)
    && persistedSelection > 0
    && !isPipelineBugDeliveryComplete(job, persistedSelection)
    && !isSkippedPipelineBug(persistedBug);
  const selectedBugIndex = queuedRetries[0]
    || (persistedSelectionIsRunnable ? persistedSelection : null)
    || nextIncompleteBugIndex(job, 1)
    || persistedSelection
    || 1;
  if (execution.autoContinue === false) return [selectedBugIndex];
  const remaining = Array.from({ length: Number(job?.request?.bugCount || 0) }, (_, index) => index + 1)
    .filter((index) => index !== selectedBugIndex
      && !queuedRetries.includes(index)
      && !isPipelineBugDeliveryComplete(job, index)
      && !isSkippedPipelineBug(job?.bugs?.find((item) => Number(item.bugIndex) === index)));
  return [...queuedRetries, ...(queuedRetries.includes(selectedBugIndex) ? [] : [selectedBugIndex]), ...remaining];
}
// A live Claude stream regularly emits tool or model events. Treat a fully
// silent stream as stalled after 15 minutes while retaining the separate
// two-hour total safety budget for sessions that keep making progress.
const configuredClaudeFixIdleTimeoutMs = Number(process.env.GO_PIPELINE_CLAUDE_FIX_IDLE_TIMEOUT_MS || 15 * 60_000);
const CLAUDE_FIX_IDLE_TIMEOUT_MS = Number.isFinite(configuredClaudeFixIdleTimeoutMs) && configuredClaudeFixIdleTimeoutMs > 0
  ? configuredClaudeFixIdleTimeoutMs
  : 15 * 60_000;
const configuredClaudeFixTimeoutMs = Number(process.env.GO_PIPELINE_CLAUDE_FIX_TIMEOUT_MS || 120 * 60_000);
const CLAUDE_FIX_TIMEOUT_MS = Number.isFinite(configuredClaudeFixTimeoutMs) && configuredClaudeFixTimeoutMs > 0
  ? configuredClaudeFixTimeoutMs
  : 120 * 60_000;
// File progress is recorded for observability only. A repair Session may spend
// a long time reading ordinary source before its first edit, so never kill a
// healthy child merely because 1200 seconds passed without a file mutation.
// The explicit command budget and activity-aware idle guard remain in force.
const configuredClaudeFixProgressTimeoutMs = Number(process.env.GO_PIPELINE_CLAUDE_FIX_PROGRESS_TIMEOUT_MS || 0);
const CLAUDE_FIX_PROGRESS_TIMEOUT_MS = Number.isFinite(configuredClaudeFixProgressTimeoutMs) && configuredClaudeFixProgressTimeoutMs > 0
  ? configuredClaudeFixProgressTimeoutMs
  : 0;
const configuredClaudeFixInitialProgressGraceMs = Number(process.env.GO_PIPELINE_CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS || 0);
const CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS = Number.isFinite(configuredClaudeFixInitialProgressGraceMs) && configuredClaudeFixInitialProgressGraceMs > 0
  ? configuredClaudeFixInitialProgressGraceMs
  : 0;
// Natural Bug discovery may need a full cross-package read and a temporary
// reproduction harness before it can emit the structured candidate pool. Give
// each parallel partition enough time to finish rather than treating a slow
// Codex session as an empty project.
const configuredNaturalBugFinderTimeoutMs = Number(process.env.GO_PIPELINE_NATURAL_BUG_FINDER_TIMEOUT_MS || 15 * 60_000);
const configuredNaturalBugReviewTimeoutMs = Number(process.env.GO_PIPELINE_NATURAL_BUG_BATCH_REVIEW_TIMEOUT_MS || 12 * 60_000);
const configuredNaturalBugFinderSoftBudgetMs = Number(process.env.GO_PIPELINE_NATURAL_BUG_FINDER_SOFT_BUDGET_MS || 8 * 60_000);
const NATURAL_BUG_FINDER_TIMEOUT_MS = Number.isFinite(configuredNaturalBugFinderTimeoutMs) && configuredNaturalBugFinderTimeoutMs > 0
  ? Math.max(5 * 60_000, configuredNaturalBugFinderTimeoutMs)
  : 15 * 60_000;
const NATURAL_BUG_BATCH_REVIEW_TIMEOUT_MS = Number.isFinite(configuredNaturalBugReviewTimeoutMs) && configuredNaturalBugReviewTimeoutMs > 0
  ? Math.max(5 * 60_000, configuredNaturalBugReviewTimeoutMs)
  : 12 * 60_000;
const NATURAL_BUG_FINDER_SOFT_BUDGET_MS = Number.isFinite(configuredNaturalBugFinderSoftBudgetMs)
  && configuredNaturalBugFinderSoftBudgetMs > 0
  ? Math.min(NATURAL_BUG_FINDER_TIMEOUT_MS, Math.max(2 * 60_000, configuredNaturalBugFinderSoftBudgetMs))
  : 8 * 60_000;
// This runner-wide setting is applied to every natural-Bug finder partition
// for every project; a disconnected partition is retried while completed
// partition candidates remain persisted for reuse.
const configuredNaturalBugStreamRecoveryWindowMs = Number(process.env.GO_PIPELINE_NATURAL_BUG_STREAM_RECOVERY_WINDOW_MS || 2 * 60_000);
const NATURAL_BUG_STREAM_RECOVERY_WINDOW_MS = Number.isFinite(configuredNaturalBugStreamRecoveryWindowMs)
  && configuredNaturalBugStreamRecoveryWindowMs > 0
  ? Math.max(10_000, configuredNaturalBugStreamRecoveryWindowMs)
  : 2 * 60_000;
const CODEX_STREAM_RECOVERY_MAX_RETRIES = 100;
const configuredCodexJsonIdleTimeoutMs = Number(process.env.GO_PIPELINE_CODEX_JSON_IDLE_TIMEOUT_MS || 6 * 60_000);
const CODEX_JSON_IDLE_TIMEOUT_MS = Number.isFinite(configuredCodexJsonIdleTimeoutMs) && configuredCodexJsonIdleTimeoutMs > 0
  ? Math.max(60_000, configuredCodexJsonIdleTimeoutMs)
  : 6 * 60_000;
const configuredProjectPlanStreamRecoveryWindowMs = Number(process.env.GO_PIPELINE_PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS || 2 * 60_000);
const PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS = Number.isFinite(configuredProjectPlanStreamRecoveryWindowMs)
  && configuredProjectPlanStreamRecoveryWindowMs > 0
  ? Math.max(30_000, configuredProjectPlanStreamRecoveryWindowMs)
  : 2 * 60_000;
const configuredProjectPlanTimeoutMs = Number(process.env.GO_PIPELINE_PROJECT_PLAN_TIMEOUT_MS || 15 * 60_000);
const PROJECT_PLAN_TIMEOUT_MS = Number.isFinite(configuredProjectPlanTimeoutMs) && configuredProjectPlanTimeoutMs > 0
  ? Math.max(5 * 60_000, configuredProjectPlanTimeoutMs)
  : 15 * 60_000;
const configuredStructuredCodexTimeoutMs = Number(process.env.GO_PIPELINE_STRUCTURED_CODEX_TIMEOUT_MS || 15 * 60_000);
const STRUCTURED_CODEX_TIMEOUT_MS = Number.isFinite(configuredStructuredCodexTimeoutMs) && configuredStructuredCodexTimeoutMs > 0
  ? Math.max(5 * 60_000, configuredStructuredCodexTimeoutMs)
  : 15 * 60_000;
const configuredStructuredCodexStreamRecoveryWindowMs = Number(process.env.GO_PIPELINE_STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS || 2 * 60_000);
const STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS = Number.isFinite(configuredStructuredCodexStreamRecoveryWindowMs)
  && configuredStructuredCodexStreamRecoveryWindowMs > 0
  ? Math.max(30_000, configuredStructuredCodexStreamRecoveryWindowMs)
  : 2 * 60_000;

export function codexStreamRecoveryConfigArgs(streamRecoveryWindowMs, providerId = process.env.GO_PIPELINE_CODEX_MODEL_PROVIDER) {
  const recoveryWindowMs = Number(streamRecoveryWindowMs || 0);
  const provider = String(providerId || '').trim();
  if (!Number.isFinite(recoveryWindowMs) || recoveryWindowMs <= 0 || !provider) return [];
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) throw new Error(`非法 Codex provider 标识：${provider}`);
  // Built-in providers are reserved and cannot be overridden through
  // model_providers. Only tune a custom provider that the operator selected.
  if (['openai', 'ollama', 'lmstudio'].includes(provider)) return [];
  return ['-c', `model_providers.${provider}.stream_max_retries=${CODEX_STREAM_RECOVERY_MAX_RETRIES}`];
}

// Jobs created before the Git workflow policy marker do not have
// workflowPolicyVersion in their persisted record.  Keep the marker migration
// for metadata compatibility, but do not use it to select the retired private
// verification-fixture workflow.
export function migrateWorkflowPolicyVersion(job = {}) {
  const workflowVersion = Number(job.workflowVersion || 1);
  const policyVersion = Number(job.workflowPolicyVersion || 0);
  if (workflowVersion < CURRENT_WORKFLOW_VERSION || policyVersion >= CURRENT_WORKFLOW_POLICY_VERSION) {
    return { job, changed: false };
  }
  return {
    job: { ...job, workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION },
    changed: true,
  };
}

// Verification-coverage review was retired by workflow v3. A stale job-level
// policy from an earlier run must not resurrect that stage and reset a valid
// Claude fix; only pre-v3 jobs that explicitly carried the old policy remain
// compatible with the historical review path.
function legacyVerificationCoverageEnabled(job = {}) {
  return Number(job.workflowVersion || 1) < CURRENT_WORKFLOW_VERSION
    && Number(job.verificationCoveragePolicyVersion || 0) >= VERIFICATION_COVERAGE_POLICY_VERSION;
}

// V5 red/green proofs are not self-describing: the delivery attestation also
// needs the semantic coverage report that ties verify_cmds back to user_query.
// The old workflow flag only controlled the legacy Gold-time review, so using
// it for V5 tasks caused "skipped" coverage stages to fail during finalization.
function verificationCoverageRequired(job = {}) {
  return Number(job.verificationPolicyVersion || 0) >= VERIFICATION_POLICY_VERSION
    || legacyVerificationCoverageEnabled(job);
}
// Scores below 4 indicate that the candidate is too shallow, weakly evidenced,
// or not sufficiently independent for a benchmark Bug slot.
export const NATURAL_BUG_MIN_REVIEW_SCORE = 3;
// The scheduler may inspect a newly-created slot before owner.json is published.
// Keep this window short, but long enough for the atomic owner write to finish.
const RESOURCE_SLOT_ACQUIRE_GRACE_MS = 30_000;
const FAST_COPY_MODE = fs.constants.COPYFILE_FICLONE || 0;
const activeChildren = new Set();
let activeJobFile = '';
let runnerHeartbeatTimer = null;
let jobUpdateTail = Promise.resolve();
const publicMetadataUpdateTails = new Map();
const jsonWriteTails = new Map();
let jsonWriteSequence = 0;

async function runBoundedWorkers(items, limit, worker, { stopOnError = false } = {}) {
  const queue = [...items];
  const failures = [];
  let stopped = false;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), queue.length) }, async () => {
    while (queue.length && !stopped) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        failures.push({ item, error });
        if (stopOnError) stopped = true;
      }
    }
  });
  await Promise.all(workers);
  if (failures.length) {
    const primary = failures[0].error instanceof Error
      ? failures[0].error
      : new Error(String(failures[0].error));
    primary.workerFailures = failures;
    throw primary;
  }
}

export async function runAdaptiveBoundedWorkers(items, initialLimit, worker, {
  stopOnError = false,
  refreshLimit = null,
  refreshIntervalMs = 10_000,
  onLimitChange = null,
} = {}) {
  const queue = [...items];
  const failures = [];
  const running = new Set();
  let stopped = false;
  let limit = Math.max(1, Number(initialLimit) || 1);

  const launch = (item) => {
    const task = Promise.resolve()
      .then(() => worker(item))
      .catch((error) => {
        failures.push({ item, error });
        if (stopOnError) stopped = true;
      })
      .finally(() => running.delete(task));
    running.add(task);
  };

  while ((queue.length || running.size) && !stopped) {
    if (typeof refreshLimit === 'function') {
      const refreshed = Math.max(1, Number(await refreshLimit().catch(() => limit)) || limit);
      if (refreshed !== limit) {
        const previous = limit;
        limit = refreshed;
        if (typeof onLimitChange === 'function') await onLimitChange({ previous, current: limit });
      }
    }
    while (queue.length && running.size < limit && !stopped) launch(queue.shift());
    if (!running.size) break;
    const waiters = [...running];
    if (queue.length && typeof refreshLimit === 'function') {
      waiters.push(new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(refreshIntervalMs) || 10_000))));
    }
    await Promise.race(waiters);
  }

  await Promise.all([...running]);
  if (failures.length) {
    const primary = failures[0].error instanceof Error
      ? failures[0].error
      : new Error(String(failures[0].error));
    primary.workerFailures = failures;
    throw primary;
  }
}

async function runBoundedSettled(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function adaptiveBugSourceWorkerLimit({
  configuredMax = PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT,
  resources = {},
  analysisRunnerCount = 1,
  analysisPoolLimit = PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT,
} = {}) {
  const configured = Math.max(1, Math.min(4, Number(configuredMax) || 4));
  const poolLimit = Math.max(1, Math.min(4, Number(analysisPoolLimit) || configured));
  const participants = Math.max(1, Number(analysisRunnerCount) || 1);
  let limit = Math.min(configured, Math.max(1, Math.floor(poolLimit / participants)));
  const memoryAvailablePercent = Number(resources.memoryAvailablePercent);
  const loadRatio = Number(resources.loadRatio || 0);
  if (Number.isFinite(memoryAvailablePercent)) {
    if (memoryAvailablePercent < 20) limit = Math.min(limit, 1);
    else if (memoryAvailablePercent < 35) limit = Math.min(limit, 2);
  }
  if (loadRatio >= 3) limit = Math.min(limit, 1);
  else if (loadRatio >= 2.5) limit = Math.min(limit, 2);
  return Math.max(1, limit);
}

async function activePipelineRunnerCount() {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { maxBuffer: 2 * 1024 * 1024 });
    return Math.max(1, stdout.split(/\r?\n/).filter((line) => /(?:^|[\s/])run-production-pipeline\.mjs(?:\s|$)/.test(line)).length);
  } catch {
    return 1;
  }
}

async function currentBugSourceWorkerLimit() {
  const fallbackResources = {
    loadRatio: os.loadavg()[0] / Math.max(1, os.cpus().length),
  };
  const [pipelineSnapshot, healthSnapshot] = await Promise.all([
    fetch(`${monitorApiUrl}/api/pipeline/jobs`, { signal: AbortSignal.timeout(5_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch(() => null),
    fetch(`${monitorApiUrl}/api/system/health`, { signal: AbortSignal.timeout(5_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch(() => null),
  ]);
  const analysisPool = pipelineSnapshot?.resourcePools?.['compute-analysis'];
  return adaptiveBugSourceWorkerLimit({
    resources: healthSnapshot?.resources || fallbackResources,
    analysisRunnerCount: analysisPool?.occupied || 1,
    analysisPoolLimit: analysisPool?.limit || PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT,
  });
}

export function adaptiveProjectBugWorkerLimit({
  configuredMax = PROJECT_BUG_MAX_WORKER_LIMIT,
  configuredMin = PROJECT_BUG_MIN_WORKER_LIMIT,
  resources = {},
  activeRunnerCount = 1,
} = {}) {
  const configured = Math.max(1, Math.min(4, Number(configuredMax) || 4));
  const minimum = Math.max(1, Math.min(configured, Number(configuredMin) || 1));
  const resourceLimit = pipelineResourcePolicy(resources, { configuredMax: configured }).effectiveMaxConcurrency;
  const fairShareLimit = Number(activeRunnerCount) >= 2 ? 2 : configured;
  return Math.max(minimum, Math.min(configured, resourceLimit || 1, fairShareLimit));
}

function remainingPublicBugCount(job = {}) {
  return (job.bugs || []).filter((bug) => {
    const status = String(bug?.workbench?.status || 'bug_ready');
    const disposition = String(bug?.disposition || '');
    if (['delivered', 'failed', 'skipped'].includes(disposition) || bug?.failureDisposition === 'auto_continued') return false;
    return !['delivered', 'fast_lane_completed', 'fast_lane_failed'].includes(status);
  }).length;
}

export function elasticProjectBugWorkerLimit({
  jobId = '',
  baseLimit = 1,
  maxWorkerLimit = PROJECT_BUG_MAX_WORKER_LIMIT,
  activeJobs = [],
  projectCapacity = 4,
} = {}) {
  const baseline = Math.max(1, Math.min(Number(maxWorkerLimit) || 1, Number(baseLimit) || 1));
  const active = (activeJobs || [])
    .filter((job) => job?.id && ['queued', 'running', 'waiting_resource'].includes(String(job.status || '')))
    .map((job) => ({ job, remaining: remainingPublicBugCount(job) }))
    .filter((item) => item.remaining > 0)
    .sort((left, right) => right.remaining - left.remaining
      || String(left.job.startedAt || left.job.createdAt || '').localeCompare(String(right.job.startedAt || right.job.createdAt || ''))
      || String(left.job.id).localeCompare(String(right.job.id)));
  if (!jobId || !active.some((item) => item.job.id === jobId)) return baseline;

  const idleProjectSlots = Math.max(0, Math.floor(Number(projectCapacity) || 0) - active.length);
  const bonuses = new Map(active.map((item) => [item.job.id, 0]));
  for (let slot = 0; slot < idleProjectSlots; slot += 1) {
    const recipient = active
      .filter((item) => baseline + Number(bonuses.get(item.job.id) || 0) < maxWorkerLimit)
      .sort((left, right) => Number(bonuses.get(left.job.id) || 0) - Number(bonuses.get(right.job.id) || 0)
        || right.remaining - left.remaining
        || String(left.job.id).localeCompare(String(right.job.id)))[0];
    if (!recipient) break;
    bonuses.set(recipient.job.id, Number(bonuses.get(recipient.job.id) || 0) + 1);
  }
  const elasticLimit = baseline + Number(bonuses.get(jobId) || 0);
  const configuredOverride = Number(active.find((item) => item.job.id === jobId)?.job?.bugWorkerLimitOverride || 0);
  const requestedLimit = Number.isInteger(configuredOverride) && configuredOverride >= 1
    ? configuredOverride
    : elasticLimit;
  return Math.min(maxWorkerLimit, Math.max(elasticLimit, requestedLimit));
}

export function projectBugWorkerCeiling({
  baseLimit = 1,
  resourceLimit = 1,
  workerLimitOverride = 0,
  canStart = true,
  maxWorkerLimit = PROJECT_BUG_MAX_WORKER_LIMIT,
} = {}) {
  const maximum = Math.max(1, Number(maxWorkerLimit) || 1);
  const adaptiveLimit = Math.max(1, Math.min(maximum,
    Math.max(Number(baseLimit) || 1, Number(resourceLimit) || 1)));
  const explicitLimit = Number(workerLimitOverride);
  const hasExplicitLimit = Number.isInteger(explicitLimit)
    && explicitLimit >= 1
    && explicitLimit <= maximum;
  return canStart !== false && hasExplicitLimit ? maximum : adaptiveLimit;
}

async function currentProjectBugWorkerLimit(jobId = '') {
  if (pipelineExecutionRole === 'repair-worker') {
    const configured = Math.max(1, Math.min(4, Number(process.env.GO_PIPELINE_REMOTE_BUG_WORKER_LIMIT || 4)));
    const resources = {
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem(),
      memoryAvailablePercent: (os.freemem() / Math.max(1, os.totalmem())) * 100,
      loadRatio: os.loadavg()[0] / Math.max(1, os.cpus().length),
    };
    return adaptiveProjectBugWorkerLimit({
      configuredMax: configured,
      configuredMin: 1,
      resources,
      activeRunnerCount: await activePipelineRunnerCount(),
    });
  }
  const [pipelineSnapshot, resources] = await Promise.all([
    fetch(`${monitorApiUrl}/api/pipeline/jobs`, { signal: AbortSignal.timeout(5_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch(() => null),
    fetch(`${monitorApiUrl}/api/system/health`, { signal: AbortSignal.timeout(5_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).resources || {};
      })
      .catch(() => ({
        freeMemoryBytes: os.freemem(),
        totalMemoryBytes: os.totalmem(),
        loadRatio: os.loadavg()[0] / Math.max(1, os.cpus().length),
      })),
  ]);
  const activeRunnerCount = Number(pipelineSnapshot?.activeCount) || await activePipelineRunnerCount();
  const baseLimit = adaptiveProjectBugWorkerLimit({ activeRunnerCount, resources });
  const resourceLimit = pipelineResourcePolicy(resources, { configuredMax: PROJECT_BUG_MAX_WORKER_LIMIT }).effectiveMaxConcurrency;
  const activeJobs = pipelineSnapshot?.jobs || [];
  const selectedJob = activeJobs.find((item) => item?.id === jobId);
  const maxWorkerLimit = projectBugWorkerCeiling({
    baseLimit,
    resourceLimit,
    workerLimitOverride: selectedJob?.bugWorkerLimitOverride,
    canStart: pipelineSnapshot?.resourcePolicy?.canStart,
  });
  return elasticProjectBugWorkerLimit({
    jobId,
    baseLimit,
    maxWorkerLimit,
    activeJobs,
    projectCapacity: pipelineSnapshot?.effectiveMaxConcurrency || activeRunnerCount,
  });
}

const DEFAULT_PROJECT_GENERATOR_PROVIDER = 'claude';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro[1m]';
const DEFAULT_BUGFIX_MODEL = 'model_hub/glm-52-coding';
const CHILD_SECRET_ENV_NAMES = [
  'GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN',
  'GO_PIPELINE_PROJECT_GENERATOR_API_KEY',
  'GO_PIPELINE_WORKER_TOKEN',
  'GO_PIPELINE_REMOTE_LEASE_ID',
  'GO_TASK_MONITOR_CLOUD_USERNAME',
  'GO_TASK_MONITOR_CLOUD_PASSWORD',
];

export function projectGeneratorConfig(environment = process.env) {
  const provider = String(environment.GO_PIPELINE_PROJECT_GENERATOR_PROVIDER || DEFAULT_PROJECT_GENERATOR_PROVIDER)
    .trim().toLowerCase();
  const effort = String(environment.GO_PIPELINE_PROJECT_GENERATOR_EFFORT || environment.CLAUDE_EFFORT || 'low').trim() || 'low';
  if (provider === DEFAULT_PROJECT_GENERATOR_PROVIDER) {
    return { provider, model: '', effort, baseUrl: '', authToken: '', subagentModel: '' };
  }
  if (provider !== 'deepseek') throw new Error(`不支持的项目生成器：${provider}；可选 claude 或 deepseek`);
  const authToken = String(environment.GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN
    || environment.GO_PIPELINE_PROJECT_GENERATOR_API_KEY || '').trim();
  if (!authToken) throw new Error('项目生成器已配置为 deepseek，但缺少 GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN');
  const baseUrl = String(environment.GO_PIPELINE_PROJECT_GENERATOR_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL).trim();
  const model = String(environment.GO_PIPELINE_PROJECT_GENERATOR_MODEL || DEFAULT_DEEPSEEK_MODEL).trim();
  const subagentModel = String(environment.GO_PIPELINE_PROJECT_GENERATOR_SUBAGENT_MODEL || 'deepseek-v4-flash').trim();
  if (!baseUrl) throw new Error('项目生成器已配置为 deepseek，但缺少 GO_PIPELINE_PROJECT_GENERATOR_BASE_URL');
  if (!model) throw new Error('项目生成器已配置为 deepseek，但缺少 GO_PIPELINE_PROJECT_GENERATOR_MODEL');
  if (!subagentModel) throw new Error('项目生成器已配置为 deepseek，但缺少 GO_PIPELINE_PROJECT_GENERATOR_SUBAGENT_MODEL');
  return {
    provider,
    baseUrl,
    authToken,
    model,
    subagentModel,
    effort,
  };
}

export function bugfixModel(environment = process.env) {
  return String(environment.GO_PIPELINE_BUGFIX_MODEL || DEFAULT_BUGFIX_MODEL).trim() || DEFAULT_BUGFIX_MODEL;
}

export function bugfixEffort(attempt = 1, environment = process.env) {
  const retry = Number(attempt) > 1;
  const fallback = retry ? 'medium' : 'low';
  const configured = String(retry
    ? environment.GO_PIPELINE_BUGFIX_RETRY_EFFORT || fallback
    : environment.GO_PIPELINE_BUGFIX_EFFORT || fallback).trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(configured) ? configured : fallback;
}

function projectGeneratorEnvironment(config, isolatedConfigDir = '') {
  if (config.provider !== 'deepseek') return { env: {}, unsetEnv: [] };
  return {
    env: {
      CLAUDE_CONFIG_DIR: isolatedConfigDir,
      ANTHROPIC_BASE_URL: config.baseUrl,
      ANTHROPIC_AUTH_TOKEN: config.authToken,
      ANTHROPIC_API_KEY: config.authToken,
      ANTHROPIC_MODEL: config.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.subagentModel,
      CLAUDE_CODE_SUBAGENT_MODEL: config.subagentModel,
      CLAUDE_CODE_EFFORT_LEVEL: config.effort,
    },
    unsetEnv: [],
  };
}

export async function projectGeneratorGatewayEnvironment(
  config,
  { environment = process.env, settings = {}, fetchImpl = fetch } = {},
) {
  if (config.provider !== DEFAULT_PROJECT_GENERATOR_PROVIDER) {
    return { env: {}, selected: '', probes: [], model: '' };
  }
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {};
  const configuredGateways = environment.GO_PIPELINE_CLAUDE_GATEWAYS_JSON
    || settingsEnv.GO_PIPELINE_CLAUDE_GATEWAYS_JSON
    || settings?.goPipelineClaudeGateways
    || '';
  const raw = typeof configuredGateways === 'string'
    ? configuredGateways
    : JSON.stringify(configuredGateways);
  const fallback = String(environment.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  const model = String(
    environment.GO_PIPELINE_PROJECT_GENERATOR_MODEL
      || environment.ANTHROPIC_MODEL
      || settingsEnv.ANTHROPIC_MODEL
      || config.model
      || '',
  ).trim();
  const result = await selectClaudeGateway({
    raw,
    model,
    fallback,
    timeoutMs: environment.GO_PIPELINE_CLAUDE_GATEWAY_PROBE_TIMEOUT_MS,
    apiKey: environment.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY || '',
    authToken: environment.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN || '',
    fetchImpl,
  });
  return {
    env: result.selected ? { ANTHROPIC_BASE_URL: result.selected } : {},
    selected: result.selected,
    probes: result.probes,
    model,
  };
}

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'project_slug', 'title', 'project_type', 'project_summary', 'overview', 'business_flows', 'components', 'domain_rules',
    'data_model', 'interfaces', 'failure_boundaries', 'acceptance', 'test_scenarios',
    'component_traceability', 'uniqueness',
  ],
  properties: {
    project_slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
    title: { type: 'string', minLength: 3, maxLength: 100 },
    project_type: { enum: ['cli', 'web'] },
    project_summary: {
      type: 'string',
      minLength: 30,
      maxLength: 120,
      pattern: '^基于 Go 实现的[^,，。！？.!?：:\\r\\n]{2,40} (?:CLI 项目，一款命令行工具|Web 项目，一款(?:后端服务|前后端应用))，[^。！？.!?\\r\\n]{6,70}。$',
    },
    overview: { type: 'string', minLength: 30, maxLength: 700 },
    business_flows: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string', minLength: 30, maxLength: 350 } },
    components: { type: 'array', minItems: 2, maxItems: PROJECT_COMPLEXITY_LIMITS.maxComponents, items: { type: 'string', maxLength: 300 } },
    domain_rules: { type: 'array', minItems: 8, maxItems: 12, items: { type: 'string', minLength: 20, maxLength: 220 } },
    data_model: { type: 'array', minItems: 5, maxItems: 10, items: { type: 'string', minLength: 20, maxLength: 220 } },
    interfaces: { type: 'array', minItems: 5, maxItems: 12, items: { type: 'string', minLength: 20, maxLength: 220 } },
    failure_boundaries: { type: 'array', minItems: 5, maxItems: 10, items: { type: 'string', minLength: 20, maxLength: 250 } },
    acceptance: { type: 'array', minItems: 3, maxItems: PROJECT_COMPLEXITY_LIMITS.maxAcceptance, items: { type: 'string', maxLength: 350 } },
    test_scenarios: { type: 'array', minItems: 8, maxItems: 14, items: { type: 'string', minLength: 20, maxLength: 220 } },
    component_traceability: { type: 'array', minItems: 5, maxItems: PROJECT_COMPLEXITY_LIMITS.maxComponents, items: { type: 'string', minLength: 20, maxLength: 250 } },
    uniqueness: { type: 'string', minLength: 20, maxLength: 500 },
  },
};

const chineseBugNarrativeDescription = 'Write prose primarily in Chinese and do not append English explanatory sentences. Necessary Go identifiers, paths, commands, API names, states, and error codes may remain embedded in the Chinese text.';

export const bugSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'reason', 'bug_id', 'title', 'task_subtype', 'bug_category', 'user_query', 'target_files', 'symbols', 'failure_mechanism', 'reproduction_evidence', 'reproduction_command', 'success_criteria', 'runtime_mechanisms', 'affected_layers', 'state_or_resource_impact', 'difficulty_evidence'],
  properties: {
    found: { type: 'boolean' },
    reason: { type: 'string', description: chineseBugNarrativeDescription },
    bug_id: { type: 'string', pattern: '^(?:|[a-z0-9]+(?:-[a-z0-9]+)*)$' },
    title: { type: 'string', description: chineseBugNarrativeDescription },
    task_subtype: { type: 'string' },
    bug_category: { enum: ['', ...BUG_MECHANISMS] },
    user_query: { type: 'string', description: chineseBugNarrativeDescription },
    target_files: { type: 'array', items: { type: 'string' } },
    symbols: { type: 'array', items: { type: 'string' } },
    failure_mechanism: { type: 'string', description: chineseBugNarrativeDescription },
    reproduction_evidence: { type: 'string', description: chineseBugNarrativeDescription },
    reproduction_command: { type: 'string' },
    success_criteria: {
      type: 'string',
      description: `Describe acceptance and retained behavior. ${chineseBugNarrativeDescription}`,
    },
    runtime_mechanisms: { type: 'array', items: { enum: BUG_RUNTIME_MECHANISMS } },
    affected_layers: { type: 'array', items: { enum: BUG_AFFECTED_LAYERS } },
    state_or_resource_impact: { type: 'string', description: chineseBugNarrativeDescription },
    difficulty_evidence: { type: 'string', description: chineseBugNarrativeDescription },
  },
};

const bugDifficultyFields = new Set(['runtime_mechanisms', 'affected_layers', 'state_or_resource_impact', 'difficulty_evidence']);
export const legacyBugSchema = {
  ...bugSchema,
  required: bugSchema.required.filter((field) => !bugDifficultyFields.has(field)),
  properties: Object.fromEntries(Object.entries(bugSchema.properties).filter(([field]) => !bugDifficultyFields.has(field))),
};

export function bugSchemaForPolicy(version = 0) {
  return Number(version || 0) >= BUG_DIFFICULTY_POLICY_VERSION ? bugSchema : legacyBugSchema;
}

export const NATURAL_BUG_BATCH_VERSION = 2;
// Candidate plans are intentionally lightweight. Bump the plan version so an
// older plan cannot re-enter the revised injection pipeline.
export const INJECTION_PLAN_VERSION = 6;
const configuredInjectionPlanBatchSize = Number(process.env.GO_PIPELINE_INJECTION_PLAN_BATCH_SIZE || 4);
const INJECTION_PLAN_BATCH_SIZE = Number.isFinite(configuredInjectionPlanBatchSize)
  ? Math.max(1, Math.min(10, Math.floor(configuredInjectionPlanBatchSize)))
  : 4;
const INJECTION_PLAN_RETRY_ALLOWANCE = 3;
const configuredInjectionPlanTimeoutMs = Number(process.env.GO_PIPELINE_INJECTION_PLAN_TIMEOUT_MS || 15 * 60_000);
const INJECTION_PLAN_TIMEOUT_MS = Number.isFinite(configuredInjectionPlanTimeoutMs)
  && configuredInjectionPlanTimeoutMs > 0
  ? Math.max(8 * 60_000, configuredInjectionPlanTimeoutMs)
  : 15 * 60_000;
const configuredInjectionPlanIdleTimeoutMs = Number(process.env.GO_PIPELINE_INJECTION_PLAN_IDLE_TIMEOUT_MS || 6 * 60_000);
const INJECTION_PLAN_IDLE_TIMEOUT_MS = Number.isFinite(configuredInjectionPlanIdleTimeoutMs)
  && configuredInjectionPlanIdleTimeoutMs > 0
  ? Math.max(2 * 60_000, Math.min(INJECTION_PLAN_TIMEOUT_MS - 60_000, configuredInjectionPlanIdleTimeoutMs))
  : 6 * 60_000;

export function bugCandidatePoolSchema(version = 0, maxCandidates = 10) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['scope_summary', 'candidates'],
    properties: {
      scope_summary: { type: 'string', minLength: 20 },
      candidates: {
        type: 'array',
        maxItems: Math.max(1, Number(maxCandidates) || 10),
        items: bugSchemaForPolicy(version),
      },
    },
  };
}

function injectionPlanSchema(version = 0, requiredCandidates = 1) {
  const count = Math.max(1, Number(requiredCandidates) || 1);
  const schema = bugCandidatePoolSchema(version, count);
  schema.properties.candidates.minItems = count;
  schema.properties.candidates.maxItems = count;
  return schema;
}

export function extractFailedGoTestNames(value = '') {
  const names = [];
  const seen = new Set();
  for (const match of String(value || '').matchAll(/^--- FAIL: ([A-Za-z0-9_]+)/gm)) {
    const name = String(match[1] || '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function bugCandidateReviewSchema(maxCandidates = 20) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'reviews'],
    properties: {
      summary: { type: 'string', minLength: 20 },
      reviews: {
        type: 'array',
        maxItems: Math.max(1, Number(maxCandidates) || 20),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['bug_id', 'approved', 'score', 'summary', 'issues'],
          properties: {
            bug_id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
            approved: { type: 'boolean' },
            score: { type: 'integer', minimum: 1, maximum: 5 },
            summary: { type: 'string', minLength: 10 },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'message', 'evidence'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  evidence: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  };
}

function bugCandidateFingerprint(candidate = {}) {
  return JSON.stringify({
    files: [...(candidate.target_files || [])].map(String).sort(),
    symbols: [...(candidate.symbols || [])].map(String).sort(),
    mechanism: String(candidate.failure_mechanism || '').replace(/\s+/g, ' ').trim(),
    runtimeMechanisms: [...(candidate.runtime_mechanisms || [])].map(String).sort(),
    stateImpact: String(candidate.state_or_resource_impact || '').replace(/\s+/g, ' ').trim(),
  });
}

function normalizedCandidateSet(values = []) {
  return new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function setsOverlap(left, right) {
  return [...left].some((value) => right.has(value));
}

function semanticNgrams(value, width = 3) {
  const normalized = String(value || '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '');
  if (!normalized) return new Set();
  if (normalized.length <= width) return new Set([normalized]);
  return new Set(Array.from({ length: normalized.length - width + 1 }, (_, index) => normalized.slice(index, index + width)));
}

function semanticTextSimilarity(left, right) {
  const leftParts = semanticNgrams(left);
  const rightParts = semanticNgrams(right);
  if (!leftParts.size || !rightParts.size) return 0;
  const intersection = [...leftParts].filter((value) => rightParts.has(value)).length;
  return intersection / (leftParts.size + rightParts.size - intersection);
}

function candidateSetsEqual(left, right) {
  const leftSet = normalizedCandidateSet(left);
  const rightSet = normalizedCandidateSet(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function approvedInjectionCandidateMismatch(expected = {}, actual = {}) {
  const differences = [];
  if (String(actual.bug_id || '') !== String(expected.bug_id || '')) differences.push('编号');
  if (!candidateSetsEqual(actual.target_files, expected.target_files)) differences.push('目标文件');
  if (!candidateSetsEqual(actual.symbols, expected.symbols)) differences.push('目标符号');
  if (!candidateSetsEqual(actual.runtime_mechanisms, expected.runtime_mechanisms)) differences.push('运行机制');

  const mechanismSimilarity = semanticTextSimilarity(actual.failure_mechanism, expected.failure_mechanism);
  const stateImpactSimilarity = semanticTextSimilarity(actual.state_or_resource_impact, expected.state_or_resource_impact);
  if (mechanismSimilarity < 0.72) differences.push(`失效机制相似度 ${mechanismSimilarity.toFixed(2)}`);
  if (stateImpactSimilarity < 0.72) differences.push(`状态影响相似度 ${stateImpactSimilarity.toFixed(2)}`);
  return differences.join('、');
}

function bugCandidatesLikelyDuplicate(left = {}, right = {}) {
  if (bugCandidateFingerprint(left) === bugCandidateFingerprint(right)) return true;
  const leftFiles = normalizedCandidateSet(left.target_files);
  const rightFiles = normalizedCandidateSet(right.target_files);
  const leftSymbols = normalizedCandidateSet(left.symbols);
  const rightSymbols = normalizedCandidateSet(right.symbols);
  const sharedFile = setsOverlap(leftFiles, rightFiles);
  const sharedSymbol = setsOverlap(leftSymbols, rightSymbols);
  if (!sharedSymbol) return false;
  const leftMechanisms = normalizedCandidateSet(left.runtime_mechanisms);
  const rightMechanisms = normalizedCandidateSet(right.runtime_mechanisms);
  const sharedMechanisms = [...leftMechanisms].filter((mechanism) => rightMechanisms.has(mechanism));
  const impactSimilarity = semanticTextSimilarity(left.state_or_resource_impact, right.state_or_resource_impact);
  const mechanismSimilarity = semanticTextSimilarity(left.failure_mechanism, right.failure_mechanism);
  if (sharedMechanisms.length >= 1 && impactSimilarity >= 0.35) return true;
  return sharedFile && mechanismSimilarity >= 0.5 && impactSimilarity >= 0.25;
}

function bugCandidateFingerprintDigest(candidate = {}) {
  return crypto.createHash('sha256').update(bugCandidateFingerprint(candidate)).digest('hex');
}

function rejectedInjectionCandidates(job = {}, bugIndexes = []) {
  const selected = new Set((bugIndexes || []).map(Number));
  return (job.bugs || []).flatMap((bug) => {
    if (selected.size && !selected.has(Number(bug.bugIndex))) return [];
    return (bug.injectionPreparation?.rejectedCandidates || []).map((candidate) => ({
      bugIndex: Number(bug.bugIndex),
      bugId: String(candidate.bugId || ''),
      fingerprint: String(candidate.fingerprint || ''),
      targetFiles: candidate.targetFiles || [],
      symbols: candidate.symbols || [],
      failureMechanism: String(candidate.failureMechanism || ''),
      retainedTestEvidence: candidate.retainedTestEvidence || [],
      failedTests: candidate.failedTests || [],
      reason: String(candidate.reason || ''),
      failureKind: String(candidate.failureKind || injectionCandidateFailureKind(candidate.reason)),
    }));
  });
}

function injectionCandidateFailureKind(error) {
  const message = String(error?.message || error || '');
  if (/受控注入候选不可用|基线(?:已)?存在(?:该|候选)?缺陷|already (?:exists?|present) in (?:the )?baseline|no (?:real )?production diff|without (?:a )?production diff|Bug injection must produce (?:a real production diff|one reasonably scoped baseline change)/i.test(message)) {
    return 'baseline_overlap_or_no_mutation';
  }
  if (/Injected (?:candidate (?:full tests|static checks)|baseline (?:full tests|static checks))\u5931\u8d25/i.test(message)) {
    return 'retained_test_regression';
  }
  return 'candidate_validation';
}

export function isRecoverableInjectionCandidateFailure(error) {
  if (error?.code === 'PIPELINE_RESOURCE_WAIT') return false;
  return injectionCandidateFailureKind(error) === 'baseline_overlap_or_no_mutation'
    || /Injected (?:candidate (?:full tests|static checks)|baseline (?:full tests|static checks))\u5931\u8d25|Bug injection (?:stage|must|cannot)|\u6ce8\u5165\u7ed3\u679c\u504f\u79bb|Bug \u6839\u56e0\u6587\u4ef6\u5360\u6bd4\u95e8\u7981|\u6ce8\u5165[^\n]{0,80}\u590d\u6838\u4e0d\u901a\u8fc7/i.test(String(error?.message || error));
}

export function isRetryableInjectionInfrastructureFailure(error) {
  if (error?.code === 'PIPELINE_RESOURCE_WAIT') return false;
  return /Codex CLI\u5931\u8d25|Invalid prompt|usage policy|stream disconnected|gateway unavailable|idle timeout|timed out/i.test(String(error?.message || error));
}

export function applyInjectionPreparationFailures(job, failures, rejectedAt = now()) {
  const failedBugIndexes = [];
  const exhaustedBugIndexes = [];
  for (const failure of failures || []) {
    const bugIndex = Number(failure?.item?.bugIndex);
    const candidate = failure?.item?.plannedCandidate;
    if (!Number.isInteger(bugIndex) || !candidate) continue;
    const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
    const source = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_bug_source_prepare`);
    if (!bug || !source) continue;
    const prior = bug.injectionPreparation || {};
    const attempts = Math.max(0, Number(prior.attempts || 0)) + 1;
    const failureKind = injectionCandidateFailureKind(failure.error);
    const rejected = {
      bugId: String(candidate.bug_id || ''),
      fingerprint: bugCandidateFingerprintDigest(candidate),
      targetFiles: [...(candidate.target_files || [])],
      symbols: [...(candidate.symbols || [])],
      failureMechanism: String(candidate.failure_mechanism || ''),
      failedTests: extractFailedGoTestNames(`${failure.error?.message || ''}\n${failure.error?.stdout || ''}\n${failure.error?.stderr || ''}`),
      reason: String(failure.error?.message || failure.error || ''),
      failureKind,
      rejectedAt,
    };
    bug.injectionPreparation = {
      ...prior,
      attempts,
      status: attempts >= MAX_INJECTION_SLOT_ATTEMPTS ? 'review_required' : 'retry_pending',
      rejectedCandidates: [...(prior.rejectedCandidates || []), rejected].slice(-MAX_INJECTION_SLOT_ATTEMPTS),
      updatedAt: rejectedAt,
    };
    if (failureKind === 'baseline_overlap_or_no_mutation') {
      source.reason = attempts >= MAX_INJECTION_SLOT_ATTEMPTS
        ? `注入候选连续 ${attempts} 次与 main 现状重合或未形成生产改动，等待人工处理`
        : `第 ${attempts}/${MAX_INJECTION_SLOT_ATTEMPTS} 个注入候选与 main 现状重合或未形成生产改动，仅重新规划 Bug ${bugIndex}`;
    } else {
      source.reason = attempts >= MAX_INJECTION_SLOT_ATTEMPTS
        ? `注入候选连续 ${attempts} 次破坏原有行为，等待人工处理`
        : `第 ${attempts}/${MAX_INJECTION_SLOT_ATTEMPTS} 个注入候选未通过原有测试，仅重新规划 Bug ${bugIndex}`;
    }
    if (attempts >= MAX_INJECTION_SLOT_ATTEMPTS) {
      exhaustedBugIndexes.push(bugIndex);
    } else {
      source.status = 'pending';
      source.startedAt = null;
      source.finishedAt = null;
      source.error = '';
      delete source.result;
      bug.workerExecution = {
        ...(bug.workerExecution || {}),
        status: 'bug_ready',
        currentStage: '',
        updatedAt: rejectedAt,
      };
    }
    failedBugIndexes.push(bugIndex);
  }
  delete job.injectionPlan;
  return { failedBugIndexes, exhaustedBugIndexes };
}

export function applyInjectionInfrastructureFailures(job, failures, retriedAt = now()) {
  const failedBugIndexes = [];
  const exhaustedBugIndexes = [];
  for (const failure of failures || []) {
    const bugIndex = Number(failure?.item?.bugIndex);
    if (!Number.isInteger(bugIndex)) continue;
    const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
    const source = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_bug_source_prepare`);
    if (!bug || !source) continue;
    const prior = bug.injectionPreparation || {};
    const infrastructureAttempts = Math.max(0, Number(prior.infrastructureAttempts || 0)) + 1;
    const reason = String(failure.error?.message || failure.error || '注入准备基础设施失败');
    bug.injectionPreparation = {
      ...prior,
      infrastructureAttempts,
      status: infrastructureAttempts >= MAX_INJECTION_SLOT_ATTEMPTS ? 'review_required' : 'retry_pending',
      lastInfrastructureFailure: { reason, retriedAt },
      updatedAt: retriedAt,
    };
    source.reason = infrastructureAttempts >= MAX_INJECTION_SLOT_ATTEMPTS
      ? `注入准备基础设施连续失败 ${infrastructureAttempts} 次，等待人工处理`
      : `第 ${infrastructureAttempts}/${MAX_INJECTION_SLOT_ATTEMPTS} 次注入准备基础设施失败，保留原候选并仅重试 Bug ${bugIndex}`;
    if (infrastructureAttempts >= MAX_INJECTION_SLOT_ATTEMPTS) {
      exhaustedBugIndexes.push(bugIndex);
    } else {
      source.status = 'pending';
      source.startedAt = null;
      source.finishedAt = null;
      source.error = '';
      delete source.result;
      bug.workerExecution = {
        ...(bug.workerExecution || {}),
        status: 'bug_ready',
        currentStage: '',
        updatedAt: retriedAt,
      };
    }
    failedBugIndexes.push(bugIndex);
  }
  return { failedBugIndexes, exhaustedBugIndexes };
}

function interleaveCandidateGroups(groups = []) {
  const remaining = groups.map((group) => [...group]);
  const output = [];
  for (let index = 0; remaining.some((group) => index < group.length); index += 1) {
    for (const group of remaining) if (group[index]) output.push(group[index]);
  }
  return output;
}

export function normalizeBugCandidateFinders(finderResults, previousBugs, {
  taskType = 'bugfix',
  request = {},
} = {}) {
  const prior = (previousBugs || []).filter((item) => item?.discovery?.found !== false);
  const priorIds = new Set(prior.map((item) => item.discovery?.bug_id).filter(Boolean));
  const fingerprints = new Set(prior.map((item) => bugCandidateFingerprint(item.discovery)));
  const acceptedCandidates = prior.map((item) => item.discovery).filter(Boolean);
  const rejected = [];
  const validGroups = (finderResults || []).map((finder) => {
    const candidates = [];
    for (const raw of finder?.output?.candidates || []) {
      const candidate = structuredClone(raw);
      try {
        if (!validateDiscoveredBug(candidate, taskType, {
          ...request,
          previousUserQueries: prior.map((item) => item.discovery?.user_query).filter(Boolean),
        })) {
          rejected.push({ bugId: candidate.bug_id || '', reason: candidate.reason || 'finder returned found=false' });
          continue;
        }
      } catch (error) {
        rejected.push({ bugId: candidate.bug_id || '', reason: error.message });
        continue;
      }
      const fingerprint = bugCandidateFingerprint(candidate);
      if (priorIds.has(candidate.bug_id)
        || fingerprints.has(fingerprint)
        || acceptedCandidates.some((accepted) => bugCandidatesLikelyDuplicate(candidate, accepted))) {
        rejected.push({ bugId: candidate.bug_id, reason: 'duplicates an existing or earlier candidate' });
        continue;
      }
      priorIds.add(candidate.bug_id);
      fingerprints.add(fingerprint);
      acceptedCandidates.push(candidate);
      candidates.push({
        candidate,
        finder: finder.partition || '',
        finderSessionId: finder.sessionId || '',
      });
    }
    return candidates;
  });
  return { candidates: interleaveCandidateGroups(validGroups), rejected };
}

export function selectReviewedBugCandidates(finderResults, reviewResult, previousBugs, {
  limit,
  taskType = 'bugfix',
  request = {},
} = {}) {
  const prior = (previousBugs || []).filter((item) => item?.discovery?.found !== false);
  const normalized = normalizeBugCandidateFinders(finderResults, prior, { taskType, request });
  const reviews = new Map((reviewResult?.reviews || []).map((review) => [review.bug_id, review]));
  const rejected = [...normalized.rejected];
  const approved = normalized.candidates
    .map((item) => ({ ...item, review: reviews.get(item.candidate.bug_id) || null }))
    .filter((item) => {
      if (item.review?.approved && Number(item.review.score || 0) >= NATURAL_BUG_MIN_REVIEW_SCORE) return true;
      rejected.push({
        bugId: item.candidate.bug_id,
        reason: item.review
          ? Number(item.review.score || 0) < NATURAL_BUG_MIN_REVIEW_SCORE
            ? `难度评分 ${item.review.score || 0} 低于 ${NATURAL_BUG_MIN_REVIEW_SCORE} 分门槛`
            : item.review.issues?.map((issue) => `${issue.code}: ${issue.message}`).join('；') || item.review.summary
          : 'batch reviewer did not return a decision',
      });
      return false;
    })
    // When the partitions return more candidates than the project has
    // slots, keep the strongest difficulty/evidence scores first. The ID tie
    // break makes equal-score selection reproducible across runs.
    .sort((left, right) => {
      const scoreDelta = Number(right.review?.score || 0) - Number(left.review?.score || 0);
      return scoreDelta || String(left.candidate.bug_id).localeCompare(String(right.candidate.bug_id));
    });
  const selected = [];
  for (const item of approved) {
    if (selected.length >= Math.max(0, Number(limit) || 0)) break;
    const concentration = validateRootCauseFileConcentration([
      ...prior,
      ...selected.map((selectedItem, index) => ({ bugIndex: prior.length + index + 1, discovery: selectedItem.candidate })),
      { bugIndex: prior.length + selected.length + 1, discovery: item.candidate },
    ], { totalBugCount: Number(request.bugCount || limit || 0) });
    if (!concentration.ok) {
      rejected.push({ bugId: item.candidate.bug_id, reason: concentration.issues.join('；') });
      continue;
    }
    selected.push(item);
  }
  return { selected, rejected };
}

const goldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['root_cause_file', 'root_cause_symbols', 'internal_cause', 'propagation_path', 'observable_failure', 'mechanism_keywords', 'test_package', 'test_name', 'verification_summary'],
  properties: {
    root_cause_file: { type: 'string', pattern: '^(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.go$' },
    root_cause_symbols: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1 } },
    internal_cause: { type: 'string', minLength: 15 },
    propagation_path: { type: 'string', minLength: 15 },
    observable_failure: { type: 'string', minLength: 10 },
    mechanism_keywords: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'string', minLength: 2 } },
    test_package: { type: 'string', pattern: '^(?:\\.|\\./[A-Za-z0-9_.\\/-]+)$' },
    test_name: { type: 'string', pattern: '^Test[A-Za-z0-9_]+$' },
    verification_summary: { type: 'string', minLength: 30 },
  },
};

// The verification fixture is prepared before Claude starts, but remains
// outside both the task workspace and the model-facing prompt.  It is the
// immutable oracle used for pre-fix red and post-fix green; publication later
// overlays the exact same file into G1/G2/R1.
const privateVerificationFixtureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['test_file', 'test_package', 'test_name'],
  properties: {
    test_file: { type: 'string', pattern: '^(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+_test\\.go$' },
    test_package: { type: 'string', pattern: '^(?:\\.|\\./[A-Za-z0-9_.\\/-]+)$' },
    test_name: { type: 'string', pattern: '^TestModel_[A-Za-z0-9_]+$' },
  },
};

// V3 Bugfix tests are authored only after Claude has finished. The response
// describes the single file that the following red/green and Git stages retain.
const postClaudeVerificationTestSchema = privateVerificationFixtureSchema;

const verificationCoverageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'summary', 'test_names', 'test_files', 'requirements', 'issues'],
  properties: {
    approved: { type: 'boolean' },
    summary: { type: 'string', minLength: 20 },
    test_names: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', pattern: '^Test[A-Za-z0-9_]+$' },
    },
    test_files: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', pattern: '^(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+_test\\.go$' },
    },
    requirements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'category', 'contract_level', 'requirement', 'status', 'evidence'],
        properties: {
          source: { enum: ['user_query', 'success_criteria', 'both'] },
          category: { enum: ['target_behavior', 'process_constraint'] },
          contract_level: { enum: ['hard', 'supplemental'] },
          requirement: { type: 'string', minLength: 8 },
          status: { enum: ['covered', 'not_covered', 'not_applicable'] },
          evidence: { type: 'string' },
        },
      },
    },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'contract_level', 'message', 'evidence'],
          properties: {
            category: { enum: ['target_behavior', 'process_constraint'] },
            contract_level: { enum: ['hard', 'supplemental'] },
            message: { type: 'string' },
            evidence: { type: 'string' },
          },
      },
    },
  },
};

const qualitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'summary', 'issues'],
  properties: {
    approved: { type: 'boolean' },
    summary: { type: 'string', minLength: 20 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'evidence'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export function projectGenerationPrompt(plan, { phase = 'complete', failure = '' } = {}) {
  const largeProject = plan.project_tier === 'large';
  const targetProductionFiles = largeProject ? 50 : 20;
  const targetProductionLines = largeProject ? 5000 : 2000;
  const common = [
    'Work only in the current directory. Do not initialize Git and do not create ZIP files.',
    'Do not intentionally inject a known bug, weaken tests, or leave answer/solution artifacts.',
    'Never access, modify, rename, or delete anything outside the current directory. Never run rm -rf with an absolute path or a parent-directory target.',
    `Read ${GENERATED_PROJECT_SPEC_FILE} before inspecting or writing Go code. It is the approved source of truth and must not be modified, replaced, or deleted during code generation.`,
    ...(Number(plan.project_package_policy_version || 0) >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION ? [
      'Never create BUG_REPRO.md in the repository or any subdirectory. Bug reproduction evidence belongs to external task metadata, not project files.',
      `BENZHI_README.md must begin with this exact single-line project introduction before its heading: ${plan.project_summary}`,
    ] : []),
    'Every production package and substantial exported capability must implement a named component, business flow, domain rule, interface, or failure boundary from the approved project document and must be reachable from a runnable entry point. Do not add speculative subsystems, disconnected packages, unused declarations, pass-through wrappers, copy-pasted handlers, repeated DTOs, or code whose only purpose is to increase file or line counts.',
    ...(plan.frontend_required ? [
      'This project is assigned to the frontend quota. It must include a real web or frontend directory with package.json, a lockfile, source files, a build script, and a page that calls the Go backend or displays live backend state. Frontend code does not count toward the Go code target.',
    ] : []),
  ];
  const instructions = phase === 'foundation'
    ? [
        'Create the compilable foundation for the supplied Go project plan.',
        `The project document already exists at ${GENERATED_PROJECT_SPEC_FILE}. Read it first, then make go.mod with an explicit go directive your first code-creation action. Do not create another plan document.`,
        'Add only the core package layout, stable domain types and interfaces, and a minimal executable entry point required by the documented component traceability. Keep this foundation small so a new session can complete it.',
        'Add initial public tests for the foundation and run gofmt, go mod tidy, go test ./..., and go vet ./... before finishing.',
      ]
    : phase === 'repair'
      ? [
          'Repair the existing generated Go project. Preserve its domain and public behavior; do not redesign or replace the project.',
          'Use the supplied failure output to make the smallest complete correction. Resolve dependency, compile, test, vet, Docker-support, packaging, reachability, dead-code, or duplicate-implementation failures at their source.',
          'If static validation rejects a smoke-test URL as external network access, keep the existing module and Docker dependency strategy and rewrite only the smoke probe to use an explicit loopback host such as 127.0.0.1. Do not add vendor, -mod=vendor, or COPY vendor unless the failure output explicitly reports a dependency download or module-cache failure.',
          'Run gofmt, go mod tidy, go test ./..., and go vet ./... before finishing.',
          `Failure to repair:\n${String(failure || 'generation or validation did not complete').slice(-6000)}`,
        ]
      : [
          'Complete the existing Go project foundation according to every applicable item in the supplied plan.',
          'If go.mod is missing, create it as your first filesystem action. Inspect and extend existing files instead of restarting or replacing working code.',
          `The final project must be non-trivial and usable: at least ${targetProductionFiles} production Go files and ${targetProductionLines} effective production Go lines excluding tests${largeProject ? '' : ' (target about 2500 lines and keep the standard project near 2000-3000 lines)'}, across at least 4 meaningful packages, with real persistence and restart recovery, at least 4 public test files containing at least 12 public tests, and enough state/error/control-flow logic to exercise the planned behavior. These numeric thresholds are eligibility floors, not permission to invent code. Every counted file and line must implement documented behavior and be reachable from the executable. Blank lines, comments, generated padding, repeated declarations, frontend code, test-only inflation, unused packages, and duplicate implementations do not count. Do not submit a thin domain-only demo.`,
          'The repository root must include benzhi.Dockerfile, build_benzhi_docker.sh, BENZHI_README.md, and run_benzhi_smoke.sh. The smoke script must use bash with fail-fast behavior, run a real public CLI command or start the service and probe its local health/API behavior, clean up every process and temporary file, finish deterministically without external network access, and must not merely call go test. With pipefail enabled, never validate a response using curl | grep -q because grep can close the pipe early and make curl fail with SIGPIPE; capture the curl response in a variable and assert that variable instead. Docker must support linux/arm64 and linux/amd64 through the script platform argument, retain a full official Go toolchain, pre-download dependencies, and run go build ./....',
          'Run gofmt, go mod tidy, go test ./..., and go vet ./... before finishing. Every imported module must be declared in go.mod and recorded in go.sum.',
        ];
  return [...instructions, ...common, '', JSON.stringify(plan, null, 2)].join('\n');
}

function now() {
  return new Date().toISOString();
}

function safeSlug(value, fallback = 'generated-go-project') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || fallback;
}

export function validateDiscoveredBug(value, taskType = 'bugfix', {
  bugPolicyVersion = 0,
  taskSubtype = '',
  bugCategory = '',
  previousUserQueries = [],
} = {}) {
  if (!value || typeof value !== 'object' || typeof value.found !== 'boolean') throw new Error('Sol 找 Bug 必须明确返回 found=true 或 found=false');
  if (!value.found) {
    if (String(value.reason || '').trim().length < 20) throw new Error('未找到更多 Bug 时必须说明已检查范围和停止原因');
    return false;
  }

  const issues = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.bug_id || ''))) issues.push('bug_id 不合法');
  if (String(value.title || '').trim().length < 5) issues.push('title 少于 5 个字符');
  else if (!isChineseDescription(value.title)) issues.push('title 必须以中文为主体，不能夹带英文叙述段落');
  if (String(value.reason || '').trim() && !isChineseDescription(value.reason)) issues.push('reason 必须以中文为主体，不能夹带英文叙述段落');
  const normalizedCategory = normalizeBugCategory(value.bug_category);
  if (!normalizedCategory) issues.push('bug_category 不合法');
  if (Number(bugPolicyVersion || 0) >= BUG_TAXONOMY_POLICY_VERSION) {
    const taxonomy = validateBugTaxonomy({ taskType, taskSubtype: value.task_subtype, bugCategory: value.bug_category });
    issues.push(...taxonomy.issues);
    if (taskSubtype && value.task_subtype !== taskSubtype) issues.push(`task_subtype 必须使用请求指定的 ${taskSubtype}`);
    if (bugCategory && normalizedCategory !== bugCategory) issues.push(`bug_category 必须使用请求指定的 ${bugCategory}`);
  }
  if (Number(bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION) {
    try {
      validateBugDifficulty(value);
    } catch (error) {
      issues.push(error.message);
    }
  }
  if (!String(value.user_query || '').trim()) issues.push('user_query 为空');
  if (!isChineseDescription(value.user_query)) issues.push('user_query 必须以中文为主体，不能夹带英文叙述段落');
  // user_query is a human-reviewed delivery field. Its existence and Chinese
  // content are checked here, while wording/style concerns are handled after
  // BUG_BASE preparation in the manual review stage.
  if (!Array.isArray(value.target_files) || !value.target_files.length) issues.push('target_files 为空');
  if (!Array.isArray(value.symbols) || !value.symbols.length) issues.push('symbols 为空');
  if (String(value.failure_mechanism || '').trim().length < 30) issues.push('failure_mechanism 少于 30 个字符');
  else if (!isChineseDescription(value.failure_mechanism)) issues.push('failure_mechanism 必须以中文为主体，不能夹带英文叙述段落');
  else if (Array.isArray(value.target_files) && value.target_files.length && Array.isArray(value.symbols) && value.symbols.length) {
    const exportRootCause = naturalizeGoldRootCause(`问题文件：${value.target_files.join('、')}；问题符号：${value.symbols.join('、')}；失效机制：${value.failure_mechanism}`);
    if (!isChineseDescription(exportRootCause)) {
      issues.push('failure_mechanism 去除 Markdown 后仍必须以中文为主体，不能粘贴完整 SQL、代码或英文说明');
    }
    const rootCauseIssues = getGoldRootCauseRuleIssues({
      gold_root_cause: exportRootCause,
      gold_files: value.target_files,
      gold_symbols: value.symbols,
    });
    issues.push(...rootCauseIssues.filter((issue) => issue.includes('失效机制')).map(() => 'failure_mechanism 必须先说明具体实现缺陷和错误操作，再说明传播后为什么导致题面症状'));
  }
  if (String(value.reproduction_evidence || '').trim().length < 20) issues.push('reproduction_evidence 少于 20 个字符');
  else if (!isChineseDescription(value.reproduction_evidence)) issues.push('reproduction_evidence 必须以中文为主体，不能夹带英文叙述段落');
  for (const field of ['state_or_resource_impact', 'difficulty_evidence']) {
    if (String(value[field] || '').trim() && !isChineseDescription(value[field])) {
      issues.push(`${field} 必须以中文为主体，不能夹带英文叙述段落`);
    }
  }
  if (taskType === 'diagnosis') {
    const command = String(value.reproduction_command || '').trim();
    if (!command) issues.push('diagnosis reproduction_command 为空');
    // This is a discovery-stage draft. It may be a directly executable
    // command or a clear public reproduction/operation scenario. The final
    // task metadata and verify_cmds still require an independently executable
    // command after the candidate is prepared.
  }
  if (!String(value.success_criteria || '').trim()) issues.push('success_criteria 为空');
  else if (!isChineseDescription(value.success_criteria)) issues.push('success_criteria 必须以中文为主体，不能夹带英文叙述段落');
  if (issues.length) throw new Error(`Sol 返回的 Bug 记录不完整：${issues.join('；')}`);
  value.bug_category = normalizedCategory;
  return true;
}

function bugTaxonomyInstruction(taskType, { taskSubtype = '', bugCategory = '' } = {}) {
  const normalizedType = taskType === 'diagnosis' ? 'diagnosis' : 'bugfix';
  return [
    taskSubtype
      ? `Set task_subtype to exactly the requested subtype: ${taskSubtype}。`
      : `Set task_subtype to exactly one allowed ${normalizedType} subtype: ${TASK_SUBTYPES[normalizedType].join('；')}。`,
    bugCategory
      ? `Set bug_category to exactly the requested defect mechanism: ${bugCategory}.`
      : `Set bug_category to the independent defect mechanism, using exactly one of: ${BUG_MECHANISMS.join(', ')}.`,
    'task_subtype describes the requested work; bug_category describes how the implementation fails. Do not use the same label for both.',
  ].join(' ');
}

export function bugNarrativeLanguageInstruction() {
  return 'This is a hard output-schema requirement: write reason and, when found=true, title, user_query, failure_mechanism, reproduction_evidence, success_criteria, state_or_resource_impact, and difficulty_evidence as Chinese narrative. Chinese must be the prose language; before returning, translate every English explanatory sentence in those fields. Necessary Go identifiers, paths, short commands, API names, states, and error codes may remain embedded in the Chinese text. Markdown backticks are removed from gold_root_cause during Excel packaging, so failure_mechanism must still be Chinese prose after removing backticks: never paste a complete SQL statement, code statement, or English explanation there; describe its semantics in Chinese and retain only the necessary identifiers. failure_mechanism must name the concrete implementation defect or missing check at the implicated symbol, explain the propagation path, and use an explicit causal link to explain why the public symptom in user_query occurs; never only restate the symptom. success_criteria must describe the affected boundary and retained behavior in Chinese.';
}

function assertInside(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error(`路径越出流水线作业目录：${target}`);
}

const noJsonFallback = Symbol('no-json-fallback');

function pipelineJobBackupFile(filename) {
  const resolved = path.resolve(filename);
  if (path.basename(resolved) !== 'job.json') return '';
  const jobDir = path.dirname(resolved);
  const jobId = path.basename(jobDir);
  const jobsRoot = path.dirname(jobDir);
  if (!/^pipeline-[a-z0-9-]+$/i.test(jobId) || path.basename(jobsRoot) !== 'pipeline-jobs') return '';
  return path.join(path.dirname(jobsRoot), 'pipeline-refill', 'job-backups', `${jobId}.json`);
}

export function pipelineTasksRootForJob(jobFile) {
  const jobDir = path.dirname(path.resolve(jobFile));
  return path.join(path.dirname(path.dirname(jobDir)), 'tasks');
}

async function writeTextAtomic(filename, content) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${++jsonWriteSequence}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, content, 'utf8');
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJson(filename, fallback = noJsonFallback) {
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch (error) {
    if (fallback !== noJsonFallback) return fallback;
    const backupFile = error?.code === 'ENOENT' ? pipelineJobBackupFile(filename) : '';
    if (backupFile) {
      try {
        const backup = await fsp.readFile(backupFile, 'utf8');
        const parsed = JSON.parse(backup);
        await writeTextAtomic(filename, backup);
        return parsed;
      } catch {}
    }
    throw error;
  }
}

async function writeJsonAtomic(filename, value) {
  const key = path.resolve(filename);
  const previous = jsonWriteTails.get(key) || Promise.resolve();
  const operation = previous.then(async () => {
    const write = async () => {
      const content = `${JSON.stringify(value, null, 2)}\n`;
      await writeTextAtomic(filename, content);
      const backupFile = pipelineJobBackupFile(filename);
      if (backupFile) await writeTextAtomic(backupFile, content);
    };
    // review_statuses.json is also written by the API server. Protect it
    // across processes in addition to serializing this runner's own writes.
    if (path.basename(filename) === 'review_statuses.json') {
      await withFileLock(`${filename}.lock`, write);
    } else {
      await write();
    }
  });
  const queued = operation.catch(() => {});
  jsonWriteTails.set(key, queued);
  try {
    await operation;
  } finally {
    if (jsonWriteTails.get(key) === queued) jsonWriteTails.delete(key);
  }
}

async function writeRunnerHeartbeat(jobFile, status = 'running') {
  const filename = path.join(path.dirname(jobFile), 'runner-heartbeat.json');
  await writeJsonAtomic(filename, {
    jobId: path.basename(path.dirname(jobFile)),
    pid: process.pid,
    at: now(),
    status,
  });
}

function startRunnerHeartbeat(jobFile) {
  void writeRunnerHeartbeat(jobFile);
  runnerHeartbeatTimer = setInterval(() => { void writeRunnerHeartbeat(jobFile); }, 15_000);
  runnerHeartbeatTimer.unref();
}

async function stopRunnerHeartbeat(jobFile, status) {
  if (runnerHeartbeatTimer) clearInterval(runnerHeartbeatTimer);
  runnerHeartbeatTimer = null;
  await writeRunnerHeartbeat(jobFile, status).catch(() => {});
}

async function updateJob(jobFile, mutate) {
  const operation = jobUpdateTail.then(async () => {
    const job = await readJson(jobFile);
    await mutate(job);
    job.updatedAt = now();
    await writeJsonAtomic(jobFile, job);
    return job;
  });
  jobUpdateTail = operation.catch(() => {});
  return operation;
}

// Proof sessions may finish concurrently. Serialize public.json merges so a
// post-fix write cannot erase the pre-fix evidence (or vice versa).
async function updatePublicMetadata(taskDir, mutate) {
  const key = path.resolve(taskDir);
  const previous = publicMetadataUpdateTails.get(key) || Promise.resolve();
  const operation = previous.then(async () => {
    const publicPath = path.join(taskDir, 'public.json');
    const metadata = await readJson(publicPath);
    await mutate(metadata);
    await writeJsonAtomic(publicPath, metadata);
    return metadata;
  });
  const queued = operation.catch(() => {});
  publicMetadataUpdateTails.set(key, queued);
  try {
    return await operation;
  } finally {
    if (publicMetadataUpdateTails.get(key) === queued) publicMetadataUpdateTails.delete(key);
  }
}

async function appendLog(jobFile, level, message, stageId = '') {
  const entry = { at: now(), level, stageId, message: String(message).trim().slice(0, 1000) };
  await updateJob(jobFile, (job) => {
    job.logs = [...(job.logs || []), entry].slice(-200);
  });
  await fsp.appendFile(path.join(path.dirname(jobFile), 'pipeline.log'), `${entry.at} [${level}]${stageId ? ` [${stageId}]` : ''} ${entry.message}\n`, 'utf8');
}

async function setStage(jobFile, stageId, status, extra = {}) {
  return updateJob(jobFile, (job) => {
    const stage = job.stages.find((item) => item.id === stageId);
    if (!stage) throw new Error(`未知流水线阶段：${stageId}`);
    const changedAt = now();
    stage.attempts = Array.isArray(stage.attempts) ? stage.attempts : [];
    if (status === 'running') {
      for (const attempt of stage.attempts) {
        if (attempt?.status !== 'running' || attempt.finishedAt) continue;
        attempt.status = 'interrupted';
        attempt.finishedAt = changedAt;
      }
      stage.attempts.push({
        attempt: stage.attempts.length + 1,
        status: 'running',
        startedAt: changedAt,
        finishedAt: null,
      });
    }
    stage.status = status;
    Object.assign(stage, extra);
    if (status === 'running') {
      stage.startedAt = changedAt;
      stage.finishedAt = null;
      stage.error = '';
      job.currentStage = stageId;
    }
    if (['passed', 'failed', 'skipped'].includes(status)) {
      stage.finishedAt = changedAt;
      const activeAttempt = [...stage.attempts].reverse().find((attempt) => attempt?.status === 'running' && !attempt.finishedAt);
      if (activeAttempt) {
        activeAttempt.status = status;
        activeAttempt.finishedAt = changedAt;
        if (extra.error) activeAttempt.error = String(extra.error).slice(0, 2000);
      }
    }
    stage.cumulativeDurationMs = stage.attempts.reduce((total, attempt) => {
      const startedAt = Date.parse(attempt?.startedAt || '');
      const finishedAt = Date.parse(attempt?.finishedAt || '');
      return total + (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
        ? finishedAt - startedAt
        : 0);
    }, 0);
    const bugIndex = Number(String(stageId).match(/^bug(\d+)_/)?.[1]);
    const bug = Number.isInteger(bugIndex)
      ? (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex)
      : null;
    if (bug && ['running', 'passed', 'failed', 'skipped'].includes(status)) {
      const otherRunningStage = (job.stages || []).find((item) => item.id !== stageId
        && Number(item.bugIndex) === bugIndex
        && item.status === 'running');
      const effectiveStatus = otherRunningStage
        ? 'fast_lane_running'
        : status === 'failed'
          ? 'fast_lane_failed'
          : status === 'skipped'
            ? 'fast_lane_stopped'
            : status === 'passed'
              ? 'bug_ready'
              : 'fast_lane_running';
      bug.workerExecution = {
        ...(bug.workerExecution || {}),
        status: effectiveStatus,
        currentStage: status === 'running' ? stageId : otherRunningStage?.id || '',
        startedAt: status === 'running' ? changedAt : bug.workerExecution?.startedAt || null,
        updatedAt: changedAt,
        lastHeartbeatAt: changedAt,
      };
    }
  });
}

async function assertStagePrerequisites(jobFile, stageId) {
  const healthPath = pipelineHealthPathForJob(jobFile);
  const health = await readJson(healthPath, {});
  const blockers = pipelineStageHealthBlockers(stageId, health);
  if (blockers.length) {
    const required = pipelineStageRequiredServices(stageId);
    const service = required.find((key) => health.services?.[key]?.status !== 'online') || required[0] || 'host';
    const error = new Error(`阶段依赖暂不可用：${blockers.join('；')}`);
    error.code = 'PIPELINE_DEPENDENCY_WAIT';
    error.stageId = stageId;
    error.service = service;
    // Convert the health miss at the boundary where it is observed. This also
    // covers trajectory-cycle stages that do not run through runStage.
    await queueDependencyWait(jobFile, stageId, error);
  }
}

async function queueDependencyWait(jobFile, stageId, error) {
  const service = String(error?.service || 'host');
  const at = now();
  await updateJob(jobFile, (job) => {
    const stage = (job.stages || []).find((item) => item.id === stageId);
    if (stage) {
      stage.status = 'pending';
      stage.startedAt = null;
      stage.finishedAt = null;
      stage.error = '';
      stage.reason = error.message;
    }
    job.status = 'waiting_resource';
    job.currentStage = stageId;
    job.error = '';
    job.finishedAt = null;
    job.runnerPid = null;
    job.schedulerLease = null;
    job.waitingResource = {
      stageId,
      pool: 'dependency',
      limit: null,
      queuedAt: job.waitingResource?.queuedAt || at,
      reason: 'dependency_wait',
    };
    job.dependencyWaitService = service;
    job.updatedAt = at;
  });
  await appendLog(jobFile, 'warn', `${error.message}；已暂停当前阶段，等待 ${service} 恢复后自动续跑`, stageId);
  throw new PipelineResourceWaitError(stageId, 'dependency', service);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function descendantProcessIds(rootPid) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 1) return [];
  let output = '';
  try {
    ({ stdout: output } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 2 * 1024 * 1024 }));
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) || [];
    siblings.push(childPid);
    children.set(parentPid, siblings);
  }
  const descendants = [];
  const queue = [...(children.get(root) || [])];
  const seen = new Set();
  while (queue.length) {
    const childPid = queue.shift();
    if (!Number.isInteger(childPid) || seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(childPid);
    queue.push(...(children.get(childPid) || []));
  }
  return descendants;
}

export async function terminateProcessTree(rootPid, { graceMs = 500 } = {}) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 1) return { terminated: [], forced: [] };
  const descendants = await descendantProcessIds(root);
  const processIds = [...descendants.reverse(), root];
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };
  // The runner itself is a detached group leader, while Claude tool commands
  // can create additional process groups. Signal both the captured processes
  // and any group led by them so neither form can survive a pipeline stop.
  signal(-root, 'SIGTERM');
  const terminated = processIds.filter((pid) => signal(pid, 'SIGTERM'));
  const waitMs = Math.max(0, Math.min(5_000, Number(graceMs) || 0));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const survivors = processIds.filter((pid) => processIsAlive(pid));
  for (const pid of survivors) {
    signal(-pid, 'SIGKILL');
    signal(pid, 'SIGKILL');
  }
  return { terminated, forced: survivors };
}

export class PipelineResourceWaitError extends Error {
  constructor(stageId, pool, reason = 'capacity') {
    super(`${currentStageLabel(stageId)}等待中央调度资源`);
    this.name = 'PipelineResourceWaitError';
    this.code = 'PIPELINE_RESOURCE_WAIT';
    this.stageId = stageId;
    this.pool = pool || 'general';
    this.reason = reason;
  }
}

export function naturalBugFinderFailureCount(settled = []) {
  return (Array.isArray(settled) ? settled : [])
    .filter((result) => result?.status === 'rejected')
    .length;
}

export class NaturalBugFinderInfrastructureError extends Error {
  constructor(message, { failureCount = 0 } = {}) {
    super(`[system:natural_bug_finder] ${message}`);
    this.name = 'NaturalBugFinderInfrastructureError';
    this.code = 'PIPELINE_NATURAL_BUG_FINDER_FAILURE';
    this.failureCount = Number(failureCount) || 0;
  }
}

// A natural-only recovery must stop with the discovery cursor still pending
// when the search yields no usable candidate. It must never silently fall
// through to the controlled injection path.
export class NaturalBugSearchWaitError extends Error {
  constructor(stageId, message) {
    super(message || `${currentStageLabel(stageId)}没有留下合格自然 Bug，等待人工重试`);
    this.name = 'NaturalBugSearchWaitError';
    this.code = 'PIPELINE_NATURAL_BUG_SEARCH_WAIT';
    this.stageId = stageId;
  }
}

function isNaturalBugOnlyJob(job = {}) {
  return job?.naturalBugOnly === true || job?.request?.naturalBugOnly === true;
}

export class PipelineUserQueryReviewWaitError extends Error {
  constructor(stageId) {
    super(`${currentStageLabel(stageId)}等待人工确认`);
    this.name = 'PipelineUserQueryReviewWaitError';
    this.code = 'PIPELINE_USER_QUERY_REVIEW_WAIT';
    this.stageId = stageId;
  }
}

async function waitForUserQueryReviews(jobFile) {
  const job = await readJson(jobFile);
  const pendingStages = (job.stages || [])
    .filter((item) => item.stage === 'user_query_review' && !['passed', 'skipped'].includes(item.status))
    .sort((left, right) => Number(left.bugIndex || 0) - Number(right.bugIndex || 0));
  if (!pendingStages.length) return;
  const stageId = pendingStages[0].id;
  await updateJob(jobFile, (current) => {
    for (const reviewStage of current.stages || []) {
      if (reviewStage.stage !== 'user_query_review' || ['passed', 'skipped'].includes(reviewStage.status)) continue;
      reviewStage.status = 'pending';
      reviewStage.error = '';
      reviewStage.reason = '等待人工编辑并确认 user_query';
      reviewStage.reviewStartedAt ||= now();
    }
    current.status = 'waiting_review';
    current.currentStage = stageId;
    current.error = '';
    current.finishedAt = null;
    current.runnerPid = null;
    current.schedulerLease = null;
    current.waitingResource = null;
    const execution = normalizeBugExecution(current.bugExecution);
    current.bugExecution = {
      ...execution,
      selectedBugIndex: null,
      status: 'bug_ready',
      currentStage: stageId,
      currentAttempt: 0,
      blockedReason: '等待人工确认 user_query',
      updatedAt: now(),
    };
    current.userQueryReviewStartedAt ||= now();
  });
  await appendLog(jobFile, 'info', `全部 Bug 技术定位与 BUG_BASE 已完成，等待人工一次性确认 ${pendingStages.length} 个 user_query`, stageId);
  throw new PipelineUserQueryReviewWaitError(stageId);
}

async function yieldToCentralScheduler(jobFile, stageId, reason = 'stage_transition') {
  const profile = pipelineStageResourceProfile(stageId);
  let queuedAt = now();
  await updateJob(jobFile, (job) => {
    if (job.waitingResource?.stageId === stageId && job.waitingResource?.queuedAt) queuedAt = job.waitingResource.queuedAt;
    job.status = 'waiting_resource';
    job.currentStage = stageId;
    job.error = '';
    job.finishedAt = null;
    job.runnerPid = null;
    job.schedulerLease = null;
    job.waitingResource = {
      stageId,
      pool: profile.pool || 'general',
      limit: profile.limit || null,
      queuedAt,
      reason,
    };
    const execution = normalizeBugExecution(job.bugExecution);
    const stageBugIndex = Number(String(stageId).match(/^bug(\d+)_/)?.[1]);
    if (stageBugIndex === execution.selectedBugIndex) {
      job.bugExecution = {
        ...execution,
        status: 'fast_lane_queued',
        startedAt: null,
        currentStage: stageId,
        blockedReason: '等待中央调度资源',
        updatedAt: now(),
      };
    }
  });
  await appendLog(jobFile, 'info', `${currentStageLabel(stageId)}已进入中央队列并交还 Runner`, stageId);
  throw new PipelineResourceWaitError(stageId, profile.pool, reason);
}

async function assertSchedulerAdmission(jobFile, stageId) {
  const job = await readJson(jobFile);
  // A scheduler admission belongs to the whole pipeline runner, not to one
  // individual stage. Keep the same runner moving through adjacent stages;
  // only a real pool miss should yield back to the central scheduler.
  if (job.schedulerLease?.runnerPid === process.pid) return;
  // The runner PID is the authoritative ownership marker while a project is
  // already executing. This also tolerates a stale lease record from a
  // monitor restart without handing the project back between stages.
  if (job.status === 'running' && Number(job.runnerPid) === process.pid) return;
  // The first stage is admitted by the API before the child runner starts, so
  // it has a stage lease but no runnerPid yet.
  if (job.schedulerLease?.stageId === stageId) {
    await updateJob(jobFile, (current) => {
      if (current.schedulerLease?.stageId === stageId) {
        current.schedulerLease = { ...current.schedulerLease, runnerPid: process.pid };
      }
      current.runnerPid = process.pid;
      current.status = 'running';
      current.waitingResource = null;
    });
    return;
  }
  await yieldToCentralScheduler(jobFile, stageId, 'stage_transition');
}

async function clearSchedulerAdmission(jobFile, stageId, { release = false } = {}) {
  await updateJob(jobFile, (job) => {
    if (release) {
      job.schedulerLease = null;
    } else if (job.status === 'running' && Number(job.runnerPid) === process.pid) {
      // Keep the project-level lease across stage transitions. The per-stage
      // Docker slot is still released by runStage's finally block below.
      job.schedulerLease = {
        ...(job.schedulerLease || {}),
        stageId,
        runnerPid: process.pid,
        admittedAt: job.schedulerLease?.admittedAt || now(),
      };
    }
    job.waitingResource = null;
  });
}

async function acquireStageResourceSlot(jobFile, stageId, {
  waitForCapacity = false,
  optional = false,
  preserveJobCursor = false,
} = {}) {
  const profile = pipelineStageResourceProfile(stageId);
  if (!profile.pool || !profile.limit) return async () => {};
  const jobsRoot = path.dirname(path.dirname(path.resolve(jobFile)));
  const libraryRoot = path.dirname(jobsRoot);
  const poolRoot = path.join(libraryRoot, 'pipeline-refill', 'resource-slots', profile.pool);
  await fsp.mkdir(poolRoot, { recursive: true });
  let transientAcquireRetries = 0;
  let waitLoggedAt = 0;
  while (true) {
  const effectiveSlotLimit = profile.pool === 'codex-structured'
    ? pipelineStructuredCodexLimit({
        configuredLimit: profile.limit,
        loadAverage: os.loadavg()[0],
        cpuCount: os.cpus().length,
      })
    : profile.limit;
  for (let slot = 1; slot <= effectiveSlotLimit; slot += 1) {
    const slotDir = path.join(poolRoot, `slot-${slot}`);
    const ownerPath = path.join(slotDir, 'owner.json');
    try {
      await fsp.mkdir(slotDir);
      await writeJsonAtomic(ownerPath, {
        pid: process.pid,
        jobFile: path.resolve(jobFile),
        stageId,
        acquiredAt: now(),
      });
      return async () => {
        const owner = await readJson(ownerPath, null);
        if (Number(owner?.pid) === process.pid && owner?.jobFile === path.resolve(jobFile) && owner?.stageId === stageId) {
          await fsp.rm(slotDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      // A stale scheduler may remove the directory between mkdir and the atomic
      // owner publish. Treat that narrow race as transient instead of failing the job.
      if (error.code === 'ENOENT' && transientAcquireRetries < 3) {
        transientAcquireRetries += 1;
        await fsp.rm(`${ownerPath}.${process.pid}.tmp`, { force: true }).catch(() => {});
        slot -= 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(ownerPath, null);
      if (owner?.pid) {
        if (!processIsAlive(Number(owner.pid))) await fsp.rm(slotDir, { recursive: true, force: true });
      } else {
        const slotStat = await fsp.stat(slotDir).catch(() => null);
        if (slotStat && Date.now() - slotStat.mtimeMs > RESOURCE_SLOT_ACQUIRE_GRACE_MS) {
          await fsp.rm(slotDir, { recursive: true, force: true });
        }
      }
    }
  }
  if (waitForCapacity) {
    if (Date.now() - waitLoggedAt >= 60_000) {
      waitLoggedAt = Date.now();
      if (!preserveJobCursor) {
        await updateJob(jobFile, (current) => {
          const stageBugIndex = Number(String(stageId).match(/^bug(\d+)_/)?.[1]);
          const bug = Number.isInteger(stageBugIndex)
            ? (current.bugs || []).find((item) => Number(item.bugIndex) === stageBugIndex)
            : null;
          if (bug) bug.workerExecution = {
            ...(bug.workerExecution || {}),
            status: 'fast_lane_queued',
            currentStage: stageId,
            startedAt: null,
            updatedAt: now(),
            blockedReason: `等待 ${profile.pool} 内部资源`,
          };
          const execution = normalizeBugExecution(current.bugExecution);
          if (stageBugIndex === execution.selectedBugIndex) current.bugExecution = {
            ...execution,
            status: 'fast_lane_queued',
            startedAt: null,
            currentStage: stageId,
            updatedAt: now(),
            blockedReason: `等待 ${profile.pool} 内部资源`,
          };
          current.currentStage = stageId;
        });
      }
      await appendLog(jobFile, 'info', `${currentStageLabel(stageId)}等待 ${profile.pool} 内部资源；同项目其他 Bug 继续运行`, stageId);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    continue;
  }
  if (optional) return null;
  await yieldToCentralScheduler(jobFile, stageId, 'pool_full');
  }
}

function currentStageLabel(stageId) {
  if (stageId === 'codex_injection_plan') return '增量注入规划';
  if (stageId === 'codex_injection') return '注入执行与复核';
  if (stageId === 'project_plan') return '项目规划';
  if (stageId === 'project_generate') return '项目生成';
  if (stageId === 'project_validate') return 'Docker 验证';
  if (stageId.endsWith('_claude_fix')) return 'Claude 修复';
  if (stageId.endsWith('_test_author')) return '独立测试编写';
  if (stageId.endsWith('_red_green')) return '红绿验证';
  if (stageId.endsWith('_docker_validation')) return 'Docker 验证';
  if (stageId.endsWith('_git_publication')) return 'Git 发布';
  if (stageId.endsWith('_gold_fix')) return 'Gold 修复';
  if (stageId.endsWith('_bug_discovery')) return '自然 Bug 搜索';
  if (stageId.endsWith('_bug_source_prepare')) return '受控 Bug 注入';
  if (stageId.endsWith('_pre_verify') || stageId.endsWith('_post_verify')) return '红绿证明';
  if (stageId.endsWith('_verification_coverage')) return '验证覆盖复核';
  return '当前阶段';
}

function pipelineHealthPathForJob(jobFile) {
  const jobsRoot = path.dirname(path.dirname(path.resolve(jobFile)));
  const libraryRoot = path.dirname(jobsRoot);
  return path.join(libraryRoot, 'pipeline-refill', 'health.json');
}

async function skipUnfilledBugSlots(jobFile, fromBugIndex, reason) {
  await updateJob(jobFile, (job) => {
    const discoveryStageId = `bug${fromBugIndex}_bug_discovery`;
    for (const stage of job.stages) {
      const shouldSkip = stage.scope === 'bug'
        && Number(stage.bugIndex) >= fromBugIndex
        && (stage.status === 'pending' || stage.id === discoveryStageId);
      if (!shouldSkip) continue;
      stage.status = 'skipped';
      stage.finishedAt = now();
      stage.error = '';
      stage.reason = reason;
    }
    job.bugSearch = {
      requested: job.request.bugCount,
      found: (job.bugs || []).filter((bug) => bug.discovery?.found !== false).length,
      stoppedAtBugIndex: fromBugIndex,
      reason,
    };
    job.currentStage = null;
  });
}

async function restoreUnfilledBugSlotsForInjection(jobFile) {
  const job = await readJson(jobFile);
  if (Number(job.workflowVersion || 1) < CURRENT_WORKFLOW_VERSION) return { restored: [] };
  const requested = Number(job.request?.bugCount || 0);
  const batch = job.naturalBugBatch;
  if (!batch || Number(batch.selected || 0) >= requested) return { restored: [] };
  const candidates = (job.stages || [])
    .filter((stage) => stage.stage === 'bug_discovery'
      && stage.status === 'skipped'
      && /不为数量强行补题|剩余槽位转入受控注入|自然 Bug/.test(String(stage.reason || '')))
    .map((stage) => Number(stage.bugIndex))
    .filter((index) => Number.isInteger(index) && index > 0)
    .sort((left, right) => left - right);
  if (!candidates.length) return { restored: [] };
  const at = now();
  await updateJob(jobFile, (current) => {
    current.bugs ||= [];
    for (const bugIndex of candidates) {
      const existing = current.bugs.find((item) => Number(item.bugIndex) === bugIndex);
      if (!existing) current.bugs.push({ bugIndex, attempts: [] });
      for (const stage of current.stages || []) {
        if (Number(stage.bugIndex) !== bugIndex || stage.status !== 'skipped') continue;
        stage.status = 'pending';
        stage.startedAt = null;
        stage.finishedAt = null;
        stage.error = '';
        delete stage.reason;
        delete stage.result;
      }
      const bug = current.bugs.find((item) => Number(item.bugIndex) === bugIndex);
      if (bug) {
        delete bug.disposition;
        delete bug.failureDisposition;
        delete bug.skipReason;
        delete bug.skippedAt;
      }
    }
    current.bugSearch = {
      ...(current.bugSearch || {}),
      injectionFallbackSlots: candidates,
      injectionFallbackAt: at,
    };
    current.updatedAt = at;
  });
  await appendLog(jobFile, 'info', `恢复 ${candidates.length} 个自然 Bug 不足槽位，转入受控注入：${candidates.join(', ')}`, `bug${candidates[0]}_bug_discovery`);
  return { restored: candidates };
}

async function runStage(jobFile, stageId, action) {
  const job = await readJson(jobFile);
  const current = job.stages.find((item) => item.id === stageId);
  // Stage completion is terminal for both successful and intentionally
  // skipped stages.  A skipped legacy/optional stage must not be re-entered
  // by recovery or recursive continuation, otherwise it can spin forever
  // (for example, the retired verification-coverage stage).
  if (['passed', 'skipped'].includes(current?.status)) return current.result || null;
  const bugScoped = Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION && /^bug\d+_/.test(stageId);
  let releaseResource = async () => {};
  let resourceReleased = false;
  const releaseStageResource = async () => {
    if (resourceReleased) return;
    resourceReleased = true;
    const release = releaseResource;
    releaseResource = async () => {};
    await release().catch(() => {});
  };
  try {
    await assertSchedulerAdmission(jobFile, stageId);
    await assertStagePrerequisites(jobFile, stageId);
    releaseResource = await acquireStageResourceSlot(jobFile, stageId, { waitForCapacity: bugScoped });
    await setStage(jobFile, stageId, 'running');
    await appendLog(jobFile, 'info', `开始：${current?.label || stageId}`, stageId);
    const result = await action({ releaseResource: releaseStageResource });
    await setStage(jobFile, stageId, 'passed', { result: result || null });
    await clearSchedulerAdmission(jobFile, stageId);
    await appendLog(jobFile, 'success', `通过：${current?.label || stageId}`, stageId);
    return result;
  } catch (error) {
    if (['PIPELINE_RESOURCE_WAIT', 'PIPELINE_DEPENDENCY_WAIT'].includes(error?.code)) {
      if (error?.code === 'PIPELINE_DEPENDENCY_WAIT') {
        await queueDependencyWait(jobFile, stageId, error);
      }
      throw error;
    }
    await clearSchedulerAdmission(jobFile, stageId, { release: !bugScoped });
    if (error?.code === 'PIPELINE_NATURAL_BUG_FINDER_FAILURE') {
      await setStage(jobFile, stageId, 'pending', {
        startedAt: null,
        finishedAt: null,
        error: '',
        reason: error.message,
      });
      await appendLog(jobFile, 'warn', `自然 Bug 搜索基础设施失败，保留阶段等待有限次数自动重试：${error.message}`, stageId);
      throw error;
    }
    await setStage(jobFile, stageId, 'failed', { error: error.message });
    if (!bugScoped) {
      await updateJob(jobFile, (latest) => {
        latest.status = 'failed';
        latest.error = error.message;
        latest.finishedAt = now();
      });
    }
    await appendLog(jobFile, 'error', error.message, stageId);
    throw error;
  } finally {
    await releaseStageResource();
  }
}

async function pipelineHasStage(jobFile, stageId) {
  const job = await readJson(jobFile);
  return (job.stages || []).some((stage) => stage.id === stageId);
}

function compactAppend(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length <= maxCommandOutput ? next : next.slice(-maxCommandOutput);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

// A Claude wrapper can spend a long time inside a real Go/Docker command
// without changing a source file. Count only known work-producing descendants
// here; the wrapper's own bash, watcher, sleep and tee processes are ignored.
async function hasActiveWorkProcess(rootPid) {
  const pid = Number(rootPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let output = '';
  try {
    // `comm` is truncated on macOS and turns paths such as /usr/local/go/bin/go
    // into unusable process names. `args` preserves the invoked executable.
    ({ stdout: output } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: 2 * 1024 * 1024 }));
  } catch {
    return false;
  }
  const processes = output.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    const args = match[3].trim();
    const executableMatch = args.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const executable = path.basename(executableMatch?.[1] || executableMatch?.[2] || executableMatch?.[3] || '').toLowerCase();
    return { pid: Number(match[1]), ppid: Number(match[2]), executable, args };
  }).filter(Boolean);
  const children = new Map();
  for (const processInfo of processes) {
    const siblings = children.get(processInfo.ppid) || [];
    siblings.push(processInfo);
    children.set(processInfo.ppid, siblings);
  }
  const compilerCommands = new Set(['compile', 'link', 'vet', 'asm', 'cgo', 'gcc', 'clang', 'clang++', 'cc']);
  const isWorkProducingCommand = (processInfo) => {
    if (compilerCommands.has(processInfo.executable)) return true;
    const commandArgs = processInfo.args.split(/\s+/).slice(1);
    if (processInfo.executable === 'go') {
      return /^(?:test|build|vet|run|generate|install)$/.test(commandArgs[0] || '');
    }
    if (processInfo.executable === 'docker') {
      return /^(?:build|buildx|run|pull)$/.test(commandArgs[0] || '');
    }
    return processInfo.executable === 'docker-buildx';
  };
  const queue = [...(children.get(pid) || [])];
  const seen = new Set();
  while (queue.length) {
    const processInfo = queue.shift();
    if (!processInfo || seen.has(processInfo.pid)) continue;
    seen.add(processInfo.pid);
    if (isWorkProducingCommand(processInfo)) return true;
    queue.push(...(children.get(processInfo.pid) || []));
  }
  return false;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutStream = options.stdoutPath ? fs.createWriteStream(options.stdoutPath, { flags: 'w' }) : null;
    const stderrStream = options.stderrPath ? fs.createWriteStream(options.stderrPath, { flags: 'w' }) : null;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutHandle;
    let idleTimeoutHandle;
    let progressPollHandle;
    let phasePollHandle;
    let phaseObservationPollHandle;
    let outputDeadlineHandle;
    let killHandle;
    let terminationFallbackHandle;
    let requiredPathHandle;
    let terminationReason = '';
    let terminating = false;
    let progressTimedOut = false;
    const terminationFallbackMs = Number(options.terminationFallbackMs || 10_000);
    let progressLastChangedAt = startedAt;
    let activeWorkStartedAt = 0;
    const childEnvironment = { ...process.env, ...(options.env || {}) };
    for (const name of CHILD_SECRET_ENV_NAMES) delete childEnvironment[name];
    for (const name of options.unsetEnv || []) delete childEnvironment[name];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A runner command is commonly a shell that starts Claude, Docker, or
      // Go subprocesses. Put the command in its own process group so timeout
      // cleanup cannot leave descendants consuming a compute slot.
      detached: true,
    });
    activeChildren.add(child);
    const finish = async (exitCode, signal, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(idleTimeoutHandle);
      clearInterval(progressPollHandle);
      clearInterval(phasePollHandle);
      clearInterval(phaseObservationPollHandle);
      clearTimeout(outputDeadlineHandle);
      clearTimeout(killHandle);
      clearTimeout(terminationFallbackHandle);
      clearTimeout(requiredPathHandle);
      const streams = [stdoutStream, stderrStream].filter(Boolean);
      for (const stream of streams) stream.end();
      await Promise.all(streams.map((stream) => finished(stream).catch(() => {})));
      activeChildren.delete(child);
      resolve({
        command,
        exitCode,
        signal,
        error: error || terminationReason,
        stdout,
        stderr,
        timedOut,
        progressTimedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    const terminate = (reason, { timeout = false, progress = false } = {}) => {
      if (settled || terminating) return;
      terminating = true;
      terminationReason = reason || terminationReason;
      timedOut = timedOut || timeout;
      progressTimedOut = progressTimedOut || progress;
      if (progress && options.progressTerminationPath) {
        try {
          fs.mkdirSync(path.dirname(options.progressTerminationPath), { recursive: true });
          fs.writeFileSync(options.progressTerminationPath, `${new Date().toISOString()}\n`, 'utf8');
        } catch {}
      }
      if (child.pid) void terminateProcessTree(child.pid);
      else child.kill('SIGTERM');
      // A descendant can keep stdout/stderr open after the process-group
      // signal (notably sandboxed Claude tools on macOS). Never let the
      // pipeline remain stuck waiting for close indefinitely after a timeout.
      terminationFallbackHandle = setTimeout(() => {
        if (settled) return;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          try { child.kill('SIGKILL'); } catch {}
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(null, 'SIGKILL');
      }, Number.isFinite(terminationFallbackMs) && terminationFallbackMs > 0 ? terminationFallbackMs : 10_000);
    };
    const idleTimeoutMs = Number(options.idleTimeoutMs || 0);
    const resetIdleTimeout = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || settled || terminating) return;
      clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = setTimeout(() => {
        const idleDuration = idleTimeoutMs >= 60_000 && idleTimeoutMs % 60_000 === 0
          ? `${idleTimeoutMs / 60_000} 分钟`
          : `${Math.ceil(idleTimeoutMs / 1000)} 秒`;
        terminate(`连续 ${idleDuration}未产生子进程事件，已提前终止`, { timeout: true });
      }, idleTimeoutMs);
    };
    const observeOutput = (stream, chunk) => {
      if (typeof options.outputObserver !== 'function' || settled || terminating) return;
      let observation;
      try {
        observation = options.outputObserver(stream, String(chunk));
      } catch (error) {
        terminate(`子进程输出监控失败：${error.message || error}`);
        return;
      }
      if (!observation) return;
      if (observation.clearDeadline) clearTimeout(outputDeadlineHandle);
      if (observation.expired) {
        terminate(observation.reason || '子进程输出恢复窗口已耗尽', { timeout: true });
        return;
      }
      const deadlineMs = Number(observation.deadlineMs || 0);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
      clearTimeout(outputDeadlineHandle);
      outputDeadlineHandle = setTimeout(() => {
        terminate(observation.reason || '子进程输出恢复窗口已耗尽', { timeout: true });
      }, deadlineMs);
    };
    child.stdout.on('data', (chunk) => {
      stdoutStream?.write(chunk);
      stdout = compactAppend(stdout, chunk);
      observeOutput('stdout', chunk);
      resetIdleTimeout();
    });
    child.stderr.on('data', (chunk) => {
      stderrStream?.write(chunk);
      stderr = compactAppend(stderr, chunk);
      observeOutput('stderr', chunk);
      resetIdleTimeout();
    });
    child.once('error', (error) => { void finish(null, null, error.message); });
    child.once('close', (code, signal) => { void finish(code, signal); });
    // An explicit zero disables the wall-clock timeout. Calls that omit the
    // option retain the existing 30-minute command safety limit.
    const configuredTimeoutMs = options.timeoutMs === undefined
      ? 30 * 60 * 1000
      : Number(options.timeoutMs);
    if (Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const timeoutSeconds = Math.round(configuredTimeoutMs / 1000);
        terminate(`运行超过 ${timeoutSeconds} 秒总上限，已终止`, { timeout: true });
      }, configuredTimeoutMs);
    }
    // Do not charge startup latency against a command's idle budget. On a
    // loaded host the child may take longer than a short test budget to emit
    // its spawn event even though it is healthy and about to produce output.
    child.once('spawn', resetIdleTimeout);
    const progressPaths = [...new Set(
      (Array.isArray(options.progressPaths) ? options.progressPaths : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    )];
    const progressTreePaths = [...new Set(
      (Array.isArray(options.progressTreePaths) ? options.progressTreePaths : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    )];
    const activityPaths = [...new Set(
      (Array.isArray(options.activityPaths) ? options.activityPaths : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    )];
    const progressTimeoutMs = Number(options.progressTimeoutMs || 0);
    const initialProgressGraceMs = Number(options.initialProgressGraceMs || 0);
    const activeWorkGraceMs = Number(options.activeWorkGraceMs || 0);
    const progressDeadlineEnabled = Boolean(progressPaths.length || progressTreePaths.length || activityPaths.length)
      && Number.isFinite(progressTimeoutMs) && progressTimeoutMs > 0;
    const activityObserverEnabled = activityPaths.length > 0
      && typeof options.onActivityObservation === 'function';
    if (progressDeadlineEnabled || activityObserverEnabled) {
      let progressSnapshot = '';
      let activitySnapshot = '';
      let progressInitialized = false;
      let hasRealProgress = false;
      const readPathSnapshot = async (paths) => {
        const entries = await Promise.all(paths.map(async (progressPath) => {
          const stat = await fsp.stat(progressPath).catch(() => null);
          return `${progressPath}:${stat ? `${stat.size}:${stat.mtimeMs}` : 'missing'}`;
        }));
        return entries.join('\n');
      };
      const readTreeSnapshot = async (roots) => {
        const ignoredDirectories = new Set(['.git', '.benzhi-build', 'coverage', 'dist', 'node_modules']);
        const entries = [];
        const visit = async (root, directory, relative = '') => {
          const children = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
          children.sort((left, right) => left.name.localeCompare(right.name));
          for (const child of children) {
            if (child.isDirectory() && ignoredDirectories.has(child.name)) continue;
            const childRelative = relative ? `${relative}/${child.name}` : child.name;
            const absolute = path.join(directory, child.name);
            if (child.isDirectory()) {
              await visit(root, absolute, childRelative);
              continue;
            }
            if (!child.isFile()) continue;
            const stat = await fsp.stat(absolute).catch(() => null);
            entries.push(`${root}/${childRelative}:${stat ? `${stat.size}:${stat.mtimeMs}:${stat.mode}` : 'missing'}`);
          }
        };
        for (const root of roots) {
          const stat = await fsp.stat(root).catch(() => null);
          if (!stat?.isDirectory()) {
            entries.push(`${root}:missing`);
            continue;
          }
          await visit(root, root);
        }
        return entries.join('\n');
      };
      const pollProgress = async () => {
        if (settled || terminating) return;
        const [pathSnapshot, treeSnapshot, nextActivitySnapshot] = await Promise.all([
          readPathSnapshot(progressPaths),
          readTreeSnapshot(progressTreePaths),
          readPathSnapshot(activityPaths),
        ]);
        const nextSnapshot = [pathSnapshot, treeSnapshot].filter(Boolean).join('\n');
        // Establish the first filesystem snapshot before charging the child
        // for progress time.  On a busy host the first poll can run well
        // after spawn; using `startedAt` here would kill a healthy process
        // before it had a chance to create its first checkpoint.
        if (!progressInitialized) {
          progressInitialized = true;
          progressSnapshot = nextSnapshot;
          activitySnapshot = nextActivitySnapshot;
          progressLastChangedAt = Date.now();
          return;
        }
        if (nextSnapshot !== progressSnapshot) {
          hasRealProgress = true;
          progressLastChangedAt = Date.now();
          progressSnapshot = nextSnapshot;
        }
        if (nextActivitySnapshot !== activitySnapshot) {
          activitySnapshot = nextActivitySnapshot;
          // Tool activity is only a liveness signal. It intentionally does
          // not refresh progressLastChangedAt or satisfy delivery progress.
          resetIdleTimeout();
          if (activityObserverEnabled) {
            try {
              await options.onActivityObservation({ observedAt: now(), paths: activityPaths });
            } catch {}
          }
        }
        if (!progressDeadlineEnabled) return;
        // A compiler process can receive an explicit, bounded grace period for
        // callers that know its expected duration. It must never refresh the
        // workspace clock indefinitely: repeated Go/Docker commands without a
        // source, test, checkpoint, or phase transition are still a stall.
        const checkedAt = Date.now();
        if (Number.isFinite(activeWorkGraceMs) && activeWorkGraceMs > 0) {
          const activeWork = await hasActiveWorkProcess(child.pid);
          if (activeWork && activeWorkStartedAt === 0) activeWorkStartedAt = checkedAt;
          if (!activeWork) activeWorkStartedAt = 0;
          if (activeWorkStartedAt > 0 && checkedAt - activeWorkStartedAt < activeWorkGraceMs) return;
        }
        if (!hasRealProgress
          && Number.isFinite(initialProgressGraceMs)
          && initialProgressGraceMs > 0
          && checkedAt - startedAt < initialProgressGraceMs) return;
        if (checkedAt - progressLastChangedAt < progressTimeoutMs) return;
        const timeoutSeconds = Math.max(1, Math.round(progressTimeoutMs / 1000));
        terminate(`连续 ${timeoutSeconds} 秒未产生真实文件进展，已提前终止`, { timeout: true, progress: true });
      };
      void pollProgress();
      const pollIntervalMs = Math.max(50, Math.min(5000, Math.floor(progressTimeoutMs / 4) || 1000));
      progressPollHandle = setInterval(() => { void pollProgress(); }, pollIntervalMs);
    }
    const phaseRequestPath = String(options.phaseRequestPath || '').trim();
    const phaseAdmissionPath = String(options.phaseAdmissionPath || '').trim();
    if (phaseRequestPath && phaseAdmissionPath && typeof options.onPhaseRequest === 'function') {
      let lastRequestId = '';
      let phaseSwitchInFlight = false;
      const pollPhaseRequest = async () => {
        if (settled || terminating || phaseSwitchInFlight) return;
        const request = await readJson(phaseRequestPath, null);
        const requestId = String(request?.request_id || '');
        if (!requestId || requestId === lastRequestId) return;
        phaseSwitchInFlight = true;
        try {
          await options.onPhaseRequest(request);
          await writeJsonAtomic(phaseAdmissionPath, {
            version: 1,
            request_id: requestId,
            phase: String(request.phase || ''),
            admitted_at: now(),
          });
          lastRequestId = requestId;
          resetIdleTimeout();
        } catch (error) {
          terminate(`阶段资源切换失败：${error.message || error}`);
        } finally {
          phaseSwitchInFlight = false;
        }
      };
      void pollPhaseRequest();
      phasePollHandle = setInterval(() => { void pollPhaseRequest(); }, 100);
    }
    const phaseObservationPath = String(options.phaseObservationPath || '').trim();
    if (phaseObservationPath && typeof options.onPhaseObservation === 'function') {
      let lastObservation = '';
      let observationInFlight = false;
      const pollPhaseObservation = async () => {
        if (settled || terminating || observationInFlight) return;
        const observation = await readJson(phaseObservationPath, null);
        const key = `${observation?.phase || ''}:${observation?.observed_at || ''}`;
        if (!observation?.phase || key === lastObservation) return;
        observationInFlight = true;
        try {
          await options.onPhaseObservation(observation);
          lastObservation = key;
        } finally {
          observationInFlight = false;
        }
      };
      void pollPhaseObservation();
      phaseObservationPollHandle = setInterval(() => { void pollPhaseObservation(); }, 250);
    }
    if (options.requiredPath && Number(options.requiredPathDeadlineMs) > 0) {
      requiredPathHandle = setTimeout(async () => {
        if (settled) return;
        const required = await fsp.stat(options.requiredPath).catch(() => null);
        if (required?.isFile()) return;
        terminate(`启动后 ${Math.round(Number(options.requiredPathDeadlineMs) / 1000)} 秒仍未生成 ${path.basename(options.requiredPath)}`);
      }, Number(options.requiredPathDeadlineMs));
    }
  });
}

function commandFailure(label, result) {
  const output = [result.error, result.stdout, result.stderr].filter(Boolean).join('\n').slice(-6000);
  const timeoutDetail = result.timedOut ? `，已超时；总运行 ${formatDuration(result.durationMs)}` : '';
  const signalDetail = result.signal ? `，signal=${result.signal}` : '';
  return new Error(`${label}失败（exit=${result.exitCode ?? 'none'}${signalDetail}${timeoutDetail}）${output ? `：\n${output}` : ''}`);
}

export async function snapshotRunnerScript(jobFile, source, label) {
  const directory = path.join(path.dirname(jobFile), 'artifacts/runner-snapshots');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.chmod(directory, 0o755).catch(() => {});
  const filename = path.join(directory, `${safeSlug(label, 'runner')}-${crypto.randomUUID()}.sh`);
  await fsp.copyFile(source, filename);
  await fsp.chmod(filename, 0o755);
  return filename;
}

export function remainingProjectGenerationTimeout(deadlineMs, requestedMs, nowMs = Date.now()) {
  if (deadlineMs === Infinity) return 0;
  const remainingMs = Number(deadlineMs) - Number(nowMs);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error('项目生成已达到当前总预算，已保留检查点等待续作');
  }
  return Math.max(1_000, Math.min(Number(requestedMs) || remainingMs, remainingMs));
}

async function runRequired(label, command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) throw commandFailure(label, result);
  return result;
}

function extractSessionId(jsonl) {
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const value = event.thread_id || event.session_id || event?.thread?.id || event?.result?.session_id;
      if (value) return String(value);
    } catch {}
  }
  return '';
}

export function codexFailureMessage(jsonl) {
  let failure = '';
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const message = event?.error?.message
        || event?.payload?.error?.message
        || (event?.type === 'error' ? event.message : '');
      if (message) failure = String(message);
    } catch {}
  }
  return failure;
}

function codexEventMessage(event = {}) {
  return String(event?.error?.message
    || event?.payload?.error?.message
    || event?.message
    || '');
}

export function createCodexStreamRecoveryMonitor(windowMs, nowMs = () => Date.now()) {
  const recoveryWindowMs = Math.max(1, Number(windowMs) || 0);
  let lineBuffer = '';
  let recoveryStartedAt = null;
  const recoveryReason = `模型网关断流后连续 ${formatDuration(recoveryWindowMs)}未恢复，已结束当前分区并保留其他分区候选`;
  return (stream, chunk) => {
    if (stream !== 'stdout') return null;
    lineBuffer += String(chunk || '');
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    let directive = null;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const message = codexEventMessage(event);
      if (/\bReconnecting\.\.\.\s*\d+\/\d+\b/i.test(message)) {
        const observedAt = Number(nowMs());
        if (recoveryStartedAt === null) recoveryStartedAt = observedAt;
        const remainingMs = recoveryWindowMs - (observedAt - recoveryStartedAt);
        directive = remainingMs <= 0
          ? { expired: true, reason: recoveryReason }
          : { deadlineMs: remainingMs, reason: recoveryReason };
        continue;
      }
      if (recoveryStartedAt !== null && event?.type !== 'error' && event?.type !== 'turn.failed') {
        recoveryStartedAt = null;
        directive = { clearDeadline: true };
      }
    }
    return directive;
  };
}

async function archiveCodexAttemptArtifacts(artifactDir, name) {
  const paths = [
    `${name}.schema.json`,
    `${name}.json`,
    `${name}.codex.jsonl`,
    `${name}.codex.stderr.log`,
  ];
  const existing = [];
  for (const filename of paths) {
    const source = path.join(artifactDir, filename);
    if (await fsp.stat(source).catch(() => null)) existing.push({ filename, source });
  }
  if (!existing.length) return null;
  const attemptId = `${now().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const historyDir = path.join(artifactDir, 'codex-attempt-history', `${name}-${attemptId}`);
  await fsp.mkdir(historyDir, { recursive: true });
  for (const item of existing) await fsp.rename(item.source, path.join(historyDir, item.filename));
  return historyDir;
}

function codexSandboxArgs(sandbox) {
  return sandbox === 'workspace-write' ? ['--approve-for-me'] : ['-s', sandbox];
}

async function runCodexJson({
  jobFile,
  stageId,
  cwd,
  prompt,
  schema,
  name,
  sandbox = 'workspace-write',
  timeoutMs = 60 * 60 * 1000,
  idleTimeoutMs = CODEX_JSON_IDLE_TIMEOUT_MS,
  env = {},
  streamRecoveryWindowMs = 0,
  reasoningEffort = '',
  ignoreUserConfig = false,
  ephemeral = false,
}) {
  const artifactDir = path.join(path.dirname(jobFile), 'artifacts');
  await fsp.mkdir(artifactDir, { recursive: true });
  const archivedAttempt = await archiveCodexAttemptArtifacts(artifactDir, name);
  if (archivedAttempt) {
    await appendLog(jobFile, 'info', `已归档未完成的 Codex 尝试：${path.relative(path.dirname(jobFile), archivedAttempt)}`, stageId);
  }
  const schemaPath = path.join(artifactDir, `${name}.schema.json`);
  const outputPath = path.join(artifactDir, `${name}.json`);
  const eventsPath = path.join(artifactDir, `${name}.codex.jsonl`);
  const stderrPath = path.join(artifactDir, `${name}.codex.stderr.log`);
  await writeJsonAtomic(schemaPath, schema);
  const args = ['exec'];
  if (ephemeral) args.push('--ephemeral');
  if (ignoreUserConfig) args.push('--ignore-user-config');
  const normalizedReasoningEffort = String(reasoningEffort || '').trim().toLowerCase();
  if (normalizedReasoningEffort) {
    if (!['low', 'medium', 'high', 'xhigh'].includes(normalizedReasoningEffort)) {
      throw new Error(`非法 Codex 推理强度：${reasoningEffort}`);
    }
    args.push('-c', `model_reasoning_effort="${normalizedReasoningEffort}"`);
  }
  const recoveryWindowMs = Number(streamRecoveryWindowMs || 0);
  // Custom providers may opt into a larger internal retry count. The built-in
  // OpenAI provider is reserved, so the external monitor alone owns its window.
  args.push(...codexStreamRecoveryConfigArgs(recoveryWindowMs));
  args.push('--skip-git-repo-check', '-C', cwd, ...codexSandboxArgs(sandbox), '--json', '--output-schema', schemaPath, '-o', outputPath);
  args.push(prompt);
  await appendLog(jobFile, 'info', `调用新的 Codex session：${name}`, stageId);
  const outputObserver = recoveryWindowMs > 0
    ? createCodexStreamRecoveryMonitor(recoveryWindowMs)
    : undefined;
  const codexToolDir = path.isAbsolute(codexBin) ? path.dirname(codexBin) : '';
  const codexEnvironment = {
    ...env,
    PATH: [...new Set([codexToolDir, env.PATH || '', process.env.PATH || ''].filter(Boolean))].join(path.delimiter),
  };
  const result = await runCommand(codexBin, args, {
    cwd,
    stdoutPath: eventsPath,
    stderrPath,
    timeoutMs,
    idleTimeoutMs,
    env: codexEnvironment,
    outputObserver,
  });
  if (result.exitCode !== 0) {
    const structuredFailure = codexFailureMessage(result.stdout);
    if (structuredFailure) {
      result.error = [result.error, structuredFailure].filter(Boolean).join('\n');
      // The complete event stream remains in eventsPath. Avoid letting one
      // large tool-result line push the actual gateway failure out of the
      // compact error shown in job state and the workbench.
      result.stdout = '';
    }
    throw commandFailure('Codex CLI', result);
  }
  const output = await readJson(outputPath);
  const events = await fsp.readFile(eventsPath, 'utf8');
  return { output, sessionId: extractSessionId(events), outputPath, eventsPath };
}

async function runInjectionCodexJson(options) {
  const releaseStructuredCodex = await acquireStageResourceSlot(options.jobFile, 'codex_injection', {
    waitForCapacity: true,
    preserveJobCursor: true,
  });
  try {
    return await runCodexJson({
      ...options,
      timeoutMs: options.timeoutMs || STRUCTURED_CODEX_TIMEOUT_MS,
      idleTimeoutMs: options.idleTimeoutMs || CODEX_JSON_IDLE_TIMEOUT_MS,
      streamRecoveryWindowMs: options.streamRecoveryWindowMs || STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS,
      reasoningEffort: options.reasoningEffort || 'medium',
      ignoreUserConfig: true,
      ephemeral: true,
    });
  } finally {
    await releaseStructuredCodex().catch(() => {});
  }
}

async function reusableCodexJson(jobFile, name) {
  const artifactDir = path.join(path.dirname(jobFile), 'artifacts');
  const outputPath = path.join(artifactDir, `${name}.json`);
  const eventsPath = path.join(artifactDir, `${name}.codex.jsonl`);
  const output = await readJson(outputPath, null);
  if (!output || !await fsp.stat(eventsPath).catch(() => null)) return null;
  const events = await fsp.readFile(eventsPath, 'utf8');
  const sessionId = extractSessionId(events);
  return sessionId ? { output, sessionId, outputPath, eventsPath, reused: true } : null;
}

async function archiveDirectory(jobDir, target, label) {
  if (!await fsp.stat(target).catch(() => null)) return;
  assertInside(jobDir, target);
  const history = path.join(jobDir, 'history', `${label}-${now().replace(/[:.]/g, '-')}`);
  await fsp.mkdir(path.dirname(history), { recursive: true });
  await fsp.rename(target, history);
}

// A stopped/retired workflow can leave a partially materialized task folder
// behind before public.json is written. Keep that evidence, but do not let the
// stale folder block a fresh V3 task with the same deterministic name.
async function archiveStaleTaskDirectory(tasksRoot, taskDir, taskName) {
  const historyRoot = path.join(tasksRoot, '.stale-task-attempts');
  const archived = path.join(historyRoot, `${taskName}-${now().replace(/[:.]/g, '-')}`);
  assertInside(tasksRoot, taskDir);
  assertInside(tasksRoot, archived);
  await fsp.mkdir(historyRoot, { recursive: true });
  await fsp.rename(taskDir, archived);
  return archived;
}

async function archiveGoldContractCandidate(jobDir, goldDir, bugIndex) {
  if (!await fsp.stat(goldDir).catch(() => null)) return '';
  const label = `gold-bug${bugIndex}-contract-retry`;
  await archiveDirectory(jobDir, goldDir, label);
  const entries = await fsp.readdir(path.join(jobDir, 'history'), { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${label}-`))
    .map((entry) => entry.name)
    .sort();
  const latest = candidates.at(-1);
  return latest ? path.join('history', latest) : '';
}

async function copyWithoutGit(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  await fsp.cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    mode: FAST_COPY_MODE,
    filter: (item) => !item.split(path.sep).includes('.git'),
  });
}

export async function removeGeneratedCompilerArtifacts(root, baselineRoot) {
  const removed = [];
  const visit = async (directory, relativeDirectory = '') => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const relative = path.join(relativeDirectory, entry.name);
      const target = path.join(root, relative);
      if (entry.isDirectory()) {
        await visit(target, relative);
        continue;
      }
      if (!entry.isFile() || await fsp.stat(path.join(baselineRoot, relative)).catch(() => null)) continue;
      const handle = await fsp.open(target, 'r');
      const header = Buffer.alloc(4);
      try {
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead < 2) continue;
      } finally {
        await handle.close();
      }
      const magic = header.toString('hex');
      const compiled = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(magic)
        || (header[0] === 0x4d && header[1] === 0x5a);
      if (!compiled) continue;
      await fsp.rm(target, { force: true });
      removed.push(relative.split(path.sep).join('/'));
    }
  };
  await visit(root);
  return removed;
}

// Diagnosis Claude sessions intentionally run in a read-only workspace. The
// independent Codex test-author session receives a disposable copy of that
// workspace, so normalize only the copy to writable permissions before the
// author adds a regression test or retries cleanup.
async function makeTreeWritable(root) {
  const visit = async (target) => {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) return;
    const isDirectory = stat.isDirectory();
    await fsp.chmod(target, (stat.mode & 0o7777) | (isDirectory ? 0o700 : 0o600));
    if (!isDirectory) return;
    for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
      await visit(path.join(target, entry.name));
    }
  };
  await visit(root);
}

async function copyFileReplacing(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.copyFile(source, temporary, FAST_COPY_MODE);
    await fsp.rename(temporary, destination);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeFileReplacing(destination, content, options = undefined) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, content, options);
    await fsp.rename(temporary, destination);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readWorkspaceEntries(root) {
  const entries = [];
  async function visit(directory, relative = '') {
    for (const child of await fsp.readdir(directory, { withFileTypes: true })) {
      if (child.name === '.git') continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolute, childRelative);
      else if (child.isFile()) entries.push({ path: childRelative, content: await fsp.readFile(absolute) });
    }
  }
  await visit(root);
  return entries;
}

export async function inspectDiagnosisWorkspace(pristineDir, workspaceDir) {
  const [pristineEntries, workspaceEntries] = await Promise.all([
    readWorkspaceEntries(pristineDir),
    readWorkspaceEntries(workspaceDir),
  ]);
  const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
  const pristine = new Map(pristineEntries.map((entry) => [entry.path, digest(entry.content)]));
  const workspace = new Map(workspaceEntries.map((entry) => [entry.path, digest(entry.content)]));
  const added = [...workspace.keys()].filter((filename) => !pristine.has(filename)).sort();
  const removed = [...pristine.keys()].filter((filename) => !workspace.has(filename)).sort();
  const modified = [...workspace]
    .filter(([filename, hash]) => pristine.has(filename) && pristine.get(filename) !== hash)
    .map(([filename]) => filename)
    .sort();
  return {
    valid: added.length === 0 && removed.length === 0 && modified.length === 0,
    added,
    removed,
    modified,
  };
}

async function readTreeModes(root) {
  const modes = new Map();
  const visit = async (target, relative = '') => {
    const stat = await fsp.lstat(target);
    modes.set(relative, stat.mode & 0o7777);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of await fsp.readdir(target)) {
      await visit(path.join(target, entry), relative ? `${relative}/${entry}` : entry);
    }
  };
  await visit(root);
  return modes;
}

async function restoreTreeModes(root, modes) {
  const entries = [...modes.entries()].sort(([left], [right]) => right.split('/').length - left.split('/').length);
  for (const [relative, mode] of entries) {
    const target = relative ? path.join(root, relative) : root;
    if (await fsp.lstat(target).catch(() => null)) await fsp.chmod(target, mode);
  }
}

export async function ensureDiagnosisWorkspaceUnchanged(taskDir, authored = null) {
  const pristineDir = path.join(taskDir, 'pristine');
  const workspaceDir = path.join(taskDir, 'workspace');
  let inspection = await inspectDiagnosisWorkspace(pristineDir, workspaceDir);
  const legacyTest = String(authored?.testFile || '');
  if (!inspection.valid
    && safeVerificationTestPath(legacyTest)
    && inspection.added.length === 1
    && inspection.added[0] === legacyTest
    && inspection.modified.length === 0
    && inspection.removed.length === 0) {
    const testPath = path.join(workspaceDir, legacyTest);
    const bytes = await fsp.readFile(testPath).catch(() => null);
    const actualSha = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : '';
    if (!authored?.sha256 || actualSha !== authored.sha256) {
      throw new Error(`diagnosis 工作区存在非系统夹具改动：${legacyTest}`);
    }
    const modes = await readTreeModes(workspaceDir);
    try {
      await makeTreeWritable(workspaceDir);
      await fsp.rm(testPath, { force: true });
      let directory = path.dirname(testPath);
      while (directory !== workspaceDir && directory.startsWith(`${workspaceDir}${path.sep}`)) {
        const entries = await fsp.readdir(directory).catch(() => ['not-empty']);
        if (entries.length) break;
        await fsp.rmdir(directory);
        directory = path.dirname(directory);
      }
    } finally {
      await restoreTreeModes(workspaceDir, modes);
    }
    inspection = await inspectDiagnosisWorkspace(pristineDir, workspaceDir);
  }
  const publicPath = path.join(taskDir, 'public.json');
  if (await fsp.stat(publicPath).catch(() => null)) {
    await updatePublicMetadata(taskDir, (metadata) => Object.assign(metadata, {
      diagnosis_workspace_policy_version: 1,
      diagnosis_workspace_unchanged: inspection.valid,
      diagnosis_workspace_check_status: inspection.valid ? 'passed' : 'failed',
      diagnosis_workspace_checked_at: now(),
    }));
  }
  if (!inspection.valid) {
    const details = [
      inspection.added.length ? `新增 ${inspection.added.join('、')}` : '',
      inspection.modified.length ? `修改 ${inspection.modified.join('、')}` : '',
      inspection.removed.length ? `删除 ${inspection.removed.join('、')}` : '',
    ].filter(Boolean).join('；');
    throw new Error(`diagnosis 禁止持久修改被测仓库源码或测试：${details}`);
  }
  return inspection;
}

export async function inspectBugfixRepairWorkspace(baselineDir, fixedDir) {
  const [baselineEntries, fixedEntries] = await Promise.all([
    readWorkspaceEntries(baselineDir),
    readWorkspaceEntries(fixedDir),
  ]);
  const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
  const baseline = new Map(baselineEntries
    .filter((entry) => !entry.path.endsWith('_test.go'))
    .map((entry) => [entry.path, digest(entry.content)]));
  const fixed = new Map(fixedEntries
    .filter((entry) => !entry.path.endsWith('_test.go'))
    .map((entry) => [entry.path, digest(entry.content)]));
  const changedNonTestFiles = [...new Set([
    ...[...fixed].filter(([filename, hash]) => baseline.get(filename) !== hash).map(([filename]) => filename),
    ...[...baseline.keys()].filter((filename) => !fixed.has(filename)),
  ])].sort();
  return { valid: changedNonTestFiles.length > 0, changedNonTestFiles };
}

async function assertBugfixRepairWorkspace(task, fixedDir = path.join(task.taskDir, 'workspace'), baselineDir = path.join(task.taskDir, 'pristine')) {
  if (task.taskType !== 'bugfix') return { valid: true, changedNonTestFiles: [] };
  const inspection = await inspectBugfixRepairWorkspace(baselineDir, fixedDir);
  if (inspection.valid) return inspection;
  const error = new Error('INVALID_REPAIR_OUTPUT=1: Bugfix Claude 修复未产生任何非测试文件变更，不能保存检查点或进入独立测试编写');
  error.code = 'INVALID_REPAIR_OUTPUT';
  throw error;
}

function verificationFixtureCommand(testPackage, testName, { concurrency = false } = {}) {
  return `go test ${concurrency ? '-race ' : ''}${testPackage} -run '^${testName}$' -count=${concurrency ? DETERMINISTIC_TEST_RUNS : 1} -v`;
}

function concurrencyVerificationNarrative(value, command) {
  const text = String(value || '').trim().replace(/[。；\s]+$/u, '');
  const alreadyDocumented = /确定性(?:复现|验证)(?:策略|替代方案)|同步屏障|起跑屏障|受控交错|固定并发轮次|固定资源裁定顺序/u.test(text)
    && text.includes(command);
  if (alreadyDocumented) return `${text}。`;
  const policy = `确定性验证策略采用固定并发轮次重放同一公开场景和断言；执行 ${command}，以 ${DETERMINISTIC_TEST_RUNS} 轮重复运行和竞态检测作为稳定性下限`;
  return `${text ? `${text}。` : ''}${policy}。`;
}

async function preparePrivateVerificationFixture(jobFile, bugIndex, bugBaseDir, bug) {
  const job = await readJson(jobFile);
  const jobDir = path.dirname(jobFile);
  const existing = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.verificationFixture;
  if (existing?.directory && existing?.testFile && existing?.testName && existing?.testPackage
    && await fsp.stat(path.join(existing.directory, existing.testFile)).catch(() => null)) {
    const existingBytes = await fsp.readFile(path.join(existing.directory, existing.testFile));
    const existingSha = crypto.createHash('sha256').update(existingBytes).digest('hex');
    if (!existing.sha256 || existing.sha256 === existingSha) {
      const testPackage = verificationTestPackage(existing.testFile);
      return {
        ...existing,
        testPackage,
        command: verificationFixtureCommand(testPackage, existing.testName, { concurrency: isConcurrencyBug(bug) }),
      };
    }
    throw new Error(`Bug ${bugIndex} 私有验证夹具已被修改，拒绝替换冻结证明`);
  }

  const directory = path.join(jobDir, `private-verification-bug${bugIndex}`);
  await fsp.rm(directory, { recursive: true, force: true });
  await copyWithoutGit(bugBaseDir, directory);
  const before = new Map((await readWorkspaceEntries(bugBaseDir)).map((entry) => [
    entry.path,
    crypto.createHash('sha256').update(entry.content).digest('hex'),
  ]));
  const fixtureChecklist = buildVerificationCoverageChecklist({
    userQuery: String(bug?.user_query || '').trim(),
    successCriteria: String(bug?.success_criteria || '').trim(),
  });
  const prompt = [
    'Prepare one private regression-test fixture for the selected Bug. Do not modify production code, existing tests, configuration, documentation, scripts, Dockerfiles, or dependencies; do not create commits or inspect Git history.',
    'Add exactly one new Go *_test.go file whose only test function is named with the TestModel_ prefix. The file is a private verification fixture and will not be shown to the repair Session. Keep assertions focused on the concrete public behavior in user_query and the supplied Bug record.',
    'The test must deterministically fail on the current BUG_BASE implementation. Do not weaken the assertion to make it pass, and do not encode a proposed fix or mention the answer in comments or names. Its assertions must cover every hard, issue-specific behavior in the supplied user_query; generic preservation prose is supplemental.',
    `Coverage checklist to satisfy in this one table-driven test:\n${JSON.stringify(fixtureChecklist, null, 2)}`,
    `Bug record:\n${JSON.stringify(bug, null, 2)}`,
    'Return only JSON with test_file, test_package and test_name. Do not include Markdown fences.',
  ].join('\n\n');
  const result = await runCodexJson({
    jobFile,
    stageId: `bug${bugIndex}_task_prepare`,
    cwd: directory,
    prompt,
    schema: privateVerificationFixtureSchema,
    name: `bug${bugIndex}-private-verification-fixture`,
    sandbox: 'workspace-write',
  });
  const fixture = result.output;
  if (!safeVerificationTestPath(fixture.testFile)) throw new Error(`Bug ${bugIndex} 私有验证夹具路径不安全`);
  const afterEntries = await readWorkspaceEntries(directory);
  const changedNonTests = afterEntries.filter((entry) => !entry.path.endsWith('_test.go') && (
    !before.has(entry.path)
    || before.get(entry.path) !== crypto.createHash('sha256').update(entry.content).digest('hex')
  ));
  const removed = [...before.keys()].filter((entry) => !afterEntries.some((item) => item.path === entry));
  const changedExistingTests = afterEntries.filter((entry) => entry.path.endsWith('_test.go') && before.has(entry.path)
    && before.get(entry.path) !== crypto.createHash('sha256').update(entry.content).digest('hex'));
  const addedTests = afterEntries.filter((entry) => entry.path.endsWith('_test.go') && !before.has(entry.path));
  if (changedNonTests.length || removed.length || changedExistingTests.length || addedTests.length !== 1
    || addedTests[0].path !== fixture.testFile) {
    throw new Error(`Bug ${bugIndex} 私有验证夹具只能新增一个 *_test.go，禁止改动生产代码或原有测试`);
  }
  const testSource = await fsp.readFile(path.join(directory, fixture.testFile), 'utf8');
  const names = goTestNames(testSource);
  if (names.length !== 1 || names[0] !== fixture.testName) {
    throw new Error(`Bug ${bugIndex} 私有验证夹具必须只包含 ${fixture.testName}`);
  }
  const goEnv = await projectGoEnvironment(directory);
  const testPackage = verificationTestPackage(fixture.testFile);
  const concurrency = isConcurrencyBug(bug);
  const command = verificationFixtureCommand(testPackage, fixture.testName, { concurrency });
  const red = await runCommand('go', [
    'test',
    ...(concurrency ? ['-race'] : []),
    testPackage,
    '-run',
    `^${fixture.testName}$`,
    `-count=${concurrency ? DETERMINISTIC_TEST_RUNS : 1}`,
    '-v',
  ], {
    cwd: directory,
    env: goEnv,
    timeoutMs: 20 * 60 * 1000,
  });
  if (red.exitCode === 0) throw new Error(`Bug ${bugIndex} 私有验证夹具在 BUG_BASE 上未复现红测`);
  const value = {
    directory,
    testFile: fixture.testFile,
    testPackage,
    testName: fixture.testName,
    command,
    sessionId: result.sessionId,
    redExitCode: red.exitCode,
    sha256: crypto.createHash('sha256').update(testSource).digest('hex'),
    frozenAt: now(),
  };
  await writeJsonAtomic(path.join(directory, 'fixture-manifest.json'), value);
  await updateJob(jobFile, (current) => {
    const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
    if (currentBug) currentBug.verificationFixture = value;
  });
  return value;
}

/**
 * Author the one repository-owned regression test after the Claude repair.
 * The Codex Session gets only the repaired ordinary source; BUG_BASE and all
 * pipeline answer material remain outside its workspace.
 */
export async function preparePostClaudeVerificationTest(jobFile, bugIndex, bugBaseDir, fixedDir, bug) {
  const job = await readJson(jobFile);
  const task = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能生成回归测试`);
  const taskDir = task.taskDir;
  await assertBugfixRepairWorkspace({ ...task, taskType: 'bugfix' }, fixedDir, bugBaseDir);
  const existing = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.verificationTestAuthor;
  if (existing?.sourceDir && existing?.testFile && existing?.sha256) {
    const bytes = await fsp.readFile(path.join(existing.sourceDir, existing.testFile)).catch(() => null);
    if (bytes && crypto.createHash('sha256').update(bytes).digest('hex') === existing.sha256) {
      const testPackage = verificationTestPackage(existing.testFile);
      const normalized = {
        ...existing,
        testPackage,
        command: verificationFixtureCommand(testPackage, existing.testName, { concurrency: isConcurrencyBug(bug) }),
      };
      if (existing.testPackage !== testPackage || existing.command !== normalized.command) {
        await updateJob(jobFile, (current) => {
          const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          if (currentBug) currentBug.verificationTestAuthor = normalized;
        });
      }
      return normalized;
    }
  }
  const attemptId = crypto.randomUUID();
  const authorDir = path.join(taskDir, `codex-test-author-bug${bugIndex}-attempt-${attemptId}`);
  // Claude has completed. The author sees the repaired ordinary workspace;
  // BUG_BASE is used only for the independent red reproduction below.
  await copyWithoutGit(fixedDir, authorDir);
  await makeTreeWritable(authorDir);
  const before = new Map((await readWorkspaceEntries(authorDir)).map((entry) => [
    entry.path,
    crypto.createHash('sha256').update(entry.content).digest('hex'),
  ]));
  const prompt = [
    'The Claude repair Session has completed. You are an independent Codex acceptance-test author.',
    'Read only ordinary repaired source, existing tests, documentation and public entry points. Add exactly one NEW Go *_test.go file containing exactly one TestModel_ test function. Put all issue-specific cases into table-driven cases and t.Run.',
    'Do not modify production code, existing tests, dependencies, documentation, scripts, Dockerfiles or metadata. Do not create commits. Do not inspect Git history, task metadata, Gold, grader, hidden tests, trajectories, verify_cmds or retry material. Do not reconstruct or propose a patch.',
    'The test must pass on the repaired tree and fail deterministically when overlaid on the original BUG_BASE. Return only JSON with test_file, test_package and test_name.',
    `User report:\n${String(bug?.user_query || '').trim()}`,
    `Success criteria:\n${String(bug?.success_criteria || '').trim()}`,
  ].join('\n\n');
  const result = await runCodexJson({
    jobFile,
    stageId: `bug${bugIndex}_test_author`,
    cwd: authorDir,
    prompt,
    schema: postClaudeVerificationTestSchema,
    name: `bug${bugIndex}-post-claude-verification-test`,
    sandbox: 'workspace-write',
    timeoutMs: STRUCTURED_CODEX_TIMEOUT_MS,
    idleTimeoutMs: CODEX_JSON_IDLE_TIMEOUT_MS,
    streamRecoveryWindowMs: STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS,
    reasoningEffort: 'medium',
    ignoreUserConfig: true,
    ephemeral: true,
  });
  const descriptor = result.output || {};
  if (!safeVerificationTestPath(descriptor.test_file) || !String(descriptor.test_name || '').startsWith('TestModel_')) {
    throw new Error(`Bug ${bugIndex} Codex 回归测试描述不合法`);
  }
  const after = await readWorkspaceEntries(authorDir);
  const digest = (entry) => crypto.createHash('sha256').update(entry.content).digest('hex');
  const addedTests = after.filter((entry) => entry.path.endsWith('_test.go') && !before.has(entry.path));
  const changedTests = after.filter((entry) => entry.path.endsWith('_test.go') && before.has(entry.path) && before.get(entry.path) !== digest(entry));
  const changedNonTests = after.filter((entry) => !entry.path.endsWith('_test.go') && (!before.has(entry.path) || before.get(entry.path) !== digest(entry)));
  const removed = [...before.keys()].filter((entry) => !after.some((item) => item.path === entry));
  if (addedTests.length !== 1 || addedTests[0].path !== descriptor.test_file || changedTests.length || changedNonTests.length || removed.length) {
    throw new Error(`Bug ${bugIndex} Codex 测试作者只能新增一个 *_test.go，不能修改生产代码或既有测试`);
  }
  const source = (await fsp.readFile(path.join(authorDir, descriptor.test_file))).toString('utf8');
  const names = goTestNames(source, { prefix: 'TestModel_' });
  if (names.length !== 1 || names[0] !== descriptor.test_name || !isTableDrivenGoTest(source)) {
    throw new Error(`Bug ${bugIndex} Codex 回归测试必须只有一个表驱动 TestModel_ 测试`);
  }
  const concurrency = isConcurrencyBug(bug);
  const plan = buildModelVerificationPlan([{ path: descriptor.test_file, content: source }], { concurrency });
  const testPackage = verificationTestPackage(descriptor.test_file);
  const redDir = path.join(taskDir, `codex-test-red-bug${bugIndex}-attempt-${attemptId}`);
  await copyWithoutGit(bugBaseDir, redDir);
  await fsp.mkdir(path.dirname(path.join(redDir, descriptor.test_file)), { recursive: true });
  await copyFileReplacing(path.join(authorDir, descriptor.test_file), path.join(redDir, descriptor.test_file));
  const goEnv = await projectGoEnvironment(authorDir);
  const focusedArgs = [
    'test',
    ...(concurrency ? ['-race'] : []),
    testPackage,
    '-run',
    `^${descriptor.test_name}$`,
    `-count=${concurrency ? DETERMINISTIC_TEST_RUNS : 1}`,
    '-v',
  ];
  const red = await runCommand('go', focusedArgs, { cwd: redDir, env: goEnv, timeoutMs: 20 * 60 * 1000 });
  if (red.exitCode === 0) throw new Error(`Bug ${bugIndex} Codex 回归测试在 BUG_BASE 上未复现红测`);
  const green = await runCommand('go', focusedArgs, { cwd: authorDir, env: goEnv, timeoutMs: 20 * 60 * 1000 });
  if (green.exitCode !== 0) throw new Error(`Bug ${bugIndex} Codex 回归测试在修复代码上未通过：exit=${green.exitCode}`);
  const sourceDir = path.join(taskDir, `verification-test-bug${bugIndex}-attempt-${attemptId}`);
  await fsp.mkdir(path.dirname(path.join(sourceDir, descriptor.test_file)), { recursive: true });
  await copyFileReplacing(path.join(authorDir, descriptor.test_file), path.join(sourceDir, descriptor.test_file));
  await materializeVerificationTest(taskDir, authorDir, descriptor.test_file);
  const value = {
    testFile: descriptor.test_file,
    testPackage,
    testName: descriptor.test_name,
    command: plan.verify_cmds[0],
    sessionId: result.sessionId,
    sourceDir,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
    redExitCode: red.exitCode,
    greenExitCode: green.exitCode,
    authoredBy: 'codex_after_claude',
    repairSessionId: String(await fsp.readFile(path.join(taskDir, 'trajectory/session_id.txt'), 'utf8').catch(() => '')).trim(),
    frozenAt: now(),
  };
  await writeJsonAtomic(path.join(sourceDir, 'test-manifest.json'), value);
  await updateJob(jobFile, (current) => {
    const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
    if (currentBug) currentBug.verificationTestAuthor = value;
  });
  return value;
}

async function diagnosisTestAuthorSessionId(jobFile, bugIndex, authorDir) {
  const artifactsDir = path.join(path.dirname(jobFile), 'artifacts');
  const artifactName = `bug${bugIndex}-diagnosis-verification-test.codex.jsonl`;
  const candidates = [path.join(artifactsDir, artifactName)];
  const historyDir = path.join(artifactsDir, 'codex-attempt-history');
  for (const entry of await fsp.readdir(historyDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith(`bug${bugIndex}-diagnosis-verification-test-`)) {
      candidates.push(path.join(historyDir, entry.name, artifactName));
    }
  }
  for (const filename of candidates.reverse()) {
    const content = await fsp.readFile(filename, 'utf8').catch(() => '');
    if (!content.includes(path.resolve(authorDir))) continue;
    for (const line of content.split(/\r?\n/)) {
      let event = null;
      try {
        event = JSON.parse(line || 'null');
      } catch {
        continue;
      }
      if (event?.type === 'thread.started' && event.thread_id) return String(event.thread_id);
    }
  }
  return '';
}

async function freezeDiagnosisVerificationTest({
  jobFile,
  bugIndex,
  taskDir,
  bugBaseDir,
  authorDir,
  descriptor,
  sessionId,
  bug,
  attemptId,
  authoredBy = 'codex_after_claude_diagnosis',
}) {
  const source = await fsp.readFile(path.join(authorDir, descriptor.test_file), 'utf8');
  const names = goTestNames(source, { prefix: 'TestModel_' });
  if (names.length !== 1 || names[0] !== descriptor.test_name || !isTableDrivenGoTest(source)) {
    throw new Error(`Bug ${bugIndex} Codex 诊断回归测试必须只有一个表驱动 TestModel_ 测试`);
  }
  const concurrency = isConcurrencyBug(bug);
  const plan = buildModelVerificationPlan([{ path: descriptor.test_file, content: source }], { concurrency });
  const testPackage = verificationTestPackage(descriptor.test_file);
  const redDir = path.join(taskDir, `codex-diagnosis-test-red-bug${bugIndex}-attempt-${attemptId}`);
  await copyWithoutGit(bugBaseDir, redDir);
  await fsp.mkdir(path.dirname(path.join(redDir, descriptor.test_file)), { recursive: true });
  await copyFileReplacing(path.join(authorDir, descriptor.test_file), path.join(redDir, descriptor.test_file));
  const goEnv = await projectGoEnvironment(redDir);
  const focusedArgs = [
    'test',
    ...(concurrency ? ['-race'] : []),
    testPackage,
    '-run',
    `^${descriptor.test_name}$`,
    `-count=${concurrency ? DETERMINISTIC_TEST_RUNS : 1}`,
    '-v',
  ];
  const red = await runCommand('go', focusedArgs, { cwd: redDir, env: goEnv, timeoutMs: 20 * 60 * 1000 });
  if (red.exitCode === 0) throw new Error(`Bug ${bugIndex} Codex 诊断回归测试在 BUG_BASE 上未复现红测`);
  const output = `${red.stdout || ''}\n${red.stderr || ''}`;
  if (/\b(?:undefined|cannot find package|no required module provides|build failed)\b/i.test(output)) {
    throw new Error(`Bug ${bugIndex} Codex 诊断回归测试未能编译并断言目标行为`);
  }
  const verificationDir = path.join(taskDir, `verification-test-bug${bugIndex}-attempt-${attemptId}`);
  await fsp.mkdir(path.dirname(path.join(verificationDir, descriptor.test_file)), { recursive: true });
  await copyFileReplacing(path.join(authorDir, descriptor.test_file), path.join(verificationDir, descriptor.test_file));
  const value = {
    testFile: descriptor.test_file,
    testPackage,
    testName: descriptor.test_name,
    command: plan.verify_cmds[0],
    sessionId,
    sourceDir: verificationDir,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
    redExitCode: red.exitCode,
    greenExitCode: null,
    authoredBy,
    diagnosisSessionId: String(await fsp.readFile(path.join(taskDir, 'trajectory/session_id.txt'), 'utf8').catch(() => '')).trim(),
    frozenAt: now(),
  };
  await writeJsonAtomic(path.join(verificationDir, 'test-manifest.json'), value);
  await updateJob(jobFile, (current) => {
    const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
    if (currentBug) currentBug.verificationTestAuthor = value;
  });
  await ensureDiagnosisWorkspaceUnchanged(taskDir, value);
  return value;
}

// Diagnosis has no repaired tree on which to run a green assertion.  Its
// verification test is therefore authored after the read-only Claude
// trajectory and is checked only for a deterministic failure on BUG_BASE.
// The test remains a system fixture outside workspace and every Git branch.
export async function recoverDiagnosisVerificationTestAttempt(jobFile, bugIndex, bugBaseDir, sourceDir, bug) {
  const job = await readJson(jobFile);
  const taskDir = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task?.taskDir;
  if (!taskDir) return null;
  const baselineEntries = await readWorkspaceEntries(sourceDir);
  const digest = (entry) => crypto.createHash('sha256').update(entry.content).digest('hex');
  const baseline = new Map(baselineEntries.map((entry) => [entry.path, digest(entry)]));
  const prefix = `codex-diagnosis-test-author-bug${bugIndex}-attempt-`;
  const candidates = await Promise.all((await fsp.readdir(taskDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(async (entry) => ({
      path: path.join(taskDir, entry.name),
      mtimeMs: (await fsp.stat(path.join(taskDir, entry.name))).mtimeMs,
    })));
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const entries = await readWorkspaceEntries(candidate.path);
    const addedTests = entries.filter((entry) => entry.path.endsWith('_test.go') && !baseline.has(entry.path));
    const addedNonTests = entries.filter((entry) => !entry.path.endsWith('_test.go') && !baseline.has(entry.path));
    const changed = entries.filter((entry) => baseline.has(entry.path) && baseline.get(entry.path) !== digest(entry));
    const removed = [...baseline.keys()].filter((filename) => !entries.some((entry) => entry.path === filename));
    if (addedTests.length !== 1 || addedNonTests.length || changed.length || removed.length
      || !safeVerificationTestPath(addedTests[0].path)) continue;
    const source = addedTests[0].content.toString('utf8');
    const names = goTestNames(source, { prefix: 'TestModel_' });
    if (names.length !== 1 || !isTableDrivenGoTest(source)) continue;
    const sessionId = await diagnosisTestAuthorSessionId(jobFile, bugIndex, candidate.path);
    if (!sessionId) continue;
    try {
      return await freezeDiagnosisVerificationTest({
        jobFile,
        bugIndex,
        taskDir,
        bugBaseDir,
        authorDir: candidate.path,
        descriptor: { test_file: addedTests[0].path, test_name: names[0] },
        sessionId,
        bug,
        attemptId: `recovered-${crypto.randomUUID()}`,
        authoredBy: 'codex_after_claude_diagnosis_recovered',
      });
    } catch {
      // Keep scanning older isolated attempts; only a deterministic red test is reusable.
    }
  }
  return null;
}

export async function prepareDiagnosisVerificationTest(jobFile, bugIndex, bugBaseDir, sourceDir, bug) {
  const job = await readJson(jobFile);
  const task = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能生成诊断回归测试`);
  const taskDir = task.taskDir;
  const existing = job.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.verificationTestAuthor;
  await ensureDiagnosisWorkspaceUnchanged(taskDir, existing);
  if (existing?.sourceDir && existing?.testFile && existing?.sha256) {
    const bytes = await fsp.readFile(path.join(existing.sourceDir, existing.testFile)).catch(() => null);
    if (bytes && crypto.createHash('sha256').update(bytes).digest('hex') === existing.sha256) {
      const testPackage = verificationTestPackage(existing.testFile);
      const normalized = {
        ...existing,
        testPackage,
        command: verificationFixtureCommand(testPackage, existing.testName, { concurrency: isConcurrencyBug(bug) }),
      };
      if (existing.testPackage !== testPackage || existing.command !== normalized.command) {
        await updateJob(jobFile, (current) => {
          const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          if (currentBug) currentBug.verificationTestAuthor = normalized;
        });
      }
      return normalized;
    }
  }
  const recovered = await recoverDiagnosisVerificationTestAttempt(jobFile, bugIndex, bugBaseDir, sourceDir, bug);
  if (recovered) return recovered;
  const attemptId = crypto.randomUUID();
  const authorDir = path.join(taskDir, `codex-diagnosis-test-author-bug${bugIndex}-attempt-${attemptId}`);
  await copyWithoutGit(sourceDir, authorDir);
  await makeTreeWritable(authorDir);
  const before = new Map((await readWorkspaceEntries(authorDir)).map((entry) => [
    entry.path,
    crypto.createHash('sha256').update(entry.content).digest('hex'),
  ]));
  const prompt = [
    'You are an independent Codex acceptance-test author after a read-only Claude diagnosis.',
    'Read only ordinary source, existing tests, documentation and public entry points. Add exactly one NEW Go *_test.go file with exactly one table-driven TestModel_ function and t.Run cases.',
    'The test must assert the correct public behavior requested by the user report, so it must fail deterministically on the original BUG_BASE. Do not modify production code, existing tests, dependencies, documentation, scripts, Dockerfiles or metadata. Do not create commits.',
    'Do not inspect Git history, task metadata, Gold, grader, hidden tests, trajectories, verify_cmds, retry material or any pipeline path. Do not reconstruct or describe a patch. Return only JSON with test_file, test_package and test_name.',
    `User report:\n${String(bug?.user_query || '').trim()}`,
    `Success criteria:\n${String(bug?.success_criteria || '').trim()}`,
  ].join('\n\n');
  const result = await runCodexJson({
    jobFile,
    stageId: `bug${bugIndex}_test_author`,
    cwd: authorDir,
    prompt,
    schema: postClaudeVerificationTestSchema,
    name: `bug${bugIndex}-diagnosis-verification-test`,
    sandbox: 'workspace-write',
    timeoutMs: STRUCTURED_CODEX_TIMEOUT_MS,
    idleTimeoutMs: CODEX_JSON_IDLE_TIMEOUT_MS,
    streamRecoveryWindowMs: STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS,
    reasoningEffort: 'medium',
    ignoreUserConfig: true,
    ephemeral: true,
  });
  const descriptor = result.output || {};
  if (!safeVerificationTestPath(descriptor.test_file) || !String(descriptor.test_name || '').startsWith('TestModel_')) {
    throw new Error(`Bug ${bugIndex} Codex 诊断回归测试描述不合法`);
  }
  const after = await readWorkspaceEntries(authorDir);
  const digest = (entry) => crypto.createHash('sha256').update(entry.content).digest('hex');
  const addedTests = after.filter((entry) => entry.path.endsWith('_test.go') && !before.has(entry.path));
  const changedTests = after.filter((entry) => entry.path.endsWith('_test.go') && before.has(entry.path) && before.get(entry.path) !== digest(entry));
  const changedNonTests = after.filter((entry) => !entry.path.endsWith('_test.go') && (!before.has(entry.path) || before.get(entry.path) !== digest(entry)));
  const removed = [...before.keys()].filter((entry) => !after.some((item) => item.path === entry));
  if (addedTests.length !== 1 || addedTests[0].path !== descriptor.test_file || changedTests.length || changedNonTests.length || removed.length) {
    throw new Error(`Bug ${bugIndex} Codex 诊断测试作者只能新增一个 *_test.go，不能修改生产代码或既有测试`);
  }
  return freezeDiagnosisVerificationTest({
    jobFile,
    bugIndex,
    taskDir,
    bugBaseDir,
    authorDir,
    descriptor,
    sessionId: result.sessionId,
    bug,
    attemptId,
  });
}

export async function materializeVerificationTest(taskDir, testSourceDir, testFile) {
  if (!safeVerificationTestPath(testFile)) throw new Error(`验证测试路径不安全：${testFile}`);
  const source = path.join(testSourceDir, testFile);
  const destination = path.join(taskDir, 'workspace', testFile);
  if (!(await fsp.stat(source).catch(() => null))?.isFile()) {
    throw new Error(`验证测试文件不存在：${testFile}`);
  }
  // Bugfix delivery owns this workspace after Claude exits and materializes
  // its repository test here. Diagnosis uses an external private fixture.
  await makeTreeWritable(path.join(taskDir, 'workspace'));
  await copyFileReplacing(source, destination);
  return destination;
}

export async function syncAuthoredVerificationMetadata(taskDir, authored, {
  taskType = 'bugfix',
  repairSessionId = '',
  concurrency = false,
} = {}) {
  if (!authored?.sourceDir || !safeVerificationTestPath(authored?.testFile)) {
    throw new Error('缺少可恢复的 Codex 回归测试元数据');
  }
  const sourcePath = path.join(authored.sourceDir, authored.testFile);
  const source = await fsp.readFile(sourcePath, 'utf8');
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  if (authored.sha256 && digest !== authored.sha256) {
    throw new Error(`Codex 回归测试哈希不一致：${authored.testFile}`);
  }
  const plan = buildModelVerificationPlan([{ path: authored.testFile, content: source }], { concurrency });
  const diagnosis = taskType === 'diagnosis';
  await updatePublicMetadata(taskDir, (metadata) => {
    Object.assign(metadata, {
      verify_cmds: plan.verify_cmds,
      verification_test_overlay: diagnosis ? 'private-fixture' : 'repository-tests',
      verification_test_files: plan.verification_test_files,
      verification_test_names: plan.verification_test_names,
      verification_test_manifest: plan.verification_test_manifest,
      model_verification_policy_version: plan.policy_version,
      concurrency_verification: plan.concurrency_verification,
      verification_repeat_count: plan.verification_repeat_count,
      verification_test_author: diagnosis ? 'codex_after_claude_diagnosis' : 'codex_after_claude',
      verification_test_author_session_id: authored.sessionId || '',
      verification_test_author_files: plan.verification_test_files,
      verification_test_source_dir: authored.sourceDir,
      verification_test_sha256: digest,
      ...(concurrency ? {
        success_criteria: concurrencyVerificationNarrative(metadata.success_criteria, plan.verify_cmds[0]),
        gold_root_cause: concurrencyVerificationNarrative(metadata.gold_root_cause, plan.verify_cmds[0]),
      } : {}),
      ...(diagnosis ? {
        diagnosis_workspace_policy_version: 1,
        verification_fixture_dir: authored.sourceDir,
        verification_fixture_sha256: digest,
        verification_fixture_published: false,
        verification_fixture_materialized: false,
        verification_test_published: false,
        verification_test_storage: 'system-fixture-only',
      } : {
        verification_test_repair_session_id: repairSessionId || authored.repairSessionId || '',
      }),
    });
  });
  return plan;
}

async function prepareV3BugfixGitLayout(jobFile, bugIndex, fixedDir, testFile) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const taskDir = bug?.task?.taskDir;
  const bugBaseDir = bug?.bugBaseDir;
  const bugBaseCommit = String(bug?.bugBaseCommit || '');
  if (!taskDir || !bugBaseDir || !/^[a-f0-9]{40}$/i.test(bugBaseCommit)) {
    throw new Error(`Bug ${bugIndex} 缺少 G1 工作区或提交，不能冻结 Git 验收布局`);
  }
  const layoutDir = path.join(taskDir, '.git-layout');
  const layoutMetaPath = path.join(taskDir, '.git-layout.json');
  const existing = await readJson(layoutMetaPath, null);
  const passedRepairAttempts = (bug.attempts || []).filter((attempt) => attempt?.status === 'passed' && attempt?.sessionId);
  const repairSessionId = String(passedRepairAttempts.at(-1)?.sessionId || bug.verificationTestAuthor?.repairSessionId || '');
  await removeGeneratedCompilerArtifacts(fixedDir, bugBaseDir);
  if (existing?.green_commit && existing?.red_commit && existing?.repository) {
    const testBytes = await fsp.readFile(path.join(fixedDir, testFile));
    const testSha = crypto.createHash('sha256').update(testBytes).digest('hex');
    const [localGreen, localRed] = await Promise.all([
      git(layoutDir, ['rev-parse', `refs/heads/${existing.green_branch}`]).then((result) => result.stdout.trim()),
      git(layoutDir, ['rev-parse', `refs/heads/${existing.red_branch}`]).then((result) => result.stdout.trim()),
    ]);
    if (localGreen !== existing.green_commit || localRed !== existing.red_commit
      || existing.bug_base_commit !== bugBaseCommit || existing.test_file !== testFile
      || existing.test_sha256 !== testSha) {
      throw new Error(`Bug ${bugIndex} 已有 Git 布局与当前 G1、测试或分支提交不一致`);
    }
    const publicationPassed = job.stages?.find((stage) => stage.id === `bug${bugIndex}_git_publication`)?.status === 'passed';
    if (publicationPassed) {
      const [remoteGreen, remoteRed] = await Promise.all([
        remoteHead(job.request.cloneUrl, existing.green_branch, layoutDir),
        remoteHead(job.request.cloneUrl, existing.red_branch, layoutDir),
      ]);
      if (remoteGreen !== existing.green_commit || remoteRed !== existing.red_commit) {
        throw new Error(`Bug ${bugIndex} 已通过的 Git 发布阶段与远端红绿分支头不一致`);
      }
    }
    await updatePublicMetadata(taskDir, (metadata) => Object.assign(metadata, {
      test_model_fix_commit: existing.green_commit,
      test_model_fix_pushed: publicationPassed,
      test_model_fix_branch: existing.green_branch,
      test_model_fix_session_id: repairSessionId,
      test_model_fix_base_commit: bugBaseCommit,
      green_fix_commit: existing.green_commit,
      red_commit: existing.red_commit,
      red_pushed: publicationPassed,
      red_branch: existing.red_branch,
      repo_url: `${String(metadata.repository || '').replace(/\.git$/, '').replace(/\/$/, '')}/tree/${existing.green_branch}`,
      verification_test_sha256: testSha,
    }));
    return { ...existing, reused: true, published: publicationPassed };
  }
  await fsp.rm(layoutDir, { recursive: true, force: true });
  await runRequired('冻结本地 G1/G2/R1 Git 布局', 'git', ['clone', '--quiet', '--no-hardlinks', bugBaseDir, layoutDir], { cwd: taskDir, timeoutMs: 10 * 60 * 1000 });
  const greenBranch = numberedGreenBranch(bugIndex);
  const redBranch = numberedRedBranch(bugIndex);
  await git(layoutDir, ['switch', '-C', greenBranch, bugBaseCommit]);
  await copyWithoutGit(fixedDir, layoutDir);
  await git(layoutDir, ['add', '-A']);
  await git(layoutDir, ['-c', 'user.name=Claude Code', '-c', 'user.email=claude-code@local.invalid', 'commit', '-m', `fix: ${numberedBugId(job.request.repository, bugIndex)}`]);
  const greenCommit = (await git(layoutDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const greenParent = (await git(layoutDir, ['rev-parse', `${greenCommit}^`])).stdout.trim();
  if (greenParent !== bugBaseCommit) throw new Error(`Bug ${bugIndex} 本地 G2 不是 G1 的直接子提交`);
  await git(layoutDir, ['switch', '--orphan', redBranch]);
  await git(layoutDir, ['read-tree', '--reset', bugBaseCommit]);
  await git(layoutDir, ['clean', '-fdx', '-q']);
  await git(layoutDir, ['checkout-index', '-a', '-f']);
  await fsp.mkdir(path.dirname(path.join(layoutDir, testFile)), { recursive: true });
  await fsp.copyFile(path.join(fixedDir, testFile), path.join(layoutDir, testFile));
  await git(layoutDir, ['add', '-A']);
  await git(layoutDir, ['-c', 'user.name=Go Pipeline', '-c', 'user.email=go-pipeline@local.invalid', 'commit', '-m', 'red: acceptance checks']);
  const redCommit = (await git(layoutDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const redParents = (await git(layoutDir, ['rev-list', '--parents', '-n', '1', redCommit])).stdout.trim().split(/\s+/).filter(Boolean);
  if (redParents.length !== 1) throw new Error(`Bug ${bugIndex} 本地 R1 必须是 orphan 提交`);
  const testSha = crypto.createHash('sha256').update(await fsp.readFile(path.join(fixedDir, testFile))).digest('hex');
  const value = { version: 1, repository: layoutDir, green_branch: greenBranch, green_commit: greenCommit, red_branch: redBranch, red_commit: redCommit, bug_base_commit: bugBaseCommit, test_file: testFile, test_sha256: testSha, prepared_at: now() };
  await writeJsonAtomic(layoutMetaPath, value);
  await updatePublicMetadata(taskDir, (metadata) => Object.assign(metadata, {
    test_model_fix_commit: greenCommit,
    test_model_fix_pushed: false,
    test_model_fix_branch: greenBranch,
    test_model_fix_session_id: repairSessionId,
    red_commit: redCommit,
    red_pushed: false,
    red_branch: redBranch,
  }));
  return value;
}

// Diagnosis publishes its immutable source-only R1 before Claude starts. The
// independent verification test is a system fixture and must never be added
// to workspace or any submitted Git branch.
export async function finalizeV3DiagnosisImmutableDelivery(jobFile, bugIndex, testSourceDir, testFile) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const taskDir = bug?.task?.taskDir;
  const bugBaseDir = bug?.bugBaseDir;
  if (!taskDir || !bugBaseDir || !safeVerificationTestPath(testFile)) {
    throw new Error(`Bug ${bugIndex} 缺少 diagnosis R1 工作区或安全外置测试文件`);
  }
  const redBranch = bug.redBranch || numberedRedBranch(bugIndex);
  const sourceCommit = String(bug.diagnosisSourceCommit || (!bug.redCommit ? bug.bugBaseCommit : '') || '').trim();
  let redCommit = String(bug.redCommit || bug.bugBaseCommit || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error(`Bug ${bugIndex} 缺少 diagnosis 原始源提交`);
  if (!/^[a-f0-9]{40}$/i.test(redCommit)) throw new Error(`Bug ${bugIndex} 缺少 diagnosis 红分支提交`);
  const testBytes = await fsp.readFile(path.join(testSourceDir, testFile));
  const testSha = crypto.createHash('sha256').update(testBytes).digest('hex');
  const [sourceTree, initialRedTree, initialRemoteCommit] = await Promise.all([
    git(bugBaseDir, ['rev-parse', `${sourceCommit}^{tree}`]).then((result) => result.stdout.trim()),
    git(bugBaseDir, ['rev-parse', `${redCommit}^{tree}`]).then((result) => result.stdout.trim()),
    remoteHead(job.request.cloneUrl, redBranch, bugBaseDir),
  ]);
  let redTree = initialRedTree;
  let remoteCommit = initialRemoteCommit;
  if (sourceTree !== redTree) {
    if (!Array.isArray(bug.qualityRejectionHistory) || !bug.qualityRejectionHistory.length) {
      throw new Error(`Bug ${bugIndex} diagnosis 红分支包含持久代码或测试改动，必须迁移后重新生成证明`);
    }
    const previousRedCommit = redCommit;
    redCommit = await createOrphanDiagnosisRedSnapshot(bugBaseDir, sourceCommit, bugIndex);
    const lease = remoteCommit
      ? `--force-with-lease=refs/heads/${redBranch}:${remoteCommit}`
      : '--force-with-lease';
    await git(
      bugBaseDir,
      ['push', lease, job.request.cloneUrl, `${redCommit}:refs/heads/${redBranch}`],
      `迁移 Bug ${bugIndex} diagnosis 只读 red 分支`,
    );
    remoteCommit = redCommit;
    redTree = sourceTree;
    await updateJob(jobFile, (current) => {
      const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
      currentBug.diagnosisSourceCommit = sourceCommit;
      currentBug.redBranch = redBranch;
      currentBug.redCommit = redCommit;
      currentBug.bugBaseCommit = redCommit;
      currentBug.diagnosisRedMigrationHistory = [...(currentBug.diagnosisRedMigrationHistory || []), {
        migratedAt: now(),
        previousRedCommit,
        redCommit,
        reason: 'quality_rejection_read_only_rebind',
      }];
    });
  }
  if (sourceTree !== redTree) throw new Error(`Bug ${bugIndex} diagnosis 红分支源码树迁移失败`);
  if (remoteCommit !== redCommit) {
    throw new Error(`Bug ${bugIndex} 远端 ${redBranch} 与源码只读 R1 不一致：${remoteCommit || '分支不存在'}`);
  }
  const parents = (await git(bugBaseDir, ['rev-list', '--parents', '-n', '1', redCommit])).stdout.trim().split(/\s+/).filter(Boolean);
  if (parents.length !== 1) throw new Error(`Bug ${bugIndex} diagnosis R1 必须是 orphan 提交`);
  await ensureDiagnosisWorkspaceUnchanged(taskDir, { testFile, sha256: testSha });
  await updateJob(jobFile, (current) => {
    const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
    Object.assign(currentBug, {
      diagnosisSourceCommit: sourceCommit,
      redBranch,
      redCommit,
      bugBaseCommit: redCommit,
      diagnosisVerificationTestSha256: testSha,
    });
  });
  await updatePublicMetadata(taskDir, (metadata) => Object.assign(metadata, {
    red_branch: redBranch,
    red_commit: redCommit,
    red_pushed: true,
    bug_base_commit: redCommit,
    bug_base_branch: '',
    test_model_fix_branch: redBranch,
    test_model_fix_base_commit: redCommit,
    test_model_fix_commit: redCommit,
    test_model_fix_pushed: true,
    repo_url: `${String(metadata.repository || '').replace(/\/$/, '')}/tree/${redBranch}`,
    verification_test_sha256: testSha,
    verification_fixture_published: false,
    verification_fixture_materialized: false,
    verification_test_published: false,
    verification_test_storage: 'system-fixture-only',
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: true,
  }));
  return { redCommit, redBranch, testSha, sourceOnly: true };
}

export async function existingDiagnosisVerificationPlan(root, command) {
  const requestedNames = verificationTestNamesFromCommand(command);
  if (!requestedNames.length) {
    return {
      verification_test_overlay: 'none',
      verification_test_files: [],
      verification_test_names: [],
      verification_test_manifest: [],
    };
  }
  const sources = (await readWorkspaceEntries(root))
    .filter((entry) => entry.path.endsWith('_test.go'))
    .map((entry) => ({ ...entry, text: entry.content.toString('utf8') }));
  const matched = sources.filter((entry) => {
    const names = new Set(goTestNames(entry.text));
    return requestedNames.some((name) => names.has(name));
  });
  const foundNames = new Set(matched.flatMap((entry) => goTestNames(entry.text)));
  const missingNames = requestedNames.filter((name) => !foundNames.has(name));
  if (missingNames.length) {
    throw new Error(`diagnosis verify_cmds 指向的公开测试不存在：${missingNames.join('、')}`);
  }
  return {
    verification_test_overlay: 'repository-tests',
    verification_test_files: matched.map((entry) => entry.path).sort(),
    verification_test_names: requestedNames,
    verification_test_manifest: matched.map((entry) => ({
      path: entry.path,
      sha256: crypto.createHash('sha256').update(entry.content).digest('hex'),
    })).sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function normalizeDiagnosisVerificationTests(root, command) {
  const requestedNames = verificationTestNamesFromCommand(command);
  if (!requestedNames.length) return [];
  const normalizedFiles = [];
  for (const entry of await readWorkspaceEntries(root)) {
    if (!entry.path.endsWith('_test.go')) continue;
    const source = entry.content.toString('utf8');
    const names = new Set(goTestNames(source));
    if (!requestedNames.some((name) => names.has(name))) continue;
    const normalized = normalizeDiagnosisVerificationSource(source);
    if (normalized === source) continue;
    await fsp.writeFile(path.join(root, entry.path), normalized, 'utf8');
    normalizedFiles.push(entry.path);
  }
  return normalizedFiles.sort();
}

export async function projectGoEnvironment(projectDir) {
  const dockerfile = await fsp.readFile(path.join(projectDir, 'benzhi.Dockerfile'), 'utf8').catch(() => '');
  const dockerVersion = dockerfile.match(/^\s*FROM\s+(?:--platform=[^\s]+\s+)?golang:(\d+\.\d+(?:\.\d+)?)(?:[-\s]|$)/im)?.[1];
  const version = dockerVersion || process.env.GO_PIPELINE_GO_TOOLCHAIN_VERSION || '1.25.6';
  // A two-part Go version (for example 1.23) is a language/image series,
  // not a valid GOTOOLCHAIN value. Let the installed toolchain handle it;
  // only pin GOTOOLCHAIN when a complete patch version is available.
  const gotoToolchain = /^\d+\.\d+\.\d+$/.test(version) ? `go${version}` : 'local';
  return {
    GOTOOLCHAIN: gotoToolchain,
    GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
  };
}

export async function removeGeneratedBuildArtifacts(projectDir) {
  const removed = [];
  const goEntries = [];
  async function collectGoSources(directory, relative = '') {
    for (const child of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (child.name === '.git' || child.name === 'node_modules' || child.name === 'dist') continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await collectGoSources(absolute, childRelative);
      else if (child.isFile() && child.name.endsWith('.go')) goEntries.push({ path: childRelative, content: await fsp.readFile(absolute) });
    }
  }
  await collectGoSources(projectDir);
  const embeddedDistDirs = new Set(goEmbeddedDistDirectories(goEntries));
  async function visit(directory, relative = '') {
    for (const child of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (child.name === '.git') continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory() && child.name === 'dist' && embeddedDistDirs.has(childRelative)) continue;
      if (child.isDirectory() && ['node_modules', 'dist'].includes(child.name)) {
        await fsp.rm(absolute, { recursive: true, force: true });
        removed.push(childRelative);
        continue;
      }
      if (child.isDirectory()) await visit(absolute, childRelative);
    }
  }
  await visit(projectDir);
  return removed.sort();
}

async function buildGeneratedProjectFrontend(projectDir, deadlineMs = 0) {
  const frontendDir = findFrontendDir((await readWorkspaceEntries(projectDir)).map((entry) => entry.path));
  if (!frontendDir) return '';
  const timeout = () => deadlineMs
    ? remainingProjectGenerationTimeout(deadlineMs, 20 * 60_000)
    : 20 * 60_000;
  const cwd = path.join(projectDir, frontendDir);
  await runRequired('生成项目前端依赖安装', 'npm', ['ci'], { cwd, timeoutMs: timeout() });
  await runRequired('生成项目前端构建', 'npm', ['run', 'build'], { cwd, timeoutMs: timeout() });
  return frontendDir;
}

async function writeFileIfChanged(filename, content) {
  const next = Buffer.from(content);
  const current = await fsp.readFile(filename).catch(() => null);
  if (current && current.equals(next)) return false;
  await fsp.writeFile(filename, next);
  return true;
}

async function normalizeProjectSupportFiles(projectDir, plan) {
  const packageOptions = projectPackageRuleOptions(plan);
  if (packageOptions.projectPackagePolicyVersion >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION) {
    const removeBugReproFiles = async (directory) => {
      for (const child of await fsp.readdir(directory, { withFileTypes: true })) {
        if (child.name === '.git') continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) await removeBugReproFiles(absolute);
        else if ((child.isFile() || child.isSymbolicLink()) && isBugReproPath(child.name)) await fsp.rm(absolute, { force: true });
      }
    };
    await removeBugReproFiles(projectDir);
  }
  await removeGeneratedBuildArtifacts(projectDir);
  const goMod = await fsp.readFile(path.join(projectDir, 'go.mod'), 'utf8');
  const languageVersion = goModVersion(goMod);
  if (!languageVersion) throw new Error('Claude 生成的 go.mod 缺少 go 语言版本');
  const toolchainVersion = process.env.GO_PIPELINE_GO_TOOLCHAIN_VERSION || '1.25.6';
  const goEnvironment = await projectGoEnvironment(projectDir);
  await runRequired('Claude 项目依赖整理', 'go', ['mod', 'tidy'], {
    cwd: projectDir,
    env: goEnvironment,
    timeoutMs: 20 * 60 * 1000,
  });
  await runRequired('统一项目 Go 工具链', 'go', ['mod', 'edit', `-toolchain=go${toolchainVersion}`], {
    cwd: projectDir,
    env: goEnvironment,
    timeoutMs: 2 * 60 * 1000,
  });
  const entries = await readWorkspaceEntries(projectDir);
  const supportFiles = createPackageSupportFiles({
    name: plan.project_slug,
    go_version: `go${toolchainVersion}; go.mod go ${languageVersion}`,
    project_package_policy_version: packageOptions.projectPackagePolicyVersion,
    project_type: packageOptions.projectType,
    project_summary: packageOptions.projectSummary,
  }, entries);
  for (const file of supportFiles) {
    await writeFileIfChanged(path.join(projectDir, file.path), file.content);
  }
  await fsp.chmod(path.join(projectDir, 'build_benzhi_docker.sh'), 0o755);
  if (await fsp.stat(path.join(projectDir, 'run_benzhi_smoke.sh')).catch(() => null)) {
    await fsp.chmod(path.join(projectDir, 'run_benzhi_smoke.sh'), 0o755);
  }
}

export async function projectValidationFingerprint(projectDir) {
  const hash = crypto.createHash('sha256');
  const entries = (await readWorkspaceEntries(projectDir))
    .filter((entry) => !entry.path.split('/').some((segment) => ['node_modules', 'dist'].includes(segment)))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function projectValidationReportPassed(report, platform = '') {
  if (!report?.ok) return false;
  if (!platform) return report.static?.accepted === true;
  const result = (report.docker?.results || []).find((item) => item?.platform === platform);
  return report.docker?.ok === true
    && result?.build?.exitCode === 0
    && result?.verify?.exitCode === 0;
}

async function validateGeneratedProjectDelivery(jobFile, projectDir, plan) {
  const jobDir = path.dirname(jobFile);
  const artifactsDir = path.join(jobDir, 'artifacts');
  const checkpointPath = path.join(artifactsDir, 'project-validation-checkpoints.json');
  await fsp.mkdir(artifactsDir, { recursive: true });
  let repairCount = 0;
  let checkpointHits = 0;
  const packageOptions = projectPackageRuleOptions(plan);
  const packageValidationArgs = packageOptions.projectPackagePolicyVersion >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION
    ? [
        `--package-policy-version=${packageOptions.projectPackagePolicyVersion}`,
        `--project-type=${packageOptions.projectType}`,
        `--project-summary=${packageOptions.projectSummary}`,
      ]
    : [];

  const runValidation = async ({ label, reportPath, args, idleTimeoutMs = 0 }) => {
    let lastProgressAt = 0;
    const result = await runCommand(process.execPath, [projectValidatorPath, ...packageValidationArgs, ...args, projectDir], {
      cwd: monitorRoot,
      stdoutPath: reportPath,
      stderrPath: `${reportPath}.stderr.log`,
      timeoutMs: 0,
      idleTimeoutMs,
      outputObserver(_stream, chunk) {
        const observedAt = Date.now();
        if (observedAt - lastProgressAt >= 2 * 60_000) {
          lastProgressAt = observedAt;
          const detail = String(chunk).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300) || '子进程仍在运行';
          void appendLog(jobFile, 'info', `${label}进行中：${detail}`, 'project_validate');
        }
        return null;
      },
    });
    const report = await readJson(reportPath, { ok: false, error: result.stderr || result.error });
    return { result, report };
  };

  const runCommandCheckpoint = async ({ label, reportPath, commands, idleTimeoutMs }) => {
    const results = [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      let lastProgressAt = 0;
      const result = await runCommand(command.bin, command.args, {
        cwd: command.cwd || projectDir,
        env: command.env,
        stdoutPath: `${reportPath}.${index + 1}.stdout.log`,
        stderrPath: `${reportPath}.${index + 1}.stderr.log`,
        timeoutMs: 0,
        idleTimeoutMs,
        outputObserver(_stream, chunk) {
          const observedAt = Date.now();
          if (observedAt - lastProgressAt < 2 * 60_000) return null;
          lastProgressAt = observedAt;
          const detail = String(chunk).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300);
          if (detail) void appendLog(jobFile, 'info', `${label}：${detail}`, 'project_validate');
          return null;
        },
      });
      results.push({
        command: [command.bin, ...command.args].join(' '),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        idleTimedOut: result.idleTimedOut,
        durationMs: result.durationMs,
      });
      if (result.exitCode !== 0) {
        const report = { ok: false, label, results };
        await writeJsonAtomic(reportPath, report);
        return { report, failure: commandFailure(label, result) };
      }
    }
    const report = { ok: true, label, results };
    await writeJsonAtomic(reportPath, report);
    return { report, failure: null };
  };

  const repairCheckpointFailure = async (failure, label) => {
    if (repairCount >= 1) throw failure;
    repairCount += 1;
    await appendLog(jobFile, 'warn', `${label}失败，启动一次定向修复：${failure.message.slice(0, 1200)}`, 'project_validate');
    await repairGeneratedProjectAfterValidation(jobFile, projectDir, plan, failure.message);
  };

  const resetDockerInfrastructure = async (platform, failure) => {
    await withFileLock(path.join(artifactsDir, 'docker-infrastructure-reset.lock'), async () => {
      const detail = String(failure?.message || 'Docker 基础设施故障');
      await appendLog(jobFile, 'warn', `${platform} Docker 基础设施故障，重置共享 Builder 后只重跑当前架构，不调用 Claude`, 'project_validate');
      const commands = [
        ['version'],
        ['buildx', 'inspect', 'benzhi-builder', '--bootstrap'],
      ];
      if (/lease|cache|content digest|failed to solve|no space left/i.test(detail)) {
        commands.push(['buildx', 'prune', '--builder', 'benzhi-builder', '-f', '--filter', 'until=24h', '--max-used-space', '20GB', '--reserved-space', '10GB']);
      }
      for (const args of commands) {
        const result = await runCommand('docker', args, {
          cwd: monitorRoot,
          timeoutMs: 5 * 60_000,
          idleTimeoutMs: 2 * 60_000,
        });
        if (result.exitCode !== 0) {
          await appendLog(jobFile, 'warn', `Docker 重置步骤失败但仍保留当前架构重试：docker ${args.join(' ')}`, 'project_validate');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }, { timeoutMs: 15 * 60_000, staleMs: 30 * 60_000 });
  };

  for (;;) {
    await normalizeProjectSupportFiles(projectDir, plan);
    const fingerprint = await projectValidationFingerprint(projectDir);
    const saved = await readJson(checkpointPath, {});
    const checkpoint = saved.version === 2 && saved.fingerprint === fingerprint
      ? saved
      : { version: 2, fingerprint, static: null, go: null, frontend: null, platforms: {}, updatedAt: now() };

    const staticReportPath = path.join(artifactsDir, 'project-validation-static.json');
    const savedStaticReport = checkpoint.static?.status === 'passed'
      ? await readJson(staticReportPath, null)
      : null;
    let staticReport = savedStaticReport;
    if (projectValidationReportPassed(savedStaticReport)) {
      checkpointHits += 1;
      await appendLog(jobFile, 'info', '复用已通过的项目静态校验检查点', 'project_validate');
    } else {
      await appendLog(jobFile, 'info', '开始项目静态交付校验', 'project_validate');
      const validation = await runValidation({
        label: '项目静态交付校验',
        reportPath: staticReportPath,
        args: ['--static-only'],
        idleTimeoutMs: 5 * 60_000,
      });
      staticReport = validation.report;
      if (validation.result.exitCode !== 0 || !projectValidationReportPassed(staticReport)) {
        const failure = commandFailure('项目静态交付校验', validation.result);
        await repairCheckpointFailure(failure, '项目静态清洁检查');
        continue;
      }
      checkpoint.static = { status: 'passed', reportPath: staticReportPath, completedAt: now() };
      checkpoint.updatedAt = now();
      await writeJsonAtomic(checkpointPath, checkpoint);
    }

    const frontendDir = staticReport?.static?.frontendDir || '';
    const hasEmbeddedFrontendOutput = goEmbeddedDistDirectories(await readWorkspaceEntries(projectDir)).length > 0;
    const goReportPath = path.join(artifactsDir, 'project-validation-go.json');
    const frontendReportPath = path.join(artifactsDir, 'project-validation-frontend.json');
    const runGoCheckpoint = async () => {
      const savedReport = checkpoint.go?.status === 'passed' ? await readJson(goReportPath, null) : null;
      if (savedReport?.ok === true) {
        await appendLog(jobFile, 'info', '复用已通过的 Go build/test/vet 检查点', 'project_validate');
        return { reused: true, entry: checkpoint.go, failure: null };
      }
      await appendLog(jobFile, 'info', '开始 Go build/test/vet 检查点', 'project_validate');
      const goEnvironment = await projectGoEnvironment(projectDir);
      const result = await runCommandCheckpoint({
        label: 'Go build/test/vet 检查点',
        reportPath: goReportPath,
        idleTimeoutMs: 10 * 60_000,
        commands: [
          { bin: 'go', args: ['build', './...'], env: goEnvironment },
          { bin: 'go', args: ['test', './...', '-count=1'], env: goEnvironment },
          { bin: 'go', args: ['vet', './...'], env: goEnvironment },
        ],
      });
      return {
        reused: false,
        entry: result.failure ? null : { status: 'passed', reportPath: goReportPath, completedAt: now() },
        failure: result.failure,
      };
    };
    const runFrontendCheckpoint = async ({ materialize = false } = {}) => {
      const savedReport = checkpoint.frontend?.status === 'passed' ? await readJson(frontendReportPath, null) : null;
      if (savedReport?.ok === true && !materialize) {
        await appendLog(jobFile, 'info', `复用已通过的前端构建检查点${frontendDir ? '' : '（项目无前端）'}`, 'project_validate');
        return { reused: true, entry: checkpoint.frontend, failure: null };
      }
      if (!frontendDir) {
        const report = { ok: true, skipped: true, reason: '项目无前端目录' };
        await writeJsonAtomic(frontendReportPath, report);
        return {
          reused: false,
          entry: { status: 'passed', skipped: true, reportPath: frontendReportPath, completedAt: now() },
          failure: null,
        };
      }
      await appendLog(jobFile, 'info', `开始 ${frontendDir} 前端 npm ci/build 检查点`, 'project_validate');
      const result = await runCommandCheckpoint({
        label: `${frontendDir} 前端 npm ci/build 检查点`,
        reportPath: frontendReportPath,
        idleTimeoutMs: 10 * 60_000,
        commands: [
          { bin: 'npm', args: ['ci'], cwd: path.join(projectDir, frontendDir) },
          { bin: 'npm', args: ['run', 'build'], cwd: path.join(projectDir, frontendDir) },
        ],
      });
      return {
        reused: false,
        entry: result.failure ? null : { status: 'passed', reportPath: frontendReportPath, completedAt: now() },
        failure: result.failure,
      };
    };

    let goOutcome;
    let frontendOutcome;
    if (frontendDir && hasEmbeddedFrontendOutput) {
      await appendLog(jobFile, 'info', '检测到 Go embed 前端产物，前端构建完成后再执行 Go 检查', 'project_validate');
      frontendOutcome = await runFrontendCheckpoint({ materialize: true });
      goOutcome = frontendOutcome.failure
        ? { reused: false, entry: null, failure: null }
        : await runGoCheckpoint();
    } else {
      [goOutcome, frontendOutcome] = await Promise.all([
        runGoCheckpoint(),
        runFrontendCheckpoint(),
      ]);
    }
    await removeGeneratedBuildArtifacts(projectDir);
    checkpointHits += Number(goOutcome.reused) + Number(frontendOutcome.reused);
    const localFailures = [goOutcome.failure, frontendOutcome.failure].filter(Boolean);
    if (localFailures.length) {
      const failure = localFailures.length === 1
        ? localFailures[0]
        : new Error(localFailures.map((error) => error.message).join('\n\n'));
      await repairCheckpointFailure(failure, 'Go 与前端并行检查点');
      continue;
    }
    checkpoint.go = goOutcome.entry;
    checkpoint.frontend = frontendOutcome.entry;
    checkpoint.updatedAt = now();
    await writeJsonAtomic(checkpointPath, checkpoint);

    const platformInputs = await Promise.all(PROJECT_VALIDATION_PLATFORMS.map(async (platform) => {
      const reportPath = path.join(artifactsDir, `project-validation-${platform.replace('/', '-')}.json`);
      const savedReport = checkpoint.platforms?.[platform]?.status === 'passed'
        ? await readJson(reportPath, null)
        : null;
      return { platform, reportPath, savedReport };
    }));
    const validatePlatform = async ({ platform, reportPath, savedReport }) => {
      if (projectValidationReportPassed(savedReport, platform)) {
        await appendLog(jobFile, 'info', `复用已通过的 ${platform} Docker 校验检查点`, 'project_validate');
        return { platform, reportPath, report: savedReport, reused: true, sourceFailure: null, infrastructureFailure: null };
      }

      for (let infrastructureAttempt = 0; infrastructureAttempt <= PROJECT_VALIDATION_INFRA_RETRIES; infrastructureAttempt += 1) {
        await appendLog(jobFile, 'info', `开始 ${platform} Docker 校验${infrastructureAttempt ? `（基础设施重试 ${infrastructureAttempt}/${PROJECT_VALIDATION_INFRA_RETRIES}）` : ''}`, 'project_validate');
        const validation = await runValidation({
          label: `${platform} Docker 校验`,
          reportPath,
          args: [`--platform=${platform}`],
          idleTimeoutMs: PROJECT_VALIDATION_IDLE_TIMEOUT_MS,
        });
        if (validation.result.exitCode === 0 && projectValidationReportPassed(validation.report, platform)) {
          return { platform, reportPath, report: validation.report, reused: false, sourceFailure: null, infrastructureFailure: null };
        }
        const failure = commandFailure(`${platform} Docker 校验`, validation.result);
        const category = classifyPipelineFailure({ currentStage: 'project_validate', error: failure.message });
        if (category !== 'docker_infrastructure') {
          return { platform, reportPath, report: null, reused: false, sourceFailure: failure, infrastructureFailure: null };
        }
        if (infrastructureAttempt >= PROJECT_VALIDATION_INFRA_RETRIES) {
          return { platform, reportPath, report: null, reused: false, sourceFailure: null, infrastructureFailure: failure };
        }
        await appendLog(jobFile, 'warn', `${platform} 遇到 Docker 基础设施故障，仅重试当前平台：${failure.message.slice(0, 1000)}`, 'project_validate');
        await resetDockerInfrastructure(platform, failure);
      }
      return { platform, reportPath, report: null, reused: false, sourceFailure: null, infrastructureFailure: new Error(`${platform} Docker 校验未产生结果`) };
    };
    const pendingPlatformCount = platformInputs.filter(({ platform, savedReport }) => !projectValidationReportPassed(savedReport, platform)).length;
    let releaseParallelDockerSlot = null;
    let platformOutcomes;
    try {
      if (pendingPlatformCount > 1) {
        releaseParallelDockerSlot = await acquireStageResourceSlot(jobFile, 'project_validate', { optional: true });
      }
      if (releaseParallelDockerSlot) {
        await appendLog(jobFile, 'info', '双架构 Docker 校验已取得第二个全局槽位，开始并行执行', 'project_validate');
        platformOutcomes = await Promise.all(platformInputs.map(validatePlatform));
      } else {
        if (pendingPlatformCount > 1) {
          await appendLog(jobFile, 'info', '第二个 Docker 槽位正忙，双架构保持顺序执行以避免主机过载', 'project_validate');
        }
        platformOutcomes = [];
        for (const input of platformInputs) platformOutcomes.push(await validatePlatform(input));
      }
    } finally {
      if (releaseParallelDockerSlot) await releaseParallelDockerSlot();
    }

    let checkpointChanged = false;
    for (const outcome of platformOutcomes) {
      if (outcome.reused) checkpointHits += 1;
      if (!projectValidationReportPassed(outcome.report, outcome.platform) || outcome.reused) continue;
      checkpoint.platforms ||= {};
      checkpoint.platforms[outcome.platform] = { status: 'passed', reportPath: outcome.reportPath, completedAt: now() };
      checkpoint.updatedAt = now();
      checkpointChanged = true;
    }
    if (checkpointChanged) {
      await writeJsonAtomic(checkpointPath, checkpoint);
    }

    const infrastructureFailure = platformOutcomes.find((outcome) => outcome.infrastructureFailure)?.infrastructureFailure;
    if (infrastructureFailure) throw infrastructureFailure;
    const sourceFailures = platformOutcomes.map((outcome) => outcome.sourceFailure).filter(Boolean);
    if (sourceFailures.length) {
      const sourceFailure = sourceFailures.length === 1
        ? sourceFailures[0]
        : new Error(sourceFailures.map((error) => error.message).join('\n\n'));
      if (repairCount >= 1) throw sourceFailure;
      repairCount += 1;
      await appendLog(jobFile, 'warn', `Docker 校验确认是项目问题，启动一次定向修复：${sourceFailure.message.slice(0, 1200)}`, 'project_validate');
      await repairGeneratedProjectAfterValidation(jobFile, projectDir, plan, sourceFailure.message);
      continue;
    }

    const platformReports = platformOutcomes.map((outcome) => outcome.report);

    const reportPath = path.join(artifactsDir, 'project-validation.json');
    const results = platformReports.flatMap((report) => report?.docker?.results || []);
    const report = {
      ok: true,
      static: staticReport.static,
      baseline: staticReport.baseline || null,
      docker: { attempted: true, ok: true, platforms: [...PROJECT_VALIDATION_PLATFORMS], results },
      checkpoints: { path: checkpointPath, fingerprint, hits: checkpointHits },
    };
    await writeJsonAtomic(reportPath, report);
    await removeGeneratedBuildArtifacts(projectDir);
    return { reportPath, report, repairCount, checkpointHits };
  }
}

function inspectClaudeGeneration(rawJsonl) {
  const events = rawJsonl.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const initCount = events.filter((event) => event.type === 'system' && event.subtype === 'init').length;
  const success = events.filter((event) => event.type === 'result' && event.subtype === 'success' && event.is_error === false);
  const retries = events.filter((event) => event.type === 'system' && event.subtype === 'api_retry').length;
  if (initCount !== 1 || success.length !== 1) throw new Error(`Claude 项目生成轨迹不完整：init=${initCount} success=${success.length} retries=${retries}`);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init') || {};
  return {
    sessionId: success[0].session_id || extractSessionId(rawJsonl),
    model: init.model || success[0].model || '',
  };
}

export async function criticalDatastoreFiles(libraryRoot) {
  const candidates = [];
  const addFiles = async (root, filenamePattern) => {
    for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && filenamePattern.test(entry.name)) candidates.push(path.join(root, entry.name));
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name);
      for (const child of await fsp.readdir(nested, { withFileTypes: true }).catch(() => [])) {
        if (child.isFile() && filenamePattern.test(child.name)) candidates.push(path.join(nested, child.name));
      }
    }
  };
  await addFiles(path.join(libraryRoot, 'pipeline-jobs'), /^job\.json$/);
  await addFiles(path.join(libraryRoot, 'tasks'), /^public\.json$/);
  await addFiles(path.join(libraryRoot, 'validation'), /\.json$/);
  for (const filename of ['state.json', 'scheduler.json', 'alerts.json', 'watchdog.json']) {
    candidates.push(path.join(libraryRoot, 'pipeline-refill', filename));
  }
  const files = [];
  for (const filename of candidates.sort()) {
    const relative = path.relative(libraryRoot, filename);
    if (relative.startsWith(`validation${path.sep}`) && /^cloud_session.*\.json$/i.test(path.basename(filename))) continue;
    const stat = await fsp.stat(filename).catch(() => null);
    if (stat?.isFile()) files.push(filename);
  }
  return files;
}

async function criticalDatastoreFingerprint(libraryRoot) {
  const manifest = [];
  for (const filename of await criticalDatastoreFiles(libraryRoot)) {
    const stat = await fsp.stat(filename);
    manifest.push(`${path.relative(libraryRoot, filename)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return crypto.createHash('sha256').update(manifest.join('\n')).digest('hex');
}

async function stageCriticalDatastoreFiles(libraryRoot, stagingRoot) {
  for (const source of await criticalDatastoreFiles(libraryRoot)) {
    const relative = path.relative(libraryRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`关键数据路径越界：${source}`);
    const target = path.join(stagingRoot, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.writeFile(target, await fsp.readFile(source));
    } catch (error) {
      // Metadata writers use atomic replacement. A file removed between the
      // directory scan and open is simply absent from this point-in-time copy.
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function createCriticalDatastoreSnapshot(jobFile) {
  const jobDir = path.dirname(jobFile);
  const libraryRoot = path.resolve(jobDir, '../..');
  const workRoot = path.dirname(libraryRoot);
  const snapshotsRoot = path.join(workRoot, 'go-task-library-backups');
  const lockPath = path.join(snapshotsRoot, '.snapshot.lock');
  const indexPath = path.join(snapshotsRoot, '.snapshot-index.json');
  const snapshotFreshMs = 15 * 60_000;
  const unchangedSnapshotMaxAgeMs = 24 * 60 * 60_000;
  const staleLockMs = 25 * 60_000;
  const snapshotWaitMs = 22 * 60_000;
  await fsp.mkdir(snapshotsRoot, { recursive: true });
  const fingerprint = await criticalDatastoreFingerprint(libraryRoot);

  const recentSnapshot = async () => {
    const files = (await fsp.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^critical-.*\.tar\.gz$/.test(entry.name));
    const stats = await Promise.all(files.map(async (entry) => ({
      name: entry.name,
      stat: await fsp.stat(path.join(snapshotsRoot, entry.name)),
    })));
    return stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0] || null;
  };
  const indexed = await readJson(indexPath, null);
  if (indexed?.fingerprint === fingerprint && indexed?.filename) {
    const indexedPath = assertProtectedSnapshotPath(path.join(snapshotsRoot, indexed.filename), snapshotsRoot);
    const indexedStat = await fsp.stat(indexedPath).catch(() => null);
    if (indexedStat?.isFile() && Date.now() - indexedStat.mtimeMs < unchangedSnapshotMaxAgeMs) return indexedPath;
  }
  const recent = await recentSnapshot();
  if (recent && Date.now() - recent.stat.mtimeMs < snapshotFreshMs) return path.join(snapshotsRoot, recent.name);

  let ownsLock = false;
  const waitDeadline = Date.now() + snapshotWaitMs;
  while (!ownsLock) {
    const completed = await recentSnapshot();
    if (completed && Date.now() - completed.stat.mtimeMs < snapshotFreshMs) {
      return path.join(snapshotsRoot, completed.name);
    }
    try {
      await fsp.mkdir(lockPath);
      ownsLock = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const lockStat = await fsp.stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > staleLockMs) {
      await fsp.rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= waitDeadline) throw new Error('等待数据快照超时，拒绝启动 Claude 项目生成');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  let temporaryPath = '';
  let stagingPath = '';
  try {
    const staleTemporaryFiles = (await fsp.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^critical-.*\.tar\.gz\.\d+\.tmp$/.test(entry.name));
    for (const entry of staleTemporaryFiles) {
      const stalePath = assertProtectedSnapshotPath(path.join(snapshotsRoot, entry.name), snapshotsRoot);
      await fsp.rm(stalePath, { force: true });
    }
    const stamp = now().replace(/[-:.TZ]/g, '').slice(0, 14);
    const finalPath = assertProtectedSnapshotPath(path.join(snapshotsRoot, `critical-${stamp}.tar.gz`), snapshotsRoot);
    temporaryPath = assertProtectedSnapshotPath(`${finalPath}.${process.pid}.tmp`, snapshotsRoot);
    for (const entry of await fsp.readdir(snapshotsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.snapshot-stage-')) continue;
      await fsp.rm(assertProtectedSnapshotPath(path.join(snapshotsRoot, entry.name), snapshotsRoot), { recursive: true, force: true });
    }
    stagingPath = assertProtectedSnapshotPath(await fsp.mkdtemp(path.join(snapshotsRoot, '.snapshot-stage-')), snapshotsRoot);
    await stageCriticalDatastoreFiles(libraryRoot, stagingPath);
    await runRequired('生成前数据快照', 'tar', [
      ...criticalSnapshotTarOptions(),
      '-czf', temporaryPath,
      '-C', stagingPath, '.',
    ], { cwd: workRoot, env: { COPYFILE_DISABLE: '1' }, timeoutMs: 20 * 60 * 1000 });
    await fsp.rename(temporaryPath, finalPath);
    await writeJsonAtomic(indexPath, {
      filename: path.basename(finalPath),
      fingerprint,
      createdAt: now(),
    });
    const snapshots = (await fsp.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^critical-.*\.tar\.gz$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const filename of snapshots.slice(5)) {
      const target = assertProtectedSnapshotPath(path.join(snapshotsRoot, filename), snapshotsRoot);
      await fsp.rm(target, { force: true });
    }
    return finalPath;
  } catch (error) {
    if (temporaryPath) await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (stagingPath) await fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(lockPath, { recursive: true, force: true });
  }
}

export function claudeProjectArgs(prompt, config = projectGeneratorConfig()) {
  return [
    ...(config.provider === 'deepseek' ? ['--bare'] : []),
    '--print', '--verbose', '--effort', config.effort,
    ...(config.model ? ['--model', config.model] : []),
    '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions', '-p', prompt,
  ];
}

export function inspectClaudeSessionMetadata(rawJsonl) {
  const events = String(rawJsonl || '').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init') || {};
  const result = [...events].reverse().find((event) => event.type === 'result') || {};
  return {
    sessionId: result.session_id || extractSessionId(rawJsonl),
    model: init.model || result.model || '',
    apiRetries: events.filter((event) => event.type === 'system' && event.subtype === 'api_retry').length,
  };
}

export function projectGeneratorSessionMismatch(config, metadata) {
  if (config?.provider !== 'deepseek') return '';
  const expected = String(config.model || '').trim();
  const actual = String(metadata?.model || '').trim();
  if (!expected) return 'DeepSeek 项目生成未配置主模型';
  if (!actual) return `DeepSeek 项目生成 Session 未报告模型，期望 ${expected}`;
  if (actual !== expected) return `DeepSeek 项目生成模型不匹配：期望 ${expected}，实际 ${actual}`;
  return '';
}

async function archiveGenerationArtifact(filename, phase) {
  const exists = await fsp.stat(filename).catch(() => null);
  if (!exists?.isFile()) return '';
  const stamp = now().replace(/[-:.TZ]/g, '').slice(0, 17);
  const archived = path.join(path.dirname(filename), `project-generation-${phase}-${stamp}-${crypto.randomUUID().slice(0, 8)}${path.extname(filename)}`);
  await fsp.copyFile(filename, archived);
  return archived;
}

async function runClaudeProjectSession({ jobFile, cwd, plan, phase, failure = '', timeoutMs, requireGoMod = false, artifactStem = 'project-generation' }) {
  const artifactDir = path.join(path.dirname(jobFile), 'artifacts');
  const rawPath = path.join(artifactDir, `${artifactStem}.claude.jsonl`);
  const stderrPath = path.join(artifactDir, `${artifactStem}.claude.stderr.log`);
  const prompt = projectGenerationPrompt(plan, { phase, failure });
  const generatorConfig = projectGeneratorConfig();
  const isolatedConfigDir = generatorConfig.provider === 'deepseek'
    ? await fsp.mkdtemp(path.join(os.tmpdir(), 'go-pipeline-deepseek-claude-config-'))
    : '';
  const generatorEnvironment = projectGeneratorEnvironment(generatorConfig, isolatedConfigDir);
  if (generatorConfig.provider === DEFAULT_PROJECT_GENERATOR_PROVIDER) {
    const claudeSettings = await readJson(path.join(os.homedir(), '.claude/settings.json'), {});
    const routing = await projectGeneratorGatewayEnvironment(generatorConfig, { settings: claudeSettings });
    Object.assign(generatorEnvironment.env, routing.env);
    if (routing.probes.length) {
      const summary = routing.probes
        .map((entry) => `${entry.baseUrl}=${entry.available ? `${entry.latencyMs}ms` : 'unavailable'}`)
        .join(', ');
      await appendLog(jobFile, 'info', `Claude 项目生成网关探测：${summary}；使用 ${routing.selected || '默认端点'}`, 'project_generate');
    }
  }
  const protectedRoot = path.resolve(monitorRoot, '..');
  const sandboxed = claudeGenerationSandbox({ protectedRoot, claudeBin, claudeArgs: claudeProjectArgs(prompt, generatorConfig) });
  try {
    const executionResult = await runCommand(sandboxed.command, sandboxed.args, {
      cwd,
      env: generatorEnvironment.env,
      unsetEnv: generatorEnvironment.unsetEnv,
      stdoutPath: rawPath,
      stderrPath,
      timeoutMs,
      idleTimeoutMs: PROJECT_GENERATION_IDLE_TIMEOUT_MS,
      progressTreePaths: [cwd],
      progressTimeoutMs: PROJECT_GENERATION_PROGRESS_TIMEOUT_MS,
      activeWorkGraceMs: PROJECT_GENERATION_ACTIVE_WORK_GRACE_MS,
      progressTerminationPath: path.join(artifactDir, `${artifactStem}.progress-timeout`),
      requiredPath: requireGoMod ? path.join(cwd, 'go.mod') : '',
      requiredPathDeadlineMs: requireGoMod ? PROJECT_FIRST_FILE_TIMEOUT_MS : 0,
    });
    const rawJsonl = await fsp.readFile(rawPath, 'utf8').catch(() => '');
    const archivedRawPath = await archiveGenerationArtifact(rawPath, phase);
    const archivedStderrPath = await archiveGenerationArtifact(stderrPath, `${phase}-stderr`);
    const metadata = inspectClaudeSessionMetadata(rawJsonl);
    const modelMismatch = projectGeneratorSessionMismatch(generatorConfig, metadata);
    const execution = modelMismatch
      ? {
        ...executionResult,
        exitCode: executionResult.exitCode === 0 ? 78 : executionResult.exitCode,
        error: [executionResult.error, modelMismatch].filter(Boolean).join('; '),
      }
      : executionResult;
    return {
      phase,
      provider: generatorConfig.provider,
      execution,
      rawJsonl,
      rawPath,
      archivedRawPath,
      archivedStderrPath,
      ...metadata,
      modelMismatch,
    };
  } finally {
    if (isolatedConfigDir) await fsp.rm(isolatedConfigDir, { recursive: true, force: true }).catch(() => {});
  }
}

function completedClaudeProjectSession(session, label) {
  if (session.modelMismatch) throw new Error(session.modelMismatch);
  if (session.execution.exitCode !== 0) throw commandFailure(label, session.execution);
  return { ...inspectClaudeGeneration(session.rawJsonl), provider: session.provider || projectGeneratorConfig().provider };
}

async function directoryHasFiles(directory) {
  return Boolean((await fsp.readdir(directory).catch(() => [])).length);
}

async function replaceCheckpoint(jobDir, source, checkpointDir) {
  assertInside(jobDir, checkpointDir);
  const temporary = `${checkpointDir}.${process.pid}.tmp`;
  assertInside(jobDir, temporary);
  await fsp.rm(temporary, { recursive: true, force: true });
  await copyWithoutGit(source, temporary);
  await fsp.rm(checkpointDir, { recursive: true, force: true });
  await fsp.rename(temporary, checkpointDir);
}

async function writeApprovedProjectSpec(directory, plan) {
  const specPath = path.join(directory, GENERATED_PROJECT_SPEC_FILE);
  await fsp.writeFile(specPath, renderGeneratedProjectSpec(plan), 'utf8');
  return specPath;
}

async function validateGeneratedProjectLocally(projectDir, plan, deadlineMs = 0, qualityPolicyVersion = PROJECT_QUALITY_POLICY_VERSION) {
  if (!await fsp.stat(path.join(projectDir, 'go.mod')).catch(() => null)) throw new Error('Claude 项目生成未产出 go.mod');
  await normalizeProjectSupportFiles(projectDir, plan);
  const qualityLimits = Number(qualityPolicyVersion || 0) >= PROJECT_QUALITY_POLICY_VERSION
    ? GENERATED_PROJECT_QUALITY_LIMITS
    : LEGACY_GENERATED_PROJECT_QUALITY_LIMITS;
  const quality = assessGeneratedProjectQuality(await readWorkspaceEntries(projectDir), plan, qualityLimits);
  if (!quality.ok) throw new Error(`0-1 项目最低质量门禁未通过：${quality.issues.join('；')}`);
  await buildGeneratedProjectFrontend(projectDir, deadlineMs);
  const timeout = () => deadlineMs
    ? remainingProjectGenerationTimeout(deadlineMs, 20 * 60_000)
    : 20 * 60_000;
  const goEnv = await projectGoEnvironment(projectDir);
  await runRequired('隔离项目复制前测试', 'go', ['test', './...'], { cwd: projectDir, env: goEnv, timeoutMs: timeout() });
  await runRequired('隔离项目复制前静态检查', 'go', ['vet', './...'], { cwd: projectDir, env: goEnv, timeoutMs: timeout() });
  return quality;
}

function generationSessionRecord(session) {
  return {
    phase: session.phase,
    provider: session.provider || projectGeneratorConfig().provider,
    sessionId: session.sessionId || null,
    model: session.model || '',
    exitCode: session.execution.exitCode,
    timedOut: session.execution.timedOut,
    durationMs: session.execution.durationMs,
    apiRetries: session.apiRetries,
    modelMismatch: session.modelMismatch || '',
    rawPath: session.archivedRawPath || session.rawPath,
    stderrPath: session.archivedStderrPath || null,
  };
}

async function runClaudeProjectGeneration(jobFile, projectDir, plan, { forceRegenerate = false } = {}) {
  const jobDir = path.dirname(jobFile);
  const generationJob = await readJson(jobFile);
  const qualityPolicyVersion = Number(generationJob.projectQualityPolicyVersion || 0);
  const rawPath = path.join(jobDir, 'artifacts/project-generation.claude.jsonl');
  const checkpointDir = path.join(jobDir, 'project-generation-checkpoint');
  const existingProject = await fsp.stat(path.join(projectDir, 'go.mod')).catch(() => null);
  if (existingProject && !forceRegenerate) {
    const existingRaw = await fsp.readFile(rawPath, 'utf8').catch(() => '');
    try {
      const existing = inspectClaudeGeneration(existingRaw);
      const existingMetadata = inspectClaudeSessionMetadata(existingRaw);
      const existingModelMismatch = projectGeneratorSessionMismatch(projectGeneratorConfig(), existingMetadata);
      if (existingModelMismatch) throw new Error(existingModelMismatch);
      await normalizeProjectSupportFiles(projectDir, plan);
      const quality = await validateGeneratedProjectLocally(projectDir, plan, 0, qualityPolicyVersion);
      await appendLog(jobFile, 'info', '复用已完整保存的 Claude 项目生成结果', 'project_generate');
      return { ...existing, provider: projectGeneratorConfig().provider, rawPath, isolatedGeneration: true, sessions: [], quality };
    } catch {}
  }
  const snapshotPath = await createCriticalDatastoreSnapshot(jobFile);
  await appendLog(jobFile, 'success', `生成前数据快照已就绪：${path.basename(snapshotPath)}`, 'project_generate');
  await archiveDirectory(jobDir, projectDir, 'project-generate-retry');
  const generationDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-pipeline-project-generation-'));
  const generationDeadlineMs = Infinity;
  const sessions = [];
  try {
    if (await directoryHasFiles(checkpointDir)) {
      await copyWithoutGit(checkpointDir, generationDir);
      if (!await fsp.stat(path.join(generationDir, GENERATED_PROJECT_SPEC_FILE)).catch(() => null)) {
        await writeApprovedProjectSpec(generationDir, plan);
      }
      await appendLog(jobFile, 'info', '已加载项目生成检查点，新 Claude Session 将从现有代码继续', 'project_generate');
    } else {
      await writeApprovedProjectSpec(generationDir, plan);
      const foundation = await runClaudeProjectSession({
        jobFile,
        cwd: generationDir,
        plan,
        phase: 'foundation',
        timeoutMs: remainingProjectGenerationTimeout(generationDeadlineMs, PROJECT_FOUNDATION_TIMEOUT_MS),
        requireGoMod: true,
      });
      sessions.push(generationSessionRecord(foundation));
      if (await directoryHasFiles(generationDir)) await replaceCheckpoint(jobDir, generationDir, checkpointDir);
      if (foundation.modelMismatch) throw new Error(foundation.modelMismatch);
      if (foundation.execution.exitCode === 0 && await fsp.stat(path.join(generationDir, 'go.mod')).catch(() => null)) {
        await appendLog(jobFile, 'success', 'Claude 已完成可续作的项目基础骨架', 'project_generate');
      } else {
        await appendLog(jobFile, 'warn', `项目基础骨架 Session 未完整结束，将由新 Session 继续：${foundation.execution.error || `exit=${foundation.execution.exitCode}`}`, 'project_generate');
      }
    }

    const completion = await runClaudeProjectSession({
      jobFile,
      cwd: generationDir,
      plan,
      phase: 'complete',
      timeoutMs: remainingProjectGenerationTimeout(generationDeadlineMs, PROJECT_COMPLETION_TIMEOUT_MS),
      requireGoMod: !await fsp.stat(path.join(generationDir, 'go.mod')).catch(() => null),
    });
    sessions.push(generationSessionRecord(completion));
    if (await directoryHasFiles(generationDir)) await replaceCheckpoint(jobDir, generationDir, checkpointDir);
    if (completion.modelMismatch) throw new Error(completion.modelMismatch);

    let finalGeneration;
    let quality;
    let repairReason = '';
    try {
      finalGeneration = completedClaudeProjectSession(completion, 'Claude 项目完成');
      quality = await validateGeneratedProjectLocally(generationDir, plan, generationDeadlineMs, qualityPolicyVersion);
    } catch (error) {
      repairReason = error.message;
      await appendLog(jobFile, 'warn', `项目生成需要定向修复，保留检查点并启动新 Claude Session：${error.message.slice(0, 1200)}`, 'project_generate');
    }

    if (repairReason) {
      const repair = await runClaudeProjectSession({
        jobFile,
        cwd: generationDir,
        plan,
        phase: 'repair',
        failure: repairReason,
        timeoutMs: remainingProjectGenerationTimeout(generationDeadlineMs, PROJECT_REPAIR_TIMEOUT_MS),
        requireGoMod: !await fsp.stat(path.join(generationDir, 'go.mod')).catch(() => null),
      });
      sessions.push(generationSessionRecord(repair));
      if (await directoryHasFiles(generationDir)) await replaceCheckpoint(jobDir, generationDir, checkpointDir);
      finalGeneration = completedClaudeProjectSession(repair, 'Claude 项目定向修复');
      quality = await validateGeneratedProjectLocally(generationDir, plan, generationDeadlineMs, qualityPolicyVersion);
    }

    await copyWithoutGit(generationDir, projectDir);
    await fsp.rm(checkpointDir, { recursive: true, force: true });
    return { ...finalGeneration, rawPath, isolatedGeneration: true, sessions, quality };
  } catch (error) {
    if (await directoryHasFiles(generationDir)) await replaceCheckpoint(jobDir, generationDir, checkpointDir).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(generationDir, { recursive: true, force: true });
  }
}

async function repairGeneratedProjectAfterValidation(jobFile, projectDir, plan, failure) {
  const jobDir = path.dirname(jobFile);
  const repairJob = await readJson(jobFile);
  const qualityPolicyVersion = Number(repairJob.projectQualityPolicyVersion || 0);
  const repairDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-pipeline-project-repair-'));
  try {
    await copyWithoutGit(projectDir, repairDir);
    if (!await fsp.stat(path.join(repairDir, GENERATED_PROJECT_SPEC_FILE)).catch(() => null)) {
      await writeApprovedProjectSpec(repairDir, plan);
    }
    const repair = await runClaudeProjectSession({
      jobFile,
      cwd: repairDir,
      plan,
      phase: 'repair',
      failure,
      timeoutMs: PROJECT_REPAIR_TIMEOUT_MS,
      requireGoMod: false,
      artifactStem: 'project-validation-repair',
    });
    const repaired = completedClaudeProjectSession(repair, 'Claude 项目外层校验修复');
    await validateGeneratedProjectLocally(repairDir, plan, 0, qualityPolicyVersion);
    await archiveDirectory(jobDir, projectDir, 'project-validation-failed');
    await copyWithoutGit(repairDir, projectDir);
    const record = generationSessionRecord(repair);
    await updateJob(jobFile, (job) => {
      job.generation ||= {};
      job.generation.sessions = [...(job.generation.sessions || []), record];
      job.generation.sessionId = repaired.sessionId;
      job.generation.model = repaired.model;
      job.generation.provider = repaired.provider || projectGeneratorConfig().provider;
      job.generation.rawPath = repair.rawPath;
    });
    return record;
  } finally {
    await fsp.rm(repairDir, { recursive: true, force: true });
  }
}

async function git(cwd, args, label = 'Git') {
  return runRequired(label, 'git', ['-C', cwd, ...args], { cwd, timeoutMs: 10 * 60 * 1000 });
}

export function normalizedPipelineCloneUrl(request = {}, originUrl = '') {
  const candidates = [request?.cloneUrl, originUrl, request?.repository];
  for (const candidate of candidates) {
    let value = String(candidate || '').trim();
    if (!value || /^(?:undefined|null)$/i.test(value)) continue;
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(value) && !value.endsWith('.git')) {
      value = `${value.replace(/\/$/, '')}.git`;
    }
    return value;
  }
  return '';
}

async function repairMissingPipelineCloneUrl(jobFile, projectDir, request = {}) {
  const origin = await git(projectDir, ['remote', 'get-url', 'origin'], '读取项目 Git origin')
    .then((result) => result.stdout.trim())
    .catch(() => '');
  const cloneUrl = normalizedPipelineCloneUrl(request, origin);
  if (!cloneUrl) throw new Error('项目缺少可用的 Git cloneUrl、origin 和 repository，无法发布远端基线');
  if (String(request.cloneUrl || '').trim() !== cloneUrl) {
    await updateJob(jobFile, (current) => {
      current.request ||= {};
      current.request.cloneUrl = cloneUrl;
    });
    await appendLog(jobFile, 'warn', `检测到缺失或无效 cloneUrl，已从项目 Git origin/repository 恢复为 ${cloneUrl}`, 'pipeline_resume');
  }
  return cloneUrl;
}

async function remoteHead(cloneUrl, branch, cwd) {
  const result = await runRequired('读取远端分支', 'git', ['ls-remote', '--heads', cloneUrl, `refs/heads/${branch}`], { cwd, timeoutMs: 2 * 60 * 1000 });
  return result.stdout.trim().split(/\s+/, 1)[0] || '';
}

async function freezeMain(projectDir, request, plan) {
  const existingGit = await fsp.stat(path.join(projectDir, '.git')).catch(() => null);
  if (!existingGit) {
    await runRequired('初始化 Git main', 'git', ['init', '-b', 'main'], { cwd: projectDir });
    await git(projectDir, ['config', 'user.name', 'Go Pipeline']);
    await git(projectDir, ['config', 'user.email', 'go-pipeline@local.invalid']);
    await git(projectDir, ['add', '-A']);
    await git(projectDir, ['commit', '-m', `feat: generate ${plan.project_slug}`]);
    await git(projectDir, ['remote', 'add', 'origin', request.cloneUrl]);
  }
  const commit = (await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(projectDir, ['branch', '--show-current'])).stdout.trim();
  if (branch !== 'main') throw new Error(`Local generated project must be frozen on main, current branch: ${branch || '(detached)'}`);
  await assertCleanGit(projectDir, 'Local main freeze');
  return commit;
}

async function publishFrozenMain(projectDir, request, commit) {
  const currentRemote = await remoteHead(request.cloneUrl, 'main', projectDir);
  if (currentRemote && currentRemote !== commit) throw new Error(`远端 main 已存在且不是本作业提交：${currentRemote}`);
  if (!currentRemote) await git(projectDir, ['push', '-u', 'origin', 'HEAD:refs/heads/main'], '推送 main');
  return commit;
}

async function publishMain(projectDir, request, plan) {
  const commit = await freezeMain(projectDir, request, plan);
  return publishFrozenMain(projectDir, request, commit);
}

async function ensureRemoteBranch(projectDir, cloneUrl, branch, commit) {
  const existing = await remoteHead(cloneUrl, branch, projectDir);
  if (existing && existing !== commit) throw new Error(`远端 ${branch} 已存在且指向 ${existing}，预期 ${commit}`);
  if (!existing) await git(projectDir, ['push', 'origin', `${commit}:refs/heads/${branch}`], `推送 ${branch}`);
}

async function ensureRemoteBranchFrom(sourceDir, cloneUrl, branch, commit) {
  const existing = await remoteHead(cloneUrl, branch, sourceDir);
  if (existing && existing !== commit) throw new Error(`Remote ${branch} points to ${existing}, expected ${commit}`);
  if (!existing) await git(sourceDir, ['push', cloneUrl, `${commit}:refs/heads/${branch}`], `Push ${branch}`);
}

async function cloneAt(cloneUrl, branch, target, jobDir) {
  await archiveDirectory(jobDir, target, `${path.basename(target)}-retry`);
  await runRequired('克隆 Git 仓库', 'git', ['clone', '--quiet', '--branch', branch, '--single-branch', cloneUrl, target], { cwd: jobDir, timeoutMs: 10 * 60 * 1000 });
}

async function goldCheckpointCandidates(jobDir, goldDir, bugIndex) {
  const candidates = [goldDir];
  const historyDir = path.join(jobDir, 'history');
  const prefix = `gold-bug${bugIndex}-retry-`;
  const entries = await fsp.readdir(historyDir, { withFileTypes: true }).catch(() => []);
  candidates.push(...entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(historyDir, entry.name))
    .sort((left, right) => right.localeCompare(left)));
  return candidates;
}

function goldCheckpointRejectionPath(jobDir, bugIndex) {
  return path.join(jobDir, 'artifacts', `bug${bugIndex}-gold-checkpoint-rejected.json`);
}

export async function rejectGoldCheckpoint(jobDir, bugIndex, reason = '') {
  const marker = goldCheckpointRejectionPath(jobDir, bugIndex);
  await writeJsonAtomic(marker, {
    rejected_at: now(),
    reason: String(reason || 'Gold checkpoint failed downstream contract or verification'),
  });
  return marker;
}

export function isGoldCheckpointSemanticFailure(error = '') {
  return /Gold (?:回归测试题面契约复核不通过|Bug 难度复核不通过|回归测试在 BUG_BASE|目标回归测试失败|全量测试失败|静态检查失败)|Gold (?:root_cause|root_cause_symbols|internal_cause|propagation_path|observable_failure|mechanism_keywords)[^\n]{0,160}(?:必须|不合格|缺少|错误)|GOLD_PUBLIC_CONTRACT_CONFLICT|Gold 根因文件占比门禁未通过|diagnosis 公开 verify_cmds 不合格|verify_cmds 未完整覆盖题面/i.test(String(error?.message || error));
}

export async function recoverGoldCheckpoint({
  jobDir,
  goldDir,
  bugIndex,
  bugBaseCommit,
  requiredPrefix,
  expectedFiles = [],
  expectedSymbols = [],
}) {
  const artifactDir = path.join(jobDir, 'artifacts');
  if (await fsp.stat(goldCheckpointRejectionPath(jobDir, bugIndex)).catch(() => null)) return null;
  const output = await readJson(path.join(artifactDir, `bug${bugIndex}-gold.json`), null);
  if (!output) return null;

  try {
    validateGoldTestDescriptor(output, { requiredPrefix, expectedFiles, expectedSymbols });
  } catch {
    return null;
  }

  for (const candidate of await goldCheckpointCandidates(jobDir, goldDir, bugIndex)) {
    try {
      if (!(await fsp.stat(path.join(candidate, '.git')).catch(() => null))?.isDirectory()) continue;
      const head = (await git(candidate, ['rev-parse', 'HEAD'])).stdout.trim();
      if (head !== bugBaseCommit) continue;
      const testFiles = await changedTestFiles(candidate, bugBaseCommit, output.test_name).catch(() => []);
      if (!testFiles.length) continue;
      const tracked = (await git(candidate, ['diff', '--name-only', bugBaseCommit])).stdout.split(/\r?\n/).filter(Boolean);
      const untracked = (await git(candidate, ['ls-files', '--others', '--exclude-standard'])).stdout.split(/\r?\n/).filter(Boolean);
      const productionChanges = [...new Set([...tracked, ...untracked])]
        .filter((filename) => filename.endsWith('.go') && !filename.endsWith('_test.go'));
      if (!productionChanges.length) continue;
      const normalizedRootCauseFile = comparableGoFile(output.root_cause_file);
      if (!productionChanges.some((filename) => comparableGoFile(filename) === normalizedRootCauseFile)) continue;

      if (path.resolve(candidate) !== path.resolve(goldDir)) {
        await archiveDirectory(jobDir, goldDir, `${path.basename(goldDir)}-incomplete`);
        await fsp.cp(candidate, goldDir, { recursive: true, preserveTimestamps: true, mode: FAST_COPY_MODE });
      }
      const events = await fsp.readFile(path.join(artifactDir, `bug${bugIndex}-gold.codex.jsonl`), 'utf8').catch(() => '');
      return {
        output,
        sessionId: extractSessionId(events),
        checkpointSource: candidate,
        productionChanges,
      };
    } catch {
      // An incomplete or stale retry directory is not a reusable checkpoint.
    }
  }
  return null;
}

async function assertCleanGit(cwd, label) {
  const status = (await git(cwd, ['status', '--porcelain'], `${label}工作区检查`)).stdout.trim();
  if (status) throw new Error(`${label}结束后修改了原始工作区，找 Bug 阶段必须只读：${status.slice(0, 1000)}`);
}

export async function validateInjectedBugWorktree(cwd, baseCommit) {
  // V3 injection happens on an orphan green worktree, so HEAD is intentionally
  // unborn while Codex edits the snapshot. V1/V2 still have a normal HEAD.
  const headResult = await git(cwd, ['rev-parse', 'HEAD'], '读取注入工作区 HEAD').catch(() => ({ stdout: '' }));
  const head = headResult.stdout.trim();
  if (head && head !== baseCommit) throw new Error('Bug injection stage must not create a Git commit');
  const nameStatus = (await git(cwd, ['diff', '--name-status', baseCommit])).stdout.split(/\r?\n/).filter(Boolean);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split(/\r?\n/).filter(Boolean);
  const changes = nameStatus.map((line) => {
    const [status, ...parts] = line.split(/\t/);
    return { status, filename: parts.at(-1) || '' };
  }).concat(untracked.map((filename) => ({ status: '??', filename })));
  if (!changes.length) throw new Error('Bug injection must produce a real production diff against the frozen main; the approved mutation may already exist in the baseline');
  const protectedChanges = changes.filter(({ filename }) => (
    filename.endsWith('_test.go')
    || /(?:^|\/)(?:gold|grader|hidden[-_]?tests?|solutions?|answers?|patches?)(?:\/|$)/i.test(filename)
    || /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude(?:\/|$))/i.test(filename)
  ));
  if (protectedChanges.length) throw new Error(`Bug injection cannot modify tests, hidden acceptance, answers, or model instructions: ${protectedChanges.map(({ status, filename }) => `${status} ${filename}`).join(', ')}`);
  const numstat = (await git(cwd, ['diff', '--numstat', baseCommit])).stdout.split(/\r?\n/).filter(Boolean);
  let changedLines = numstat.reduce((total, line) => {
    const [added, removed] = line.split(/\t/);
    return total + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
  const diff = (await git(cwd, ['diff', '--unified=0', baseCommit, '--', ...changes.filter(({ status }) => status !== '??').map(({ filename }) => filename)])).stdout;
  const leakingComment = diff.split(/\r?\n/).find((line) => /^\+\s*(?:\/\/|#|\/\*)/.test(line) && /\b(?:TODO|FIXME|BUG|injected|intentional|benchmark)\b/i.test(line));
  if (leakingComment) throw new Error(`Injected code leaks the answer in a comment: ${leakingComment.slice(0, 200)}`);
  for (const filename of untracked) {
    const content = await fsp.readFile(path.join(cwd, filename), 'utf8').catch(() => '');
    changedLines += content ? content.split(/\r?\n/).length : 0;
    const marker = content.split(/\r?\n/).find((line) => /^\s*(?:\/\/|#|\/\*)/.test(line) && /\b(?:TODO|FIXME|BUG|injected|intentional|benchmark)\b/i.test(line));
    if (marker) throw new Error(`Injected file leaks the answer in a comment: ${filename}: ${marker.slice(0, 160)}`);
  }
  const reviewReasons = [];
  if (changes.length > 4) reviewReasons.push(`涉及 ${changes.length} 个文件`);
  if (changedLines > 300) reviewReasons.push(`改动 ${changedLines} 行`);
  if (changes.some(({ status }) => /^[DR]/.test(status))) reviewReasons.push('包含删除或重命名');
  return { files: changes.map(({ filename }) => filename), changedLines, reviewRequired: reviewReasons.length > 0, reviewReasons };
}

async function createOrphanGreenSnapshot(cwd, mainCommit, bugIndex) {
  const greenBranch = numberedGreenBranch(bugIndex);
  await git(cwd, ['switch', '--orphan', greenBranch], '创建独立 green 分支');
  // An orphan switch clears the index and worktree. Rehydrate exactly the
  // frozen main tree, leaving the new branch with no parent relationship.
  await git(cwd, ['read-tree', mainCommit], '恢复 main 基座到 green 分支');
  await git(cwd, ['checkout-index', '-a'], '检出 green 基座文件');
  return greenBranch;
}

export async function createOrphanDiagnosisRedSnapshot(cwd, sourceCommit, bugIndex) {
  const redBranch = numberedRedBranch(bugIndex);
  // A process can stop after creating R1 but before its SHA is persisted in
  // job.json. Detach from the frozen source before deleting the branch so the
  // next main_publish attempt can rebuild the same orphan snapshot safely.
  await git(cwd, ['switch', '--detach', sourceCommit], '恢复 diagnosis red 源提交');
  await git(cwd, ['branch', '-D', redBranch]).catch(() => {});
  await git(cwd, ['switch', '--orphan', redBranch], '创建独立 diagnosis red 分支');
  await git(cwd, ['read-tree', sourceCommit], '恢复 diagnosis 失败环境到 red 分支');
  await git(cwd, ['checkout-index', '-a', '-f'], '检出 diagnosis 失败环境');
  await git(cwd, ['add', '-A'], '提交 diagnosis red 环境');
  await git(cwd, [
    '-c', 'user.name=Go Pipeline',
    '-c', 'user.email=go-pipeline@local.invalid',
    'commit', '-m', 'test: public diagnosis reproduction',
  ], '提交 diagnosis red R1');
  const redCommit = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', redCommit])).stdout.trim().split(/\s+/).filter(Boolean);
  if (parents.length !== 1) throw new Error('Diagnosis red R1 必须是无父提交的 orphan 根提交');
  return redCommit;
}

async function reviewBroadInjectedBug(jobFile, stageId, cwd, baseCommit, bug, injection, bugIndex) {
  const job = await readJson(jobFile);
  const enforceDifficulty = Number(job.request?.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION;
  if (!injection.reviewRequired && !enforceDifficulty) return null;
  const prompt = [
    'Perform a strictly read-only review of one proposed benchmark BUG_BASE change. Do not modify files or create commits.',
    `Compare the current worktree with base commit ${baseCommit}. Deterministic scope observations: ${injection.reviewReasons.join('、') || 'normal-sized diff; mandatory V3 quality review'}.`,
    'Approve only if the complete diff introduces exactly one realistic deterministic bug, remains proportionate to that behavior, does not weaken or modify tests, does not leak the answer, and does not include unrelated rewrites or cleanup. Configuration, dependency, Docker, build-script, and Go-source bugs are all allowed when they are genuinely required by the selected behavior.',
    ...(enforceDifficulty ? [
      bugDifficultyPolicyText(),
      'Reject a shallow one-point edit even when the Bug record labels it as a runtime mechanism. In particular, renaming a flag, replacing one literal or prefix, adding one enum case or nil check, changing one comparison/operator/counter/offset, or enabling one decoder option is insufficient when the actual investigation and fix are local. Approve an arithmetic or boundary defect only when the diff and surrounding code establish a substantive transaction, concurrent, recovery, resource, or cross-layer invariant rather than merely a dramatic downstream symptom.',
    ] : []),
    `Selected bug record:\n${JSON.stringify(bug, null, 2)}`,
    'Return JSON matching the supplied schema and cite concrete diff evidence for each issue.',
  ].join('\n\n');
  const review = await runInjectionCodexJson({
    jobFile,
    stageId,
    cwd,
    prompt,
    schema: qualitySchema,
    name: `bug${bugIndex}-injection-scope-review`,
    sandbox: 'read-only',
  });
  if (!review.output.approved) {
    const detail = review.output.issues.map((issue) => `${issue.code}: ${issue.message} (${issue.evidence})`).join('; ') || review.output.summary;
    throw new Error(`注入 Bug 质量复核不通过：${detail}`);
  }
  return review;
}

async function reviewNaturalBugDifficulty(jobFile, stageId, cwd, bug, bugIndex) {
  const prompt = [
    'Perform a strictly read-only difficulty review of one naturally discovered benchmark Bug. Inspect the actual reachable production code, but do not modify files, create files, run tests, or create commits.',
    bugDifficultyPolicyText(),
    'Approve only when the reported runtime mechanism and propagation chain are supported by the code and locating the root cause plus verifying the invariant requires reasoning across at least two meaningful boundaries. Reject unused or toy components and reject a local typo, mapping, nil check, string normalization, decoder option, simple comparator, index, counter, or offset repair even when the report describes a severe downstream symptom.',
    'An overflow or boundary defect may pass only when the actual mechanism includes a substantive transaction, persistence, concurrency, recovery, or resource invariant and the required regression evidence verifies that invariant, such as preventing an orphan persisted Session after a failed reservation.',
    `Candidate Bug record:\n${JSON.stringify(bug, null, 2)}`,
    'Return JSON matching the supplied schema. Cite exact files, symbols, control flow, and affected runtime state for approval or rejection.',
  ].join('\n\n');
  return runCodexJson({
    jobFile,
    stageId,
    cwd,
    prompt,
    schema: qualitySchema,
    name: `bug${bugIndex}-natural-difficulty-review`,
    sandbox: 'read-only',
  });
}

const NATURAL_BUG_SEARCH_PARTITIONS = [
  {
    id: 'api-orchestration',
    scope: 'Own documented commands and HTTP APIs, authorization and idempotency, service orchestration, cross-service calls, and externally observable outcomes. A returned candidate must have its primary root-cause symbol in cmd, api, handler, or service orchestration code. Storage internals, worker ownership, and protocol codecs may be supporting links but must not be the primary root cause.',
  },
  {
    id: 'state-persistence',
    scope: 'Own domain state transitions, persistence and transactions, immutable evidence/version chains, atomicity, rollback, and restart consistency. A returned candidate must have its primary root-cause symbol in store, repository, persistence, or domain-state code. API policy, worker races, and transport codecs belong to other partitions.',
  },
  {
    id: 'concurrency-resources',
    scope: 'Own concurrency and cancellation, ownership isolation, locks and races, background work, resource allocation/release, and caller-owned mutable state. A returned candidate must have its primary root-cause symbol in worker, scheduler, cache, pool, lock, or lifecycle code. Ordinary transactions and protocol parsing belong to other partitions.',
  },
  {
    id: 'protocol-recovery',
    scope: 'Own protocol and stream integrity, serialization boundaries, retries and replay, timeouts and disconnects, malformed responses, recovery ordering, and late events. A returned candidate must have its primary root-cause symbol in client, transport, codec, replay, or recovery code. API policy, ordinary persistence, and worker ownership belong to other partitions.',
  },
];

function naturalBugAnalysisPort(job, batchKey, partitionId) {
  const digest = crypto.createHash('sha256')
    .update(`${job?.id || ''}:${batchKey}:${partitionId}`)
    .digest('hex');
  return 20_000 + (Number.parseInt(digest.slice(0, 8), 16) % 20_000);
}

function naturalBugBatchKey(firstBugIndex, previousBugs, retryNonce = '') {
  const previousIds = (previousBugs || []).map((item) => item.discovery?.bug_id || '').filter(Boolean).sort();
  const digest = crypto.createHash('sha256').update(JSON.stringify({ previousIds, retryNonce })).digest('hex').slice(0, 10);
  return `natural-bug-batch-v${NATURAL_BUG_BATCH_VERSION}-from${firstBugIndex}-${digest}`;
}

function naturalBugFinderPrompt(job, partition, remainingCount, previousBugs, analysisPort) {
  const filePolicy = validateRootCauseFileConcentration(previousBugs, { totalBugCount: job.request.bugCount });
  return [
    'Inspect this locally generated Go project once and return a pool of distinct existing Bug candidates. Do not inject a bug, edit repository files, commit, or inspect any solution artifact.',
    `This is search partition ${partition.id}. ${partition.scope}`,
    `If a local process is genuinely required, use the assigned unprivileged port ${analysisPort} (or $PORT), never a fixed :18080; prefer no listener because this sandbox may deny TCP binding. Stop every process before returning.`,
    `Return at most ${remainingCount} independently reproducible candidates. Return fewer, including zero, when the code does not support more. Never weaken a candidate or invent evidence to fill a quota.`,
    `Before returning a candidate, self-score it with the later reviewer rubric and omit it unless it would score at least ${NATURAL_BUG_MIN_REVIEW_SCORE}/5.`,
    `Prioritize the strongest reachable candidates and prepare a complete structured response within about ${Math.round(NATURAL_BUG_FINDER_SOFT_BUDGET_MS / 60_000)} minutes; the system hard deadline is ${Math.round(NATURAL_BUG_FINDER_TIMEOUT_MS / 60_000)} minutes. Do not spend the remaining budget chasing a weak extra candidate.`,
    `The requested trajectory type is ${job.request.taskType}. Each candidate user_query is only a draft for later batch human review; wording style or a missing natural request must not reject a technically valid candidate.`,
    bugTaxonomyInstruction(job.request.taskType, job.request),
    bugDifficultyPolicyText(),
    userQueryAuthoringPolicyText(),
    bugNarrativeLanguageInstruction(),
    `No root-cause file may account for more than 30% of this project's Bug records. Current single-target file counts are ${JSON.stringify(filePolicy.counts)}; the per-file ceiling is ${Number.isFinite(filePolicy.limit) ? filePolicy.limit : 'not-applicable'}.`,
    'Every candidate must identify exact reachable files and symbols, a concrete three-link failure mechanism, actual reproduction evidence, affected runtime state, and retained behavior. Reject dead code, toy packages, local spelling/mapping/nil/comparator/index/counter fixes, and variants of another candidate.',
    job.request.taskType === 'diagnosis'
      ? 'Each diagnosis candidate should identify a legal direct public read-only command or focused observable scenario when available. Do not require the command to have been executed or to return non-zero during discovery; final red evidence is generated later in the verifier overlay. The eventual command cannot create files, use pipes, redirects, Git, hidden tests, or external network access.'
      : 'You may use temporary files outside the repository to confirm behavior, but finish with a clean Git worktree.',
    'This analysis sandbox may reject TCP listeners. Do not start a local server or bind a fixed port during discovery; prefer an existing CLI, an in-process test, or a static control-flow trace. A port-binding failure is infrastructure noise, not reproduction evidence and must not be reported as a Bug.',
    `Already selected Bugs that must not be repeated:\n${JSON.stringify(previousBugs.map((item) => item.discovery), null, 2)}`,
    'Return only the requested structured candidate pool. Every returned candidate must use found=true.',
  ].join('\n\n');
}

async function runNaturalBugFinder({ jobFile, stageId, projectDir, jobDir, job, partition, remainingCount, previousBugs, batchKey }) {
  const startedAtMs = Date.now();
  const name = `${batchKey}-${partition.id}`;
  const reusable = await reusableCodexJson(jobFile, name);
  if (reusable) return { ...reusable, partition: partition.id, durationMs: 0 };
  const analysisDir = path.join(jobDir, `analysis-${name}`);
  await cloneAt(projectDir, 'main', analysisDir, jobDir);
  const analysisPort = naturalBugAnalysisPort(job, batchKey, partition.id);
  const result = await runCodexJson({
    jobFile,
    stageId,
    cwd: analysisDir,
    prompt: naturalBugFinderPrompt(job, partition, remainingCount, previousBugs, analysisPort),
    schema: bugCandidatePoolSchema(job.request.bugPolicyVersion, remainingCount),
    name,
    sandbox: 'workspace-write',
    timeoutMs: NATURAL_BUG_FINDER_TIMEOUT_MS,
    streamRecoveryWindowMs: NATURAL_BUG_STREAM_RECOVERY_WINDOW_MS,
    env: {
      GO_PIPELINE_ANALYSIS_PORT: String(analysisPort),
      PORT: String(analysisPort),
      GO_PIPELINE_NATURAL_BUG_PARTITION: partition.id,
    },
  });
  await assertCleanGit(analysisDir, `natural Bug batch finder ${partition.id}`);
  return { ...result, partition: partition.id, durationMs: Date.now() - startedAtMs };
}

async function reviewNaturalBugCandidateBatch({ jobFile, stageId, projectDir, jobDir, job, candidates, batchKey }) {
  const name = `${batchKey}-review`;
  const reusable = await reusableCodexJson(jobFile, name);
  if (reusable) return reusable;
  const reviewDir = path.join(jobDir, `analysis-${name}`);
  await cloneAt(projectDir, 'main', reviewDir, jobDir);
  const prompt = [
    'Perform one strictly read-only batch review of the following naturally discovered Bug candidates. Inspect only the production paths needed to decide these candidates. Do not modify files, create files, run tests, or create commits.',
    bugDifficultyPolicyText(),
    'Return exactly one review for every candidate bug_id. Approve only candidates supported by reachable code, concrete reproduction evidence, a substantive runtime invariant, and at least two meaningful boundaries. Reject semantic duplicates by approving only the stronger one. Reject dead code, toy components, shallow local fixes, invented evidence, and candidates that merely restate another failure.',
    'Score approved candidates from 1 to 5 for evidence strength, runtime depth, public observability, and independence. A rejected candidate still receives a score and concrete issue evidence.',
    `Candidate records:\n${JSON.stringify(candidates.map((item) => item.candidate), null, 2)}`,
    'Return only JSON matching the supplied schema.',
  ].join('\n\n');
  return runCodexJson({
    jobFile,
    stageId,
    cwd: reviewDir,
    prompt,
    schema: bugCandidateReviewSchema(candidates.length),
    name,
    sandbox: 'read-only',
    timeoutMs: NATURAL_BUG_BATCH_REVIEW_TIMEOUT_MS,
  });
}

export async function naturalBugCandidateSeedResult(jobDir, seed = null) {
  if (!seed?.artifact) return null;
  const artifactsDir = path.join(jobDir, 'artifacts');
  const outputPath = path.resolve(jobDir, String(seed.artifact));
  assertInside(artifactsDir, outputPath);
  const output = await readJson(outputPath);
  if (!Array.isArray(output?.candidates) || !output.candidates.length) {
    throw new Error(`自然 Bug 恢复候选为空：${seed.artifact}`);
  }
  const eventsPath = seed.eventsArtifact
    ? path.resolve(jobDir, String(seed.eventsArtifact))
    : '';
  if (eventsPath) assertInside(artifactsDir, eventsPath);
  return {
    output,
    partition: 'recovered-candidates',
    sessionId: String(seed.sessionId || ''),
    outputPath,
    eventsPath,
    durationMs: 0,
    recovered: true,
  };
}

async function ensureNaturalBugBatch(jobFile, projectDir) {
  let job = await readJson(jobFile);
  if (Number(job.workflowVersion || 1) < CURRENT_WORKFLOW_VERSION) return null;
  const jobDir = path.dirname(jobFile);
  const pendingIndexes = Array.from({ length: Number(job.request.bugCount || 0) }, (_, index) => index + 1)
    .filter((bugIndex) => {
      const stage = job.stages.find((item) => item.id === `bug${bugIndex}_bug_discovery`);
      return stage && !['passed', 'skipped'].includes(stage.status);
    });
  if (!pendingIndexes.length) return null;
  const firstBugIndex = pendingIndexes[0];
  const previousBugs = (job.bugs || []).filter((item) => item.discovery?.found === true
    && job.stages.find((stage) => stage.id === `bug${item.bugIndex}_bug_discovery`)?.status === 'passed');
  const expectedBatchKey = naturalBugBatchKey(firstBugIndex, previousBugs, job.naturalBugRetryNonce || '');
  const existingBatch = job.naturalBugBatch;
  const assignedIndexes = new Set((existingBatch?.assignments || []).map((item) => Number(item.bugIndex)));
  const coversPendingIndexes = pendingIndexes.every((bugIndex) => assignedIndexes.has(bugIndex));
  if (existingBatch?.version === NATURAL_BUG_BATCH_VERSION
    && existingBatch.key === expectedBatchKey
    && Array.isArray(existingBatch.assignments)
    && (!isNaturalBugOnlyJob(job) || coversPendingIndexes)
    && Number(existingBatch.firstBugIndex) <= firstBugIndex
    && Number(existingBatch.finderFailureCount || 0) === 0
    && existingBatch.finderStatus !== 'failed') {
    return existingBatch;
  }

  const remainingCount = pendingIndexes.length;
  // The complementary partitions jointly cover the remaining slots. Keep a
  // small overlap for deduplication, but do not make every finder investigate
  // all ten slots independently; that caused long exploratory timeouts.
  const partitionCandidateLimit = Math.min(
    4,
    remainingCount,
    Math.max(1, Math.ceil(remainingCount / NATURAL_BUG_SEARCH_PARTITIONS.length)),
  );
  const batchKey = expectedBatchKey;
  const stageId = `bug${firstBugIndex}_bug_discovery`;
  const batchStartedAtMs = Date.now();
  const finderConcurrency = await currentBugSourceWorkerLimit();
  const recoveredSeed = await naturalBugCandidateSeedResult(jobDir, job.naturalBugCandidateSeed);
  let settled = [];
  if (recoveredSeed) {
    await appendLog(jobFile, 'info', `复用 ${recoveredSeed.output.candidates.length} 个历史技术候选，跳过四分区重搜并直接进入统一去重与难度复核`, stageId);
  } else {
    await appendLog(jobFile, 'info', `启动项目级 Bug 候选池：4 个互补分区，当前 ${finderConcurrency} 路并行，覆盖剩余 ${remainingCount} 个槽位；每分区最多返回 ${partitionCandidateLimit} 个候选`, stageId);
    settled = await runBoundedSettled(NATURAL_BUG_SEARCH_PARTITIONS, finderConcurrency, (partition) => runNaturalBugFinder({
      jobFile,
      stageId,
      projectDir,
      jobDir,
      job,
      partition,
      remainingCount: partitionCandidateLimit,
      previousBugs,
      batchKey,
    }));
  }
  const searchDurationMs = Date.now() - batchStartedAtMs;
  const finderResults = recoveredSeed ? [recoveredSeed] : [];
  const finderFailureCount = recoveredSeed ? 0 : naturalBugFinderFailureCount(settled);
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'fulfilled') finderResults.push(result.value);
    else await appendLog(jobFile, 'warn', `Bug 候选分区 ${NATURAL_BUG_SEARCH_PARTITIONS[index].id} 未完成：${result.reason?.message || result.reason}`, stageId);
  }
  // A failed finder is an infrastructure failure, not an empty candidate
  // pool. Keep discovery pending and return the runner to the central
  // scheduler so a retry can reuse any completed partition output.
  if (finderFailureCount > 0) {
    const retainedFinders = finderResults.map((result) => ({
      partition: result.partition,
      sessionId: result.sessionId,
      candidateCount: Array.isArray(result.output?.candidates) ? result.output.candidates.length : 0,
      outputArtifact: path.relative(jobDir, result.outputPath),
      eventsArtifact: path.relative(jobDir, result.eventsPath),
      completedAt: now(),
    }));
    const retainedCandidateCount = retainedFinders.reduce((total, item) => total + item.candidateCount, 0);
    const retainedSummary = retainedFinders.length
      ? `已保留 ${retainedFinders.map((item) => `${item.partition} ${item.candidateCount} 个`).join('、')}候选；`
      : '';
    const failureDetails = settled
      .map((result, index) => result.status === 'rejected'
        ? `${NATURAL_BUG_SEARCH_PARTITIONS[index].id}: ${result.reason?.message || result.reason}`
        : '')
      .filter(Boolean)
      .join('；');
    await updateJob(jobFile, (current) => {
      const stage = (current.stages || []).find((item) => item.id === stageId);
      if (stage) {
        stage.status = 'pending';
        stage.startedAt = null;
        stage.finishedAt = null;
        stage.error = '';
        stage.reason = `${retainedSummary}自然 Bug 搜索基础设施失败，等待重试（${finderFailureCount} 个分区）：${failureDetails}`.slice(0, 4000);
        delete stage.result;
      }
      current.naturalBugBatch = {
        version: NATURAL_BUG_BATCH_VERSION,
        key: batchKey,
        firstBugIndex,
        requested: remainingCount,
        selected: 0,
        assignments: [],
        rejectedCount: 0,
        retainedCandidateCount,
        retainedFinders,
        partitionCount: recoveredSeed ? 1 : NATURAL_BUG_SEARCH_PARTITIONS.length,
        finderConcurrency,
        searchDurationMs,
        finderFailureCount,
        finderStatus: retainedFinders.length ? 'partial' : 'failed',
        lastFinderFailure: failureDetails,
        failedAt: now(),
      };
    });
    await appendLog(jobFile, 'warn', `${retainedSummary}自然 Bug 搜索基础设施失败（${finderFailureCount} 个分区），不转入受控注入，仅重试失败分区：${failureDetails}`, stageId);
    throw new NaturalBugFinderInfrastructureError(
      `自然 Bug 搜索分区失败（${finderFailureCount} 个）：${failureDetails}`,
      { failureCount: finderFailureCount },
    );
  }
  if (!finderResults.length) {
    const emptyBatch = {
      version: NATURAL_BUG_BATCH_VERSION,
      key: batchKey,
      firstBugIndex,
      requested: remainingCount,
      selected: 0,
      assignments: [],
      rejectedCount: 0,
      partitionCount: recoveredSeed ? 1 : NATURAL_BUG_SEARCH_PARTITIONS.length,
      finderConcurrency,
      searchDurationMs,
      finderFailureCount: 0,
      finderStatus: 'completed',
      completedAt: now(),
    };
    await updateJob(jobFile, (current) => { current.naturalBugBatch = emptyBatch; });
    if (isNaturalBugOnlyJob(job)) {
      const message = `自然 Bug 搜索分区均未返回有效结果，${remainingCount} 个槽位保持待搜索；本次恢复禁止受控注入`;
      await appendLog(jobFile, 'warn', message, stageId);
      throw new NaturalBugSearchWaitError(stageId, message);
    }
    await appendLog(jobFile, 'warn', `自然 Bug 搜索分区均未返回有效结果，全部 ${remainingCount} 个槽位转入分批受控注入`, stageId);
    return emptyBatch;
  }
  const normalized = normalizeBugCandidateFinders(finderResults, previousBugs, {
    taskType: job.request.taskType,
    request: job.request,
  });
  if (!normalized.candidates.length) {
    const finderCandidateCount = finderResults.reduce(
      (total, result) => total + (Array.isArray(result.output?.candidates) ? result.output.candidates.length : 0),
      0,
    );
    const rejectionCounts = new Map();
    for (const rejection of normalized.rejected) {
      const reason = String(rejection.reason || '未说明原因');
      rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
    }
    const rejectionSummary = [...rejectionCounts.entries()]
      .slice(0, 4)
      .map(([reason, count]) => `${count} 条：${reason}`)
      .join('；');
    const emptyBatch = {
      version: NATURAL_BUG_BATCH_VERSION,
      key: batchKey,
      firstBugIndex,
      requested: remainingCount,
      selected: 0,
      assignments: [],
      finderCandidateCount,
      rejectedCount: normalized.rejected.length,
      rejections: normalized.rejected.slice(0, 50),
      rejectionSummary,
      partitionCount: recoveredSeed ? 1 : NATURAL_BUG_SEARCH_PARTITIONS.length,
      finderConcurrency,
      searchDurationMs,
      finderFailureCount: 0,
      finderStatus: 'completed',
      completedAt: now(),
    };
    await updateJob(jobFile, (current) => { current.naturalBugBatch = emptyBatch; });
    if (isNaturalBugOnlyJob(job)) {
      const message = `自然 Bug 搜索返回 ${finderCandidateCount} 个候选，但字段校验全部拒绝（${rejectionSummary || '未说明原因'}）；${remainingCount} 个槽位保持待搜索，本次恢复禁止受控注入`;
      await appendLog(jobFile, 'warn', message, stageId);
      throw new NaturalBugSearchWaitError(stageId, message);
    }
    await appendLog(jobFile, 'warn', `自然 Bug 搜索返回 ${finderCandidateCount} 个候选，但字段校验全部拒绝（${rejectionSummary || '未说明原因'}）；全部 ${remainingCount} 个槽位转入分批受控注入`, stageId);
    return emptyBatch;
  }

  const reviewCandidateLimit = Math.min(
    normalized.candidates.length,
    Math.max(remainingCount, Math.min(12, remainingCount + 2)),
  );
  const reviewCandidates = normalized.candidates.slice(0, reviewCandidateLimit);
  const candidateSource = recoveredSeed ? '历史恢复候选池' : '四个搜索分区';
  await appendLog(jobFile, 'info', `${candidateSource}得到 ${normalized.candidates.length} 个去重候选，截取 ${reviewCandidates.length} 个进入一次批量难度复核`, stageId);
  const reviewStartedAtMs = Date.now();
  const review = await reviewNaturalBugCandidateBatch({
    jobFile,
    stageId,
    projectDir,
    jobDir,
    job,
    candidates: reviewCandidates,
    batchKey,
  });
  const reviewDurationMs = Date.now() - reviewStartedAtMs;
  const selection = selectReviewedBugCandidates(finderResults, review.output, previousBugs, {
    limit: remainingCount,
    taskType: job.request.taskType,
    request: job.request,
  });
  const assignments = selection.selected.map((item, index) => ({
    bugIndex: pendingIndexes[index],
    candidate: item.candidate,
    finder: item.finder,
    finderSessionId: item.finderSessionId,
    reviewScore: item.review.score,
  }));
  const selectedArtifact = `${batchKey}-selected.json`;
  await writeJsonAtomic(path.join(jobDir, 'artifacts', selectedArtifact), {
    version: NATURAL_BUG_BATCH_VERSION,
    key: batchKey,
    previousBugIds: previousBugs.map((item) => item.discovery?.bug_id).filter(Boolean),
    finderSessions: finderResults.map((item) => ({ partition: item.partition, sessionId: item.sessionId })),
    finderConcurrency,
    searchDurationMs,
    reviewDurationMs,
    reviewedCandidateCount: reviewCandidates.length,
    reviewSessionId: review.sessionId,
    assignments,
    rejected: selection.rejected,
  });
  const batch = {
    version: NATURAL_BUG_BATCH_VERSION,
    key: batchKey,
    firstBugIndex,
    requested: remainingCount,
    selected: assignments.length,
    assignments: assignments.map((item) => ({
      bugIndex: item.bugIndex,
      bugId: item.candidate.bug_id,
      finder: item.finder,
      finderSessionId: item.finderSessionId,
      reviewScore: item.reviewScore,
    })),
    selectedArtifact,
    reviewSessionId: review.sessionId,
    rejectedCount: selection.rejected.length,
    partitionCount: recoveredSeed ? 1 : NATURAL_BUG_SEARCH_PARTITIONS.length,
    finderConcurrency,
    searchDurationMs,
    reviewDurationMs,
    totalDurationMs: Date.now() - batchStartedAtMs,
    reviewedCandidateCount: reviewCandidates.length,
    finderFailureCount: 0,
    finderStatus: 'completed',
    completedAt: now(),
  };
  await updateJob(jobFile, (current) => { current.naturalBugBatch = batch; });
  await appendLog(jobFile, 'success', `候选池批量复核完成：批准 ${assignments.length} 个，拒绝 ${selection.rejected.length} 个`, stageId);
  return batch;
}

async function naturalBugBatchAssignment(jobFile, bugIndex) {
  const job = await readJson(jobFile);
  const batch = job.naturalBugBatch;
  const assignment = batch?.assignments?.find((item) => Number(item.bugIndex) === Number(bugIndex));
  if (!assignment || !batch.selectedArtifact) return null;
  const detail = await readJson(path.join(path.dirname(jobFile), 'artifacts', batch.selectedArtifact), null);
  return detail?.assignments?.find((item) => Number(item.bugIndex) === Number(bugIndex)) || null;
}

function injectionPlanKey(job, bugIndexes, previousBugs) {
  const rejectedFingerprints = rejectedInjectionCandidates(job, bugIndexes)
    .map((item) => item.fingerprint)
    .filter(Boolean)
    .sort();
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    mainCommit: job.mainCommit,
    bugIndexes,
    previousBugIds: previousBugs.map((item) => item.discovery?.bug_id || '').filter(Boolean).sort(),
    rejectedFingerprints,
  })).digest('hex').slice(0, 12);
  return `injection-plan-v${INJECTION_PLAN_VERSION}-${digest}`;
}

export function injectionPlanningBatch(bugIndexes, acceptedCount, batchSize = INJECTION_PLAN_BATCH_SIZE) {
  const indexes = Array.isArray(bugIndexes) ? bugIndexes : [];
  const offset = Math.max(0, Math.min(indexes.length, Number(acceptedCount) || 0));
  const size = Math.max(1, Math.min(10, Math.floor(Number(batchSize) || INJECTION_PLAN_BATCH_SIZE)));
  const remainingSlots = indexes.slice(offset);
  const requestedSlots = remainingSlots.slice(0, size);
  return {
    totalRemaining: remainingSlots.length,
    requestCount: requestedSlots.length,
    requestedSlots,
  };
}

export function retainValidInjectionPlanCandidates(candidates, {
  job,
  previousBugs = [],
  accepted = [],
  rejectedIds = new Set(),
  rejectedFingerprints = new Set(),
} = {}) {
  const retained = [...accepted];
  const rejected = [];
  for (const raw of candidates || []) {
    const candidate = structuredClone(raw);
    const fingerprint = bugCandidateFingerprintDigest(candidate);
    const originalBugId = candidate.bug_id;
    try {
      if (rejectedFingerprints.has(fingerprint)) {
        throw new Error(`重复了已拒绝候选：${candidate.bug_id || 'unknown'}`);
      }
      const occupiedIds = new Set([
        ...rejectedIds,
        ...previousBugs.map((item) => item.discovery?.bug_id).filter(Boolean),
        ...retained.map((item) => item.bug_id).filter(Boolean),
      ]);
      if (candidate.bug_id && occupiedIds.has(candidate.bug_id)) {
        const suffix = `retry-${fingerprint.slice(0, 8)}`;
        const maxBaseLength = Math.max(1, 72 - suffix.length - 1);
        const base = safeSlug(candidate.bug_id, 'injected-bug').slice(0, maxBaseLength).replace(/-+$/g, '') || 'injected-bug';
        let renamed = `${base}-${suffix}`;
        let sequence = 2;
        while (occupiedIds.has(renamed)) {
          renamed = `${base}-${suffix}-${sequence}`;
          sequence += 1;
        }
        candidate.bug_id = renamed;
      }
      if (candidate.found !== true) throw new Error(`必须返回 found=true：${candidate.bug_id || 'unknown'}`);
      validateDiscoveredBug(candidate, job.request.taskType, {
        ...job.request,
        previousUserQueries: [...previousBugs, ...retained.map((item) => ({ discovery: item }))]
          .map((item) => item.discovery?.user_query).filter(Boolean),
      });
      assertDistinctBugSelection({
        bugs: [...previousBugs, ...retained.map((item, index) => ({ bugIndex: -(index + 1), discovery: item }))],
      }, 0, candidate);
      const concentration = validateRootCauseFileConcentration([
        ...previousBugs,
        ...retained.map((item, index) => ({ bugIndex: -(index + 1), discovery: item })),
        { bugIndex: 0, discovery: candidate },
      ], { totalBugCount: job.request.bugCount });
      if (!concentration.ok) throw new Error(`根因文件占比门禁未通过：${concentration.issues.join('；')}`);
      retained.push(candidate);
    } catch (error) {
      if (originalBugId) rejectedIds.add(originalBugId);
      if (candidate.bug_id) rejectedIds.add(candidate.bug_id);
      rejectedFingerprints.add(fingerprint);
      rejected.push({ bugId: candidate.bug_id || '', fingerprint, reason: error.message });
    }
  }
  return { accepted: retained, rejected };
}

async function ensureInjectionPlan(jobFile, projectDir, naturalBatch) {
  const job = await readJson(jobFile);
  if (Number(job.workflowVersion || 1) < CURRENT_WORKFLOW_VERSION) return null;
  const naturalIndexes = new Set((naturalBatch?.assignments || []).map((item) => Number(item.bugIndex)));
  const bugIndexes = Array.from({ length: Number(job.request.bugCount || 0) }, (_, index) => index + 1)
    .filter((bugIndex) => {
      const discovery = job.stages.find((item) => item.id === `bug${bugIndex}_bug_discovery`);
      const source = job.stages.find((item) => item.id === `bug${bugIndex}_bug_source_prepare`);
      const record = (job.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
      const pendingDiscovery = discovery && !['passed', 'skipped'].includes(discovery.status);
      const pendingInjectedSource = source && !['passed', 'skipped'].includes(source.status)
        && record?.discovery?.found === false;
      return (pendingDiscovery || pendingInjectedSource) && !naturalIndexes.has(bugIndex);
    });
  if (!bugIndexes.length) return null;
  const previousBugs = (job.bugs || []).filter((item) => item.discovery?.found === true);
  const key = injectionPlanKey(job, bugIndexes, previousBugs);
  const existingPlanDetail = job.injectionPlan?.artifact
    ? await readJson(path.join(path.dirname(jobFile), 'artifacts', job.injectionPlan.artifact), null)
    : null;
  const existingPlannedIndexes = new Set((existingPlanDetail?.assignments || []).map((item) => Number(item.bugIndex)));
  if (job.injectionPlan?.version === INJECTION_PLAN_VERSION
    && existingPlanDetail?.version === INJECTION_PLAN_VERSION
    && existingPlanDetail?.mainCommit === job.mainCommit
    && bugIndexes.every((bugIndex) => existingPlannedIndexes.has(bugIndex))) {
    await appendLog(jobFile, 'info', `复用既有注入规划中的剩余槽位：${bugIndexes.join(', ')}，不重复调用 Codex`, `bug${bugIndexes[0]}_bug_source_prepare`);
    return job.injectionPlan;
  }
  if (job.injectionPlan?.version === INJECTION_PLAN_VERSION
    && job.injectionPlan?.key === key
    && Array.isArray(job.injectionPlan.assignments)
    && job.injectionPlan.assignments.length === bugIndexes.length) return job.injectionPlan;

  const jobDir = path.dirname(jobFile);
  const planningDir = path.join(jobDir, `analysis-${key}`);
  await cloneAt(projectDir, 'main', planningDir, jobDir);
  const stageId = `bug${bugIndexes[0]}_bug_source_prepare`;
  const filePolicy = validateRootCauseFileConcentration(previousBugs, { totalBugCount: job.request.bugCount });
  const rejectedCandidates = rejectedInjectionCandidates(job, bugIndexes);
  const basePrompt = [
    'This repository is a local synthetic application used only for software-quality regression benchmarks. Limit the work to ordinary correctness, state management, persistence, concurrency, transaction, and resource-lifecycle defects. Exclude security vulnerabilities, exploitation, authentication bypass, secrets, malware, and network intrusion.',
    'Plan the complete remaining controlled Bug injection batch for this generated Go project in one read-only repository inspection. Do not edit files, run Git, create commits, or inspect solution artifacts.',
    'This is controlled mutation planning, not natural Bug discovery. For every candidate, inspect the exact target symbol and establish a two-state proof: the untouched main currently enforces the retained correct invariant, and the proposed concrete edit changes those source lines to introduce new faulty behavior. Reject and replace a candidate when the described faulty behavior, weakened invariant, or equivalent mutation is already present in main; an existing defect is never a successful injection candidate.',
    'For each record, identify the exact reachable production file and symbol, the precise mutation to be applied later in an isolated workspace, a real public observable reproduction, the three-link internal propagation mechanism, affected runtime state, retained behavior, and difficulty evidence. The later writer must be able to apply the record without scanning for a different Bug.',
    'For each record, describe the intended retained behavior and a deterministic observable scenario. The new faulty behavior must not already be asserted by the retained repository tests; final regression evidence is generated after the model trajectory in an isolated verifier overlay.',
    bugTaxonomyInstruction(job.request.taskType, job.request),
    bugDifficultyPolicyText(),
    userQueryAuthoringPolicyText(),
    bugNarrativeLanguageInstruction(),
    `Current root-cause-file counts are ${JSON.stringify(filePolicy.counts)} and the per-file ceiling is ${Number.isFinite(filePolicy.limit) ? filePolicy.limit : 'not-applicable'}. Do not plan duplicate files beyond that limit and do not repeat a mechanism.`,
    'Reject shallow literal, flag-name, enum, nil-only, decoder-option, comparator, index, counter, offset, or string-normalization mutations. Every planned defect must cross at least two meaningful runtime boundaries and modify reachable behavior, not dead or test-only code.',
    job.request.taskType === 'diagnosis'
      ? 'Every planned diagnosis Bug must describe one directly observable behavior and a legal read-only command shape when one is known. Do not execute the command or require it to be red during injection planning; the final pre_fix red proof is produced after the model trajectory with the isolated verifier overlay. Never use temporary paths, pipes, redirects, Git, hidden tests, or external network access in the eventual public command.'
      : 'Each planned bugfix must be exposable by a focused repository-owned TestModel_ regression test after injection.',
    `Already selected Bugs that must not be repeated:\n${JSON.stringify(previousBugs.map((item) => item.discovery), null, 2)}`,
    `Previously rejected injection candidates that either broke retained behavior, overlapped a defect already present in main, or failed to form a real production mutation. They must not be returned again (do not repeat their bug_id, target files plus symbols, or mutation):\n${JSON.stringify(rejectedCandidates, null, 2)}`,
    'Return only the requested structured pool. scope_summary must explain how the new records are independent and cover the requested missing slots.',
  ].join('\n\n');
  let result;
  let accepted = [];
  let lastRejected = [];
  const planningSessionIds = [];
  let lastSessionId = '';
  let recoveredPlanningAttempts = 0;
  const planningStartedAtMs = Date.now();
  const rejectedIds = new Set(rejectedCandidates.map((item) => item.bugId).filter(Boolean));
  const rejectedFingerprints = new Set(rejectedCandidates.map((item) => item.fingerprint).filter(Boolean));
  const maxPlanningAttempts = Math.ceil(bugIndexes.length / INJECTION_PLAN_BATCH_SIZE)
    + INJECTION_PLAN_RETRY_ALLOWANCE;

  // Every completed Codex call already has an atomic JSON artifact. Revalidate
  // those batches after a runner restart so later-batch failures do not discard
  // candidates that previously passed all local gates.
  for (let planningAttempt = 1; planningAttempt <= maxPlanningAttempts; planningAttempt += 1) {
    const attemptName = planningAttempt === 1 ? key : `${key}-batch-${planningAttempt}`;
    const reusable = await reusableCodexJson(jobFile, attemptName);
    if (!Array.isArray(reusable?.output?.candidates)) continue;
    const merged = retainValidInjectionPlanCandidates(reusable.output.candidates, {
      job,
      previousBugs,
      accepted,
      rejectedIds,
      rejectedFingerprints,
    });
    accepted = merged.accepted.slice(0, bugIndexes.length);
    lastRejected = merged.rejected;
    planningSessionIds.push(reusable.sessionId);
    lastSessionId = reusable.sessionId;
    recoveredPlanningAttempts = planningAttempt;
  }
  if (recoveredPlanningAttempts > 0) {
    await appendLog(jobFile, 'info', `从 ${planningSessionIds.length} 个已落盘规划批次恢复 ${accepted.length}/${bugIndexes.length} 个合格候选（最高第 ${recoveredPlanningAttempts} 轮），仅续接剩余槽位`, stageId);
  }

  for (let planningAttempt = recoveredPlanningAttempts + 1; planningAttempt <= maxPlanningAttempts; planningAttempt += 1) {
    const planningBatch = injectionPlanningBatch(bugIndexes, accepted.length);
    if (planningBatch.totalRemaining <= 0) break;
    const attemptPrompt = [
      basePrompt,
      `There are ${planningBatch.totalRemaining} total missing slots. This small planning call covers only the next ${planningBatch.requestCount} slots (${planningBatch.requestedSlots.join(', ')}). Return exactly ${planningBatch.requestCount} NEW independent found=true Bug records.`,
      'Inspect only the production paths needed for this small batch. First support each candidate from public handlers or commands plus production implementation. Then use targeted symbol or test-name search to inspect at most 4 directly related existing *_test.go files for the whole call, and reject any candidate whose planned faulty behavior is already asserted there. Test inspection is exclusion-only: never make a candidate conditional on a fixture, clock or concrete type, environment variable, build tag, runtime caller, or any other test-versus-production discriminator to evade retained tests. Do not run tests, inspect testdata or test helpers, choose test-only code, or scan the full test suite. Use rg for targeted discovery; if it is unavailable, any find fallback must prune .git and other metadata directories instead of listing the whole workspace. Inspect at most 15 additional production files for this call, do not ask for additional input, and return the structured result immediately once the requested records are supported. Aim to finish this call within about 6 minutes.',
      rejectedCandidates.some((item) => item.failedTests?.length)
        ? `Retained tests that rejected earlier candidates in these slots are listed below. Inspect those named tests first when their production path overlaps a new candidate, and do not propose an equivalent behavior break:\n${JSON.stringify(rejectedCandidates.flatMap((item) => item.failedTests || []).filter(Boolean), null, 2)}`
        : '',
      accepted.length
        ? `The following ${accepted.length} records already passed every local planning gate and are frozen. Do not return or revise them; only fill the missing slots:\n${JSON.stringify(accepted, null, 2)}`
        : 'No injection records have been retained yet.',
      lastRejected.length
        ? `The previous planning response had rejected records. Do not repeat their IDs, fingerprints, mechanisms, or equivalent mutations:\n${JSON.stringify(lastRejected, null, 2)}`
        : '',
    ].filter(Boolean).join('\n\n');
    let releaseStructuredCodex = async () => {};
    try {
      releaseStructuredCodex = await acquireStageResourceSlot(jobFile, 'codex_injection_plan', {
        waitForCapacity: true,
        preserveJobCursor: true,
      });
      result = await runCodexJson({
        jobFile,
        stageId,
        cwd: planningDir,
        prompt: attemptPrompt,
        schema: injectionPlanSchema(job.request.bugPolicyVersion, planningBatch.requestCount),
        name: planningAttempt === 1 ? key : `${key}-batch-${planningAttempt}`,
        sandbox: 'read-only',
        timeoutMs: INJECTION_PLAN_TIMEOUT_MS,
        idleTimeoutMs: INJECTION_PLAN_IDLE_TIMEOUT_MS,
        streamRecoveryWindowMs: STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS,
        reasoningEffort: 'medium',
        ignoreUserConfig: true,
        ephemeral: true,
      });
    } catch (error) {
      if (planningAttempt >= maxPlanningAttempts) throw error;
      await appendLog(jobFile, 'warn', `增量注入规划第 ${planningAttempt} 批失败，已保留 ${accepted.length}/${bugIndexes.length} 个候选，仅重试当前小批次：${error.message}`, stageId);
      continue;
    } finally {
      await releaseStructuredCodex().catch(() => {});
    }
    planningSessionIds.push(result.sessionId);
    lastSessionId = result.sessionId;
    await assertCleanGit(planningDir, 'batch injection planning');
    const candidates = result.output.candidates || [];
    const merged = retainValidInjectionPlanCandidates(candidates, {
      job,
      previousBugs,
      accepted,
      rejectedIds,
      rejectedFingerprints,
    });
    accepted = merged.accepted.slice(0, bugIndexes.length);
    lastRejected = merged.rejected;
    if (accepted.length < bugIndexes.length) {
      const remaining = bugIndexes.length - accepted.length;
      const detail = lastRejected.map((item) => `${item.bugId || 'unknown'}: ${item.reason}`).join('；') || '返回数量不足';
      if (planningAttempt >= maxPlanningAttempts) throw new Error(`增量注入规划用尽 ${maxPlanningAttempts} 批后仍缺少 ${remaining} 个合格候选：${detail}`);
      await appendLog(jobFile, 'info', `增量注入规划第 ${planningAttempt} 批后已保留 ${accepted.length}/${bugIndexes.length} 个合格候选，继续补剩余 ${remaining} 个${lastRejected.length ? `：${detail}` : ''}`, stageId);
    }
  }
  if (accepted.length !== bugIndexes.length || !lastSessionId) {
    throw new Error(`批量注入规划未填满：需要 ${bugIndexes.length} 个，实际 ${accepted.length} 个`);
  }
  const assignments = bugIndexes.map((bugIndex, index) => ({ bugIndex, candidate: accepted[index] }));
  const artifact = `${key}.json`;
  await writeJsonAtomic(path.join(jobDir, 'artifacts', artifact), {
    version: INJECTION_PLAN_VERSION,
    key,
    sessionId: lastSessionId,
    planningSessionIds,
    planningDurationMs: Date.now() - planningStartedAtMs,
    mainCommit: job.mainCommit,
    assignments,
  });
  const plan = {
    version: INJECTION_PLAN_VERSION,
    key,
    sessionId: lastSessionId,
    planningSessionIds,
    planningAttempts: planningSessionIds.length,
    planningDurationMs: Date.now() - planningStartedAtMs,
    artifact,
    assignments: assignments.map(({ bugIndex, candidate }) => ({
      bugIndex,
      bugId: candidate.bug_id,
      fingerprint: bugCandidateFingerprintDigest(candidate),
    })),
    completedAt: now(),
  };
  await updateJob(jobFile, (current) => { current.injectionPlan = plan; });
  await appendLog(jobFile, 'success', `增量注入规划用 ${planningSessionIds.length} 轮填满 ${assignments.length} 个剩余 Bug 槽位：${bugIndexes.join(', ')}`, stageId);
  return plan;
}

async function injectionPlanAssignment(jobFile, bugIndex) {
  const job = await readJson(jobFile);
  const plan = job.injectionPlan;
  if (!plan?.artifact) return null;
  const detail = await readJson(path.join(path.dirname(jobFile), 'artifacts', plan.artifact), null);
  return detail?.assignments?.find((item) => Number(item.bugIndex) === Number(bugIndex)) || null;
}

async function reviewGoldBugDifficulty(jobFile, stageId, goldDir, bug, gold, bugBaseCommit, bugIndex) {
  const prompt = [
    'Perform a strictly read-only final difficulty audit of this benchmark Bug using the BUG_BASE, current Gold diff, regression test, and structured Gold root cause. Do not modify files or create commits.',
    `Use ${bugBaseCommit} as the BUG_BASE when inspecting the current Gold diff.`,
    bugDifficultyPolicyText(),
    'Reject if the concrete Gold root cause reveals that the task is essentially a one-line typo, one missing enum/nil/decoder check, string normalization, or a simple comparator/index/counter/offset change without a substantive runtime invariant. Do not approve because the user_query or difficulty fields exaggerate the impact.',
    'Approve only when the Gold test exercises the stated runtime and cross-boundary invariant through public observable behavior. Concurrent tasks must use the race detector or a deterministic synchronization barrier that directly proves the race or lifecycle ordering.',
    `Selected Bug record:\n${JSON.stringify(bug, null, 2)}`,
    `Structured Gold result:\n${JSON.stringify(gold, null, 2)}`,
    'Return JSON matching the supplied schema and cite exact source and test evidence.',
  ].join('\n\n');
  const review = await runCodexJson({
    jobFile,
    stageId,
    cwd: goldDir,
    prompt,
    schema: qualitySchema,
    name: `bug${bugIndex}-gold-difficulty-review`,
    sandbox: 'read-only',
  });
  if (!review.output.approved) {
    const detail = review.output.issues.map((issue) => `${issue.code}: ${issue.message} (${issue.evidence})`).join('; ') || review.output.summary;
    throw new Error(`Gold Bug 难度复核不通过：${detail}`);
  }
  return review;
}

const GOLD_INTERNAL_CAUSE_PATTERN = /未|没有|缺少|忽略|遗漏|漏掉|错误|不正确|不当|非严格|无条件|过早|过晚|提前|延后|相反|颠倒|多算|少算|覆盖|清空|丢弃|吞掉|竞态|竞争|随机|未同步|未更新|未检查|未传播|未保留|整数除法|取整|截断|溢出|越界/i;
const GOLD_INTERNAL_OPERATION_PATTERN = /分支|使用|采用|执行|计算|比较|判断|检查|校验|更新|修改|设置|赋值|写入|读取|删除|追加|递增|递减|加锁|解锁|同步|缓存|阈值|索引|切片|map|通道|channel|循环|返回|传递|解析|编码|解码|取整|截断|整数除法|位移|状态|字段|投影|事务|提交|恢复|重放|构造|保存|原地/i;
const GOLD_PROPAGATION_PATTERN = /导致|使得|使|从而|因此|进而|传播|进入|继续|返回|写入|读取|覆盖|丢失|绕过|越过|保留|选择|计算|转换|解析|索引|更新|调用|提交|触发|传入|交给|落入|流入|到达|可见/i;
const GO_ROOT_CAUSE_FILE_PATTERN = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.go$/;
const GO_ROOT_CAUSE_SYMBOL_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:\(\*?[A-Za-z_][A-Za-z0-9_]*\)\.)?[A-Za-z_][A-Za-z0-9_]*$/;

function cleanGoldValue(value) {
  return stripMarkdownBackticks(String(value || '')).trim();
}

function normalizeGoSymbol(value) {
  const cleaned = cleanGoldValue(value);
  return cleaned.replace(
    /^\((\*?)([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\)\.([A-Za-z_][A-Za-z0-9_]*)$/,
    (_, pointer, packageName, receiver, method) => `${packageName}.(${pointer}${receiver}).${method}`,
  );
}

function comparableGoSymbol(value) {
  return normalizeGoSymbol(value).replace(
    /(^|\.)\(\*?([A-Za-z_][A-Za-z0-9_]*)\)\./,
    '$1$2.',
  );
}

function comparableGoSymbolForms(value) {
  const comparable = comparableGoSymbol(value);
  if (!comparable) return new Set();
  const parts = comparable.split('.');
  // A discovery record may omit the package while Gold reports the exact
  // package-qualified receiver. Keep Receiver.Method intact so unrelated
  // methods with the same final name are never treated as equivalent.
  return new Set(parts.length >= 3 ? [comparable, parts.slice(-2).join('.')] : [comparable]);
}

function goSymbolsOverlap(left, right) {
  const leftForms = comparableGoSymbolForms(left);
  const rightForms = comparableGoSymbolForms(right);
  for (const form of leftForms) if (rightForms.has(form)) return true;
  return false;
}

function comparableGoFile(value) {
  return cleanGoldValue(value)
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^\.\//, '');
}

export function canonicalizeGoldDescriptor(gold = {}) {
  const rootCauseFile = cleanGoldValue(gold.root_cause_file);
  const rootCauseSymbols = [...new Set((Array.isArray(gold.root_cause_symbols) ? gold.root_cause_symbols : [])
    .map(normalizeGoSymbol)
    .filter(Boolean))];
  const internalCause = cleanGoldValue(gold.internal_cause);
  const propagationPath = cleanGoldValue(gold.propagation_path);
  const observableFailure = cleanGoldValue(gold.observable_failure);
  const structuredMechanism = internalCause && propagationPath && observableFailure
    ? `内部原因是${internalCause}；传播过程是${propagationPath}；最终导致${observableFailure}`
    : '';
  const failureMechanism = structuredMechanism || cleanGoldValue(gold.failure_mechanism);
  const legacyRootCause = cleanGoldValue(gold.gold_root_cause);
  const primarySymbol = rootCauseSymbols[0] || '';
  const cleanSentencePart = (value) => cleanGoldValue(value).replace(/[\s。；;.]+$/u, '');
  const explicitSymbols = rootCauseSymbols.join('、');
  const naturalRootCause = rootCauseFile && primarySymbol && internalCause && propagationPath && observableFailure
    ? `${rootCauseFile} 中的 ${explicitSymbols} 根本原因是${cleanSentencePart(internalCause)}；${cleanSentencePart(propagationPath)}，最终导致${cleanSentencePart(observableFailure)}。`
    : '';
  const goldRootCause = legacyRootCause || naturalRootCause;
  return {
    ...gold,
    root_cause_file: rootCauseFile,
    root_cause_symbols: rootCauseSymbols,
    internal_cause: internalCause,
    propagation_path: propagationPath,
    observable_failure: observableFailure,
    failure_mechanism: failureMechanism,
    gold_root_cause: goldRootCause,
  };
}

export function validateGoldTestDescriptor(gold, { requiredPrefix = '', expectedFiles = [], expectedSymbols = [] } = {}) {
  const normalized = canonicalizeGoldDescriptor(gold);
  if (!/^(?:\.|\.\/[A-Za-z0-9_.\/-]+)$/.test(gold.test_package)) throw new Error(`Gold test_package 不安全：${gold.test_package}`);
  if (!/^Test[A-Za-z0-9_]+$/.test(gold.test_name)) throw new Error(`Gold test_name 不合法：${gold.test_name}`);
  if (requiredPrefix && !String(gold.test_name).startsWith(requiredPrefix)) {
    throw new Error(`Gold test_name 必须使用唯一命名空间前缀 ${requiredPrefix}：${gold.test_name}`);
  }
  if (!GO_ROOT_CAUSE_FILE_PATTERN.test(normalized.root_cause_file)) throw new Error('Gold root_cause_file 必须是具体的 Go 源文件路径');
  if (!normalized.root_cause_symbols.length || normalized.root_cause_symbols.some((symbol) => !GO_ROOT_CAUSE_SYMBOL_PATTERN.test(symbol))) {
    throw new Error('Gold root_cause_symbols 必须包含具体且合法的 Go 函数、方法或类型符号');
  }
  if (!isChineseDescription(normalized.internal_cause)
    || !GOLD_INTERNAL_CAUSE_PATTERN.test(normalized.internal_cause)
    || !GOLD_INTERNAL_OPERATION_PATTERN.test(normalized.internal_cause)) {
    throw new Error('Gold internal_cause 必须说明实现内部的错误检查、状态或控制流，不能填写可观察现象');
  }
  if (!isChineseDescription(normalized.propagation_path) || !GOLD_PROPAGATION_PATTERN.test(normalized.propagation_path)) {
    throw new Error('Gold propagation_path 必须说明内部原因如何传播到错误结果');
  }
  if (!isChineseDescription(normalized.observable_failure)) throw new Error('Gold observable_failure 必须使用中文说明公开可观察的错误结果');
  const expectedFileBasenames = new Set(expectedFiles.map((value) => path.basename(comparableGoFile(value))).filter(Boolean));
  if (expectedFileBasenames.size && !expectedFileBasenames.has(path.basename(normalized.root_cause_file))) {
    throw new Error(`Gold root_cause_file 必须命中已定位文件：${[...expectedFileBasenames].join('、')}`);
  }
  const expectedSymbolSet = new Set(expectedSymbols.map(comparableGoSymbol).filter(Boolean));
  if (expectedSymbolSet.size && !normalized.root_cause_symbols.some((symbol) => expectedSymbols.some((expected) => goSymbolsOverlap(symbol, expected)))) {
    throw new Error(`Gold root_cause_symbols 必须命中已定位符号：${[...expectedSymbolSet].join('、')}`);
  }
  if (!isChineseDescription(normalized.gold_root_cause)) throw new Error('Gold gold_root_cause 必须以中文为主体，不能夹带英文叙述段落');
  if (!Array.isArray(gold.mechanism_keywords) || gold.mechanism_keywords.length < 3 || new Set(gold.mechanism_keywords).size !== gold.mechanism_keywords.length) {
    throw new Error('Gold 必须提供 3-6 个互不重复的失效机制关键词');
  }
  return normalized;
}

export async function changedTestFiles(goldDir, baseCommit, testName, { requiredBasename = '' } = {}) {
  const tracked = (await git(goldDir, ['diff', '--name-only', baseCommit])).stdout.split(/\r?\n/).filter(Boolean);
  const untracked = (await git(goldDir, ['ls-files', '--others', '--exclude-standard'])).stdout.split(/\r?\n/).filter(Boolean);
  const changed = [...new Set([...tracked, ...untracked])];
  const tests = changed.filter((filename) => filename.endsWith('_test.go'));
  if (!tests.length) throw new Error('Gold 修复必须新增或修改至少一个 Go 回归测试文件');
  const declaration = new RegExp(`\\bfunc\\s+${String(testName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  const declarationFiles = [];
  for (const filename of tests) {
    if (filename.includes('..') || path.isAbsolute(filename)) throw new Error(`Gold 测试路径不安全：${filename}`);
    const content = await fsp.readFile(path.join(goldDir, filename), 'utf8');
    if (declaration.test(content)) declarationFiles.push(filename);
  }
  if (declarationFiles.length !== 1) throw new Error(`Gold 回归测试声明必须只位于一个文件：${testName}（实际 ${declarationFiles.length} 个）`);
  if (requiredBasename && path.basename(declarationFiles[0]) !== requiredBasename) {
    throw new Error(`Gold 回归测试必须新增独立文件 ${requiredBasename}，实际为 ${declarationFiles[0]}`);
  }
  const untrackedSet = new Set(untracked);
  if (requiredBasename && !untrackedSet.has(declarationFiles[0])) {
    throw new Error(`Gold 回归测试文件必须是新增文件，不能覆盖已有测试：${declarationFiles[0]}`);
  }
  return declarationFiles;
}

export async function resolveGoldTestPackage(goldDir, testFiles, testName) {
  const declaration = new RegExp(`\\bfunc\\s+${String(testName).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`);
  const packages = new Set();
  for (const filename of testFiles) {
    const content = await fsp.readFile(path.join(goldDir, filename), 'utf8');
    if (!declaration.test(content)) continue;
    const directory = path.posix.dirname(filename.split(path.sep).join('/'));
    packages.add(directory === '.' ? '.' : `./${directory}`);
  }
  if (packages.size !== 1) throw new Error(`Gold test_name ${testName} 必须只在一个 Go package 中声明`);
  return [...packages][0];
}

export async function assertGoldTestsUsePublicBehavior(goldDir, testFiles) {
  const issues = [];
  const samePackageFiles = [];
  for (const filename of testFiles) {
    const content = await fsp.readFile(path.join(goldDir, filename), 'utf8');
    const packageName = content.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/m)?.[1] || '';
    if (packageName && !packageName.endsWith('_test')) samePackageFiles.push(filename);
    if (/\/\/go:linkname\b|\bunsafe\b|reflect\.(?:Value|NewAt)\b/.test(content)) issues.push(`${filename} 不能通过 linkname、unsafe 或反射绕过公开行为边界`);
  }
  if (issues.length) throw new Error(`Gold 回归测试不是公开行为验证：${issues.join('；')}`);
  return { samePackageFiles };
}

async function reviewGoldTestContract(jobFile, stageId, goldDir, bug, testFiles, bugIndex) {
  if (!testFiles.length) return null;
  const prompt = [
    'Perform a strictly read-only contract review of the listed Go regression tests and their current Gold diff. Do not modify files or create commits.',
    `Tests requiring contract review: ${testFiles.join(', ')}.`,
    'Approve only when the tests verify the public observable behavior explicitly required by user_query. success_criteria may clarify that behavior but must not introduce a new failure mode, exact value, or unrelated normal-flow requirement.',
    'Reject a test that requires an exact error code, error message, HTTP body, ordering, count, or internal representation when user_query asks only for a stable client error, rejection, or unchanged state. Exact values are valid only when user_query explicitly names them or an existing public contract in the supplied workspace already requires them.',
    'Representative equivalence classes may establish a general invariant. Do not require the Cartesian product of every input permutation, every changed field, and every state assertion when the focused tests collectively prove the invariant.',
    'Reject when the proposed new Gold behavior directly contradicts an existing repository-owned public test or documented public contract. Report this as GOLD_PUBLIC_CONTRACT_CONFLICT. A benchmark must not ask Claude to make a new hidden expectation pass by breaking an already passing public behavior.',
    'Also reject acceptance that depends on calling an unexported helper directly, inspecting private state or layout, or fixing implementation details rather than externally visible behavior. Main-package CLI behavior and same-package setup needed to reach a public outcome may be valid. The deterministic checker has already rejected linkname, unsafe, and reflection boundary bypasses.',
    `Selected bug record:\n${JSON.stringify(bug, null, 2)}`,
    'Return JSON matching the supplied schema and cite concrete test or diff evidence for each issue.',
  ].join('\n\n');
  const review = await runCodexJson({
    jobFile,
    stageId,
    cwd: goldDir,
    prompt,
    schema: qualitySchema,
    name: `bug${bugIndex}-gold-public-behavior-review`,
    sandbox: 'read-only',
  });
  if (!review.output.approved) {
    const detail = review.output.issues.map((issue) => `${issue.code}: ${issue.message} (${issue.evidence})`).join('; ') || review.output.summary;
    throw new Error(`Gold 回归测试题面契约复核不通过：${detail}`);
  }
  return review;
}

async function readVerificationTestSources(sourceDir, testFiles) {
  return Promise.all([...testFiles].sort().map(async (filename) => ({
    path: filename.split(path.sep).join('/'),
    content: await fsp.readFile(path.join(sourceDir, filename), 'utf8'),
  })));
}

function safeVerificationTestPath(filename) {
  const normalized = String(filename || '').trim();
  return Boolean(normalized)
    && !path.isAbsolute(normalized)
    && !normalized.split(/[\\/]/).includes('..')
    && normalized.endsWith('_test.go');
}

async function copyIfRegularFile(source, destination) {
  const sourceStat = await fsp.stat(source).catch(() => null);
  if (!sourceStat?.isFile()) return false;
  await copyFileReplacing(source, destination);
  return true;
}

/**
 * Verify all inputs before starting a Claude proof Session. Test-author output
 * is produced in a temporary workspace, so a scheduler restart can otherwise
 * leave public.json pointing at a test that is absent from the task workspace.
 * The checkpoint/model-test copies are repository-owned artifacts and are safe
 * recovery sources; no proof Session is started until the task copy exists.
 */
export async function prepareVerificationProofInputs(taskDir, phase, sourceDir) {
  const metadata = await readJson(path.join(taskDir, 'public.json'));
  const verifyCmds = Array.isArray(metadata.verify_cmds)
    ? metadata.verify_cmds.map((command) => String(command || '').trim()).filter(Boolean)
    : [];
  if (!verifyCmds.length) {
    throw new Error(`${phase} 证明前置检查失败：public.json.verify_cmds 为空，暂不启动 Claude 证明 Session`);
  }
  // Reject malformed public commands before allocating a proof Session.  In
  // particular, old Diagnosis rows may contain prose such as "HTTP 场景：...";
  // attempting to execute that text through the runner only wastes a timeout
  // and leaves the Bug looking like an infrastructure failure.
  const commandIssues = directPublicVerifyCommandIssues(verifyCmds, String(metadata.task_type || ''), {
    concurrency: isConcurrencyBug(metadata),
  });
  if (commandIssues.length) {
    throw new Error(`${phase} 证明前置检查失败：verify_cmds 不可直接执行：${commandIssues.join('；')}`);
  }
  const overlay = String(metadata.verification_test_overlay || 'none');
  if (overlay === 'private-fixture') {
    const taskRoot = path.resolve(taskDir);
    const fixtureDir = path.resolve(String(metadata.verification_fixture_dir || ''));
    if (!fixtureDir || (fixtureDir !== taskRoot && !fixtureDir.startsWith(`${taskRoot}${path.sep}`))) {
      throw new Error(`${phase} 证明前置检查失败：私有验证夹具必须位于任务目录内`);
    }
    const testFiles = Array.isArray(metadata.verification_test_files)
      ? metadata.verification_test_files.map((filename) => String(filename || '').trim()).filter(Boolean)
      : [];
    if (testFiles.length !== 1 || !safeVerificationTestPath(testFiles[0])) {
      throw new Error(`${phase} 证明前置检查失败：private-fixture 必须声明一个安全的 *_test.go 文件`);
    }
    const fixturePath = path.join(fixtureDir, testFiles[0]);
    const fixtureStat = await fsp.stat(fixturePath).catch(() => null);
    if (!fixtureStat?.isFile()) throw new Error(`${phase} 证明前置检查失败：私有验证夹具文件不存在：${testFiles[0]}`);
    if (metadata.verification_fixture_sha256) {
      const digest = crypto.createHash('sha256').update(await fsp.readFile(fixturePath)).digest('hex');
      if (digest !== metadata.verification_fixture_sha256) throw new Error(`${phase} 证明前置检查失败：私有验证夹具哈希不一致`);
    }
    return { verifyCmds, testFiles, fixtureDir };
  }
  if (overlay !== 'repository-tests') return { verifyCmds, testFiles: [] };
  const testFiles = Array.isArray(metadata.verification_test_files)
    ? metadata.verification_test_files.map((filename) => String(filename || '').trim()).filter(Boolean)
    : [];
  if (!testFiles.length) {
    throw new Error(`${phase} 证明前置检查失败：repository-tests 未声明 verification_test_files`);
  }
  const taskWorkspace = path.join(taskDir, 'workspace');
  const recoveryRoots = [
    taskWorkspace,
    path.join(taskDir, '.test-author-checkpoint', 'workspace'),
    path.join(taskDir, 'grader', 'model-tests'),
    path.resolve(String(sourceDir || '')),
  ];
  for (const filename of testFiles) {
    if (!safeVerificationTestPath(filename)) {
      throw new Error(`${phase} 证明前置检查失败：验证测试路径不安全：${filename}`);
    }
    const destination = path.join(taskWorkspace, filename);
    let materialized = await fsp.stat(destination).then((stat) => stat.isFile()).catch(() => false);
    for (const root of recoveryRoots) {
      if (materialized) break;
      if (!root || root === taskWorkspace) continue;
      materialized = await copyIfRegularFile(path.join(root, filename), destination);
    }
    if (!materialized) {
      throw new Error(`${phase} 证明前置检查失败：验证测试文件未物化到任务工作区：${filename}`);
    }
  }
  return { verifyCmds, testFiles };
}

async function reviewVerificationCoverage(jobFile, stageId, sourceDir, bug, verifyCmds, testFiles, taskType, bugIndex, redGreen, label = '公开模型') {
  const deliveredUserQuery = taskType === 'diagnosis'
    ? `${bug.user_query.trim()}\n\n公开复现命令：${verifyCmds.join('\n')}`
    : bug.user_query.trim();
  const modelTests = await readVerificationTestSources(sourceDir, testFiles);
  const commandTestNames = [...new Set(verifyCmds.flatMap(verificationTestNamesFromCommand))].sort();
  const sourceTestNames = [...new Set(modelTests.flatMap((entry) => goTestNames(entry.content)))].sort();
  const testNames = commandTestNames.length ? commandTestNames : sourceTestNames;
  const commandDescription = verifyCmds.map((command, index) => `${index + 1}. ${command}`).join('\n');
  const coverageInstruction = commandTestNames.length
    ? `The commands run exactly these Go test functions: ${testNames.join(', ')}. They must collectively cover every distinct issue-specific public scenario explicitly requested by user_query. It is not enough that another test in go test ./... might cover a missing scenario.`
    : `The public reproduction command does not name a Go test. Use these repository-owned public regression tests as the semantic oracle for its expected behavior: ${testNames.join(', ')}. They must collectively cover every distinct issue-specific public scenario explicitly requested by user_query.`;
  const prompt = [
    `Perform a strictly read-only semantic coverage audit of the listed ${label} sources. Do not modify files, create files, inspect Git history, inspect hidden grader answers, or execute any shell, Go, Docker, or other command. The audit must use only the listed test sources and the supplied red_green_summary.`,
    `The reference verification commands are exactly:\n${commandDescription}\nThey have already been executed by the pipeline; do not execute them again and do not reject the report because this read-only audit environment cannot create a Go temporary build directory.`,
    coverageInstruction,
    'Treat issue-specific behavior in user_query as the authoritative hard contract. success_criteria may clarify an already stated scenario, but a detail that appears only in success_criteria is supplemental and must not make approved=false. Broad preservation clauses whose only meaning is that existing, normal, compatibility, idempotency, transaction, or concurrency behavior remains unchanged/unaffected are supplemental even when they appear in user_query; the pipeline full-suite gate supplies their general non-regression evidence. In particular, do not require a dedicated concurrent-operation test merely for wording such as 并发访问不受影响, 保持现有并发行为, or concurrency behavior must remain unaffected. Concurrency remains hard when it is the Bug trigger or requested observable scenario, including two goroutines/parallel requests, a controlled interleaving, race, deadlock, lost update, or an explicit -race requirement. Set contract_level=hard only for such concrete issue-specific requirements; set contract_level=supplemental for generic preservation, success_criteria-only strengthening, and optional review notes. Do not strengthen words such as equivalent, unchanged, stable, or regardless of order into a requirement to repeat every assertion for every permutation or to enumerate every possible field combination.',
    'Classify process instructions such as run full tests, run vet, do not modify unrelated files, or diagnosis-vs-bugfix workflow as process_constraint. For target behavior, judge scenario coverage across the complete focused test set: representative equivalence classes and shared invariance assertions are sufficient; never demand a Cartesian product of inputs and assertions.',
    'For every hard target_behavior requirement from user_query, cite the exact public test file path and Test/subtest plus the concrete assertion or observed value. Set approved=false only when a distinct user_query scenario or required public boundary is actually absent. Do not add issues for optional strengthening. Reject if the tests only exercise a lower-level helper while user_query requires a public command or HTTP boundary.',
    'Do not require a specific error code or message unless user_query explicitly names it. A stable domain/client rejection with the required no-write behavior satisfies a generic stable-error request.',
    'Process constraints are not coverage requirements for this audit: report them as category=process_constraint and contract_level=supplemental only when useful, and never set approved=false or add a hard issue merely because the pipeline already executed a command outside this read-only audit. Every issue must also carry contract_level.',
    `user_query:\n${deliveredUserQuery}`,
    `success_criteria:\n${bug.success_criteria}`,
    `test_names: ${testNames.join(', ')}`,
    `test_files: ${testFiles.join(', ')}`,
    `red_green_summary:\n${JSON.stringify(redGreen, null, 2)}`,
    ...modelTests.map((entry) => `--- ${entry.path} ---\n${entry.content}`),
    'Return only JSON matching the supplied schema.',
  ].join('\n\n');
  const review = await runCodexJson({
    jobFile,
    stageId,
    cwd: sourceDir,
    prompt,
    schema: verificationCoverageSchema,
    name: `bug${bugIndex}-verification-coverage-review`,
    sandbox: 'read-only',
  });
  const attestation = createVerificationCoverageAttestation({
    userQuery: deliveredUserQuery,
    successCriteria: bug.success_criteria,
    verifyCmds,
    modelTests,
    report: review.output,
    reviewerSessionId: review.sessionId,
  });
  return { report: review.output, attestation, modelTests, verifyCmds, testFiles, testNames };
}

function isConcurrencyBug(bug) {
  return isConcurrencyVerificationRecord(bug);
}

function targetTestCommand(gold, { repeat = DETERMINISTIC_TEST_RUNS, race = false } = {}) {
  return `GOTOOLCHAIN=local go test ${race ? '-race ' : ''}${gold.test_package} -run '^${gold.test_name}$' -count=${repeat}`;
}

async function overlayTests(sourceRoot, destinationRoot, testFiles) {
  for (const filename of testFiles) {
    const destination = path.join(destinationRoot, filename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(path.join(sourceRoot, filename), destination);
  }
}

async function verifyGoldRedGreen(jobDir, bugBaseDir, goldDir, bugBaseCommit, bug, gold, testFiles, bugIndex) {
  const redDir = path.join(jobDir, `red-check-bug${bugIndex}`);
  await archiveDirectory(jobDir, redDir, `red-check-bug${bugIndex}-retry`);
  await copyWithoutGit(bugBaseDir, redDir);
  await overlayTests(goldDir, redDir, testFiles);
  const race = isConcurrencyBug(bug);
  const redCommand = targetTestCommand(gold, { repeat: 1, race });
  const redGoEnv = await projectGoEnvironment(redDir);
  const greenGoEnv = await projectGoEnvironment(goldDir);
  const fastRed = await runCommand('/bin/bash', ['-lc', redCommand], { cwd: redDir, env: redGoEnv, timeoutMs: 10 * 60 * 1000 });
  if (fastRed.exitCode === 0) throw new Error('Gold 快速门禁失败：目标回归测试在 BUG_BASE 没有失败');
  const fastGreenCommand = targetTestCommand(gold, { repeat: 1, race });
  await runRequired('Gold 快速门禁修复后目标测试', '/bin/bash', ['-lc', fastGreenCommand], { cwd: goldDir, env: greenGoEnv, timeoutMs: 10 * 60 * 1000 });

  const redRuns = [fastRed];
  const command = targetTestCommand(gold, { repeat: DETERMINISTIC_TEST_RUNS, race });
  const remainingRedRuns = Array.from({ length: DETERMINISTIC_TEST_RUNS - 1 }, (_, index) => index + 2);
  let green;
  await Promise.all([
    runBoundedWorkers(remainingRedRuns, 2, async (runNumber) => {
      const red = await runCommand('/bin/bash', ['-lc', redCommand], { cwd: redDir, env: redGoEnv, timeoutMs: 10 * 60 * 1000 });
      redRuns.push(red);
      if (red.exitCode === 0) throw new Error(`Gold 回归测试在 BUG_BASE 第 ${runNumber}/${DETERMINISTIC_TEST_RUNS} 次没有失败，故障不具备确定性`);
    }, { stopOnError: true }),
    runRequired('Gold 20 次稳定性目标回归测试', '/bin/bash', ['-lc', command], { cwd: goldDir, env: greenGoEnv, timeoutMs: 10 * 60 * 1000 })
      .then((result) => { green = result; }),
  ]);
  const fullArgs = race ? ['test', '-race', './...', `-count=${DETERMINISTIC_TEST_RUNS}`] : ['test', './...', '-count=1'];
  await runRequired('Gold 全量测试', 'go', fullArgs, { cwd: goldDir, env: greenGoEnv, timeoutMs: race ? 60 * 60 * 1000 : 20 * 60 * 1000 });
  await runRequired('Gold 静态检查', 'go', ['vet', './...'], { cwd: goldDir, env: greenGoEnv, timeoutMs: 20 * 60 * 1000 });
  return {
    command,
    baseCommit: bugBaseCommit,
    redCommand,
    redExitCode: redRuns.at(-1).exitCode,
    redOutput: redRuns.map((run) => [run.stdout, run.stderr].filter(Boolean).join('\n')).join('\n').slice(-8000),
    redFailureCount: redRuns.filter((run) => run.exitCode !== 0).length,
    greenExitCode: green.exitCode,
    greenOutput: [green.stdout, green.stderr].filter(Boolean).join('\n').slice(-8000),
    repeatCount: DETERMINISTIC_TEST_RUNS,
    race,
  };
}

function goModVersion(content) {
  return String(content || '').match(/^\s*go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1] || '';
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function createDockerGraderScript(taskType = 'bugfix') {
  if (!['bugfix', 'diagnosis'].includes(taskType)) throw new Error(`不支持的 Docker grader 任务类型：${taskType}`);
  return `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
task_type="\${2:-${taskType}}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
task_dir="$(cd "$script_dir/.." && pwd)"
platforms=(linux/arm64 linux/amd64)
go_version="\${GO_PIPELINE_GO_TOOLCHAIN_VERSION:-}"
if [[ -z "$go_version" && -f "$workspace/benzhi.Dockerfile" ]]; then
  # Use awk instead of sed -E: macOS BSD sed rejects the GNU-only
  # non-capturing group (?:...), which previously masked the real grader
  # result as exit=7.
  go_version="$(awk '
    toupper($1) == "FROM" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^golang:[0-9]/) {
          value = $i
          sub(/^golang:/, "", value)
          sub(/@.*/, "", value)
          sub(/[^0-9.].*/, "", value)
          print value
          exit
        }
      }
    }
  ' "$workspace/benzhi.Dockerfile")"
fi
if [[ -z "$go_version" && -f "$workspace/go.mod" ]]; then
  go_version="$(awk '$1 == "go" { print $2; exit }' "$workspace/go.mod")"
fi
if [[ ! "$go_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "cannot determine a valid Go toolchain version from benzhi.Dockerfile or go.mod: \${go_version:-<empty>}" >&2
  echo "FAILURE_CLASS=docker_configuration" >&2
  exit 90
fi
module_fingerprint="$( {
  [[ -f "$workspace/go.mod" ]] && cat "$workspace/go.mod"
  [[ -f "$workspace/go.sum" ]] && cat "$workspace/go.sum"
  [[ -f "$workspace/benzhi.Dockerfile" ]] && cat "$workspace/benzhi.Dockerfile"
} | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
module_fingerprint="\${module_fingerprint:-no-modules}"
image_stem="go-task-grader-go\${go_version}-\${module_fingerprint}"
lock_root="\${GO_PIPELINE_DOCKER_LOCK_ROOT:-$(cd "$task_dir/../../.." && pwd)/docker-cache/locks}"
mkdir -p "$lock_root"
refresh_images="\${REFRESH_GRADER_IMAGES:-0}"

cleanup() {
  :
}
trap cleanup EXIT

if [[ "$task_type" != "bugfix" && "$task_type" != "diagnosis" ]]; then
  echo "unsupported task type: $task_type" >&2
  exit 2
fi
docker version >/dev/null
# Use the dedicated Buildx worker explicitly; plain docker build ignores
# BUILDX_BUILDER and can block every compute-heavy stage on Desktop's frontend.
export BUILDX_BUILDER="\${BUILDX_BUILDER:-benzhi-builder}"

acquire_cache_lock() {
  local lock_dir="$1"
  local waited=0
  local max_wait="\${GRADER_CACHE_LOCK_WAIT_SECONDS:-1800}"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    local owner=""
    if [[ -f "$lock_dir/pid" ]]; then owner="$(<"$lock_dir/pid")"; fi
    if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    if (( waited >= max_wait )); then
      echo "timed out waiting for grader cache lock: $lock_dir" >&2
      return 1
    fi
    sleep 1
    ((waited += 1))
  done
  printf '%s\\n' "$$" >"$lock_dir/pid"
}

release_cache_lock() {
  rm -rf "$1"
}

build_image() {
  local image_reference="$1"
  local platform="$2"
  local platform_tag="\${platform#linux/}"
  local cache_lock="$lock_root/\$image_stem-\$platform_tag.lock"
  cached_matches() {
    local labels
    labels="$(docker image inspect --format '{{ index .Config.Labels "go-task-grader.go_version" }}|{{ index .Config.Labels "go-task-grader.module_sha" }}' "$image_reference" 2>/dev/null || true)"
    [[ "$labels" == "$go_version|$module_fingerprint" ]]
  }
  acquire_cache_lock "$cache_lock" || return $?
  if [[ "$refresh_images" != "1" ]] && docker image inspect "$image_reference" >/dev/null 2>&1 && cached_matches; then
    release_cache_lock "$cache_lock"
    echo "Reusing cached grader image $image_reference ($platform)"
    return 0
  fi
  local build_status=0
  docker buildx build --builder "$BUILDX_BUILDER" --load \\
    --platform "$platform" -f "$workspace/benzhi.Dockerfile" \\
    --label "go-task-grader.go_version=$go_version" \\
    --label "go-task-grader.module_sha=$module_fingerprint" \\
    -t "$image_reference" "$workspace" || build_status=$?
  release_cache_lock "$cache_lock"
  return "$build_status"
}

run_grader() {
  local platform="$1"
  local image_reference="$2"
  local grader_script="$3"
  docker run --rm --network none --platform "$platform" \\
    --cpus ${DOCKER_RUN_CPU_LIMIT} \\
    -e GOTOOLCHAIN=local \\
    -v "$workspace:/workspace:ro" \\
    -v "$script_dir:/grader:ro" \\
    "$image_reference" bash -c "GO_BIN=go /grader/$grader_script /workspace"
}

check_toolchain() {
  local platform="$1"
  local image_reference="$2"
  docker run --rm --network none --platform "$platform" \\
    --cpus ${DOCKER_RUN_CPU_LIMIT} \\
    "$image_reference" bash -c 'command -v go >/dev/null && go version >/dev/null'
}

for platform in "\${platforms[@]}"; do
  platform_tag="\${platform#linux/}"
  image_reference="\${image_stem}-\${platform_tag}:latest"
  echo "=== Docker grader $platform ==="
  if ! build_image "$image_reference" "$platform"; then
    echo "FAILURE_CLASS=docker_build" >&2
    exit 93
  fi
  if ! check_toolchain "$platform" "$image_reference"; then
    echo "FAILURE_CLASS=docker_toolchain" >&2
    exit 90
  fi

  echo "--- run_compile.sh ($platform) ---"
  if ! run_grader "$platform" "$image_reference" run_compile.sh; then
    echo "FAILURE_CLASS=public_compile" >&2
    exit 91
  fi

  echo "--- run_target.sh ($platform) ---"
  if [[ "$task_type" == "diagnosis" ]]; then
    set +e
    run_grader "$platform" "$image_reference" run_target.sh
    target_exit=$?
    set -e
    if [[ "$target_exit" -eq 0 ]]; then
      echo "diagnosis target unexpectedly passed on $platform" >&2
      exit 97
    fi
    echo "diagnosis target reproduced as expected on $platform (exit=$target_exit)"
  else
    if ! run_grader "$platform" "$image_reference" run_target.sh; then
      echo "FAILURE_CLASS=hidden_target" >&2
      exit 92
    fi
  fi

  echo "--- run_full.sh ($platform) ---"
  if ! run_grader "$platform" "$image_reference" run_full.sh; then
    echo "FAILURE_CLASS=public_full" >&2
    exit 94
  fi
  if [[ "$task_type" == "bugfix" ]]; then
    echo "--- run_static.sh ($platform) ---"
    if ! run_grader "$platform" "$image_reference" run_static.sh; then
      echo "FAILURE_CLASS=public_static" >&2
      exit 95
    fi
  fi
done

if [[ "$task_type" == "diagnosis" ]]; then
  diff -qr --exclude='.git' "$task_dir/pristine" "$workspace"
fi
echo "Docker grader passed: task_type=$task_type platforms=linux/arm64,linux/amd64"
`;
}

async function writeGrader(taskDir, goldDir, testFiles, gold, taskType = 'bugfix', concurrency = false) {
  const graderDir = path.join(taskDir, 'grader');
  const goldTestsDir = path.join(graderDir, 'gold-tests');
  await fsp.mkdir(goldTestsDir, { recursive: true });
  for (const filename of testFiles) {
    const destination = path.join(goldTestsDir, filename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(path.join(goldDir, filename), destination);
  }
  await fsp.writeFile(path.join(graderDir, 'test-files.txt'), `${testFiles.join('\n')}\n`, 'utf8');
  await fsp.writeFile(path.join(graderDir, 'namespace.json'), `${JSON.stringify({
    policy: 'isolated-gold-test-name-v1',
    test_name: gold.test_name,
  }, null, 2)}\n`, 'utf8');
  const target = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
script_dir="$(cd "$(dirname "$0")" && pwd)"
go_bin="\${GO_BIN:-go}"
scratch="$(mktemp -d "\${TMPDIR:-/tmp}/go-pipeline-target.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/workspace"
cp -R "$workspace/." "$scratch/workspace/"
while IFS= read -r test_file; do
  [[ -z "$test_file" ]] && continue
  mkdir -p "$scratch/workspace/$(dirname "$test_file")"
  cp "$script_dir/gold-tests/$test_file" "$scratch/workspace/$test_file"
done < "$script_dir/test-files.txt"
cd "$scratch/workspace"
GOTOOLCHAIN=local "$go_bin" test ${concurrency ? '-race ' : ''}${shellSingleQuote(gold.test_package)} -run ${shellSingleQuote(`^${gold.test_name}$`)} -count=${DETERMINISTIC_TEST_RUNS}
`;
  const full = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
MODEL_REPRO=0 GOTOOLCHAIN=local "$go_bin" test ./... -count=1
`;
  const compile = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
GOTOOLCHAIN=local "$go_bin" test ./... -run '^$' -count=1
`;
  const staticScript = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
GOTOOLCHAIN=local "$go_bin" vet ./...
`;
  const dockerScript = createDockerGraderScript(taskType);
  await Promise.all([
    fsp.writeFile(path.join(graderDir, 'run_target.sh'), target, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_compile.sh'), compile, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_full.sh'), full, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_static.sh'), staticScript, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_docker.sh'), dockerScript, { mode: 0o755 }),
  ]);
}

async function writeClaudeOnlyGrader(taskDir, taskType, publicTargetCommand = '', verificationFixture = null) {
  const graderDir = path.join(taskDir, 'grader');
  await fsp.mkdir(graderDir, { recursive: true });
  await fsp.writeFile(path.join(graderDir, 'test-files.txt'), '', 'utf8');
  const target = taskType === 'diagnosis' && publicTargetCommand
    ? `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
cd "$workspace"
GOTOOLCHAIN=local /bin/bash -c ${shellSingleQuote(publicTargetCommand)}
`
    : `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
cd "$workspace"
# The repair Session does not receive verify_cmds or a generated regression
# test. Run a compile-only check here; the post-repair red/green stage builds
# the final command from Claude's submitted repository test.
GOTOOLCHAIN=local go test ./... -run '^$' -count=1
`;
const full = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
MODEL_REPRO=0 GOTOOLCHAIN=local "$go_bin" test ./... -count=1
`;
  const compile = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
GOTOOLCHAIN=local "$go_bin" test ./... -run '^$' -count=1
`;
  const staticScript = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
go_bin="\${GO_BIN:-go}"
cd "$workspace"
GOTOOLCHAIN=local "$go_bin" vet ./...
`;
  await Promise.all([
    fsp.writeFile(path.join(graderDir, 'run_target.sh'), target, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_compile.sh'), compile, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_full.sh'), full, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_static.sh'), staticScript, { mode: 0o755 }),
    fsp.writeFile(path.join(graderDir, 'run_docker.sh'), createDockerGraderScript(taskType), { mode: 0o755 }),
  ]);
}

export function discoveryRootCauseDescriptor(bug = {}) {
  const files = [...new Set((bug.target_files || []).map(String).map((value) => value.trim()).filter(Boolean))];
  const symbols = [...new Set((bug.symbols || []).map(String).map((value) => value.trim()).filter(Boolean))];
  const mechanism = String(bug.failure_mechanism || '').trim();
  if (!isChineseDescription(mechanism)) {
    throw new Error('生成 gold_root_cause 前发现 failure_mechanism 不是中文主体，已阻止打包');
  }
  let rootCause;
  try {
    rootCause = buildGoldRootCause(bug);
  } catch (error) {
    throw new Error(`生成 gold_root_cause 前发现记录不完整：${error.message}`);
  }
  return {
    root_cause_file: files[0] || '',
    root_cause_symbols: symbols,
    failure_mechanism: mechanism,
    mechanism_keywords: [],
    test_package: '',
    test_name: '',
    gold_root_cause: rootCause,
  };
}

function commitUrl(repository, commit) {
  return `${String(repository).replace(/\.git$/i, '').replace(/\/$/, '')}/commit/${commit}`;
}

function withoutTerminalPeriod(value) {
  return String(value || '').trim().replace(/[。.]+$/u, '');
}

export function buildPreparedVerifyResult({ taskType, bug, gold, mainCommit, goldCommit, redGreen }) {
  const problem = withoutTerminalPeriod(bug?.title);
  const base = String(mainCommit || '').slice(0, 12);
  const goldFix = String(goldCommit || '').slice(0, 12);
  const targets = [...(bug?.target_files || []), ...(bug?.symbols || [])].filter(Boolean).join('、') || '目标源码与符号';
  if (taskType === 'diagnosis') {
    return `PASS；问题情况：${problem}。处理过程：出题侧使用临时复现检查 ${targets}，并通过 ${gold?.test_name || '目标回归测试'} 建立确定性对照，全程未改动待交给 Claude 的 pristine/workspace。诊断结论：${withoutTerminalPeriod(gold?.gold_root_cause)}。验证结论：BUG_BASE ${base} 的目标故障稳定复现，Gold ${goldFix} 对照修复通过；任务仅在 Claude 保持 workspace 无改动并通过轨迹校验后才可导出。`;
  }
  return `PASS；问题情况：${problem}。处理过程：出题侧检查 ${targets}，由 Gold 模型新增或更新 ${gold?.test_name || '目标回归测试'} 并完成最小修复。解决情况：修复前 BUG_BASE ${base} 的目标回归 ${DETERMINISTIC_TEST_RUNS}/${DETERMINISTIC_TEST_RUNS} 稳定失败（红，exit=${redGreen?.redExitCode}）；修复后 Gold ${goldFix} 的目标测试 ${DETERMINISTIC_TEST_RUNS}/${DETERMINISTIC_TEST_RUNS} 通过（绿），全量测试和 go vet 通过。验证结论：Gold 红绿对照成立；任务仅在 Claude 独立修复并通过同一套系统验收后才可导出。`;
}

export function numberedModelFixBranch(bugIndex, actor) {
  if (!Number.isInteger(Number(bugIndex)) || Number(bugIndex) < 1 || Number(bugIndex) > 99) throw new Error(`Bug 编号不合法：${bugIndex}`);
  if (!['test', 'gold'].includes(actor)) throw new Error(`修复分支角色不合法：${actor}`);
  return `bug-${String(Number(bugIndex)).padStart(2, '0')}/${actor}_model_fix`;
}

// V3 repositories use the anti-leakage branch layout from the Git guide.
// Legacy V1/V2 tasks continue to use numberedModelFixBranch above.
export function numberedGreenBranch(bugIndex) {
  if (!Number.isInteger(Number(bugIndex)) || Number(bugIndex) < 1 || Number(bugIndex) > 99) throw new Error(`Bug 编号不合法：${bugIndex}`);
  return `bug${Number(bugIndex)}_green`;
}

export function numberedRedBranch(bugIndex) {
  if (!Number.isInteger(Number(bugIndex)) || Number(bugIndex) < 1 || Number(bugIndex) > 99) throw new Error(`Bug 编号不合法：${bugIndex}`);
  return `bug${Number(bugIndex)}_red`;
}

export function numberedBugId(repository, bugIndex) {
  if (!Number.isInteger(Number(bugIndex)) || Number(bugIndex) < 1 || Number(bugIndex) > 99) throw new Error(`Bug 编号不合法：${bugIndex}`);
  const normalizedRepository = String(repository || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const repositoryName = safeSlug(normalizedRepository.split('/').at(-1), '');
  if (!repositoryName) throw new Error('无法从 repository 解析 bug_id 仓库名');
  const deliveryRepositoryName = repositoryName.startsWith('nyh-') ? repositoryName : `nyh-${repositoryName}`;
  return `${deliveryRepositoryName}-bug-${String(Number(bugIndex)).padStart(2, '0')}`;
}

function reproduciblePublicCommand(command, taskType) {
  const value = String(command || '').trim();
  if (!value) return 'GOTOOLCHAIN=local go test ./... -count=1';
  if (/\n|\r|\b(?:docker|git|gh|curl\s+https?:\/\/(?!localhost|127\.0\.0\.1))\b|\/tmp\/|\/private\/tmp\/|\/var\/folders\//i.test(value)) {
    throw new Error(`${taskType} 的公开复现命令不能依赖本地临时路径、Git 或外部网络`);
  }
  if (taskType === 'diagnosis' && /(?:^|[;&|])\s*(?:rm|mv|cp|install|tee|truncate|touch|mkdir|python\d*|perl|ruby|node)\b|(?:^|\s)(?:sed|perl)\s+-i\b|>>?|\|/i.test(value)) {
    throw new Error('diagnosis 的公开复现命令必须只读、直接执行且保留自身退出码，不能写文件、运行临时脚本或使用管道');
  }
  if (taskType === 'diagnosis'
    && /^((?:[A-Z_][A-Z0-9_]*=\S+\s+)*)go\s+test\s+\.\/\.\.\.(?:\s+-[^\s]+)*\s*$/i.test(value)
    && !/\s-run(?:=|\s)/i.test(value)) {
    throw new Error('diagnosis 的公开复现命令不能使用不带 -run 的全量 go test ./...；必须使用可独立复跑的定向命令');
  }
  return taskType === 'diagnosis'
    ? normalizeDiagnosisPublicCommand(value)
    : value.replace(/^GOTOOLCHAIN=local\s+/, '');
}

export function explicitDockerVerifyCmds(identifier, taskType, focusedCommand = '') {
  if (!['bugfix', 'diagnosis'].includes(taskType)) throw new Error(`不支持的任务类型：${taskType}`);
  const imagePrefix = `${safeSlug(identifier, 'go-task')}-grader`;
  const focused = reproduciblePublicCommand(focusedCommand, taskType);
  const commands = [];
  for (const platform of ['linux/arm64', 'linux/amd64']) {
    const architecture = platform.split('/')[1];
    const image = `${imagePrefix}-${architecture}:latest`;
    commands.push(`docker build --platform ${platform} -f benzhi.Dockerfile -t ${image} .`);
    commands.push(`docker run --rm --network none --platform ${platform} --cpus ${DOCKER_RUN_CPU_LIMIT} -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace ${image} bash -c ${shellSingleQuote(`GOTOOLCHAIN=local ${focused}`)}`);
    commands.push(`docker run --rm --network none --platform ${platform} --cpus ${DOCKER_RUN_CPU_LIMIT} -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace ${image} bash -c 'GOTOOLCHAIN=local go test ./... -count=1'`);
    if (taskType === 'bugfix') commands.push(`docker run --rm --network none --platform ${platform} --cpus ${DOCKER_RUN_CPU_LIMIT} -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace ${image} bash -c 'GOTOOLCHAIN=local go vet ./...'`);
  }
  return commands;
}

export function packagedDockerVerifyCmds(identifier, taskType) {
  if (!['bugfix', 'diagnosis'].includes(taskType)) throw new Error(`不支持的任务类型：${taskType}`);
  const imagePrefix = `${safeSlug(identifier, 'go-task')}-grader`;
  const commands = [];
  for (const platform of ['linux/arm64', 'linux/amd64']) {
    const architecture = platform.split('/')[1];
    const image = `${imagePrefix}-${architecture}:latest`;
    // Keep each proof command a single Docker invocation. Nested bash and
    // command substitution make external evidence parsers see fragments
    // instead of the exact public command.
    const dockerRun = (script) => `docker run --rm --network none --platform ${platform} --cpus ${DOCKER_RUN_CPU_LIMIT} -e GO_BIN=go -e GOTOOLCHAIN=local -v "\${PWD}/grader:/grader:ro" ${image} /grader/${script} /app`;
    commands.push(`docker build --platform ${platform} -f workspace/benzhi.Dockerfile -t ${image} workspace`);
    commands.push(dockerRun('run_target.sh'));
    commands.push(dockerRun('run_full.sh'));
    if (taskType === 'bugfix') commands.push(dockerRun('run_static.sh'));
  }
  return commands;
}

export function publicTargetCommandForTask(taskType, gold, publicReproductionCommand = '', concurrency = false) {
  const repeatCount = concurrency ? DETERMINISTIC_TEST_RUNS : 1;
  if (taskType === 'bugfix') return `go test ${concurrency ? '-race ' : ''}${gold.test_package} -run '^${gold.test_name}$' -count=${repeatCount} -v`;
  const command = publicReproductionCommand
    ? reproduciblePublicCommand(publicReproductionCommand, 'diagnosis')
    : `go test ${concurrency ? '-race ' : ''}${gold?.test_package || ''} -run '^${gold?.test_name || ''}$' -count=${repeatCount} -v`;
  const issues = directPublicVerifyCommandIssues([command], 'diagnosis', { concurrency });
  if (issues.length) throw new Error(`diagnosis 的公开复现命令不合格：${issues.join('；')}`);
  return command;
}

export function safeDiagnosisPublicReproductionCommand(command) {
  const candidate = String(command || '').trim();
  if (!candidate) return '';
  try {
    const normalized = reproduciblePublicCommand(candidate, 'diagnosis');
    return directPublicVerifyCommandIssues([normalized], 'diagnosis').length ? '' : normalized;
  } catch {
    return '';
  }
}

export function modelFacingDiagnosisQuery(userQuery, publicTargetCommand = '') {
  const query = String(userQuery || '').trim();
  const command = String(publicTargetCommand || '').trim();
  return command ? `${query}\n\n公开复现命令：${command}` : query;
}

function nativeTrajectoryUserPrompts(content) {
  const prompts = [];
  for (const line of String(content || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'user') continue;
    const messageContent = event?.message?.content;
    const prompt = typeof messageContent === 'string'
      ? messageContent.trim()
      : Array.isArray(messageContent) && messageContent.every((block) => block?.type === 'text')
        ? messageContent.map((block) => String(block?.text || '').trim()).filter(Boolean).join('\n').trim()
        : '';
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

async function restoreImmutableDiagnosisPrompt(taskDir, metadata) {
  const artifactDirectories = ['trajectory', '.repair-checkpoint'];
  let immutableManifestFound = false;
  for (const directoryName of artifactDirectories) {
    const directory = path.join(taskDir, directoryName);
    const manifest = await readJson(path.join(directory, 'runner-manifest.json'), null);
    if (!manifest?.prompt_sha256) continue;
    immutableManifestFound = true;
    const rawFilename = directoryName === 'trajectory'
      && path.basename(String(manifest.raw_filename || '')) === manifest.raw_filename
      ? manifest.raw_filename
      : 'raw.native.jsonl';
    const rawContent = await fsp.readFile(path.join(directory, rawFilename), 'utf8').catch(() => '');
    const prompt = nativeTrajectoryUserPrompts(rawContent)
      .find((candidate) => crypto.createHash('sha256').update(candidate).digest('hex') === manifest.prompt_sha256);
    if (!prompt) continue;
    const promptPath = path.join(taskDir, 'PROMPT.md');
    const currentPrompt = await fsp.readFile(promptPath, 'utf8').catch(() => '');
    const promptChanged = currentPrompt.trim() !== prompt;
    const metadataChanged = String(metadata.user_query || '').trim() !== prompt;
    if (promptChanged) await fsp.writeFile(promptPath, `${prompt}\n`, 'utf8');
    if (metadataChanged) {
      metadata.user_query = prompt;
      await writeJsonAtomic(path.join(taskDir, 'public.json'), metadata);
    }
    return {
      found: true,
      changed: promptChanged || metadataChanged,
      prompt,
    };
  }
  return { found: false, immutableManifestFound, changed: false, prompt: '' };
}

// A task directory can outlive a failed attempt and its task_prepare stage.
// Rebuild the model-facing copy immediately before every Claude retry so an
// older guessed Test* command cannot survive in PROMPT.md/public.json.
export async function sanitizeModelFacingDiagnosisTask(task, bugRecord) {
  if (!task?.taskDir || String(task.taskType || '') !== 'diagnosis') return { sanitized: false };
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath, null);
  if (!metadata || String(metadata.task_type || '') !== 'diagnosis') return { sanitized: false };
  const immutablePrompt = await restoreImmutableDiagnosisPrompt(task.taskDir, metadata);
  if (immutablePrompt.found) {
    return {
      sanitized: true,
      changed: immutablePrompt.changed,
      restoredFromTrajectory: true,
      publicTargetCommand: String(immutablePrompt.prompt).split(/\n\n公开复现命令：/i)[1]?.trim() || '',
    };
  }
  if (immutablePrompt.immutableManifestFound) {
    return { sanitized: false, changed: false, preservedImmutableArtifacts: true };
  }
  const baseQuery = String(bugRecord?.discovery?.user_query || '').trim()
    || String(metadata.user_query || '').split(/\n\n公开复现命令：/i)[0].trim();
  let confirmedCommand = '';
  const candidates = Array.isArray(metadata.verify_cmds)
    ? metadata.verify_cmds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  for (const candidate of candidates) {
    if (directPublicVerifyCommandIssues([candidate], 'diagnosis').length) continue;
    const plan = await existingDiagnosisVerificationPlan(path.join(task.taskDir, 'pristine'), candidate).catch(() => null);
    if (plan) {
      confirmedCommand = candidate;
      break;
    }
  }
  const safeQuery = modelFacingDiagnosisQuery(baseQuery, confirmedCommand);
  const changed = String(metadata.user_query || '').trim() !== safeQuery;
  if (changed) {
    metadata.user_query = safeQuery;
    await writeJsonAtomic(publicPath, metadata);
  }
  await fsp.writeFile(path.join(task.taskDir, 'PROMPT.md'), `${safeQuery}\n`, 'utf8');
  return { sanitized: true, changed, publicTargetCommand: confirmedCommand };
}

async function createTask({ job, jobFile, bugIndex, bug, bugRecord, gold, goldDir, testFiles, verificationFixture, mainCommit, bugBaseCommit, bugBaseDir, goldCommit, generation, redGreen, verificationCoverage }) {
  const taskName = safeSlug(`${job.project.project_slug}-bug${bugIndex}-${bug.bug_id}`);
  const taskDir = path.join(job.tasksRoot, taskName);
  const workflowVersion = Number(job.workflowVersion || 1);
  const claudeOnly = workflowVersion >= CURRENT_WORKFLOW_VERSION;
  const existingTask = await fsp.stat(taskDir).catch(() => null);
  if (existingTask) {
    const existingMetadata = await readJson(path.join(taskDir, 'public.json'), null);
    const belongsToCurrentBug = existingMetadata
      && String(existingMetadata.pipeline_job_id || '') === String(job.id)
      && Number(existingMetadata.bug_index) === Number(bugIndex)
      && Number(existingMetadata.workflow_version || 0) >= CURRENT_WORKFLOW_VERSION;
    if (belongsToCurrentBug) {
      if (job.request.taskType === 'diagnosis' || existingMetadata.task_type === 'diagnosis') {
        await sanitizeModelFacingDiagnosisTask(
          { taskDir, taskType: 'diagnosis' },
          { discovery: bug },
        );
      }
      await appendLog(jobFile, 'info', `复用已完成的任务目录：${taskName}`, `bug${bugIndex}_task_prepare`);
      return { taskName, taskDir, bugId: existingMetadata.bug_id || numberedBugId(job.request.repository, bugIndex), reused: true };
    }
    const archived = await archiveStaleTaskDirectory(job.tasksRoot, taskDir, taskName);
    await appendLog(jobFile, 'warn', `归档不完整或旧流程任务目录：${taskName} -> ${path.relative(job.tasksRoot, archived)}`, `bug${bugIndex}_task_prepare`);
  }
  const normalizedGold = claudeOnly ? discoveryRootCauseDescriptor(bug) : canonicalizeGoldDescriptor(gold);
  const leakage = scanAnswerLeakage(await readWorkspaceEntries(bugBaseDir), { needles: [bug.failure_mechanism, normalizedGold.gold_root_cause, normalizedGold.failure_mechanism] });
  if (!leakage.ok) throw new Error(`BUG_BASE 答案泄露扫描不通过：${leakage.issues.join('；')}`);
  await fsp.mkdir(taskDir, { recursive: true });
  await copyWithoutGit(bugBaseDir, path.join(taskDir, 'pristine'));
  await copyWithoutGit(path.join(taskDir, 'pristine'), path.join(taskDir, 'workspace'));
  const taskType = job.request.taskType;
  const verificationPolicyVersion = Number(job.verificationPolicyVersion || 0);
  const usesVerificationEvidence = verificationPolicyVersion >= VERIFICATION_POLICY_VERSION;
  if (!claudeOnly && usesVerificationEvidence && !testFiles?.length) {
    throw new Error(`${taskType} V5 任务缺少 repository-owned verification_test_files，不能生成依赖 grader 覆盖的证明`);
  }
  if (!claudeOnly && usesVerificationEvidence && taskType === 'diagnosis') {
    // The public regression test is a repository-owned verification asset. It
    // is present before Claude starts so the diagnosis proof can replay from a
    // clean submitted-repository checkout without a grader overlay.
    await overlayTests(goldDir, path.join(taskDir, 'pristine'), testFiles);
    await overlayTests(goldDir, path.join(taskDir, 'workspace'), testFiles);
  }
  const publicReproductionCommand = taskType === 'diagnosis'
    ? safeDiagnosisPublicReproductionCommand(bug.reproduction_command)
    : '';
  // A discovery record may describe a scenario or contain a guessed test
  // name. Do not expose that guess to Claude or let task_prepare retry it
  // forever. Existing public tests remain usable; otherwise the independent
  // post-trajectory diagnosis test author supplies the command later.
  let publicTargetCommand = '';
  if (taskType === 'diagnosis' && publicReproductionCommand) {
    const requestedNames = verificationTestNamesFromCommand(publicReproductionCommand);
    if (!requestedNames.length) {
      publicTargetCommand = publicTargetCommandForTask('diagnosis', normalizedGold, publicReproductionCommand, isConcurrencyBug(bug));
    } else {
      const candidatePlan = await existingDiagnosisVerificationPlan(path.join(taskDir, 'pristine'), publicReproductionCommand).catch(() => null);
      if (candidatePlan) publicTargetCommand = publicTargetCommandForTask('diagnosis', normalizedGold, publicReproductionCommand, isConcurrencyBug(bug));
    }
  }
  if (taskType === 'diagnosis') {
    if (publicTargetCommand) {
      // Diagnosis commands are exported as direct go test/go run commands. If
      // an older model fixture used the internal MODEL_REPRO skip guard, make
      // that guard apply only to the ordinary full-suite check before creating
      // the proof workspace so a bare go test still exercises the Bug.
      await normalizeDiagnosisVerificationTests(path.join(taskDir, 'pristine'), publicTargetCommand);
      await normalizeDiagnosisVerificationTests(path.join(taskDir, 'workspace'), publicTargetCommand);
      if (!claudeOnly) await normalizeDiagnosisVerificationTests(goldDir, publicTargetCommand);
    }
  }
  const diagnosisVerificationPlan = claudeOnly && taskType === 'diagnosis' && publicTargetCommand
    ? await existingDiagnosisVerificationPlan(path.join(taskDir, 'pristine'), publicTargetCommand)
    : null;
  if (claudeOnly) await writeClaudeOnlyGrader(taskDir, taskType, publicTargetCommand, verificationFixture);
  else await writeGrader(taskDir, goldDir, testFiles, normalizedGold, taskType, isConcurrencyBug(bug));
  await writeJsonAtomic(path.join(taskDir, 'grader/v4-context.json'), {
    policy_version: 4,
    task_type: taskType,
    gold_files: bug.target_files,
    gold_symbols: bug.symbols,
    mechanism_keywords: normalizedGold.mechanism_keywords,
    failure_mechanism: bug.failure_mechanism,
    concurrency: isConcurrencyBug(bug),
    gold_test_package: claudeOnly ? '' : normalizedGold.test_package,
    gold_test_name: claudeOnly ? '' : normalizedGold.test_name,
    gold_test_namespace: claudeOnly ? '' : goldTestNamespace(bugIndex, bug.bug_id).prefix,
    public_reproduction_command: publicReproductionCommand,
  });
  const goMod = await fsp.readFile(path.join(taskDir, 'pristine/go.mod'), 'utf8');
  const goVersion = goModVersion(goMod);
  const toolchainVersion = process.env.GO_PIPELINE_GO_TOOLCHAIN_VERSION || '1.25.6';
  const branchSuffix = String(bugIndex);
  const bugSource = bugRecord?.bugSource || 'natural';
  const greenBranch = numberedGreenBranch(bugIndex);
  const redBranch = numberedRedBranch(bugIndex);
  // A discovery candidate may contain a guessed test name.  It is useful to
  // the pipeline as an internal hint while deciding whether a repository
  // owned public command exists, but it is not part of the model-facing
  // report.  Exposing a missing Test* name lets Claude reverse-engineer the
  // verifier instead of independently reading the source.  Only a command
  // confirmed against the pristine repository may be appended to the report.
  const deliveredUserQuery = taskType === 'diagnosis'
    ? modelFacingDiagnosisQuery(bug.user_query, publicTargetCommand)
    : bug.user_query.trim();
  const coverageChecklist = buildVerificationCoverageChecklist({
    userQuery: deliveredUserQuery,
    successCriteria: bug.success_criteria,
  });
  // The acceptance test is written by Codex only after the Claude repair
  // checkpoint. Claude therefore starts with an ordinary G1 tree and no
  // TestModel_ or verify_cmds material.
  const verifyCmds = usesVerificationEvidence
    ? taskType === 'diagnosis' ? (publicTargetCommand ? [publicTargetCommand] : []) : []
    : explicitDockerVerifyCmds(taskName, taskType, publicTargetCommand);
  // Diagnosis may defer verify_cmds until the post-trajectory independent
  // test author has converted a scenario draft into a real repository test.
  const goldVerificationSummary = claudeOnly
    ? ''
    : buildPreparedVerifyResult({ taskType, bug, gold: normalizedGold, mainCommit: bugBaseCommit, goldCommit, redGreen });
  const metadata = {
    sample_id: taskName,
    bug_id: numberedBugId(job.request.repository, bugIndex),
    title: bug.title,
    task_type: taskType,
    task_subtype: bug.task_subtype,
    bug_category: bug.bug_category,
    language: 'Go',
    workflow_version: workflowVersion,
    workflow_policy_version: Number(job.workflowPolicyVersion || 0),
    verification_policy_version: verificationPolicyVersion,
    verification_coverage_policy_version: 0,
    verification_coverage_checklist_policy_version: VERIFICATION_COVERAGE_CHECKLIST_VERSION,
    pipeline_job_id: job.id,
    pipeline_created_at: job.createdAt,
    project_tier: job.project?.quality?.projectTier || job.request.projectTier || '',
    project_quality_policy_version: Number(job.projectQualityPolicyVersion || 0),
    project_package_policy_version: Number(job.projectPackagePolicyVersion || 0),
    project_type: job.project?.project_type || '',
    project_summary: job.project?.project_summary || '',
    production_go_files: Number(job.project?.quality?.productionGoFiles || 0),
    production_go_lines: Number(job.project?.quality?.productionCodeLines || 0),
    bug_quota: Number(job.project?.quality?.bugQuota || 0),
    frontend_required: Boolean(job.request.frontendRequired),
    frontend_present: Boolean(job.project?.quality?.frontend?.present),
    contributor_id: job.request.contributorId || job.request.creator || '',
    bug_policy_version: Number(job.request.bugPolicyVersion || 0),
    production_flow: claudeOnly
      ? 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix'
      : workflowVersion >= PARALLEL_BUG_WORKFLOW_VERSION
        ? 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_dual_fix'
        : 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'claude_code_cli',
    project_generation_provider: generation.provider || projectGeneratorConfig().provider,
    project_generation_session_id: generation.sessionId,
    project_generation_model: generation.model || '',
    bug_discovery_stage: workflowVersion >= PARALLEL_BUG_WORKFLOW_VERSION ? 'before_git_main_publish' : 'in_generated_main_before_trajectory',
    bug_discovery_author: 'codex',
    bug_discovery_id: bugRecord?.bugDiscoveryId || crypto.randomUUID(),
    bug_source: bugSource,
    bug_source_private_to_pipeline: true,
    test_model_git_metadata_available: false,
    test_model_repository_identity_available: false,
    bug_index: bugIndex,
    trajectory_count: 1,
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: job.request.repository,
    clone_url: job.request.cloneUrl,
    main_branch: 'main',
    main_commit: mainCommit,
    main_pushed: true,
    ...(claudeOnly ? {} : {
      bug_main_branch: `bug${branchSuffix}_main`,
      bug_main_commit: mainCommit,
      bug_main_pushed: true,
      bug_main_unchanged: true,
    }),
    bug_base_branch: claudeOnly
      ? taskType === 'diagnosis' ? '' : greenBranch
      : `BUG_BASE${branchSuffix}`,
    bug_base_commit: bugBaseCommit,
    bug_base_parent_commit: claudeOnly ? '' : bugSource === 'injected' ? mainCommit : '',
    ...(claudeOnly && taskType === 'bugfix' ? {
      bug_base_root: true,
      bug_base_source_commit: mainCommit,
      green_branch: greenBranch,
      green_baseline_commit: bugBaseCommit,
      green_baseline_pushed: true,
      red_branch: redBranch,
      red_pushed: false,
      model_input_branch: greenBranch,
      model_input_commit: bugBaseCommit,
      model_input_snapshot: 'single-branch-single-commit-no-tests',
    } : {}),
    ...(claudeOnly && taskType === 'diagnosis' ? {
      bug_base_root: true,
      bug_base_source_commit: mainCommit,
      green_branch: '',
      green_baseline_commit: '',
      green_baseline_pushed: false,
      red_branch: redBranch,
      red_commit: bugBaseCommit,
      red_pushed: true,
      model_input_branch: '',
      model_input_commit: '',
      model_input_snapshot: 'single-branch-single-commit-no-tests',
    } : {}),
    bug_base_pushed: taskType !== 'diagnosis',
    main_unchanged: true,
    test_model_fix_branch: claudeOnly
      ? taskType === 'diagnosis' ? redBranch : greenBranch
      : numberedModelFixBranch(bugIndex, 'test'),
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: bugBaseCommit,
    ...(!claudeOnly ? {
      gold_model_fix_branch: numberedModelFixBranch(bugIndex, 'gold'),
      gold_model_fix_actor: 'codex',
      gold_model_fix_base_commit: bugBaseCommit,
      gold_model_fix_commit: goldCommit,
      gold_model_fix_pushed: true,
      gold_patch: commitUrl(job.request.repository, goldCommit),
    } : {}),
    validation_policy_version: 4,
    trajectory_exporter_version: 'v4.0.0',
    go_version: `go${toolchainVersion}; go.mod go ${goVersion}`,
    go_mod_version: goVersion,
    repro_determinism: 'deterministic',
    workspace: 'workspace',
    user_query_file: 'PROMPT.md',
    user_query: deliveredUserQuery,
    verify_cmds: verifyCmds,
    verification_test_overlay: usesVerificationEvidence
      ? taskType === 'bugfix' ? 'none' : diagnosisVerificationPlan?.verification_test_overlay || 'none'
      : diagnosisVerificationPlan?.verification_test_overlay || 'repository-tests',
    verification_test_files: usesVerificationEvidence
      ? taskType === 'bugfix' ? [] : diagnosisVerificationPlan?.verification_test_files || []
      : (diagnosisVerificationPlan?.verification_test_files || (taskType === 'diagnosis' ? testFiles : verificationCoverage?.testFiles || [])),
    verification_test_names: usesVerificationEvidence
      ? taskType === 'bugfix' ? [] : diagnosisVerificationPlan?.verification_test_names || []
      : (diagnosisVerificationPlan?.verification_test_names || (taskType === 'diagnosis' ? [normalizedGold.test_name] : verificationCoverage?.testNames || [])),
    ...(diagnosisVerificationPlan ? { verification_test_manifest: diagnosisVerificationPlan.verification_test_manifest } : {}),
    ...(taskType === 'diagnosis' ? {
      diagnosis_workspace_policy_version: 1,
      diagnosis_workspace_unchanged: false,
      diagnosis_workspace_check_status: 'pending',
      verification_test_storage: 'system-fixture-only',
    } : {}),
    success_criteria: bug.success_criteria,
    gold_root_cause: normalizedGold.gold_root_cause,
    verify_result: usesVerificationEvidence ? '' : goldVerificationSummary,
    verification_evidence: {},
    gold_verification_summary: goldVerificationSummary,
    harness: claudeOnly
      ? `backend=docker-target; isolation=independent-workspace-without-.git + system-side-public-model-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=claude; go=go${toolchainVersion}; public_target_runs=pending`
      : `backend=docker-target; isolation=independent-workspace-without-.git + read-only-external-hidden-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=claude; go=go${toolchainVersion}; hidden_target_runs=${DETERMINISTIC_TEST_RUNS}/${DETERMINISTIC_TEST_RUNS}`,
    generator_model: '',
    创建人: job.request.creator || 'niuyuhang',
  };
  if (!claudeOnly && legacyVerificationCoverageEnabled(job) && taskType === 'diagnosis') {
    if (!verificationCoverage?.report) throw new Error('诊断任务缺少 verify_cmds 题面完整覆盖复核报告');
    const coverageAttestation = createVerificationCoverageAttestation({
      userQuery: metadata.user_query,
      successCriteria: metadata.success_criteria,
      verifyCmds: metadata.verify_cmds,
      modelTests: verificationCoverage.modelTests,
      report: verificationCoverage.report,
      reviewerSessionId: verificationCoverage.attestation?.reviewer_session_id || '',
      reviewedAt: verificationCoverage.attestation?.reviewed_at || new Date().toISOString(),
    });
    metadata.verification_coverage = coverageAttestation;
    await fsp.writeFile(path.join(taskDir, 'grader/verification-coverage.json'), `${JSON.stringify(verificationCoverage.report, null, 2)}\n`, 'utf8');
    await fsp.writeFile(path.join(taskDir, 'grader/model-test-files.txt'), `${verificationCoverage.testFiles.join('\n')}\n`, 'utf8');
    await fsp.mkdir(path.join(taskDir, 'grader/model-tests'), { recursive: true });
    await Promise.all(verificationCoverage.modelTests.map((entry) => fsp.mkdir(path.dirname(path.join(taskDir, 'grader/model-tests', entry.path)), { recursive: true }).then(() => fsp.writeFile(path.join(taskDir, 'grader/model-tests', entry.path), entry.content, 'utf8'))));
  }
  await writeJsonAtomic(path.join(taskDir, 'public.json'), metadata);
  await fsp.writeFile(path.join(taskDir, 'PROMPT.md'), `${deliveredUserQuery}\n`, 'utf8');
  await writeJsonAtomic(path.join(taskDir, 'grader/verification-coverage-checklist.json'), coverageChecklist);
  await fsp.writeFile(path.join(taskDir, 'VERIFICATION_COVERAGE_CHECKLIST.md'), formatVerificationCoverageChecklist(coverageChecklist), 'utf8');
  await fsp.writeFile(path.join(taskDir, '.trajectory-policy-v4'), 'original-session-events=preserved\ncomplete-conversation=required\nbalanced-tool-events=required\nimmutable-runner-manifest=required\ncontent-quality-review=paused\n', 'utf8');
  if (usesVerificationEvidence) {
    await fsp.writeFile(path.join(taskDir, '.verification-policy-v5'), `main-trajectory=integrity-and-originality-only
verify-cmds=single-direct-go-test-command-for-bugfix-and-diagnosis
verification-test-source=independent-codex-test-author-after-repair
verification-test-overlay=${taskType === 'diagnosis' ? 'private-fixture-after-trajectory' : 'repository-tests'}
diagnosis-workspace=${taskType === 'diagnosis' ? 'immutable-source-and-tests' : 'not-applicable'}
diagnosis-git=${taskType === 'diagnosis' ? 'source-only-no-verification-fixture' : 'not-applicable'}
coverage=user-query-hard-contract-success-criteria-clarification-only
pre-fix=fresh-claude-session-red
post-fix=fresh-claude-session-green-for-bugfix
diagnosis-post-fix=not-required
solution-author=${claudeOnly ? 'claude-only' : 'dual-fix-legacy'}
gold-verification=${claudeOnly ? 'disabled' : 'internal-only'}
`, 'utf8');
  }
  if (!claudeOnly) {
    await fsp.mkdir(path.join(taskDir, 'gold'), { recursive: true });
    await fsp.writeFile(path.join(taskDir, 'gold/gold_root_cause.md'), `${normalizedGold.gold_root_cause}\n`, 'utf8');
    const patchResult = await git(goldDir, ['diff', `${bugBaseCommit}..${goldCommit}`]);
    await fsp.writeFile(path.join(taskDir, 'gold/gold.patch'), patchResult.stdout, 'utf8');
  }
  await appendLog(jobFile, 'success', `已导入任务 ${taskName}`, `bug${bugIndex}_task_prepare`);
  return { taskName, taskDir, bugId: metadata.bug_id };
}

async function exportTrajectoryJson(taskDir) {
  const source = await fsp.readFile(path.join(taskDir, 'trajectory/trajectory.stream.jsonl'), 'utf8');
  const streamEvents = source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const sessionIds = [...new Set(streamEvents.map((event) => event?.session_id).filter(Boolean))];
  if (sessionIds.length !== 1) throw new Error(`轨迹必须包含唯一 session，实际 ${sessionIds.length} 个`);
  const nativeFilename = path.join(taskDir, 'trajectory', `trajectory_${sessionIds[0]}.jsonl`);
  const nativeSource = await fsp.readFile(nativeFilename, 'utf8').catch(() => '');
  if (nativeSource) {
    const events = nativeSource.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const nativeSessionIds = [...new Set(events.map((event) => event?.sessionId || event?.session_id).filter(Boolean))];
    if (nativeSessionIds.length !== 1 || nativeSessionIds[0] !== sessionIds[0]) {
      throw new Error(`Claude 原生轨迹 session 与运行流不一致：${nativeSessionIds.join(', ') || '空'} != ${sessionIds[0]}`);
    }
    return { filename: nativeFilename, events, sessionId: sessionIds[0], format: 'claude-native-jsonl' };
  }

  // Compatibility for an attempt that started before native JSONL export was enabled.
  const filename = path.join(taskDir, 'trajectory', `trajectory_${sessionIds[0]}.json`);
  await fsp.writeFile(filename, `${JSON.stringify(streamEvents, null, 2)}\n`, 'utf8');
  return { filename, events: streamEvents, sessionId: sessionIds[0], format: 'stream-json-array' };
}

function trajectoryModel(events) {
  const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init') || {};
  return init.model || events.find((event) => event?.message?.model)?.message?.model || events.find((event) => event?.model)?.model || 'claude-code-cli';
}

async function updateTaskAfterTrajectory(taskDir, trajectory, validation = null) {
  const publicPath = path.join(taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  metadata.generator_model = trajectoryModel(trajectory.events);
  const verification = validation?.report?.reports?.[0]?.stats?.verification || {};
  const publicCommand = metadata.task_type === 'diagnosis' ? verification.reproductionCommand : verification.focusedCommand;
  if (publicCommand && Number(metadata.verification_policy_version || 0) < VERIFICATION_POLICY_VERSION) {
    metadata.verify_cmds = explicitDockerVerifyCmds(metadata.bug_id || metadata.sample_id, metadata.task_type, publicCommand);
  }
  await writeJsonAtomic(publicPath, metadata);
}

async function finalizeBugfixModelVerification(jobFile, bugIndex, task) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  const concurrency = isConcurrencyBug(bug?.discovery || metadata);
  const commandIssues = directPublicVerifyCommandIssues(metadata.verify_cmds, 'bugfix', { concurrency });
  if (commandIssues.length) throw new Error(`公开模型 verify_cmds 不合格：${commandIssues.join('；')}`);
  const files = Array.isArray(metadata.verification_test_files) ? metadata.verification_test_files : [];
  const modelTests = await readVerificationTestSources(path.join(task.taskDir, 'workspace'), files);
  const planIssues = modelVerificationPlanIssues({
    ...metadata,
    model_verification_policy_version: metadata.model_verification_policy_version,
  }, modelTests, { concurrency });
  if (planIssues.length) throw new Error(`公开模型回归测试与 verify_cmds 不一致：${planIssues.join('；')}`);

  const graderModelRoot = path.join(task.taskDir, 'grader/model-tests');
  await fsp.rm(graderModelRoot, { recursive: true, force: true });
  await fsp.mkdir(graderModelRoot, { recursive: true });
  await fsp.writeFile(path.join(task.taskDir, 'grader/model-test-files.txt'), `${files.join('\n')}\n`, 'utf8');
  await Promise.all(modelTests.map(async (entry) => {
    const destination = path.join(graderModelRoot, entry.path);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, entry.content, 'utf8');
  }));

  // The two independent Claude proof sessions are the authoritative red/green
  // execution. This stage only validates the model-authored command/test plan
  // and prepares the repository-owned test files; running the same command
  // here would add a third execution without adding evidence.
  return { commandCount: metadata.verify_cmds.length, testFiles: files };
}

async function readProofResult(taskDir, phase, manifest) {
  const phaseRoot = path.join(taskDir, 'verification', phase);
  const attempts = await fsp.readdir(phaseRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of attempts.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const manifestPath = path.join(phaseRoot, entry.name, 'manifest.json');
    const candidate = await readJson(manifestPath, null);
    if (candidate?.session_id !== manifest?.session_id) continue;
    return readJson(path.join(phaseRoot, entry.name, 'verification-result.json'), null);
  }
  throw new Error(`${phase} 证明缺少与 manifest 对应的 verification-result.json`);
}

async function finalizeBugfixProofCoverage(jobFile, bugIndex, preManifest, postManifest) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const task = bug?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能完成验证覆盖复核`);
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  const files = Array.isArray(metadata.verification_test_files) ? metadata.verification_test_files : [];
  const modelTests = await readVerificationTestSources(path.join(task.taskDir, 'workspace'), files);
  const coverageReport = await readJson(path.join(task.taskDir, 'grader/verification-coverage.json'), null);
  if (!coverageReport) throw new Error('公开模型回归测试缺少证明前题面覆盖预检报告');
  const [pre, post] = await Promise.all([
    readProofResult(task.taskDir, 'pre_fix', preManifest),
    readProofResult(task.taskDir, 'post_fix', postManifest),
  ]);
  if (pre?.result !== 'red' || post?.result !== 'green') {
    throw new Error(`公开模型红绿证明结果不完整：pre_fix=${pre?.result || '空'}，post_fix=${post?.result || '空'}`);
  }
  const redGreen = {
    command: metadata.verify_cmds,
    pre_fix: pre,
    post_fix: post,
    test_files: files,
    test_names: metadata.verification_test_names,
  };
  const attestation = createVerificationCoverageAttestation({
    userQuery: metadata.user_query,
    successCriteria: metadata.success_criteria,
    verifyCmds: metadata.verify_cmds,
    modelTests,
    report: coverageReport,
    reviewerSessionId: metadata.verification_coverage?.reviewer_session_id || '',
    reviewedAt: metadata.verification_coverage?.reviewed_at || new Date().toISOString(),
  });
  await updatePublicMetadata(task.taskDir, (current) => {
    current.verification_coverage = attestation;
    current.model_verification_pre_fix = { ...pre, result: 'red' };
    current.model_verification_post_fix = { ...post, result: 'green' };
  });
  return { redGreen, coverage: attestation };
}

async function preflightBugfixVerificationCoverage(jobFile, bugIndex) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const task = bug?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能执行 verify_cmds 题面覆盖预检`);
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  const files = Array.isArray(metadata.verification_test_files) ? metadata.verification_test_files : [];
  const modelTests = await readVerificationTestSources(path.join(task.taskDir, 'workspace'), files);
  const fastGate = await readJson(path.join(task.taskDir, 'trajectory/verification-fast-gate.json'), null);
  if (!fastGate?.ok) throw new Error('verify_cmds 题面覆盖预检缺少修复前红、修复后绿的快速执行结果');
  const coverage = await reviewVerificationCoverage(
    jobFile,
    `bug${bugIndex}_verification_coverage`,
    path.join(task.taskDir, 'workspace'),
    bug.discovery,
    metadata.verify_cmds,
    files,
    'bugfix',
    bugIndex,
    {
      command: metadata.verify_cmds,
      fast_gate: fastGate.fast_gate,
      note: '系统快速门禁已执行同一提交仓库测试；独立 Claude 证明 Session 尚未启动。',
    },
    '公开模型回归测试',
  );
  if (!coverage?.report) throw new Error('公开模型回归测试缺少题面覆盖预检报告');
  await updatePublicMetadata(task.taskDir, (current) => {
    current.verification_coverage = coverage.attestation;
    delete current.model_verification_pre_fix;
    delete current.model_verification_post_fix;
  });
  await fsp.writeFile(path.join(task.taskDir, 'grader/verification-coverage.json'), `${JSON.stringify(coverage.report, null, 2)}\n`, 'utf8');
  return { coverage: coverage.attestation, report: coverage.report };
}

async function runBugfixVerificationCoverageIfEnabled(jobFile, job, bugIndex) {
  const stageId = `bug${bugIndex}_verification_coverage`;
  if (!await pipelineHasStage(jobFile, stageId)) return;
  if (verificationCoverageRequired(job)) {
    await runStage(jobFile, stageId, async () => preflightBugfixVerificationCoverage(jobFile, bugIndex));
    return;
  }
  await setStage(jobFile, stageId, 'skipped', {
    reason: '旧 verify_cmds 题面语义覆盖复核已停用；保留 V5 独立红绿证明校验',
  });
}

async function runTrajectoryValidator(task, trajectory) {
  await assertBugfixRepairWorkspace(task);
  const reportPath = path.join(task.taskDir, 'trajectory', `validator-${trajectory.sessionId}.json`);
  const integrity = validateTrajectoryIntegrityEvents(trajectory.events, {
    filename: trajectory.filename,
    taskType: task.taskType,
  });
  if (task.taskType === 'diagnosis') {
    const auditPath = path.join(task.taskDir, 'trajectory', 'mutation-audit.jsonl');
    const auditRecords = parseMutationAudit(await fsp.readFile(auditPath, 'utf8'));
    const readOnly = validateDiagnosisReadOnlyEvents(trajectory.events, {
      workspaceRoot: path.join(task.taskDir, 'workspace'),
      auditRecords,
      requireAudit: true,
    });
    integrity.errors.push(...readOnly.errors);
    integrity.warnings.push(...readOnly.warnings);
    integrity.stats.diagnosisReadOnly = readOnly.stats;
    integrity.ok = integrity.errors.length === 0;
  }
  const report = {
    ok: integrity.ok,
    policy: task.taskType === 'diagnosis' ? 'basic-integrity+diagnosis-read-only' : 'basic-integrity-only',
    reports: [{ file: trajectory.filename, ...integrity, stats: { ...integrity.stats, verification: {} } }],
  };
  await writeJsonAtomic(reportPath, report);
  if (!report.ok) {
    const detail = report.reports[0].errors.map((error) => error.message).join('；');
    throw new Error(`主轨迹基础完整性校验不通过：${detail}`);
  }
  return { report, reportPath };
}

export async function createCurrentQualityReviewBundle({ taskMeta, validationReport, redGreen, trajectoryFilename }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-quality-current-'));
  const copiedTrajectory = path.join(directory, path.extname(trajectoryFilename).toLowerCase() === '.jsonl' ? 'trajectory.jsonl' : 'trajectory.json');
  try {
    const currentValidation = structuredClone(validationReport);
    for (const report of currentValidation?.reports || []) report.file = path.basename(copiedTrajectory);
    await Promise.all([
      writeJsonAtomic(path.join(directory, 'public.json'), taskMeta),
      writeJsonAtomic(path.join(directory, 'validator.json'), currentValidation),
      writeJsonAtomic(path.join(directory, 'red-green.json'), redGreen),
      fsp.copyFile(trajectoryFilename, copiedTrajectory),
    ]);
    return { directory, trajectoryFilename: copiedTrajectory };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function runSolQuality(jobFile, bugIndex, task, trajectory, validation) {
  const taskMeta = await readJson(path.join(task.taskDir, 'public.json'));
  const redGreen = await readJson(path.join(path.dirname(jobFile), `artifacts/bug${bugIndex}-red-green.json`));
  const reviewBundle = await createCurrentQualityReviewBundle({
    taskMeta,
    validationReport: validation.report,
    redGreen,
    trajectoryFilename: trajectory.filename,
  });
  const prompt = [
    'Perform a strictly read-only quality review of this completed benchmark trajectory. Do not modify any file.',
    `Review exactly these four files in the current directory: public.json, validator.json, red-green.json, and ${path.basename(reviewBundle.trajectoryFilename)}. Do not inspect parent, sibling, absolute, history, Gold, grader, or archived-attempt paths.`,
    'This isolated directory contains the single current delivery candidate. Rejected or archived attempts are deliberately excluded and are not submitted trajectories. Evaluate duplicate identity only within this current candidate and its metadata.',
    'Approve only when the V4 deterministic validator passed, the immutable runner manifest is coherent, the trajectory is complete and independent, the task matches exactly one bug and one task type, Gold 20-run red-to-green evidence is coherent, diagnosis contains a reproducible evidence-backed file/symbol/mechanism conclusion with zero code writes, and bugfix shows a reliable pre-fix red result followed by post-fix focused and full success. Treat static validation as supporting evidence when applicable, not as a mandatory final position in one fixed command order.',
    'Reject hidden grader or Gold access by Claude, ungrounded trial-and-error, repeated edit-and-revert cycles, unrelated scope, decisive acceptance commands that mask their exit status, incomplete root cause, duplicate identity, unrecovered permission failures, or missing Git delivery evidence. Do not reject one evidence-based cleanup, a recovered permission denial, an exploratory piped command followed by reliable acceptance commands, or purposeful repeated edits; judge the actual direction of progress and final evidence.',
    'Return JSON matching the supplied schema. Cite concrete file/event evidence for every issue.',
  ].join('\n');
  try {
    return await runCodexJson({
      jobFile,
      stageId: `bug${bugIndex}_sol_quality`,
      cwd: reviewBundle.directory,
      prompt,
      schema: qualitySchema,
      name: `bug${bugIndex}-quality-attempt-${task.attempt}`,
      sandbox: 'read-only',
    });
  } finally {
    await fsp.rm(reviewBundle.directory, { recursive: true, force: true });
  }
}

// A retry may resume a completed internal checkpoint, but a new Claude
// Session must never receive the previous acceptance/error report.  The
// runner emits these exact machine signals on stderr; reduce any caller input
// to one signal before it reaches retry preparation and discard all other
// text.
function reusableCheckpointSignal(value = '') {
  const text = String(value || '');
  if (text.includes('REUSABLE_RED_GREEN_CHECKPOINT=1')) return 'REUSABLE_RED_GREEN_CHECKPOINT=1';
  if (text.includes('REUSABLE_TEST_AUTHOR_CHECKPOINT=1')) return 'REUSABLE_TEST_AUTHOR_CHECKPOINT=1';
  if (text.includes('REUSABLE_REPAIR_CHECKPOINT=1')) return 'REUSABLE_REPAIR_CHECKPOINT=1';
  return '';
}

async function sha256File(filename) {
  return crypto.createHash('sha256').update(await fsp.readFile(filename)).digest('hex');
}

export async function restoreArchivedTrajectoryArtifacts(job, task, bugRecord) {
  const taskName = String(task?.taskName || '');
  const taskDir = String(task?.taskDir || '');
  const trustedSessionIds = new Set((bugRecord?.attempts || [])
    .filter((attempt) => attempt?.status === 'passed' && attempt?.sessionId)
    .map((attempt) => String(attempt.sessionId)));
  if (!taskName || path.basename(taskName) !== taskName || !taskDir || !trustedSessionIds.size) {
    return { restored: false, reason: 'missing_trusted_attempt' };
  }
  const historyRoot = path.join(path.dirname(job.tasksRoot), 'retry-history', taskName);
  const historyEntries = await fsp.readdir(historyRoot, { withFileTypes: true }).catch(() => []);
  const candidates = historyEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(historyRoot, entry.name))
    .sort((left, right) => right.localeCompare(left))
    .flatMap((directory) => [directory, path.join(directory, 'trajectory')]);

  for (const directory of candidates) {
    const manifest = await readJson(path.join(directory, 'runner-manifest.json'), null);
    if (!manifest || !trustedSessionIds.has(String(manifest.session_id || ''))) continue;
    const sessionId = String(manifest.session_id);
    const deliveryName = String(manifest.delivery_filename || '');
    const rawName = String(manifest.raw_filename || '');
    if (!deliveryName || path.basename(deliveryName) !== deliveryName
      || !rawName || path.basename(rawName) !== rawName) continue;
    const required = {
      stream: path.join(directory, 'trajectory.stream.jsonl'),
      delivery: path.join(directory, deliveryName),
      raw: path.join(directory, rawName),
      validator: path.join(directory, `validator-${sessionId}.json`),
      session: path.join(directory, 'session_id.txt'),
    };
    if (!(await Promise.all(Object.values(required).map((filename) => fsp.stat(filename).catch(() => null))))
      .every((value) => value?.isFile())) continue;
    const archivedSessionId = String(await fsp.readFile(required.session, 'utf8')).trim();
    const validator = await readJson(required.validator, null);
    const report = validator?.reports?.find((item) => String(item?.stats?.sessionId || '') === sessionId);
    if (archivedSessionId !== sessionId || validator?.ok !== true || report?.ok !== true) continue;
    const [streamSha, deliverySha, rawSha] = await Promise.all([
      sha256File(required.stream),
      sha256File(required.delivery),
      sha256File(required.raw),
    ]);
    if (streamSha !== manifest.stream_sha256
      || deliverySha !== manifest.delivery_sha256
      || rawSha !== manifest.raw_sha256) continue;
    const auditPath = path.join(directory, 'mutation-audit.jsonl');
    if (manifest.audit_sha256) {
      const audit = await fsp.stat(auditPath).catch(() => null);
      if (!audit?.isFile() || await sha256File(auditPath) !== manifest.audit_sha256) continue;
    }

    const restoreDir = path.join(taskDir, `.trajectory-restore-${process.pid}-${Date.now()}`);
    await fsp.mkdir(restoreDir, { recursive: true });
    const artifactNames = [
      'trajectory.stream.jsonl', deliveryName, rawName, `validator-${sessionId}.json`,
      'session_id.txt', 'runner-manifest.json', 'mutation-audit.jsonl', 'raw.sha256', 'raw.bytes',
    ];
    try {
      for (const name of artifactNames) {
        const source = path.join(directory, name);
        if (await fsp.stat(source).catch(() => null)) await fsp.copyFile(source, path.join(restoreDir, name));
      }
      const trajectoryDir = path.join(taskDir, 'trajectory');
      const existing = await fsp.stat(trajectoryDir).catch(() => null);
      let replacedDir = '';
      if (existing) {
        replacedDir = path.join(historyRoot, `recovery-replaced-${now().replace(/[:.]/g, '-')}`);
        await fsp.rename(trajectoryDir, replacedDir);
      }
      try {
        await fsp.rename(restoreDir, trajectoryDir);
      } catch (error) {
        if (replacedDir) await fsp.rename(replacedDir, trajectoryDir).catch(() => {});
        throw error;
      }
      return {
        restored: true,
        sessionId,
        source: directory,
        streamSha256: streamSha,
        deliverySha256: deliverySha,
        rawSha256: rawSha,
      };
    } finally {
      await fsp.rm(restoreDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { restored: false, reason: 'no_matching_valid_archive' };
}

export async function prepareTrajectoryRetry(job, task, checkpointSignal = '') {
  const stamp = now().replace(/[:.]/g, '-');
  const history = path.join(path.dirname(job.tasksRoot), 'retry-history', task.taskName, `pipeline-retry-${stamp}`);
  await fsp.mkdir(history, { recursive: true });
  const legacyHistory = path.join(task.taskDir, 'history');
  if (await fsp.stat(legacyHistory).catch(() => null)) await fsp.rename(legacyHistory, path.join(history, 'earlier-attempts'));
  // Diagnosis sessions intentionally leave their workspace read-only.  A
  // retry must still be able to archive that attempt before rebuilding from
  // pristine; macOS can reject the directory rename while restrictive ACLs
  // remain on descendants.  Normalize permissions first and fall back to a
  // copy/remove move if the filesystem still rejects rename.
  const moveRetryDirectory = async (source, destination) => {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
      await makeTreeWritable(source);
      try {
        await fsp.rename(source, destination);
        return;
      } catch (retryError) {
        if (!['EACCES', 'EPERM'].includes(retryError?.code)) throw retryError;
      }
    }
    await copyWithoutGit(source, destination);
    await makeTreeWritable(source);
    await fsp.rm(source, { recursive: true, force: true });
  };
  for (const name of ['trajectory', 'workspace']) {
    const source = path.join(task.taskDir, name);
    if (await fsp.stat(source).catch(() => null)) await moveRetryDirectory(source, path.join(history, name));
  }
  const internalRetryState = path.join(history, 'internal-retry-state');
  const signal = reusableCheckpointSignal(checkpointSignal);
  const requestedReuseLevel = /REUSABLE_RED_GREEN_CHECKPOINT=1/.test(signal)
    ? 3
    : (/REUSABLE_TEST_AUTHOR_CHECKPOINT=1/.test(signal)
      ? 2
      : (/REUSABLE_REPAIR_CHECKPOINT=1/.test(signal) ? 1 : 0));
  const checkpointExists = async (name) => Boolean(await fsp.stat(path.join(task.taskDir, name, 'checkpoint.json')).catch(() => null));
  const retryMetadata = await readJson(path.join(task.taskDir, 'public.json'), {});
  const repairCheckpointExists = await checkpointExists('.repair-checkpoint');
  const repairInspection = retryMetadata.task_type === 'bugfix' && repairCheckpointExists
    ? await inspectBugfixRepairWorkspace(
        path.join(task.taskDir, 'pristine'),
        path.join(task.taskDir, '.repair-checkpoint/workspace'),
      ).catch(() => ({ valid: false, changedNonTestFiles: [] }))
    : { valid: true, changedNonTestFiles: [] };
  const repairCheckpointReusable = !repairCheckpointExists || repairInspection.valid;
  const explicitReuseLevel = requestedReuseLevel === 1 && !repairCheckpointReusable ? 0 : requestedReuseLevel;
  // Only the saved checkpoint is durable. Failure details are deliberately
  // ignored so a fresh Claude Session starts from the original user report.
  const inferredReuseLevel = await checkpointExists('.publish-checkpoint')
    ? 4
    : (await checkpointExists('.red-green-checkpoint')
      ? 3
      : (await checkpointExists('.test-author-checkpoint')
        ? 2
        : (repairCheckpointExists && repairCheckpointReusable ? 1 : 0)));
  const missingRepositoryVerificationTest = Number(retryMetadata.workflow_policy_version || 0) >= CURRENT_WORKFLOW_POLICY_VERSION
    && Number(retryMetadata.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION
    && retryMetadata.task_type === 'bugfix'
    && (!Array.isArray(retryMetadata.verification_test_files) || retryMetadata.verification_test_files.length === 0);
  // Some older Bugfix attempts saved a Docker/publish checkpoint before the
  // post-Claude test author existed. That checkpoint can never be published;
  // retain the immutable repair checkpoint and resume at test authoring.
  const reuseLevel = missingRepositoryVerificationTest
    ? Math.min(1, Math.max(explicitReuseLevel, inferredReuseLevel))
    : Math.max(explicitReuseLevel, inferredReuseLevel);
  const retryStateNames = [
    '.coverage-repair-mode', '.coverage-repair-workspace', '.progress-checkpoint',
    '.post-fix-checkpoint',
    ...(reuseLevel >= 4 ? [] : ['.publish-checkpoint']),
    ...(reuseLevel >= 1 ? [] : ['.repair-checkpoint']),
    ...(reuseLevel >= 2 ? [] : ['.test-author-checkpoint']),
    ...(reuseLevel >= 3 ? [] : ['.red-green-checkpoint']),
  ];
  for (const name of retryStateNames) {
    const source = path.join(task.taskDir, name);
    if (!await fsp.stat(source).catch(() => null)) continue;
    await fsp.mkdir(internalRetryState, { recursive: true });
    await fsp.rename(source, path.join(internalRetryState, name));
  }
  await copyWithoutGit(path.join(task.taskDir, 'pristine'), path.join(task.taskDir, 'workspace'));
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = retryMetadata;
  if (reuseLevel >= 4) {
    await fsp.rm(path.join(task.taskDir, '.retry-feedback'), { force: true });
    await fsp.rm(path.join(task.taskDir, 'regeneration-instructions.txt'), { force: true });
    return { reuseLevel };
  }
  for (const field of [
    'test_model_fix_commit', 'test_model_fix_pushed', 'test_model_fix_session_id',
    'green_fix_commit', 'red_commit', 'red_pushed', 'red_test_files',
    'verification_test_author_session_id', 'verification_test_author_files',
    'repo_url', 'trajectory', 'trajectory_uploaded_at',
  ]) delete metadata[field];
  metadata.generator_model = '';
  if (Number(metadata.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION) {
    if (metadata.verification_evidence?.post_fix) delete metadata.verification_evidence.post_fix;
    delete metadata.verify_result;
    const privateFixtureFlow = Number(metadata.workflow_policy_version || 0) >= CURRENT_WORKFLOW_POLICY_VERSION
      && metadata.verification_test_overlay === 'private-fixture';
    if (metadata.task_type === 'bugfix' && !privateFixtureFlow) {
      metadata.verification_evidence = {};
      metadata.verify_cmds = [];
      metadata.verification_test_overlay = 'pending-model-tests';
      metadata.verification_test_files = [];
      metadata.verification_test_names = [];
      metadata.verification_test_manifest = [];
      delete metadata.model_verification_policy_version;
      delete metadata.verification_coverage;
      delete metadata.model_verification_pre_fix;
      delete metadata.model_verification_post_fix;
      await fsp.rm(path.join(task.taskDir, 'grader/model-tests'), { recursive: true, force: true });
      await fsp.rm(path.join(task.taskDir, 'grader/model-test-files.txt'), { force: true });
      await fsp.rm(path.join(task.taskDir, 'grader/verification-coverage.json'), { force: true });
    }
  }
  await writeJsonAtomic(publicPath, metadata);
  // Acceptance failures stay in the pipeline attempt history for operators.
  // Never expose them to a fresh Claude Session: it must diagnose the original
  // user report from pristine source rather than follow system feedback.
  await fsp.rm(path.join(task.taskDir, '.retry-feedback'), { force: true });
  await fsp.rm(path.join(task.taskDir, 'regeneration-instructions.txt'), { force: true });
  const reviewsPath = path.join(path.dirname(job.tasksRoot), 'validation/review_statuses.json');
  const taskId = managedTaskId(task.taskName);
  // The API server and parallel Bug workers both update this file.  Reading
  // before taking the lock lets a stale snapshot overwrite a newer review;
  // perform the complete read/filter/write transaction under the shared lock.
  await withFileLock(`${reviewsPath}.lock`, async () => {
    const reviews = await readJson(reviewsPath, []);
    const filtered = Array.isArray(reviews) ? reviews.filter((record) => record.taskId !== taskId) : [];
    await fsp.mkdir(path.dirname(reviewsPath), { recursive: true });
    const temporary = `${reviewsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');
      await fsp.rename(temporary, reviewsPath);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  });
  return { reuseLevel };
}

export async function persistVerificationManifest(taskDir, phase, manifest, manifestPath) {
  const expectedResult = phase === 'pre_fix' ? 'red' : phase === 'post_fix' ? 'green' : '';
  if (!expectedResult) throw new Error(`不支持的验证证明阶段：${phase || '空'}`);
  if (Number(manifest?.policy_version) !== VERIFICATION_POLICY_VERSION) {
    throw new Error(`${phase} 证明 policy_version 必须为 ${VERIFICATION_POLICY_VERSION}`);
  }
  if (manifest.phase !== phase || manifest.result !== expectedResult || !manifest.session_id) {
    throw new Error(`${phase} 证明阶段、结果或 Session 不完整`);
  }
  if (manifest.command_mode !== 'direct_verify_cmds_v2' || !Number.isInteger(manifest.command_count) || manifest.command_count < 1) {
    throw new Error(`${phase} V5 证明必须使用 direct_verify_cmds_v2 逐条直接执行模式`);
  }

  const publicPath = path.join(taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  const expectedCommit = phase === 'pre_fix' ? metadata.bug_base_commit : metadata.test_model_fix_commit;
  if (!/^[a-f0-9]{40}$/i.test(String(expectedCommit || '')) || manifest.source_commit !== expectedCommit) {
    throw new Error(`${phase} 证明绑定的源码 commit 已失效`);
  }
  const expectedCommandsHash = verificationCommandsSha256(metadata.verify_cmds);
  if (!Array.isArray(metadata.verify_cmds) || !metadata.verify_cmds.length || manifest.verify_cmds_sha256 !== expectedCommandsHash) {
    throw new Error(`${phase} 证明绑定的 verify_cmds 已失效`);
  }
  if (manifest.command_count !== metadata.verify_cmds.length) {
    throw new Error(`${phase} 证明的逐条命令数与 verify_cmds 不一致`);
  }

  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedTaskDir = path.resolve(taskDir);
  if (!resolvedManifestPath.startsWith(`${resolvedTaskDir}${path.sep}`)) {
    throw new Error(`${phase} 证明 manifest 路径越出任务目录`);
  }
  const evidence = {
    session_id: manifest.session_id,
    result: manifest.result,
    command_mode: manifest.command_mode,
    command_count: manifest.command_count,
    source_commit: manifest.source_commit,
    trajectory_sha256: manifest.trajectory_sha256,
    verify_cmds_sha256: manifest.verify_cmds_sha256,
    raw_stream_sha256: manifest.raw_stream_sha256,
    prompt_sha256: manifest.prompt_sha256,
    result_sha256: manifest.result_sha256,
    command_results_sha256: manifest.command_results_sha256,
    local_manifest: path.relative(taskDir, resolvedManifestPath),
  };
  const merged = await updatePublicMetadata(taskDir, (current) => {
    const previous = current.verification_evidence?.[phase] || {};
    const next = { ...evidence };
    if (previous.session_id === next.session_id && previous.trajectory_sha256 === next.trajectory_sha256) {
      if (previous.trajectory_url) next.trajectory_url = previous.trajectory_url;
      if (previous.uploaded_at) next.uploaded_at = previous.uploaded_at;
    }
    current.verification_evidence = {
      ...(current.verification_evidence || {}),
      [phase]: next,
    };
  });
  return merged.verification_evidence[phase];
}

async function latestVerificationManifestPath(taskDir, phase) {
  const phaseDir = path.join(taskDir, 'verification', phase);
  const attempts = (await fsp.readdir(phaseDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.slice(8)) - Number(left.name.slice(8)));
  for (const attempt of attempts) {
    const candidate = path.join(phaseDir, attempt.name, 'manifest.json');
    if (await fsp.stat(candidate).catch(() => null)) return candidate;
  }
  return '';
}

export async function restoreVerificationEvidenceFromManifests(jobFile, bugIndex, taskDir, taskType = 'bugfix') {
  const phases = taskType === 'diagnosis' ? ['pre_fix'] : ['pre_fix', 'post_fix'];
  const restored = [];
  const reset = [];
  for (const phase of phases) {
    const stageId = `bug${bugIndex}_${phase === 'pre_fix' ? 'pre_verify' : 'post_verify'}`;
    const current = await readJson(jobFile);
    const stage = (current.stages || []).find((item) => item.id === stageId);
    if (stage?.status !== 'passed') continue;
    const manifestPath = await latestVerificationManifestPath(taskDir, phase);
    try {
      if (!manifestPath) throw new Error(`${phase} 本地证明 manifest 不存在`);
      const manifest = await readJson(manifestPath);
      const evidence = await persistVerificationManifest(taskDir, phase, manifest, manifestPath);
      await updateJob(jobFile, (job) => {
        const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === Number(bugIndex));
        if (!bug) return;
        bug.verificationEvidence = {
          ...(bug.verificationEvidence || {}),
          [phase]: { ...(stage?.result || {}), ...evidence },
        };
      });
      restored.push(phase);
    } catch (error) {
      const at = now();
      await updateJob(jobFile, (job) => {
        const proofStage = (job.stages || []).find((item) => item.id === stageId);
        if (!proofStage || proofStage.status !== 'passed') return;
        proofStage.resultHistory = [...(proofStage.resultHistory || []), {
          invalidatedAt: at,
          reason: error.message,
          result: proofStage.result || null,
        }].slice(-10);
        proofStage.status = 'pending';
        proofStage.startedAt = null;
        proofStage.finishedAt = null;
        proofStage.error = '';
        proofStage.reason = `本地证明绑定已失效，重新生成 ${phase} 证明`;
        delete proofStage.result;
        const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === Number(bugIndex));
        if (bug?.verificationEvidence) delete bug.verificationEvidence[phase];
      });
      await updatePublicMetadata(taskDir, (metadata) => {
        if (metadata.verification_evidence) delete metadata.verification_evidence[phase];
        delete metadata.verify_result;
      });
      reset.push({ phase, reason: error.message });
    }
  }
  return { restored, reset };
}

const remoteTaskSyncTails = new Map();

function remoteWorkerRequestHeaders(extra = {}) {
  return {
    authorization: `Bearer ${remoteWorkerToken}`,
    'x-go-pipeline-worker-id': remoteWorkerId,
    'x-go-pipeline-worker-protocol': String(DISTRIBUTED_WORKER_PROTOCOL_VERSION),
    'x-go-pipeline-lease-id': remoteWorkerLeaseId,
    ...extra,
  };
}

function assertRemoteWorkerRuntime() {
  if (pipelineExecutionRole !== 'repair-worker') return false;
  if (!remoteWorkerId || !remoteWorkerToken || !remoteWorkerLeaseId) {
    throw new Error('repair-worker 缺少 GO_PIPELINE_WORKER_ID、GO_PIPELINE_WORKER_TOKEN 或远程租约');
  }
  return true;
}

async function pushRemoteJobSnapshot(jobFile = activeJobFile) {
  if (!assertRemoteWorkerRuntime()) return { skipped: true };
  const snapshot = await readJson(jobFile);
  const response = await fetch(`${monitorApiUrl}/api/pipeline/workers/jobs/${encodeURIComponent(snapshot.id)}/snapshot`, {
    method: 'PUT',
    headers: remoteWorkerRequestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      workerId: remoteWorkerId,
      role: 'repair-worker',
      protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
      leaseId: remoteWorkerLeaseId,
      job: snapshot,
    }),
    signal: AbortSignal.timeout(2 * 60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `远程项目快照同步失败（HTTP ${response.status}）`);
    error.code = payload.code || 'REMOTE_SNAPSHOT_FAILED';
    throw error;
  }
  return payload;
}

async function remoteTaskDirForName(taskName) {
  if (!activeJobFile) return '';
  const job = await readJson(activeJobFile, null);
  const task = (job?.bugs || []).find((bug) => bug.task?.taskName === taskName)?.task;
  return String(task?.taskDir || '');
}

async function syncRemoteTaskPackage(taskDir) {
  if (!assertRemoteWorkerRuntime()) return { skipped: true };
  const resolvedTaskDir = path.resolve(taskDir);
  const taskName = path.basename(resolvedTaskDir);
  const previous = remoteTaskSyncTails.get(resolvedTaskDir) || Promise.resolve();
  const operation = previous.then(async () => {
    const job = await readJson(activeJobFile);
    await pushRemoteJobSnapshot(activeJobFile);
    const archiveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-pipeline-remote-task-'));
    const archivePath = path.join(archiveRoot, `${taskName}.tar.gz`);
    try {
      const packed = await runCommand('tar', [
        '-czf', archivePath,
        '--exclude=.verification-cache',
        '--exclude=node_modules',
        '-C', path.dirname(resolvedTaskDir),
        taskName,
      ], { cwd: path.dirname(resolvedTaskDir), timeoutMs: 20 * 60_000 });
      if (packed.exitCode !== 0) throw commandFailure('远程任务包压缩', packed);
      const stat = await fsp.stat(archivePath);
      const response = await fetch(
        `${monitorApiUrl}/api/pipeline/workers/jobs/${encodeURIComponent(job.id)}/tasks/${encodeURIComponent(taskName)}/package`,
        {
          method: 'PUT',
          headers: remoteWorkerRequestHeaders({
            'content-type': 'application/gzip',
            'content-length': String(stat.size),
          }),
          body: fs.createReadStream(archivePath),
          duplex: 'half',
          signal: AbortSignal.timeout(30 * 60_000),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `远程任务包同步失败（HTTP ${response.status}）`);
      return payload;
    } finally {
      await fsp.rm(archiveRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
  const queued = operation.catch(() => {});
  remoteTaskSyncTails.set(resolvedTaskDir, queued);
  try {
    return await operation;
  } finally {
    if (remoteTaskSyncTails.get(resolvedTaskDir) === queued) remoteTaskSyncTails.delete(resolvedTaskDir);
  }
}

async function qualifyTask(job, task, { verificationFinalize = false } = {}) {
  await syncRemoteTaskPackage(task.taskDir);
  const taskId = managedTaskId(task.taskName);
  const bugIndex = Number((job.bugs || []).find((bug) => bug.task?.taskName === task.taskName)?.bugIndex);
  const response = await fetch(`${monitorApiUrl}/api/tasks/review`, {
    method: 'POST',
    headers: remoteWorkerRequestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      tasks: [taskId],
      status: 'qualified',
      source: verificationFinalize ? 'pipeline-verification-finalize' : 'pipeline-integrity-originality',
      ...(verificationFinalize ? { pipelineJobId: job.id, bugIndex } : {}),
    }),
    signal: AbortSignal.timeout(2 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `自动标记主轨迹采集登记失败（HTTP ${response.status}）`);
}

function managedTaskId(taskName) {
  return `task-${crypto.createHash('sha256').update(`go-task-library/${taskName}`).digest('hex').slice(0, 16)}`;
}

async function cleanupVerificationCache(taskDir) {
  const cacheDir = path.join(taskDir, '.verification-cache');
  try {
    await fsp.rm(cacheDir, { recursive: true, force: true });
    return { cleaned: true };
  } catch (error) {
    // Docker may leave root-owned module/build cache files behind. Cleanup is
    // housekeeping after all proof and delivery writes have succeeded; it
    // must not turn a delivered Bug into a false model failure.
    const makeDirectoriesWritable = async (directory) => {
      await fsp.chmod(directory, 0o755).catch(() => {});
      for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await makeDirectoriesWritable(path.join(directory, entry.name));
      }
    };
    await makeDirectoriesWritable(cacheDir).catch(() => {});
    try {
      await fsp.rm(cacheDir, { recursive: true, force: true });
      return { cleaned: true, permissionRetry: true };
    } catch (retryError) {
      return {
        cleaned: false,
        error: retryError instanceof Error ? retryError.message : String(retryError),
        initialError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function uploadQualifiedTrajectory(taskName, { pipelineJobId = '', bugIndex = null } = {}) {
  const remoteTaskDir = await remoteTaskDirForName(taskName);
  if (remoteTaskDir) await syncRemoteTaskPackage(remoteTaskDir);
  const taskId = managedTaskId(taskName);
  const response = await fetch(`${monitorApiUrl}/api/cloud/upload`, {
    method: 'POST',
    headers: remoteWorkerRequestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      tasks: [taskId],
      source: 'pipeline-verification-finalize',
      pipelineJobId,
      bugIndex,
    }),
    signal: AbortSignal.timeout(PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `轨迹云盘上传失败（HTTP ${response.status}）`);
  const uploaded = payload.uploaded?.find((record) => record.taskId === taskId);
  const signedUrl = uploaded?.signedUrl || uploaded?.url || '';
  if (!/^https:\/\//i.test(signedUrl)) throw new Error('轨迹云盘未返回永久 HTTPS 链接');
  return { taskId, signedUrl, skipped: Boolean(uploaded.skipped) };
}

async function submitQualifiedTaskToPlatform(taskName, { pipelineJobId, bugIndex }) {
  const taskId = managedTaskId(taskName);
  const response = await fetch(`${monitorApiUrl}/api/submission-platform/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, pipelineJobId, bugIndex }),
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `提交质检平台失败（HTTP ${response.status}）`);
  return payload.submission || {};
}

async function runVerificationProof(jobFile, bugIndex, phase, sourceDir) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => item.bugIndex === bugIndex);
  const task = bug?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能执行 ${phase} 证明`);
  const preparedInputs = await prepareVerificationProofInputs(task.taskDir, phase, sourceDir);
  const hasDockerCommand = preparedInputs.verifyCmds.some((command) => /^docker\s+/i.test(command));
  const releaseDockerResource = hasDockerCommand
    ? await acquireStageResourceSlot(jobFile, `bug${bugIndex}_docker_validation`, { waitForCapacity: true })
    : async () => {};
  try {
    return await runVerificationProofCore(jobFile, bugIndex, phase, sourceDir, task);
  } finally {
    await releaseDockerResource().catch(() => {});
  }
}

async function runVerificationProofCore(jobFile, bugIndex, phase, sourceDir, task) {
  const expectedResult = phase === 'pre_fix' ? 'red' : 'green';
  const proofRoot = path.join(task.taskDir, 'verification', phase);
  await fsp.mkdir(proofRoot, { recursive: true });
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const outputDir = path.join(proofRoot, `attempt-${attempt}`);
    const existing = await readJson(path.join(outputDir, 'manifest.json'), null);
    if (existing?.result === expectedResult && existing?.session_id) {
      try {
        await persistVerificationManifest(task.taskDir, phase, existing, path.join(outputDir, 'manifest.json'));
        await updateJob(jobFile, (current) => {
          const currentBug = current.bugs.find((item) => item.bugIndex === bugIndex);
          currentBug.verificationEvidence = { ...(currentBug.verificationEvidence || {}), [phase]: existing };
        });
        return existing;
      } catch (error) {
        lastError = error;
        await appendLog(jobFile, 'warn', `${phase} 已有证明不能复用，将创建新 Session：${error.message}`, `bug${bugIndex}_${phase === 'pre_fix' ? 'pre_verify' : 'post_verify'}`);
      }
    }
    if (await fsp.stat(outputDir).catch(() => null)) await archiveDirectory(task.taskDir, outputDir, `bug${bugIndex}-${phase}-attempt-${attempt}`);
    await fsp.mkdir(outputDir, { recursive: true });
    let run;
    const runnerSnapshot = await snapshotRunnerScript(jobFile, verificationRunnerPath, `bug${bugIndex}-${phase}-attempt-${attempt}`);
    try {
      run = await runCommand('/bin/bash', [runnerSnapshot, task.taskDir, phase, sourceDir, outputDir], {
        cwd: monitorRoot,
        env: { GO_PIPELINE_MONITOR_ROOT: monitorRoot },
        stdoutPath: path.join(outputDir, 'runner.stdout.log'),
        stderrPath: path.join(outputDir, 'runner.stderr.log'),
        timeoutMs: 60 * 60 * 1000,
      });
    } finally {
      await fsp.rm(runnerSnapshot, { force: true });
      // Keep task-keyed Docker images available for the next proof/retry.
      // Explicit V5 commands remain authoritative; this only removes an
      // orchestrator-side cleanup that defeated the shared Docker cache.
    }
    if (run.exitCode === 0) {
      const manifest = await readJson(path.join(outputDir, 'manifest.json'));
      if (manifest.result !== expectedResult) throw new Error(`${phase} 证明结果应为 ${expectedResult}，实际为 ${manifest.result}`);
      await persistVerificationManifest(task.taskDir, phase, manifest, path.join(outputDir, 'manifest.json'));
      await updateJob(jobFile, (current) => {
        const currentBug = current.bugs.find((item) => item.bugIndex === bugIndex);
        currentBug.verificationEvidence = { ...(currentBug.verificationEvidence || {}), [phase]: manifest };
      });
      return manifest;
    }
    lastError = commandFailure(`Claude ${phase} 验证证明`, run);
    await appendLog(jobFile, 'warn', `${phase} 证明第 ${attempt}/3 个新 Session 失败：${lastError.message}`, `bug${bugIndex}_${phase === 'pre_fix' ? 'pre_verify' : 'post_verify'}`);
  }
  throw lastError || new Error(`${phase} 验证证明连续 3 次失败`);
}

async function cleanPostFixSource(jobFile, bugIndex) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => item.bugIndex === bugIndex);
  const metadata = await readJson(path.join(bug.task.taskDir, 'public.json'));
  const expectedCommit = String(metadata.test_model_fix_commit || '');
  if (!expectedCommit) throw new Error('test_model_fix_commit 尚未发布，不能执行 post_fix 证明');
  const preparedLayout = await readJson(path.join(bug.task.taskDir, '.git-layout.json'), null);
  if (preparedLayout?.repository && preparedLayout.green_commit === expectedCommit) {
    const preparedRepo = path.resolve(preparedLayout.repository);
    const sourceDir = path.join(path.dirname(jobFile), `post-verify-bug${bugIndex}`);
    await cloneAt(preparedRepo, preparedLayout.green_branch || numberedGreenBranch(bugIndex), sourceDir, path.dirname(jobFile));
    const actualCommit = (await git(sourceDir, ['rev-parse', 'HEAD'])).stdout.trim();
    if (actualCommit !== expectedCommit) throw new Error(`post_fix 本地 G2 提交不一致：${actualCommit} != ${expectedCommit}`);
    await assertCleanGit(sourceDir, 'post_fix 本地 G2 干净克隆');
    return sourceDir;
  }
  const checkpointPath = path.join(bug.task.taskDir, '.post-fix-checkpoint/checkpoint.json');
  const checkpoint = await readJson(checkpointPath, null);
  const sourceDir = path.join(path.dirname(jobFile), `post-verify-bug${bugIndex}`);
  if (checkpoint?.source_commit === expectedCommit) {
    const checkpointWorkspace = path.resolve(String(checkpoint.workspace || ''));
    const taskWorkspace = path.resolve(path.join(bug.task.taskDir, 'workspace'));
    if (checkpointWorkspace === taskWorkspace && await directoryHasFiles(taskWorkspace)) {
      const existingSource = await fsp.stat(sourceDir).catch(() => null);
      if (existingSource) await archiveDirectory(path.dirname(jobFile), sourceDir, `post-verify-bug${bugIndex}-stale`);
      await copyWithoutGit(taskWorkspace, sourceDir);
      await appendLog(jobFile, 'info', `复用已发布的本地 post_fix 检查点（${expectedCommit.slice(0, 12)}），跳过远端 clone`, `bug${bugIndex}_post_verify`);
      return sourceDir;
    }
  }
  const existingCommit = await git(sourceDir, ['rev-parse', 'HEAD'], '读取缓存的 post_fix 提交').then((result) => result.stdout.trim()).catch(() => '');
  if (existingCommit && existingCommit !== expectedCommit) {
    await archiveDirectory(path.dirname(jobFile), sourceDir, `post-verify-bug${bugIndex}-stale`);
  }
  if (!existingCommit || existingCommit !== expectedCommit) {
    await cloneAt(job.request.cloneUrl, metadata.test_model_fix_branch, sourceDir, path.dirname(jobFile));
  }
  const actualCommit = (await git(sourceDir, ['rev-parse', 'HEAD'])).stdout.trim();
  if (actualCommit !== expectedCommit) throw new Error(`post_fix 源码提交不一致：${actualCommit} != ${expectedCommit}`);
  await assertCleanGit(sourceDir, 'post_fix 干净克隆');
  return sourceDir;
}

async function runBugfixProofStages(jobFile, bugIndex, projectDir) {
  const job = await readJson(jobFile);
  const bug = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
  const taskDir = bug?.task?.taskDir;
  if (!taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能执行红绿证明`);
  const metadata = await readJson(path.join(taskDir, 'public.json'));
  const preparedInputs = await prepareVerificationProofInputs(
    taskDir,
    'pre_fix',
    bug.bugBaseDir || projectDir,
  );
  const hasDockerCommand = preparedInputs.verifyCmds.some((command) => /^docker\s+/i.test(command));
  const runPre = () => runStage(jobFile, `bug${bugIndex}_pre_verify`, async () => {
    const latest = await readJson(jobFile);
    const currentBug = latest.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
    return runVerificationProof(jobFile, bugIndex, 'pre_fix', currentBug.bugBaseDir || projectDir);
  });
  const runPost = () => runStage(jobFile, `bug${bugIndex}_post_verify`, async () => {
    const sourceDir = await cleanPostFixSource(jobFile, bugIndex);
    return runVerificationProof(jobFile, bugIndex, 'post_fix', sourceDir);
  });
  // V5 bugfix proofs are direct Go commands and have isolated source/output
  // directories, so they can run concurrently. Keep Docker-backed legacy
  // proofs sequential because either runner may clean shared image names.
  if (hasDockerCommand) {
    const pre = await runPre();
    const post = await runPost();
    return { pre, post };
  }
  const results = await Promise.allSettled([runPre(), runPost()]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return { pre: results[0].value, post: results[1].value };
}

async function uploadVerificationProof(taskName, artifactKind) {
  const remoteTaskDir = await remoteTaskDirForName(taskName);
  if (remoteTaskDir) await syncRemoteTaskPackage(remoteTaskDir);
  const taskId = managedTaskId(taskName);
  const response = await fetch(`${monitorApiUrl}/api/cloud/upload-proof`, {
    method: 'POST',
    headers: remoteWorkerRequestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ taskId, artifactKind }),
    signal: AbortSignal.timeout(PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `${artifactKind} 云盘上传失败（HTTP ${response.status}）`);
  return payload.uploaded;
}

export async function finalizeVerificationResult(taskDir, mainSessionId) {
  if (typeof taskDir !== 'string' || !taskDir.trim()) throw new Error('缺少任务目录，不能回填 verify_result 验证证明');
  const publicPath = path.join(taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  const evidence = metadata.verification_evidence || {};
  const requiredPhases = metadata.task_type === 'diagnosis'
    ? ['pre_fix']
    : metadata.task_type === 'bugfix'
      ? ['pre_fix', 'post_fix']
      : [];
  if (!requiredPhases.length) throw new Error('task_type 必须是 bugfix 或 diagnosis，不能回填 verify_result');
  for (const phase of requiredPhases) {
    const phaseEvidence = evidence[phase];
    // A local manifest is not a deliverable. The proof URL and upload timestamp
    // are written only by /api/cloud/upload-proof after the bundle is verified
    // and uploaded; do not create verify_result before that step completes.
    if (!phaseEvidence?.trajectory_url || !/^https:\/\/[^\s]+\.jsonl?(?:\?[^\s]*)?$/i.test(String(phaseEvidence.trajectory_url)) || !phaseEvidence.uploaded_at) {
      throw new Error(`${phase} 修复证明尚未完成云盘上传，不能生成 verify_result`);
    }
  }
  const proofValue = (phase) => ({
    trajectory_url: evidence[phase]?.trajectory_url,
    session_id: evidence[phase]?.session_id,
    result: evidence[phase]?.result,
  });
  const result = buildVerificationResult({
    taskType: metadata.task_type,
    preFix: proofValue('pre_fix'),
    postFix: metadata.task_type === 'bugfix' ? proofValue('post_fix') : undefined,
  });
  const sessions = [mainSessionId, result.pre_fix.session_id, result.post_fix?.session_id].filter(Boolean);
  if (new Set(sessions).size !== sessions.length) throw new Error('主轨迹、pre_fix 和 post_fix 必须使用互不重复的新 Session');
  metadata.verify_result = JSON.stringify(result);
  await writeJsonAtomic(publicPath, metadata);
  await syncRemoteTaskPackage(taskDir);
  return result;
}

export async function promotePublishedVerificationFixture(taskDir) {
  const publicPath = path.join(taskDir, 'public.json');
  const metadata = await readJson(publicPath);
  if (metadata.verification_test_overlay !== 'private-fixture') return { promoted: false };
  if (metadata.task_type === 'diagnosis') {
    await ensureDiagnosisWorkspaceUnchanged(taskDir, {
      testFile: metadata.verification_test_files?.[0],
      sha256: metadata.verification_fixture_sha256,
    });
    return { promoted: false, external: true };
  }
  if (metadata.verification_fixture_published !== true) {
    throw new Error('私有验证夹具尚未发布到提交仓库，不能切换为 repository-tests');
  }
  const files = Array.isArray(metadata.verification_test_files)
    ? metadata.verification_test_files.map((filename) => String(filename || '').trim()).filter(Boolean)
    : [];
  if (files.length !== 1 || !safeVerificationTestPath(files[0])) {
    throw new Error('已发布私有验证夹具必须声明一个安全的 *_test.go 文件');
  }
  const fixtureDir = path.resolve(String(metadata.verification_fixture_dir || ''));
  const taskRoot = path.resolve(taskDir);
  if (fixtureDir !== taskRoot && !fixtureDir.startsWith(`${taskRoot}${path.sep}`)) {
    throw new Error('已发布私有验证夹具目录越出任务目录');
  }
  const source = path.join(fixtureDir, files[0]);
  const content = await fsp.readFile(source);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (metadata.verification_fixture_sha256 && digest !== metadata.verification_fixture_sha256) {
    throw new Error('已发布私有验证夹具哈希不一致');
  }
  const destination = path.join(taskDir, 'workspace', files[0]);
  await writeFileReplacing(destination, content);
  metadata.verification_test_overlay = 'repository-tests';
  metadata.verification_test_manifest = [{ path: files[0], sha256: digest }];
  metadata.verification_fixture_materialized = true;
  await writeJsonAtomic(publicPath, metadata);
  return { promoted: true, testFile: files[0], sha256: digest };
}

async function recordAttempt(jobFile, bugIndex, value) {
  await updateJob(jobFile, (job) => {
    const bug = job.bugs.find((item) => item.bugIndex === bugIndex);
    bug.attempts = [...(bug.attempts || []), value];
  });
}

async function runTrajectoryCycleCore(jobFile, bugIndex, phaseResources = {}) {
  let initialJob = await readJson(jobFile);
  let bugRecord = initialJob.bugs.find((item) => item.bugIndex === bugIndex);
  const recoveredSystemAttempts = (bugRecord.attempts || []).filter((attempt) => isSystemTrajectoryFailure(attempt?.error));
  if (recoveredSystemAttempts.length) {
    await updateJob(jobFile, (current) => {
      const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
      const attempts = bug.attempts || [];
      const modelAttempts = attempts.filter((attempt) => !isSystemTrajectoryFailure(attempt?.error));
      bug.attempts = modelAttempts.map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
      bug.systemFailures = [
        ...(bug.systemFailures || []),
        ...attempts.filter((attempt) => isSystemTrajectoryFailure(attempt?.error)).map((attempt) => ({
          at: attempt.finishedAt || now(),
          stage: attempt.stage || `bug${bugIndex}_claude_fix`,
          category: classifyTrajectoryAttemptFailure(attempt.error),
          error: attempt.error,
          recoveredFromAttemptBudget: true,
        })),
      ].slice(-10);
    });
    await appendLog(jobFile, 'info', `已将 ${recoveredSystemAttempts.length} 次 Docker/Runner 系统故障移出 Claude 轨迹尝试额度`, `bug${bugIndex}_claude_fix`);
    initialJob = await readJson(jobFile);
    bugRecord = initialJob.bugs.find((item) => item.bugIndex === bugIndex);
  }
  const task = { ...bugRecord.task, taskType: initialJob.request.taskType };
  await sanitizeModelFacingDiagnosisTask(task, bugRecord);
  if (bugRecord.trajectoryDisposition === 'skipped_pending_verification') {
    return {
      skipped: true,
      bugIndex,
      reason: bugRecord.trajectorySkipReason || `轨迹累计 ${MAX_BUG_TRAJECTORY_ATTEMPTS} 次仍未完成采集登记`,
    };
  }
  const qualityStage = initialJob.stages.find((stage) => stage.id === `bug${bugIndex}_sol_quality`);
  const qualityStageStatus = qualityStage ? qualityStage.status : 'skipped';
  const trajectoryStageStatus = initialJob.stages.find((stage) => stage.id === `bug${bugIndex}_trajectory_validate`)?.status;
  const trajectoryStream = path.join(task.taskDir, 'trajectory/trajectory.stream.jsonl');
  if (trajectoryStageStatus === 'passed'
    && (bugRecord.attempts || []).some((attempt) => attempt?.status === 'passed')
    && !await fsp.stat(trajectoryStream).catch(() => null)) {
    const recovery = await restoreArchivedTrajectoryArtifacts(initialJob, task, bugRecord);
    if (recovery.restored) {
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        bug.trajectoryRecoveryHistory = [...(bug.trajectoryRecoveryHistory || []), {
          recoveredAt: now(),
          sessionId: recovery.sessionId,
          source: recovery.source,
          streamSha256: recovery.streamSha256,
          deliverySha256: recovery.deliverySha256,
          rawSha256: recovery.rawSha256,
        }].slice(-10);
      });
      await appendLog(jobFile, 'success', `Bug ${bugIndex} 已从可信归档恢复主轨迹 ${recovery.sessionId}，未重新运行 Claude`, `bug${bugIndex}_trajectory_validate`);
    }
  }
  // A stale stream can survive a failed attempt or a manual reset. It is only
  // a reusable delivery artifact after the trajectory validation stage and a
  // corresponding model attempt both completed successfully. Otherwise the
  // runner must launch Claude again so it cannot skip repair and fail later in
  // the independent proof phase (for example with an empty verify_cmds).
  const reusableTrajectory = trajectoryStageStatus === 'passed'
    && (bugRecord.attempts || []).some((attempt) => attempt?.status === 'passed');
  if (reusableTrajectory && ['passed', 'skipped'].includes(qualityStageStatus)
    && await fsp.stat(trajectoryStream).catch(() => null)) {
    const trajectory = await exportTrajectoryJson(task.taskDir);
    const validation = await runTrajectoryValidator(task, trajectory);
    await updateTaskAfterTrajectory(task.taskDir, trajectory, validation);
    await setStage(jobFile, `bug${bugIndex}_trajectory_validate`, 'passed', {
      sessionId: trajectory.sessionId,
      reportPath: validation.reportPath,
      reused: true,
    });
    return { taskId: managedTaskId(task.taskName), taskName: task.taskName, sessionId: trajectory.sessionId, trajectory: trajectory.filename };
  }
  if (reusableTrajectory && await fsp.stat(trajectoryStream).catch(() => null)) {
    try {
      const trajectory = await exportTrajectoryJson(task.taskDir);
      const validation = await runTrajectoryValidator(task, trajectory);
      await updateTaskAfterTrajectory(task.taskDir, trajectory, validation);
      await setStage(jobFile, `bug${bugIndex}_trajectory_validate`, 'passed', { sessionId: trajectory.sessionId, reportPath: validation.reportPath, reused: true });
      if (qualityStage) {
        await setStage(jobFile, `bug${bugIndex}_sol_quality`, 'skipped', { summary: '新规则暂停轨迹内容质检', policy: 'capture-only-no-trajectory-audit' });
      }
      await appendLog(jobFile, 'success', `Bug ${bugIndex} 已登记现有主轨迹，未重新运行 Claude`, `bug${bugIndex}_trajectory_validate`);
      return { taskId: managedTaskId(task.taskName), taskName: task.taskName, sessionId: trajectory.sessionId, trajectory: trajectory.filename };
    } catch (error) {
      await appendLog(jobFile, 'warn', `Bug ${bugIndex} 现有轨迹无法复用：${error.message}`, `bug${bugIndex}_trajectory_validate`);
    }
  }
  const attemptOffset = countedBugTrajectoryAttempts(bugRecord);
  const remainingAttempts = remainingBugTrajectoryAttempts(bugRecord);
  const skipExhaustedBug = async () => {
    const reason = `轨迹累计 ${MAX_BUG_TRAJECTORY_ATTEMPTS} 次仍未完成采集登记，已自动跳过并继续下一个 Bug`;
    // Keep the Bug pending until independent verification evidence has been
    // uploaded and finalized. Marking it skipped here would make the outer
    // pipeline bypass cloud_upload/verification_finalize forever.
    await updateJob(jobFile, (current) => markPipelineTrajectorySkippedPendingVerification(current, bugIndex, reason, now()));
    await appendLog(jobFile, 'warn', `${reason}；先完成可用的独立验证证明`, `bug${bugIndex}_trajectory_validate`);
    return { skipped: true, bugIndex, reason };
  };
  if (remainingAttempts === 0) return skipExhaustedBug();
  if (attemptOffset > 0) {
    const retryPreparation = await prepareTrajectoryRetry(initialJob, task);
    const resumeLabel = retryPreparation?.reuseLevel >= 4
      ? 'Git 发布'
      : retryPreparation?.reuseLevel === 3
        ? 'Docker'
        : retryPreparation?.reuseLevel === 2
          ? '红绿验证'
          : retryPreparation?.reuseLevel === 1
            ? '独立测试编写'
            : 'Claude 修复';
    await appendLog(jobFile, 'warn', `Bug ${bugIndex} 流水线重新启动，将从${resumeLabel}阶段继续`, `bug${bugIndex}_claude_fix`);
  }
  for (let localAttempt = 1; localAttempt <= remainingAttempts; localAttempt += 1) {
    const attempt = attemptOffset + localAttempt;
    task.attempt = attempt;
    let failedStage = '';
    const attemptStartedAt = now();
    await updateJob(jobFile, (current) => {
      const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
      const nextBug = beginBugAttempt(bug, {
        attempt,
        stage: `bug${bugIndex}_claude_fix`,
        action: attempt > 1 ? 'automatic_retry' : 'manual_start',
        startedAt: attemptStartedAt,
      });
      Object.assign(bug, nextBug);
      const execution = normalizeBugExecution(current.bugExecution);
      current.bugExecution = {
        ...execution,
        selectedBugIndex: bugIndex,
        status: 'fast_lane_running',
        currentAttempt: attempt,
        currentStage: `bug${bugIndex}_claude_fix`,
        startedAt: execution.startedAt || attemptStartedAt,
        updatedAt: attemptStartedAt,
        lastHeartbeatAt: attemptStartedAt,
      };
      bug.workerExecution = {
        ...(bug.workerExecution || {}),
        status: 'fast_lane_running',
        currentAttempt: attempt,
        currentStage: `bug${bugIndex}_claude_fix`,
        startedAt: bug.workerExecution?.startedAt || attemptStartedAt,
        updatedAt: attemptStartedAt,
        lastHeartbeatAt: attemptStartedAt,
        blockedReason: '',
      };
    });
    try {
      const claudeStage = `bug${bugIndex}_claude_fix`;
      failedStage = claudeStage;
      await setStage(jobFile, claudeStage, 'running', { attempt });
      await appendLog(jobFile, 'info', `Claude 修复尝试（累计 ${attempt}/${MAX_BUG_TRAJECTORY_ATTEMPTS}）`, claudeStage);
      const runnerSnapshot = await snapshotRunnerScript(jobFile, taskRunnerPath, `bug${bugIndex}-claude-attempt-${attempt}`);
      let run;
      try {
        run = await runCommand('/bin/bash', [runnerSnapshot, task.taskDir], {
          cwd: monitorRoot,
          env: {
            GO_PIPELINE_MONITOR_ROOT: monitorRoot,
            GO_PIPELINE_PHASE_RESOURCE_HANDSHAKE: '1',
            GO_PIPELINE_REPAIR_ONLY: '1',
            GO_PIPELINE_BUGFIX_MODEL: bugfixModel(),
            CLAUDE_EFFORT: bugfixEffort(attempt),
            ANTHROPIC_MODEL: bugfixModel(),
            ANTHROPIC_DEFAULT_OPUS_MODEL: bugfixModel(),
            ANTHROPIC_DEFAULT_SONNET_MODEL: bugfixModel(),
            ANTHROPIC_DEFAULT_HAIKU_MODEL: bugfixModel(),
          },
          unsetEnv: [
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_API_KEY',
            'CLAUDE_CODE_SUBAGENT_MODEL',
          ],
          stdoutPath: path.join(task.taskDir, `pipeline-claude-attempt-${attempt}.stdout.log`),
          stderrPath: path.join(task.taskDir, `pipeline-claude-attempt-${attempt}.stderr.log`),
          timeoutMs: CLAUDE_FIX_TIMEOUT_MS,
          idleTimeoutMs: CLAUDE_FIX_IDLE_TIMEOUT_MS,
          progressPaths: [path.join(task.taskDir, '.claude-progress.json')],
          activityPaths: [path.join(task.taskDir, '.claude-activity.json')],
          initialProgressGraceMs: CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS,
          progressTimeoutMs: CLAUDE_FIX_PROGRESS_TIMEOUT_MS,
          phaseRequestPath: path.join(task.taskDir, '.runner-phase-request.json'),
          phaseAdmissionPath: path.join(task.taskDir, '.runner-phase-admission.json'),
          phaseObservationPath: path.join(task.taskDir, '.runner-phase-observation.json'),
          onPhaseRequest: phaseResources.onPhaseRequest,
          onPhaseObservation: phaseResources.onPhaseObservation,
          onActivityObservation: phaseResources.onActivityObservation,
        });
      } finally {
        await fsp.rm(runnerSnapshot, { force: true });
      }
      if (run.exitCode !== 0) throw commandFailure('Claude 修复', run);
      const trajectoryCapturePath = path.join(task.taskDir, 'trajectory/trajectory.stream.jsonl');
      const trajectoryCapture = await fsp.stat(trajectoryCapturePath).catch(() => null);
      if (!trajectoryCapture?.isFile()) {
        throw new Error(`ENOENT: Claude runner exited successfully without required trajectory capture '${trajectoryCapturePath}'`);
      }
      await setStage(jobFile, claudeStage, 'passed', { attempt });

      const validationStage = `bug${bugIndex}_trajectory_validate`;
      failedStage = validationStage;
      await setStage(jobFile, validationStage, 'running', { attempt });
      const trajectory = await exportTrajectoryJson(task.taskDir);
      const validation = await runTrajectoryValidator(task, trajectory);
      await updateTaskAfterTrajectory(task.taskDir, trajectory, validation);
      await setStage(jobFile, validationStage, 'passed', { attempt, sessionId: trajectory.sessionId, reportPath: validation.reportPath });
      const qualityStage = `bug${bugIndex}_sol_quality`;
      if (await pipelineHasStage(jobFile, qualityStage)) {
        await setStage(jobFile, qualityStage, 'skipped', { attempt, summary: '新规则不执行额外轨迹内容质检', policy: 'basic-integrity-only' });
      }
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        Object.assign(bug, finishBugAttempt(bug, {
          status: 'passed',
          stage: validationStage,
          sessionId: trajectory.sessionId,
          action: attempt > 1 ? 'automatic_retry' : 'manual_start',
        }, now()));
        bug.workerExecution = {
          ...(bug.workerExecution || {}),
          status: 'fast_lane_running',
          currentAttempt: 0,
          currentStage: validationStage,
          updatedAt: now(),
          lastHeartbeatAt: now(),
        };
        const execution = normalizeBugExecution(current.bugExecution);
        current.bugExecution = { ...execution, status: 'fast_lane_running', currentAttempt: 0, currentStage: validationStage, updatedAt: now(), lastHeartbeatAt: now() };
      });
      await appendLog(jobFile, 'success', `Bug ${bugIndex} 主轨迹已完成采集登记`, validationStage);
      return { taskId: managedTaskId(task.taskName), taskName: task.taskName, sessionId: trajectory.sessionId, trajectory: trajectory.filename };
    } catch (error) {
      const latest = await readJson(jobFile);
      failedStage ||= (latest.stages || []).find((stage) => Number(stage.bugIndex) === bugIndex
        && ['running', 'failed'].includes(stage.status))?.id || `bug${bugIndex}_claude_fix`;
      const feedback = error.message;
      if (isSystemTrajectoryFailure(feedback)) {
        const failureCategory = classifyTrajectoryAttemptFailure(feedback);
        const publicationCheckpointFailure = failureCategory === 'git_infrastructure'
          && /FAILURE_CLASS=git_publication|validated checkpoint Git publication failed|(?:green_branch|red_branch|test_model_fix_branch) must be bug/i.test(feedback);
        const systemMessage = publicationCheckpointFailure
          ? `[system:${failureCategory}] Git 发布失败，已保留验证通过的修复检查点；本次不计入 Claude ${MAX_BUG_TRAJECTORY_ATTEMPTS} 次轨迹额度，重试时仅继续发布：${feedback}`
          : `[system:${failureCategory}] 系统侧验收失败，本次不计入 Claude ${MAX_BUG_TRAJECTORY_ATTEMPTS} 次轨迹额度：${feedback}`;
        const attemptSessionId = String(await fsp.readFile(path.join(task.taskDir, 'trajectory/session_id.txt'), 'utf8').catch(() => '')).trim();
        await setStage(jobFile, failedStage, 'failed', { attempt, error: systemMessage, failureCategory });
        await updateJob(jobFile, (current) => {
          const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
          Object.assign(bug, finishBugAttempt(bug, {
            status: 'failed',
            stage: failedStage,
            sessionId: attemptSessionId,
            failureCategory,
            error: systemMessage,
            action: attempt > 1 ? 'automatic_retry' : 'manual_start',
          }, now()));
          bug.systemFailures = [...(bug.systemFailures || []), {
            at: now(),
            stage: failedStage,
            category: failureCategory,
            error: feedback,
          }].slice(-10);
          bug.workerExecution = {
            ...(bug.workerExecution || {}),
            status: 'fast_lane_failed',
            currentAttempt: 0,
            currentStage: failedStage,
            updatedAt: now(),
            lastHeartbeatAt: now(),
          };
        });
        await appendLog(jobFile, 'error', systemMessage, failedStage);
        if (publicationCheckpointFailure) throw new Error(systemMessage);
        await prepareTrajectoryRetry(latest, task, reusableCheckpointSignal(feedback));
        throw new Error(systemMessage);
      }
      await setStage(jobFile, failedStage, 'failed', { attempt, error: feedback });
      const attemptSessionId = String(await fsp.readFile(path.join(task.taskDir, 'trajectory/session_id.txt'), 'utf8').catch(() => '')).trim();
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        Object.assign(bug, finishBugAttempt(bug, {
          status: 'failed',
          stage: failedStage,
          sessionId: attemptSessionId,
          error: feedback,
          action: attempt > 1 ? 'automatic_retry' : 'manual_start',
        }, now()));
        bug.workerExecution = {
          ...(bug.workerExecution || {}),
          status: 'fast_lane_failed',
          currentAttempt: 0,
          currentStage: failedStage,
          updatedAt: now(),
          lastHeartbeatAt: now(),
        };
        const execution = normalizeBugExecution(current.bugExecution);
        current.bugExecution = { ...execution, status: 'fast_lane_failed', currentAttempt: 0, currentStage: failedStage, updatedAt: now(), lastHeartbeatAt: now() };
      });
      if (attempt >= MAX_BUG_TRAJECTORY_ATTEMPTS) return skipExhaustedBug();
      await appendLog(
        jobFile,
        'warn',
        `Bug ${bugIndex} 累计第 ${attempt} 次轨迹失败，将从 pristine 创建新 workspace 和新 Session`,
        failedStage,
      );
      await prepareTrajectoryRetry(latest, task, reusableCheckpointSignal(feedback));
      for (const suffix of ['pre_verify', 'claude_fix', 'trajectory_validate', 'sol_quality', 'post_verify', 'verification_coverage', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready']) {
        const stageId = `bug${bugIndex}_${suffix}`;
        if (await pipelineHasStage(jobFile, stageId)) {
          await setStage(jobFile, stageId, 'pending', { error: '', attempt: attempt + 1 });
        }
      }
    }
  }
}

async function runTrajectoryCycle(jobFile, bugIndex) {
  const job = await readJson(jobFile);
  const cycleStages = new Set([
    `bug${bugIndex}_claude_fix`,
    `bug${bugIndex}_trajectory_validate`,
    `bug${bugIndex}_sol_quality`,
  ]);
  const stageId = Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION
    ? (job.stages || []).find((stage) => cycleStages.has(stage.id) && !['passed', 'skipped'].includes(stage.status))?.id
      || `bug${bugIndex}_claude_fix`
    : nextPipelineStage(job);
  if (!cycleStages.has(stageId)) return runTrajectoryCycleCore(jobFile, bugIndex);
  await assertSchedulerAdmission(jobFile, stageId);
  await assertStagePrerequisites(jobFile, stageId);
  const concurrent = Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION;
  let releaseResource = await acquireStageResourceSlot(jobFile, stageId, { waitForCapacity: concurrent });
  let resourceStageId = stageId;
  const phaseStageId = (phase) => {
    const prefix = `bug${bugIndex}_`;
    if (phase === 'independent_test_authoring') return `${prefix}test_author`;
    if (phase === 'red_green_validation') return `${prefix}red_green`;
    if (phase === 'docker_validation') return `${prefix}docker_validation`;
    if (phase === 'git_publication') return `${prefix}git_publication`;
    return stageId;
  };
  const recordSubphase = async (phase, nextStageId = resourceStageId) => {
    await updateJob(jobFile, (current) => {
      const bug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
      if (bug) bug.workerExecution = {
        ...(bug.workerExecution || {}),
        subphase: phase,
        resourceStage: nextStageId,
        updatedAt: now(),
        lastHeartbeatAt: now(),
      };
      const execution = normalizeBugExecution(current.bugExecution);
      if (execution.selectedBugIndex === bugIndex) current.bugExecution = {
        ...execution,
        subphase: phase,
        resourceStage: nextStageId,
        updatedAt: now(),
        lastHeartbeatAt: now(),
      };
    });
  };
  let lastActivityHeartbeatMs = 0;
  const recordActivityHeartbeat = async () => {
    const observedAtMs = Date.now();
    if (observedAtMs - lastActivityHeartbeatMs < 10_000) return;
    lastActivityHeartbeatMs = observedAtMs;
    const heartbeatAt = now();
    await updateJob(jobFile, (current) => {
      const bug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
      if (bug) bug.workerExecution = {
        ...(bug.workerExecution || {}),
        updatedAt: heartbeatAt,
        lastHeartbeatAt: heartbeatAt,
      };
      const execution = normalizeBugExecution(current.bugExecution);
      if (execution.selectedBugIndex === bugIndex) current.bugExecution = {
        ...execution,
        updatedAt: heartbeatAt,
        lastHeartbeatAt: heartbeatAt,
      };
    });
  };
  const switchPhaseResource = async (request) => {
    const phase = String(request?.phase || '');
    const nextStageId = phaseStageId(phase);
    const currentProfile = pipelineStageResourceProfile(resourceStageId);
    const nextProfile = pipelineStageResourceProfile(nextStageId);
    if (currentProfile.pool !== nextProfile.pool) {
      await releaseResource().catch(() => {});
      releaseResource = nextProfile.pool
        ? await acquireStageResourceSlot(jobFile, nextStageId, { waitForCapacity: true })
        : async () => {};
    }
    resourceStageId = nextStageId;
    await recordSubphase(phase, nextStageId);
    await appendLog(jobFile, 'info', `Bug ${bugIndex} 进入${currentStageLabel(nextStageId)}`, stageId);
  };
  try {
    const result = await runTrajectoryCycleCore(jobFile, bugIndex, {
      onPhaseRequest: switchPhaseResource,
      onPhaseObservation: async (observation) => recordSubphase(String(observation?.phase || '')),
      onActivityObservation: recordActivityHeartbeat,
    });
    await clearSchedulerAdmission(jobFile, stageId);
    return result;
  } catch (error) {
    if (error?.code !== 'PIPELINE_RESOURCE_WAIT') await clearSchedulerAdmission(jobFile, stageId, { release: !concurrent });
    throw error;
  } finally {
    await releaseResource().catch(() => {});
  }
}

// Continue a V3 Bugfix after Codex has frozen the post-Claude test and local
// G2/R1 layout. The Claude runner resumes its immutable repair checkpoint,
// performs Docker validation, and publishes the already-frozen commits; it
// does not start another repair Session.
async function runPostClaudeDelivery(jobFile, bugIndex, { releaseResource = async () => {} } = {}) {
  const job = await readJson(jobFile);
  const task = job.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
  if (!task?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，不能继续 Docker/Git 发布`);
  const publicMetadata = await readJson(path.join(task.taskDir, 'public.json'));
  const expectedSessionId = String(publicMetadata.test_model_fix_session_id || '');
  const checkpointRoots = ['.publish-checkpoint', '.repair-checkpoint'];
  let hasReusableCheckpoint = false;
  for (const checkpointName of checkpointRoots) {
    const checkpointRoot = path.join(task.taskDir, checkpointName);
    const checkpoint = await readJson(path.join(checkpointRoot, 'checkpoint.json'), null);
    if (!checkpoint || String(checkpoint.session_id || '') !== expectedSessionId) continue;
    const requiredPaths = [
      path.join(checkpointRoot, 'workspace'),
      path.join(checkpointRoot, 'trajectory.stream.jsonl'),
      path.join(checkpointRoot, 'raw.native.jsonl'),
      path.join(checkpointRoot, 'trajectory.jsonl'),
      path.join(checkpointRoot, 'runner-manifest.json'),
      path.join(checkpointRoot, 'mutation-audit.jsonl'),
    ];
    const requiredStats = await Promise.all(requiredPaths.map((filename) => fsp.stat(filename).catch(() => null)));
    if (requiredStats[0]?.isDirectory() && requiredStats.slice(1).every((value) => value?.isFile())) {
      hasReusableCheckpoint = true;
      break;
    }
  }
  if (!expectedSessionId || !hasReusableCheckpoint) {
    throw new Error(`[system:repair_checkpoint] Bug ${bugIndex} 缺少与修复 Session 绑定的可信发布检查点，已阻止重复运行 Claude`);
  }
  const stageId = `bug${bugIndex}_docker_validation`;
  await assertSchedulerAdmission(jobFile, stageId);
  const runnerSnapshot = await snapshotRunnerScript(jobFile, taskRunnerPath, `bug${bugIndex}-post-claude-delivery`);
  try {
    const run = await runCommand('/bin/bash', [runnerSnapshot, task.taskDir], {
      cwd: monitorRoot,
      env: {
        GO_PIPELINE_MONITOR_ROOT: monitorRoot,
        // runStage owns the Docker slot. The phase handshake releases that
        // slot before network-only Git publication starts.
        GO_PIPELINE_PHASE_RESOURCE_HANDSHAKE: '1',
        GO_PIPELINE_REPAIR_ONLY: '0',
        GO_PIPELINE_BUGFIX_MODEL: bugfixModel(),
        CLAUDE_EFFORT: bugfixEffort(1),
        ANTHROPIC_MODEL: bugfixModel(),
        ANTHROPIC_DEFAULT_OPUS_MODEL: bugfixModel(),
        ANTHROPIC_DEFAULT_SONNET_MODEL: bugfixModel(),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: bugfixModel(),
      },
      unsetEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SUBAGENT_MODEL'],
      stdoutPath: path.join(task.taskDir, 'pipeline-post-claude-delivery.stdout.log'),
      stderrPath: path.join(task.taskDir, 'pipeline-post-claude-delivery.stderr.log'),
      timeoutMs: CLAUDE_FIX_TIMEOUT_MS,
      idleTimeoutMs: CLAUDE_FIX_IDLE_TIMEOUT_MS,
      progressPaths: [path.join(task.taskDir, '.claude-progress.json')],
      activityPaths: [path.join(task.taskDir, '.claude-activity.json')],
      initialProgressGraceMs: CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS,
      progressTimeoutMs: CLAUDE_FIX_PROGRESS_TIMEOUT_MS,
      phaseRequestPath: path.join(task.taskDir, '.runner-phase-request.json'),
      phaseAdmissionPath: path.join(task.taskDir, '.runner-phase-admission.json'),
      phaseObservationPath: path.join(task.taskDir, '.runner-phase-observation.json'),
      onPhaseRequest: async (request) => {
        if (String(request?.phase || '') !== 'git_publication') return;
        await releaseResource();
        await setStage(jobFile, stageId, 'passed', { dockerCompleted: true });
        await setStage(jobFile, `bug${bugIndex}_git_publication`, 'running');
        await appendLog(jobFile, 'info', `Bug ${bugIndex} Docker 验证完成，释放 compute-docker 后开始 Git 发布`, `bug${bugIndex}_git_publication`);
      },
      onPhaseObservation: async () => {},
    });
    if (run.exitCode !== 0) throw commandFailure('Claude 后 Docker/Git 发布', run);
    await setStage(jobFile, `bug${bugIndex}_git_publication`, 'passed', { resumed: true });
    return { resumed: true };
  } finally {
    await fsp.rm(runnerSnapshot, { force: true });
  }
}

async function previousProjectContext(jobFile) {
  const jobsRoot = path.dirname(path.dirname(jobFile));
  const currentDir = path.dirname(jobFile);
  const summaries = [];
  for (const entry of await fsp.readdir(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || path.join(jobsRoot, entry.name) === currentDir) continue;
    const previous = await readJson(path.join(jobsRoot, entry.name, 'job.json'), null);
    if (previous?.project) {
      summaries.push({
        slug: previous.project.project_slug,
        title: previous.project.title,
      });
    }
  }
  return summaries.slice(-30);
}

function assertDistinctBugSelection(job, bugIndex, candidate) {
  const duplicate = (job.bugs || []).find((item) => item.bugIndex !== bugIndex
    && item.discovery?.found !== false
    && (item.discovery?.bug_id === candidate.bug_id
      || (JSON.stringify(item.discovery?.target_files || []) === JSON.stringify(candidate.target_files || [])
        && JSON.stringify(item.discovery?.symbols || []) === JSON.stringify(candidate.symbols || [])
        && item.discovery?.failure_mechanism === candidate.failure_mechanism)));
  if (duplicate) throw new Error(`Bug ${bugIndex} duplicates bug ${duplicate.bugIndex}; every slot must describe a distinct failure`);
}

async function prepareV2BugSourcesPass(jobFile, projectDir) {
  let job = await readJson(jobFile);
  const jobDir = path.dirname(jobFile);
  let naturalBatch = job.naturalBugBatch || null;
  let injectionPlan = job.injectionPlan || null;
  const sourcePreparations = [];
  if (Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION) {
    const firstPendingDiscovery = job.stages.find((stage) => stage.stage === 'bug_discovery'
      && !['passed', 'skipped'].includes(stage.status));
    if (firstPendingDiscovery) {
      let releaseBatchResource = async () => {};
      let batchStageStarted = false;
      try {
        await updateJob(jobFile, (current) => {
          current.currentStage = firstPendingDiscovery.id;
          current.error = '';
        });
        await assertSchedulerAdmission(jobFile, firstPendingDiscovery.id);
        await assertStagePrerequisites(jobFile, firstPendingDiscovery.id);
        releaseBatchResource = await acquireStageResourceSlot(jobFile, firstPendingDiscovery.id);
        await setStage(jobFile, firstPendingDiscovery.id, 'running', { phase: 'candidate_batch' });
        batchStageStarted = true;
        naturalBatch = await ensureNaturalBugBatch(jobFile, projectDir);
      } catch (error) {
        if (error?.code === 'PIPELINE_NATURAL_BUG_SEARCH_WAIT') {
          await updateJob(jobFile, (current) => {
            const stage = (current.stages || []).find((item) => item.id === firstPendingDiscovery.id);
            if (stage) {
              stage.status = 'pending';
              stage.startedAt = null;
              stage.finishedAt = null;
              stage.error = '';
              stage.reason = error.message;
              delete stage.result;
            }
            current.status = 'waiting_review';
            current.currentStage = firstPendingDiscovery.id;
            current.error = error.message;
            current.finishedAt = null;
            current.runnerPid = null;
            current.schedulerLease = null;
            current.waitingResource = null;
          });
        }
        if (batchStageStarted
          && error?.code !== 'PIPELINE_RESOURCE_WAIT'
          && error?.code !== 'PIPELINE_NATURAL_BUG_FINDER_FAILURE'
          && error?.code !== 'PIPELINE_NATURAL_BUG_SEARCH_WAIT') {
          await setStage(jobFile, firstPendingDiscovery.id, 'failed', { error: error.message }).catch(() => {});
        }
        throw error;
      } finally {
        await releaseBatchResource().catch(() => {});
      }
    }
    // A natural-only recovery deliberately stops when the candidate pool is
    // empty. Do not create or consume a controlled injection plan on this
    // pass; the existing project and any retained Bug BASEs remain intact.
    injectionPlan = isNaturalBugOnlyJob(await readJson(jobFile))
      ? null
      : await ensureInjectionPlan(jobFile, projectDir, naturalBatch);
    job = await readJson(jobFile);
    for (const bugIndex of Array.from({ length: Number(job.request.bugCount || 0) }, (_, index) => index + 1)) {
      if (await naturalBugBatchAssignment(jobFile, bugIndex)) continue;
      if (isNaturalBugOnlyJob(await readJson(jobFile))) continue;
      const discoveryStage = `bug${bugIndex}_bug_discovery`;
      const stage = job.stages.find((item) => item.id === discoveryStage);
      if (!stage || ['passed', 'skipped'].includes(stage.status)) continue;
      const planned = await injectionPlanAssignment(jobFile, bugIndex);
      if (!planned?.candidate) continue;
      const reason = `项目级自然 Bug 批量搜索已结束，槽位 ${bugIndex} 直接转入一次性注入规划`;
      await runStage(jobFile, discoveryStage, async () => {
        await updateJob(jobFile, (current) => {
          current.bugs ||= [];
          const existing = current.bugs.find((item) => Number(item.bugIndex) === bugIndex);
          const value = {
            bugIndex,
            discovery: { found: false, reason, user_query: '' },
            naturalDiscovery: { found: false, reason },
            discoverySessionId: '',
            bugDiscoveryId: existing?.bugDiscoveryId || crypto.randomUUID(),
            attempts: existing?.attempts || [],
            bugSource: 'injected',
          };
          if (existing) Object.assign(existing, value);
          else current.bugs.push(value);
        });
        return { found: false, injectedFallback: true, reason };
      });
    }
  }
  for (let bugIndex = 1; bugIndex <= job.request.bugCount; bugIndex += 1) {
    const discoveryStage = `bug${bugIndex}_bug_discovery`;
    const currentJob = await readJson(jobFile);
    const currentDiscoveryStage = currentJob.stages.find((item) => item.id === discoveryStage);
    if (currentDiscoveryStage?.status === 'skipped') continue;
    const batchAssignment = naturalBatch ? await naturalBugBatchAssignment(jobFile, bugIndex) : null;
    if (isNaturalBugOnlyJob(currentJob) && !batchAssignment
      && !['passed', 'skipped'].includes(currentDiscoveryStage?.status)) continue;
    const injectionFallback = Boolean(!isNaturalBugOnlyJob(await readJson(jobFile))
      && naturalBatch
      && currentDiscoveryStage
      && !['passed', 'skipped'].includes(currentDiscoveryStage.status)
      && !batchAssignment);
    if (injectionFallback) {
      const reason = `项目级批量搜索与复核批准 ${naturalBatch.selected || 0} 个自然 Bug，剩余槽位转入受控注入并经过同等难度复核`;
      await runStage(jobFile, discoveryStage, async () => {
        await updateJob(jobFile, (current) => {
          current.bugs ||= [];
          const existing = current.bugs.find((item) => Number(item.bugIndex) === bugIndex);
          const value = {
            bugIndex,
            discovery: { found: false, reason, user_query: '' },
            naturalDiscovery: { found: false, reason },
            discoverySessionId: '',
            bugDiscoveryId: existing?.bugDiscoveryId || crypto.randomUUID(),
            attempts: existing?.attempts || [],
            bugSource: 'injected',
          };
          if (existing) Object.assign(existing, value);
          else current.bugs.push(value);
        });
        return { found: false, injectedFallback: true, reason };
      });
      await appendLog(jobFile, 'info', `Bug ${bugIndex} 自然候选不足，进入受控注入：${reason}`, discoveryStage);
    }
    if (injectionFallback) {
      // The source-preparation stage below owns the injected BUG_BASE and
      // must run even though the natural candidate pool had no assignment.
    }
    await runStage(jobFile, discoveryStage, async () => {
      job = await readJson(jobFile);
      if (batchAssignment) {
        validateDiscoveredBug(batchAssignment.candidate, job.request.taskType, {
          ...job.request,
          previousUserQueries: (job.bugs || []).map((item) => item.discovery?.user_query).filter(Boolean),
        });
        assertDistinctBugSelection(job, bugIndex, batchAssignment.candidate);
        await updateJob(jobFile, (current) => {
          current.bugs ||= [];
          const existing = current.bugs.find((item) => item.bugIndex === bugIndex);
          const value = {
            bugIndex,
            discovery: batchAssignment.candidate,
            naturalDiscovery: batchAssignment.candidate,
            discoverySessionId: batchAssignment.finderSessionId,
            bugDiscoveryId: existing?.bugDiscoveryId || crypto.randomUUID(),
            attempts: existing?.attempts || [],
            batchDiscovery: {
              version: NATURAL_BUG_BATCH_VERSION,
              key: naturalBatch.key,
              finder: batchAssignment.finder,
              reviewSessionId: naturalBatch.reviewSessionId,
              reviewScore: batchAssignment.reviewScore,
            },
          };
          if (existing) Object.assign(existing, value);
          else current.bugs.push(value);
        });
        await appendLog(jobFile, 'info', `从项目级候选池分配 Bug ${bugIndex}：${batchAssignment.candidate.bug_id}`, discoveryStage);
        return {
          found: true,
          reason: batchAssignment.candidate.reason || '',
          bugId: batchAssignment.candidate.bug_id,
          sessionId: batchAssignment.finderSessionId,
          batch: true,
        };
      }
      if (Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION && injectionPlan) {
        const planned = await injectionPlanAssignment(jobFile, bugIndex);
        if (!planned?.candidate) throw new Error(`Bug ${bugIndex} 缺少批量自然候选或批量注入规划`);
        return { found: false, injectedFallback: true, reason: '使用项目级批量注入规划' };
      }
      const analysisDir = path.join(jobDir, `analysis-bug${bugIndex}`);
      await cloneAt(projectDir, 'main', analysisDir, jobDir);
      const previousBugs = (job.bugs || []).filter((item) => item.bugIndex !== bugIndex && item.discovery?.found !== false);
      const filePolicy = validateRootCauseFileConcentration(previousBugs, { totalBugCount: job.request.bugCount });
      const enforceDifficulty = Number(job.request.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION;
      const enforceQueryAuthorship = Number(job.request.bugPolicyVersion || 0) >= BUG_QUERY_POLICY_VERSION;
      const prompt = [
        'Independently inspect this locally generated Go project and find at most one additional existing, deterministic, reasonably scoped bug. Do not inject a bug, edit files, commit, or inspect any solution artifact.',
        `This is bug slot ${bugIndex} of at most ${job.request.bugCount}. Avoid every previously selected bug below.`,
        'The generated main has only been frozen locally and has not been published to the delivery Git remote. If diligent inspection cannot find a distinct qualifying bug, return found=false with a concrete reason; a separate private stage may then prepare a benchmark baseline.',
        `The requested trajectory type is ${job.request.taskType}. For diagnosis, keep the task read-only; for bugfix, describe the affected behavior and desired retained behavior. The user_query is an initial draft and does not need a natural request to qualify the technical Bug. A human will edit and confirm the final wording after BUG_BASE preparation.`,
        bugTaxonomyInstruction(job.request.taskType, job.request),
        ...(enforceDifficulty ? [bugDifficultyPolicyText()] : []),
        ...(enforceQueryAuthorship ? [userQueryAuthoringPolicyText()] : []),
        `No root-cause file may account for more than 30% of this project's Bug records. Current single-target file counts are ${JSON.stringify(filePolicy.counts)}; the per-file ceiling is ${Number.isFinite(filePolicy.limit) ? filePolicy.limit : 'not-applicable'}. Prefer a materially different root-cause file when a file has reached the ceiling.`,
        bugNarrativeLanguageInstruction(),
        'The user_query must describe the real business situation, trigger path, and observed output/error/log/state/value difference when known. It will be edited and confirmed by a human after BUG_BASE preparation, so a missing natural request is not a technical discovery failure. Never pad to a fixed length or reveal a solution, patch, root-cause file/symbol, hidden test, commit hash, or exact code change.',
        job.request.taskType === 'diagnosis'
          ? 'For a diagnosis Bug, describe one existing public read-only command or focused observable scenario when available. Do not execute it or require a non-zero result during discovery; the final pre_fix red proof is generated later with an isolated verifier overlay. The eventual command must not create files or scripts, use temporary paths, pipes, redirects, Git, hidden tests, or external network access. Finish with a clean Git worktree.'
          : 'Use temporary files outside the repository for discovery when needed and finish with a clean Git worktree.',
        `Previous selected bugs:\n${JSON.stringify(previousBugs.map((item) => item.discovery), null, 2)}`,
        'Return only the requested structured result. Set found=true only for a complete qualifying Bug record.',
      ].join('\n\n');
      const artifactName = `bug${bugIndex}-discovery`;
      let result = await reusableCodexJson(jobFile, artifactName);
      if (result) {
        try {
          validateDiscoveredBug(structuredClone(result.output), job.request.taskType, {
            ...job.request,
            previousUserQueries: previousBugs.map((item) => item.discovery?.user_query).filter(Boolean),
          });
          await appendLog(jobFile, 'info', `复用已完成的 Bug ${bugIndex} 技术定位，仅将 user_query 转交人工确认`, discoveryStage);
        } catch {
          result = null;
        }
      }
      result ||= await runCodexJson({ jobFile, stageId: discoveryStage, cwd: analysisDir, prompt, schema: bugSchemaForPolicy(job.request.bugPolicyVersion), name: artifactName, sandbox: 'workspace-write' });
      await assertCleanGit(analysisDir, 'Sol natural bug discovery');
      let found = false;
      try {
        found = validateDiscoveredBug(result.output, job.request.taskType, {
          ...job.request,
          previousUserQueries: previousBugs.map((item) => item.discovery?.user_query).filter(Boolean),
        });
      } catch (error) {
        if (!enforceDifficulty || !String(error.message || '').includes('Bug 难度门禁未通过')) throw error;
        result.output.reason = `现有自然 Bug 未采用：${error.message}`;
        await appendLog(jobFile, 'info', result.output.reason, discoveryStage);
      }
      if (found) assertDistinctBugSelection(job, bugIndex, result.output);
      if (found && enforceDifficulty && !result.reused) {
        const review = await reviewNaturalBugDifficulty(jobFile, discoveryStage, analysisDir, result.output, bugIndex);
        if (!review.output.approved) {
          const detail = review.output.issues.map((issue) => `${issue.code}: ${issue.message} (${issue.evidence})`).join('; ') || review.output.summary;
          found = false;
          result.output.reason = `现有自然 Bug 未采用：难度语义复核不通过：${detail}`;
          await appendLog(jobFile, 'info', result.output.reason, discoveryStage);
        }
      }
      if (found && Number(job.request.bugPolicyVersion || 0) >= BUG_TAXONOMY_POLICY_VERSION) {
        const concentration = validateRootCauseFileConcentration([...previousBugs, { bugIndex, discovery: result.output }], { totalBugCount: job.request.bugCount });
        if (!concentration.ok) {
          found = false;
          result.output.reason = `现有自然 Bug 未采用：${concentration.issues.join('；')}`;
          await appendLog(jobFile, 'info', result.output.reason, discoveryStage);
        }
      }
      await updateJob(jobFile, (current) => {
        current.bugs ||= [];
        const existing = current.bugs.find((item) => item.bugIndex === bugIndex);
        const value = {
          bugIndex,
          discovery: found ? result.output : { ...result.output, found: false },
          naturalDiscovery: result.output,
          discoverySessionId: result.sessionId,
          bugDiscoveryId: existing?.bugDiscoveryId || crypto.randomUUID(),
          attempts: existing?.attempts || [],
        };
        if (existing) Object.assign(existing, value);
        else current.bugs.push(value);
      });
      return { found, reason: result.output.reason || '', bugId: result.output.bug_id || '', sessionId: result.sessionId };
    });

    const sourceStage = `bug${bugIndex}_bug_source_prepare`;
    const currentSourceStage = (await readJson(jobFile)).stages.find((item) => item.id === sourceStage);
    if (['passed', 'skipped'].includes(currentSourceStage?.status)) continue;
    const plannedSource = injectionPlan ? await injectionPlanAssignment(jobFile, bugIndex) : null;
    if (isNaturalBugOnlyJob(await readJson(jobFile)) && !batchAssignment) continue;
    sourcePreparations.push({
      bugIndex,
      plannedCandidate: plannedSource?.candidate || null,
      run: async () => runStage(jobFile, sourceStage, async () => {
      const sourceJob = await readJson(jobFile);
      const bugRecord = sourceJob.bugs.find((item) => item.bugIndex === bugIndex);
      if (!bugRecord) throw new Error(`Missing bug selection record for slot ${bugIndex}`);
      const bugBaseDir = path.join(jobDir, `bug-base-bug${bugIndex}`);
      await cloneAt(projectDir, 'main', bugBaseDir, jobDir);
      // Bugfix tasks expose an orphan green G1 baseline. Diagnosis tasks do
      // not modify code and therefore keep their private BUG_BASE worktree
      // local until the publisher creates the sole orphan red R1 branch.
      const v3OrphanGit = Number(sourceJob.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION
        && sourceJob.request.taskType !== 'diagnosis';
      if (v3OrphanGit) {
        await createOrphanGreenSnapshot(bugBaseDir, sourceJob.mainCommit, bugIndex);
      } else {
        await git(bugBaseDir, ['switch', '-c', `BUG_BASE${bugIndex}`]);
      }

      if (bugRecord.discovery?.found === true) {
        let bugBaseCommit;
        if (v3OrphanGit) {
          await git(bugBaseDir, ['add', '-A'], '提交 green 基座文件');
          await git(bugBaseDir, ['-c', 'user.name=Go Pipeline', '-c', 'user.email=go-pipeline@local.invalid', 'commit', '-m', 'init: generated project snapshot'], '提交 green G1 基座');
          bugBaseCommit = (await git(bugBaseDir, ['rev-parse', 'HEAD'])).stdout.trim();
          const parents = (await git(bugBaseDir, ['rev-list', '--parents', '-n', '1', bugBaseCommit])).stdout.trim().split(/\s+/).filter(Boolean);
          if (parents.length !== 1) throw new Error('V3 green G1 必须是无父提交的 orphan 根提交');
        } else {
          bugBaseCommit = (await git(bugBaseDir, ['rev-parse', 'HEAD'])).stdout.trim();
          if (bugBaseCommit !== sourceJob.mainCommit) throw new Error('Natural bug BUG_BASE must equal the frozen main commit');
        }
        await updateJob(jobFile, (current) => {
          const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
          Object.assign(bug, {
            bugSource: 'natural',
            bugBaseCommit,
            bugBaseDir,
            ...(v3OrphanGit ? { greenBranch: numberedGreenBranch(bugIndex), greenBaselineCommit: bugBaseCommit } : {}),
          });
        });
        return { bugSource: 'natural', bugBaseCommit, changedFiles: [] };
      }

      const planned = plannedSource;
      if (!planned?.candidate) throw new Error(`Bug ${bugIndex} 缺少项目级批量注入规划，禁止重新进入逐条找 Bug`);
      const previousBugs = (sourceJob.bugs || []).filter((item) => item.bugIndex !== bugIndex && item.discovery?.found === true);
      const filePolicy = validateRootCauseFileConcentration(previousBugs, { totalBugCount: sourceJob.request.bugCount });
      const enforceDifficulty = Number(sourceJob.request.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION;
      const enforceQueryAuthorship = Number(sourceJob.request.bugPolicyVersion || 0) >= BUG_QUERY_POLICY_VERSION;
      const prompt = [
        'Apply exactly the approved Bug record below to this untouched generated main snapshot. Do not search for or substitute a different Bug.',
        'Before editing, inspect every approved target symbol and compare its current source behavior with the proposed mutation. The current baseline must enforce the correct retained invariant and the edit must create a real production diff. If the faulty behavior or an equivalent weakened invariant is already present, or the proposed edit would be a no-op, do not edit anything: return found=false and begin reason with BASELINE_ALREADY_DEFECTIVE. Never report an existing baseline defect or a zero-diff workspace as a successful controlled injection.',
        'Make the smallest change appropriate to the selected behavior. The change may involve Go source, configuration, dependencies, Docker, or build scripts, and may add a production file when the behavior genuinely requires it. Do not modify tests, weaken assertions, touch hidden acceptance or model-instruction files, or include unrelated rewrites.',
        'Do not run Git commands or create commits. Do not add TODO, FIXME, BUG, benchmark, intentional-fault, or other comments or names that reveal the planted behavior or its repair. Never make the mutation conditional on test fixtures, clock or concrete types, environment variables, build tags, runtime callers, or other test-versus-production discriminators to evade retained tests.',
        'The defect must be exposed by one new focused regression test that a separate verifier stage can add, and the eventual fix should be local rather than a rewrite. The candidate confirmation stage runs project-wide checks once after the mutation is selected.',
        `The requested trajectory type is ${sourceJob.request.taskType}. Return the same complete Bug record with found=true after applying and checking its planned mutation. Do not broaden or rewrite user_query to describe a different failure.`,
        bugTaxonomyInstruction(sourceJob.request.taskType, sourceJob.request),
        ...(enforceDifficulty ? [bugDifficultyPolicyText()] : []),
        ...(enforceQueryAuthorship ? [userQueryAuthoringPolicyText()] : []),
        bugNarrativeLanguageInstruction(),
        `No root-cause file may account for more than 30% of this project's Bug records. Current single-target file counts are ${JSON.stringify(filePolicy.counts)}; the per-file ceiling is ${Number.isFinite(filePolicy.limit) ? filePolicy.limit : 'not-applicable'}.`,
        sourceJob.request.taskType === 'diagnosis'
          ? 'Describe either a directly executable read-only public command or a clear public reproduction/operation scenario for the injected behavior. Do not execute it during injection and do not require a non-zero result at this stage; the final pre_fix proof is generated after the Claude diagnosis trajectory, using an isolated verifier workspace. If the draft is a scenario, it will be converted or completed before final verify_cmds is frozen. Do not use temporary paths, pipes, redirects, Git, hidden tests, or external network access in the eventual command.'
          : 'reproduction_command may be empty for bugfix tasks.',
        `Avoid these already selected bugs:\n${JSON.stringify(previousBugs.map((item) => item.discovery), null, 2)}`,
        `Approved project-level injection record (must remain the same Bug):\n${JSON.stringify(planned.candidate, null, 2)}`,
        'Return only the requested structured Bug record after modifying and validating the workspace.',
      ].join('\n\n');
      const result = await runInjectionCodexJson({ jobFile, stageId: sourceStage, cwd: bugBaseDir, prompt, schema: bugSchemaForPolicy(sourceJob.request.bugPolicyVersion), name: `bug${bugIndex}-injection`, sandbox: 'workspace-write' });
      if (result.output?.found !== true) {
        const reason = String(result.output?.reason || '').trim();
        throw new Error(`Bug ${bugIndex} 受控注入候选不可用：基线已存在候选缺陷或写入器无法形成新的生产改动${reason ? `：${reason}` : ''}`);
      }
      if (!validateDiscoveredBug(result.output, sourceJob.request.taskType, {
        ...sourceJob.request,
        previousUserQueries: previousBugs.map((item) => item.discovery?.user_query).filter(Boolean),
      })) throw new Error('Bug injection stage must return found=true');
      const approvedCandidateMismatch = approvedInjectionCandidateMismatch(planned.candidate, result.output);
      if (approvedCandidateMismatch) {
        throw new Error(`Bug ${bugIndex} 注入结果偏离项目级批准规划（${approvedCandidateMismatch}）：期望 ${planned.candidate.bug_id}，实际 ${result.output.bug_id || 'unknown'}`);
      }
      assertDistinctBugSelection(sourceJob, bugIndex, result.output);
      if (Number(sourceJob.request.bugPolicyVersion || 0) >= BUG_TAXONOMY_POLICY_VERSION) {
        const concentration = validateRootCauseFileConcentration([...previousBugs, { bugIndex, discovery: result.output }], { totalBugCount: sourceJob.request.bugCount });
        if (!concentration.ok) throw new Error(`Bug 根因文件占比门禁未通过：${concentration.issues.join('；')}`);
      }
      const injection = await validateInjectedBugWorktree(bugBaseDir, sourceJob.mainCommit);
      const bugBaseGoEnv = await projectGoEnvironment(bugBaseDir);
      // Reject behavior-breaking mutations with deterministic checks before
      // spending another model session on the mandatory scope review.
      await runRequired('Injected candidate full tests', 'go', ['test', '-timeout=5m', './...'], { cwd: bugBaseDir, env: bugBaseGoEnv, timeoutMs: 20 * 60 * 1000 });
      await runRequired('Injected candidate static checks', 'go', ['vet', './...'], { cwd: bugBaseDir, env: bugBaseGoEnv, timeoutMs: 20 * 60 * 1000 });
      await reviewBroadInjectedBug(jobFile, sourceStage, bugBaseDir, sourceJob.mainCommit, result.output, injection, bugIndex);
      await git(bugBaseDir, ['add', '-A']);
      await git(bugBaseDir, ['-c', 'user.name=Go Pipeline', '-c', 'user.email=go-pipeline@local.invalid', 'commit', '-m', v3OrphanGit ? 'init: generated project snapshot' : `chore: prepare benchmark baseline slot ${String(bugIndex).padStart(2, '0')}`]);
      const bugBaseCommit = (await git(bugBaseDir, ['rev-parse', 'HEAD'])).stdout.trim();
      const parents = (await git(bugBaseDir, ['rev-list', '--parents', '-n', '1', bugBaseCommit])).stdout.trim().split(/\s+/).filter(Boolean);
      if (v3OrphanGit) {
        if (parents.length !== 1) throw new Error('V3 injected green G1 必须是无父提交的 orphan 根提交');
      } else if (parents[1] !== sourceJob.mainCommit) {
        throw new Error('Injected BUG_BASE must be a direct child of the same frozen main commit');
      }
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        Object.assign(bug, {
          discovery: result.output,
          injectionSessionId: result.sessionId,
          bugSource: 'injected',
          bugBaseCommit,
          bugBaseDir,
          injectionValidation: injection,
          ...(v3OrphanGit ? { greenBranch: numberedGreenBranch(bugIndex), greenBaselineCommit: bugBaseCommit } : {}),
        });
        if (bug.injectionPreparation) {
          bug.injectionPreparation.status = 'passed';
          bug.injectionPreparation.updatedAt = now();
        }
      });
      return { bugSource: 'injected', bugBaseCommit, changedFiles: injection.files, changedLines: injection.changedLines };
      }),
    });
  }
  if (sourcePreparations.length) {
    const sourceWorkerLimit = await currentBugSourceWorkerLimit();
    await appendLog(jobFile, 'info', `启动 Bug 源准备：${sourcePreparations.length} 个槽位，当前最多 ${sourceWorkerLimit} 路并行（单 Pipeline 上限 ${PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT}）`, sourcePreparations.length ? 'main_freeze' : '');
    try {
      await runBoundedWorkers(sourcePreparations, sourceWorkerLimit, (prepare) => prepare.run());
    } catch (error) {
      const failures = error.workerFailures || [];
      const recoverable = failures.filter((failure) => failure.item?.plannedCandidate
        && isRecoverableInjectionCandidateFailure(failure.error));
      const recoverableSet = new Set(recoverable);
      const infrastructure = failures.filter((failure) => failure.item?.plannedCandidate
        && !recoverableSet.has(failure)
        && isRetryableInjectionInfrastructureFailure(failure.error));
      const handled = new Set([...recoverable, ...infrastructure]);
      if (!injectionPlan || !handled.size) throw error;
      let recovery = { failedBugIndexes: [], exhaustedBugIndexes: [] };
      let infrastructureRecovery = { failedBugIndexes: [], exhaustedBugIndexes: [] };
      await updateJob(jobFile, (current) => {
        if (recoverable.length) recovery = applyInjectionPreparationFailures(current, recoverable);
        if (infrastructure.length) infrastructureRecovery = applyInjectionInfrastructureFailures(current, infrastructure);
      });
      const retriedBugIndexes = [...new Set([...recovery.failedBugIndexes, ...infrastructureRecovery.failedBugIndexes])].sort((a, b) => a - b);
      const exhaustedBugIndexes = [...new Set([...recovery.exhaustedBugIndexes, ...infrastructureRecovery.exhaustedBugIndexes])].sort((a, b) => a - b);
      await appendLog(jobFile, 'warn', `注入准备未通过；保留成功 BUG_BASE，仅重试槽位 ${retriedBugIndexes.join('、')}`, 'main_freeze');
      if (exhaustedBugIndexes.length) {
        const waitError = new Error(`Bug ${exhaustedBugIndexes.join('、')} 的注入准备连续 ${MAX_INJECTION_SLOT_ATTEMPTS} 次失败，已暂停并等待人工处理`);
        waitError.code = 'PIPELINE_INJECTION_REVIEW_WAIT';
        await updateJob(jobFile, (current) => {
          current.status = 'waiting_review';
          current.currentStage = `bug${exhaustedBugIndexes[0]}_bug_source_prepare`;
          current.error = waitError.message;
          current.finishedAt = null;
          current.injectionReviewPending = {
            bugIndexes: exhaustedBugIndexes,
            reason: waitError.message,
            requestedAt: now(),
          };
        });
        throw waitError;
      }
      const unhandled = failures.filter((failure) => !handled.has(failure));
      if (unhandled.length) {
        const unhandledError = unhandled[0].error instanceof Error
          ? unhandled[0].error
          : new Error(String(unhandled[0].error));
        unhandledError.workerFailures = unhandled;
        throw unhandledError;
      }
      return { retryInjection: true, failedBugIndexes: retriedBugIndexes };
    }
  }
  const afterSources = await readJson(jobFile);
  const pendingNaturalDiscoveries = isNaturalBugOnlyJob(afterSources)
    ? (afterSources.stages || []).filter((stage) => stage.stage === 'bug_discovery'
      && !['passed', 'skipped'].includes(stage.status))
    : [];
  if (pendingNaturalDiscoveries.length) {
    await updateJob(jobFile, (current) => {
      current.naturalBugRetryNonce = `${Date.now()}-${crypto.randomUUID()}`;
      delete current.naturalBugBatch;
    });
    await appendLog(jobFile, 'info', `本轮自然候选已保留，继续搜索剩余 ${pendingNaturalDiscoveries.length} 个槽位`, pendingNaturalDiscoveries[0].id);
    return { retryNatural: true };
  }
  const reviewJob = await readJson(jobFile);
  if (Number(reviewJob.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION) {
    await waitForUserQueryReviews(jobFile);
  }
  return { retryInjection: false };
}

async function prepareV2BugSources(jobFile, projectDir) {
  while (true) {
    const result = await prepareV2BugSourcesPass(jobFile, projectDir);
    if (!result?.retryInjection && !result?.retryNatural) return result;
  }
}

async function publishV2GitBaselines(jobFile, projectDir) {
  const job = await readJson(jobFile);
  await publishFrozenMain(projectDir, job.request, job.mainCommit);
  for (const bug of job.bugs || []) {
    if (isSkippedPipelineBug(bug)) continue;
    await ensureRemoteBranch(projectDir, job.request.cloneUrl, `bug${bug.bugIndex}_main`, job.mainCommit);
    const sourceDir = bug.bugSource === 'injected' ? bug.bugBaseDir : projectDir;
    await ensureRemoteBranchFrom(sourceDir, job.request.cloneUrl, `BUG_BASE${bug.bugIndex}`, bug.bugBaseCommit);
  }
  return { mainCommit: job.mainCommit, bugBases: job.bugs.map((bug) => ({ bugIndex: bug.bugIndex, bugSource: bug.bugSource, bugBaseCommit: bug.bugBaseCommit })) };
}

async function publishV3GitBaselines(jobFile, projectDir) {
  const job = await readJson(jobFile);
  await publishFrozenMain(projectDir, job.request, job.mainCommit);
  const bugBases = [];
  for (const bug of job.bugs || []) {
    if (isSkippedPipelineBug(bug)) continue;
    if (job.request.taskType === 'diagnosis') {
      const redBranch = numberedRedBranch(bug.bugIndex);
      const sourceCommit = bug.diagnosisSourceCommit || bug.bugBaseCommit;
      let redCommit = bug.redCommit || '';
      if (!redCommit) {
        redCommit = await createOrphanDiagnosisRedSnapshot(bug.bugBaseDir, sourceCommit, bug.bugIndex);
        await updateJob(jobFile, (current) => {
          const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bug.bugIndex));
          Object.assign(currentBug, {
            diagnosisSourceCommit: sourceCommit,
            bugBaseCommit: redCommit,
            redBranch,
            redCommit,
          });
        });
      }
      await ensureRemoteBranchFrom(bug.bugBaseDir, job.request.cloneUrl, redBranch, redCommit);
      bugBases.push({ bugIndex: bug.bugIndex, bugSource: bug.bugSource, bugBaseCommit: redCommit, redBranch, redOnly: true });
      continue;
    }
    const greenBranch = bug.greenBranch || numberedGreenBranch(bug.bugIndex);
    const greenCommit = bug.greenBaselineCommit || bug.bugBaseCommit;
    if (!greenCommit) throw new Error(`Bug ${bug.bugIndex} 缺少 green G1 提交`);
    const sourceDir = bug.bugBaseDir;
    if (!sourceDir) throw new Error(`Bug ${bug.bugIndex} 缺少 green G1 工作区`);
    await ensureRemoteBranchFrom(sourceDir, job.request.cloneUrl, greenBranch, greenCommit);
    bugBases.push({ bugIndex: bug.bugIndex, bugSource: bug.bugSource, bugBaseCommit: greenCommit, greenBranch });
  }
  return { mainCommit: job.mainCommit, bugBases };
}

async function runPipeline(jobFile) {
  activeJobFile = jobFile;
  let job = await readJson(jobFile);
  if (pipelineExecutionRole === 'repair-worker'
    && pipelineStageExecutionRole(job.currentStage) !== 'repair-worker') {
    throw new Error(`repair-worker 不能从 A 电脑阶段 ${job.currentStage || '(empty)'} 启动`);
  }
  const policyMigration = migrateWorkflowPolicyVersion(job);
  if (policyMigration.changed) {
    await updateJob(jobFile, (current) => {
      current.workflowPolicyVersion = CURRENT_WORKFLOW_POLICY_VERSION;
    });
    await appendLog(
      jobFile,
      'info',
      `恢复旧任务策略版本：workflowPolicyVersion ${job.workflowPolicyVersion || 0} -> ${CURRENT_WORKFLOW_POLICY_VERSION}`,
      'pipeline_resume',
    );
    job = policyMigration.job;
  }
  // Do not resurrect the retired private-fixture recovery path.  A stopped
  // task is resumed from its persisted August 21 checkpoint or by an explicit
  // operator action; it is never sent back to a Codex fixture Session.
  if (pipelineExecutionRole !== 'repair-worker') await restoreUnfilledBugSlotsForInjection(jobFile);
  job = await readJson(jobFile);
  const quotaUpgrade = pipelineExecutionRole === 'repair-worker'
    ? { changed: false }
    : upgradeUnfinishedPipelineBugQuota(job);
  if (quotaUpgrade.changed) {
    job = await updateJob(jobFile, (current) => {
      Object.assign(current, upgradeUnfinishedPipelineBugQuota(current).job);
    });
    await appendLog(jobFile, 'info', `项目 Bug 配额已从 ${quotaUpgrade.previousBugCount} 补齐为 ${quotaUpgrade.bugCount}，先处理新增 Bug 槽位再重新发布 Git 基线`, job.currentStage);
  }
  const workflowVersion = Number(job.workflowVersion || 1);
  const resumeFailure = {
    status: job.status || '',
    error: job.error || '',
    currentStage: job.currentStage || '',
    workflowVersion,
    stages: (job.stages || []).map((stage) => ({ id: stage.id, status: stage.status || '', error: stage.error || '' })),
  };
  const jobDir = path.dirname(jobFile);
  const tasksRoot = pipelineTasksRootForJob(jobFile);
  job.jobDir = jobDir;
  const runnerStartedAt = now();
  await updateJob(jobFile, (current) => {
    const existingStages = new Map((current.stages || []).map((stage) => [stage.id, stage]));
    current.stages = createPipelineStages(
      current.request.bugCount,
      workflowVersion,
      current.verificationPolicyVersion,
      current.request.taskType,
      current.workflowPolicyVersion,
      current.submissionPlatformPolicyVersion,
    ).map((stage) => ({ ...stage, ...(existingStages.get(stage.id) || {}) }));
    current.jobDir = jobDir;
    current.tasksRoot = tasksRoot;
    current.status = 'running';
    current.startedAt ||= now();
    current.runStartedAt = runnerStartedAt;
    current.runnerPid = process.pid;
    current.finishedAt = null;
    current.error = '';
    const execution = normalizeBugExecution(current.bugExecution);
    const selectedStagePrefix = execution.selectedBugIndex ? `bug${execution.selectedBugIndex}_` : '';
    const runningSelectedBug = Boolean(selectedStagePrefix && String(current.currentStage || '').startsWith(selectedStagePrefix));
    current.bugExecution = {
      ...execution,
      status: runningSelectedBug ? 'fast_lane_running' : 'bug_ready',
      startedAt: runningSelectedBug ? runnerStartedAt : execution.startedAt,
      updatedAt: runnerStartedAt,
      blockedReason: '',
    };
    for (const bug of current.bugs || []) {
      const hasPendingStage = current.stages.some((stage) => Number(stage.bugIndex) === Number(bug.bugIndex)
        && stage.status === 'pending');
      const terminal = isPipelineBugDeliveryComplete(current, bug.bugIndex)
        || isSkippedPipelineBug(bug)
        || bug.disposition === 'failed'
        || bug.failureDisposition === 'auto_continued';
      if (!hasPendingStage || terminal || bug.workerExecution?.status !== 'fast_lane_stopped') continue;
      bug.workerExecution = {
        ...bug.workerExecution,
        status: 'bug_ready',
        currentStage: '',
        startedAt: null,
        currentAttempt: 0,
        blockedReason: '',
        updatedAt: runnerStartedAt,
        lastAction: 'runner_resumed',
      };
    }
  });
  await fsp.mkdir(path.join(jobDir, 'artifacts'), { recursive: true });
  const projectDir = path.join(jobDir, 'project');
  await repairMissingPipelineCloneUrl(jobFile, projectDir, job.request);

  if (pipelineExecutionRole !== 'repair-worker') {
  // Project planning is a one-time checkpoint.  A stale scheduler cursor or
  // a resumed Bug must not invoke Sol again after generation/validation has
  // already consumed the original plan.
  job = await readJson(jobFile);
  if (projectPlanCheckpointConsumed(job) && assessProjectDomain(job.project).ok) {
    const planStage = (job.stages || []).find((stage) => stage.id === 'project_plan');
    const at = now();
    await updateJob(jobFile, (current) => {
      const stage = (current.stages || []).find((item) => item.id === 'project_plan');
      if (!stage || stage.status === 'passed') return;
      stage.status = 'passed';
      stage.error = '';
      stage.finishedAt = at;
      stage.result ||= {
        projectSlug: current.project?.project_slug || '',
        sessionId: current.project?.planningSessionId || null,
        simplificationSessionId: current.project?.simplificationSessionId || null,
        complexity: current.project?.complexity || null,
      };
    });
    await appendLog(jobFile, 'warn', `检测到下游项目阶段已开始，保留既有项目规划检查点并跳过重复规划（${planStage?.status || 'unknown'}）`, 'project_plan');
  }
  await runStage(jobFile, 'project_plan', async () => {
    const previous = await previousProjectContext(jobFile);
    const largeProject = job.request.projectTier === 'large';
    const targetProductionFiles = largeProject ? 50 : 20;
    const targetProductionLines = largeProject ? 5000 : 2000;
    const assignedDomain = String(job.request.projectDomain || '').trim();
    const prompt = [
      assignedDomain
        ? 'Convert the fixed Chinese Go project requirement below into one structured, original project plan. Preserve its assigned domain and workflow. Do not write code or choose a different project.'
        : 'Plan one original, non-trivial Go project that is materially different from the previous project titles below. Do not write code.',
      ...(assignedDomain ? [] : [
        prohibitedProjectDomainPolicyText(),
        'Describe only the chosen positive business domain. Do not repeat prohibited-domain names in uniqueness, exclusions, or “this is not …” disclaimers; those words are reserved for the policy text above.',
      ]),
      'The project must be feasible for Claude Code to generate from zero, must have meaningful concurrency/state/error-handling behavior, and must support deterministic public tests.',
      `This project is assigned to the ${largeProject ? 'large' : 'standard'} tier. It must be designed for at least ${targetProductionFiles} production Go files and ${targetProductionLines} effective production Go lines excluding tests${largeProject ? '' : ' with a target around 2500 lines and a bounded standard-project range near 2000-3000 lines'}, across at least 4 meaningful packages, with real persistence or restart recovery and public tests split across at least 4 test files with at least 12 test cases. The specification must explain enough concrete business behavior for that implementation size to arise naturally; never satisfy the target with padding, repeated files, disconnected packages, or unused declarations.`,
      `Keep the project bounded: at most ${PROJECT_COMPLEXITY_LIMITS.maxComponents} core components and at most ${PROJECT_COMPLEXITY_LIMITS.maxAcceptance} acceptance criteria. The implementation must stay within the assigned production-code file and line budget and remain one coherent workflow. Do not pad the project with unrelated subsystems.`,
      job.request.frontendRequired
        ? 'It must include a real frontend page connected to the Go backend, with package.json, a lockfile and a deterministic build. Frontend code does not count toward the Go line target.'
        : 'It must include a Go backend; a frontend is optional. The final generated repository will need go.mod and dual-architecture Docker support.',
      'Set project_type to web when the primary public interface is HTTP/Web/API, including backend-only services; set it to cli only for a command-line-only project.',
      'Write project_summary as exactly one Chinese sentence. For cli use: 基于 Go 实现的{业务领域} CLI 项目，一款命令行工具，{核心能力}。 For web use: 基于 Go 实现的{业务领域} Web 项目，一款后端服务，{核心能力}。 Use exactly one final Chinese period, keep the business domain and capability in Chinese, and do not include a product brand, English explanation, drafting notes, JSON commentary, or a second sentence.',
      ...(assignedDomain
        ? [`Assigned project domain: ${assignedDomain}. Keep every field within this domain and preserve the supplied business rules.`]
        : []),
      `User requirement:\n${job.request.projectBrief}`,
      `Previous project titles to avoid duplicating:\n${JSON.stringify(previous)}`,
      'Return only the requested structured project plan.',
    ].join('\n\n');
    const result = await runCodexJson({
      jobFile,
      stageId: 'project_plan',
      cwd: jobDir,
      prompt,
      schema: planSchema,
      name: 'project-plan',
      sandbox: 'read-only',
      timeoutMs: PROJECT_PLAN_TIMEOUT_MS,
      streamRecoveryWindowMs: PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS,
      reasoningEffort: 'low',
      ignoreUserConfig: true,
      ephemeral: true,
    });
    let plan = {
      ...result.output,
      project_tier: largeProject ? 'large' : 'standard',
      frontend_required: Boolean(job.request.frontendRequired),
      project_package_policy_version: Number(job.projectPackagePolicyVersion || 0),
    };
    let assessment = assessProjectComplexity(plan);
    let domainAssessment = assessProjectDomain(plan);
    let minimumQualityAssessment = assessGeneratedProjectPlan(plan);
    let packagePolicyAssessment = validateProjectPackagePlan(plan, {
      policyVersion: job.projectPackagePolicyVersion,
      frontendRequired: job.request.frontendRequired,
    });
    let simplificationSessionId = '';
    if (!assessment.ok || !domainAssessment.ok || !minimumQualityAssessment.ok || !packagePolicyAssessment.ok) {
      const reasons = [...assessment.issues, ...domainAssessment.issues, ...minimumQualityAssessment.issues, ...packagePolicyAssessment.issues];
      await appendLog(jobFile, `warn`, `项目规划不符合门禁，使用新 Codex Session 重新规划：${reasons.join('；')}`, 'project_plan');
      const simplified = await runCodexJson({
        jobFile,
        stageId: 'project_plan',
        cwd: jobDir,
        prompt: [
          'Rewrite the supplied Go project plan into one original, non-trivial Go project. Do not write code.',
          'If the current domain is in the prohibited list, choose a materially different domain; do not preserve or disguise the prohibited domain.',
          prohibitedProjectDomainPolicyText(),
          'Describe only the chosen positive business domain. Do not repeat prohibited-domain names in uniqueness, exclusions, or “this is not …” disclaimers.',
          `The result must contain at most ${PROJECT_COMPLEXITY_LIMITS.maxComponents} components, at most ${PROJECT_COMPLEXITY_LIMITS.maxAcceptance} acceptance criteria, and no more than ${PROJECT_COMPLEXITY_LIMITS.maxPlanCharacters} characters across overview, components, and acceptance.`,
          `The rewritten 0-1 plan must still require at least ${targetProductionFiles} production Go files and ${targetProductionLines} effective production Go lines excluding tests${largeProject ? '' : ' with a target around 2500 lines and a bounded standard-project range near 2000-3000 lines'}, across at least 4 meaningful packages, with real persistence and restart recovery and at least 4 public test files containing at least 12 public tests. Do not reduce it to an in-memory domain-only demo or satisfy the target with tests, frontend code, comments or repeated padding.`,
          'The rewritten plan must include concrete business flows, domain invariants, data model, public interfaces, failure boundaries, deterministic test scenarios, and a component-to-behavior traceability list. Do not inflate the plan with generic CRUD or unrelated subsystems.',
          ...(job.request.frontendRequired ? ['Keep a real buildable frontend page connected to the Go backend; do not replace it with a static placeholder.'] : []),
          'Set project_type to web for an HTTP/Web/API service and to cli only for a command-line-only project.',
          'Rewrite project_summary in exactly one of these forms: 基于 Go 实现的{业务领域} CLI 项目，一款命令行工具，{核心能力}。 Or: 基于 Go 实现的{业务领域} Web 项目，一款后端服务，{核心能力}。 The domain and capability must be Chinese, with no brand, English prose, drafting note, JSON commentary, extra sentence, or punctuation after the final Chinese period.',
          'Keep the project as one coherent workflow. Remove unrelated subsystems and preserve the assigned production-code file and line budget.',
          'Remove optional subsystems and combine overlapping components. Preserve deterministic public testability and dual-architecture Docker feasibility.',
          JSON.stringify(plan, null, 2),
          'Return only the requested structured project plan.',
        ].join('\n\n'),
        schema: planSchema,
        name: 'project-plan-simplified',
        sandbox: 'read-only',
        timeoutMs: PROJECT_PLAN_TIMEOUT_MS,
        streamRecoveryWindowMs: PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS,
        reasoningEffort: 'low',
        ignoreUserConfig: true,
        ephemeral: true,
      });
      plan = {
        ...simplified.output,
        project_tier: largeProject ? 'large' : 'standard',
        frontend_required: Boolean(job.request.frontendRequired),
        project_package_policy_version: Number(job.projectPackagePolicyVersion || 0),
      };
      simplificationSessionId = simplified.sessionId;
      assessment = assessProjectComplexity(plan);
      domainAssessment = assessProjectDomain(plan);
      minimumQualityAssessment = assessGeneratedProjectPlan(plan);
      packagePolicyAssessment = validateProjectPackagePlan(plan, {
        policyVersion: job.projectPackagePolicyVersion,
        frontendRequired: job.request.frontendRequired,
      });
    }
    if (!assessment.ok) throw new Error(`项目规划复杂度门禁未通过：${assessment.issues.join('；')}`);
    if (!domainAssessment.ok) throw new Error(`项目领域不符合出题规则：${domainAssessment.issues.join('；')}`);
    if (!minimumQualityAssessment.ok) throw new Error(`项目最低质量规划门禁未通过：${minimumQualityAssessment.issues.join('；')}`);
    if (!packagePolicyAssessment.ok) throw new Error(`项目包规划门禁未通过：${packagePolicyAssessment.issues.join('；')}`);
    await updateJob(jobFile, (current) => {
      current.project = {
        ...plan,
        planningSessionId: result.sessionId,
        ...(simplificationSessionId ? { simplificationSessionId } : {}),
        complexity: assessment,
        domainPolicy: domainAssessment,
      };
    });
    const specPath = path.join(jobDir, 'artifacts', GENERATED_PROJECT_SPEC_FILE);
    await fsp.writeFile(specPath, renderGeneratedProjectSpec(plan), 'utf8');
    return { projectSlug: plan.project_slug, sessionId: result.sessionId, simplificationSessionId, complexity: assessment, specPath };
  });

  job = await readJson(jobFile);
  const forceProjectRegeneration = shouldRegenerateGeneratedProject(resumeFailure);
  if (forceProjectRegeneration) {
    const failureCategory = classifyPipelineFailure(resumeFailure);
    await updateJob(jobFile, (current) => {
      for (const stage of current.stages) {
        if (stage.id === 'project_plan') continue;
        stage.status = 'pending';
        stage.startedAt = null;
        stage.finishedAt = null;
        stage.error = '';
        delete stage.result;
      }
      current.generation = null;
      current.mainCommit = null;
      current.bugs = [];
      current.currentStage = 'project_generate';
    });
    await appendLog(jobFile, 'info', `检测到可恢复的 ${failureCategory} 失败，归档旧项目并使用新 Claude Session 重新生成`, 'project_generate');
    job = await readJson(jobFile);
  }
  await runStage(jobFile, 'project_generate', async () => {
    const generation = await runClaudeProjectGeneration(jobFile, projectDir, job.project, { forceRegenerate: forceProjectRegeneration });
    const quality = generation.quality || {};
    if (Number(job.projectQualityPolicyVersion || 0) >= PROJECT_QUALITY_POLICY_VERSION) {
      if (job.request.projectTier === 'large' && quality.projectTier !== 'large') {
        throw new Error(`大型项目质量门禁未通过：实际 ${quality.productionCodeLines || 0} 行、${quality.productionGoFiles || 0} 个生产 Go 文件`);
      }
      if (job.request.projectTier !== 'large' && quality.projectTier === 'large') {
        throw new Error(`大型项目暂时停用：标准项目实际达到 ${quality.productionCodeLines || 0} 行、${quality.productionGoFiles || 0} 个生产 Go 文件，请重新生成低于 5000 行的标准项目`);
      }
      if (Number(job.request.bugCount || 0) > Number(quality.bugQuota || 0)) {
        throw new Error(`项目实际层级 ${quality.projectTier || '不合格'} 最多允许 ${quality.bugQuota || 0} 个 Bug，当前请求 ${job.request.bugCount}`);
      }
    }
    await updateJob(jobFile, (current) => {
      current.generation = generation;
      current.project = { ...current.project, quality };
    });
    return {
      sessionId: generation.sessionId,
      model: generation.model,
      provider: generation.provider || projectGeneratorConfig().provider,
      projectTier: quality.projectTier || '',
      bugQuota: Number(quality.bugQuota || 0),
      productionGoFiles: Number(quality.productionGoFiles || 0),
      productionCodeLines: Number(quality.productionCodeLines || 0),
      frontend: Boolean(quality.frontend?.present),
    };
  });

  await runStage(jobFile, 'project_validate', async () => {
    const validation = await validateGeneratedProjectDelivery(jobFile, projectDir, job.project);
    return {
      reportPath: validation.reportPath,
      platforms: validation.report.docker?.platforms || [],
      repairCount: validation.repairCount,
      checkpointHits: validation.checkpointHits,
    };
  });

  job = await readJson(jobFile);
  if (workflowVersion >= PARALLEL_BUG_WORKFLOW_VERSION) {
    await runStage(jobFile, 'main_freeze', async () => {
      const mainCommit = await freezeMain(projectDir, job.request, job.project);
      const mainGoEnv = await projectGoEnvironment(projectDir);
      await runRequired('本地冻结 main 全量测试', 'go', ['test', './...'], { cwd: projectDir, env: mainGoEnv, timeoutMs: 20 * 60 * 1000 });
      await runRequired('本地冻结 main 静态检查', 'go', ['vet', './...'], { cwd: projectDir, env: mainGoEnv, timeoutMs: 20 * 60 * 1000 });
      await updateJob(jobFile, (current) => { current.mainCommit = mainCommit; });
      return { mainCommit, published: false };
    });
    await prepareV2BugSources(jobFile, projectDir);
    await runStage(jobFile, 'main_publish', async () => (
      workflowVersion >= CURRENT_WORKFLOW_VERSION
        ? publishV3GitBaselines(jobFile, projectDir)
        : publishV2GitBaselines(jobFile, projectDir)
    ));
  } else {
    await runStage(jobFile, 'main_publish', async () => {
      const mainCommit = await publishMain(projectDir, job.request, job.project);
      await updateJob(jobFile, (current) => { current.mainCommit = mainCommit; });
      return { mainCommit };
    });
    try {
      const mainGoEnv = await projectGoEnvironment(projectDir);
      await runRequired('已发布 main 全量测试', 'go', ['test', './...'], { cwd: projectDir, env: mainGoEnv, timeoutMs: 20 * 60 * 1000 });
      await runRequired('已发布 main 静态检查', 'go', ['vet', './...'], { cwd: projectDir, env: mainGoEnv, timeoutMs: 20 * 60 * 1000 });
    } catch (error) {
      throw new Error(`已发布 main 基线不合格，停止自动重试：${error.message}`);
    }
  }

  if (pipelineExecutionRole === 'producer') {
    const published = await readJson(jobFile);
    const remoteStage = String((published.stages || []).find((stage) => (
      pipelineStageExecutionRole(stage.id) === 'repair-worker'
        && !['passed', 'skipped'].includes(stage.status)
    ))?.id || '');
    const handedOffAt = now();
    if (!remoteStage) {
      await updateJob(jobFile, (current) => {
        const summary = pipelineProjectDeliverySummary(current);
        current.status = summary.passed ? 'passed' : 'failed';
        current.repositoryDisposition = summary.passed ? 'delivered' : 'failed';
        current.currentStage = null;
        current.finishedAt = handedOffAt;
        current.error = summary.passed
          ? ''
          : '项目没有形成可交给 B 电脑修复的合格 Bug，已停止在 A 电脑';
      });
      return;
    }
    await updateJob(jobFile, (current) => {
      Object.assign(current, prepareRemoteRepairHandoff(current, remoteStage, handedOffAt));
      current.logs = [...(current.logs || []), {
        at: handedOffAt,
        level: 'success',
        stageId: remoteStage,
        message: `Git 基线已发布，项目已交给 B 电脑 repair-worker，从 ${remoteStage} 继续`,
      }].slice(-200);
    });
    await fsp.appendFile(
      path.join(jobDir, 'pipeline.log'),
      `${handedOffAt} [success] [${remoteStage}] Git 基线已发布，等待 B 电脑 repair-worker 领取\n`,
      'utf8',
    );
    return;
  }
  }

  job = await readJson(jobFile);
  const execution = normalizeBugExecution(job.bugExecution);
  const bugOrder = bugWorkerOrder(job, execution);
  const selectedBugIndex = bugOrder[0];
  // Consume the persisted retry queue only after deriving the worker order;
  // from this point this fresh Runner owns those queued Bug attempts.
  if (Array.isArray(job.pendingBugRetries) && job.pendingBugRetries.length) {
    await updateJob(jobFile, (current) => {
      takeBugRetryQueue(current);
      current.error = '';
    });
  }
  await updateJob(jobFile, (current) => {
    const currentExecution = normalizeBugExecution(current.bugExecution);
    const bugStartedAt = now();
    const selectedStage = nextPipelineStage({
      ...current,
      bugExecution: { ...currentExecution, selectedBugIndex },
    }) || `bug${selectedBugIndex}_task_prepare`;
    current.currentStage = selectedStage;
    current.bugExecution = {
      ...currentExecution,
      selectedBugIndex,
      status: 'fast_lane_running',
      startedAt: bugStartedAt,
      updatedAt: bugStartedAt,
      currentStage: selectedStage,
      subphase: '',
      resourceStage: '',
      lastHeartbeatAt: null,
      blockedReason: '',
    };
  });

  const processBug = async (bugIndex) => {
    let job = await readJson(jobFile);
    try {
      job = await readJson(jobFile);
      const pendingRetry = (job.pendingBugRetries || []).map(Number).includes(Number(bugIndex));
      const activeOtherWorker = (job.bugs || []).some((item) => Number(item.bugIndex) !== Number(bugIndex)
        && item.workerExecution?.status === 'fast_lane_running');
      // A retry requested during an existing Runner is handed back to the
      // central queue after the current worker batch; do not start it as a
      // spare worker in the middle of that batch.
      if (pendingRetry && activeOtherWorker) return;
      if (pendingRetry) {
        await updateJob(jobFile, (current) => {
          current.pendingBugRetries = (current.pendingBugRetries || [])
            .map(Number)
            .filter((index) => index !== Number(bugIndex));
          if (!current.pendingBugRetries.length) delete current.pendingBugRetries;
        });
      }
      if (isPipelineBugDeliveryComplete(job, bugIndex)
        || isSkippedPipelineBug(job.bugs?.find((item) => Number(item.bugIndex) === bugIndex))) return;
    if (workflowVersion < PARALLEL_BUG_WORKFLOW_VERSION) {
      const discoveryStage = `bug${bugIndex}_bug_discovery`;
      const discoveryResult = await runStage(jobFile, discoveryStage, async () => {
      const analysisDir = path.join(jobDir, `analysis-bug${bugIndex}`);
      await cloneAt(job.request.cloneUrl, 'main', analysisDir, jobDir);
      const previousBugs = job.bugs || [];
      const enforceQueryAuthorship = Number(job.request.bugPolicyVersion || 0) >= BUG_QUERY_POLICY_VERSION;
      const prompt = [
        'Independently inspect this generated Go project and find at most one additional existing, deterministic bug. Do not inject a bug, edit files, commit, or inspect any Gold solution.',
        `This is bug slot ${bugIndex} of at most ${job.request.bugCount}. Avoid all previously selected bugs below.`,
        'The requested bug count is a ceiling, not a quota. If diligent inspection cannot find another distinct bug with deterministic reproduction evidence, return found=false with a concrete reason and leave every bug detail field empty. Never invent, weaken, or force a bug to fill the slot.',
        `The requested trajectory type is ${job.request.taskType}. For diagnosis, keep the task read-only; for bugfix, describe the affected behavior and desired retained behavior. The user_query is an initial draft and does not need a natural request to qualify the technical Bug. A human will edit and confirm the final wording after BUG_BASE preparation.`,
        bugTaxonomyInstruction(job.request.taskType, job.request),
        ...(Number(job.request.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION ? [bugDifficultyPolicyText()] : []),
        ...(enforceQueryAuthorship ? [userQueryAuthoringPolicyText()] : []),
        bugNarrativeLanguageInstruction(),
        'The user_query must describe the real business situation, trigger path, and observed output/error/log/state/value difference when known. The success_criteria must cover the verification expectation and task-type constraint. It will be edited and confirmed by a human after BUG_BASE preparation, so a missing natural request is not a technical discovery failure. Never pad to a fixed length.',
        job.request.taskType === 'diagnosis'
          ? 'For a diagnosis Bug, provide either a directly executable public read-only command or a clear focused observable scenario when available. Do not execute it or require a non-zero result during discovery; the final pre_fix red proof is generated later with an isolated verifier overlay. A scenario draft is allowed here and will be converted or completed before final verify_cmds is frozen. Do not create files or scripts, use temporary paths, pipes, redirects, Git, hidden tests, or external network access. Finish with a clean Git worktree.'
          : 'Use temporary files outside the repository for discovery when needed. Finish with a clean Git worktree.',
        'The user query must not reveal the solution, Gold patch, hidden tests, commit hashes, or exact fix.',
        `Previous bugs:\n${JSON.stringify(previousBugs.map((item) => item.discovery), null, 2)}`,
        'Return only the requested structured result. Set found=true only for a complete qualifying Bug record; reason may then be empty.',
      ].join('\n\n');
      const result = await runCodexJson({ jobFile, stageId: discoveryStage, cwd: analysisDir, prompt, schema: bugSchemaForPolicy(job.request.bugPolicyVersion), name: `bug${bugIndex}-discovery`, sandbox: 'workspace-write' });
      await assertCleanGit(analysisDir, 'Sol 找 Bug');
      if (!validateDiscoveredBug(result.output, job.request.taskType, {
        ...job.request,
        previousUserQueries: previousBugs.map((item) => item.discovery?.user_query).filter(Boolean),
      })) {
        return { found: false, reason: result.output.reason.trim(), sessionId: result.sessionId };
      }
      await updateJob(jobFile, (current) => {
        current.bugs ||= [];
        const existing = current.bugs.find((item) => item.bugIndex === bugIndex);
        if (existing) Object.assign(existing, { discovery: result.output, discoverySessionId: result.sessionId });
        else current.bugs.push({ bugIndex, discovery: result.output, discoverySessionId: result.sessionId, attempts: [] });
      });
      return { found: true, bugId: result.output.bug_id, sessionId: result.sessionId };
      });

      if (discoveryResult?.found === false) {
        await skipUnfilledBugSlots(jobFile, bugIndex, discoveryResult.reason);
        await appendLog(jobFile, 'info', `项目只找到 ${bugIndex - 1} 个合格 Bug，停止继续凑数：${discoveryResult.reason}`, discoveryStage);
        return;
      }
    }

    job = await readJson(jobFile);
    const bugRecord = job.bugs.find((item) => item.bugIndex === bugIndex);
    if (isSkippedPipelineBug(bugRecord)) return;
    const bugBaseCommit = bugRecord.bugBaseCommit || job.mainCommit;
    const bugBaseDir = bugRecord.bugBaseDir || projectDir;
    const goldStage = `bug${bugIndex}_gold_fix`;
    if (workflowVersion < CURRENT_WORKFLOW_VERSION) {
      try {
      await runStage(jobFile, goldStage, async () => {
      if (workflowVersion < PARALLEL_BUG_WORKFLOW_VERSION) {
        await ensureRemoteBranch(projectDir, job.request.cloneUrl, `bug${bugIndex}_main`, job.mainCommit);
        await ensureRemoteBranch(projectDir, job.request.cloneUrl, `BUG_BASE${bugIndex}`, job.mainCommit);
      }
      const goldDir = path.join(jobDir, `gold-bug${bugIndex}`);
      const goldBranch = numberedModelFixBranch(bugIndex, 'gold');
      const goldNamespace = goldTestNamespace(bugIndex, bugRecord.discovery?.bug_id || `bug-${bugIndex}`);
      const goldContractRetry = bugRecord.goldContractRetry && !bugRecord.goldContractRetry.exhausted
        ? bugRecord.goldContractRetry
        : null;
      const goldRetryCandidatePath = goldContractRetry?.candidateDir
        ? path.resolve(jobDir, goldContractRetry.candidateDir)
        : '';
      if (goldRetryCandidatePath) assertInside(jobDir, goldRetryCandidatePath);
      const prompt = [
        goldContractRetry
          ? 'A previous Gold test was rejected by the read-only public-contract review. The workspace contains an existing production fix candidate. Keep that production fix intact and replace only the added Gold regression test with a less over-specified test; do not reset or discard the production changes, inspect another Bug slot, or run Git commands.'
          : 'Independently fix the selected bug in this isolated BUG_BASE. Do not inspect another bug slot, prior commit history, or run Git commands.',
        goldContractRetry
          ? `Replace the existing standalone Gold test file with ${goldNamespace.filename}; do not add a second Gold test file. The test function name must start with ${goldNamespace.prefix}, and every helper function/type introduced by that file should use the same namespace.`
          : `Add one new standalone Go regression test file named ${goldNamespace.filename}; do not modify an existing test file. The test function name must start with ${goldNamespace.prefix}, and every helper function/type introduced by that file should use the same namespace.`,
        'Treat user_query as the hard behavior contract: the single test function must cover every distinct issue-specific behavior and public boundary explicitly requested there. success_criteria may clarify that behavior, but must not introduce a new failure mode, exact error value, unrelated normal-flow requirement, or Cartesian-product repetition. Verify public observable behavior rather than a private helper or implementation detail. The test must fail on BUG_BASE and pass after your fix. Keep the change minimal.',
        'Run the focused test, go test ./..., and go vet ./.... Return root_cause_file as the exact implicated .go path and root_cause_symbols as the exact directly implicated Go symbols. Write method symbols in package.(*Receiver).method or package.Receiver.method form. Fill three distinct Chinese causal fields: internal_cause must name the incorrect implementation check/state/control-flow operation, propagation_path must explain how that internal condition travels through the code, and observable_failure must name the resulting public behavior. Chinese must be the prose language; do not append English explanatory sentences. Necessary Go identifiers, paths, commands, API names, states, and error codes may remain in English. Never copy the same symptom into internal_cause or propagation_path. The pipeline will construct failure_mechanism and gold_root_cause from these fields. Also return 3-6 concise, exact mechanism_keywords that an independent correct diagnosis should naturally mention. Do not use Markdown backticks in any field.',
        ...(Number(job.request.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION ? [
          `${bugDifficultyPolicyText()} If the actual root cause is shallower than the selected Bug record claims, do not disguise it as difficult; the final independent review will reject it.`,
        ] : []),
        'Do not rely on another existing test or the full suite to satisfy any user_query behavior in this internal Gold check. The public model verification is generated separately from Claude-authored tests after test_model_fix is published.',
        `Bug record:\n${JSON.stringify(bugRecord.discovery, null, 2)}`,
        'Return only the requested structured Gold result after modifying and validating the workspace.',
      ].join('\n\n');
      let result = await recoverGoldCheckpoint({
        jobDir,
        goldDir,
        bugIndex,
        bugBaseCommit,
        requiredPrefix: goldNamespace.prefix,
        expectedFiles: bugRecord.discovery?.target_files,
        expectedSymbols: bugRecord.discovery?.symbols,
      });
      if (result) {
        await appendLog(jobFile, 'info', `复用已验证的本地 Gold checkpoint：${path.basename(result.checkpointSource)}`, goldStage);
      } else {
        await fsp.rm(goldCheckpointRejectionPath(jobDir, bugIndex), { force: true });
        if (goldRetryCandidatePath && await fsp.stat(goldRetryCandidatePath).catch(() => null)) {
          await archiveDirectory(jobDir, goldDir, `${path.basename(goldDir)}-contract-retry-incomplete`);
          await fsp.cp(goldRetryCandidatePath, goldDir, { recursive: true, preserveTimestamps: true, mode: FAST_COPY_MODE });
          await appendLog(jobFile, 'info', `保留 Gold 生产修复，仅替换第 ${bugRecord.goldContractRetry.attempt} 次契约复核失败的回归测试`, goldStage);
        } else {
          await cloneAt(job.request.cloneUrl, `BUG_BASE${bugIndex}`, goldDir, jobDir);
          await git(goldDir, ['switch', '-c', goldBranch]);
        }
        result = await runCodexJson({ jobFile, stageId: goldStage, cwd: goldDir, prompt, schema: goldSchema, name: `bug${bugIndex}-gold`, sandbox: 'workspace-write' });
      }
      let normalizedGold = validateGoldTestDescriptor(result.output, {
        requiredPrefix: goldNamespace.prefix,
        expectedFiles: bugRecord.discovery?.target_files,
        expectedSymbols: bugRecord.discovery?.symbols,
      });
      const head = (await git(goldDir, ['rev-parse', 'HEAD'])).stdout.trim();
      if (head !== bugBaseCommit) throw new Error('Sol Gold 修复阶段自行创建了 Git 提交；流水线要求由脚本生成唯一直接子提交');
      const testFiles = await changedTestFiles(goldDir, bugBaseCommit, normalizedGold.test_name, { requiredBasename: goldNamespace.filename });
      normalizedGold = {
        ...normalizedGold,
        test_package: await resolveGoldTestPackage(goldDir, testFiles, normalizedGold.test_name),
      };
      const publicBehavior = await assertGoldTestsUsePublicBehavior(goldDir, testFiles);
      await reviewGoldTestContract(jobFile, goldStage, goldDir, bugRecord.discovery, testFiles, bugIndex);
      if (Number(job.request.bugPolicyVersion || 0) >= BUG_DIFFICULTY_POLICY_VERSION) {
        validateBugDifficulty(bugRecord.discovery);
        await reviewGoldBugDifficulty(jobFile, goldStage, goldDir, bugRecord.discovery, normalizedGold, bugBaseCommit, bugIndex);
      }
      if (Number(job.request.bugPolicyVersion || 0) >= BUG_TAXONOMY_POLICY_VERSION) {
        const latest = await readJson(jobFile);
        const concentrationInput = (latest.bugs || []).map((item) => item.bugIndex === bugIndex
          ? { ...item, gold: normalizedGold }
          : item);
        const concentration = validateRootCauseFileConcentration(concentrationInput, { totalBugCount: job.request.bugCount });
        if (!concentration.ok) throw new Error(`Gold 根因文件占比门禁未通过：${concentration.issues.join('；')}`);
      }
      const redGreen = await verifyGoldRedGreen(jobDir, bugBaseDir, goldDir, bugBaseCommit, bugRecord.discovery, normalizedGold, testFiles, bugIndex);
      await writeJsonAtomic(path.join(jobDir, `artifacts/bug${bugIndex}-red-green.json`), redGreen);
      let verificationCoverage = null;
      if (legacyVerificationCoverageEnabled(job)
        && job.request.taskType === 'diagnosis') {
        const diagnosisCommand = publicTargetCommandForTask(
          'diagnosis',
          normalizedGold,
          bugRecord.discovery.reproduction_command,
          isConcurrencyBug(bugRecord.discovery),
        );
        const commandIssues = directPublicVerifyCommandIssues([diagnosisCommand], 'diagnosis');
        if (commandIssues.length) throw new Error(`diagnosis 公开 verify_cmds 不合格：${commandIssues.join('；')}`);
        verificationCoverage = await reviewVerificationCoverage(
          jobFile,
          goldStage,
          goldDir,
          bugRecord.discovery,
          [diagnosisCommand],
          testFiles,
          job.request.taskType,
          bugIndex,
          redGreen,
          '诊断公开测试',
        );
        await writeJsonAtomic(path.join(jobDir, `artifacts/bug${bugIndex}-verification-coverage.json`), verificationCoverage.report);
      }
      await git(goldDir, ['add', '-A']);
      await git(goldDir, ['-c', 'user.name=Sol Gold Model', '-c', 'user.email=sol-gold@local.invalid', 'commit', '-m', `fix: ${safeSlug(`${job.project.project_slug}-${bugRecord.discovery.bug_id}`)}`]);
      const goldCommit = (await git(goldDir, ['rev-parse', 'HEAD'])).stdout.trim();
      const parent = (await git(goldDir, ['rev-parse', 'HEAD^'])).stdout.trim();
      if (parent !== bugBaseCommit) throw new Error('gold_model_fix 必须是 BUG_BASE 的直接子提交');
      await git(goldDir, ['push', 'origin', `HEAD:refs/heads/${goldBranch}`], `推送 ${goldBranch}`);
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        Object.assign(bug, { gold: normalizedGold, goldSessionId: result.sessionId, goldCommit, goldDir, testFiles, redGreen, verificationCoverage });
        delete bug.goldContractRetry;
      });
        return { goldCommit, sessionId: result.sessionId, testName: normalizedGold.test_name, verificationCoverage };
      });
      } catch (error) {
        if (isGoldCheckpointSemanticFailure(error)) {
          await rejectGoldCheckpoint(jobDir, bugIndex, error.message);
          await appendLog(jobFile, 'warn', `Gold checkpoint 已失效，下次将使用新 Session 重新生成：${error.message}`, goldStage);
        }
        throw error;
      }
    }

    job = await readJson(jobFile);
    const preparedBug = job.bugs.find((item) => item.bugIndex === bugIndex);
      const prepareStage = `bug${bugIndex}_task_prepare`;
      await runStage(jobFile, prepareStage, async () => {
      const preparedJob = await readJson(jobFile);
      const prepared = preparedJob.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
      const task = await createTask({
        job: preparedJob,
        jobFile,
        bugIndex,
        bug: prepared.discovery,
        bugRecord: prepared,
        gold: prepared.gold,
        goldDir: prepared.goldDir,
        testFiles: prepared.testFiles,
        verificationFixture: null,
        mainCommit: preparedJob.mainCommit,
        bugBaseCommit: prepared.bugBaseCommit || preparedJob.mainCommit,
        bugBaseDir: prepared.bugBaseDir || projectDir,
        goldCommit: prepared.goldCommit,
        generation: preparedJob.generation,
        redGreen: prepared.redGreen,
        verificationCoverage: prepared.verificationCoverage,
      });
      await updateJob(jobFile, (current) => {
        const bug = current.bugs.find((item) => item.bugIndex === bugIndex);
        bug.task = task;
      });
      return { taskName: task.taskName, bugId: task.bugId };
    });

      const preparedAfterTask = await readJson(jobFile);
      const usesVerificationEvidence = Number(preparedAfterTask.verificationPolicyVersion || 0) >= VERIFICATION_POLICY_VERSION;
      let verifiedTask = await runTrajectoryCycle(jobFile, bugIndex);
      if (!verifiedTask.skipped && preparedAfterTask.request.taskType === 'diagnosis') {
        const postTrajectoryJob = await readJson(jobFile);
        const postTrajectoryTask = postTrajectoryJob.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
        if (postTrajectoryTask?.taskDir) await ensureDiagnosisWorkspaceUnchanged(postTrajectoryTask.taskDir);
      }
      if (verifiedTask.skipped) {
        const skippedTask = preparedBug.task;
        const skippedMetadata = skippedTask?.taskDir
          ? await readJson(path.join(skippedTask.taskDir, 'public.json'), {})
          : {};
        if (usesVerificationEvidence && (!Array.isArray(skippedMetadata.verify_cmds) || skippedMetadata.verify_cmds.length === 0)) {
          const reason = `${verifiedTask.reason}；缺少可执行 verify_cmds，无法生成独立红绿证明`;
          await updateJob(jobFile, (current) => markPipelineBugSkipped(current, bugIndex, reason, now()));
          await appendLog(jobFile, 'error', reason, `bug${bugIndex}_verification_finalize`);
          return;
        }
        if (usesVerificationEvidence && skippedTask?.taskDir && skippedTask?.taskName) {
          // Main trajectory integrity and independent red/green evidence are
          // separate deliverables. A rejected main trajectory must not make a
          // valid pre_fix/post_fix proof impossible to upload or finalize.
          if (job.request.taskType === 'bugfix') {
            await runStage(jobFile, `bug${bugIndex}_post_verify`, async () => {
              const latest = await readJson(jobFile);
              const currentBug = latest.bugs.find((item) => item.bugIndex === bugIndex);
              const sourceDir = await cleanPostFixSource(jobFile, bugIndex);
              return runVerificationProof(jobFile, bugIndex, 'post_fix', sourceDir);
            });
          }
          await promotePublishedVerificationFixture(skippedTask.taskDir);
          await runStage(jobFile, `bug${bugIndex}_cloud_upload`, async () => {
            const preFix = await uploadVerificationProof(skippedTask.taskName, 'verify_pre');
            const postFix = job.request.taskType === 'bugfix'
              ? await uploadVerificationProof(skippedTask.taskName, 'verify_post')
              : null;
            return { preFix, postFix, main: null };
          });
          const mainSessionId = String(await fsp.readFile(path.join(skippedTask.taskDir, 'trajectory/session_id.txt'), 'utf8').catch(() => '')).trim();
          await runStage(jobFile, `bug${bugIndex}_verification_finalize`, async () => {
            const latest = await readJson(jobFile);
            const currentBug = latest.bugs.find((item) => item.bugIndex === bugIndex);
            const result = await finalizeVerificationResult(currentBug?.task?.taskDir, mainSessionId);
            return { result, main: null };
          });
          await cleanupVerificationCache(skippedTask.taskDir);
          await appendLog(jobFile, 'success', '主轨迹仅完成采集登记，不作为红绿证明；独立红绿证明已上传并回填 verify_result', `bug${bugIndex}_verification_finalize`);
        }
        await updateJob(jobFile, (current) => markPipelineBugSkipped(current, bugIndex, verifiedTask.reason, now()));
        return;
      }
      if (usesVerificationEvidence && job.request.taskType === 'bugfix') {
        const afterClaude = await readJson(jobFile);
        const afterClaudeBug = afterClaude.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
        const frozenTest = afterClaudeBug?.verificationTestAuthor;
        if (!frozenTest?.sourceDir || !frozenTest?.testFile) {
          await updateJob(jobFile, (current) => {
            invalidatePipelineVerificationAfterMissingTestAuthor(current, bugIndex);
          });
          await runStage(jobFile, `bug${bugIndex}_test_author`, async () => {
            const author = await preparePostClaudeVerificationTest(
              jobFile,
              bugIndex,
              afterClaudeBug.bugBaseDir || projectDir,
              path.join(afterClaudeBug.task.taskDir, 'workspace'),
              afterClaudeBug.discovery,
            );
            const plan = await syncAuthoredVerificationMetadata(afterClaudeBug.task.taskDir, author, {
              taskType: 'bugfix',
              repairSessionId: author.repairSessionId,
              concurrency: isConcurrencyBug(afterClaudeBug.discovery),
            });
            return { ...author, verify_cmds: plan.verify_cmds };
          });
        }
        const authored = (await readJson(jobFile)).bugs.find((item) => Number(item.bugIndex) === Number(bugIndex)).verificationTestAuthor;
        if (!authored?.sourceDir || !authored?.testFile) throw new Error(`Bug ${bugIndex} 缺少已生成的 Codex 回归测试`);
        await syncAuthoredVerificationMetadata(afterClaudeBug.task.taskDir, authored, {
          taskType: 'bugfix',
          repairSessionId: verifiedTask.sessionId || authored.repairSessionId,
          concurrency: isConcurrencyBug(afterClaudeBug.discovery),
        });
        await materializeVerificationTest(afterClaudeBug.task.taskDir, authored.sourceDir, authored.testFile);
        await prepareV3BugfixGitLayout(jobFile, bugIndex, path.join(afterClaudeBug.task.taskDir, 'workspace'), authored.testFile);
        await restoreVerificationEvidenceFromManifests(jobFile, bugIndex, afterClaudeBug.task.taskDir, 'bugfix');
        await runStage(jobFile, `bug${bugIndex}_pre_verify`, async () => {
          const latest = await readJson(jobFile);
          const currentBug = latest.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          return runVerificationProof(
            jobFile,
            bugIndex,
            'pre_fix',
            currentBug.bugBaseDir || projectDir,
          );
        });
        await runStage(jobFile, `bug${bugIndex}_post_verify`, async () => {
          const sourceDir = await cleanPostFixSource(jobFile, bugIndex);
          return runVerificationProof(jobFile, bugIndex, 'post_fix', sourceDir);
        });
        await runStage(jobFile, `bug${bugIndex}_docker_validation`, async ({ releaseResource } = {}) => runPostClaudeDelivery(jobFile, bugIndex, { releaseResource }));
      } else if (usesVerificationEvidence && job.request.taskType === 'diagnosis') {
        const afterClaude = await readJson(jobFile);
        const afterClaudeBug = afterClaude.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
        const authoredBefore = afterClaudeBug?.verificationTestAuthor;
        if (!authoredBefore?.sourceDir || !authoredBefore?.testFile) {
          await updateJob(jobFile, (current) => {
            invalidatePipelineVerificationAfterMissingTestAuthor(current, bugIndex);
          });
          await runStage(jobFile, `bug${bugIndex}_test_author`, async () => {
            const author = await prepareDiagnosisVerificationTest(
              jobFile,
              bugIndex,
              afterClaudeBug.bugBaseDir || projectDir,
              path.join(afterClaudeBug.task.taskDir, 'workspace'),
              afterClaudeBug.discovery,
            );
            const plan = await syncAuthoredVerificationMetadata(afterClaudeBug.task.taskDir, author, {
              taskType: 'diagnosis',
              concurrency: isConcurrencyBug(afterClaudeBug.discovery),
            });
            return { ...author, verify_cmds: plan.verify_cmds };
          });
        } else if (!['passed', 'skipped'].includes(afterClaude.stages.find((stage) => stage.id === `bug${bugIndex}_test_author`)?.status)) {
          await setStage(jobFile, `bug${bugIndex}_test_author`, 'passed', {
            testFile: authoredBefore.testFile,
            testName: authoredBefore.testName,
            redExitCode: authoredBefore.redExitCode,
            reused: true,
          });
        }
        const authored = (await readJson(jobFile)).bugs.find((item) => Number(item.bugIndex) === Number(bugIndex)).verificationTestAuthor;
        if (!authored?.sourceDir || !authored?.testFile) throw new Error(`Bug ${bugIndex} 缺少已生成的诊断回归测试`);
        await ensureDiagnosisWorkspaceUnchanged(afterClaudeBug.task.taskDir, authored);
        await syncAuthoredVerificationMetadata(afterClaudeBug.task.taskDir, authored, {
          taskType: 'diagnosis',
          concurrency: isConcurrencyBug(afterClaudeBug.discovery),
        });
        await finalizeV3DiagnosisImmutableDelivery(jobFile, bugIndex, authored.sourceDir, authored.testFile);
        await restoreVerificationEvidenceFromManifests(jobFile, bugIndex, afterClaudeBug.task.taskDir, 'diagnosis');
        await runStage(jobFile, `bug${bugIndex}_pre_verify`, async () => {
          const latest = await readJson(jobFile);
          const currentBug = latest.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          return runVerificationProof(
            jobFile,
            bugIndex,
            'pre_fix',
            currentBug.bugBaseDir || projectDir,
          );
        });
        await ensureDiagnosisWorkspaceUnchanged(afterClaudeBug.task.taskDir, authored);
      }
      const cloudResult = await runStage(jobFile, `bug${bugIndex}_cloud_upload`, async () => {
        if (!usesVerificationEvidence) {
          const latest = await readJson(jobFile);
          await qualifyTask(latest, verifiedTask, { verificationFinalize: true });
          return {
            main: await uploadQualifiedTrajectory(verifiedTask.taskName, {
              pipelineJobId: latest.id,
              bugIndex,
            }),
          };
        }
        const preFix = await uploadVerificationProof(verifiedTask.taskName, 'verify_pre');
        const postFix = job.request.taskType === 'bugfix'
          ? await uploadVerificationProof(verifiedTask.taskName, 'verify_post')
          : null;
        return { preFix, postFix };
      });
      let verificationResult = null;
      let mainCloudResult = cloudResult.main || null;
      if (usesVerificationEvidence) {
        const finalized = await runStage(jobFile, `bug${bugIndex}_verification_finalize`, async () => {
          const latest = await readJson(jobFile);
          const currentBug = latest.bugs.find((item) => item.bugIndex === bugIndex);
          const result = await finalizeVerificationResult(currentBug?.task?.taskDir, verifiedTask.sessionId);
          // The task is still pipeline-incomplete until this stage finishes.
          // Bind the qualification request to the owning Job/Bug so the
          // monitor can validate the completed proof checkpoints without
          // treating the task as an ordinary, prematurely reviewed row.
          await qualifyTask(latest, verifiedTask, { verificationFinalize: true });
          const main = await uploadQualifiedTrajectory(verifiedTask.taskName, {
            pipelineJobId: latest.id,
            bugIndex,
          });
          return { result, main };
        });
        verificationResult = finalized.result;
        mainCloudResult = finalized.main;
        const deliveredTaskDir = preparedBug?.task?.taskDir || path.join(job.tasksRoot, verifiedTask.taskName);
        await cleanupVerificationCache(deliveredTaskDir);
      }
      let platformSubmission = null;
      if (await pipelineHasStage(jobFile, `bug${bugIndex}_platform_submit`)) {
        platformSubmission = await runStage(jobFile, `bug${bugIndex}_platform_submit`, async () => {
          const latest = await readJson(jobFile);
          return submitQualifiedTaskToPlatform(verifiedTask.taskName, {
            pipelineJobId: latest.id,
            bugIndex,
          });
        });
      }
      await setStage(jobFile, `bug${bugIndex}_delivery_ready`, 'passed', {
        taskId: verifiedTask.taskId,
        sessionId: verifiedTask.sessionId || null,
        trajectoryUrl: mainCloudResult.signedUrl,
        verificationResult,
        platformSubmission,
      });
      // A previous infrastructure failure may have marked this Bug as
      // auto-continued while its proofs were still being recovered. Once the
      // delivery gate passes, normalize the Bug to delivered while retaining
      // first/last failure history for audit display.
      await updateJob(jobFile, (current) => {
        const deliveredBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
        if (!deliveredBug) return;
        deliveredBug.disposition = 'delivered';
        delete deliveredBug.failureDisposition;
        deliveredBug.deliveredAt = now();
        deliveredBug.lastAction = 'delivery_completed';
      });
      await appendLog(jobFile, 'success', usesVerificationEvidence
        ? `Bug ${bugIndex} 已完成主轨迹、独立红绿证明、云盘上传、Excel 回填${platformSubmission ? '和质检平台提交' : ''}`
        : `Bug ${bugIndex} 已完成轨迹采集登记、云盘上传和 Excel 链接回填`, `bug${bugIndex}_delivery_ready`);
      if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
        await updateJob(jobFile, (current) => {
          const deliveredBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          if (!deliveredBug) return;
          deliveredBug.workerExecution = {
            ...(deliveredBug.workerExecution || {}),
            status: 'fast_lane_completed',
            currentStage: '',
            currentAttempt: 0,
            updatedAt: now(),
          };
        });
        return;
      }
      const afterDelivery = await readJson(jobFile);
      const afterExecution = normalizeBugExecution(afterDelivery.bugExecution);
      const nextBug = bugOrder.find((candidate) => candidate > bugIndex
        && !isPipelineBugDeliveryComplete(afterDelivery, candidate)
        && !isSkippedPipelineBug(afterDelivery.bugs?.find((item) => Number(item.bugIndex) === candidate)))
        || nextIncompleteBugIndex(afterDelivery, bugIndex + 1);
      const nextBugStage = nextBug
        ? nextPipelineStage({
            ...afterDelivery,
            currentStage: `bug${nextBug}_bug_discovery`,
            bugExecution: { ...afterExecution, selectedBugIndex: nextBug },
          }) || `bug${nextBug}_bug_discovery`
        : '';
      if (nextBug && afterExecution.autoContinue === false) {
        await updateJob(jobFile, (current) => {
          const currentExecution = normalizeBugExecution(current.bugExecution);
          current.bugExecution = {
            ...currentExecution,
            selectedBugIndex: nextBug,
            status: 'fast_lane_stopped',
            currentStage: nextBugStage,
            currentAttempt: 0,
            updatedAt: now(),
            lastAction: 'auto_pause_after_delivery',
          };
          current.status = 'stopped';
          current.currentStage = nextBugStage;
          current.finishedAt = now();
          current.error = `Bug ${bugIndex} 已完成，按工作台设置暂停；下一个未完成 Bug 为 ${nextBug}`;
        });
        await appendLog(jobFile, 'info', `Bug ${bugIndex} 已完成，工作台暂停在下一个未完成 Bug ${nextBug}`, `bug${bugIndex}_delivery_ready`);
        return;
      }
      await updateJob(jobFile, (current) => {
        const currentExecution = normalizeBugExecution(current.bugExecution);
        const nextBugStartedAt = nextBug ? now() : null;
        current.bugExecution = {
          ...currentExecution,
          selectedBugIndex: nextBug || bugIndex,
          status: nextBug ? 'fast_lane_running' : 'fast_lane_completed',
          startedAt: nextBugStartedAt,
          currentStage: nextBug ? nextBugStage : '',
          updatedAt: nextBugStartedAt || now(),
        };
      });
    } catch (error) {
      // Resource yielding is a normal scheduler hand-off, not a failed Bug.
      // Preserve waiting_resource so the central scheduler can resume this job.
      if (error?.code === 'PIPELINE_RESOURCE_WAIT') throw error;
      const failedAt = now();
      const latest = await readJson(jobFile);
      const failedStage = (latest.stages || []).findLast((stage) => Number(stage.bugIndex) === bugIndex
        && ['running', 'failed'].includes(stage.status))?.id || `bug${bugIndex}_bug_discovery`;

      // Older jobs may already have marked a zero-patch Claude Session as a
      // reusable trajectory. Revalidate it before downstream work and, when it
      // is invalid, archive the whole attempt and restart Claude from BUG_BASE.
      if (error?.code === 'INVALID_REPAIR_OUTPUT' || /INVALID_REPAIR_OUTPUT=1/.test(error?.message || '')) {
        const retryTask = latest.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
        if (!retryTask?.taskDir) throw error;
        const retryPreparation = await prepareTrajectoryRetry(latest, retryTask);
        const retryStage = `bug${bugIndex}_claude_fix`;
        await updateJob(jobFile, (current) => {
          const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          for (const suffix of ['claude_fix', 'trajectory_validate', 'sol_quality', 'test_author', 'pre_verify', 'docker_validation', 'post_verify', 'git_publication', 'verification_coverage', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready']) {
            const stage = current.stages.find((item) => item.id === `bug${bugIndex}_${suffix}`);
            if (!stage) continue;
            stage.status = 'pending';
            stage.startedAt = null;
            stage.finishedAt = null;
            stage.error = '';
            stage.reason = '无有效生产补丁，已从 BUG_BASE 重新启动 Claude 修复';
            delete stage.result;
            delete stage.failureCategory;
          }
          if (currentBug) {
            delete currentBug.verificationTestAuthor;
            delete currentBug.disposition;
            delete currentBug.failureDisposition;
            delete currentBug.failureStage;
            delete currentBug.failureReason;
            if (currentBug.stageAutoRetries) delete currentBug.stageAutoRetries[`bug${bugIndex}_test_author`];
            currentBug.invalidRepairHistory = [...(currentBug.invalidRepairHistory || []), {
              at: failedAt,
              error: error.message,
              archivedWithReuseLevel: retryPreparation.reuseLevel,
            }].slice(-10);
            currentBug.workerExecution = {
              ...(currentBug.workerExecution || {}),
              status: 'fast_lane_queued',
              currentStage: retryStage,
              currentAttempt: 0,
              updatedAt: failedAt,
              lastAction: 'invalid_repair_full_rerun_queued',
              blockedReason: '等待 Claude 从 BUG_BASE 重新修复',
            };
          }
          const execution = normalizeBugExecution(current.bugExecution);
          current.bugExecution = {
            ...execution,
            selectedBugIndex: bugIndex,
            status: 'fast_lane_queued',
            currentStage: retryStage,
            currentAttempt: 0,
            updatedAt: failedAt,
            lastAction: 'invalid_repair_full_rerun_queued',
            blockedReason: '等待 Claude 从 BUG_BASE 重新修复',
          };
          current.status = 'running';
          current.currentStage = retryStage;
          current.error = '';
          current.finishedAt = null;
        });
        await appendLog(jobFile, 'warn', `Bug ${bugIndex} 的 Claude 会话未产生有效生产补丁，旧轨迹已归档并从 BUG_BASE 重新修复`, retryStage);
        return processBug(bugIndex);
      }

      // A Gold public-contract rejection means the generated test is wrong or
      // over-specified. Preserve the production patch and retry only Gold test
      // generation; do not mark the Bug failed or skip its delivery stages.
      if (isGoldCheckpointSemanticFailure(error) && failedStage === `bug${bugIndex}_gold_fix`) {
        const candidateDir = await archiveGoldContractCandidate(
          jobDir,
          path.join(jobDir, `gold-bug${bugIndex}`),
          bugIndex,
        );
        let retryResult;
        await updateJob(jobFile, (current) => {
          retryResult = queuePipelineGoldContractRetry(current, bugIndex, {
            candidateDir,
            error: error.message,
            at: failedAt,
          });
          Object.assign(current, retryResult.job);
        });
        if (retryResult.queued) {
          await appendLog(jobFile, 'warn', `Gold 公共契约复核不通过，保留生产修复并重新生成回归测试（第 ${retryResult.attempt} 次）：${error.message}`, failedStage);
          if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
            await updateJob(jobFile, (current) => {
              const retryBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
              current.status = 'running';
              current.error = '';
              current.finishedAt = null;
              current.runnerPid = process.pid;
              current.waitingResource = null;
              current.schedulerLease = {
                stageId: failedStage,
                runnerPid: process.pid,
                admittedAt: current.schedulerLease?.admittedAt || failedAt,
              };
              if (retryBug) retryBug.workerExecution = {
                ...(retryBug.workerExecution || {}),
                status: 'fast_lane_queued',
                currentStage: failedStage,
                currentAttempt: 0,
                updatedAt: failedAt,
                lastAction: 'gold_contract_retry_queued',
                blockedReason: '保留生产修复并重新生成 Gold 回归测试',
              };
            });
            return processBug(bugIndex);
          }
          throw new PipelineResourceWaitError(failedStage, 'compute-heavy', 'gold_contract_review_retry');
        }
        if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
          await updateJob(jobFile, (current) => {
            const stoppedBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
            const activeOther = current.bugs.find((item) => Number(item.bugIndex) !== Number(bugIndex)
              && item.workerExecution?.status === 'fast_lane_running');
            current.status = 'running';
            current.error = '';
            current.finishedAt = null;
            current.runnerPid = process.pid;
            current.waitingResource = null;
            current.schedulerLease = activeOther?.workerExecution?.currentStage
              ? {
                  stageId: activeOther.workerExecution.currentStage,
                  runnerPid: process.pid,
                  admittedAt: current.schedulerLease?.admittedAt || failedAt,
                }
              : current.schedulerLease;
            current.currentStage = activeOther?.workerExecution?.currentStage || null;
            if (stoppedBug) stoppedBug.workerExecution = {
              ...(stoppedBug.workerExecution || {}),
              status: 'fast_lane_failed',
              currentStage: failedStage,
              currentAttempt: 0,
              updatedAt: failedAt,
              lastAction: 'gold_contract_review_exhausted',
              blockedReason: '等待人工复核 Gold 测试',
            };
          });
        }
        await appendLog(jobFile, 'error', `Gold 公共契约复核连续失败，已暂停当前 Bug 等待人工复核：${error.message}`, failedStage);
        return;
      }
      const failureCategory = classifyPipelineFailure({
        ...latest,
        status: 'failed',
        currentStage: failedStage,
        error: error.message,
      });
      const infrastructureFailure = new Set([
        'cloud_upload',
        'verification_coverage',
        'snapshot_infrastructure',
        'grader_infrastructure',
        'audit_infrastructure',
        'runner_infrastructure',
        'codex_infrastructure',
        'git_infrastructure',
        'docker_infrastructure',
        'git_baseline_conflict',
      ]).has(failureCategory);
      // Only an explicitly enabled coverage policy may invalidate the model
      // attempt. Legacy jobs retain the stage for history, but that retired
      // review must never reset an already validated Claude fix.
      if (failedStage.endsWith('_verification_coverage')) {
        const coveragePolicyEnabled = legacyVerificationCoverageEnabled(latest);
        if (!coveragePolicyEnabled) {
          await updateJob(jobFile, (current) => {
            const stage = current.stages.find((item) => item.id === failedStage);
            if (stage) {
              stage.status = 'skipped';
              stage.error = '';
              stage.failureCategory = '';
              stage.reason = '旧 verify_cmds 题面语义覆盖复核已停用；不重置已通过的 Claude 修复';
              delete stage.result;
            }
            current.status = 'running';
            current.error = '';
            current.finishedAt = null;
            current.currentStage = failedStage;
          });
          await appendLog(jobFile, 'warn', `Bug ${bugIndex} 命中已停用的旧覆盖复核失败，跳过该阶段并保留现有修复，不重新启动 Claude`, failedStage);
          if (workflowVersion >= CURRENT_WORKFLOW_VERSION) return processBug(bugIndex);
          throw new PipelineResourceWaitError(failedStage, 'compute-heavy', 'legacy_verification_coverage_disabled');
        }
        const coverageRepairAttempt = Number(latest.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.coverageRepairAttempts || 0) + 1;
        const coverageRepairLimit = 2;
        if (coverageRepairAttempt <= coverageRepairLimit) {
          const coverageTask = latest.bugs?.find((item) => Number(item.bugIndex) === Number(bugIndex))?.task;
          if (!coverageTask?.taskDir) throw new Error(`Bug ${bugIndex} 缺少任务目录，无法从 pristine 重跑`);
          await prepareTrajectoryRetry(latest, coverageTask);
          const retryStage = `bug${bugIndex}_claude_fix`;
          await updateJob(jobFile, (current) => {
            const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
            if (currentBug) {
              currentBug.coverageRepairAttempts = coverageRepairAttempt;
              currentBug.coverageRepairLastError = error.message;
            }
            for (const suffix of ['claude_fix', 'trajectory_validate', 'sol_quality', 'test_author', 'pre_verify', 'docker_validation', 'post_verify', 'git_publication', 'verification_coverage', 'cloud_upload', 'verification_finalize', 'platform_submit', 'delivery_ready']) {
              const stage = current.stages.find((item) => item.id === `bug${bugIndex}_${suffix}`);
              if (!stage) continue;
              stage.status = 'pending';
              stage.startedAt = null;
              stage.finishedAt = null;
              stage.error = '';
              stage.reason = `覆盖复核缺项，从 pristine 完整重跑（${coverageRepairAttempt}/${coverageRepairLimit}）`;
              delete stage.result;
            }
            current.status = workflowVersion >= CURRENT_WORKFLOW_VERSION ? 'running' : 'waiting_resource';
            current.error = '';
            current.finishedAt = null;
            current.currentStage = retryStage;
            if (workflowVersion < CURRENT_WORKFLOW_VERSION) {
              current.waitingResource = null;
              current.schedulerLease = null;
            }
            const execution = normalizeBugExecution(current.bugExecution);
            current.bugExecution = {
              ...execution,
              selectedBugIndex: bugIndex,
              status: 'fast_lane_queued',
              currentStage: retryStage,
              currentAttempt: 0,
              updatedAt: failedAt,
              lastAction: 'coverage_full_rerun_queued',
              blockedReason: '等待 Claude 从 pristine 完整重跑',
            };
            if (currentBug) currentBug.workerExecution = {
              ...(currentBug.workerExecution || {}),
              status: 'fast_lane_queued',
              currentStage: retryStage,
              currentAttempt: 0,
              updatedAt: failedAt,
              lastAction: 'coverage_full_rerun_queued',
              blockedReason: '等待 Claude 从 pristine 完整重跑',
            };
          });
          await appendLog(jobFile, 'warn', `Bug ${bugIndex} 覆盖复核缺项，归档本次修复并从 pristine 完整重跑（${coverageRepairAttempt}/${coverageRepairLimit}）`, failedStage);
          if (workflowVersion >= CURRENT_WORKFLOW_VERSION) return processBug(bugIndex);
          throw new PipelineResourceWaitError(retryStage, 'compute-heavy', 'verification_coverage_repair');
        }
        if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
          await updateJob(jobFile, (current) => {
            markPipelineBugFailed(current, bugIndex, {
              stage: failedStage,
              error: error.message,
              failureCategory,
              at: failedAt,
            });
            const currentBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
            if (currentBug) currentBug.workerExecution = {
              ...(currentBug.workerExecution || {}),
              status: 'fast_lane_failed',
              currentStage: failedStage,
              currentAttempt: 0,
              updatedAt: failedAt,
              lastAction: 'coverage_review_exhausted',
            };
            current.status = 'running';
            current.error = '';
            current.finishedAt = null;
          });
          await appendLog(jobFile, 'error', `Bug ${bugIndex} 验证覆盖复核重试已耗尽，当前 Bug 停止；另一 Bug worker 继续运行`, failedStage);
          return;
        }
        await updateJob(jobFile, (current) => {
          current.status = 'failed';
          current.error = error.message;
          current.finishedAt = failedAt;
          current.currentStage = failedStage;
          const execution = normalizeBugExecution(current.bugExecution);
          current.bugExecution = {
            ...execution,
            status: 'fast_lane_failed',
            currentStage: failedStage,
            updatedAt: failedAt,
            lastAction: 'coverage_review_retry',
          };
        });
        await appendLog(jobFile, 'warn', `Bug ${bugIndex} 验证覆盖复核失败，保留现有证明并仅重试覆盖复核`, failedStage);
        throw error;
      }
      if (!infrastructureFailure && workflowVersion >= CURRENT_WORKFLOW_VERSION && /^bug\d+_/.test(failedStage)) {
        let stageRetry;
        await updateJob(jobFile, (current) => {
          stageRetry = queuePipelineBugStageRetry(current, bugIndex, {
            stage: failedStage,
            error: error.message,
            failureCategory,
            at: failedAt,
            maxRetries: MAX_BUG_STAGE_AUTO_RETRIES,
          });
        });
        if (stageRetry.queued) {
          await appendLog(
            jobFile,
            'warn',
            `Bug ${bugIndex} 的 ${failedStage} 失败，保留已通过检查点并自动重试当前阶段（${stageRetry.retryCount}/${stageRetry.maxRetries}）：${error.message}`,
            failedStage,
          );
          return processBug(bugIndex);
        }
        await appendLog(
          jobFile,
          'error',
          `Bug ${bugIndex} 的 ${failedStage} 自动重试 ${stageRetry.maxRetries} 次后仍失败，停止当前 Bug：${error.message}`,
          failedStage,
        );
      }
      if (infrastructureFailure || !/^bug\d+_/.test(failedStage)) {
        // Project-level and infrastructure failures remain retryable project
        // failures; only Bug-scoped model/validation failures auto-continue.
        await updateJob(jobFile, (current) => {
          if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
            current.pendingFatalFailure = {
              bugIndex,
              failedStage,
              failureCategory,
              message: error.message,
              failedAt,
            };
          } else {
            current.status = 'failed';
            current.error = error.message;
            current.finishedAt = failedAt;
          }
          const execution = normalizeBugExecution(current.bugExecution);
          current.bugExecution = {
            ...execution,
            selectedBugIndex: bugIndex,
            status: 'fast_lane_failed',
            currentStage: failedStage,
            updatedAt: failedAt,
          };
        });
        error.pipelineFatalFailure = {
          bugIndex,
          failedStage,
          failureCategory,
          message: error.message,
          failedAt,
        };
        throw error;
      }

      if (workflowVersion >= CURRENT_WORKFLOW_VERSION) {
        await updateJob(jobFile, (current) => {
          markPipelineBugFailed(current, bugIndex, {
            stage: failedStage,
            error: error.message,
            failureCategory,
            at: failedAt,
          });
          const failedBug = current.bugs.find((item) => Number(item.bugIndex) === Number(bugIndex));
          if (failedBug) failedBug.workerExecution = {
            ...(failedBug.workerExecution || {}),
            status: 'fast_lane_failed',
            currentStage: failedStage,
            currentAttempt: 0,
            updatedAt: failedAt,
            lastAction: 'auto_continue_after_failure',
          };
          current.status = 'running';
          current.error = '';
          current.finishedAt = null;
        });
        await appendLog(jobFile, 'warn', `Bug ${bugIndex} 在 ${failedStage} 失败（${failureCategory}）：${error.message}；另一 Bug worker 继续运行`, failedStage);
        return;
      }

      const nextBug = bugOrder.find((candidate) => candidate > bugIndex
        && !isPipelineBugDeliveryComplete(latest, candidate)
        && !isSkippedPipelineBug(latest.bugs?.find((item) => Number(item.bugIndex) === candidate)))
        || nextIncompleteBugIndex(latest, bugIndex + 1);
      const nextBugStage = nextBug
        ? nextPipelineStage({
            ...latest,
            currentStage: `bug${nextBug}_bug_discovery`,
            bugExecution: { ...normalizeBugExecution(latest.bugExecution), selectedBugIndex: nextBug },
          }) || `bug${nextBug}_bug_discovery`
        : '';
      await updateJob(jobFile, (current) => {
        markPipelineBugFailed(current, bugIndex, {
          stage: failedStage,
          error: error.message,
          failureCategory,
          at: failedAt,
        });
        const execution = normalizeBugExecution(current.bugExecution);
        const shouldPause = execution.autoContinue === false && Boolean(nextBug);
        current.status = shouldPause ? 'stopped' : 'running';
        current.finishedAt = shouldPause ? failedAt : null;
        current.error = shouldPause
          ? `Bug ${bugIndex} 失败，已暂停；下一个未完成 Bug 为 ${nextBug}`
          : '';
        current.currentStage = nextBug ? nextBugStage : null;
        current.bugExecution = {
          ...execution,
          selectedBugIndex: nextBug || bugIndex,
          status: shouldPause ? 'fast_lane_stopped' : nextBug ? 'fast_lane_running' : 'fast_lane_completed',
          startedAt: shouldPause || !nextBug ? null : failedAt,
          currentStage: nextBug ? nextBugStage : '',
          currentAttempt: 0,
          updatedAt: failedAt,
          lastAction: shouldPause ? 'auto_pause_after_failure' : 'auto_continue_after_failure',
          blockedReason: '',
        };
      });
      await appendLog(jobFile, 'warn', nextBug
        ? `Bug ${bugIndex} 在 ${failedStage} 失败（${failureCategory}）：${error.message}；自动切换到 Bug ${nextBug}`
        : `Bug ${bugIndex} 在 ${failedStage} 失败（${failureCategory}）：${error.message}；没有后续未完成 Bug`, failedStage);
      if (normalizeBugExecution(latest.bugExecution).autoContinue === false) return;
    }
  };

  const workerLimit = workflowVersion >= CURRENT_WORKFLOW_VERSION
    ? await currentProjectBugWorkerLimit(job.id)
    : 1;
  await appendLog(jobFile, 'info', `启动单项目 Bug 修复池：当前 ${workerLimit} 路，资源健康时最多 ${PROJECT_BUG_MAX_WORKER_LIMIT} 路`, `bug${selectedBugIndex}_task_prepare`);
  try {
    await runAdaptiveBoundedWorkers(bugOrder, workerLimit, processBug, {
      stopOnError: true,
      refreshLimit: workflowVersion >= CURRENT_WORKFLOW_VERSION
        ? () => currentProjectBugWorkerLimit(job.id)
        : null,
      onLimitChange: ({ previous, current }) => appendLog(
        jobFile,
        'info',
        current > previous
          ? `检测到空闲项目槽位，Bug worker 弹性扩容 ${previous}→${current}`
          : `项目槽位已被占用，Bug worker 完成当前任务后收缩 ${previous}→${current}`,
        `bug${selectedBugIndex}_task_prepare`,
      ),
    });
  } catch (error) {
    if (error?.code !== 'PIPELINE_RESOURCE_WAIT') {
      const fatal = error.pipelineFatalFailure || {};
      await updateJob(jobFile, (current) => {
        current.status = 'failed';
        current.repositoryDisposition = 'failed';
        current.currentStage = fatal.failedStage || current.currentStage;
        current.error = fatal.message || error.message;
        current.finishedAt = fatal.failedAt || now();
        current.runnerPid = null;
        current.schedulerLease = null;
        current.waitingResource = null;
        delete current.pendingFatalFailure;
      });
    }
    throw error;
  }

  // A live Runner never interrupts its current workers for a manual retry.
  // Hand the queued Bug back to the central scheduler once this batch has
  // naturally yielded, so it receives a fresh Runner and its own resources.
  const afterWorkers = await readJson(jobFile);
  const pendingRetryIndexes = [...new Set((afterWorkers.pendingBugRetries || [])
    .map(Number)
    .filter((index) => Number.isInteger(index) && index > 0))].sort((left, right) => left - right);
  if (pendingRetryIndexes.length) {
    const nextRetry = pendingRetryIndexes[0];
    const retryJob = {
      ...afterWorkers,
      currentStage: `bug${nextRetry}_claude_fix`,
      bugExecution: {
        ...normalizeBugExecution(afterWorkers.bugExecution),
        selectedBugIndex: nextRetry,
      },
    };
    const retryStage = nextPipelineStage(retryJob) || `bug${nextRetry}_claude_fix`;
    const profile = pipelineStageResourceProfile(retryStage);
    await updateJob(jobFile, (current) => {
      current.status = 'waiting_resource';
      current.currentStage = retryStage;
      current.error = '';
      current.finishedAt = null;
      current.runnerPid = null;
      current.schedulerLease = null;
      current.waitingResource = {
        stageId: retryStage,
        pool: profile.pool || 'general',
        limit: profile.limit || null,
        queuedAt: current.retryRequestedAt || now(),
        reason: 'manual_bug_retry_after_runner_batch',
      };
      const execution = normalizeBugExecution(current.bugExecution);
      current.bugExecution = {
        ...execution,
        selectedBugIndex: nextRetry,
        status: 'fast_lane_queued',
        startedAt: null,
        currentStage: retryStage,
        blockedReason: '等待中央调度启动重试',
        updatedAt: now(),
      };
      current.logs = [...(current.logs || []), {
        at: now(),
        level: 'info',
        stageId: retryStage,
        message: `当前 Runner 已完成，Bug ${nextRetry} 重试请求交回中央调度队列`,
      }].slice(-300);
    });
    throw new PipelineResourceWaitError(retryStage, profile.pool || 'general', 'manual_bug_retry_after_runner_batch');
  }

  const afterWorkersExecution = normalizeBugExecution(afterWorkers.bugExecution);
  if (afterWorkersExecution.autoContinue === false && afterWorkers.status !== 'stopped') {
    const nextBug = nextIncompleteBugIndex(afterWorkers, Number(afterWorkersExecution.selectedBugIndex || 0) + 1);
    if (nextBug) {
      const nextBugStage = nextPipelineStage({
        ...afterWorkers,
        currentStage: `bug${nextBug}_task_prepare`,
        bugExecution: { ...afterWorkersExecution, selectedBugIndex: nextBug },
      }) || `bug${nextBug}_task_prepare`;
      await updateJob(jobFile, (current) => {
        const execution = normalizeBugExecution(current.bugExecution);
        current.status = 'stopped';
        current.currentStage = nextBugStage;
        current.finishedAt = now();
        current.error = `当前 Bug 已完成，按工作台设置暂停；下一个未完成 Bug 为 ${nextBug}`;
        current.runnerPid = null;
        current.schedulerLease = null;
        current.waitingResource = null;
        current.bugExecution = {
          ...execution,
          selectedBugIndex: nextBug,
          status: 'fast_lane_stopped',
          startedAt: null,
          currentStage: nextBugStage,
          currentAttempt: 0,
          updatedAt: now(),
          lastAction: 'auto_pause_after_delivery',
          blockedReason: '',
        };
      });
      await appendLog(jobFile, 'info', `单 Bug 模式已暂停在下一个未完成 Bug ${nextBug}`, nextBugStage);
      return;
    }
  }

  await updateJob(jobFile, (current) => {
    const summary = pipelineProjectDeliverySummary(current);
    const settled = summary.deliveredBugIndexes.length + summary.failedBugIndexes.length + summary.skippedBugIndexes.length === summary.requested;
    if (!settled) throw new Error('Bug worker 返回后仍有未完成槽位，拒绝提前结束项目');
    current.status = summary.passed ? 'passed' : summary.deliveredBugIndexes.length ? 'stopped' : 'failed';
    current.repositoryDisposition = summary.passed ? 'delivered' : summary.deliveredBugIndexes.length ? 'partial' : 'failed';
    current.currentStage = summary.passed
      ? null
      : current.bugs?.find((bug) => summary.failedBugIndexes.includes(Number(bug.bugIndex)))?.failureStage || null;
    current.finishedAt = now();
    current.error = summary.passed
      ? ''
      : `项目仅交付 ${summary.deliveredBugIndexes.length}/${summary.requested} 个合格 Bug；失败 ${summary.failedBugIndexes.length} 个，跳过 ${summary.skippedBugIndexes.length} 个`;
    const execution = normalizeBugExecution(current.bugExecution);
    current.bugExecution = { ...execution, status: summary.passed ? 'fast_lane_completed' : 'fast_lane_stopped', selectedBugIndex: null, currentStage: '', currentAttempt: 0, updatedAt: now() };
  });
  const completedJob = await readJson(jobFile);
  const completion = pipelineProjectDeliverySummary(completedJob);
  await appendLog(jobFile, completion.passed ? 'success' : 'warn', completion.passed
    ? '流水线全部完成，全部合格任务已进入表格导出集合'
    : completedJob.error);
}

async function stopJob(signal) {
  const stopRequestPath = activeJobFile ? path.join(path.dirname(activeJobFile), 'stop-request.json') : '';
  const stopRequest = stopRequestPath ? await readJson(stopRequestPath, null) : null;
  const stopReason = String(stopRequest?.reason || 'external_signal');
  const stopLabels = {
    user_stopped: '人工停止',
    user_switched: '人工切换 Bug',
    watchdog_retry: '系统看门狗终止并重试',
    watchdog_abandon: '系统看门狗终止并废弃',
    emergency_stop: '系统紧急停止',
    external_signal: '外部进程信号',
  };
  const stopLabel = stopLabels[stopReason] || stopLabels.external_signal;
  await Promise.all([...activeChildren].map((child) => terminateProcessTree(child.pid)));
  if (activeJobFile) {
    await updateJob(activeJobFile, (job) => {
      const stoppedAt = now();
      const activeStageBugIndexes = new Set((job.stages || [])
        .filter((stage) => stage.status === 'running')
        .map((stage) => Number(stage.bugIndex))
        .filter((bugIndex) => Number.isInteger(bugIndex)));
      for (const stage of job.stages || []) {
        if (stage.status !== 'running') continue;
        stage.status = 'pending';
        stage.finishedAt = null;
        stage.error = '';
      }
      for (const bug of job.bugs || []) {
        const hadActiveWork = (bug.attempts || []).some((attempt) => attempt?.status === 'running')
          || activeStageBugIndexes.has(Number(bug.bugIndex));
        while ((bug.attempts || []).some((attempt) => attempt?.status === 'running')) {
          Object.assign(bug, finishBugAttempt(bug, {
            status: 'stopped',
            stage: (bug.attempts || []).findLast((attempt) => attempt?.status === 'running')?.stage || job.currentStage,
            error: `${stopLabel}（${signal}），本次尝试已停止`,
            action: stopReason,
          }, stoppedAt));
        }
        if (bug.workerExecution) {
          const terminalWorker = ['fast_lane_failed', 'fast_lane_completed', 'delivered'].includes(bug.workerExecution.status);
          const resumeAsReady = stopReason === 'watchdog_retry' && !hadActiveWork && !terminalWorker;
          bug.workerExecution = {
            ...bug.workerExecution,
            status: terminalWorker
              ? bug.workerExecution.status
              : resumeAsReady
                ? 'bug_ready'
                : 'fast_lane_stopped',
            // A stop rolls running stages back to pending above.  Do not retain
            // a completed or rolled-back source-preparation cursor: it makes the
            // workbench look as if injection is still running after BUG_BASE and
            // user_query review have already passed.  Failed stages remain
            // visible so their failure can still be retried from the workbench.
            currentStage: (() => {
              const stage = (job.stages || []).find((item) => item.id === bug.workerExecution.currentStage
                && Number(item.bugIndex) === Number(bug.bugIndex));
              return stage && ['running', 'failed'].includes(stage.status)
                ? stage.id
                : '';
            })(),
            startedAt: (() => {
              const stage = (job.stages || []).find((item) => item.id === bug.workerExecution.currentStage
                && Number(item.bugIndex) === Number(bug.bugIndex));
              return stage && ['running', 'failed'].includes(stage.status)
                ? bug.workerExecution.startedAt || null
                : null;
            })(),
            currentAttempt: 0,
            blockedReason: resumeAsReady ? '' : bug.workerExecution.blockedReason || '',
            updatedAt: stoppedAt,
            lastAction: stopReason,
          };
        }
      }
      job.status = 'stopped';
      job.finishedAt = stoppedAt;
      job.error = `${stopLabel}（${signal}），流水线已停止`;
      job.lastStopRequest = stopRequest ? {
        reason: stopReason,
        source: String(stopRequest.source || 'unknown'),
        requestedAt: stopRequest.requestedAt || null,
        runnerPid: Number(stopRequest.runnerPid) || null,
        observedAt: stoppedAt,
      } : {
        reason: stopReason,
        source: 'external_signal',
        requestedAt: null,
        runnerPid: null,
        observedAt: stoppedAt,
      };
      job.logs = [...(job.logs || []), {
        at: stoppedAt,
        level: 'warn',
        stageId: job.currentStage || null,
        message: `${stopLabel}请求来源：${job.lastStopRequest.source}；目标 Runner：${job.lastStopRequest.runnerPid || '未记录'}`,
      }].slice(-300);
      if (stopReason === 'user_stopped') {
        job.manualHold = true;
        delete job.manualRetryRequestedAt;
        delete job.retryRequestedAt;
        delete job.pendingBugRetries;
      }
      const execution = normalizeBugExecution(job.bugExecution);
      job.bugExecution = {
        ...execution,
        status: 'fast_lane_stopped',
        currentAttempt: 0,
        updatedAt: stoppedAt,
        lastAction: stopReason,
      };
    }).catch(() => {});
    if (stopRequestPath) await fsp.rm(stopRequestPath, { force: true }).catch(() => {});
  }
  process.exit(143);
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error('用法：node scripts/run-production-pipeline.mjs <job.json>');
  const jobFile = path.resolve(args[0]);
  startRunnerHeartbeat(jobFile);
  try {
    await runPipeline(jobFile);
    await stopRunnerHeartbeat(jobFile, 'completed');
  } catch (error) {
    if (['PIPELINE_RESOURCE_WAIT', 'PIPELINE_USER_QUERY_REVIEW_WAIT', 'PIPELINE_INJECTION_REVIEW_WAIT', 'PIPELINE_NATURAL_BUG_SEARCH_WAIT'].includes(error?.code)) {
      await stopRunnerHeartbeat(jobFile, error?.code === 'PIPELINE_RESOURCE_WAIT' ? 'waiting_resource' : 'waiting_review');
      return;
    }
    await stopRunnerHeartbeat(jobFile, 'failed');
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.once('SIGTERM', () => { void stopJob('SIGTERM'); });
  process.once('SIGINT', () => { void stopJob('SIGINT'); });
  main().catch(async (error) => {
    if (activeJobFile) {
      await updateJob(activeJobFile, (job) => {
        if (job.status !== 'stopped') job.status = 'failed';
        job.error = error.message;
        job.finishedAt = now();
      }).catch(() => {});
    }
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { acquireStageResourceSlot, assertSchedulerAdmission, bugWorkerOrder, codexSandboxArgs, goModVersion, pipelineHealthPathForJob, readJson, runCommand, safeSlug, shellSingleQuote, verificationCoverageSchema, writeGrader };
