import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { normalizePackageEntries, validateGoPackage, validateGoPackageAgainstBaseline } from './src/package-rules.js';
import { workspaceValidationFingerprint } from './src/workspace-validation-cache.js';
import {
  comparePackageWithWorkspace,
  createPackageSupportFiles,
  isExcludedWorkspacePath,
} from './src/package-build-rules.js';
import { CONTAINER_SHELL_ARGS, createContainerVerificationPlan } from './src/package-runtime-rules.js';
import { parseZipEntries } from './src/zip-reader.js';
import { extractTrajectorySessionId, requireUniquePassedTaskForSession, selectPermanentSignedUrl } from './src/trajectory-upload-rules.js';
import { parseTrajectoryJson } from './src/trajectory-file-validator.js';
import { resolveTrajectoryManifestPrompt, validateTrajectoryManifest } from './src/trajectory-v4.js';
import { platformCompatibleVerificationProofIssues, validateVerificationProofBundle, verificationCommandsSha256 } from './src/verification-proof.js';
import { assertVerificationExportMetadata } from './src/verification-export-rules.js';
import { assertRemoteGitDeliveryLayout, GIT_COMMIT_LAYOUT_POLICY_VERSION, usesFixedGitCommitLayout } from './src/git-delivery-layout.js';
import { buildGoldRootCause, requireDockerHarness } from './src/export-rules.js';
import { createExportValidationTokenStore, EXCEL_EXPORT_VALIDATION_BATCH_SIZE } from './src/export-coordinator.js';
import { extractClaudeCodeVersion, getClaudeHarnessIssues, upsertClaudeCodeHarness } from './src/harness-rules.js';
import {
  githubRepositoryUrls,
  nextSequentialRepositoryName,
  parseGitHubRepositoryNames,
  validateProvisionedRepository,
} from './src/github-repository.js';
import {
  REVIEW_STATUSES,
  annotateIdentityConflicts,
  assertQualifiedIdentitiesUnique,
  assertQualifiedTasksPassHardRules,
  getGitPreparationRuleIssues,
  getGitWorkflowRuleIssues,
  getApplicableGitRuleIssues,
  getGoVersionRuleIssues,
  getHardRuleIssues,
  getProductionFlowRuleIssues,
  isManagedGitPreparation,
  isManagedGitWorkflow,
  isManagedProductionTask,
  normalizeDiagnosisGitMetadata,
  resolvePinnedGoVersion,
} from './src/review-rules.js';
import { createPipelineStages, CURRENT_BUG_POLICY_VERSION, CURRENT_BUGFIX_REPAIR_POLICY_VERSION, CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION, CURRENT_VERIFICATION_POLICY_VERSION, CURRENT_WORKFLOW_POLICY_VERSION, CURRENT_WORKFLOW_VERSION, DEFAULT_BUG_COUNT, isPipelineBugDeliveryComplete, pipelineBugQuota, pipelineStageLayoutMatches, pipelineTaskOutcome, pipelineUserQueryReadiness, publicPipelineJob, reactivateFailedPipelineBugsForManualRetry, reactivateFrozenVerificationFailures, reactivatePipelineBug, rewindPipelineBugAfterMissingTrajectory, upgradeSubmissionPlatformStageLayout, upgradeUnfinishedPipelineBugQuota, validatePipelineRequest } from './src/pipeline-rules.js';
import {
  buildPlatformReviewSnapshot,
  buildSubmissionActivityStats,
  DEFAULT_SUBMISSION_PLATFORM_URL,
  deferredPlatformBugIndexes,
  extractPlatformSubmissionItems,
  extractPlatformSubmissionTotal,
  findPlatformSubmissionByBugId,
  findPlatformSubmissionForRecord,
  isLegacyDeliveredPlatformBackfill,
  isReadmeOnlyPlatformRepairReason,
  isSubmissionPlatformUnavailableError,
  mergePlatformSubmissionReview,
  mergePlatformCookies,
  platformApiMessage,
  platformCsrfToken,
  platformImportState,
  platformSubmissionFingerprint,
  platformSubmissionId,
  preparePlatformSubmission,
  reopenDeferredPlatformSubmissions,
} from './src/submission-platform.js';
import { enqueueBugRetry, normalizeBugExecution, nextIncompleteBugIndex } from './src/bug-workbench.js';
import { classifyPipelineFailure, isPipelineAutofillEligible, isRetryablePipelineStartError, isStaleQueuedPipelineReservation, MAX_PIPELINE_AUTO_RETRIES, MAX_PIPELINE_CONCURRENCY, pipelineAbandonmentState, pipelineAutofillStartCapacity, pipelineOccupiedJobIds, pipelineResumeUsesExistingAdmission, pipelineRetryState, queuePipelineManualRetry, reconcilePipelineCloudUpload, reopenPipelineAbandonmentForManualRetry, selectPipelineAutofillCandidates } from './src/pipeline-concurrency.js';
import {
  allocateProjectDomainFamilies,
  allocatePipelineTaskTypes,
  applyPipelineTaskTypePolicy,
  advancePipelineTaskTypeCounts,
  autoRefillProjectTiers,
  normalizePipelineRefillPlan,
  PIPELINE_REFILL_BATCH_SIZE,
  PIPELINE_REFILL_FAILURE_COOLDOWN_MS,
  PIPELINE_INCOMPLETE_PROJECT_LIMIT,
  PIPELINE_TASK_TYPE_POLICY_VERSION,
  normalizePipelineTaskTypeCounts,
  countIncompletePipelineProjects,
  normalizeLargeProjectCanary,
  pipelineRefillCapacity,
  publicPipelineRefillState,
  recordLargeProjectCanaryJob,
  reconcileLargeProjectCanary,
  reconcilePipelineRefillCreatedJobs,
  shouldStartPipelineRefill,
} from './src/pipeline-refill.js';
import { prohibitedProjectDomainPolicyText } from './src/project-domain-rules.js';
import { normalizePipelineRolloutState, pipelineRolloutDecision, rolloutEligibleJobs } from './src/pipeline-rollout.js';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAJECTORY_FILENAME_PATTERN = /^trajectory_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl?$/i;
import {
  collectHostResourceSnapshot,
  normalizePipelineControlMode,
  parseDockerBuildxReclaimableBytes,
  parseDockerSize,
  parsePipelineRunnerProcesses,
  pipelineDailyBudget,
  pipelineDependencyServiceForIncident,
  pipelineDiskCleanupPlan,
  pipelineDockerMaintenanceAction,
  pipelineJobStartBlockers,
  pipelineHardStallTerminationScope,
  nextPipelineStage,
  pipelineOccupiedWeight,
  pipelineResourcePoolState,
  pipelineResourcePolicy,
  pipelineStageResourceProfile,
  pipelineStageStartCapacity,
  parseOrphanedPipelineProcesses,
  shouldQueuePipelineRetry,
  triageActionPlan,
} from './src/pipeline-operations.js';
import {
  PIPELINE_HEALTH_INTERVAL_MS,
  PIPELINE_WATCHDOG_INTERVAL_MS,
  pipelineProjectThroughputMonitor,
  pipelineWatchdogObservation,
  recoverInterruptedPipelineTriages,
} from './src/pipeline-watchdog.js';
import { pipelinePerformanceSnapshot } from './src/pipeline-performance.js';
import {
  cloudUploadRetryDelayMs,
  createCloudPublicState,
  isCloudAuthenticationFailure,
  isCloudTransientFailure,
  shouldRetryCloudUpload,
} from './src/cloud-auth-rules.js';
import { datastoreIntegrityDecision } from './src/data-protection.js';
import { assertVerificationCoverage, VERIFICATION_COVERAGE_POLICY_VERSION } from './src/verification-coverage.js';
import { modelVerificationPlanIssues } from './src/model-verification.js';
import { PROJECT_QUALITY_POLICY_VERSION } from './src/generated-project-quality.js';
import { CURRENT_PROJECT_PACKAGE_POLICY_VERSION, projectPackageRuleOptions } from './src/project-package-policy.js';
import { assessBugDifficulty, BUG_DIFFICULTY_POLICY_VERSION, assignFrontendFlags, validateUserQueryDraft } from './src/bug-policy.js';
import { isInjectionReviewStale, isUserQueryReviewStale, INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS, USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS } from './src/pipeline-review.js';
import { classifySubmissionQualityIncident, isContributorQualityBlocked, normalizeSubmissionQualityState, recordSubmissionQualityIncident } from './src/submission-quality.js';
import { DOCKER_RUN_CPU_LIMIT, explicitDockerVerifyCmds, packagedDockerVerifyCmds, publicTargetCommandForTask } from './scripts/run-production-pipeline.mjs';
import { withFileLock } from './src/file-lock.js';
import { validateManualRecoveryBundle } from './src/manual-recovery.js';
import { hasCurrentArchivedExportPolicy, mergeArchivedTaskRecords } from './src/task-archive.js';
import {
  assertRemoteLeaseOwner,
  claimRemoteRepairJob,
  completeRemoteRepairJob,
  DISTRIBUTED_WORKER_PROTOCOL_VERSION,
  mergeRemoteJobSnapshot,
  nodeRoleCanExecuteStage,
  normalizePipelineNodeRole,
  PIPELINE_NODE_ROLES,
  remoteRepairClaimable,
  renewRemoteRepairLease,
} from './src/distributed-workers.js';

const port = Number(process.env.GO_TASK_MONITOR_API_PORT || 4174);
const apiHost = String(process.env.GO_TASK_MONITOR_API_HOST || '127.0.0.1').trim() || '127.0.0.1';
const configuredPipelineNodeRole = String(process.env.GO_PIPELINE_NODE_ROLE || '').trim().toLowerCase();
if (configuredPipelineNodeRole && !PIPELINE_NODE_ROLES.has(configuredPipelineNodeRole)) {
  throw new Error(`GO_PIPELINE_NODE_ROLE 不合法：${configuredPipelineNodeRole}`);
}
const pipelineNodeRole = normalizePipelineNodeRole(configuredPipelineNodeRole);
const remoteWorkerToken = String(process.env.GO_PIPELINE_WORKER_TOKEN || '').trim();
const pipelineReleaseId = String(process.env.GO_PIPELINE_RELEASE_ID || '').trim();
const configuredRemoteLeaseTtlMs = Number(process.env.GO_PIPELINE_REMOTE_LEASE_TTL_MS || 90_000);
const REMOTE_LEASE_TTL_MS = Number.isFinite(configuredRemoteLeaseTtlMs)
  ? Math.max(30_000, Math.min(10 * 60_000, configuredRemoteLeaseTtlMs))
  : 90_000;
const REMOTE_TASK_PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const startupRecoveryEnabled = process.env.GO_TASK_MONITOR_STARTUP_RECOVERY !== '0';
if (pipelineNodeRole === 'producer' && remoteWorkerToken.length < 32) {
  throw new Error('producer 模式必须设置至少 32 字符的 GO_PIPELINE_WORKER_TOKEN');
}
const projectRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.resolve(process.env.GO_TASK_MONITOR_WORK_ROOT || path.join(projectRoot, '.task_work'));
if (pipelineNodeRole === 'producer') {
  const workRootRelativeToProtectedCode = path.relative(projectRoot, workRoot);
  if (!workRootRelativeToProtectedCode || (!workRootRelativeToProtectedCode.startsWith('..') && !path.isAbsolute(workRootRelativeToProtectedCode))) {
    throw new Error('producer 的 GO_TASK_MONITOR_WORK_ROOT 必须放在系统代码父目录之外，避免 Claude 保护沙箱同时锁住运行数据');
  }
}
const managedLibraryRoot = path.join(workRoot, 'go-task-library');
const datastoreProtectionRoot = path.join(workRoot, '.go-task-monitor-protection');
const datastoreSentinelPath = path.join(datastoreProtectionRoot, 'datastore-sentinel.json');
const tasksRoot = path.join(managedLibraryRoot, 'tasks');
const runnerPath = path.join(import.meta.dirname, 'run_one_claude.sh');
const pipelineRunnerPath = path.join(import.meta.dirname, 'scripts/run-production-pipeline.mjs');
const pipelineJobsRoot = path.join(managedLibraryRoot, 'pipeline-jobs');
const pipelineRefillRoot = path.join(managedLibraryRoot, 'pipeline-refill');
const pipelineJobBackupsRoot = path.join(pipelineRefillRoot, 'job-backups');
const pipelineRefillStatePath = path.join(pipelineRefillRoot, 'state.json');
const pipelineSchedulerStatePath = path.join(pipelineRefillRoot, 'scheduler.json');
const pipelineWatchdogStatePath = path.join(pipelineRefillRoot, 'watchdog.json');
const pipelineHealthStatePath = path.join(pipelineRefillRoot, 'health.json');
const pipelineAlertsStatePath = path.join(pipelineRefillRoot, 'alerts.json');
const remoteWorkersStatePath = path.join(pipelineRefillRoot, 'remote-workers.json');
const submissionQualityStatePath = path.join(pipelineRefillRoot, 'submission-quality.json');
function resolveCliPath(configured, command, candidates) {
  if (configured) return configured;
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || command;
}

const githubCliPath = resolveCliPath(process.env.GO_PIPELINE_GH_BIN, 'gh', [
  path.join(os.homedir(), '.local/bin/gh'),
]);

const codexCliPath = resolveCliPath(process.env.GO_PIPELINE_CODEX_BIN, 'codex', [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  path.join(os.homedir(), '.local/bin/codex'),
]);
const configuredCodexInferenceProbeIntervalMs = Number(process.env.GO_PIPELINE_CODEX_INFERENCE_PROBE_INTERVAL_MS || 5 * 60_000);
const CODEX_INFERENCE_PROBE_INTERVAL_MS = Number.isFinite(configuredCodexInferenceProbeIntervalMs)
  && configuredCodexInferenceProbeIntervalMs > 0
  ? Math.max(60_000, configuredCodexInferenceProbeIntervalMs)
  : 5 * 60_000;
const configuredCodexInferenceProbeCooldownMs = Number(process.env.GO_PIPELINE_CODEX_INFERENCE_PROBE_COOLDOWN_MS || 2 * 60_000);
const CODEX_INFERENCE_PROBE_COOLDOWN_MS = Number.isFinite(configuredCodexInferenceProbeCooldownMs)
  && configuredCodexInferenceProbeCooldownMs > 0
  ? Math.max(30_000, configuredCodexInferenceProbeCooldownMs)
  : 2 * 60_000;
const configuredCodexInferenceProbeTimeoutMs = Number(process.env.GO_PIPELINE_CODEX_INFERENCE_PROBE_TIMEOUT_MS || 45_000);
const CODEX_INFERENCE_PROBE_TIMEOUT_MS = Number.isFinite(configuredCodexInferenceProbeTimeoutMs)
  && configuredCodexInferenceProbeTimeoutMs > 0
  ? Math.max(15_000, configuredCodexInferenceProbeTimeoutMs)
  : 45_000;
const claudeCliPath = resolveCliPath(process.env.GO_TASK_MONITOR_CLAUDE_BIN || process.env.GO_PIPELINE_CLAUDE_BIN, 'claude', [
  path.join(os.homedir(), '.npm-global/bin/claude'),
  path.join(os.homedir(), '.local/bin/claude'),
]);
const cloudUploadBaseUrl = process.env.GO_TASK_MONITOR_CLOUD_URL || 'https://upload.jzxhnh.com';
const cloudEnvironmentAccount = String(process.env.GO_TASK_MONITOR_CLOUD_USERNAME || '').trim();
const cloudEnvironmentPassword = String(process.env.GO_TASK_MONITOR_CLOUD_PASSWORD || '');
const cloudEnvironmentLoginConfigured = Boolean(cloudEnvironmentAccount && cloudEnvironmentPassword);
const CLOUD_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const cloudUploadsPath = path.join(managedLibraryRoot, 'validation/trajectory_uploads.json');
const cloudUploadsLockPath = `${cloudUploadsPath}.lock`;
const cloudSessionPath = path.join(managedLibraryRoot, 'validation/cloud_session.json');
const cloudKeychainSourcePath = path.join(import.meta.dirname, 'scripts/cloud-keychain.swift');
const cloudKeychainBinaryPath = path.join(workRoot, '.bin/cloud-keychain');
const cloudKeychainService = `go-task-monitor.cloud-upload.${crypto.createHash('sha256').update(cloudUploadBaseUrl).digest('hex').slice(0, 12)}`;
const cloudHealthCheckIntervalMs = 2 * 60 * 1000;
const submissionPlatformBaseUrl = String(process.env.GO_SUBMISSION_PLATFORM_URL || DEFAULT_SUBMISSION_PLATFORM_URL).replace(/\/$/, '');
const submissionPlatformApiUrl = `${submissionPlatformBaseUrl}/api/v1`;
const submissionPlatformSessionPath = path.join(managedLibraryRoot, 'validation/submission_platform_session.json');
const submissionPlatformControlPath = path.join(managedLibraryRoot, 'validation/submission_platform_control.json');
const submissionPlatformRecordsPath = path.join(managedLibraryRoot, 'validation/platform_submissions.json');
const submissionPlatformRecordsLockPath = `${submissionPlatformRecordsPath}.lock`;
const submissionPlatformReviewSnapshotPath = path.join(managedLibraryRoot, 'validation/platform_review_snapshot.json');
const submissionPlatformKeychainService = `go-task-monitor.submission-platform.${crypto.createHash('sha256').update(submissionPlatformBaseUrl).digest('hex').slice(0, 12)}`;
const SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const SUBMISSION_PLATFORM_PAGE_SIZE = 50;
function optionalPositiveLimit(value) {
  const parsed = Number(value);
  return String(value || '').trim() && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

const pipelineDailyProjectLimit = optionalPositiveLimit(process.env.GO_PIPELINE_DAILY_PROJECT_LIMIT);
const pipelineDailyTrajectoryLimit = optionalPositiveLimit(process.env.GO_PIPELINE_DAILY_TRAJECTORY_LIMIT);
const pipelineAlertWebhookUrl = String(process.env.GO_PIPELINE_ALERT_WEBHOOK_URL || '').trim();
const reviewStatusesPath = path.join(managedLibraryRoot, 'validation/review_statuses.json');
const reviewStatusesLockPath = `${reviewStatusesPath}.lock`;
const taskExportRecordsPath = path.join(managedLibraryRoot, 'validation/task_exports.json');
const archivedTasksPath = path.join(managedLibraryRoot, 'validation/archived_tasks.json');
const archivedTrajectoriesRoot = path.join(managedLibraryRoot, 'validation/archived-trajectories');
const packageValidationsPath = path.join(managedLibraryRoot, 'validation/package_validations.json');
const packagesRoot = path.join(managedLibraryRoot, 'packages');
const packageEvidenceRoot = path.join(managedLibraryRoot, 'package-evidence');
const labelExportRecordsPath = path.join(import.meta.dirname, 'public/label_export_records.json');

const clients = new Set();
const activeProcesses = new Map();
const activePipelineProcesses = new Map();
const pipelineStopRequests = new Set();
const pollTimers = new Map();
let cloudSessionCookie = '';
let cloudConnectedAs = '';
let cloudAutoLoginAccount = '';
let cloudAutoLoginConfigured = false;
let cloudAuthEpoch = 0;
let cloudAuthRefreshPromise = null;
let cloudHealthCheckPromise = null;
let cloudLastCheckedAt = null;
let cloudLastRefreshedAt = null;
let cloudLastError = '';
const cloudUploadTails = new Map();
let submissionPlatformCookie = '';
let submissionPlatformConnectedAs = '';
let submissionPlatformAutoLoginAccount = '';
let submissionPlatformAutoLoginConfigured = false;
let submissionPlatformAuthEpoch = 0;
let submissionPlatformAuthRefreshPromise = null;
let submissionPlatformLastCheckedAt = null;
let submissionPlatformLastRefreshedAt = null;
let submissionPlatformLastError = '';
const submissionPlatformSubmitTails = new Map();
let submissionPlatformReviewSyncPromise = null;
let submissionPlatformReviewLastSyncedAt = null;
let submissionPlatformReviewLastError = '';
let submissionPlatformSyncPaused = false;
let submissionPlatformSyncPausedAt = null;
let submissionPlatformSyncPauseReason = '';
let automaticUploadRunning = false;
let pipelineCloudReconcileRunning = false;
const automaticUploadRetryAt = new Map();
let reviewUpdateTail = Promise.resolve();
let taskExportUpdateTail = Promise.resolve();
const excelExportValidationTokens = createExportValidationTokenStore({ createToken: () => crypto.randomUUID() });
let bulkTrajectoryExportRunning = false;
const trajectoryMetadataCache = new Map();
const trajectoryHardRuleCache = new Map();
const workspaceProjectValidationCache = new Map();
let labelExportRecordsCache = { mtimeMs: -1, records: new Map() };
let taskDiscoveryCache = { expiresAt: 0, value: null, promise: null, generation: 0 };
const TASK_DISCOVERY_CACHE_TTL_MS = 60_000;
const TASK_DISCOVERY_DIRTY_SNAPSHOT_TTL_MS = 30_000;
const TASK_DISCOVERY_CONCURRENCY = 4;
const PIPELINE_JOBS_CACHE_TTL_MS = 5_000;
let pipelineJobsCache = { expiresAt: 0, value: null, promise: null, generation: 0 };
const pipelineJobListEntryCache = new Map();
let datastoreWatchHandle = null;
let datastoreEventTimer = null;
let datastoreEventDueAt = 0;
let lastPipelineEventProcessedAt = 0;
const pendingDatastoreEventTypes = new Set();
const DATASTORE_EVENT_DEBOUNCE_MS = 1_500;
const PIPELINE_EVENT_THROTTLE_MS = 15_000;

function invalidateTaskDiscoveryCache({ graceMs = 0 } = {}) {
  taskDiscoveryCache.expiresAt = taskDiscoveryCache.value && graceMs > 0
    // Cap the stale snapshot's remaining lifetime. A sliding deadline would
    // keep an old task list alive forever while busy pipelines write files.
    ? Math.min(taskDiscoveryCache.expiresAt, Date.now() + graceMs)
    : 0;
  taskDiscoveryCache.generation += 1;
  if (!graceMs) workspaceProjectValidationCache.clear();
}

function invalidatePipelineJobsCache() {
  pipelineJobsCache.value = null;
  pipelineJobsCache.expiresAt = 0;
  pipelineJobsCache.generation += 1;
}

function scheduleDatastoreEvent(type = 'data') {
  const normalizedType = type === 'pipeline' ? 'pipeline' : 'data';
  pendingDatastoreEventTypes.add(normalizedType);
  const now = Date.now();
  const dataPending = pendingDatastoreEventTypes.has('data');
  const desiredAt = dataPending
    ? now + DATASTORE_EVENT_DEBOUNCE_MS
    : Math.max(now + DATASTORE_EVENT_DEBOUNCE_MS, lastPipelineEventProcessedAt + PIPELINE_EVENT_THROTTLE_MS);
  // Keep an earlier scheduled flush. Repeated three-second runner heartbeats
  // must not keep moving the timer or force the browser to download the full
  // job history on every write.
  if (datastoreEventTimer && datastoreEventDueAt <= desiredAt) return;
  if (datastoreEventTimer) clearTimeout(datastoreEventTimer);
  datastoreEventDueAt = desiredAt;
  datastoreEventTimer = setTimeout(() => {
    datastoreEventTimer = null;
    datastoreEventDueAt = 0;
    const eventTypes = new Set(pendingDatastoreEventTypes);
    pendingDatastoreEventTypes.clear();
    const taskDataChanged = eventTypes.has('data');
    if (eventTypes.has('pipeline')) lastPipelineEventProcessedAt = Date.now();
    if (taskDataChanged) invalidateTaskDiscoveryCache({ graceMs: TASK_DISCOVERY_DIRTY_SNAPSHOT_TTL_MS });
    broadcast(taskDataChanged ? 'data' : 'pipeline');
    // Runner heartbeats update job.json frequently. They must refresh the
    // workbench, but must not invalidate the pipeline cache or trigger a full
    // task-library discovery and cloud reconciliation on every write. The
    // five-second cache TTL coalesces external runner writes; API-owned writes
    // invalidate explicitly in writePipelineJob(). Task/verification files
    // have their own data event and periodic reconciliation remains a fallback.
    if (taskDataChanged) {
      void autoUploadCompletedTrajectories();
      void reconcileUploadedPipelineJobs();
    }
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
  }, Math.max(0, desiredAt - now));
  datastoreEventTimer.unref?.();
}

async function startDatastoreWatcher() {
  await fsp.mkdir(managedLibraryRoot, { recursive: true });
  try {
    datastoreWatchHandle = fs.watch(managedLibraryRoot, { recursive: true }, (_eventType, filename) => {
      const normalized = String(filename || '').replaceAll('\\', '/');
      if (!normalized || /(?:^|\/)job\.json$/.test(normalized)) return scheduleDatastoreEvent('pipeline');
      if (/^pipeline-refill\//.test(normalized)) return scheduleDatastoreEvent('pipeline');
      if (/^validation\//.test(normalized) || /(?:^|\/)public\.json$/.test(normalized)) scheduleDatastoreEvent('data');
    });
    datastoreWatchHandle.on('error', (error) => addLog('warn', `数据事件监听已降级为定时巡检：${error.message}`));
  } catch (error) {
    addLog('warn', `数据事件监听不可用，使用定时巡检：${error.message}`);
  }
}
let repositoryProvisioningTail = Promise.resolve();
let pipelineStartTail = Promise.resolve();
let pipelineAutoFillEnabled = false;
let pipelineControlMode = 'running';
let pipelineRefillPaused = false;
let pipelineAutoFillRunning = false;
let pipelineFillRetryTimer = null;
const manualPipelineRetryTimers = new Map();
let pipelineAutoRefillRunning = false;
let pipelineRolloutState = normalizePipelineRolloutState();
let pipelineWatchdogRunning = false;
let pipelineCodexTriageRunning = false;
let pipelineHealthCheckRunning = false;
let pipelineHealthState = { updatedAt: null, services: {} };
let codexInferenceProbeHealth = null;
let pipelineAlertTail = Promise.resolve();
let pipelineResourceMaintenanceRunning = false;
let remoteWorkerMutationTail = Promise.resolve();
let dockerGraderCpuGuardRunning = false;
let pipelineLastResourceMaintenanceAt = null;
let pipelineResourceMaintenanceState = { status: 'idle', requestedAt: null, startedAt: null, finishedAt: null, retryAfter: null, reason: '', error: '' };
const RESOURCE_SLOT_ACQUIRE_GRACE_MS = 30_000;
let submissionQualityState = { updatedAt: null, incidents: [], blockedContributors: [] };
let pipelineRateLimitCooldownUntil = 0;
let datastoreIntegrityCheckPromise = null;
let datastoreProtectionState = { status: 'initializing', checkedAt: null, taskCount: 0, jobCount: 0, message: '' };
const pipelineServiceOnlineStreaks = new Map();
const state = {
  status: 'idle',
  message: '等待启动',
  total: 0,
  completed: 0,
  failed: 0,
  currentTasks: [],
  concurrency: 4,
  queue: [],
  logs: [],
  startedAt: null,
  finishedAt: null,
  phase: 'idle',
};

function publicState() {
  return JSON.parse(JSON.stringify(state));
}

function publicTask(task) {
  const { sourceId, taskDir, ...value } = task;
  return value;
}

function broadcast(type = 'snapshot') {
  const payload = `data: ${JSON.stringify({ type, state: publicState() })}\n\n`;
  for (const response of clients) response.write(payload);
}

function addLog(level, message) {
  state.logs.push({ at: new Date().toISOString(), level, message: String(message).trim().slice(0, 500) });
  if (state.logs.length > 60) state.logs.splice(0, state.logs.length - 60);
  broadcast('log');
}

async function readPipelineAlerts() {
  try {
    const value = JSON.parse(await fsp.readFile(pipelineAlertsStatePath, 'utf8'));
    return { updatedAt: value.updatedAt || null, records: Array.isArray(value.records) ? value.records : [] };
  } catch {
    return { updatedAt: null, records: [] };
  }
}

async function emitPipelineAlert({ key, severity = 'warning', title, message, resolved = false }) {
  const operation = pipelineAlertTail.then(async () => {
    const alerts = await readPipelineAlerts();
    const now = new Date().toISOString();
    const previous = [...alerts.records].reverse().find((item) => item.key === key);
    if (previous && previous.resolved === resolved && previous.message === message && Date.now() - Date.parse(previous.at) < 10 * 60_000) return previous;
    const record = {
      id: `alert-${crypto.randomUUID()}`,
      key,
      severity,
      title: sanitizeMonitorText(title).slice(0, 160),
      message: sanitizeMonitorText(message).slice(0, 1200),
      resolved: Boolean(resolved),
      at: now,
      webhook: pipelineAlertWebhookUrl ? 'pending' : 'disabled',
    };
    alerts.records = [...alerts.records, record].slice(-200);
    alerts.updatedAt = now;
    if (pipelineAlertWebhookUrl) {
      try {
        const response = await fetch(pipelineAlertWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'go-task-monitor', ...record }),
          signal: AbortSignal.timeout(15_000),
        });
        record.webhook = response.ok ? 'sent' : `http_${response.status}`;
      } catch (error) {
        record.webhook = 'failed';
        record.webhookError = sanitizeMonitorText(error.message).slice(0, 300);
      }
    }
    await fsp.mkdir(path.dirname(pipelineAlertsStatePath), { recursive: true });
    const temporary = `${pipelineAlertsStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(alerts, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, pipelineAlertsStatePath);
    return record;
  });
  pipelineAlertTail = operation.catch(() => {});
  return operation;
}

function pipelineJobFile(jobId) {
  if (!/^pipeline-[a-z0-9-]+$/i.test(jobId)) throw new Error('流水线作业 ID 不合法');
  return path.join(pipelineJobsRoot, jobId, 'job.json');
}

function pipelineJobBackupFile(jobId) {
  if (!/^pipeline-[a-z0-9-]+$/i.test(jobId)) throw new Error('流水线作业 ID 不合法');
  return path.join(pipelineJobBackupsRoot, `${jobId}.json`);
}

async function writePipelineJobContent(filename, content) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, content, 'utf8');
  await fsp.rename(temporary, filename);
}

async function readPipelineJob(jobId) {
  let raw;
  try {
    raw = await fsp.readFile(pipelineJobFile(jobId), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        raw = await fsp.readFile(pipelineJobBackupFile(jobId), 'utf8');
        await writePipelineJobContent(pipelineJobFile(jobId), raw);
      } catch {
        return null;
      }
    } else {
      throw error;
    }
  }
  // A runner can be interrupted while an older deployment is creating a job
  // directory. Keep one incomplete artifact from taking down the whole API;
  // the refill loop will create a replacement and the original remains for
  // later recovery/audit instead of being deleted implicitly.
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    // A previous injection-review continuation could be queued immediately
    // before the resource-capacity check. Restore the human topic-review gate
    // on read so a full Runner pool never hides the editor/buttons.
    if (parsed.status === 'queued' && parsed.bugExecution?.lastAction === 'injection_review_continue') {
      const nextReview = (parsed.stages || []).find((stage) => stage.stage === 'user_query_review'
        && !['passed', 'skipped'].includes(stage.status));
      if (nextReview) {
        parsed.status = 'waiting_review';
        parsed.currentStage = nextReview.id;
        parsed.waitingResource = null;
        parsed.bugExecution = {
          ...normalizeBugExecution(parsed.bugExecution),
          status: 'bug_ready',
          currentStage: nextReview.id,
          blockedReason: '等待人工编辑并确认 user_query',
        };
        parsed.updatedAt = new Date().toISOString();
        await writePipelineJob(parsed);
      }
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writePipelineJob(job) {
  const filename = pipelineJobFile(job.id);
  const content = `${JSON.stringify(job, null, 2)}\n`;
  await writePipelineJobContent(filename, content);
  await writePipelineJobContent(pipelineJobBackupFile(job.id), content);
  invalidatePipelineJobsCache();
  scheduleDatastoreEvent('pipeline');
}

function remoteWorkerAuthorized(request) {
  if (!remoteWorkerToken) return false;
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!supplied) return false;
  const expectedHash = crypto.createHash('sha256').update(remoteWorkerToken).digest();
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(expectedHash, suppliedHash);
}

function assertRemoteWorkerAuthorized(request) {
  if (pipelineNodeRole !== 'producer') {
    const error = new Error('当前节点没有启用 producer 远程派单模式');
    error.statusCode = 409;
    throw error;
  }
  if (!remoteWorkerAuthorized(request)) {
    const error = new Error('远程 Worker 认证失败');
    error.statusCode = 401;
    throw error;
  }
}

function normalizeRemoteWorkerIdentity(value = {}) {
  const workerId = String(value.workerId || '').trim();
  const role = normalizePipelineNodeRole(value.role);
  const protocolVersion = Number(value.protocolVersion || 0);
  const codeVersion = String(value.codeVersion || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(workerId)) throw new Error('workerId 必须是 3-64 位字母、数字、点、下划线或短横线');
  if (role !== 'repair-worker') throw new Error('A/B 模式当前只接受 repair-worker');
  if (protocolVersion !== DISTRIBUTED_WORKER_PROTOCOL_VERSION) {
    throw new Error(`Worker 协议版本不兼容：需要 ${DISTRIBUTED_WORKER_PROTOCOL_VERSION}，收到 ${protocolVersion || 'none'}`);
  }
  if (pipelineReleaseId && codeVersion && codeVersion !== pipelineReleaseId) {
    throw new Error(`Worker 代码版本不一致：A=${pipelineReleaseId}，B=${codeVersion || 'unknown'}`);
  }
  return { workerId, role, protocolVersion, codeVersion };
}

async function readRemoteWorkersState() {
  try {
    const value = JSON.parse(await fsp.readFile(remoteWorkersStatePath, 'utf8'));
    return {
      protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
      workers: Array.isArray(value.workers) ? value.workers : [],
      updatedAt: value.updatedAt || null,
    };
  } catch {
    return { protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION, workers: [], updatedAt: null };
  }
}

async function writeRemoteWorkersState(value) {
  const stateValue = {
    protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
    workers: Array.isArray(value.workers) ? value.workers.slice(-50) : [],
    updatedAt: new Date().toISOString(),
  };
  await writePipelineJobContent(remoteWorkersStatePath, `${JSON.stringify(stateValue, null, 2)}\n`);
  return stateValue;
}

async function recordRemoteWorker(identity, details = {}) {
  const stateValue = await readRemoteWorkersState();
  const observedAt = new Date().toISOString();
  const previous = stateValue.workers.find((worker) => worker.workerId === identity.workerId);
  const worker = {
    ...(previous || {}),
    workerId: identity.workerId,
    role: identity.role,
    protocolVersion: identity.protocolVersion,
    status: details.status || previous?.status || 'online',
    hostname: String(details.hostname || previous?.hostname || '').slice(0, 120),
    platform: String(details.platform || previous?.platform || '').slice(0, 120),
    codeVersion: String(details.codeVersion || previous?.codeVersion || '').slice(0, 120),
    currentJobId: details.currentJobId === undefined ? previous?.currentJobId || '' : String(details.currentJobId || ''),
    registeredAt: previous?.registeredAt || observedAt,
    lastHeartbeatAt: observedAt,
  };
  stateValue.workers = [...stateValue.workers.filter((item) => item.workerId !== identity.workerId), worker];
  await writeRemoteWorkersState(stateValue);
  return worker;
}

function withRemoteWorkerMutation(action) {
  const operation = remoteWorkerMutationTail.then(action);
  remoteWorkerMutationTail = operation.catch(() => {});
  return operation;
}

async function claimRemoteRepairAssignment(identity, details = {}) {
  return withRemoteWorkerMutation(async () => {
    if (pipelineReleaseId && identity.codeVersion !== pipelineReleaseId) {
      throw new Error(`Worker 代码版本不一致：A=${pipelineReleaseId}，B=${identity.codeVersion || 'unknown'}`);
    }
    const visibleJobs = await listPipelineJobsFresh();
    const jobs = (await Promise.all(visibleJobs.map((job) => readPipelineJob(job.id)))).filter(Boolean);
    const nowMs = Date.now();
    const candidate = jobs
      .filter((job) => remoteRepairClaimable(job, nowMs))
      .sort((left, right) => String(left.waitingResource?.queuedAt || left.updatedAt || left.createdAt || '')
        .localeCompare(String(right.waitingResource?.queuedAt || right.updatedAt || right.createdAt || '')))[0];
    if (!candidate) {
      await recordRemoteWorker(identity, { ...details, status: 'idle', currentJobId: '' });
      return null;
    }
    const leaseId = crypto.randomUUID();
    const claimed = claimRemoteRepairJob(candidate, {
      workerId: identity.workerId,
      leaseId,
      leaseTtlMs: REMOTE_LEASE_TTL_MS,
    });
    claimed.logs = [...(claimed.logs || []), {
      at: claimed.remoteExecution.claimedAt,
      level: 'info',
      stageId: claimed.currentStage,
      message: `B 电脑 ${identity.workerId} 已领取远程修复租约 ${leaseId}`,
    }].slice(-300);
    await writePipelineJob(claimed);
    await recordRemoteWorker(identity, { ...details, status: 'busy', currentJobId: claimed.id });
    return { leaseId, expiresAt: claimed.remoteExecution.expiresAt, job: claimed };
  });
}

async function heartbeatRemoteRepairAssignment(jobId, identity, leaseId, details = {}) {
  return withRemoteWorkerMutation(async () => {
    const job = await readPipelineJob(jobId);
    if (!job) throw new Error('远程租约对应的项目不存在');
    const renewed = renewRemoteRepairLease(job, {
      workerId: identity.workerId,
      leaseId,
      leaseTtlMs: REMOTE_LEASE_TTL_MS,
      status: 'running',
    });
    await writePipelineJob(renewed);
    await recordRemoteWorker(identity, { ...details, status: 'busy', currentJobId: jobId });
    return {
      expiresAt: renewed.remoteExecution.expiresAt,
      cancelRequested: renewed.remoteExecution.status === 'cancel_requested',
      cancelReason: renewed.remoteExecution.cancelReason || '',
    };
  });
}

async function acceptRemoteJobSnapshot(jobId, identity, leaseId, snapshot) {
  return withRemoteWorkerMutation(async () => {
    const current = await readPipelineJob(jobId);
    if (!current) throw new Error('远程快照对应的项目不存在');
    if (current.remoteExecution?.status === 'cancel_requested') {
      const error = new Error('远程项目已经收到停止请求');
      error.code = 'REMOTE_CANCEL_REQUESTED';
      throw error;
    }
    let merged = mergeRemoteJobSnapshot(current, snapshot, {
      workerId: identity.workerId,
      leaseId,
    });
    merged = renewRemoteRepairLease(merged, {
      workerId: identity.workerId,
      leaseId,
      leaseTtlMs: REMOTE_LEASE_TTL_MS,
      status: 'running',
    });
    await writePipelineJob(merged);
    await recordRemoteWorker(identity, { status: 'busy', currentJobId: jobId });
    return merged;
  });
}

async function finishRemoteRepairAssignment(jobId, identity, leaseId, snapshot, outcome) {
  return withRemoteWorkerMutation(async () => {
    const current = await readPipelineJob(jobId);
    if (!current) throw new Error('远程完成回报对应的项目不存在');
    assertRemoteLeaseOwner(current, identity.workerId, leaseId);
    let merged = snapshot
      ? mergeRemoteJobSnapshot(current, snapshot, { workerId: identity.workerId, leaseId })
      : structuredClone(current);
    const effectiveOutcome = outcome === 'passed' && snapshot?.status === 'passed'
      ? 'passed'
      : outcome === 'stopped' || current.remoteExecution?.status === 'cancel_requested'
        ? 'stopped'
        : 'failed';
    merged = completeRemoteRepairJob(merged, {
      workerId: identity.workerId,
      leaseId,
      outcome: effectiveOutcome,
    });
    if (effectiveOutcome === 'failed' && !merged.error) merged.error = '远程 repair-worker 异常结束';
    merged.logs = [...(merged.logs || []), {
      at: merged.finishedAt,
      level: effectiveOutcome === 'passed' ? 'success' : effectiveOutcome === 'stopped' ? 'warn' : 'error',
      stageId: merged.currentStage,
      message: `B 电脑 ${identity.workerId} 远程修复结束：${effectiveOutcome}`,
    }].slice(-300);
    await writePipelineJob(merged);
    await recordRemoteWorker(identity, { status: 'idle', currentJobId: '' });
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
    return merged;
  });
}

async function publicRemoteWorkerState() {
  const stateValue = await readRemoteWorkersState();
  const now = Date.now();
  return {
    enabled: pipelineNodeRole === 'producer',
    nodeRole: pipelineNodeRole,
    protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION,
    leaseTtlMs: REMOTE_LEASE_TTL_MS,
    workers: stateValue.workers.map((worker) => ({
      ...worker,
      status: now - Date.parse(worker.lastHeartbeatAt || '') > REMOTE_LEASE_TTL_MS * 2 ? 'offline' : worker.status,
    })),
  };
}

async function writePipelineStopRequest(jobId, reason, source = 'monitor') {
  const filename = path.join(path.dirname(pipelineJobFile(jobId)), 'stop-request.json');
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const runnerPid = Number(activePipelineProcesses.get(jobId)?.pid) || null;
  await fsp.writeFile(temporary, `${JSON.stringify({
    version: 2,
    reason,
    source,
    requestedAt: new Date().toISOString(),
    runnerPid,
  }, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
  addLog('warn', `流水线停止请求：${jobId}（${reason}/${source}，Runner ${runnerPid || '未接管'}）`);
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

async function activePipelineResourceSlotSnapshot() {
  const slotsRoot = path.join(pipelineRefillRoot, 'resource-slots');
  const pools = await fsp.readdir(slotsRoot, { withFileTypes: true }).catch(() => []);
  const counts = Object.fromEntries([
    'codex-structured',
    'project-bootstrap',
    'project-generation',
    'compute-analysis',
    'compute-repair',
    'compute-proof',
    'compute-docker',
    'compute-heavy',
  ].map((pool) => [pool, 0]));
  const jobIds = {};
  for (const pool of pools) {
    if (!pool.isDirectory()) continue;
    const poolRoot = path.join(slotsRoot, pool.name);
    const slots = await fsp.readdir(poolRoot, { withFileTypes: true }).catch(() => []);
    for (const slot of slots) {
      if (!slot.isDirectory()) continue;
      const slotDir = path.join(poolRoot, slot.name);
      const owner = await fsp.readFile(path.join(slotDir, 'owner.json'), 'utf8')
        .then((value) => JSON.parse(value))
        .catch(() => null);
      const slotStat = owner ? null : await fsp.stat(slotDir).catch(() => null);
      const publishing = !owner && slotStat && Date.now() - slotStat.mtimeMs <= RESOURCE_SLOT_ACQUIRE_GRACE_MS;
      if (!publishing && (!owner || !processIsAlive(Number(owner.pid)))) continue;
      counts[pool.name] = Number(counts[pool.name] || 0) + 1;
      const jobId = owner?.jobFile ? path.basename(path.dirname(owner.jobFile)) : '';
      if (jobId) {
        jobIds[pool.name] ||= [];
        jobIds[pool.name].push(jobId);
      }
    }
  }
  // Runners started before the shared structured-Codex pool was introduced
  // may still hold one of the two legacy leases. Count them during the rolling
  // reload so a new planner cannot overbook the same upstream capacity.
  counts['codex-structured'] += Number(counts['project-planning'] || 0)
    + Number(counts['compute-test-author'] || 0);
  return { counts, jobIds };
}

async function scanPipelineRunnerProcesses() {
  const result = await runCapturedCommand('ps', ['-axo', 'pid=,command='], { cwd: import.meta.dirname, timeoutMs: 15_000 });
  if (result.exitCode !== 0) return new Map();
  return parsePipelineRunnerProcesses(result.stdout, pipelineRunnerPath);
}

async function adoptPipelineRunnerProcesses() {
  const found = await scanPipelineRunnerProcesses();
  let adopted = 0;
  for (const [jobId, info] of found) {
    if (activePipelineProcesses.has(jobId) || !processIsAlive(info.pid)) continue;
    const ownedJob = await readPipelineJob(jobId);
    if (!ownedJob) continue;
    activePipelineProcesses.set(jobId, { pid: info.pid, child: null, adopted: true, command: info.command });
    adopted += 1;
  }
  if (adopted) addLog('info', `服务重启后已接管 ${adopted} 个仍在运行的流水线 Runner`);
  return adopted;
}

async function reapOrphanedPipelineProcesses() {
  const result = await runCapturedCommand('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    cwd: import.meta.dirname,
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) return 0;
  const terminalStatuses = new Set(['stopped', 'failed', 'abandoned', 'passed']);
  const candidates = parseOrphanedPipelineProcesses(result.stdout);
  const reapedJobs = new Set();
  for (const candidate of candidates) {
    if (candidate.pid === process.pid || !processIsAlive(candidate.pid)) continue;
    const job = await readPipelineJob(candidate.jobId).catch(() => null);
    if (!job || !terminalStatuses.has(job.status)) continue;
    try {
      process.kill(-candidate.pgid, 'SIGTERM');
    } catch {
      try { process.kill(candidate.pid, 'SIGTERM'); } catch {}
    }
    reapedJobs.add(candidate.jobId);
    if (job.runnerPid || job.schedulerLease) {
      job.runnerPid = null;
      job.schedulerLease = null;
      job.updatedAt = new Date().toISOString();
      await writePipelineJob(job).catch(() => {});
    }
  }
  if (reapedJobs.size) {
    addLog('warn', `已回收 ${reapedJobs.size} 个终态作业遗留的 Runner 子进程：${[...reapedJobs].join(', ')}`);
  }
  return reapedJobs.size;
}

async function reconcileAdoptedPipelineProcesses() {
  let changed = false;
  for (const [jobId, handle] of activePipelineProcesses) {
    if (!handle.adopted || processIsAlive(handle.pid)) continue;
    activePipelineProcesses.delete(jobId);
    pipelineStopRequests.delete(jobId);
    const job = await readPipelineJob(jobId);
    if (job && ['queued', 'running'].includes(job.status)) {
      job.status = 'failed';
      job.error = 'Runner 进程已经退出，但没有写入任务终态';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await writePipelineJob(job);
    }
    changed = true;
    addLog('warn', `已回收退出的接管 Runner：${jobId}`);
  }
  if (changed && pipelineAutoFillEnabled) void fillPipelineSlots();
}

async function readPipelineRefillState() {
  try {
    return JSON.parse(await fsp.readFile(pipelineRefillStatePath, 'utf8'));
  } catch {
    return {
      status: 'idle',
      specs: [],
      createdJobIds: [],
      taskTypePolicyVersion: PIPELINE_TASK_TYPE_POLICY_VERSION,
      taskTypeCounts: { bugfix: 0, diagnosis: 0 },
      largeProjectCanary: normalizeLargeProjectCanary(),
    };
  }
}

async function writePipelineRefillState(value) {
  await fsp.mkdir(pipelineRefillRoot, { recursive: true });
  const temporary = `${pipelineRefillStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, pipelineRefillStatePath);
}

async function configureLargeProjectCanary(count) {
  const targetCount = Math.max(0, Math.floor(Number(count) || 0));
  const current = await readPipelineRefillState();
  if (['planning', 'provisioning'].includes(current.status)) {
    throw new Error('自动补题批次正在规划或创建，完成后才能设置超大型试跑额度');
  }
  const now = new Date().toISOString();
  const largeProjectCanary = normalizeLargeProjectCanary({
    id: targetCount ? `large-canary-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}` : '',
    targetCount,
    createdJobIds: [],
    requestedAt: targetCount ? now : null,
    updatedAt: now,
  });
  await writePipelineRefillState({ ...current, largeProjectCanary });
  addLog('info', targetCount
    ? `已设置超大型项目自动补题试跑：接下来 ${largeProjectCanary.targetCount} 个实际创建的项目使用超大型规格`
    : '已取消超大型项目自动补题试跑，后续恢复标准规格');
  return largeProjectCanary;
}

async function readPipelineSchedulerState() {
  try {
    return JSON.parse(await fsp.readFile(pipelineSchedulerStatePath, 'utf8'));
  } catch {
    return { autoFillEnabled: true, controlMode: 'running', rollout: normalizePipelineRolloutState() };
  }
}

async function writePipelineSchedulerState() {
  await fsp.mkdir(pipelineRefillRoot, { recursive: true });
  const temporary = `${pipelineSchedulerStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({
    autoFillEnabled: pipelineAutoFillEnabled,
    controlMode: pipelineControlMode,
    refillPaused: pipelineRefillPaused,
    rollout: pipelineRolloutState,
    rateLimitCooldownUntil: pipelineRateLimitCooldownUntil || null,
    resourceMaintenance: pipelineResourceMaintenanceState,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, pipelineSchedulerStatePath);
}

async function readSubmissionQualityState() {
  try {
    return normalizeSubmissionQualityState(JSON.parse(await fsp.readFile(submissionQualityStatePath, 'utf8')));
  } catch {
    return normalizeSubmissionQualityState();
  }
}

async function writeSubmissionQualityState(value) {
  await fsp.mkdir(path.dirname(submissionQualityStatePath), { recursive: true });
  const temporary = `${submissionQualityStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, submissionQualityStatePath);
}

async function recordTerminalSubmissionQualityIncident(job) {
  const contributorId = String(job?.request?.contributorId || job?.request?.creator || '').trim();
  if (!contributorId || Number(job?.projectQualityPolicyVersion || 0) < PROJECT_QUALITY_POLICY_VERSION) return;
  const incident = classifySubmissionQualityIncident(job);
  if (!incident) return;
  const retry = pipelineRetryState(job);
  if (!retry.exhausted && !job.abandonmentApprovedAt) return;
  const result = recordSubmissionQualityIncident(submissionQualityState, {
    contributorId,
    jobId: job.id,
    type: incident.type,
    reason: incident.reason,
  });
  if (!result.added) return;
  submissionQualityState = result.state;
  await writeSubmissionQualityState(submissionQualityState);
  const incidentCount = new Set(submissionQualityState.incidents
    .filter((item) => item.contributorId === contributorId)
    .map((item) => item.jobId)).size;
  addLog('warn', `${contributorId} 的项目质量事故 ${incident.type}：${job.id}（累计 ${incidentCount} 个不同项目）`);
  if (result.blocked && pipelineControlMode === 'running') {
    pipelineAutoFillEnabled = false;
    pipelineControlMode = 'paused';
    await writePipelineSchedulerState();
    addLog('error', `${contributorId} 已达到质量事故熔断阈值，自动补题与调度已暂停，等待人工复核`);
  }
}

async function setPipelineAutoFillEnabled(enabled) {
  pipelineAutoFillEnabled = Boolean(enabled);
  if (pipelineAutoFillEnabled) pipelineControlMode = 'running';
  else if (pipelineControlMode === 'running') pipelineControlMode = 'paused';
  await writePipelineSchedulerState();
}

async function setPipelineControlMode(mode) {
  pipelineControlMode = normalizePipelineControlMode(mode, pipelineAutoFillEnabled);
  pipelineAutoFillEnabled = pipelineControlMode === 'running';
  await writePipelineSchedulerState();
}

async function managedDatastoreCounts() {
  const countDirectories = async (root, predicate = () => true) => {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && predicate(entry.name)).length;
  };
  return {
    taskCount: await countDirectories(tasksRoot),
    jobCount: await countDirectories(pipelineJobsRoot, (name) => /^pipeline-[a-z0-9-]+$/i.test(name)),
  };
}

async function checkDatastoreIntegrity() {
  if (datastoreIntegrityCheckPromise) return datastoreIntegrityCheckPromise;
  datastoreIntegrityCheckPromise = (async () => {
    const current = await managedDatastoreCounts();
    let previous = null;
    try {
      previous = JSON.parse(await fsp.readFile(datastoreSentinelPath, 'utf8'));
    } catch {}
    const decision = datastoreIntegrityDecision(previous, current);
    const checkedAt = new Date().toISOString();
    if (decision.trip || previous?.status === 'tripped') {
      const reasons = decision.trip ? decision.missing : (previous.reasons || ['数据目录熔断尚未解除']);
      pipelineAutoFillEnabled = false;
      pipelineControlMode = 'paused';
      datastoreProtectionState = {
        status: 'tripped',
        checkedAt,
        ...current,
        reasons,
        message: `检测到数据目录异常：${reasons.join('；')}，已暂停调度并禁止自动补题`,
      };
      await fsp.mkdir(datastoreProtectionRoot, { recursive: true, mode: 0o700 });
      const sentinel = {
        status: 'tripped',
        taskCount: Number(previous?.taskCount || decision.previous.taskCount),
        jobCount: Number(previous?.jobCount || decision.previous.jobCount),
        observed: current,
        reasons,
        checkedAt,
      };
      const temporary = `${datastoreSentinelPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, `${JSON.stringify(sentinel, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporary, datastoreSentinelPath);
      await writePipelineSchedulerState();
      addLog('error', datastoreProtectionState.message);
      return false;
    }

    datastoreProtectionState = { status: 'healthy', checkedAt, ...current, message: '数据目录完整性正常' };
    if (!previous || previous.taskCount !== current.taskCount || previous.jobCount !== current.jobCount || previous.status !== 'healthy') {
      await fsp.mkdir(datastoreProtectionRoot, { recursive: true, mode: 0o700 });
      const temporary = `${datastoreSentinelPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, `${JSON.stringify({ status: 'healthy', ...current, checkedAt }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporary, datastoreSentinelPath);
    }
    return true;
  })();
  try {
    return await datastoreIntegrityCheckPromise;
  } finally {
    datastoreIntegrityCheckPromise = null;
  }
}

async function updatePipelineRollout(next, message = '') {
  const normalized = normalizePipelineRolloutState({ ...pipelineRolloutState, ...next, updatedAt: new Date().toISOString() });
  const changed = normalized.mode !== pipelineRolloutState.mode || normalized.canaryJobId !== pipelineRolloutState.canaryJobId;
  pipelineRolloutState = normalized;
  if (changed) {
    await writePipelineSchedulerState();
    if (message) addLog('info', message);
    void emitPipelineAlert({
      key: 'rollout:mode',
      severity: normalized.mode === 'v2_live' ? 'info' : 'warning',
      title: `流水线切换为 ${normalized.mode}`,
      message: message || `canary=${normalized.canaryJobId || 'none'}`,
      resolved: normalized.mode === 'v2_live',
    });
  }
  return changed;
}

async function listPipelineJobs() {
  if (pipelineJobsCache.value && Date.now() < pipelineJobsCache.expiresAt) return pipelineJobsCache.value;
  if (pipelineJobsCache.promise) return pipelineJobsCache.promise;
  const generation = pipelineJobsCache.generation;
  const discovery = listPipelineJobsFresh();
  pipelineJobsCache.promise = discovery;
  try {
    const value = await discovery;
    if (generation === pipelineJobsCache.generation) {
      pipelineJobsCache.value = value;
      pipelineJobsCache.expiresAt = Date.now() + PIPELINE_JOBS_CACHE_TTL_MS;
    }
    return value;
  } finally {
    if (pipelineJobsCache.promise === discovery) pipelineJobsCache.promise = null;
  }
}

async function listPipelineJobsFresh() {
  await fsp.mkdir(pipelineJobsRoot, { recursive: true });
  const watchdog = await readPipelineWatchdogState();
  const jobs = [];
  const liveJobIds = new Set();
  for (const entry of await fsp.readdir(pipelineJobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^pipeline-[a-z0-9-]+$/i.test(entry.name)) continue;
    liveJobIds.add(entry.name);
    const filename = pipelineJobFile(entry.name);
    let restoredJob = null;
    let stat = await fsp.stat(filename).catch(() => null);
    if (!stat) {
      restoredJob = await readPipelineJob(entry.name);
      stat = restoredJob ? await fsp.stat(filename).catch(() => null) : null;
      if (!stat) {
        pipelineJobListEntryCache.delete(entry.name);
        continue;
      }
    }
    // Runners publish job.json by atomically renaming a new file. The inode,
    // mtime and size therefore provide a cheap identity for an unchanged job.
    // Reusing its parsed/public form keeps historical jobs out of the hot path
    // while active jobs still become visible within the normal five-second TTL.
    const fingerprint = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    let cached = pipelineJobListEntryCache.get(entry.name);
    if (!cached || cached.fingerprint !== fingerprint) {
      const parsed = restoredJob || await readPipelineJob(entry.name);
      cached = parsed ? { fingerprint, job: parsed, visible: publicPipelineJob(parsed) } : null;
      if (cached) pipelineJobListEntryCache.set(entry.name, cached);
      else pipelineJobListEntryCache.delete(entry.name);
    }
    const job = cached?.job || null;
    if (job) {
      const handle = activePipelineProcesses.get(job.id);
      const relatedIncidents = watchdog.incidents.filter((incident) => incident.jobId === job.id && incident.status !== 'resolved');
      const latestIncident = relatedIncidents.at(-1);
      const visible = {
        ...cached.visible,
        processActive: Boolean(handle) || ['leased', 'running', 'cancel_requested'].includes(String(job.remoteExecution?.status || '')),
        processPid: handle?.pid || null,
        processAdopted: Boolean(handle?.adopted),
        ...(latestIncident?.triage ? {
          watchdogTriage: {
            incidentId: latestIncident.id,
            fingerprint: latestIncident.fingerprint,
            category: latestIncident.triage.category,
            conclusion: latestIncident.triage.conclusion,
            recommendedAction: latestIncident.triage.recommended_action,
            projectDisposition: latestIncident.triage.project_disposition,
            finishedAt: latestIncident.triageFinishedAt,
            actionStatus: latestIncident.actionStatus || '',
          },
        } : {}),
      };
      const observation = pipelineWatchdogObservation(visible);
      const matchingIncident = observation && relatedIncidents.find((incident) => incident.fingerprint === observation.fingerprint && incident.type === observation.type);
      visible.watchdogTriagePending = Boolean(observation?.codexTriage
        && visible.status === 'failed'
        && !['triaged'].includes(matchingIncident?.status));
      jobs.push(visible);
    }
  }
  for (const jobId of pipelineJobListEntryCache.keys()) {
    if (!liveJobIds.has(jobId)) pipelineJobListEntryCache.delete(jobId);
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function runGitHubCli(args, label) {
  let result;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await runCapturedCommand(githubCliPath, args, { cwd: import.meta.dirname, timeoutMs: 2 * 60 * 1000 });
    if (result.exitCode === 0 || !isTransientGitHubFailure(result) || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 800));
  }
  if (result.exitCode !== 0) {
    const detail = compactCapturedOutput(result).replace(/gho_[A-Za-z0-9_]+/g, '[redacted]').slice(-4000);
    throw new Error(`${label}失败${detail ? `：${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function isTransientGitHubFailure(result = {}) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`;
  return result.timedOut
    || /\bHTTP\s*5\d{2}\b|No server is currently available|temporarily unavailable|connection reset|ECONNRESET|ETIMEDOUT/i.test(text);
}

function repositoryNameFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.hostname !== 'github.com') return '';
    return parsed.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/i, '') || '';
  } catch {
    return '';
  }
}

async function getSequentialRepositoryStatus() {
  const configuredOwner = String(process.env.GO_PIPELINE_GITHUB_OWNER || '').trim();
  const owner = configuredOwner || await runGitHubCli([
    'auth', 'status', '--active', '--json', 'hosts',
    '--jq', '.hosts["github.com"][] | select(.active == true) | .login',
  ], '读取 GitHub 登录账号');
  const remoteRaw = await runGitHubCli(['repo', 'list', owner, '--limit', '1000', '--json', 'name'], '读取 GitHub 仓库列表');
  const remoteNames = parseGitHubRepositoryNames(remoteRaw);
  const localNames = (await listPipelineJobs()).map((job) => repositoryNameFromUrl(job.request?.repository)).filter(Boolean);
  const nextName = nextSequentialRepositoryName(new Set([...remoteNames, ...localNames]));
  const next = githubRepositoryUrls(owner, nextName);
  return { connected: true, owner, nextName, repository: next.repository };
}

async function withRepositoryProvisioningLock(action) {
  const previous = repositoryProvisioningTail;
  let release;
  repositoryProvisioningTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

async function provisionNextSequentialRepository() {
  return withRepositoryProvisioningLock(async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const status = await getSequentialRepositoryStatus();
      const expected = githubRepositoryUrls(status.owner, status.nextName);
      try {
        await runGitHubCli([
          'repo', 'create', expected.nameWithOwner,
          '--public',
          '--description', 'Generated Go benchmark project',
          '--disable-issues',
          '--disable-wiki',
        ], `创建 GitHub 空仓库 ${expected.nameWithOwner}`);
      } catch (error) {
        if (attempt < 3 && /already exists|name already exists/i.test(error.message)) continue;
        throw error;
      }
      const viewRaw = await runGitHubCli([
        'repo', 'view', expected.nameWithOwner,
        '--json', 'nameWithOwner,isPrivate,isEmpty,url,sshUrl',
      ], `验证 GitHub 仓库 ${expected.nameWithOwner}`);
      validateProvisionedRepository(JSON.parse(viewRaw), expected);
      return { ...expected, createdAt: new Date().toISOString() };
    }
    throw new Error('连续三次分配 GitHub 仓库编号冲突，请刷新后重试');
  });
}

async function createPipelineJob(input) {
  if (!await checkDatastoreIntegrity()) throw new Error(datastoreProtectionState.message);
  const validated = validatePipelineRequest(input);
  if (!validated.ok) throw new Error(validated.issues.join('；'));
  if (pipelineControlMode !== 'running') throw new Error(`流水线当前为 ${pipelineControlMode}，不创建新仓库`);
  if (isContributorQualityBlocked(submissionQualityState, validated.value.contributorId)) {
    throw new Error(`提交人 ${validated.value.contributorId} 已触发项目质量事故熔断，不能创建新题目`);
  }
  const jobs = await listPipelineJobs();
  if (input?.autoRefillBatchId && countIncompletePipelineProjects(jobs) >= PIPELINE_INCOMPLETE_PROJECT_LIMIT) {
    throw new Error(`未完成项目已达到 ${PIPELINE_INCOMPLETE_PROJECT_LIMIT} 个，暂停自动补题规划`);
  }
  const resourcePolicy = currentPipelineResourcePolicy();
  const budget = currentPipelineBudget(jobs);
  if (!resourcePolicy.canCreate) throw new Error(`主机资源保护已启用：${resourcePolicy.blockers.join('；')}`);
  if (!budget.canCreateProject) throw new Error(`已达到 ${budget.day} 的显式自动化预算：项目 ${budget.createdProjects}/${budget.projectLimit ?? '不限'}，轨迹 ${budget.deliveredTrajectories}/${budget.trajectoryLimit ?? '不限'}`);
  if (pipelineHealthState.services?.git?.status !== 'online') throw new Error('GitHub 当前不可用，暂停创建新仓库');
  const provisionedRepository = await provisionNextSequentialRepository();
  const id = `pipeline-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  const jobDir = path.join(pipelineJobsRoot, id);
  const job = {
    id,
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION,
    bugfixRepairPolicyVersion: CURRENT_BUGFIX_REPAIR_POLICY_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    submissionPlatformPolicyVersion: CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
    // The semantic verify_cmds coverage review is retired. V5 independent
    // red/green proof validation remains enabled through verificationPolicyVersion.
    verificationCoveragePolicyVersion: 0,
    projectQualityPolicyVersion: PROJECT_QUALITY_POLICY_VERSION,
    projectPackagePolicyVersion: CURRENT_PROJECT_PACKAGE_POLICY_VERSION,
    status: 'draft',
    request: {
      ...validated.value,
      repository: provisionedRepository.repository,
      cloneUrl: provisionedRepository.cloneUrl,
      repositoryName: provisionedRepository.name,
      repositoryOwner: provisionedRepository.owner,
      repositoryCreatedAt: provisionedRepository.createdAt,
      creator: validated.value.contributorId,
      ...(input.autoRefillBatchId ? {
        autoRefillBatchId: String(input.autoRefillBatchId),
        autoRefillQuestionIndex: Number(input.autoRefillQuestionIndex),
        autoRefillTitle: String(input.autoRefillTitle || '').trim(),
        ...(input.replacesPipelineJobId ? { replacesPipelineJobId: String(input.replacesPipelineJobId) } : {}),
        ...(input.largeProjectCanaryId ? {
          largeProjectCanaryId: String(input.largeProjectCanaryId),
          largeProjectCanaryIndex: Number(input.largeProjectCanaryIndex),
        } : {}),
      } : {}),
    },
    jobDir,
    tasksRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    currentStage: null,
    stages: createPipelineStages(
      validated.value.bugCount,
      CURRENT_WORKFLOW_VERSION,
      CURRENT_VERIFICATION_POLICY_VERSION,
      validated.value.taskType,
      CURRENT_WORKFLOW_POLICY_VERSION,
      CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION,
    ),
    bugs: [],
    bugExecution: normalizeBugExecution({ autoContinue: true, status: 'bug_ready' }),
    repositoryDisposition: 'provisioned',
    logs: [],
    error: '',
    autoRetryCount: 0,
  };
  await writePipelineJob(job);
  return publicPipelineJob(job);
}

function pipelineRefillSchema(count) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'projectBrief', 'projectDomain'],
          properties: {
            title: { type: 'string', minLength: 6 },
            projectBrief: { type: 'string', minLength: 60 },
            projectDomain: { type: 'string' },
          },
        },
      },
    },
  };
}

function extractCodexSessionId(jsonl) {
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const sessionId = event.thread_id || event.session_id || event?.thread?.id || event?.result?.session_id;
      if (sessionId) return String(sessionId);
    } catch {}
  }
  return '';
}

async function runCodexPipelineRefillPlan(batchId, jobs, {
  targetCount,
  taskTypes,
  projectTiers,
  frontendFlags,
}) {
  const assignedProjectTiers = Array.from({ length: targetCount }, (_, index) => (
    projectTiers?.[index] === 'large' ? 'large' : 'standard'
  ));
  const projectTierAssignments = assignedProjectTiers.map((tier, index) => tier === 'large'
    ? `${index + 1}. 超大型：生产 Go 代码至少 5000 行、至少 50 个生产 Go 文件、30 个独立 Bug`
    : `${index + 1}. 标准：生产 Go 代码最低 2000 行、目标约 2500 行并控制在 2000-3000 行附近、至少 20 个生产 Go 文件、10 个独立 Bug`);
  const projectDomains = allocateProjectDomainFamilies(jobs, targetCount);
  const batchDir = path.join(pipelineRefillRoot, batchId);
  await fsp.mkdir(batchDir, { recursive: true });
  const schemaPath = path.join(batchDir, 'questions.schema.json');
  const outputPath = path.join(batchDir, 'questions.json');
  const eventsPath = path.join(batchDir, 'codex.jsonl');
  const stderrPath = path.join(batchDir, 'codex.stderr.log');
  await fsp.writeFile(schemaPath, `${JSON.stringify(pipelineRefillSchema(targetCount), null, 2)}\n`, 'utf8');
  const history = jobs.slice(0, 40).map((job) => ({
    repository: job.request?.repository || '',
    title: job.request?.autoRefillTitle || '',
    projectBrief: job.request?.projectBrief || '',
    projectName: job.project?.project_name || job.project?.project_slug || '',
    projectDomain: job.request?.projectDomain || '',
  }));
  const prompt = [
    `为 Go 题目生产流水线规划 ${targetCount} 个互不重复的原创 0-1 项目题目，只做项目选题和需求规划，不写代码、不搜索或克隆现有仓库。`,
    prohibitedProjectDomainPolicyText(),
    '只描述选定领域本身，不要在题目或项目要求中重复“不是订单/财务/前端”等禁用领域排除说明；系统会单独执行领域门禁。',
    '每个项目要求必须使用中文且至少 60 个字符，具备真实业务语境、并发或状态管理、错误处理，以及可确定复现的公开测试空间。',
    `系统已按近期低频优先分配领域。第 1 到第 ${targetCount} 题必须依次使用以下 projectDomain，不得交换、重复或自行改名：\n${projectDomains.map((domain, index) => `${index + 1}. ${domain.id}（${domain.label}）`).join('\n')}`,
    '每个项目只保留一个连贯业务流程，最多 6 个核心组件、8 条验收标准。复杂度维度不作为硬门禁，重点保证生产 Go 文件数、有效代码量、真实业务闭环和可复现测试；不要用无关子系统或重复代码填充规模。项目生成不设按时长终止的硬上限，Claude 应持续完成代码、测试和自测，不得为了赶时间删减质量。',
    `${targetCount} 个项目的领域、核心状态模型和失效边界必须彼此不同，也不能与历史项目重复。后续 Claude 将从零生成项目；所有 Bug 都从同一个初始 main 建立独立支线。`,
    `本批次规模由系统逐题预先分配，不得自行降级、升级或交换：\n${projectTierAssignments.join('\n')}\n超大型项目必须让规模来自真实业务组件、持久化、并发状态和公开测试，不得用注释、空行、重复实现、死代码或无关子系统填充。`,
    '自动批次会把至少 30% 的项目标记为必须包含真实前端页面。前端只负责业务交互且不计入 Go 行数，仍必须包含可编译、可运行的 Go 后端。',
    '不要在项目要求中预先泄漏具体 Bug、修复方式、Gold 答案、提交记录或隐藏测试。',
    `需要避开的历史项目：\n${JSON.stringify(history, null, 2)}`,
    '仅返回符合指定 schema 的 JSON。',
  ].join('\n\n');
  const result = await runCapturedCommand(codexCliPath, [
    'exec', '--ephemeral', '--ignore-user-config', '-c', 'model_reasoning_effort="low"',
    '--skip-git-repo-check', '-C', batchDir, '-s', 'read-only', '--json',
    '--output-schema', schemaPath, '-o', outputPath, prompt,
  ], { cwd: batchDir, timeoutMs: 60 * 60 * 1000 });
  await fsp.writeFile(eventsPath, result.stdout || '', 'utf8');
  await fsp.writeFile(stderrPath, result.stderr || result.error || '', 'utf8');
  if (result.exitCode !== 0) {
    const detail = compactCapturedOutput(result).slice(-3000);
    throw new Error(`Codex 自动找题失败（exit=${result.exitCode ?? 'none'}）${detail ? `：${detail}` : ''}`);
  }
  const output = JSON.parse(await fsp.readFile(outputPath, 'utf8'));
  return {
    specs: normalizePipelineRefillPlan(output, {
      count: targetCount,
      taskTypes,
      projectTiers: assignedProjectTiers,
      frontendFlags,
      projectDomains,
    }),
    sessionId: extractCodexSessionId(result.stdout),
  };
}

async function abandonTerminalPipelineJobs() {
  let abandoned = 0;
  for (const visibleJob of await listPipelineJobs()) {
    const state = pipelineAbandonmentState(visibleJob);
    if (!state.shouldAbandon || activePipelineProcesses.has(visibleJob.id)) continue;
    const job = await readPipelineJob(visibleJob.id);
    if (!job || !pipelineAbandonmentState(job).shouldAbandon) continue;
    const abandonedAt = new Date().toISOString();
    job.status = 'abandoned';
    job.abandonedAt = abandonedAt;
    job.abandonReason = state.reason;
    job.failureCategory = state.failureCategory;
    job.repositoryDisposition = 'retained_abandoned';
    job.updatedAt = abandonedAt;
    job.finishedAt = job.finishedAt || abandonedAt;
    job.logs = [...(job.logs || []), {
      at: abandonedAt,
      level: 'warn',
      stageId: job.currentStage || null,
      message: state.reason === 'non_retryable'
        ? '项目已确认不可恢复，自动废弃并请求同类型替补题目'
        : `项目达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重试上限，自动废弃并请求同类型替补题目`,
    }].slice(-300);
    await writePipelineJob(job);
    abandoned += 1;
    addLog('warn', `流水线 ${job.id} 已废弃，将自动补充一个 ${job.request?.taskType || '同类型'} 项目`);
  }
  return abandoned;
}

async function linkPipelineReplacement(sourceJobId, replacementJobId) {
  if (!sourceJobId) return;
  const source = await readPipelineJob(sourceJobId);
  if (!source || source.status !== 'abandoned' || source.replacementJobId === replacementJobId) return;
  const linkedAt = new Date().toISOString();
  source.replacementJobId = replacementJobId;
  source.replacementCreatedAt = linkedAt;
  source.updatedAt = linkedAt;
  source.logs = [...(source.logs || []), {
    at: linkedAt,
    level: 'success',
    stageId: source.currentStage || null,
    message: `替补流水线已创建：${replacementJobId}`,
  }].slice(-300);
  await writePipelineJob(source);
}

async function readPipelineWatchdogState() {
  try {
    const value = JSON.parse(await fsp.readFile(pipelineWatchdogStatePath, 'utf8'));
    return { ...value, updatedAt: value.updatedAt || null, incidents: Array.isArray(value.incidents) ? value.incidents : [] };
  } catch {
    return { updatedAt: null, incidents: [], projectThroughput: {} };
  }
}

async function writePipelineWatchdogState(value) {
  await fsp.mkdir(path.dirname(pipelineWatchdogStatePath), { recursive: true });
  const temporary = `${pipelineWatchdogStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, pipelineWatchdogStatePath);
}

async function readPipelineHeartbeat(jobId) {
  try {
    const heartbeat = JSON.parse(await fsp.readFile(path.join(pipelineJobsRoot, jobId, 'runner-heartbeat.json'), 'utf8'));
    return heartbeat?.jobId === jobId ? heartbeat : null;
  } catch {
    return null;
  }
}

function watchdogIncidentId(observation) {
  return `incident-${crypto.createHash('sha256').update(`${observation.jobId}:${observation.type}:${observation.fingerprint}`).digest('hex').slice(0, 16)}`;
}

function sanitizeMonitorText(value) {
  return String(value || '')
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 3000);
}

const pipelineTriageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'conclusion', 'evidence', 'recommended_action', 'project_disposition'],
  properties: {
    category: { type: 'string', enum: ['infrastructure_error', 'generated_project_error', 'task_execution_error', 'project_unusable', 'unknown_error'] },
    conclusion: { type: 'string', minLength: 20 },
    evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 5 } },
    recommended_action: { type: 'string', enum: ['retry_stage', 'regenerate_project', 'fix_pipeline', 'wait_dependency', 'abandon_project', 'manual_review'] },
    project_disposition: { type: 'string', enum: ['keep', 'retry', 'abandon'] },
  },
};

async function runCodexWatchdogTriage(incident) {
  const triageDir = path.join(pipelineRefillRoot, 'triage', incident.id);
  await fsp.mkdir(triageDir, { recursive: true });
  const schemaPath = path.join(triageDir, 'triage.schema.json');
  const outputPath = path.join(triageDir, 'triage.json');
  const inputPath = path.join(triageDir, 'incident.json');
  const eventsPath = path.join(triageDir, 'codex.jsonl');
  await fsp.writeFile(schemaPath, `${JSON.stringify(pipelineTriageSchema, null, 2)}\n`, 'utf8');
  await fsp.writeFile(inputPath, `${JSON.stringify({
    jobId: incident.jobId,
    repository: incident.repository,
    taskType: incident.taskType,
    stageId: incident.stageId,
    type: incident.type,
    failureCategory: incident.failureCategory,
    message: incident.message,
    autoRetryCount: incident.autoRetryCount,
    heartbeatState: incident.heartbeatState,
    stageAgeMs: incident.stageAgeMs,
  }, null, 2)}\n`, 'utf8');
  const prompt = [
    '你是 Go 题目生产流水线的只读故障分诊员。只分析当前目录的 incident.json，不得访问项目 workspace、Gold、隐藏 grader 或任何轨迹答案，不得修改任何文件。',
    '先判断错误来自基础设施/流水线、生成项目、单题执行，还是项目确定无法使用。CLI 脚本、Docker、Git、云盘、网络、权限和服务状态问题一律不能判定项目废弃。',
    'V5 bugfix 的 verify_cmds 在 Claude 公开回归测试通过覆盖复核前按设计为空；若它在 claude_fix、trajectory_validate 或 pre_verify 阶段为空，属于阶段推进/重试状态错误，必须选择 retry 或 keep，不能据此判定生成项目交付契约永久不满足。',
    '以下硬规则命中时直接判定项目不可用：题目领域命中不可出题类型、项目需求违反领域/规模/代码量硬门禁、生成项目无法满足固定交付契约，或系统明确写出“硬规则/不可出题/项目不可用”。复杂度维度本身不是废弃理由。此时必须返回 category=project_unusable、recommended_action=abandon_project、project_disposition=abandon，不要再重试。',
    '除上述明确硬规则外，只有基础设施健康、独立重试已耗尽且相同的项目内在错误可确定复现时，project_disposition 才能是 abandon；证据不足必须选择 retry 或 keep。',
    '返回符合 schema 的中文 JSON 结论。',
  ].join('\n\n');
  const result = await runCapturedCommand(codexCliPath, [
    'exec', '--ephemeral', '--ignore-user-config', '-c', 'model_reasoning_effort="low"',
    '--skip-git-repo-check', '-C', triageDir, '-s', 'read-only', '--json',
    '--output-schema', schemaPath, '-o', outputPath, prompt,
  ], { cwd: triageDir, timeoutMs: 30 * 60 * 1000 });
  await fsp.writeFile(eventsPath, result.stdout || '', 'utf8');
  if (result.exitCode !== 0) throw new Error(`Codex 只读排查失败（exit=${result.exitCode ?? 'none'}）：${sanitizeMonitorText(compactCapturedOutput(result)).slice(-1500)}`);
  return JSON.parse(await fsp.readFile(outputPath, 'utf8'));
}

async function updateIncidentAction(incidentId, patch) {
  const latest = await readPipelineWatchdogState();
  const current = latest.incidents.find((item) => item.id === incidentId);
  if (!current) return;
  Object.assign(current, patch);
  latest.updatedAt = new Date().toISOString();
  await writePipelineWatchdogState(latest);
}

async function waitForProcessExit(pid, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !processIsAlive(pid);
}

async function queuePipelineRetryFromTriage(jobId, incident, triage, { terminated = false } = {}) {
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('分诊动作对应的流水线作业不存在');
  if (job.status === 'passed' || job.status === 'abandoned') return;
  if (!shouldQueuePipelineRetry({ processActive: activePipelineProcesses.has(jobId), terminated })) {
    return { queued: false, reason: 'runner_active' };
  }
  const at = new Date().toISOString();
  job.status = 'failed';
  if (Number(job.autoRetryCount || 0) >= MAX_PIPELINE_AUTO_RETRIES) {
    const retryBlockedReason = `流水线阶段连续失败，已达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重试上限，等待人工重试`;
    const alreadyRecorded = job.retryBlockedReason === retryBlockedReason;
    job.retryBlockedReason = retryBlockedReason;
    delete job.retryRequestedAt;
    if (!alreadyRecorded) {
      job.logs = [...(job.logs || []), {
        at,
        level: 'warn',
        stageId: job.currentStage || incident.stageId || null,
        message: `已达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重试上限，不再重复加入队列`,
      }].slice(-300);
      // Preserve the actual failure timestamp and error. Updating them here
      // makes the watchdog mistake its own retry decision for a newer Runner
      // failure and reopen the same Codex triage forever.
      await writePipelineJob(job);
    }
    return { queued: false, reason: 'retry_exhausted' };
  }
  job.error = terminated
    ? `监控已终止硬卡点并请求重试：${sanitizeMonitorText(triage.conclusion)}`
    : job.error || `Codex 分诊请求重试：${sanitizeMonitorText(triage.conclusion)}`;
  job.finishedAt = at;
  job.updatedAt = at;
  job.retryRequestedAt = at;
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: job.currentStage || incident.stageId || null,
    message: `${triage.recommended_action} 已加入自动重试队列`,
  }].slice(-300);
  await writePipelineJob(job);
  return { queued: true, reason: '' };
}

async function abandonPipelineJobFromTriage(jobId, incident, triage) {
  const job = await readPipelineJob(jobId);
  if (!job || ['passed', 'abandoned', 'stopped'].includes(job.status)) return false;
  const at = new Date().toISOString();
  const conclusion = sanitizeMonitorText(triage.conclusion || 'Codex 判定项目无法满足硬规则');
  job.status = 'abandoned';
  job.abandonedAt = at;
  job.abandonmentApprovedAt = at;
  job.abandonmentApprovalIncidentId = incident.id;
  job.abandonReason = 'codex_hard_rule';
  job.failureCategory = incident.failureCategory || classifyPipelineFailure(job);
  job.repositoryDisposition = 'retained_abandoned';
  job.updatedAt = at;
  job.finishedAt = job.finishedAt || at;
  job.error = conclusion;
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: job.currentStage || incident.stageId || null,
    message: `Codex 确认硬规则不可满足，项目已废弃：${conclusion}`,
  }].slice(-300);
  await writePipelineJob(job);
  await recordTerminalSubmissionQualityIncident(job);
  addLog('warn', `流水线 ${jobId} 已由 Codex 分诊确认废弃，等待自动补充替补题目`);
  return true;
}

async function executePipelineTriageAction(incident, triage) {
  let plan = triageActionPlan(incident, triage);
  if (plan.type === 'terminate_and_retry') {
    const latestJob = await readPipelineJob(incident.jobId);
    const scope = pipelineHardStallTerminationScope(latestJob, incident.stageId);
    if (!scope.safe) {
      plan = { type: 'observe', action: plan.action, reason: scope.reason };
      addLog('warn', `${incident.jobId} ${scope.reason}`);
    }
  }
  const actionStartedAt = new Date().toISOString();
  await updateIncidentAction(incident.id, { actionPlan: plan, actionStatus: 'executing', actionStartedAt });
  try {
    if (plan.type === 'terminate_and_retry') {
      const handle = activePipelineProcesses.get(incident.jobId);
      if (!handle) throw new Error('硬卡点 Runner 未被服务接管，不能安全终止');
      pipelineStopRequests.add(incident.jobId);
      await writePipelineStopRequest(incident.jobId, 'watchdog_retry', 'pipeline_watchdog');
      await signalPipelineProcess(incident.jobId, 'SIGTERM');
      if (!await waitForProcessExit(handle.pid)) {
        await signalPipelineProcess(incident.jobId, 'SIGKILL');
        if (!await waitForProcessExit(handle.pid, 5_000)) throw new Error('硬卡点 Runner 无法终止');
      }
      activePipelineProcesses.delete(incident.jobId);
      pipelineStopRequests.delete(incident.jobId);
      const retry = await queuePipelineRetryFromTriage(incident.jobId, incident, triage, { terminated: true });
      if (!retry?.queued && retry?.reason === 'retry_exhausted') {
        await updateIncidentAction(incident.id, {
          actionStatus: 'observing',
          actionFinishedAt: new Date().toISOString(),
          actionError: `已达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重试上限，等待人工重试`,
        });
        return true;
      }
    } else if (plan.type === 'terminate_and_abandon') {
      const handle = activePipelineProcesses.get(incident.jobId);
      if (handle) {
        pipelineStopRequests.add(incident.jobId);
        await writePipelineStopRequest(incident.jobId, 'watchdog_abandon', 'pipeline_watchdog');
        await signalPipelineProcess(incident.jobId, 'SIGTERM');
        if (!await waitForProcessExit(handle.pid)) {
          await signalPipelineProcess(incident.jobId, 'SIGKILL');
          if (!await waitForProcessExit(handle.pid, 5_000)) throw new Error('硬卡点 Runner 无法终止');
        }
        activePipelineProcesses.delete(incident.jobId);
        pipelineStopRequests.delete(incident.jobId);
      }
      await abandonPipelineJobFromTriage(incident.jobId, incident, triage);
    } else if (plan.type === 'queue_retry') {
      const retry = await queuePipelineRetryFromTriage(incident.jobId, incident, triage);
      if (!retry?.queued) {
        await updateIncidentAction(incident.id, {
          actionStatus: 'observing',
          actionFinishedAt: new Date().toISOString(),
          actionError: retry?.reason === 'retry_exhausted'
            ? `已达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重试上限，等待人工重试`
            : 'Runner 已恢复运行，忽略过期的重试分诊结果',
        });
        return true;
      }
    } else if (plan.type === 'wait_dependency') {
      const job = await readPipelineJob(incident.jobId);
      if (job && job.status === 'failed') {
        job.dependencyWaitService = pipelineDependencyServiceForIncident(incident);
        delete job.retryRequestedAt;
        job.updatedAt = new Date().toISOString();
        await writePipelineJob(job);
      }
    } else if (plan.type === 'pause_scheduler') {
      await setPipelineControlMode('paused');
      void emitPipelineAlert({
        key: `pipeline-fix:${incident.fingerprint}`,
        severity: 'critical',
        title: '流水线需要修复，已暂停新任务',
        message: triage.conclusion,
      });
    } else if (plan.type === 'approve_abandonment') {
      await abandonPipelineJobFromTriage(incident.jobId, incident, triage);
    }
    await updateIncidentAction(incident.id, {
      actionStatus: plan.type === 'observe' ? 'observing' : 'executed',
      actionFinishedAt: new Date().toISOString(),
      actionError: '',
    });
    if (['queue_retry', 'terminate_and_retry', 'approve_abandonment', 'terminate_and_abandon'].includes(plan.type) && pipelineAutoFillEnabled) void fillPipelineSlots();
  } catch (error) {
    await updateIncidentAction(incident.id, {
      status: 'triage_failed',
      retryAfter: Date.now() + 60_000,
      actionStatus: 'failed',
      actionFinishedAt: new Date().toISOString(),
      actionError: sanitizeMonitorText(error.message),
    });
    void emitPipelineAlert({
      key: `triage-action:${incident.id}`,
      severity: 'critical',
      title: 'Codex 分诊动作执行失败',
      message: `${incident.jobId}：${error.message}`,
    });
    return false;
  }
  return true;
}

async function triageNextPipelineIncident() {
  if (pipelineCodexTriageRunning) return;
  const state = await readPipelineWatchdogState();
  const nowMs = Date.now();
  const incident = state.incidents.find((item) => item.codexTriage
    && (item.status === 'open' || item.status === 'triage_failed' && Number(item.retryAfter || 0) <= nowMs));
  if (!incident) return;
  pipelineCodexTriageRunning = true;
  try {
    incident.status = 'triaging';
    incident.triageAttempts = Number(incident.triageAttempts || 0) + 1;
    incident.triageStartedAt = new Date().toISOString();
    state.updatedAt = incident.triageStartedAt;
    await writePipelineWatchdogState(state);
    addLog('info', `Codex 开始只读排查流水线异常：${incident.jobId} / ${incident.stageId || incident.type}`);
    const triage = await runCodexWatchdogTriage(incident);
    const latest = await readPipelineWatchdogState();
    const current = latest.incidents.find((item) => item.id === incident.id);
    if (current) {
      current.status = 'triaged';
      current.triage = triage;
      current.triageFinishedAt = new Date().toISOString();
      current.error = '';
      latest.updatedAt = current.triageFinishedAt;
      await writePipelineWatchdogState(latest);
    }
    await executePipelineTriageAction(incident, triage);
    addLog('info', `Codex 只读排查完成：${incident.jobId} → ${triage.category} / ${triage.recommended_action}`);
  } catch (error) {
    const latest = await readPipelineWatchdogState();
    const current = latest.incidents.find((item) => item.id === incident.id);
    if (current) {
      current.status = 'triage_failed';
      current.error = sanitizeMonitorText(error.message);
      const attempts = Number(current.triageAttempts || 1);
      current.retryAfter = Date.now() + Math.min(15 * 60_000, 60_000 * (2 ** Math.min(4, Math.max(0, attempts - 1))));
      current.triageFinishedAt = new Date().toISOString();
      latest.updatedAt = current.triageFinishedAt;
      await writePipelineWatchdogState(latest);
    }
    addLog('warn', `Codex 只读排查暂未完成：${incident.jobId}：${error.message}`);
  } finally {
    pipelineCodexTriageRunning = false;
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
  }
}

async function runPipelineWatchdog() {
  if (pipelineWatchdogRunning) return;
  pipelineWatchdogRunning = true;
  try {
    const jobs = await listPipelineJobs();
    const state = await readPipelineWatchdogState();
    const now = new Date().toISOString();
    const activeKeys = new Set();
    const recordObservation = (observation, job = null) => {
      const id = watchdogIncidentId(observation);
      activeKeys.add(id);
      const existingIncident = state.incidents.find((incident) => incident.id === id);
      if (existingIncident) {
        const failureRetried = observation.type === 'failure'
          && ['triaged', 'resolved'].includes(existingIncident.status)
          && (existingIncident.status === 'resolved'
            || (!job?.retryRequestedAt
              && Date.parse(observation.failureAt || '') > Date.parse(existingIncident.triageFinishedAt || '')));
        if (failureRetried) {
          // The error fingerprint can remain stable across attempts. Reopen
          // the incident when the runner records a newer failure so every
          // automatic retry receives a fresh Codex decision.
          Object.assign(existingIncident, {
            status: 'open',
            triage: null,
            triageFinishedAt: null,
            actionPlan: null,
            actionStatus: '',
            actionError: '',
            reopenedAt: now,
          });
        }
        Object.assign(existingIncident, observation, { lastSeenAt: now });
        return;
      }
      state.incidents.push({
        id,
        ...observation,
        repository: job?.request?.repository || '',
        taskType: job?.request?.taskType || '',
        autoRetryCount: Number(job?.autoRetryCount || 0),
        status: 'open',
        firstSeenAt: now,
        lastSeenAt: now,
        triageAttempts: 0,
      });
      addLog(observation.severity === 'critical' ? 'warn' : 'info', `流水线监控发现异常：${observation.jobId}：${observation.message}`);
      void emitPipelineAlert({
        key: `incident:${id}`,
        severity: observation.severity,
        title: observation.type === 'throughput_stall'
          ? '流水线长时间没有生成新项目'
          : `${observation.jobId} ${observation.type === 'hard_stall' ? '达到硬超时' : observation.type === 'stalled' ? '出现卡点' : '执行失败'}`,
        message: observation.message,
      });
    };
    for (const job of jobs) {
      const observation = pipelineWatchdogObservation(job, { heartbeat: await readPipelineHeartbeat(job.id) });
      if (!observation) continue;
      recordObservation(observation, job);
    }
    const throughput = pipelineProjectThroughputMonitor(jobs, state.projectThroughput || {}, {
      enabled: pipelineControlMode === 'running' && pipelineAutoFillEnabled,
    });
    state.projectThroughput = throughput.state;
    if (throughput.observation) recordObservation(throughput.observation);
    for (const incident of state.incidents) {
      if (activeKeys.has(incident.id)) incident.lastSeenAt = now;
      else if (['open', 'triaged', 'triage_failed'].includes(incident.status)) {
        const job = jobs.find((item) => item.id === incident.jobId);
        if (!job || ['passed', 'abandoned', 'stopped'].includes(job.status) || job.currentStage !== incident.stageId) {
          incident.status = 'resolved';
          incident.resolvedAt = now;
          void emitPipelineAlert({
            key: `incident:${incident.id}`,
            severity: 'info',
            title: `${incident.jobId} 异常已解除`,
            message: incident.triage?.conclusion || incident.message,
            resolved: true,
          });
        }
      }
    }
    state.incidents = state.incidents.slice(-200);
    state.updatedAt = now;
    await writePipelineWatchdogState(state);
  } finally {
    pipelineWatchdogRunning = false;
  }
  void triageNextPipelineIncident();
}

function commandHealth(name, result) {
  const detail = sanitizeMonitorText((result.stdout || result.stderr || result.error || '').trim().split(/\r?\n/)[0]).slice(0, 240);
  return {
    name,
    status: result.exitCode === 0 ? 'online' : 'offline',
    checkedAt: new Date().toISOString(),
    latencyMs: result.durationMs,
    detail: detail || (result.exitCode === 0 ? '可用' : `exit=${result.exitCode ?? 'none'}`),
  };
}

async function checkCommandHealth(name, command, args) {
  return commandHealth(name, await runCapturedCommand(command, args, { cwd: import.meta.dirname, timeoutMs: 15_000 }));
}

async function runCodexInferenceProbe() {
  const probeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-codex-health-'));
  const schemaPath = path.join(probeDir, 'schema.json');
  const outputPath = path.join(probeDir, 'result.json');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } },
  };
  try {
    await fsp.writeFile(schemaPath, `${JSON.stringify(schema)}\n`, 'utf8');
    const result = await runCapturedCommand(codexCliPath, [
      'exec', '--ephemeral', '--ignore-user-config',
      '-c', 'model_reasoning_effort="low"',
      '--skip-git-repo-check', '-C', probeDir, '-s', 'read-only', '--json',
      '--output-schema', schemaPath, '-o', outputPath,
      'Return only the requested JSON object with status set to ok. Do not use tools.',
    ], { cwd: probeDir, timeoutMs: CODEX_INFERENCE_PROBE_TIMEOUT_MS });
    let validOutput = false;
    if (result.exitCode === 0) {
      const output = await fsp.readFile(outputPath, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
      validOutput = output?.status === 'ok';
    }
    const probeCheckedAt = new Date().toISOString();
    if (result.exitCode === 0 && validOutput) {
      return {
        name: 'Codex CLI',
        status: 'online',
        authStatus: 'online',
        inferenceStatus: 'online',
        probeCheckedAt,
        checkedAt: probeCheckedAt,
        latencyMs: result.durationMs,
        detail: '认证有效，结构化推理在线',
      };
    }
    const detail = sanitizeMonitorText(compactCapturedOutput(result)).slice(-240)
      || (result.exitCode === 0 ? '结构化输出无效' : `exit=${result.exitCode ?? 'none'}`);
    return {
      name: 'Codex CLI',
      status: 'degraded',
      authStatus: 'online',
      inferenceStatus: 'degraded',
      probeCheckedAt,
      checkedAt: probeCheckedAt,
      latencyMs: result.durationMs,
      detail: `认证有效，但结构化推理探针失败：${detail}`,
    };
  } finally {
    await fsp.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkCodexHealth(authResult) {
  const auth = authenticatedCommandHealth('Codex CLI', authResult, '认证有效');
  if (auth.status !== 'online') {
    codexInferenceProbeHealth = null;
    return { ...auth, authStatus: 'offline', inferenceStatus: 'unknown' };
  }
  const previousCheckedAt = Date.parse(codexInferenceProbeHealth?.probeCheckedAt || '');
  const probeIntervalMs = codexInferenceProbeHealth?.status === 'online'
    ? CODEX_INFERENCE_PROBE_INTERVAL_MS
    : CODEX_INFERENCE_PROBE_COOLDOWN_MS;
  if (Number.isFinite(previousCheckedAt) && Date.now() - previousCheckedAt < probeIntervalMs) {
    return {
      ...codexInferenceProbeHealth,
      checkedAt: new Date().toISOString(),
      latencyMs: authResult.durationMs,
    };
  }
  codexInferenceProbeHealth = await runCodexInferenceProbe();
  return codexInferenceProbeHealth;
}

async function checkGitHubHealth() {
  const startedAt = Date.now();
  const authResult = await runCapturedCommand(githubCliPath, [
    'auth', 'status', '--active', '--json', 'hosts',
    '--jq', '.hosts["github.com"][] | select(.active == true) | .login',
  ], { cwd: import.meta.dirname, timeoutMs: 15_000 });
  if (authResult.exitCode !== 0 || !String(authResult.stdout || '').trim()) return commandHealth('GitHub', authResult);
  const login = String(authResult.stdout).trim();
  const viewerResult = await runCapturedCommand(githubCliPath, [
    'api', 'graphql',
    '-f', 'query={ viewer { login } }',
    '--jq', '.data.viewer.login',
  ], { cwd: import.meta.dirname, timeoutMs: 15_000 });
  if (viewerResult.exitCode === 0 && String(viewerResult.stdout || '').trim()) {
    return {
      name: 'GitHub',
      status: 'online',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      detail: `账号 ${login}，认证与 GraphQL API 在线`,
    };
  }

  // A partial API outage can leave the authenticated rate-limit endpoint
  // healthy. Report degradation while repository calls keep their retries.
  const rateLimit = await runCapturedCommand(githubCliPath, ['api', 'rate_limit', '--jq', '.resources.core.limit'], {
    cwd: import.meta.dirname,
    timeoutMs: 15_000,
  });
  if (rateLimit.exitCode === 0 && /^\d+$/.test(String(rateLimit.stdout || '').trim())) {
    return {
      name: 'GitHub',
      status: 'degraded',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      detail: `认证 API 可用，/user 暂时返回 5xx；rate limit ${String(rateLimit.stdout).trim()}`,
    };
  }
  return commandHealth('GitHub', viewerResult);
}

function authenticatedCommandHealth(name, result, detail) {
  const health = commandHealth(name, result);
  return { ...health, detail: result.exitCode === 0 ? detail : health.detail };
}

function currentPipelineResourcePolicy() {
  const base = pipelineHealthState.resourcePolicy || pipelineResourcePolicy(pipelineHealthState.resources || {});
  if (Date.now() >= pipelineRateLimitCooldownUntil) return base;
  return {
    ...base,
    effectiveMaxConcurrency: Math.min(1, Number(base.effectiveMaxConcurrency || 1)),
    warnings: [...(base.warnings || []), `模型 429 冷却至 ${new Date(pipelineRateLimitCooldownUntil).toISOString()}`],
    rateLimitCooldownUntil: new Date(pipelineRateLimitCooldownUntil).toISOString(),
  };
}

function currentPipelineBudget(jobs) {
  return pipelineDailyBudget(jobs, {
    projectLimit: pipelineDailyProjectLimit,
    trajectoryLimit: pipelineDailyTrajectoryLimit,
  });
}

async function releaseRecoveredDependencyWaits() {
  if (pipelineControlMode !== 'running') return 0;
  let released = 0;
  for (const visible of await listPipelineJobs()) {
    if (!['failed', 'waiting_resource'].includes(visible.status) || !visible.dependencyWaitService) continue;
    if (pipelineServiceOnlineStreaks.get(visible.dependencyWaitService) < 3) continue;
    const job = await readPipelineJob(visible.id);
    if (!job || !['failed', 'waiting_resource'].includes(job.status)
      || job.dependencyWaitService !== visible.dependencyWaitService) continue;
    job.retryRequestedAt = new Date().toISOString();
    job.status = 'waiting_resource';
    job.runnerPid = null;
    job.schedulerLease = null;
    job.waitingResource = {
      ...(job.waitingResource || {}),
      stageId: job.currentStage,
      pool: 'dependency',
      reason: 'dependency_recovered',
      queuedAt: job.waitingResource?.queuedAt || job.retryRequestedAt,
    };
    job.updatedAt = job.retryRequestedAt;
    job.logs = [...(job.logs || []), {
      at: job.updatedAt,
      level: 'success',
      stageId: job.currentStage || null,
      message: `${job.dependencyWaitService} 连续三次健康，解除依赖等待并加入重试队列`,
    }].slice(-300);
    delete job.dependencyWaitService;
    await writePipelineJob(job);
    released += 1;
  }
  if (released) void fillPipelineSlots();
  return released;
}

async function readDockerReclaimableBytes(result) {
  if (result.exitCode !== 0) return 0;
  let total = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      total += parseDockerSize(JSON.parse(line).Reclaimable || '');
    } catch {}
  }
  return total;
}

async function runSystemHealthChecks() {
  if (pipelineHealthCheckRunning) return;
  pipelineHealthCheckRunning = true;
  try {
    const cloudCheck = (async () => {
      const startedAt = Date.now();
      try {
        await maintainCloudSession({ force: true });
      } catch {}
      return {
        name: '轨迹云盘',
        status: cloudSessionCookie && !cloudLastError ? 'online' : cloudAutoLoginConfigured ? 'degraded' : 'offline',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        detail: cloudLastError || (cloudSessionCookie ? '会话在线，自动续登已启用' : '尚未连接'),
      };
    })();
    const previous = pipelineHealthState;
    const [git, docker, claudeAuth, codexAuth, dockerDisk, dockerBuilderDisk, memoryPressure, cloud, statfs] = await Promise.all([
      checkGitHubHealth(),
      checkCommandHealth('Docker', 'docker', ['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']),
      runCapturedCommand(claudeCliPath, ['auth', 'status', '--json'], { cwd: import.meta.dirname, timeoutMs: 15_000 }),
      runCapturedCommand(codexCliPath, ['login', 'status'], { cwd: import.meta.dirname, timeoutMs: 15_000 }),
      runCapturedCommand('docker', ['system', 'df', '--format', '{{json .}}'], { cwd: import.meta.dirname, timeoutMs: 30_000 }),
      runCapturedCommand('docker', ['buildx', 'du', '--builder', 'benzhi-builder'], { cwd: import.meta.dirname, timeoutMs: 30_000 }),
      process.platform === 'darwin'
        ? runCapturedCommand('memory_pressure', ['-Q'], { cwd: import.meta.dirname, timeoutMs: 15_000 })
        : Promise.resolve({ exitCode: 1, stdout: '' }),
      cloudCheck,
      fsp.statfs(managedLibraryRoot).catch(() => null),
    ]);
    let claudeLoggedIn = false;
    try { claudeLoggedIn = JSON.parse(claudeAuth.stdout || '{}').loggedIn === true; } catch {}
    const claude = authenticatedCommandHealth('Claude CLI', {
      ...claudeAuth,
      exitCode: claudeAuth.exitCode === 0 && claudeLoggedIn ? 0 : claudeAuth.exitCode || 1,
    }, '认证有效');
    const codex = await checkCodexHealth(codexAuth);
    const memoryPercentMatch = memoryPressure.stdout?.match(/memory free percentage:\s*(\d+)%/i);
    const dockerSystemReclaimableBytes = await readDockerReclaimableBytes(dockerDisk);
    const dockerBuilderReclaimableBytes = dockerBuilderDisk.exitCode === 0
      ? parseDockerBuildxReclaimableBytes(dockerBuilderDisk.stdout)
      : 0;
    const resources = collectHostResourceSnapshot({
      statfs,
      loadAverage: os.loadavg()[0],
      cpuCount: os.cpus().length,
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem(),
      memoryAvailablePercent: memoryPercentMatch ? Number(memoryPercentMatch[1]) : undefined,
      dockerSystemReclaimableBytes,
      dockerBuilderReclaimableBytes,
    });
    const resourcePolicy = pipelineResourcePolicy(resources, { configuredMax: MAX_PIPELINE_CONCURRENCY });
    const host = {
      name: '主机资源',
      status: resourcePolicy.status === 'healthy' ? 'online' : resourcePolicy.status === 'degraded' ? 'degraded' : 'offline',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      detail: resourcePolicy.blockers[0] || resourcePolicy.warnings[0] || `动态并发 ${resourcePolicy.effectiveMaxConcurrency}`,
    };
    pipelineHealthState = {
      updatedAt: new Date().toISOString(),
      services: { git, cloud, docker, claude, codex, host },
      resources,
      resourcePolicy,
    };
    for (const [key, service] of Object.entries(pipelineHealthState.services)) {
      pipelineServiceOnlineStreaks.set(key, service.status === 'online' ? Number(pipelineServiceOnlineStreaks.get(key) || 0) + 1 : 0);
      const previousStatus = previous.services?.[key]?.status;
      if (previousStatus && previousStatus !== service.status) {
        void emitPipelineAlert({
          key: `service:${key}`,
          severity: service.status === 'online' ? 'info' : 'critical',
          title: `${service.name}${service.status === 'online' ? '已恢复' : '不可用'}`,
          message: service.detail,
          resolved: service.status === 'online',
        });
      }
    }
    if (resourcePolicy.status !== previous.resourcePolicy?.status) {
      void emitPipelineAlert({
        key: 'resource:host',
        severity: resourcePolicy.status === 'blocked' ? 'critical' : resourcePolicy.status === 'degraded' ? 'warning' : 'info',
        title: resourcePolicy.status === 'healthy' ? '主机资源已恢复' : '主机资源触发保护',
        message: [...resourcePolicy.blockers, ...resourcePolicy.warnings].join('；') || '资源指标恢复正常',
        resolved: resourcePolicy.status === 'healthy',
      });
    }
    await fsp.mkdir(path.dirname(pipelineHealthStatePath), { recursive: true });
    const temporary = `${pipelineHealthStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(pipelineHealthState, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, pipelineHealthStatePath);
    await releaseRecoveredDependencyWaits();
    const resourceSlots = await activePipelineResourceSlotSnapshot();
    const dockerOccupiedCount = Number(resourceSlots.counts['compute-docker'] || 0);
    const maintenanceAction = pipelineDockerMaintenanceAction(resources, pipelineResourceMaintenanceState, {
      occupiedCount: dockerOccupiedCount,
      lastMaintenanceAt: pipelineLastResourceMaintenanceAt,
    });
    if (maintenanceAction.action === 'cancel') {
      pipelineResourceMaintenanceState = {
        status: 'idle',
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        retryAfter: null,
        reason: '',
        error: '',
      };
      await writePipelineSchedulerState();
      addLog('success', 'Docker 清理条件已解除，取消排空维护并恢复流水线补位');
      if (pipelineAutoFillEnabled) void fillPipelineSlots();
    } else if (maintenanceAction.action === 'request') {
      const urgent = maintenanceAction.mode === 'urgent';
      const cleanupPlan = pipelineDiskCleanupPlan(resources);
      pipelineResourceMaintenanceState = {
        status: 'pending',
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        retryAfter: null,
        mode: cleanupPlan.mode,
        plan: cleanupPlan,
        reason: urgent
          ? `磁盘可用空间低于动态水位，等待 Docker 阶段释放后回收最多 ${Math.round(resources.dockerReclaimableBytes / 1e9)} GB 可再生缓存`
          : `流水线自然空闲，准备回收 ${Math.round(resources.dockerReclaimableBytes / 1e9)} GB Docker 空间`,
        error: '',
      };
      await writePipelineSchedulerState();
      addLog(urgent ? 'warn' : 'info', urgent
        ? `${pipelineResourceMaintenanceState.reason}；当前 Docker 阶段完成后自动清理`
        : `${pipelineResourceMaintenanceState.reason}；不占用生产任务时间`);
    }
    if (pipelineResourceMaintenanceState.status === 'pending' && !pipelineResourceMaintenanceRunning) {
      if (dockerOccupiedCount === 0) void runDockerResourceMaintenance({ automatic: true }).catch((error) => addLog('warn', error.message));
    }
  } finally {
    pipelineHealthCheckRunning = false;
  }
}

async function restorePipelineHealthState() {
  try {
    pipelineHealthState = JSON.parse(await fsp.readFile(pipelineHealthStatePath, 'utf8'));
  } catch {
    pipelineHealthState = { updatedAt: null, services: {} };
  }
}

async function publicSystemHealth() {
  const watchdog = await readPipelineWatchdogState();
  const alerts = await readPipelineAlerts();
  const jobs = await listPipelineJobs();
  const openIncidents = watchdog.incidents.filter((incident) => !['resolved'].includes(incident.status));
  return {
    ...pipelineHealthState,
    datastoreProtection: datastoreProtectionState,
    rollout: pipelineRolloutState,
    scheduler: {
      controlMode: pipelineControlMode,
      autoFillEnabled: pipelineAutoFillEnabled,
      refillPaused: pipelineRefillPaused,
      effectiveMaxConcurrency: currentPipelineResourcePolicy().effectiveMaxConcurrency,
      incompleteProjectCount: countIncompletePipelineProjects(jobs),
      incompleteProjectLimit: PIPELINE_INCOMPLETE_PROJECT_LIMIT,
      refillPausedForIncompleteLimit: countIncompletePipelineProjects(jobs) >= PIPELINE_INCOMPLETE_PROJECT_LIMIT,
      budget: currentPipelineBudget(jobs),
      alertWebhookConfigured: Boolean(pipelineAlertWebhookUrl),
      lastResourceMaintenanceAt: pipelineLastResourceMaintenanceAt,
      resourceMaintenance: pipelineResourceMaintenanceState,
    },
    performance: pipelinePerformanceSnapshot(jobs, {
      workflowVersion: CURRENT_WORKFLOW_VERSION,
      verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    }),
    watchdog: {
      intervalMs: PIPELINE_WATCHDOG_INTERVAL_MS,
      activeIncidentCount: openIncidents.length,
      triaging: pipelineCodexTriageRunning,
      projectThroughput: watchdog.projectThroughput || {},
      incidents: openIncidents.slice(-20).reverse(),
      updatedAt: watchdog.updatedAt,
    },
    alerts: alerts.records.slice(-20).reverse(),
  };
}

async function ensurePipelineRefill() {
  if (!await checkDatastoreIntegrity()) return;
  if (['pending', 'running'].includes(pipelineResourceMaintenanceState.status)) return;
  if (pipelineRefillPaused || pipelineAutoRefillRunning || pipelineControlMode !== 'running' || state.status === 'running' || state.status === 'stopping' || activeProcesses.size) return;
  pipelineAutoRefillRunning = true;
    let refill = await readPipelineRefillState();
  try {
    const jobs = await listPipelineJobs();
    const taskTypePolicyChanged = Number(refill.taskTypePolicyVersion || 0) !== PIPELINE_TASK_TYPE_POLICY_VERSION;
    refill = {
      ...applyPipelineTaskTypePolicy(refill),
      largeProjectCanary: normalizeLargeProjectCanary(refill.largeProjectCanary),
    };
    if (taskTypePolicyChanged) {
      await writePipelineRefillState(refill);
    }
    const incompleteCount = countIncompletePipelineProjects(jobs);
    const refillCapacity = pipelineRefillCapacity(jobs);
    if (refillCapacity <= 0) {
      addLog('info', `未完成项目 ${incompleteCount}/${PIPELINE_INCOMPLETE_PROJECT_LIMIT}，暂停 Codex 自动补题规划`);
      return;
    }
    const resourcePolicy = currentPipelineResourcePolicy();
    const budget = currentPipelineBudget(jobs);
    if (!resourcePolicy.canCreate || !budget.canCreateProject) return;
    if (pipelineHealthState.services?.codex?.status !== 'online' || pipelineHealthState.services?.git?.status !== 'online') return;
    const persistedBeforeReconcile = refill;
    const persisted = {
      ...reconcilePipelineRefillCreatedJobs(persistedBeforeReconcile, jobs),
      largeProjectCanary: reconcileLargeProjectCanary(persistedBeforeReconcile.largeProjectCanary, jobs),
    };
    if (persisted.createdJobIds.length !== Number(persistedBeforeReconcile.createdJobIds?.length || 0)) {
      await writePipelineRefillState(persisted);
      addLog('warn', `自动补题恢复对账：移除 ${Number(persistedBeforeReconcile.createdJobIds?.length || 0) - persisted.createdJobIds.length} 个已不存在的作业记录`);
    }
    const decision = shouldStartPipelineRefill(jobs, {
      autoFillEnabled: pipelineAutoFillEnabled,
      currentWorkflowVersion: CURRENT_WORKFLOW_VERSION,
      currentVerificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
      refillState: persisted,
    });
    if (!decision.start) return;
    refill = persisted;
    const remainingProjectBudget = budget.projectLimit == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, budget.projectLimit - budget.createdProjects);
    const persistedTargetCount = Number(persisted.targetCount || persisted.specs?.length || 0);
    const persistedCreatedCount = Number(persisted.createdJobIds?.length || 0);
    const hasPersistedBatch = ['planning', 'provisioning', 'failed'].includes(persisted.status)
      && persistedTargetCount > persistedCreatedCount;
    const targetCount = hasPersistedBatch
      ? Math.min(persistedTargetCount, persistedCreatedCount + refillCapacity)
      : Math.min(Number(decision.targetCount || PIPELINE_REFILL_BATCH_SIZE), remainingProjectBudget, refillCapacity);
    if (!targetCount) return;
    // A previously planned batch may contain more questions than the current
    // three-project work-in-progress budget. Keep its specs for later, but
    // shrink this provisioning pass to the capacity that is available now.
    refill = { ...refill, targetCount };
    const resumable = Array.isArray(refill.specs)
      && refill.specs.length >= Number(refill.targetCount || refill.specs.length)
      && Array.isArray(refill.createdJobIds)
      && refill.createdJobIds.length < Number(refill.targetCount || refill.specs.length);
    if (!resumable) {
      const assignedProjectTiers = autoRefillProjectTiers(targetCount, {
        largeCount: refill.largeProjectCanary?.remainingCount,
      });
      const assignedQuestionCounts = assignedProjectTiers.map((tier) => pipelineBugQuota(tier));
      const batchId = `refill-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
      refill = {
        status: 'planning',
        batchId,
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        specs: [],
        createdJobIds: [],
        targetCount,
        mode: decision.replacementSourceJobIds?.length ? 'replacement' : 'batch',
        replacementSourceJobIds: decision.replacementSourceJobIds || [],
        taskTypePolicyVersion: PIPELINE_TASK_TYPE_POLICY_VERSION,
        taskTypeCountsBeforeBatch: normalizePipelineTaskTypeCounts(refill.taskTypeCounts),
        taskTypeCounts: normalizePipelineTaskTypeCounts(refill.taskTypeCounts),
        taskTypes: allocatePipelineTaskTypes(targetCount, refill.taskTypeCounts, assignedQuestionCounts),
        largeProjectCanary: normalizeLargeProjectCanary(refill.largeProjectCanary),
        error: '',
      };
      await writePipelineRefillState(refill);
      addLog('info', refill.mode === 'replacement'
        ? `检测到 ${targetCount} 个已废弃项目，自动触发 Codex 规划同类型替补题目：${batchId}`
        : `没有待运行流水线，自动触发 Codex 规划 ${targetCount} 个新题目：${batchId}`);
      const sourceJobs = refill.replacementSourceJobIds.map((id) => jobs.find((job) => job.id === id));
      const contributorId = 'codex-auto-refill';
      const contributorJobs = jobs.filter((job) => Number(job.projectQualityPolicyVersion || 0) >= PROJECT_QUALITY_POLICY_VERSION
        && (job.request?.contributorId || job.request?.creator) === contributorId
        && !['abandoned', 'stopped'].includes(job.status));
      const replacementOptions = sourceJobs.length ? {
        projectTiers: assignedProjectTiers,
        frontendFlags: sourceJobs.map((job) => Boolean(job?.request?.frontendRequired)),
      } : {
        projectTiers: assignedProjectTiers,
        frontendFlags: assignFrontendFlags(
          targetCount,
          contributorJobs.length,
          contributorJobs.filter((job) => Boolean(job.request?.frontendRequired)).length,
        ),
      };
      const planned = await runCodexPipelineRefillPlan(batchId, jobs, {
        targetCount,
        taskTypes: refill.taskTypes,
        ...replacementOptions,
      });
      refill = {
        ...refill,
        status: 'provisioning',
        specs: planned.specs,
        taskTypes: planned.specs.map((spec) => spec.taskType),
        planningSessionId: planned.sessionId,
        updatedAt: new Date().toISOString(),
      };
      await writePipelineRefillState(refill);
    } else {
      refill = { ...refill, status: 'provisioning', error: '', updatedAt: new Date().toISOString() };
      await writePipelineRefillState(refill);
      addLog('info', `继续未完成的自动补题批次：${refill.batchId}（${refill.createdJobIds.length}/${refill.targetCount || refill.specs.length}）`);
    }

    for (let index = 0; index < Number(refill.targetCount || refill.specs.length); index += 1) {
      if (pipelineRefillPaused) throw new Error('自动补题规划已暂停，停止创建新题目');
      if (!pipelineAutoFillEnabled || pipelineControlMode !== 'running') throw new Error('自动补位已关闭，停止创建新题目');
      const existingJobs = await listPipelineJobs();
      if (countIncompletePipelineProjects(existingJobs) >= PIPELINE_INCOMPLETE_PROJECT_LIMIT) {
        addLog('info', `未完成项目达到 ${PIPELINE_INCOMPLETE_PROJECT_LIMIT} 个，暂停当前补题批次的后续创建`);
        break;
      }
      const existing = existingJobs.find((job) => job.request?.autoRefillBatchId === refill.batchId
        && Number(job.request?.autoRefillQuestionIndex) === index + 1);
      const spec = refill.specs[index];
      const canary = normalizeLargeProjectCanary(refill.largeProjectCanary);
      const isLargeCanary = spec.projectTier === 'large' && canary.remainingCount > 0;
      let job = existing;
      if (!job) {
        const replacesPipelineJobId = refill.replacementSourceJobIds?.[index] || '';
        job = await createPipelineJob({
          ...spec,
          creator: 'codex-auto-refill',
          autoRefillBatchId: refill.batchId,
          autoRefillQuestionIndex: index + 1,
          autoRefillTitle: spec.title,
          replacesPipelineJobId,
          ...(isLargeCanary ? {
            largeProjectCanaryId: canary.id,
            largeProjectCanaryIndex: canary.createdJobIds.length + 1,
          } : {}),
        });
        addLog('success', `自动补题 ${index + 1}/${refill.targetCount || refill.specs.length}：${spec.title} → ${job.request.repository}`);
      }
      const batchStartCounts = normalizePipelineTaskTypeCounts(
        refill.taskTypeCountsBeforeBatch || refill.taskTypeCounts,
      );
      refill.taskTypeCounts = advancePipelineTaskTypeCounts(
        batchStartCounts,
        (refill.taskTypes || refill.specs.map((spec) => spec.taskType)).slice(0, index + 1),
        refill.specs.slice(0, index + 1).map((spec) => spec.bugCount),
      );
      await linkPipelineReplacement(refill.replacementSourceJobIds?.[index], job.id);
      refill.createdJobIds = [...new Set([...refill.createdJobIds, job.id])];
      const canaryUpdatedAt = job.request?.largeProjectCanaryId ? new Date().toISOString() : refill.largeProjectCanary?.updatedAt;
      refill.largeProjectCanary = isLargeCanary
        ? recordLargeProjectCanaryJob({
          ...refill.largeProjectCanary,
          updatedAt: canaryUpdatedAt,
        }, job.id)
        : normalizeLargeProjectCanary(refill.largeProjectCanary);
      if (job.request?.largeProjectCanaryId) {
        addLog('info', `超大型试跑项目 ${job.request.largeProjectCanaryIndex}/${refill.largeProjectCanary.targetCount} 已创建，剩余 ${refill.largeProjectCanary.remainingCount} 个`);
      }
      refill.updatedAt = new Date().toISOString();
      await writePipelineRefillState(refill);
      void fillPipelineSlots();
    }

    refill = {
      ...refill,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: '',
      retryAfter: null,
    };
    await writePipelineRefillState(refill);
    addLog('success', `Codex 自动补题完成：已补充 ${refill.createdJobIds.length} 个流水线作业，动态并发上限 ${currentPipelineResourcePolicy().effectiveMaxConcurrency}/${MAX_PIPELINE_CONCURRENCY}`);
  } catch (error) {
    refill = {
      ...refill,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      retryAfter: Date.now() + PIPELINE_REFILL_FAILURE_COOLDOWN_MS,
      error: String(error.message || error).slice(0, 3000),
    };
    await writePipelineRefillState(refill);
    addLog('warn', `Codex 自动补题暂未完成，${Math.ceil(PIPELINE_REFILL_FAILURE_COOLDOWN_MS / 1000)} 秒后重试：${refill.error}`);
  } finally {
    pipelineAutoRefillRunning = false;
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
  }
}

async function preparePipelineStart(jobId, { automatic = false, externalResume = false } = {}) {
  if (!await checkDatastoreIntegrity()) throw new Error(datastoreProtectionState.message);
  if (['pending', 'running'].includes(pipelineResourceMaintenanceState.status)) throw new Error('Docker 资源维护正在排空或执行，暂不启动新流水线');
  const liveRunners = await scanPipelineRunnerProcesses();
  let managedLiveRunnerCount = 0;
  for (const [runningJobId, info] of liveRunners) {
    if (!processIsAlive(info.pid) || !await readPipelineJob(runningJobId)) continue;
    managedLiveRunnerCount += 1;
    if (!activePipelineProcesses.has(runningJobId)) {
      activePipelineProcesses.set(runningJobId, { pid: info.pid, child: null, adopted: true, command: info.command });
    }
  }
  const existingRunner = liveRunners.get(jobId);
  if (existingRunner && processIsAlive(existingRunner.pid)) {
    const error = new Error(`流水线 ${jobId} 已有运行中的 Runner（pid=${existingRunner.pid}）`);
    error.code = 'PIPELINE_RUNNER_ACTIVE';
    throw error;
  }
  const allJobs = await listPipelineJobs();
  const occupiedJobIds = pipelineOccupiedJobIds(allJobs);
  let job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  if (pipelineControlMode !== 'running' && !externalResume) {
    throw new Error(`流水线调度处于 ${pipelineControlMode} 状态`);
  }
  const resourcePolicy = currentPipelineResourcePolicy();
  const effectiveMaxConcurrency = resourcePolicy.effectiveMaxConcurrency;
  if (!effectiveMaxConcurrency) throw new Error(`主机资源保护已启用：${resourcePolicy.blockers.join('；')}`);
  const reusesExistingAdmission = pipelineResumeUsesExistingAdmission(job, externalResume);
  if (managedLiveRunnerCount >= effectiveMaxConcurrency && !reusesExistingAdmission) {
    throw new Error(`生产流水线全局容量已满（${managedLiveRunnerCount}/${effectiveMaxConcurrency}）`);
  }
  // V3 jobs created before workflow policy v4 may lack the persisted policy
  // marker. Upgrade before selecting the next stage so a retry cannot enter
  // the compatibility task-preparation path with an empty frozen command.
  const stageLayoutNeedsMigration = Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION
    && !pipelineStageLayoutMatches(job);
  if (Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION
    && (Number(job.workflowPolicyVersion || 0) < CURRENT_WORKFLOW_POLICY_VERSION || stageLayoutNeedsMigration)) {
    const migratedAt = new Date().toISOString();
    if (stageLayoutNeedsMigration && !job.legacyStageSnapshot) {
      job.legacyStageSnapshot = {
        capturedAt: migratedAt,
        workflowPolicyVersion: Number(job.workflowPolicyVersion || 0),
        stages: Array.isArray(job.stages) ? job.stages : [],
      };
    }
    job.workflowPolicyVersion = CURRENT_WORKFLOW_POLICY_VERSION;
    job.stages = createPipelineStages(
      Number(job.request?.bugCount || job.bugs?.length || DEFAULT_BUG_COUNT),
      Number(job.workflowVersion || CURRENT_WORKFLOW_VERSION),
      Number(job.verificationPolicyVersion || CURRENT_VERIFICATION_POLICY_VERSION),
      job.request?.taskType || 'bugfix',
      CURRENT_WORKFLOW_POLICY_VERSION,
      Number(job.submissionPlatformPolicyVersion || 0),
    ).map((stage) => ({
      ...stage,
      ...((job.stages || []).find((existing) => existing.id === stage.id) || {}),
    }));
    job.updatedAt = migratedAt;
    job.logs = [...(job.logs || []), {
      at: migratedAt,
      level: 'info',
      stageId: job.currentStage || 'pipeline_resume',
      message: stageLayoutNeedsMigration
        ? '迁移旧任务阶段布局：移除已退役 Gold/私有夹具阶段并保留同名阶段状态'
        : `恢复旧任务策略版本：workflowPolicyVersion -> ${CURRENT_WORKFLOW_POLICY_VERSION}`,
    }].slice(-300);
    await writePipelineJob(job);
  }
  const frozenVerificationRecovery = reactivateFrozenVerificationFailures(job);
  if (frozenVerificationRecovery.reactivated.length) {
    const recoveredAt = new Date().toISOString();
    job.updatedAt = recoveredAt;
    job.logs = [...(job.logs || []), {
      at: recoveredAt,
      level: 'warn',
      stageId: 'pipeline_resume',
      message: `恢复 ${frozenVerificationRecovery.reactivated.length} 个旧任务槽位：重新生成 Claude 前私有验证夹具（${frozenVerificationRecovery.reactivated.join(', ')}）`,
    }].slice(-300);
    await writePipelineJob(job);
  }
  const hasStartedBugDiscovery = (job.bugs || []).some((bug) => bug?.discovery?.user_query)
    || (job.stages || []).some((stage) => stage.id?.endsWith('_bug_discovery') && ['running', 'passed', 'failed'].includes(stage.status));
  if (Number(job.request?.bugPolicyVersion || 0) < CURRENT_BUG_POLICY_VERSION
    && !hasStartedBugDiscovery
    && Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION) {
    job.request = { ...job.request, bugPolicyVersion: CURRENT_BUG_POLICY_VERSION };
    job.updatedAt = new Date().toISOString();
    job.logs = [...(job.logs || []), {
      at: job.updatedAt,
      level: 'info',
      stageId: job.currentStage || 'project_plan',
      message: `未开始 Bug 发现的草稿已升级 user_query 规则 V${CURRENT_BUG_POLICY_VERSION}`,
    }].slice(-300);
    await writePipelineJob(job);
  }
  const quotaUpgrade = upgradeUnfinishedPipelineBugQuota(job);
  if (quotaUpgrade.changed) {
    job = quotaUpgrade.job;
    const upgradedAt = new Date().toISOString();
    job.updatedAt = upgradedAt;
    job.logs = [...(job.logs || []), {
      at: upgradedAt,
      level: 'info',
      stageId: job.currentStage,
      message: `项目 Bug 配额已按 ${job.request.projectTier === 'large' ? '大型' : '标准'}等级从 ${quotaUpgrade.previousBugCount} 补齐为 ${quotaUpgrade.bugCount}，保留已有 Bug 并继续处理新增槽位`,
    }].slice(-300);
    await writePipelineJob(job);
    const listedIndex = allJobs.findIndex((item) => item.id === job.id);
    if (listedIndex >= 0) allJobs[listedIndex] = job;
  }
  const contributorId = job.request?.contributorId || job.request?.creator || '';
  if (isContributorQualityBlocked(submissionQualityState, contributorId)) {
    throw new Error(`提交人 ${contributorId} 已触发项目质量事故熔断，不能继续运行该项目`);
  }
  const admittedStage = nextPipelineStage(job);
  if (!nodeRoleCanExecuteStage(pipelineNodeRole, admittedStage)) {
    throw new Error(`阶段 ${admittedStage} 等待 B 电脑 repair-worker，producer 不会在本机执行`);
  }
  const resourceSlots = await activePipelineResourceSlotSnapshot();
  const startCapacity = pipelineStageStartCapacity(allJobs, admittedStage, effectiveMaxConcurrency, {
    activeLeaseCounts: resourceSlots.counts,
    reuseExistingAdmission: reusesExistingAdmission,
  });
  if (!startCapacity.allowed) throw new Error(`生产流水线资源池 ${startCapacity.pool} 已满（${startCapacity.occupied}/${startCapacity.limit}）`);
  if (activePipelineProcesses.has(jobId)) throw new Error('流水线作业已经在运行');
  if (state.status === 'running' || state.status === 'stopping' || activeProcesses.size) throw new Error('任务队列正在运行，请先等待完成或停止任务队列');
  const blockers = pipelineJobStartBlockers(job, pipelineHealthState, resourcePolicy, currentPipelineBudget(allJobs));
  if (blockers.length) throw new Error(`流水线暂不能启动：${blockers.join('；')}`);
  const rollout = pipelineRolloutDecision(allJobs, CURRENT_WORKFLOW_VERSION, pipelineRolloutState);
  if (Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION && !externalResume) {
    if (rollout.mode === 'drain_to_v2' && rollout.legacyActiveCount > 0) throw new Error(`正在排空 ${rollout.legacyActiveCount} 个旧流程，V2 暂不启动`);
    if (rollout.mode === 'v2_canary' && !rolloutEligibleJobs([job], rollout).length) throw new Error(`V2 canary ${rollout.canaryJobId} 通过前，自动 V2 项目保持等待`);
  }
  if (job.status === 'passed') throw new Error('流水线作业已完成，无需重复启动');
  if (job.status === 'abandoned') throw new Error('流水线作业已废弃，不能再次启动');
  if (job.status === 'waiting_review') {
    const reviewStage = (job.stages || []).find((stage) => stage.id === job.currentStage);
    if (reviewStage?.stage === 'user_query_review' && !['passed', 'skipped'].includes(reviewStage.status)) {
      throw new Error('请先在 Bug 工作台编辑并确认 user_query');
    }
  }
  if (['queued', 'running'].includes(job.status)) throw new Error('流水线作业已经在运行，请勿重复启动');
  const previousStatus = job.status;
  if (automatic && previousStatus === 'failed') {
    const nextRetryCount = Number(job.autoRetryCount || 0) + 1;
    if (nextRetryCount > MAX_PIPELINE_AUTO_RETRIES) throw new Error(`流水线已达到 ${MAX_PIPELINE_AUTO_RETRIES} 次自动重启上限`);
    job.autoRetryCount = nextRetryCount;
    job.lastAutoRetryAt = new Date().toISOString();
  } else if (!automatic && !externalResume && previousStatus === 'failed') {
    job.autoRetryCount = 0;
    if (Number(job.workflowVersion || 1) < CURRENT_WORKFLOW_VERSION) job.legacyAutoRetryEnabled = true;
  }
  for (const stage of job.stages || []) {
    if (stage.status === 'running') {
      stage.status = 'pending';
      stage.error = '';
      stage.finishedAt = null;
    }
  }
  job.status = 'queued';
  delete job.dependencyWaitService;
  delete job.waitingResource;
  delete job.manualRetryRequestedAt;
  delete job.retryRequestedAt;
  job.schedulerLease = { stageId: admittedStage, admittedAt: new Date().toISOString() };
  job.error = '';
  job.finishedAt = null;
  job.updatedAt = new Date().toISOString();
  await writePipelineJob(job);
  return job;
}

async function startPipelineJob(jobId, options = {}) {
  const previous = pipelineStartTail;
  let release;
  pipelineStartTail = new Promise((resolve) => { release = resolve; });
  await previous;
  let job;
  let child;
  try {
    job = await preparePipelineStart(jobId, options);
    await fsp.rm(path.join(path.dirname(pipelineJobFile(jobId)), 'stop-request.json'), { force: true });
    const runnerEnvironment = { ...process.env };
    delete runnerEnvironment.GO_PIPELINE_WORKER_TOKEN;
    delete runnerEnvironment.GO_TASK_MONITOR_CLOUD_USERNAME;
    delete runnerEnvironment.GO_TASK_MONITOR_CLOUD_PASSWORD;
    child = spawn(process.execPath, [pipelineRunnerPath, pipelineJobFile(jobId)], {
      cwd: import.meta.dirname,
      env: {
        ...runnerEnvironment,
        GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'local',
        GO_PIPELINE_CODEX_BIN: codexCliPath,
        GO_PIPELINE_CLAUDE_BIN: claudeCliPath,
        GO_PIPELINE_BUGFIX_MODEL: process.env.GO_PIPELINE_BUGFIX_MODEL || 'model_hub/glm-52-coding',
        GO_PIPELINE_EXECUTION_ROLE: pipelineNodeRole,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    activePipelineProcesses.set(jobId, { pid: child.pid, child, adopted: false });
  } finally {
    release();
  }
  addLog('info', `启动生产流水线：${jobId}（当前 ${activePipelineProcesses.size} 个 Runner，按阶段资源池独立限流）`);
  child.stdout.on('data', (chunk) => {
    const output = String(chunk).trim();
    if (output) addLog('info', `[${jobId}] ${output}`);
  });
  child.stderr.on('data', (chunk) => {
    const output = String(chunk).trim();
    if (output) addLog('warn', `[${jobId}] ${output}`);
  });
  const finish = async (code, signal, spawnError = '') => {
    if (activePipelineProcesses.get(jobId)?.child !== child) return;
    activePipelineProcesses.delete(jobId);
    const latest = await readPipelineJob(jobId).catch(() => null);
    const stopped = pipelineStopRequests.has(jobId);
    if (latest && ['queued', 'running'].includes(latest.status)) {
      latest.status = stopped ? 'stopped' : 'failed';
      latest.error = stopped ? '流水线已由用户停止' : (spawnError || `流水线异常结束（exit=${code ?? 'none'} signal=${signal || 'none'}）`);
      latest.finishedAt = new Date().toISOString();
      latest.updatedAt = latest.finishedAt;
      await writePipelineJob(latest);
    }
    if (!stopped) {
      const terminalJob = await readPipelineJob(jobId).catch(() => latest);
      if (terminalJob) await recordTerminalSubmissionQualityIncident(terminalJob);
    }
    const rateLimitText = `${spawnError || ''}\n${latest?.error || ''}`;
    if (!stopped && /(?:\b429\b|rate[_ -]?limit|too many requests)/i.test(rateLimitText)) {
      pipelineRateLimitCooldownUntil = Math.max(pipelineRateLimitCooldownUntil, Date.now() + 10 * 60_000);
      await writePipelineSchedulerState();
      addLog('warn', `检测到模型 429，新的流水线启动并发暂降为 1，冷却至 ${new Date(pipelineRateLimitCooldownUntil).toLocaleString('zh-CN', { hour12: false })}`);
    }
    pipelineStopRequests.delete(jobId);
    addLog(code === 0 ? 'success' : 'warn', `生产流水线 ${jobId} 已结束（exit=${code ?? 'none'} signal=${signal || 'none'}）`);
    if (!stopped) {
      void autoUploadCompletedTrajectories();
      void reconcileUploadedPipelineJobs();
      if (pipelineAutoFillEnabled) void fillPipelineSlots();
      else {
        const waiting = await readPipelineJob(jobId).catch(() => null);
        if (isManualBugQueue(waiting)) scheduleManualBugRetry(jobId, '阶段资源交接');
      }
    }
  };
  child.once('error', (error) => { void finish(null, null, error.message); });
  child.once('close', (code, signal) => { void finish(code, signal); });
  return publicPipelineJob({ ...job, processActive: true });
}

function schedulePipelineFillRetry(reason = '调度器状态变化') {
  if (pipelineFillRetryTimer || !pipelineAutoFillEnabled || pipelineControlMode !== 'running') return;
  pipelineFillRetryTimer = setTimeout(() => {
    pipelineFillRetryTimer = null;
    void fillPipelineSlots();
  }, 5_000);
  pipelineFillRetryTimer.unref?.();
  addLog('warn', `中央调度将在 5 秒后重试补位：${String(reason).slice(0, 240)}`);
}

function isManualBugQueue(job) {
  const execution = normalizeBugExecution(job?.bugExecution);
  return job?.status === 'waiting_resource'
    && Number.isInteger(execution.selectedBugIndex)
    && execution.selectedBugIndex > 0
    && ['manual_start', 'manual_retry', 'user_switched', 'quality_rejection_recovery'].includes(execution.lastAction)
    && ['fast_lane_queued', 'fast_lane_running', 'fast_lane_switching'].includes(execution.status);
}

function scheduleManualBugRetry(jobId, reason = '等待资源') {
  if (!jobId || manualPipelineRetryTimers.has(jobId) || pipelineControlMode !== 'paused') return;
  const timer = setTimeout(async () => {
    manualPipelineRetryTimers.delete(jobId);
    if (pipelineControlMode !== 'paused') return;
    const job = await readPipelineJob(jobId).catch(() => null);
    if (!isManualBugQueue(job) || activePipelineProcesses.has(jobId)) return;
    try {
      await startPipelineJob(jobId, { externalResume: true });
      addLog('info', `Bug 工作台继续执行 ${jobId} ${job.currentStage || ''}`.trim());
    } catch (error) {
      const retryable = isRetryablePipelineStartError(error);
      if (retryable) scheduleManualBugRetry(jobId, error.message);
      else addLog('warn', `Bug 工作台续跑 ${jobId} 失败：${error.message}`);
    }
  }, 5_000);
  timer.unref?.();
  manualPipelineRetryTimers.set(jobId, timer);
  addLog('info', `Bug 工作台 ${jobId} 将在资源可用后继续：${String(reason).slice(0, 160)}`);
}

async function resumePausedManualBugQueues(reason = '暂停调度期间继续人工 Bug') {
  if (pipelineControlMode !== 'paused') return;
  for (const job of await listPipelineJobs()) {
    if (isManualBugQueue(job)) scheduleManualBugRetry(job.id, reason);
  }
}

async function reconcilePipelineResourceSlots() {
  const slotsRoot = path.join(pipelineRefillRoot, 'resource-slots');
  const pools = await fsp.readdir(slotsRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const pool of pools) {
    if (!pool.isDirectory()) continue;
    const poolRoot = path.join(slotsRoot, pool.name);
    const slots = await fsp.readdir(poolRoot, { withFileTypes: true }).catch(() => []);
    for (const slot of slots) {
      if (!slot.isDirectory()) continue;
      const slotDir = path.join(poolRoot, slot.name);
      const ownerPath = path.join(slotDir, 'owner.json');
      const owner = await fsp.readFile(ownerPath, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
      const slotStat = await fsp.stat(slotDir).catch(() => null);
      const slotAgeMs = slotStat ? Date.now() - slotStat.mtimeMs : Number.POSITIVE_INFINITY;
      // A runner publishes owner.json immediately after claiming the directory.
      // Do not delete a fresh, owner-less directory while that publication is in flight.
      let stale = (!owner && slotAgeMs > RESOURCE_SLOT_ACQUIRE_GRACE_MS)
        || (Boolean(owner) && !processIsAlive(Number(owner.pid)));
      if (!stale && owner?.jobFile) {
        const jobId = path.basename(path.dirname(owner.jobFile));
        const job = /^pipeline-[a-z0-9-]+$/i.test(jobId)
          ? await readPipelineJob(jobId).catch(() => null)
          : null;
        const stage = String(owner.stageId || '');
        const workerStage = String(owner.workerStageId || '');
        const activeStages = new Set([
          String(job?.currentStage || ''),
          String(nextPipelineStage(job) || ''),
          ...(job?.bugs || [])
            .filter((bug) => ['fast_lane_running', 'fast_lane_switching'].includes(String(bug?.workerExecution?.status || '')))
            .flatMap((bug) => [
              String(bug?.workerExecution?.currentStage || ''),
              String(bug?.workerExecution?.resourceStage || ''),
            ]),
        ].filter(Boolean));
        for (const activeStage of [...activeStages]) {
          if (activeStage.endsWith('_pre_verify') || activeStage.endsWith('_post_verify')) {
            activeStages.add(activeStage.replace(/_(?:pre|post)_verify$/, '_docker_validation'));
          }
        }
        const stillOwnsStage = job
          && ['queued', 'running'].includes(job.status)
          && (activeStages.has(stage)
            || (workerStage && activeStages.has(workerStage))
            // Runners started before workerStageId was added still own these
            // virtual structured-Codex stages through their live project PID.
            || (['codex_injection', 'codex_injection_plan'].includes(stage)
              && Number(owner.pid) === Number(job.runnerPid)));
        stale = !stillOwnsStage;
      }
      if (!stale) continue;
      await fsp.rm(slotDir, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed) addLog('info', `中央调度清理失效资源槽位 ${removed} 个`);
  return removed;
}

async function reconcileStaleQueuedPipelineReservations() {
  const jobs = await listPipelineJobs();
  const liveRunnerJobIds = new Set((await scanPipelineRunnerProcesses()).keys());
  let repaired = 0;
  for (const job of jobs) {
    if (!isStaleQueuedPipelineReservation(job, liveRunnerJobIds)) continue;
    const at = new Date().toISOString();
    const waiting = queuePipelineManualRetry(job, at, 'stale_queued_runner_recovered');
    waiting.logs = [...(waiting.logs || []), {
      at,
      level: 'warn',
      stageId: waiting.currentStage || null,
      message: '检测到 queued 状态没有调度租约或存活 Runner，已回收到中央等待队列',
    }].slice(-300);
    await writePipelineJob(waiting);
    repaired += 1;
  }
  if (repaired) addLog('warn', `中央调度回收 ${repaired} 个无 Runner 的陈旧 queued 占位`);
  return repaired;
}

async function fillPipelineSlots() {
  if (!await checkDatastoreIntegrity()) return;
  if (['pending', 'running'].includes(pipelineResourceMaintenanceState.status)) return;
  if (!pipelineAutoFillEnabled || pipelineControlMode !== 'running' || pipelineAutoFillRunning) return;
  if (state.status === 'running' || state.status === 'stopping' || activeProcesses.size) return;
  pipelineAutoFillRunning = true;
  try {
    await reconcilePipelineResourceSlots();
    await reconcileStaleQueuedPipelineReservations();
    await abandonTerminalPipelineJobs();
    void ensurePipelineRefill();
    while (pipelineAutoFillEnabled) {
      const jobs = await listPipelineJobs();
      const rollout = pipelineRolloutDecision(jobs, CURRENT_WORKFLOW_VERSION, pipelineRolloutState);
      if (rollout.transition === 'legacy_drained') {
        await updatePipelineRollout({ mode: rollout.mode, canaryJobId: rollout.canaryJobId }, `旧流程已经排空，开始 V2 canary：${rollout.canaryJobId}`);
      } else if (rollout.transition === 'canary_passed') {
        await updatePipelineRollout({ mode: rollout.mode, canaryJobId: rollout.canaryJobId }, `V2 canary ${rollout.canaryJobId} 已通过，正式开放 V2 四路并发`);
      } else if (rollout.transition === 'canary_replaced') {
        await updatePipelineRollout({ mode: rollout.mode, canaryJobId: rollout.canaryJobId }, `V2 canary 已切换到替补项目：${rollout.canaryJobId}`);
      } else if (rollout.transition === 'canary_detected') {
        await updatePipelineRollout({ mode: rollout.mode, canaryJobId: rollout.canaryJobId }, `排空切换期间检测到已启动的 V2 canary：${rollout.canaryJobId}；其余 V2 继续等待`);
      } else if (rollout.transition === 'rollout_disabled_for_v3') {
        await updatePipelineRollout({ mode: 'v2_live', canaryJobId: '' }, 'V3 已接管生产流水线，关闭旧 V2 单项目 canary 门禁并恢复双项目并发');
        pipelineRolloutState = { ...pipelineRolloutState, mode: 'v2_live', canaryJobId: '' };
      }
      if (rollout.mode === 'drain_to_v2' && rollout.legacyActiveCount > 0) break;
      const occupiedJobIds = pipelineOccupiedJobIds(jobs);
      const resourcePolicy = currentPipelineResourcePolicy();
      const effectiveMaxConcurrency = resourcePolicy.effectiveMaxConcurrency;
      if (!effectiveMaxConcurrency) break;
      const availableCapacity = pipelineAutofillStartCapacity(
        jobs,
        effectiveMaxConcurrency,
        MAX_PIPELINE_CONCURRENCY,
      );
      if (!availableCapacity) break;
      const budget = currentPipelineBudget(jobs);
      const resourceSlots = await activePipelineResourceSlotSnapshot();
      const snapshotInProgress = Boolean(await fsp.stat(path.join(path.dirname(managedLibraryRoot), 'go-task-library-backups', '.snapshot.lock')).catch(() => null));
      const autofillEligibleJobs = jobs.filter((job) => isPipelineAutofillEligible(job, CURRENT_WORKFLOW_VERSION, CURRENT_VERIFICATION_POLICY_VERSION));
      const continuationPredicate = (job) => {
        if (job.status === 'failed' && job.watchdogTriagePending) return false;
        if (job.dependencyWaitService && Number(pipelineServiceOnlineStreaks.get(job.dependencyWaitService) || 0) < 3) return false;
        return pipelineJobStartBlockers(job, pipelineHealthState, resourcePolicy, budget).length === 0;
      };
      // Apply the rollout allow-list before candidate selection. During the
      // V2 canary phase, higher-priority waiting jobs must not consume the
      // selection quota and then get filtered out afterwards; doing so can
      // leave the canary failed forever with an apparently idle scheduler.
      const rolloutCandidates = rolloutEligibleJobs(autofillEligibleJobs, rollout);
      const roleEligibleCandidates = rolloutCandidates.filter((job) => (
        nodeRoleCanExecuteStage(pipelineNodeRole, nextPipelineStage(job))
      ));
      let candidates = selectPipelineAutofillCandidates(
        roleEligibleCandidates,
        occupiedJobIds,
        availableCapacity,
        {
          snapshotInProgress,
          preserveContinuationPriority: true,
          blockNewProjectOnAnyResourceWait: true,
          continuationPredicate,
          candidatePredicate: (job) => {
            if (!continuationPredicate(job)) return false;
            const reuseExistingAdmission = pipelineResumeUsesExistingAdmission(job, true);
            if (!pipelineStageStartCapacity(jobs, nextPipelineStage(job), effectiveMaxConcurrency, {
              // Keep all waiters visible to fairness checks even when the
              // rollout allow-list narrows the actual launch candidates.
              waitingJobs: autofillEligibleJobs,
              activeLeaseCounts: resourceSlots.counts,
              reuseExistingAdmission,
            }).allowed) return false;
            return true;
          },
        },
      );
      // Start as many independent projects as the current global capacity allows.
      // The previous single-candidate cap made a four-slot scheduler run only one
      // project at a time even when all resource pools were healthy.
      candidates = candidates.slice(0, Math.max(1, availableCapacity));
      if (!candidates.length) {
        void ensurePipelineRefill();
        break;
      }
      for (const candidate of candidates) {
        if (!pipelineAutoFillEnabled) break;
        try {
          await startPipelineJob(candidate.id, {
            automatic: true,
            externalResume: pipelineResumeUsesExistingAdmission(candidate, true),
          });
          const retryLabel = candidate.status === 'failed'
            ? `自动重启 ${Number(candidate.autoRetryCount || 0) + 1}/${MAX_PIPELINE_AUTO_RETRIES}`
            : candidate.status === 'waiting_resource' ? '中央调度续跑' : '自动补位';
          const runningCount = pipelineOccupiedJobIds(await listPipelineJobs()).size;
          addLog('info', `${retryLabel}生产流水线：${candidate.id}（当前 ${runningCount} 个 Runner，按阶段资源池独立限流）`);
        } catch (error) {
          addLog('warn', `自动补位 ${candidate.id} 失败：${error.message}`);
          schedulePipelineFillRetry(`${candidate.id}：${error.message}`);
          return;
        }
      }
    }
  } catch (error) {
    addLog('error', `中央调度补位异常：${error.stack || error.message}`);
    schedulePipelineFillRetry(error.message);
  } finally {
    pipelineAutoFillRunning = false;
  }
}

async function signalPipelineProcess(jobId, signal = 'SIGTERM') {
  const handle = activePipelineProcesses.get(jobId);
  if (!handle || !processIsAlive(handle.pid)) throw new Error('该流水线当前没有可管理的运行进程');
  try {
    process.kill(-handle.pid, signal);
  } catch {
    process.kill(handle.pid, signal);
  }
  return handle;
}

async function stopPipelineJob(jobId, { pauseScheduling = true, reason = 'user_stopped', source = 'pipeline_stop' } = {}) {
  if (pauseScheduling) await setPipelineControlMode('paused');
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  if (reason === 'user_stopped') {
    job.manualHold = true;
    delete job.manualRetryRequestedAt;
    delete job.retryRequestedAt;
    delete job.pendingBugRetries;
    job.updatedAt = new Date().toISOString();
    await writePipelineJob(job);
  }
  const handle = activePipelineProcesses.get(jobId);
  if (!handle && ['leased', 'running', 'cancel_requested'].includes(String(job.remoteExecution?.status || ''))) {
    const requestedAt = new Date().toISOString();
    job.remoteExecution = {
      ...job.remoteExecution,
      status: 'cancel_requested',
      cancelReason: reason,
      cancelSource: source,
      cancelRequestedAt: requestedAt,
      updatedAt: requestedAt,
    };
    job.status = 'waiting_resource';
    job.error = '已通知 B 电脑停止远程 Runner';
    job.updatedAt = requestedAt;
    await writePipelineJob(job);
    return;
  }
  if (!handle || !processIsAlive(handle.pid)) {
    job.status = 'stopped';
    job.finishedAt = new Date().toISOString();
    job.runnerPid = null;
    job.schedulerLease = null;
    job.waitingResource = null;
    job.error = '人工停止，流水线保持暂停';
    job.updatedAt = job.finishedAt;
    job.bugExecution = {
      ...normalizeBugExecution(job.bugExecution),
      status: 'fast_lane_stopped',
      selectedBugIndex: null,
      currentStage: '',
      currentAttempt: 0,
      blockedReason: '',
      lastAction: reason,
      updatedAt: job.finishedAt,
    };
    await writePipelineJob(job);
    return;
  }
  pipelineStopRequests.add(jobId);
  await writePipelineStopRequest(jobId, reason, source);
  await signalPipelineProcess(jobId, 'SIGTERM');
}

async function waitForPipelineProcessExit(jobId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (activePipelineProcesses.has(jobId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !activePipelineProcesses.has(jobId);
}

async function updateBugWorkbench(jobId, mutator) {
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  const execution = normalizeBugExecution(job.bugExecution);
  await mutator(job, execution);
  execution.updatedAt = new Date().toISOString();
  job.bugExecution = execution;
  job.updatedAt = execution.updatedAt;
  await writePipelineJob(job);
  return job;
}

async function updatePipelineJob(jobId, mutator) {
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  await mutator(job);
  job.updatedAt = new Date().toISOString();
  await writePipelineJob(job);
  return job;
}

async function reviewPipelineBugUserQuery(jobId, bugIndex, body = {}) {
  const index = Number(bugIndex);
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
  if (!bug) throw new Error(`Bug ${index} 尚未生成`);
  const reviewStage = (job.stages || []).find((stage) => stage.id === `bug${index}_user_query_review`);
  if (!reviewStage) throw new Error('当前流程没有 user_query 人工确认阶段');
  const readiness = pipelineUserQueryReadiness(job);
  if (body.confirm === true && !readiness.ready) {
    const pending = readiness.unpreparedBugIndexes.length
      ? `Bug ${readiness.unpreparedBugIndexes.join('、')} 尚未完成 BUG_BASE 准备`
      : `题面复核阶段数量为 ${readiness.reviewStageCount}/${readiness.requestedBugCount}`;
    throw new Error(`全部 Bug 准备完成后才能确认题面：${pending}`);
  }
  if (reviewStage.status === 'passed' && body.confirm !== false) {
    return { job: publicPipelineJob(job), message: `Bug ${index} 的 user_query 已确认` };
  }
  const draft = String(body.user_query ?? bug.discovery?.user_query ?? '').trim();
  const validation = validateUserQueryDraft(draft);
  if (!validation.ok) throw new Error(validation.issues.join('；'));
  const confirmed = body.confirm === true;
  const at = new Date().toISOString();
  const updatedJob = structuredClone(job);
  {
    const current = updatedJob;
    const target = (current.bugs || []).find((item) => Number(item.bugIndex) === index);
    if (!target) throw new Error(`Bug ${index} 尚未生成`);
    target.discovery ||= {};
    target.discovery.user_query = draft;
    target.userQueryDraft = draft;
    target.userQueryReviewStatus = confirmed ? 'confirmed' : 'draft';
    target.userQueryReviewedAt = confirmed ? at : null;
    const stage = (current.stages || []).find((item) => item.id === `bug${index}_user_query_review`);
    if (stage && confirmed) {
      stage.status = 'passed';
      stage.error = '';
      stage.reason = '';
      stage.finishedAt = at;
      stage.result = { confirmedAt: at };
    }
    if (stage && !confirmed) {
      stage.reviewStartedAt ||= at;
    }
    current.userQueryReviewStartedAt ||= at;
    current.updatedAt = at;
    current.error = '';
    if (confirmed) {
      current.status = 'waiting_review';
      current.currentStage = (current.stages || []).find((item) => !['passed', 'skipped'].includes(item.status))?.id || null;
      current.finishedAt = null;
      current.bugExecution = {
        ...normalizeBugExecution(current.bugExecution),
        selectedBugIndex: null,
        status: 'bug_ready',
        currentStage: current.currentStage || '',
        blockedReason: '',
        lastAction: 'user_query_confirmed',
        updatedAt: at,
      };
    }
  }
  await writePipelineJob(updatedJob);
  const updated = updatedJob;
  if (!confirmed) return { job: publicPipelineJob(updated), message: `Bug ${index} 的 user_query 草稿已保存，确认后才会继续流水线` };
  const pendingReviews = (updated.stages || [])
    .filter((item) => item.stage === 'user_query_review' && !['passed', 'skipped'].includes(item.status));
  if (pendingReviews.length) {
    updated.status = 'waiting_review';
    updated.currentStage = pendingReviews
      .sort((left, right) => Number(left.bugIndex || 0) - Number(right.bugIndex || 0))[0].id;
    updated.finishedAt = null;
    updated.bugExecution = {
      ...normalizeBugExecution(updated.bugExecution),
      selectedBugIndex: null,
      status: 'bug_ready',
      currentStage: updated.currentStage,
      blockedReason: `还需确认 ${pendingReviews.length} 个 user_query`,
      lastAction: 'user_query_saved_waiting_batch_confirmation',
      updatedAt: at,
    };
    await writePipelineJob(updated);
    return { job: publicPipelineJob(updated), message: `Bug ${index} 的 user_query 已确认，还需确认 ${pendingReviews.length} 个，全部确认后才会继续流水线` };
  }
  try {
    const started = await startPipelineJob(jobId, { externalResume: true });
    return { job: started, message: `Bug ${index} 的 user_query 已确认，流水线继续执行` };
  } catch (error) {
    if (!isRetryablePipelineStartError(error)) throw error;
    const waiting = await readPipelineJob(jobId);
    const queued = queuePipelineManualRetry(waiting, new Date().toISOString(), 'user_query_review_capacity');
    await writePipelineJob(queued);
    void fillPipelineSlots();
    return { job: publicPipelineJob(queued), message: `Bug ${index} 已确认，等待中央调度继续执行` };
  }
}

// Injection failures are a separate review gate from user_query editing. A
// retry keeps the rejected-candidate evidence and re-enters only the source
// preparation stage; continuing skips the unproven slot because there is no
// valid BUG_BASE that could legally enter Claude repair.
async function resolvePipelineInjectionReview(jobId, action, { automatic = false } = {}) {
  const normalizedAction = action === 'retry' ? 'retry' : action === 'continue' ? 'continue' : '';
  if (!normalizedAction) throw new Error('注入复核动作不合法');
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  const pendingIndexes = [...new Set((job.injectionReviewPending?.bugIndexes || []).map(Number))]
    .filter((index) => Number.isInteger(index) && index > 0);
  if (job.status !== 'waiting_review' || !pendingIndexes.length) {
    throw new Error('当前没有待处理的注入复核');
  }
  const at = new Date().toISOString();
  await updatePipelineJob(jobId, (current) => {
    const pending = new Set((current.injectionReviewPending?.bugIndexes || []).map(Number));
    for (const index of pendingIndexes) {
      if (!pending.has(index)) continue;
      const bug = (current.bugs || []).find((item) => Number(item.bugIndex) === index);
      if (!bug) continue;
      const sourceStage = (current.stages || []).find((stage) => stage.id === `bug${index}_bug_source_prepare`);
      const reviewStage = (current.stages || []).find((stage) => stage.id === `bug${index}_user_query_review`);
      const prep = bug.injectionPreparation || {};
      if (normalizedAction === 'retry') {
        bug.injectionPreparation = {
          ...prep,
          status: 'retry_pending',
          reviewAction: 'retry',
          reviewResolvedAt: at,
          updatedAt: at,
        };
        if (sourceStage) {
          sourceStage.status = 'pending';
          sourceStage.startedAt = null;
          sourceStage.finishedAt = null;
          sourceStage.error = '';
          sourceStage.reason = `人工选择重新规划注入，保留前 ${prep.attempts || 0} 次失败记录`;
          delete sourceStage.result;
        }
      } else {
        bug.injectionPreparation = {
          ...prep,
          status: 'stopped',
          reviewAction: 'continue_without_injection',
          reviewResolvedAt: at,
          updatedAt: at,
        };
        bug.bugSource = 'injection_skipped';
        bug.disposition = 'skipped';
        bug.failureDisposition = 'injection_review_stopped';
        bug.discovery = { ...(bug.discovery || {}), found: false, reason: '注入候选连续失败，人工停止注入并跳过该 Bug 槽位' };
        for (const stage of current.stages || []) {
          if (Number(stage.bugIndex) !== index || stage.stage === 'bug_discovery') continue;
          if (['passed', 'skipped'].includes(stage.status)) continue;
          stage.status = 'skipped';
          stage.startedAt ||= at;
          stage.finishedAt = at;
          stage.error = '';
          stage.reason = '无合法 BUG_BASE，人工停止注入；继续其余 Bug 流程';
          stage.result = { skipped: true, reason: 'injection_review_stopped' };
        }
        if (reviewStage && !['passed', 'skipped'].includes(reviewStage.status)) {
          reviewStage.status = 'skipped';
          reviewStage.finishedAt = at;
          reviewStage.reason = '该槽位未形成 BUG_BASE，跳过题面确认';
        }
      }
    }
    delete current.injectionReviewPending;
    delete current.injectionPlan;
    // Stopping injection is a human-review continuation, not a Runner start.
    // Keep the job in waiting_review so the batch user_query editor remains
    // visible even when the general resource pool is full. The final topic
    // confirmation will enqueue the actual Runner if resources are available.
    const nextReviewStage = (current.stages || []).find((stage) => stage.stage === 'user_query_review'
      && !['passed', 'skipped'].includes(stage.status));
    if (normalizedAction === 'continue') {
      for (const stage of current.stages || []) {
        if (stage.stage !== 'user_query_review' || ['passed', 'skipped'].includes(stage.status)) continue;
        stage.status = 'pending';
        stage.error = '';
        stage.reason = '等待人工编辑并确认 user_query';
        stage.reviewStartedAt ||= at;
      }
      current.userQueryReviewStartedAt ||= at;
    }
    current.status = normalizedAction === 'continue' ? 'waiting_review' : 'waiting_resource';
    current.error = '';
    current.finishedAt = null;
    current.schedulerLease = null;
    current.currentStage = normalizedAction === 'continue'
      ? nextReviewStage?.id || null
      : nextPipelineStage({ ...current, bugExecution: { selectedBugIndex: null } });
    current.waitingResource = normalizedAction === 'continue' ? null : {
      stageId: current.currentStage,
      pool: pipelineStageResourceProfile(current.currentStage).pool || 'general',
      queuedAt: at,
      reason: 'injection_review_retry',
    };
    current.bugExecution = {
      ...normalizeBugExecution(current.bugExecution),
      selectedBugIndex: null,
      status: normalizedAction === 'continue' ? 'bug_ready' : 'fast_lane_queued',
      currentStage: current.currentStage || '',
      blockedReason: normalizedAction === 'continue' ? '等待人工编辑并确认 user_query' : '',
      lastAction: normalizedAction === 'retry' ? 'injection_review_retry' : 'injection_review_continue',
      updatedAt: at,
    };
    current.logs = [...(current.logs || []), {
      at,
      level: automatic ? 'warn' : 'info',
      stageId: `bug${pendingIndexes[0]}_bug_source_prepare`,
      message: normalizedAction === 'retry'
        ? `人工${automatic ? '超时自动' : ''}选择重新规划注入：保留 ${pendingIndexes.join('、')} 的失败历史`
        : `人工${automatic ? '超时自动' : ''}停止注入：跳过 ${pendingIndexes.join('、')}，继续其余 Bug 流程`,
    }].slice(-300);
  });
  if (normalizedAction === 'continue') {
    return { job: publicPipelineJob(await readPipelineJob(jobId)), message: '已停止注入，请在工作台编辑并确认其余 Bug 的 user_query' };
  }
  try {
    const started = await startPipelineJob(jobId, { externalResume: true });
    return { job: started, message: normalizedAction === 'retry' ? '已重新规划注入，正在继续执行' : '已停止注入并跳过失败槽位，正在继续其余 Bug 流程' };
  } catch (error) {
    if (!isRetryablePipelineStartError(error)) throw error;
    const waiting = await readPipelineJob(jobId);
    if (waiting) {
      const queued = queuePipelineManualRetry(waiting, new Date().toISOString(), error.message);
      await writePipelineJob(queued);
      void fillPipelineSlots();
      return { job: publicPipelineJob(queued), message: '人工处理已记录，等待中央调度资源继续执行' };
    }
    throw error;
  }
}

async function autoConfirmStaleUserQueryReviews() {
  const nowMs = Date.now();
  const jobs = await listPipelineJobs();
  for (const visibleJob of jobs) {
    if (visibleJob.status !== 'waiting_review') continue;
    const job = await readPipelineJob(visibleJob.id);
    if (!job || job.status !== 'waiting_review') continue;
    const stale = (job.stages || [])
      .filter((stage) => isUserQueryReviewStale(stage, nowMs))
      .sort((left, right) => Number(left.bugIndex || 0) - Number(right.bugIndex || 0));
    for (const stage of stale) {
      const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === Number(stage.bugIndex));
      const draft = String(bug?.userQueryDraft || bug?.discovery?.user_query || '').trim();
      if (!draft) {
        addLog('warn', `自动确认跳过 ${job.id} Bug ${stage.bugIndex}：题面为空`);
        continue;
      }
      try {
        await reviewPipelineBugUserQuery(job.id, Number(stage.bugIndex), { confirm: true, user_query: draft });
        addLog('info', `人工题面超过 ${Math.round(USER_QUERY_AUTO_CONFIRM_TIMEOUT_MS / 60_000)} 分钟未操作，已自动确认 ${job.id} Bug ${stage.bugIndex}`);
      } catch (error) {
        addLog('warn', `自动确认 ${job.id} Bug ${stage.bugIndex} 失败：${error.message}`);
      }
    }
  }
}

async function autoResolveStaleInjectionReviews() {
  const nowMs = Date.now();
  for (const visibleJob of await listPipelineJobs()) {
    if (!isInjectionReviewStale(visibleJob, nowMs)) continue;
    try {
      await resolvePipelineInjectionReview(visibleJob.id, 'continue', { automatic: true });
      addLog('warn', `注入复核超过 ${Math.round(INJECTION_REVIEW_AUTO_CONTINUE_TIMEOUT_MS / 60_000)} 分钟未操作，已自动停止注入并继续 ${visibleJob.id}`);
    } catch (error) {
      addLog('warn', `注入复核自动处理 ${visibleJob.id} 失败：${error.message}`);
    }
  }
}

async function controlPipelineBug(jobId, bugIndex, action, body = {}) {
  const index = Number(bugIndex);
  if (!Number.isInteger(index) || index < 1) throw new Error('Bug 编号不合法');
  let job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
  if (!bug) throw new Error(`Bug ${index} 尚未生成，不能进入工作台`);
  // A stopped/adopted Runner can leave a handle in the monitor map until its
  // close event is observed. Never let that stale PID turn a fresh retry into
  // a queue-only response forever.
  const activeHandle = activePipelineProcesses.get(jobId);
  if (activeHandle && !processIsAlive(Number(activeHandle.pid))) {
    activePipelineProcesses.delete(jobId);
  }
  if (!activePipelineProcesses.has(jobId)) {
    const liveRunner = (await scanPipelineRunnerProcesses()).get(jobId);
    if (liveRunner && processIsAlive(liveRunner.pid)) {
      activePipelineProcesses.set(jobId, {
        pid: liveRunner.pid,
        child: null,
        adopted: true,
        command: liveRunner.command,
      });
    }
  }
  // The persisted job status can briefly lag behind an adopted Runner after
  // an API restart. The live process is authoritative for retry/switch logic;
  // otherwise a harmless retry can start a duplicate Runner or move the UI
  // cursor backwards while another Bug is still executing.
  const runnerHandle = activePipelineProcesses.get(jobId);
  const runnerActive = Boolean(runnerHandle && processIsAlive(Number(runnerHandle.pid)));
  const missingIndependentTest = Number(job.verificationPolicyVersion || 0) >= CURRENT_VERIFICATION_POLICY_VERSION
    && (!bug.verificationTestAuthor?.sourceDir || !bug.verificationTestAuthor?.testFile);
  if (isPipelineBugDeliveryComplete(job, index) && !(action === 'retry' && missingIndependentTest)) {
    return {
      job: publicPipelineJob(job),
      message: `Bug ${index} 已交付，忽略重复的${action === 'retry' ? '重试' : action === 'switch' ? '切换' : action === 'close' ? '关闭' : '启动'}请求`,
    };
  }
  if (isPipelineBugDeliveryComplete(job, index) && action === 'retry' && missingIndependentTest) {
    job = await updateBugWorkbench(jobId, (current) => {
      reactivatePipelineBug(current, index, { resetAttempts: body.resetAttempts === true });
      current.logs = [...(current.logs || []), {
        at: new Date().toISOString(),
        level: 'warn',
        stageId: `bug${index}_test_author`,
        message: `Bug ${index} 的历史交付缺少独立测试，已撤销假交付并从 test_author 恢复`,
      }].slice(-300);
    });
  }
  const autoContinue = body.autoContinue !== undefined ? Boolean(body.autoContinue) : normalizeBugExecution(job.bugExecution).autoContinue;
  if (action === 'close') {
    if (runnerActive) await stopPipelineJob(jobId, { pauseScheduling: false, reason: 'user_stopped', source: 'bug_close' }).catch(() => {});
    await waitForPipelineProcessExit(jobId);
    job = await updateBugWorkbench(jobId, (current, execution) => {
      execution.selectedBugIndex = index;
      execution.autoContinue = autoContinue;
      execution.status = 'fast_lane_stopped';
      execution.lastAction = 'user_stopped';
      current.status = 'stopped';
      current.error = '当前 Bug 已由人工工作台关闭，历史尝试和证据已保留';
      current.finishedAt = new Date().toISOString();
    });
    return { job: publicPipelineJob(job), message: `Bug ${index} 已关闭` };
  }

  // Retrying a finished/failed Bug while another Bug worker is active must be
  // a queue operation.  The Runner is project-scoped, so treating this as a
  // switch would write stop-request.json and SIGTERM the unrelated worker.
  if (runnerActive && action === 'retry') {
    const activeStage = (job.stages || [])
      .filter((stage) => stage.status === 'running')
      .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''))[0];
    const activeWorker = (job.bugs || [])
      .filter((item) => item.workerExecution?.status === 'fast_lane_running')
      .sort((left, right) => Date.parse(right.workerExecution?.updatedAt || '') - Date.parse(left.workerExecution?.updatedAt || ''))[0];
    const activeBugIndex = Number(activeStage?.bugIndex || activeWorker?.bugIndex);
    if (activeBugIndex !== index) {
      const at = new Date().toISOString();
      const queued = await updateBugWorkbench(jobId, (current) => {
        const target = (current.bugs || []).find((item) => Number(item.bugIndex) === index);
        if (!target) throw new Error(`Bug ${index} 尚未生成`);
        if (target.disposition === 'failed'
          || target.disposition === 'skipped'
          || target.failureDisposition === 'auto_continued'
          || target.trajectoryDisposition === 'skipped_pending_verification') {
          reactivatePipelineBug(current, index, { resetAttempts: body.resetAttempts === true });
        }
        const targetExecution = normalizeBugExecution({
          ...(target.workerExecution || {}),
          selectedBugIndex: index,
          currentStage: nextPipelineStage({
            ...current,
            currentStage: `bug${index}_claude_fix`,
            bugExecution: { ...normalizeBugExecution(current.bugExecution), selectedBugIndex: index },
          }),
        });
        target.workerExecution = {
          ...targetExecution,
          status: 'fast_lane_queued',
          startedAt: null,
          currentAttempt: 0,
          blockedReason: '当前 Runner 正在执行其他 Bug，等待重试队列',
          lastAction: 'manual_retry_queued',
          updatedAt: at,
        };
        enqueueBugRetry(current, index, at);
        current.error = `Bug ${index} 已加入重试队列，当前 Bug ${activeBugIndex || '其他'} 继续执行`;
        current.finishedAt = null;
        current.status = ['queued', 'waiting_resource'].includes(current.status) ? current.status : 'running';
      });
      return {
        job: publicPipelineJob(queued),
        message: `Bug ${index} 已加入重试队列，当前 Runner 继续执行${activeBugIndex ? ` Bug ${activeBugIndex}` : ''}`,
      };
    }
  }

  if (runnerActive) {
    const activeStage = (job.stages || [])
      .filter((stage) => stage.status === 'running')
      .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''))[0];
    const activeBugIndex = Number(activeStage?.bugIndex);
    if (activeBugIndex === index && action !== 'switch') {
      return {
        job: publicPipelineJob(job),
        message: `Bug ${index} 已在执行 ${activeStage.id}，无需重复启动`,
      };
    }
    await updateBugWorkbench(jobId, (current, execution) => {
      execution.selectedBugIndex = index;
      execution.autoContinue = autoContinue;
      execution.status = 'fast_lane_switching';
      execution.lastAction = 'user_switched';
      current.error = `正在切换到 Bug ${index}`;
    });
    await stopPipelineJob(jobId, { pauseScheduling: false, reason: 'user_switched', source: 'bug_switch' }).catch(() => {});
    if (!await waitForPipelineProcessExit(jobId)) throw new Error(`切换到 Bug ${index} 前，旧 Runner 未能及时退出`);
  }

  const resumedFromStoppedScheduler = pipelineControlMode !== 'running';
  if (resumedFromStoppedScheduler) {
    await setPipelineControlMode('paused');
    addLog('info', `Bug 工作台人工启动 ${jobId} Bug ${index}；自动补题保持暂停`);
  }
  job = await updateBugWorkbench(jobId, (current, execution) => {
    const selectedBug = (current.bugs || []).find((item) => Number(item.bugIndex) === index);
    if (selectedBug?.disposition === 'failed'
      || selectedBug?.disposition === 'skipped'
      || selectedBug?.failureDisposition === 'auto_continued'
      || selectedBug?.trajectoryDisposition === 'skipped_pending_verification') {
      reactivatePipelineBug(current, index, { resetAttempts: body.resetAttempts === true });
    }
    execution.selectedBugIndex = index;
    execution.autoContinue = autoContinue;
    execution.status = 'fast_lane_queued';
    execution.startedAt = null;
    execution.lastAction = action === 'retry' ? 'manual_retry' : action === 'switch' ? 'user_switched' : 'manual_start';
    execution.blockedReason = '';
    const selectedStage = nextPipelineStage({ ...current, bugExecution: execution });
    execution.currentStage = selectedStage;
    current.currentStage = selectedStage;
    delete current.manualHold;
    current.manualRetryRequestedAt = new Date().toISOString();
    current.retryRequestedAt = current.manualRetryRequestedAt;
    current.error = '';
    current.finishedAt = null;
  });
  try {
    const started = await startPipelineJob(jobId, { externalResume: true });
    return {
      job: publicPipelineJob(started),
      message: `Bug ${index} 已启动，正在执行 ${started.currentStage || '当前阶段'}${resumedFromStoppedScheduler ? '；自动补题仍暂停' : ''}`,
    };
  } catch (error) {
    if (!isRetryablePipelineStartError(error)) throw error;
    const waiting = await readPipelineJob(jobId);
    if (!waiting) throw error;
    const queued = queuePipelineManualRetry(waiting, new Date().toISOString(), 'bug_workbench_capacity');
    const execution = normalizeBugExecution(queued.bugExecution);
    queued.bugExecution = {
      ...execution,
      selectedBugIndex: index,
      status: 'fast_lane_queued',
      startedAt: null,
      currentStage: queued.currentStage,
      blockedReason: `等待中央调度资源：${error.message}`,
      lastAction: action === 'retry' ? 'manual_retry' : action === 'switch' ? 'user_switched' : 'manual_start',
      updatedAt: new Date().toISOString(),
    };
    await writePipelineJob(queued);
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
    else scheduleManualBugRetry(jobId, error.message);
    return {
      job: publicPipelineJob(queued),
      message: `Bug ${index} 已加入优先队列：${error.message}`,
    };
  }
}

async function resetPipelineBugForRetry(jobId, bugIndex) {
  const index = Number(bugIndex);
  if (!Number.isInteger(index) || index < 1) throw new Error('Bug 编号不合法');
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('流水线作业不存在');
  const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === index);
  if (!bug) throw new Error(`Bug ${index} 尚未生成`);
  if (isPipelineBugDeliveryComplete(job, index)) throw new Error(`Bug ${index} 已交付，不能重置`);
  const activeStage = (job.stages || []).find((stage) => stage.status === 'running' && Number(stage.bugIndex) === index);
  if (activeStage) throw new Error(`Bug ${index} 当前正在执行 ${activeStage.id}，请等待该阶段结束后再重置`);
  const activeHandle = activePipelineProcesses.get(jobId);
  if (activeHandle && !processIsAlive(Number(activeHandle.pid))) {
    activePipelineProcesses.delete(jobId);
  }
  if (!activePipelineProcesses.has(jobId)) {
    const liveRunner = (await scanPipelineRunnerProcesses()).get(jobId);
    if (liveRunner && processIsAlive(liveRunner.pid)) {
      activePipelineProcesses.set(jobId, {
        pid: liveRunner.pid,
        child: null,
        adopted: true,
        command: liveRunner.command,
      });
    }
  }
  const runnerHandle = activePipelineProcesses.get(jobId);
  const runnerActive = Boolean(runnerHandle && processIsAlive(Number(runnerHandle.pid)));
  const taskDir = String(bug.task?.taskDir || '');
  const trajectoryCapture = taskDir
    ? await fsp.stat(path.join(taskDir, 'trajectory/trajectory.stream.jsonl')).catch(() => null)
    : null;
  const missingTrajectoryCapture = Boolean(taskDir && !trajectoryCapture?.isFile());
  const updated = await updateBugWorkbench(jobId, (current, execution) => {
    const resetAt = new Date().toISOString();
    reactivatePipelineBug(current, index, { resetAttempts: true });
    const rewoundClaudeStage = missingTrajectoryCapture
      ? rewindPipelineBugAfterMissingTrajectory(current, index, resetAt)
      : false;
    const selectedStage = nextPipelineStage({
      ...current,
      currentStage: `bug${index}_claude_fix`,
      bugExecution: { ...execution, selectedBugIndex: index },
    }) || `bug${index}_claude_fix`;
    const selectedStageRecord = (current.stages || []).find((stage) => stage.id === selectedStage);
    // Manual retry is an operational recovery boundary. A failed stage must
    // become runnable again; leaving it failed makes the queued Bug appear
    // terminal in the UI even though the live Runner will retry it.
    if (selectedStageRecord?.status === 'failed') {
      selectedStageRecord.status = 'pending';
      selectedStageRecord.startedAt = null;
      selectedStageRecord.finishedAt = null;
      selectedStageRecord.error = '';
      selectedStageRecord.reason = 'Bug 人工重置后从当前阶段继续';
      delete selectedStageRecord.result;
      delete selectedStageRecord.failureCategory;
      delete selectedStageRecord.retryCount;
      delete selectedStageRecord.maxRetries;
    }
    const selectedBug = (current.bugs || []).find((item) => Number(item.bugIndex) === index);
    if (runnerActive) {
      if (selectedBug) {
        selectedBug.workerExecution = {
          ...(selectedBug.workerExecution || {}),
          status: 'fast_lane_queued',
          currentStage: selectedStage,
          startedAt: null,
          currentAttempt: 0,
          blockedReason: '当前 Runner 正在执行其他 Bug，等待重试队列',
          lastAction: 'manual_retry_queued',
          updatedAt: resetAt,
        };
      }
      enqueueBugRetry(current, index, resetAt);
      current.logs = [...(current.logs || []), {
        at: resetAt,
        level: 'info',
        stageId: selectedStage,
        message: rewoundClaudeStage
          ? `Bug ${index} 已重置尝试次数并退回 Claude 阶段；当前 Runner 继续执行其他 Bug`
          : `Bug ${index} 已重置尝试次数并加入项目内重试队列；当前 Runner 继续执行其他 Bug`,
      }].slice(-300);
      return;
    }
    execution.selectedBugIndex = index;
    execution.status = 'fast_lane_queued';
    execution.startedAt = null;
    execution.currentAttempt = 0;
    execution.blockedReason = '等待中央调度资源';
    execution.lastAction = 'manual_retry';
    execution.currentStage = selectedStage;
    if (selectedBug) {
      selectedBug.workerExecution = {
        ...(selectedBug.workerExecution || {}),
        status: 'fast_lane_queued',
        currentStage: execution.currentStage,
        startedAt: null,
        currentAttempt: 0,
        blockedReason: '等待中央调度资源',
        lastAction: 'manual_retry',
        updatedAt: resetAt,
      };
    }
    current.bugExecution = execution;
    current.currentStage = execution.currentStage;
    current.updatedAt = resetAt;
    current.logs = [...(current.logs || []), {
      at: current.updatedAt,
      level: 'info',
      stageId: `bug${index}_claude_fix`,
      message: rewoundClaudeStage
        ? `Bug ${index} 已人工重置轨迹尝试次数；检测到轨迹缺失，已退回 Claude 阶段重新执行`
        : `Bug ${index} 已人工重置轨迹尝试次数，保留历史记录并从未完成阶段继续`,
    }].slice(-300);
  });
  if (runnerActive) {
    return {
      job: publicPipelineJob(updated),
      message: `Bug ${index} 已重置尝试次数并加入重试队列，当前 Runner 继续执行其他 Bug`,
    };
  }
  const queued = queuePipelineManualRetry(updated, updated.updatedAt, 'bug_attempt_reset');
  await writePipelineJob(queued);
  // Nudge the central scheduler immediately instead of waiting for its
  // periodic tick to notice the newly selected Bug.
  if (pipelineAutoFillEnabled) void fillPipelineSlots();
  else scheduleManualBugRetry(jobId, 'Bug 重置后等待资源');
  return { job: publicPipelineJob(await readPipelineJob(jobId)), message: `Bug ${index} 已重置尝试次数并重新排队` };
}

async function controlPipelineScheduler(mode) {
  const normalized = normalizePipelineControlMode(mode, pipelineAutoFillEnabled);
  await setPipelineControlMode(normalized);
  if (normalized === 'emergency_stopped') {
    for (const timer of manualPipelineRetryTimers.values()) clearTimeout(timer);
    manualPipelineRetryTimers.clear();
    for (const jobId of [...activePipelineProcesses.keys()]) {
      pipelineStopRequests.add(jobId);
      await writePipelineStopRequest(jobId, 'emergency_stop', 'scheduler_control').catch(() => {});
      await signalPipelineProcess(jobId, 'SIGTERM').catch((error) => addLog('warn', `紧急停止 ${jobId} 失败：${error.message}`));
    }
    for (const visibleJob of await listPipelineJobsFresh()) {
      const remote = visibleJob.remoteExecution || {};
      if (!['leased', 'running', 'cancel_requested'].includes(String(remote.status || ''))) continue;
      await stopPipelineJob(visibleJob.id, {
        pauseScheduling: false,
        reason: 'emergency_stop',
        source: 'scheduler_control',
      }).catch((error) => addLog('warn', `紧急停止远程项目 ${visibleJob.id} 失败：${error.message}`));
    }
  }
  const labels = {
    running: '闭环调度已恢复',
    paused: '已暂停创建和启动新任务，当前任务继续运行',
    draining: '已进入排空模式，当前任务完成后不再补位',
    emergency_stopped: '已发送全部流水线紧急停止请求',
  };
  addLog(normalized === 'running' ? 'success' : 'warn', labels[normalized]);
  void emitPipelineAlert({
    key: 'scheduler:control',
    severity: normalized === 'emergency_stopped' ? 'critical' : normalized === 'running' ? 'info' : 'warning',
    title: labels[normalized],
    message: `控制模式：${normalized}`,
    resolved: normalized === 'running',
  });
  if (normalized === 'running') void fillPipelineSlots();
  return labels[normalized];
}

const MANAGED_PIPELINE_TEMP_PREFIXES = [
  'go-pipeline-deepseek-claude-config-',
  'go-pipeline-project-generation-',
  'go-pipeline-project-repair-',
  'go-pipeline-baseline.',
  'go-pipeline-target.',
  'go-task-claude.',
  'go-task-docker-config.',
  'go-task-fast-red-',
  'go-task-git-publish.',
  'go-task-git-v4.',
  'go-task-package-',
  'go-task-quality-current-',
  'go-task-test-author.',
  'go-task-verify.',
];

const LEGACY_PIPELINE_BUILDX_BUILDERS = [
  'aqualeak-builder',
  'benzhi-escrow-builder',
  'flyrail-builder',
  'snapvault-benzhi-builder',
];

async function managedDiskFreeBytes() {
  const statfs = await fsp.statfs(managedLibraryRoot).catch(() => null);
  return Number(statfs?.bavail || statfs?.bfree || 0) * Number(statfs?.bsize || 0);
}

async function cleanupManagedPipelineTempDirectories({ maxAgeHours }) {
  const temporaryRoot = os.tmpdir();
  const cutoffMs = Date.now() - Math.max(1, Number(maxAgeHours) || 168) * 60 * 60_000;
  const entries = await fsp.readdir(temporaryRoot, { withFileTypes: true }).catch(() => []);
  const processSnapshot = await runCapturedCommand('ps', ['-eww', '-axo', 'command='], {
    cwd: import.meta.dirname,
    timeoutMs: 30_000,
  });
  const activeProcessText = processSnapshot.exitCode === 0 && !processSnapshot.truncated ? processSnapshot.stdout : '';
  const lsofCommand = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
  const removed = [];
  let skippedActiveCount = 0;
  let skippedUnsafeCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !MANAGED_PIPELINE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const candidate = path.join(temporaryRoot, entry.name);
    if (path.dirname(candidate) !== temporaryRoot) {
      skippedUnsafeCount += 1;
      continue;
    }
    const metadata = await fsp.lstat(candidate).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || metadata.mtimeMs > cutoffMs) continue;
    if (!activeProcessText || activeProcessText.includes(candidate) || activeProcessText.includes(entry.name)) {
      skippedActiveCount += 1;
      continue;
    }
    const openFiles = await runCapturedCommand(lsofCommand, ['-n', '-w', '+D', candidate], {
      cwd: import.meta.dirname,
      timeoutMs: 15_000,
    });
    if (openFiles.timedOut || ![0, 1].includes(openFiles.exitCode) || (openFiles.exitCode === 1 && openFiles.stderr.trim())) {
      skippedUnsafeCount += 1;
      continue;
    }
    if (openFiles.exitCode === 0 && openFiles.stdout.trim()) {
      skippedActiveCount += 1;
      continue;
    }
    try {
      await fsp.rm(candidate, { recursive: true, force: true });
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
      const writable = await runCapturedCommand('chmod', ['-R', 'u+w', candidate], {
        cwd: import.meta.dirname,
        timeoutMs: 30_000,
      });
      if (writable.exitCode !== 0) throw error;
      await fsp.rm(candidate, { recursive: true, force: true });
    }
    removed.push(entry.name);
  }

  return {
    maxAgeHours: Number(maxAgeHours),
    removedCount: removed.length,
    skippedActiveCount,
    skippedUnsafeCount,
    removed: removed.slice(0, 50),
  };
}

async function consolidatePipelineBuildxPool() {
  const processSnapshot = await runCapturedCommand('ps', ['-eww', '-axo', 'command='], {
    cwd: import.meta.dirname,
    timeoutMs: 30_000,
  });
  if (processSnapshot.exitCode !== 0 || processSnapshot.truncated) {
    return { removedBuilders: [], skippedBuilders: [...LEGACY_PIPELINE_BUILDX_BUILDERS], localCacheRemoved: false };
  }
  const removedBuilders = [];
  const skippedBuilders = [];
  for (const builderName of LEGACY_PIPELINE_BUILDX_BUILDERS) {
    if (processSnapshot.stdout.includes(builderName)) {
      skippedBuilders.push(builderName);
      continue;
    }
    const result = await runCapturedCommand('docker', ['buildx', 'rm', '-f', builderName], {
      cwd: import.meta.dirname,
      timeoutMs: 2 * 60_000,
    });
    if (result.exitCode === 0) removedBuilders.push(builderName);
    else if (!/no builder|not found|does not exist/i.test(compactCapturedOutput(result))) skippedBuilders.push(builderName);
  }
  const legacyLocalCache = path.join(managedLibraryRoot, 'docker-cache', 'go-task-grader');
  const localCacheExists = Boolean(await fsp.stat(legacyLocalCache).catch(() => null));
  if (localCacheExists) await fsp.rm(legacyLocalCache, { recursive: true, force: true });
  return { removedBuilders, skippedBuilders, localCacheRemoved: localCacheExists };
}

async function runDockerResourceMaintenance({ automatic = false } = {}) {
  if (pipelineResourceMaintenanceRunning) throw new Error('Docker 资源清理已经在运行');
  const resourceSlots = await activePipelineResourceSlotSnapshot();
  const dockerOccupiedCount = Number(resourceSlots.counts['compute-docker'] || 0);
  if (dockerOccupiedCount) throw new Error(`仍有 ${dockerOccupiedCount} 个 Docker 资源租约运行，暂不能清理缓存`);
  let cleanupPlan = pipelineDiskCleanupPlan(pipelineHealthState.resources || {});
  if (cleanupPlan.mode === 'none' && !automatic) cleanupPlan = pipelineDiskCleanupPlan(pipelineHealthState.resources || {}, { force: true });
  if (cleanupPlan.mode === 'none') {
    pipelineResourceMaintenanceState = {
      status: 'idle',
      requestedAt: null,
      startedAt: null,
      finishedAt: new Date().toISOString(),
      retryAfter: null,
      reason: '',
      error: '',
      lastResult: { skipped: true, reason: '资源已恢复，无需清理' },
    };
    await writePipelineSchedulerState();
    return pipelineResourceMaintenanceState.lastResult;
  }
  pipelineResourceMaintenanceRunning = true;
  const beforeDiskFreeBytes = await managedDiskFreeBytes();
  pipelineResourceMaintenanceState = {
    ...pipelineResourceMaintenanceState,
    status: 'running',
    requestedAt: pipelineResourceMaintenanceState.requestedAt || new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    retryAfter: null,
    reason: pipelineResourceMaintenanceState.reason || `${automatic ? '自动' : '手动'} Docker 缓存维护`,
    error: '',
    mode: cleanupPlan.mode,
    plan: cleanupPlan,
  };
  await writePipelineSchedulerState();
  try {
    const targetFreeSpace = String(cleanupPlan.targetFreeBytes);
    const buildxBuilder = await runCapturedCommand('docker', [
      'buildx', 'prune', '--builder', 'benzhi-builder', '-f',
      '--max-used-space', cleanupPlan.builderMaxUsedSpace,
      '--reserved-space', cleanupPlan.builderReservedSpace,
      '--min-free-space', targetFreeSpace,
    ], { cwd: import.meta.dirname, timeoutMs: 20 * 60_000 });
    const defaultBuilder = await runCapturedCommand('docker', [
      'builder', 'prune', '-f',
      '--max-used-space', cleanupPlan.builderMaxUsedSpace,
      '--reserved-space', cleanupPlan.builderReservedSpace,
      '--min-free-space', targetFreeSpace,
    ], { cwd: import.meta.dirname, timeoutMs: 20 * 60_000 });
    const images = await runCapturedCommand('docker', [
      'image', 'prune', '-a', '-f', '--filter', `until=${cleanupPlan.imageMaxAgeHours}h`,
    ], { cwd: import.meta.dirname, timeoutMs: 10 * 60_000 });
    const failedDockerCommand = [buildxBuilder, defaultBuilder, images].find((result) => result.exitCode !== 0);
    if (failedDockerCommand) throw new Error(`Docker 清理失败：${compactCapturedOutput(failedDockerCommand)}`);
    const builderPool = await consolidatePipelineBuildxPool();
    const temporaryDirectories = await cleanupManagedPipelineTempDirectories({
      maxAgeHours: cleanupPlan.tempMaxAgeHours,
    });
    const afterDiskFreeBytes = await managedDiskFreeBytes();
    const maintenanceResult = {
      mode: cleanupPlan.mode,
      beforeDiskFreeBytes,
      afterDiskFreeBytes,
      reclaimedDiskBytes: Math.max(0, afterDiskFreeBytes - beforeDiskFreeBytes),
      buildxBuilder: compactCapturedOutput(buildxBuilder).slice(-1000),
      defaultBuilder: compactCapturedOutput(defaultBuilder).slice(-1000),
      images: compactCapturedOutput(images).slice(-1000),
      builderPool,
      temporaryDirectories,
    };
    pipelineLastResourceMaintenanceAt = new Date().toISOString();
    pipelineResourceMaintenanceState = {
      status: 'idle',
      requestedAt: null,
      startedAt: pipelineResourceMaintenanceState.startedAt,
      finishedAt: pipelineLastResourceMaintenanceAt,
      retryAfter: null,
      reason: '',
      error: '',
      lastResult: maintenanceResult,
    };
    await writePipelineSchedulerState();
    addLog('success', `${automatic ? '自动' : '手动'}动态缓存清理完成，释放约 ${(maintenanceResult.reclaimedDiskBytes / 1024 ** 3).toFixed(1)} GiB`);
    await runSystemHealthChecks();
    return maintenanceResult;
  } catch (error) {
    pipelineResourceMaintenanceState = {
      ...pipelineResourceMaintenanceState,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      retryAfter: Date.now() + 60 * 60_000,
      error: sanitizeMonitorText(error.message).slice(0, 1000),
    };
    await writePipelineSchedulerState();
    throw error;
  } finally {
    pipelineResourceMaintenanceRunning = false;
    if (pipelineAutoFillEnabled) void fillPipelineSlots();
  }
}

async function enforceDockerGraderCpuLimit() {
  if (dockerGraderCpuGuardRunning) return;
  dockerGraderCpuGuardRunning = true;
  try {
    const listed = await runCapturedCommand('docker', ['ps', '--format', '{{.ID}}\t{{.Image}}'], {
      cwd: import.meta.dirname,
      timeoutMs: 10_000,
    });
    if (listed.exitCode !== 0) return;
    const graderIds = listed.stdout.split('\n')
      .map((line) => line.trim().split(/\s+/, 2))
      .filter(([, image]) => /^go-task-grader-/i.test(image || ''))
      .map(([id]) => id)
      .filter(Boolean);
    if (!graderIds.length) return;
    const inspected = await runCapturedCommand('docker', [
      'inspect', '--format', '{{.Id}}\t{{.HostConfig.NanoCpus}}', ...graderIds,
    ], { cwd: import.meta.dirname, timeoutMs: 10_000 });
    if (inspected.exitCode !== 0) return;
    const expectedNanoCpus = DOCKER_RUN_CPU_LIMIT * 1_000_000_000;
    const uncappedIds = inspected.stdout.split('\n')
      .map((line) => line.trim().split(/\s+/, 2))
      .filter(([, nanoCpus]) => Number(nanoCpus) !== expectedNanoCpus)
      .map(([id]) => id)
      .filter(Boolean);
    let cappedCount = 0;
    for (const id of uncappedIds) {
      const updated = await runCapturedCommand('docker', ['update', '--cpus', String(DOCKER_RUN_CPU_LIMIT), id], {
        cwd: import.meta.dirname,
        timeoutMs: 10_000,
      });
      if (updated.exitCode === 0) cappedCount += 1;
    }
    if (cappedCount) addLog('info', `已为 ${cappedCount} 个旧版 Docker 验证容器补加 ${DOCKER_RUN_CPU_LIMIT} 核 CPU 上限`);
  } catch {
    // Health checks report Docker outages; the guard retries on its next tick.
  } finally {
    dockerGraderCpuGuardRunning = false;
  }
}

async function readCloudUploads() {
  try {
    const records = JSON.parse(await fsp.readFile(cloudUploadsPath, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function writeCloudUploadsUnlocked(records) {
  await fsp.mkdir(path.dirname(cloudUploadsPath), { recursive: true });
  const temporaryPath = `${cloudUploadsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, cloudUploadsPath);
}

async function withCloudUploadsLock(callback) {
  return withFileLock(cloudUploadsLockPath, callback, { timeoutMs: 30_000, staleMs: 2 * 60_000 });
}

async function writeCloudUploads(records) {
  return withCloudUploadsLock(() => writeCloudUploadsUnlocked(records));
}

async function reconcileUploadedPipelineJobs() {
  if (pipelineCloudReconcileRunning) return;
  pipelineCloudReconcileRunning = true;
  let reconciled = 0;
  try {
    const uploads = (await readCloudUploads()).filter((record) => !record.artifactKind || record.artifactKind === 'main');
    if (!uploads.length) return;
    const jobs = await Promise.all((await listPipelineJobs()).map((job) => readPipelineJob(job.id)));
    const exportCandidates = new Set();
    for (const job of jobs) {
      if (job?.status !== 'failed') continue;
      const matched = String(job.currentStage || '').match(/^bug(\d+)_(?:cloud_upload|verification_finalize)$/);
      if (!matched) continue;
      const bugIndex = Number(matched[1]);
      const coverageStage = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_verification_coverage`);
      if (coverageStage && coverageStage.status !== 'passed') continue;
      const taskName = (job.bugs || []).find((bug) => Number(bug.bugIndex) === bugIndex)?.task?.taskName;
      const upload = uploads.find((record) => record?.task === taskName);
      if (upload?.taskId) exportCandidates.add(upload.taskId);
    }
    const verificationExportReadyTaskIds = new Set();
    for (const task of (await discoverTasks()).filter((item) => exportCandidates.has(item.id))) {
      try {
        await validateTaskExcelVerification(task);
        verificationExportReadyTaskIds.add(task.id);
      } catch {
        // Keep the pipeline at its failed delivery stage. The normal runner
        // remains responsible for repairing incomplete verification evidence.
      }
    }
    for (const job of jobs) {
      const updated = reconcilePipelineCloudUpload(job, uploads, new Date().toISOString(), { verificationExportReadyTaskIds });
      if (!updated) continue;
      await writePipelineJob(updated);
      reconciled += 1;
      addLog('success', updated.status === 'passed'
        ? `云盘轨迹已回填，流水线自动完成：${updated.id}`
        : `云盘轨迹已回填，流水线等待继续后续 Bug：${updated.id}`);
    }
  } finally {
    pipelineCloudReconcileRunning = false;
  }
  if (reconciled && pipelineAutoFillEnabled) void fillPipelineSlots();
}

async function readReviewStatuses() {
  try {
    const records = JSON.parse(await fsp.readFile(reviewStatusesPath, 'utf8'));
    return Array.isArray(records) ? records.filter((record) => REVIEW_STATUSES.has(record?.status) && record.status !== 'pending') : [];
  } catch {
    return [];
  }
}

async function writeReviewStatuses(records) {
  await withFileLock(reviewStatusesLockPath, () => writeReviewStatusesUnlocked(records));
  invalidateTaskDiscoveryCache();
}

async function writeReviewStatusesUnlocked(records) {
  await fsp.mkdir(path.dirname(reviewStatusesPath), { recursive: true });
  const temporaryPath = `${reviewStatusesPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await fsp.rename(temporaryPath, reviewStatusesPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readPackageValidations() {
  try {
    const records = JSON.parse(await fsp.readFile(packageValidationsPath, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function writePackageValidations(records) {
  await fsp.mkdir(path.dirname(packageValidationsPath), { recursive: true });
  const temporaryPath = `${packageValidationsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, packageValidationsPath);
}

async function readTaskExportRecords() {
  try {
    const records = JSON.parse(await fsp.readFile(taskExportRecordsPath, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function readArchivedTasks() {
  try {
    const records = JSON.parse(await fsp.readFile(archivedTasksPath, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

async function writeTaskExportRecords(records) {
  await fsp.mkdir(path.dirname(taskExportRecordsPath), { recursive: true });
  const temporaryPath = `${taskExportRecordsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, taskExportRecordsPath);
  // Export counters are user-visible immediately after a download starts.
  // Keeping the old discovery snapshot alive here makes the follow-up
  // /api/run/status refresh report the previous count even though the record
  // is already durable on disk.
  invalidateTaskDiscoveryCache();
}

async function recordTaskExports(taskIds, kind) {
  if (!['trajectory', 'excel'].includes(kind)) throw new Error('导出类型不合法');
  const requested = [...new Set((taskIds || []).map(String).filter(Boolean))];
  if (!requested.length) return [];
  const previous = taskExportUpdateTail;
  let release;
  taskExportUpdateTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const records = await readTaskExportRecords();
    const recordMap = new Map(records.map((record) => [record.taskId, record]));
    const exportedAt = new Date().toISOString();
    for (const taskId of requested) {
      const current = recordMap.get(taskId) || { taskId, count: 0, trajectoryCount: 0, excelCount: 0 };
      recordMap.set(taskId, {
        ...current,
        count: Number(current.count || 0) + 1,
        trajectoryCount: Number(current.trajectoryCount || 0) + (kind === 'trajectory' ? 1 : 0),
        excelCount: Number(current.excelCount || 0) + (kind === 'excel' ? 1 : 0),
        lastKind: kind,
        lastExportedAt: exportedAt,
      });
    }
    const next = [...recordMap.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
    await writeTaskExportRecords(next);
    return requested.map((taskId) => recordMap.get(taskId));
  } finally {
    release();
  }
}

async function readLabelExportRecords() {
  try {
    const stat = await fsp.stat(labelExportRecordsPath);
    if (stat.mtimeMs === labelExportRecordsCache.mtimeMs) return labelExportRecordsCache.records;
    const records = JSON.parse(await fsp.readFile(labelExportRecordsPath, 'utf8'));
    labelExportRecordsCache = {
      mtimeMs: stat.mtimeMs,
      records: new Map((Array.isArray(records) ? records : []).map((record) => [record.bug_id, record])),
    };
  } catch {
    labelExportRecordsCache = { mtimeMs: -1, records: new Map() };
  }
  return labelExportRecordsCache.records;
}

async function cachedTrajectoryHardRuleIssues(taskDir, record) {
  const filename = path.join(taskDir, 'trajectory', 'trajectory.stream.jsonl');
  const stat = await fsp.stat(filename);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    task_type: record.task_type || '',
    production_flow: record.production_flow || '',
    verification_policy_version: record.verification_policy_version || 0,
    session_id: record.sessionId || record['session  id'] || record.test_model_fix_session_id || '',
    gold_root_cause: record.gold_root_cause || '',
    gold_files: record.gold_files || record.target_files || [],
    gold_symbols: record.gold_symbols || record.symbols || [],
    verify_result: record.verify_result || '',
    verify_cmds: record.verify_cmds || '',
    has_go_mod: record.hasGoMod,
    go_version: record.go_version || '',
  })).digest('hex');
  const cached = trajectoryHardRuleCache.get(record.id);
  if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size && cached?.fingerprint === fingerprint) return cached.issues;
  const issues = getHardRuleIssues(record, { includeGoVersion: false });
  trajectoryHardRuleCache.set(record.id, { mtimeMs: stat.mtimeMs, size: stat.size, fingerprint, issues });
  return issues;
}

async function cachedWorkspaceProjectValidation(task, { enforcePinnedToolchain = false, cacheable = false } = {}) {
  const packageOptions = projectPackageRuleOptions(task);
  const workspaceFingerprint = cacheable
    ? await workspaceValidationFingerprint(task.taskDir, ['workspace', 'pristine'])
    : '';
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    enforcePinnedToolchain,
    main_commit: task.main_commit || '',
    bug_base_commit: task.bug_base_commit || '',
    test_model_fix_commit: task.test_model_fix_commit || '',
    test_model_fix_session_id: task.test_model_fix_session_id || '',
    package_options: packageOptions,
    workspace_fingerprint: workspaceFingerprint,
  })).digest('hex');
  const cached = workspaceProjectValidationCache.get(task.id);
  if (cacheable && cached?.fingerprint === fingerprint) return cached.validation;
  const entries = await readWorkspacePackageEntries(task, { forValidation: true });
  const hasBaseline = await pathExists(path.join(task.taskDir, 'pristine'));
  const validation = hasBaseline
    ? validateGoPackageAgainstBaseline(
      entries,
      await readWorkspacePackageEntries(task, { forValidation: true, directoryName: 'pristine' }),
      { enforcePinnedToolchain, ...packageOptions },
    )
    : validateGoPackage(entries, { enforcePinnedToolchain, ...packageOptions });
  if (cacheable) workspaceProjectValidationCache.set(task.id, { fingerprint, validation });
  return validation;
}

function cookieHeaderFromResponse(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((value) => value.split(';', 1)[0]).join('; ');
}

async function persistCloudSession() {
  await fsp.mkdir(path.dirname(cloudSessionPath), { recursive: true });
  const temporary = `${cloudSessionPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const session = {
    cookie: cloudSessionCookie,
    connectedAs: cloudConnectedAs,
    autoLoginAccount: cloudAutoLoginAccount,
    autoLoginConfigured: cloudAutoLoginConfigured,
    lastCheckedAt: cloudLastCheckedAt,
    lastRefreshedAt: cloudLastRefreshedAt,
    lastError: cloudLastError,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, cloudSessionPath);
  await fsp.chmod(cloudSessionPath, 0o600);
}

async function ensureCloudKeychainBinary() {
  const source = await fsp.stat(cloudKeychainSourcePath);
  const binary = await fsp.stat(cloudKeychainBinaryPath).catch(() => null);
  if (binary?.isFile() && binary.mtimeMs >= source.mtimeMs) return;
  await fsp.mkdir(path.dirname(cloudKeychainBinaryPath), { recursive: true, mode: 0o700 });
  const result = await runCapturedCommand('xcrun', ['swiftc', '-O', cloudKeychainSourcePath, '-o', cloudKeychainBinaryPath], {
    cwd: import.meta.dirname,
    timeoutMs: 2 * 60 * 1000,
  });
  if (result.exitCode !== 0) throw new Error(`无法编译云盘钥匙串助手：${result.stderr.trim() || result.error || `exit ${result.exitCode}`}`);
  await fsp.chmod(cloudKeychainBinaryPath, 0o700);
}

async function runKeychain(action, service, account, password = null) {
  if (!['store', 'read', 'exists', 'delete'].includes(action)) throw new Error('不支持的钥匙串操作');
  if (!account) throw new Error('钥匙串账号不能为空');
  await ensureCloudKeychainBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(cloudKeychainBinaryPath, [action, service, account], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    let settled = false;
    const secret = password === null ? null : Buffer.from(String(password), 'utf8');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secret?.fill(0);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) return finish(null, { found: true, data: Buffer.concat(chunks) });
      if (code === 2 && ['read', 'exists'].includes(action)) return finish(null, { found: false, data: Buffer.alloc(0) });
      return finish(new Error(stderr.trim() || `钥匙串操作失败（exit ${code ?? 'none'}）`));
    });
    if (secret) child.stdin.end(secret);
    else child.stdin.end();
  });
}

function runCloudKeychain(action, account, password = null) {
  return runKeychain(action, cloudKeychainService, account, password);
}

function runSubmissionPlatformKeychain(action, account, password = null) {
  return runKeychain(action, submissionPlatformKeychainService, account, password);
}

async function readCloudCredential(account) {
  if (cloudEnvironmentLoginConfigured && account === cloudEnvironmentAccount) {
    return { found: true, data: Buffer.from(cloudEnvironmentPassword, 'utf8'), source: 'environment' };
  }
  if (process.platform !== 'darwin') return { found: false, data: Buffer.alloc(0), source: 'none' };
  return runCloudKeychain('read', account);
}

async function cloudCredentialExists(account) {
  if (cloudEnvironmentLoginConfigured && account === cloudEnvironmentAccount) return true;
  if (process.platform !== 'darwin') return false;
  return (await runCloudKeychain('exists', account)).found;
}

async function clearCloudSession({ forgetCredentials = false } = {}) {
  if (forgetCredentials) cloudAuthEpoch += 1;
  const accountToForget = cloudAutoLoginAccount || cloudConnectedAs;
  let credentialDeleteError = null;
  if (forgetCredentials && accountToForget && process.platform === 'darwin') {
    try {
      await runCloudKeychain('delete', accountToForget);
    } catch (error) {
      credentialDeleteError = error;
    }
  }
  cloudSessionCookie = '';
  cloudConnectedAs = '';
  if (forgetCredentials) {
    cloudAutoLoginAccount = '';
    cloudAutoLoginConfigured = false;
    cloudLastCheckedAt = null;
    cloudLastRefreshedAt = null;
    cloudLastError = '';
    await fsp.rm(cloudSessionPath, { force: true });
  } else if (cloudAutoLoginConfigured && cloudAutoLoginAccount) {
    await persistCloudSession();
  } else {
    await fsp.rm(cloudSessionPath, { force: true });
  }
  if (credentialDeleteError) throw new Error(`云盘会话已断开，但钥匙串凭据删除失败：${credentialDeleteError.message}`);
}

async function validateCloudCookie(cookie) {
  const response = await fetch(`${cloudUploadBaseUrl}/`, {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(CLOUD_CONTROL_REQUEST_TIMEOUT_MS),
  });
  const location = response.headers.get('location') || '';
  return {
    valid: response.status === 200,
    authFailure: isCloudAuthenticationFailure(response.status, location, cloudUploadBaseUrl),
    status: response.status,
    location,
  };
}

async function requestCloudLogin(username, password) {
  const body = new URLSearchParams({ username, password });
  const response = await fetch(`${cloudUploadBaseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(CLOUD_CONTROL_REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  const cookie = cookieHeaderFromResponse(response);
  if (!response.ok || !payload.ok || !cookie) throw new Error(payload.error || '云盘登录失败');
  const check = await validateCloudCookie(cookie);
  if (!check.valid) throw new Error(`云盘登录会话校验失败（HTTP ${check.status}）`);
  return cookie;
}

async function connectCloudUpload(username, password) {
  const previousAccount = cloudAutoLoginAccount;
  const cookie = await requestCloudLogin(username, password);
  if (process.platform === 'darwin') {
    await runCloudKeychain('store', username, password);
    if (previousAccount && previousAccount !== username) {
      await runCloudKeychain('delete', previousAccount).catch((error) => addLog('warn', `旧云盘账号的钥匙串凭据未能删除：${error.message}`));
    }
  }
  cloudAuthEpoch += 1;
  cloudSessionCookie = cookie;
  cloudConnectedAs = username;
  cloudAutoLoginAccount = username;
  cloudAutoLoginConfigured = process.platform === 'darwin'
    || (cloudEnvironmentLoginConfigured && username === cloudEnvironmentAccount && password === cloudEnvironmentPassword);
  cloudLastCheckedAt = new Date().toISOString();
  cloudLastRefreshedAt = cloudLastCheckedAt;
  cloudLastError = '';
  await persistCloudSession();
}

async function refreshCloudLogin(reason = '会话失效') {
  if (cloudAuthRefreshPromise) return cloudAuthRefreshPromise;
  if (!cloudAutoLoginConfigured || !cloudAutoLoginAccount) throw new Error('请重新连接一次云盘以启用自动登录');
  const account = cloudAutoLoginAccount;
  const epoch = cloudAuthEpoch;
  const refresh = (async () => {
    const stored = await readCloudCredential(account);
    if (epoch !== cloudAuthEpoch || !cloudAutoLoginConfigured || cloudAutoLoginAccount !== account) {
      stored.data.fill(0);
      throw new Error('自动登录已被用户取消');
    }
    if (!stored.found || !stored.data.length) {
      cloudAutoLoginConfigured = false;
      cloudLastError = process.platform === 'darwin'
        ? 'macOS 钥匙串中没有找到云盘凭据，请重新连接一次'
        : '未配置 GO_TASK_MONITOR_CLOUD_USERNAME/GO_TASK_MONITOR_CLOUD_PASSWORD，不能自动恢复云盘登录';
      await persistCloudSession();
      throw new Error(cloudLastError);
    }
    try {
      const cookie = await requestCloudLogin(account, stored.data.toString('utf8'));
      if (epoch !== cloudAuthEpoch || !cloudAutoLoginConfigured || cloudAutoLoginAccount !== account) {
        throw new Error('自动登录已被用户取消');
      }
      cloudSessionCookie = cookie;
      cloudConnectedAs = account;
      cloudAutoLoginConfigured = true;
      cloudLastCheckedAt = new Date().toISOString();
      cloudLastRefreshedAt = cloudLastCheckedAt;
      cloudLastError = '';
      await persistCloudSession();
      addLog('success', `云盘会话已自动恢复：${cloudConnectedAs}（${reason}）`);
      return true;
    } finally {
      stored.data.fill(0);
    }
  })();
  cloudAuthRefreshPromise = refresh;
  try {
    return await refresh;
  } catch (error) {
    if (epoch !== cloudAuthEpoch) throw error;
    cloudLastError = `自动登录失败：${error.message}`;
    await persistCloudSession().catch(() => {});
    throw new Error(cloudLastError);
  } finally {
    if (cloudAuthRefreshPromise === refresh) cloudAuthRefreshPromise = null;
  }
}

async function ensureCloudSession({ forceRefresh = false, reason = '需要上传' } = {}) {
  if (forceRefresh && cloudSessionCookie) await clearCloudSession();
  if (cloudSessionCookie) return true;
  return refreshCloudLogin(reason);
}

async function maintainCloudSession({ force = false } = {}) {
  if (cloudHealthCheckPromise) return cloudHealthCheckPromise;
  if (!force && cloudLastCheckedAt && Date.now() - Date.parse(cloudLastCheckedAt) < cloudHealthCheckIntervalMs) return;
  const check = (async () => {
    if (!cloudSessionCookie) {
      if (cloudAutoLoginConfigured) await refreshCloudLogin('定时健康检查');
      return;
    }
    let result;
    try {
      result = await validateCloudCookie(cloudSessionCookie);
    } catch (error) {
      cloudLastError = `云盘健康检查失败：${error.message}`;
      await persistCloudSession().catch(() => {});
      throw error;
    }
    cloudLastCheckedAt = new Date().toISOString();
    if (result.valid) {
      cloudLastError = '';
      await persistCloudSession();
      return;
    }
    if (result.authFailure) {
      await clearCloudSession();
      await refreshCloudLogin('登录会话已过期');
      return;
    }
    cloudLastError = `云盘健康检查返回 HTTP ${result.status}，保留当前会话等待恢复`;
    await persistCloudSession();
  })();
  cloudHealthCheckPromise = check;
  try {
    return await check;
  } finally {
    if (cloudHealthCheckPromise === check) cloudHealthCheckPromise = null;
  }
}

async function restoreCloudSession() {
  const saved = JSON.parse(await fsp.readFile(cloudSessionPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  }));
  cloudSessionCookie = String(saved?.cookie || '');
  cloudConnectedAs = String(saved?.connectedAs || '');
  cloudAutoLoginAccount = cloudEnvironmentLoginConfigured
    ? cloudEnvironmentAccount
    : String(saved?.autoLoginAccount || saved?.connectedAs || '');
  cloudLastCheckedAt = saved?.lastCheckedAt || null;
  cloudLastRefreshedAt = saved?.lastRefreshedAt || null;
  cloudLastError = String(saved?.lastError || '');
  if (cloudAutoLoginAccount) {
    try {
      cloudAutoLoginConfigured = await cloudCredentialExists(cloudAutoLoginAccount);
    } catch (error) {
      cloudAutoLoginConfigured = false;
      cloudLastError = `无法检查云盘自动登录凭据：${error.message}`;
    }
  }
  if (!cloudSessionCookie) {
    if (cloudAutoLoginConfigured) await refreshCloudLogin('服务启动');
    return;
  }
  let result;
  try {
    result = await validateCloudCookie(cloudSessionCookie);
  } catch (error) {
    cloudLastError = `云盘启动检查失败：${error.message}`;
    await persistCloudSession().catch(() => {});
    addLog('warn', `${cloudLastError}，保留已有会话`);
    return;
  }
  cloudLastCheckedAt = new Date().toISOString();
  if (result.valid) {
    cloudLastError = '';
    await persistCloudSession();
    addLog('success', `已恢复云盘登录：${cloudConnectedAs}`);
    return;
  }
  if (!result.authFailure) {
    cloudLastError = `云盘启动检查返回 HTTP ${result.status}，保留已有会话`;
    await persistCloudSession();
    return;
  }
  await clearCloudSession();
  if (cloudAutoLoginConfigured) await refreshCloudLogin('服务启动时发现会话过期');
  else throw new Error('已保存的云盘会话失效，请重新连接一次以启用自动登录');
}

function responseSetCookieHeaders(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
}

async function persistSubmissionPlatformSession() {
  await fsp.mkdir(path.dirname(submissionPlatformSessionPath), { recursive: true });
  const temporary = `${submissionPlatformSessionPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const session = {
    cookie: submissionPlatformCookie,
    connectedAs: submissionPlatformConnectedAs,
    autoLoginAccount: submissionPlatformAutoLoginAccount,
    autoLoginConfigured: submissionPlatformAutoLoginConfigured,
    lastCheckedAt: submissionPlatformLastCheckedAt,
    lastRefreshedAt: submissionPlatformLastRefreshedAt,
    lastError: submissionPlatformLastError,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, submissionPlatformSessionPath);
  await fsp.chmod(submissionPlatformSessionPath, 0o600);
}

async function persistSubmissionPlatformControl() {
  await fsp.mkdir(path.dirname(submissionPlatformControlPath), { recursive: true });
  const temporary = `${submissionPlatformControlPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const control = {
    syncPaused: submissionPlatformSyncPaused,
    pausedAt: submissionPlatformSyncPausedAt,
    pauseReason: submissionPlatformSyncPauseReason,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(temporary, `${JSON.stringify(control, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, submissionPlatformControlPath);
  await fsp.chmod(submissionPlatformControlPath, 0o600);
}

async function restoreSubmissionPlatformControl() {
  try {
    const saved = JSON.parse(await fsp.readFile(submissionPlatformControlPath, 'utf8'));
    submissionPlatformSyncPaused = saved?.syncPaused === true;
    submissionPlatformSyncPausedAt = saved?.pausedAt || null;
    submissionPlatformSyncPauseReason = String(saved?.pauseReason || '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function setSubmissionPlatformSyncPaused(paused, reason = '') {
  submissionPlatformSyncPaused = paused === true;
  submissionPlatformSyncPausedAt = submissionPlatformSyncPaused ? new Date().toISOString() : null;
  submissionPlatformSyncPauseReason = submissionPlatformSyncPaused ? String(reason || '人工暂停质检平台同步') : '';
  await persistSubmissionPlatformControl();
}

async function requestSubmissionPlatformLogin(username, password) {
  const response = await fetch(`${submissionPlatformApiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    redirect: 'manual',
    signal: AbortSignal.timeout(SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  let cookie = mergePlatformCookies('', responseSetCookieHeaders(response));
  if (!response.ok || !cookie) throw new Error(platformApiMessage(payload, `提交平台登录失败（HTTP ${response.status}）`));
  const check = await fetch(`${submissionPlatformApiUrl}/auth/me`, {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS),
  });
  const checkPayload = await check.json().catch(() => ({}));
  cookie = mergePlatformCookies(cookie, responseSetCookieHeaders(check));
  if (!check.ok) throw new Error(platformApiMessage(checkPayload, `提交平台会话校验失败（HTTP ${check.status}）`));
  return { cookie, profile: checkPayload };
}

async function connectSubmissionPlatform(username, password) {
  const previousAccount = submissionPlatformAutoLoginAccount;
  const login = await requestSubmissionPlatformLogin(username, password);
  await runSubmissionPlatformKeychain('store', username, password);
  if (previousAccount && previousAccount !== username) {
    await runSubmissionPlatformKeychain('delete', previousAccount)
      .catch((error) => addLog('warn', `旧提交平台账号的钥匙串凭据未能删除：${error.message}`));
  }
  submissionPlatformAuthEpoch += 1;
  submissionPlatformCookie = login.cookie;
  submissionPlatformConnectedAs = username;
  submissionPlatformAutoLoginAccount = username;
  submissionPlatformAutoLoginConfigured = true;
  submissionPlatformLastCheckedAt = new Date().toISOString();
  submissionPlatformLastRefreshedAt = submissionPlatformLastCheckedAt;
  submissionPlatformLastError = '';
  await persistSubmissionPlatformSession();
  await setSubmissionPlatformSyncPaused(false);
}

async function clearSubmissionPlatformSession({ forgetCredentials = false } = {}) {
  if (forgetCredentials) submissionPlatformAuthEpoch += 1;
  const account = submissionPlatformAutoLoginAccount || submissionPlatformConnectedAs;
  if (forgetCredentials && account) await runSubmissionPlatformKeychain('delete', account);
  submissionPlatformCookie = '';
  submissionPlatformConnectedAs = '';
  if (forgetCredentials) {
    submissionPlatformAutoLoginAccount = '';
    submissionPlatformAutoLoginConfigured = false;
    submissionPlatformLastCheckedAt = null;
    submissionPlatformLastRefreshedAt = null;
    submissionPlatformLastError = '';
    await fsp.rm(submissionPlatformSessionPath, { force: true });
  } else if (submissionPlatformAutoLoginConfigured && submissionPlatformAutoLoginAccount) {
    await persistSubmissionPlatformSession();
  }
}

async function refreshSubmissionPlatformLogin(reason = '会话失效') {
  if (submissionPlatformAuthRefreshPromise) return submissionPlatformAuthRefreshPromise;
  if (!submissionPlatformAutoLoginConfigured || !submissionPlatformAutoLoginAccount) {
    throw new Error('请在任务系统中连接一次提交平台以启用自动登录');
  }
  const account = submissionPlatformAutoLoginAccount;
  const epoch = submissionPlatformAuthEpoch;
  const refresh = (async () => {
    const stored = await runSubmissionPlatformKeychain('read', account);
    if (!stored.found || !stored.data.length) throw new Error('macOS 钥匙串中没有找到提交平台凭据，请重新连接');
    try {
      const login = await requestSubmissionPlatformLogin(account, stored.data.toString('utf8'));
      if (epoch !== submissionPlatformAuthEpoch || account !== submissionPlatformAutoLoginAccount) throw new Error('提交平台自动登录已被取消');
      submissionPlatformCookie = login.cookie;
      submissionPlatformConnectedAs = account;
      submissionPlatformLastCheckedAt = new Date().toISOString();
      submissionPlatformLastRefreshedAt = submissionPlatformLastCheckedAt;
      submissionPlatformLastError = '';
      await persistSubmissionPlatformSession();
      addLog('success', `提交平台会话已自动恢复：${account}（${reason}）`);
      return true;
    } finally {
      stored.data.fill(0);
    }
  })();
  submissionPlatformAuthRefreshPromise = refresh;
  try {
    return await refresh;
  } catch (error) {
    if (epoch === submissionPlatformAuthEpoch) {
      submissionPlatformLastError = `提交平台自动登录失败：${error.message}`;
      await persistSubmissionPlatformSession().catch(() => {});
    }
    throw new Error(submissionPlatformLastError || error.message);
  } finally {
    if (submissionPlatformAuthRefreshPromise === refresh) submissionPlatformAuthRefreshPromise = null;
  }
}

async function ensureSubmissionPlatformSession(reason = '需要提交') {
  if (submissionPlatformSyncPaused) throw new Error('质检提交平台维护中，等待统一补交');
  if (submissionPlatformCookie) return true;
  return refreshSubmissionPlatformLogin(reason);
}

async function submissionPlatformRequest(endpoint, options = {}, retryAuth = true) {
  await ensureSubmissionPlatformSession(endpoint);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}), cookie: submissionPlatformCookie };
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = platformCsrfToken(submissionPlatformCookie);
    if (!csrf) throw new Error('提交平台登录会话缺少 CSRF 令牌，请重新连接');
    headers['X-CSRF-Token'] = csrf;
  }
  const response = await fetch(`${submissionPlatformApiUrl}${endpoint}`, {
    ...options,
    method,
    headers,
    redirect: 'manual',
    signal: options.signal || AbortSignal.timeout(SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS),
  });
  const nextCookie = mergePlatformCookies(submissionPlatformCookie, responseSetCookieHeaders(response));
  if (nextCookie !== submissionPlatformCookie) submissionPlatformCookie = nextCookie;
  const payload = await response.json().catch(() => ({}));
  if (retryAuth && [401, 403].includes(response.status)) {
    submissionPlatformCookie = '';
    await refreshSubmissionPlatformLogin(`HTTP ${response.status}`);
    return submissionPlatformRequest(endpoint, options, false);
  }
  submissionPlatformLastCheckedAt = new Date().toISOString();
  submissionPlatformLastError = response.ok ? '' : platformApiMessage(payload, `HTTP ${response.status}`);
  await persistSubmissionPlatformSession().catch(() => {});
  return { response, payload };
}

async function restoreSubmissionPlatformSession() {
  const saved = JSON.parse(await fsp.readFile(submissionPlatformSessionPath, 'utf8'));
  submissionPlatformCookie = String(saved?.cookie || '');
  submissionPlatformConnectedAs = String(saved?.connectedAs || '');
  submissionPlatformAutoLoginAccount = String(saved?.autoLoginAccount || saved?.connectedAs || '');
  submissionPlatformLastCheckedAt = saved?.lastCheckedAt || null;
  submissionPlatformLastRefreshedAt = saved?.lastRefreshedAt || null;
  submissionPlatformLastError = String(saved?.lastError || '');
  if (submissionPlatformAutoLoginAccount) {
    submissionPlatformAutoLoginConfigured = (await runSubmissionPlatformKeychain('exists', submissionPlatformAutoLoginAccount)).found;
  }
  if (!submissionPlatformCookie) {
    if (submissionPlatformAutoLoginConfigured) await refreshSubmissionPlatformLogin('服务启动');
    return;
  }
  const response = await fetch(`${submissionPlatformApiUrl}/auth/me`, {
    headers: { cookie: submissionPlatformCookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS),
  });
  submissionPlatformCookie = mergePlatformCookies(submissionPlatformCookie, responseSetCookieHeaders(response));
  if (response.ok) {
    submissionPlatformLastCheckedAt = new Date().toISOString();
    submissionPlatformLastError = '';
    await persistSubmissionPlatformSession();
    addLog('success', `已恢复提交平台登录：${submissionPlatformConnectedAs}`);
    return;
  }
  submissionPlatformCookie = '';
  if (submissionPlatformAutoLoginConfigured) await refreshSubmissionPlatformLogin('服务启动时发现会话过期');
  else throw new Error('已保存的提交平台会话失效，请重新连接');
}

async function readSubmissionPlatformRecords() {
  try {
    const records = JSON.parse(await fsp.readFile(submissionPlatformRecordsPath, 'utf8'));
    if (!Array.isArray(records)) throw new Error('提交平台幂等记录格式损坏');
    return records;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readSubmissionPlatformReviewSnapshot() {
  try {
    const snapshot = JSON.parse(await fsp.readFile(submissionPlatformReviewSnapshotPath, 'utf8'));
    if (!snapshot || !Array.isArray(snapshot.submissions)) throw new Error('提交平台审核快照格式损坏');
    return snapshot;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSubmissionPlatformReviewSnapshot(snapshot) {
  await fsp.mkdir(path.dirname(submissionPlatformReviewSnapshotPath), { recursive: true });
  const temporary = `${submissionPlatformReviewSnapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, submissionPlatformReviewSnapshotPath);
  await fsp.chmod(submissionPlatformReviewSnapshotPath, 0o600);
}

async function writeSubmissionPlatformRecordsUnlocked(records) {
  await fsp.mkdir(path.dirname(submissionPlatformRecordsPath), { recursive: true });
  const temporary = `${submissionPlatformRecordsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, submissionPlatformRecordsPath);
  await fsp.chmod(submissionPlatformRecordsPath, 0o600);
}

async function upsertSubmissionPlatformRecord(record) {
  const updated = await withFileLock(submissionPlatformRecordsLockPath, async () => {
    const records = await readSubmissionPlatformRecords();
    const next = records.filter((item) => item.taskId !== record.taskId);
    next.push(record);
    await writeSubmissionPlatformRecordsUnlocked(next);
    return record;
  }, { timeoutMs: 30_000, staleMs: 5 * 60_000 });
  invalidateTaskDiscoveryCache();
  return updated;
}

async function findRemoteSubmission(bugId) {
  const query = new URLSearchParams({ page: '1', page_size: String(SUBMISSION_PLATFORM_PAGE_SIZE), bug_id: bugId });
  const { response, payload } = await submissionPlatformRequest(`/submissions/mine?${query}`);
  if (!response.ok) throw new Error(platformApiMessage(payload, `读取提交平台“我的提交”失败（HTTP ${response.status}）`));
  return findPlatformSubmissionByBugId(payload, bugId);
}

async function listRemoteSubmissions() {
  const items = [];
  const pageSize = SUBMISSION_PLATFORM_PAGE_SIZE;
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    const { response, payload } = await submissionPlatformRequest(`/submissions/mine?${query}`);
    if (!response.ok) throw new Error(platformApiMessage(payload, `读取提交平台审核状态失败（HTTP ${response.status}）`));
    const pageItems = extractPlatformSubmissionItems(payload);
    items.push(...pageItems);
    const total = extractPlatformSubmissionTotal(payload);
    if (!pageItems.length || items.length >= total || pageItems.length < pageSize) break;
  }
  return items;
}

async function postSubmissionPlatformRecord(submission) {
  const form = new FormData();
  form.append('data', JSON.stringify(submission.data));
  form.append('trajectory_url', submission.trajectoryUrl);
  return submissionPlatformRequest('/submissions', { method: 'POST', body: form });
}

async function editablePlatformSubmission(submissionId) {
  const { response, payload } = await submissionPlatformRequest(`/submissions/mine/${encodeURIComponent(submissionId)}/editable`);
  if (!response.ok) throw new Error(platformApiMessage(payload, `读取平台返修数据失败（HTTP ${response.status}）`));
  return payload?.data ?? payload;
}

async function postSubmissionPlatformRepair(submissionId, submission) {
  const form = new FormData();
  form.append('data', JSON.stringify(submission.data));
  form.append('trajectory_url', submission.trajectoryUrl);
  return submissionPlatformRequest(`/submissions/mine/${encodeURIComponent(submissionId)}/resubmit`, { method: 'POST', body: form });
}

async function validatePlatformVerificationCompatibility(task, submission) {
  let verifyResult;
  try {
    verifyResult = JSON.parse(String(submission?.prepared?.verify_result || ''));
  } catch (error) {
    throw new Error(`${task.bug_id} 提交前证明兼容检查失败：verify_result 无法解析：${error.message}`);
  }
  const phases = task.task_type === 'diagnosis' ? ['pre_fix'] : ['pre_fix', 'post_fix'];
  const verifyCmds = Array.isArray(task.verify_cmds)
    ? task.verify_cmds
    : String(task.verify_cmds || '').split(/\r?\n/).map((command) => command.trim()).filter(Boolean);
  for (const phase of phases) {
    const proofUrl = String(verifyResult?.[phase]?.trajectory_url || '').trim();
    const artifactKind = phase === 'pre_fix' ? 'verify_pre' : 'verify_post';
    const localProof = task.archived
      ? await readArchivedArtifact(task, task.archiveProofs?.[phase], `${phase} 证明`)
      : await readVerificationProof(task, artifactKind);
    let response;
    try {
      response = await fetch(proofUrl, { redirect: 'follow', signal: AbortSignal.timeout(SUBMISSION_PLATFORM_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`${task.bug_id} ${phase} 云端证明不可读：${error.message}`);
    }
    if (!response.ok) throw new Error(`${task.bug_id} ${phase} 云端证明返回 HTTP ${response.status}`);
    const remoteContent = await response.text();
    const localContent = String(localProof.content || '');
    const remoteSha256 = crypto.createHash('sha256').update(remoteContent).digest('hex');
    const localSha256 = crypto.createHash('sha256').update(localContent).digest('hex');
    if (remoteSha256 !== localSha256) {
      throw new Error(`${task.bug_id} ${phase} 云端证明与本地已校验证明的 SHA-256 不一致`);
    }
    const issues = platformCompatibleVerificationProofIssues({
      phase,
      taskType: task.task_type,
      verifyCmds,
      trajectoryContent: remoteContent,
    });
    if (issues.length) throw new Error(`${task.bug_id} ${phase} 不符合提交平台证明识别格式：${issues.join('；')}`);
  }
}

async function validatePlatformBugDifficulty(task, jobOverride = null) {
  const jobId = String(task?.pipeline_job_id || task?.pipelineJobId || '').trim();
  const job = jobOverride || (jobId ? await readPipelineJob(jobId) : null);
  if (!job || Number(job.request?.bugPolicyVersion || 0) < BUG_DIFFICULTY_POLICY_VERSION) return;
  const bugIndex = Number(task?.bug_index ?? task?.bugIndex);
  const bug = (job.bugs || []).find((item) => Number(item?.bugIndex) === bugIndex);
  if (!bug?.discovery) throw new Error(`${task.bug_id} 缺少可复核的原始 Bug 难度记录`);
  const assessment = assessBugDifficulty(bug.discovery);
  if (!assessment.ok) {
    throw new Error(`${task.bug_id} 平台提交前难度门禁未通过：${assessment.issues.join('；')}`);
  }
}

function platformReviewFields(record = {}) {
  return JSON.stringify([
    record.platformSubmissionId || '',
    record.submittedAt || '',
    record.platformReviewStatus || '',
    record.platformReviewLabel || '',
    record.platformReviewReason || '',
    record.platformReviewUpdatedAt || '',
    Number(record.platformCurrentVersion || 0),
  ]);
}

async function reconcileSubmissionPlatformReviews() {
  if (submissionPlatformReviewSyncPromise) return submissionPlatformReviewSyncPromise;
  if (submissionPlatformSyncPaused) return { updated: 0, remote: 0, paused: true };
  if (!submissionPlatformCookie && !(submissionPlatformAutoLoginConfigured && submissionPlatformAutoLoginAccount)) return { updated: 0, remote: 0 };
  const sync = (async () => {
    const observedAt = new Date().toISOString();
    const remoteItems = await listRemoteSubmissions();
    await writeSubmissionPlatformReviewSnapshot(buildPlatformReviewSnapshot(remoteItems, { observedAt }));
    let updated = 0;
    await withFileLock(submissionPlatformRecordsLockPath, async () => {
      const records = await readSubmissionPlatformRecords();
      const next = records.map((record) => {
        if (record?.status !== 'submitted' || !record?.bugId) return record;
        const remote = findPlatformSubmissionForRecord({ items: remoteItems }, record);
        if (!remote) return record;
        const merged = mergePlatformSubmissionReview({
          ...record,
          platformSubmissionId: platformSubmissionId(remote) || record.platformSubmissionId,
          submittedAt: remote.submitted_at || record.submittedAt,
        }, remote, { observedAt });
        if (platformReviewFields(merged) !== platformReviewFields(record)) updated += 1;
        return merged;
      });
      if (updated) await writeSubmissionPlatformRecordsUnlocked(next);
    }, { timeoutMs: 30_000, staleMs: 5 * 60_000 });
    submissionPlatformReviewLastSyncedAt = observedAt;
    submissionPlatformReviewLastError = '';
    if (updated) {
      invalidateTaskDiscoveryCache();
      broadcast('data');
      addLog('info', `已同步 ${updated} 条提交平台审核状态`);
    }
    return { updated, remote: remoteItems.length };
  })();
  submissionPlatformReviewSyncPromise = sync;
  try {
    return await sync;
  } catch (error) {
    submissionPlatformReviewLastError = error.message;
    throw error;
  } finally {
    if (submissionPlatformReviewSyncPromise === sync) submissionPlatformReviewSyncPromise = null;
  }
}

async function runSerializedSubmissionPlatformTask(taskId, callback) {
  const previous = submissionPlatformSubmitTails.get(taskId) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  submissionPlatformSubmitTails.set(taskId, turn);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (submissionPlatformSubmitTails.get(taskId) === turn) submissionPlatformSubmitTails.delete(taskId);
  }
}

async function submitPipelineTaskToPlatform(pipelineJobId, bugIndex, taskId, { allowLegacyDeliveredBackfill = false } = {}) {
  const job = await readPipelineJob(pipelineJobId);
  if (!job) throw new Error('流水线作业不存在');
  const platformPolicyEnabled = Number(job.submissionPlatformPolicyVersion || 0) >= CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION;
  const legacyBackfill = allowLegacyDeliveredBackfill
    && isLegacyDeliveredPlatformBackfill(job, bugIndex, CURRENT_SUBMISSION_PLATFORM_POLICY_VERSION);
  if (!platformPolicyEnabled && !legacyBackfill) {
    throw new Error('流水线未启用提交平台策略');
  }
  const platformStage = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_platform_submit`);
  const finalizeStage = (job.stages || []).find((stage) => stage.id === `bug${bugIndex}_verification_finalize`);
  if (platformPolicyEnabled
    && (!platformStage || !['running', 'passed'].includes(platformStage.status) || finalizeStage?.status !== 'passed')) {
    throw new Error('提交平台节点与验证完成节点状态不一致');
  }
  const task = await loadPipelineReviewTask(job, bugIndex, taskId);
  await validatePlatformBugDifficulty(task, job);
  const qualified = (await readReviewStatuses()).some((record) => record.taskId === task.id && record.status === 'qualified');
  if (!qualified) throw new Error(`${task.bug_id} 尚未通过本地交付审核`);
  await validateTaskExcelVerification(task);
  if (task.ruleIssues?.length) throw new Error(`${task.bug_id} 尚未满足交付规则：${task.ruleIssues.join('；')}`);
  if (!legacyBackfill && usesFixedGitCommitLayout(task)) await assertRemoteGitDeliveryLayout(task);
  await readTrajectoryMetadata(task, { requireV4: await requiresV4Trajectory(task) });

  const schema = await submissionPlatformRequest('/form/fields');
  if (!schema.response.ok) throw new Error(platformApiMessage(schema.payload, `读取提交平台字段失败（HTTP ${schema.response.status}）`));
  const submission = preparePlatformSubmission(task, schema.payload);
  const fingerprint = platformSubmissionFingerprint(submission);

  return runSerializedSubmissionPlatformTask(task.id, async () => {
    const existingRecord = (await readSubmissionPlatformRecords()).find((record) => record.taskId === task.id);
    if (existingRecord?.status === 'submitted') {
      if (existingRecord.fingerprint !== fingerprint) throw new Error(`${task.bug_id} 已提交，但本地交付字段发生变化，禁止创建重复记录`);
      return { ...existingRecord, skipped: true };
    }

    const remote = await findRemoteSubmission(task.bug_id);
    if (remote) {
      const reconciled = mergePlatformSubmissionReview({
        taskId: task.id,
        bugId: task.bug_id,
        fingerprint,
        status: 'submitted',
        platformSubmissionId: platformSubmissionId(remote),
        platformUrl: `${submissionPlatformBaseUrl}/u/submissions`,
        submittedAt: remote.submitted_at || remote.created_at || new Date().toISOString(),
        reconciledAt: new Date().toISOString(),
      }, remote);
      await upsertSubmissionPlatformRecord(reconciled);
      return { ...reconciled, skipped: true, reconciled: true };
    }

    await validatePlatformVerificationCompatibility(task, submission);
    const startedAt = new Date().toISOString();
    await upsertSubmissionPlatformRecord({
      taskId: task.id,
      bugId: task.bug_id,
      fingerprint,
      status: 'submitting',
      startedAt,
      attemptId: crypto.randomUUID(),
    });
    const result = await postSubmissionPlatformRecord(submission);
    if (!result.response.ok) {
      if (result.response.status === 409) {
        const duplicate = await findRemoteSubmission(task.bug_id);
        if (duplicate) {
          const reconciled = mergePlatformSubmissionReview({
            taskId: task.id,
            bugId: task.bug_id,
            fingerprint,
            status: 'submitted',
            platformSubmissionId: platformSubmissionId(duplicate),
            platformUrl: `${submissionPlatformBaseUrl}/u/submissions`,
            submittedAt: duplicate.submitted_at || duplicate.created_at || new Date().toISOString(),
            reconciledAt: new Date().toISOString(),
          }, duplicate);
          await upsertSubmissionPlatformRecord(reconciled);
          return { ...reconciled, skipped: true, reconciled: true };
        }
      }
      const message = platformApiMessage(result.payload, `提交平台返回 HTTP ${result.response.status}`);
      await upsertSubmissionPlatformRecord({ taskId: task.id, bugId: task.bug_id, fingerprint, status: 'failed', startedAt, failedAt: new Date().toISOString(), error: message });
      throw new Error(message);
    }
    const submitted = mergePlatformSubmissionReview({
      taskId: task.id,
      bugId: task.bug_id,
      fingerprint,
      status: 'submitted',
      platformSubmissionId: platformSubmissionId(result.payload),
      platformUrl: `${submissionPlatformBaseUrl}/u/submissions`,
      submittedAt: new Date().toISOString(),
    }, result.payload?.data || result.payload);
    await upsertSubmissionPlatformRecord(submitted);
    addLog('success', `${task.bug_id} 已提交质检平台`);
    setTimeout(() => {
      void reconcileSubmissionPlatformReviews().catch((error) => addLog('warn', `提交平台审核状态同步失败：${error.message}`));
    }, 5_000).unref();
    return submitted;
  });
}

async function resubmitTaskToPlatform(taskId, submissionId, {
  allowLegacyReadmeOnlyDifficultyOverride = false,
} = {}) {
  const task = (await discoverTasksFresh()).find((item) => item.id === taskId);
  if (!task) throw new Error('没有找到待返修任务');
  let difficultyOverride = false;
  if (allowLegacyReadmeOnlyDifficultyOverride) {
    const reviewSnapshot = await readSubmissionPlatformReviewSnapshot();
    const pendingRepair = (reviewSnapshot?.submissions || []).find((record) => {
      return String(record?.submissionId || '') === String(submissionId)
        && String(record?.bugId || '') === String(task.bug_id || '');
    });
    if (pendingRepair?.reviewStatus !== 'PENDING_FIX'
      || !isReadmeOnlyPlatformRepairReason(pendingRepair?.reviewReason)) {
      throw new Error(`${task.bug_id} 不符合 README 单项打回的人工难度豁免条件`);
    }
    difficultyOverride = true;
  }
  const archivedRepairEligibility = difficultyOverride
    ? (await readArchivedTasks()).find((record) => {
      return String(record?.id || '') === String(task.id || '')
        && String(record?.name || '') === String(task.name || '')
        && String(record?.bug_id || '') === String(task.bug_id || '')
        && record?.status === 'passed'
        && record?.reviewStatus === 'qualified'
        && hasCurrentArchivedExportPolicy(record, CURRENT_VERIFICATION_POLICY_VERSION);
    })
    : null;
  if (task.status !== 'passed' && !archivedRepairEligibility) {
    throw new Error(`${task.bug_id} 尚未完成，不能返修提交`);
  }
  const qualified = (await readReviewStatuses()).some((record) => record.taskId === task.id && record.status === 'qualified')
    || (task.archived === true && task.archiveExportReady === true && task.reviewStatus === 'qualified')
    || Boolean(archivedRepairEligibility);
  if (!qualified) throw new Error(`${task.bug_id} 尚未通过本地交付审核`);
  if (!difficultyOverride) await validatePlatformBugDifficulty(task);
  if (!archivedRepairEligibility) await validateTaskExcelVerification(task);
  if (task.ruleIssues?.length && !archivedRepairEligibility) {
    throw new Error(`${task.bug_id} 尚未满足交付规则：${task.ruleIssues.join('；')}`);
  }
  if (usesFixedGitCommitLayout(task)) await assertRemoteGitDeliveryLayout(task);
  await readTrajectoryMetadata(task, { requireV4: await requiresV4Trajectory(task) });

  const [schema, editable] = await Promise.all([
    submissionPlatformRequest('/form/fields'),
    editablePlatformSubmission(submissionId),
  ]);
  if (!schema.response.ok) throw new Error(platformApiMessage(schema.payload, `读取提交平台字段失败（HTTP ${schema.response.status}）`));
  const remoteData = editable?.data ?? {};
  const remoteBugId = String(remoteData?.bug_id ?? remoteData?.bugId ?? '').trim();
  if (remoteBugId !== task.bug_id) {
    throw new Error(`平台返修记录 ${submissionId} 属于 ${remoteBugId || '未知 BUG'}，不是 ${task.bug_id}`);
  }
  const submission = preparePlatformSubmission(task, schema.payload);
  await validatePlatformVerificationCompatibility(task, submission);
  const fingerprint = platformSubmissionFingerprint(submission);

  return runSerializedSubmissionPlatformTask(task.id, async () => {
    const startedAt = new Date().toISOString();
    const result = await postSubmissionPlatformRepair(submissionId, submission);
    if (!result.response.ok) {
      const message = platformApiMessage(result.payload, `平台返修提交返回 HTTP ${result.response.status}`);
      await upsertSubmissionPlatformRecord({
        taskId: task.id,
        bugId: task.bug_id,
        fingerprint,
        status: 'submitted',
        platformSubmissionId: String(submissionId),
        platformUrl: `${submissionPlatformBaseUrl}/u/detail/${submissionId}`,
        repairAttemptedAt: startedAt,
        repairError: message,
        repairDifficultyOverride: difficultyOverride ? 'legacy_readme_only_manual_repair' : '',
      });
      throw new Error(message);
    }
    const remote = result.payload?.data ?? result.payload ?? {};
    const resubmitted = mergePlatformSubmissionReview({
      taskId: task.id,
      bugId: task.bug_id,
      fingerprint,
      status: 'submitted',
      platformSubmissionId: String(submissionId),
      platformUrl: `${submissionPlatformBaseUrl}/u/detail/${submissionId}`,
      submittedAt: editable?.submitted_at || startedAt,
      resubmittedAt: startedAt,
      repairError: '',
      repairDifficultyOverride: difficultyOverride ? 'legacy_readme_only_manual_repair' : '',
    }, { status: remote?.status || 'PENDING_FIRST_REVIEW', ...remote });
    await upsertSubmissionPlatformRecord(resubmitted);
    invalidateTaskDiscoveryCache();
    broadcast('data');
    addLog('success', `${task.bug_id} 已返修并重新提交质检平台`);
    setTimeout(() => {
      void reconcileSubmissionPlatformReviews().catch((error) => addLog('warn', `提交平台审核状态同步失败：${error.message}`));
    }, 5_000).unref();
    return resubmitted;
  });
}

async function submissionPlatformPublicState() {
  const [records, remoteSnapshot, pipelineJobs] = await Promise.all([
    readSubmissionPlatformRecords(),
    readSubmissionPlatformReviewSnapshot(),
    listPipelineJobs(),
  ]);
  const localReviewCounts = records.reduce((counts, record) => {
    const status = String(record?.platformReviewStatus || '').trim();
    if (status) counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});
  const reviewCounts = remoteSnapshot?.submissions?.length
    ? remoteSnapshot.reviewCounts || {}
    : localReviewCounts;
  const remotePendingSubmissions = (remoteSnapshot?.submissions || [])
    .filter((record) => record.reviewStatus === 'PENDING_FIX');
  return {
    baseUrl: submissionPlatformBaseUrl,
    connected: Boolean(submissionPlatformCookie),
    connectedAs: submissionPlatformConnectedAs || submissionPlatformAutoLoginAccount,
    autoLoginConfigured: submissionPlatformAutoLoginConfigured,
    syncPaused: submissionPlatformSyncPaused,
    syncPausedAt: submissionPlatformSyncPausedAt,
    syncPauseReason: submissionPlatformSyncPauseReason,
    deferredSubmissionCount: pipelineJobs.reduce((total, job) => total + deferredPlatformBugIndexes(job).length, 0),
    lastCheckedAt: submissionPlatformLastCheckedAt,
    lastRefreshedAt: submissionPlatformLastRefreshedAt,
    lastError: submissionPlatformLastError,
    reviewLastSyncedAt: submissionPlatformReviewLastSyncedAt,
    reviewLastError: submissionPlatformReviewLastError,
    reviewCounts,
    pendingRepairCount: Number(reviewCounts.PENDING_FIX || 0),
    submittedCount: records.filter((record) => record.status === 'submitted').length,
    submissions: records.map(({ taskId, bugId, status, platformSubmissionId: submissionId, platformUrl, submittedAt, error, platformReviewStatus: reviewStatus, platformReviewLabel: reviewLabel, platformReviewReason: reviewReason, platformReviewUpdatedAt: reviewUpdatedAt, platformCurrentVersion: currentVersion }) => ({
      taskId,
      bugId,
      status,
      submissionId,
      platformUrl,
      submittedAt,
      error,
      reviewStatus,
      reviewLabel,
      reviewReason,
      reviewUpdatedAt,
      currentVersion,
    })),
    remotePendingSubmissions,
  };
}

async function remoteWorkerSubmissionStats() {
  const [submissionRecords, reviewRecords] = await Promise.all([
    readSubmissionPlatformRecords(),
    readReviewStatuses(),
  ]);
  return buildSubmissionActivityStats(submissionRecords, reviewRecords);
}

async function resumeSubmissionPlatformWaiters() {
  if (submissionPlatformSyncPaused || !submissionPlatformCookie) {
    return { resumedProjects: 0, resumedBugs: 0 };
  }
  let resumedProjects = 0;
  let resumedBugs = 0;
  for (const visible of await listPipelineJobs()) {
    // Let a live Runner finish its current batch. The periodic recovery scan
    // reopens its platform tail after it goes idle, avoiding cursor write races.
    if (activePipelineProcesses.has(visible.id)) continue;
    const job = await readPipelineJob(visible.id);
    if (!job) continue;
    const reopened = reopenDeferredPlatformSubmissions(job);
    if (reopened.changed) {
      const queued = queuePipelineManualRetry(reopened.job, new Date().toISOString(), 'submission_platform_backfill');
      await writePipelineJob(queued);
      resumedProjects += 1;
      resumedBugs += reopened.bugIndexes.length;
      continue;
    }
    if (!pipelineRetryState(job).waitingForPlatform) continue;
    const queued = queuePipelineManualRetry(job, new Date().toISOString(), 'submission_platform_connected');
    await writePipelineJob(queued);
    resumedProjects += 1;
  }
  if (resumedProjects) {
    addLog('info', `提交平台连接恢复，已重新排队 ${resumedProjects} 个项目、${resumedBugs} 个延期 Bug`);
    void fillPipelineSlots();
  }
  return { resumedProjects, resumedBugs };
}

async function pathExists(target) {
  return fsp.access(target).then(() => true).catch(() => false);
}

function resolveTaskArtifact(taskDir, relativePath) {
  const resolved = path.resolve(taskDir, String(relativePath || ''));
  if (!String(relativePath || '').trim() || !resolved.startsWith(`${path.resolve(taskDir)}${path.sep}`)) {
    throw new Error('人工恢复工件路径越出任务目录');
  }
  return resolved;
}

async function readManualRecoveryValidation(taskDir, metadata, pipelineJob, pipelineBug) {
  if (metadata?.status !== 'manual_recovery_passed') return null;
  const testFile = Array.isArray(metadata.verification_test_files) && metadata.verification_test_files.length === 1
    ? metadata.verification_test_files[0]
    : '';
  const preManifestPath = resolveTaskArtifact(taskDir, metadata.verification_evidence?.pre_fix?.local_manifest);
  const postManifestPath = resolveTaskArtifact(taskDir, metadata.verification_evidence?.post_fix?.local_manifest);
  const testPath = resolveTaskArtifact(taskDir, `verification-test-manual/${testFile}`);
  const [recovery, preManifest, postManifest, testContent] = await Promise.all([
    fsp.readFile(path.join(taskDir, 'manual-recovery.json'), 'utf8').then(JSON.parse),
    fsp.readFile(preManifestPath, 'utf8').then(JSON.parse),
    fsp.readFile(postManifestPath, 'utf8').then(JSON.parse),
    fsp.readFile(testPath),
  ]);
  return validateManualRecoveryBundle({
    metadata,
    pipelineJob,
    pipelineBug,
    recovery,
    preManifest,
    postManifest,
    testSha256: crypto.createHash('sha256').update(testContent).digest('hex'),
  });
}

async function discoverTaskSources() {
  await fsp.mkdir(tasksRoot, { recursive: true });
  const entries = await fsp.readdir(workRoot, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name !== 'go-task-library' && !entry.name.startsWith('go-batch-')) continue;
    const root = path.join(workRoot, entry.name);
    const sourceTasksRoot = path.join(root, 'tasks');
    if (!await pathExists(sourceTasksRoot)) continue;
    let manifest = [];
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(root, 'validation/trajectory_export_manifest.json'), 'utf8'));
      manifest = Array.isArray(parsed) ? parsed : [];
    } catch {}
    sources.push({ id: entry.name, root, tasksRoot: sourceTasksRoot, manifest });
  }
  return sources;
}

function globalTaskId(sourceId, taskName) {
  return `task-${crypto.createHash('sha256').update(`${sourceId}/${taskName}`).digest('hex').slice(0, 16)}`;
}

function titleFromId(id) {
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Main Claude transcripts are captured and delivered as source evidence. They
// are not red/green proof artifacts, so parent-chain, tool-balance, and content
// quality findings must not block upload. Keep only the envelope needed to bind
// the file to one Session and to the immutable V4 manifest.
function readTrajectoryEnvelope(events, taskName, filename = '') {
  if (!Array.isArray(events) || !events.length) throw new Error(`${taskName} 轨迹正文必须是非空事件数组`);
  if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) {
    throw new Error(`${taskName} 轨迹包含非 JSON 对象事件`);
  }
  const sessionIds = [...new Set(events.map((event) => String(event?.sessionId || event?.session_id || '').trim().toLowerCase()).filter(Boolean))];
  if (sessionIds.length !== 1 || !SESSION_ID_PATTERN.test(sessionIds[0] || '')) {
    throw new Error(`${taskName} 轨迹必须且只能包含一个合法 session ID`);
  }
  const basename = path.basename(filename || '');
  const filenameMatch = basename.match(TRAJECTORY_FILENAME_PATTERN);
  if (filenameMatch && filenameMatch[1].toLowerCase() !== sessionIds[0]) {
    throw new Error(`${taskName} 文件名 session ID 与正文不一致`);
  }
  return {
    eventCount: events.length,
    sessionId: sessionIds[0],
    taskName,
    format: events.some((event) => event?.type === 'system' || event?.type === 'result')
      ? 'claude-stream-jsonl'
      : 'claude-native-jsonl',
  };
}

async function readTaskClaudeCodeVersion(taskDir) {
  const trajectoryDir = path.join(taskDir, 'trajectory');
  const entries = await fsp.readdir(trajectoryDir).catch(() => []);
  const candidates = [...new Set([
    ...['trajectory.stream.jsonl', 'raw.stream.jsonl'].filter((name) => entries.includes(name)),
    ...entries.filter((name) => /^raw\.native\..+\.jsonl$/i.test(name)).sort(),
    ...entries.filter((name) => /^trajectory_.+\.jsonl?$/i.test(name)).sort(),
  ])];
  for (const filename of candidates) {
    try {
      const events = parseTrajectoryJson(await fsp.readFile(path.join(trajectoryDir, filename), 'utf8'));
      const version = extractClaudeCodeVersion(events);
      if (version) return version;
    } catch {}
  }
  return '';
}

async function readTaskGeneratorModel(taskDir) {
  const trajectoryDir = path.join(taskDir, 'trajectory');
  const entries = await fsp.readdir(trajectoryDir).catch(() => []);
  const candidates = [...new Set([
    ...entries.filter((name) => /^trajectory_.+\.jsonl?$/i.test(name)).sort(),
    ...['trajectory.stream.jsonl', 'raw.stream.jsonl'].filter((name) => entries.includes(name)),
    ...entries.filter((name) => /^raw\.native\..+\.jsonl$/i.test(name)).sort(),
  ])];
  for (const filename of candidates) {
    try {
      const events = parseTrajectoryJson(await fsp.readFile(path.join(trajectoryDir, filename), 'utf8'));
      const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init') || {};
      const model = init.model || events.find((event) => event?.message?.model)?.message?.model || events.find((event) => event?.model)?.model;
      if (model) return String(model).trim();
    } catch {}
  }
  return '';
}

async function resolveTrajectoryDeliverySource(task) {
  const trajectoryDir = path.join(task.taskDir, 'trajectory');
  const entries = await fsp.readdir(trajectoryDir).catch(() => []);
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(trajectoryDir, 'runner-manifest.json'), 'utf8'));
    if (manifest.upload_source === 'raw_native') {
      const rawFilename = String(manifest.raw_filename || '');
      const uploadFilename = String(manifest.upload_filename || '');
      if (path.basename(rawFilename) !== rawFilename || !/^raw\.native\.[0-9a-f-]{36}\.jsonl$/i.test(rawFilename)) {
        throw new Error('runner manifest 的原生轨迹文件名不合法');
      }
      if (path.basename(uploadFilename) !== uploadFilename || !/^trajectory_[0-9a-f-]{36}\.jsonl$/i.test(uploadFilename)) {
        throw new Error('runner manifest 的上传文件名不合法');
      }
      return {
        path: path.join(trajectoryDir, rawFilename),
        filename: uploadFilename,
        native: true,
        rawNative: true,
      };
    }
    if (manifest.exporter_version === 'v4.1.0') {
      throw new Error('当前 runner manifest 缺少 raw_native 原始上传源，禁止回退到规范化轨迹');
    }
    const legacyRawFilename = String(manifest.raw_filename || '');
    if (/^raw\.native\.[0-9a-f-]{36}\.jsonl$/i.test(legacyRawFilename)
      && path.basename(legacyRawFilename) === legacyRawFilename
      && await pathExists(path.join(trajectoryDir, legacyRawFilename))) {
      // v4.0.0 manifests were created before the raw-native upload source was
      // made explicit. If the immutable native capture is still present, use
      // it for delivery so historical tasks do not re-upload a normalized
      // transcript that can lose native parent links. The manifest still
      // binds the canonical delivery hash for audit compatibility.
      return {
        path: path.join(trajectoryDir, legacyRawFilename),
        filename: legacyRawFilename.replace(/^raw\.native\./i, 'trajectory_'),
        native: true,
        rawNative: true,
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`${task.bug_id || task.name} 无法解析轨迹交付源：${error.message}`);
  }
  const canonicalFiles = entries.filter((entry) => /^trajectory_[0-9a-f-]{36}\.jsonl$/i.test(entry)).sort();
  if (canonicalFiles.length > 1) throw new Error(`${task.bug_id || task.name} 存在多个 Claude 规范化交付轨迹`);
  if (canonicalFiles.length === 1) return {
    path: path.join(trajectoryDir, canonicalFiles[0]),
    filename: canonicalFiles[0],
    native: true,
    rawNative: false,
  };
  return { path: path.join(trajectoryDir, 'trajectory.stream.jsonl'), native: false };
}

async function loadV4TrajectoryArtifacts(task, deliverySource, deliveryContent, deliveryEvents, { requireV4 = false } = {}) {
  const marker = await pathExists(path.join(task.taskDir, '.trajectory-policy-v4'));
  if (!marker) {
    if (requireV4) throw new Error(`${task.bug_id || task.name} 不是 V4 原始捕获，禁止重新上传、合格或导出`);
    return null;
  }
  const trajectoryDir = path.join(task.taskDir, 'trajectory');
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(trajectoryDir, 'runner-manifest.json'), 'utf8'));
    if (path.basename(String(manifest.raw_filename || '')) !== manifest.raw_filename) throw new Error('runner manifest 的 raw_filename 不是安全文件名');
    if (path.basename(String(manifest.delivery_filename || '')) !== manifest.delivery_filename) throw new Error('runner manifest 的 delivery_filename 不是安全文件名');
    const [promptDocument, rawNativeContent, rawStreamContent, auditContent, canonicalDeliveryContent] = await Promise.all([
      fsp.readFile(path.join(task.taskDir, 'PROMPT.md'), 'utf8'),
      fsp.readFile(path.join(trajectoryDir, manifest.raw_filename), 'utf8'),
      fsp.readFile(path.join(trajectoryDir, 'trajectory.stream.jsonl'), 'utf8'),
      fsp.readFile(path.join(trajectoryDir, 'mutation-audit.jsonl'), 'utf8'),
      fsp.readFile(path.join(trajectoryDir, manifest.delivery_filename), 'utf8'),
    ]);
    const prompt = resolveTrajectoryManifestPrompt(manifest, promptDocument);
    const rawEvents = parseTrajectoryJson(rawNativeContent);
    const canonicalDeliveryEvents = parseTrajectoryJson(canonicalDeliveryContent);
    const sessionIds = [...new Set(deliveryEvents.map((event) => event?.sessionId || event?.session_id).filter(Boolean))];
    const checked = validateTrajectoryManifest(manifest, {
      prompt,
      rawNativeContent,
      rawStreamContent,
      deliveryContent: canonicalDeliveryContent,
      auditContent,
      expectedSessionId: sessionIds.length === 1 ? sessionIds[0] : '',
      expectedTaskType: task.task_type,
      rawEventCount: rawEvents.length,
      deliveryEventCount: canonicalDeliveryEvents.length,
    });
    if (deliverySource.rawNative) {
      if (path.basename(deliverySource.path) !== manifest.raw_filename) checked.issues.push('runner manifest 的 raw_filename 与原生交付文件不一致');
      const expectedUploadFilename = manifest.upload_filename || String(manifest.raw_filename || '').replace(/^raw\.native\./i, 'trajectory_');
      if (deliverySource.filename !== expectedUploadFilename) checked.issues.push('runner manifest 的 upload_filename 与上传文件名不一致');
      if (deliveryContent !== rawNativeContent) checked.issues.push('上传正文不是 runner 捕获的 Claude 原生轨迹');
    } else if (manifest.delivery_filename !== path.basename(deliverySource.path)) {
      checked.issues.push('runner manifest 的 delivery_filename 与交付文件不一致');
    }
    if (manifest.task_type !== task.task_type) checked.issues.push('runner manifest 的 task_type 与任务不一致');
    if (checked.issues.length) throw new Error(checked.issues.join('；'));
    return { manifest };
  } catch (error) {
    throw new Error(`${task.bug_id || task.name} V4 runner manifest 校验失败：${error.message}`);
  }
}

function resolveArchivedArtifactPath(relativePath, expectedFilename) {
  const value = String(relativePath || '').trim();
  if (!value) throw new Error('历史恢复记录缺少本地云盘原件路径');
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(managedLibraryRoot, value);
  const root = path.resolve(archivedTrajectoriesRoot);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('历史恢复原件路径越出受管归档目录');
  if (expectedFilename && path.basename(resolved) !== expectedFilename) throw new Error('历史恢复原件文件名与 Session 不一致');
  return resolved;
}

async function readArchivedArtifact(task, artifact, label) {
  const sessionId = String(artifact?.sessionId || '').trim().toLowerCase();
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`${task.bug_id} ${label} 缺少合法 Session`);
  const filename = `trajectory_${sessionId}.jsonl`;
  const sourcePath = resolveArchivedArtifactPath(artifact.path, filename);
  const content = await fsp.readFile(sourcePath);
  let events;
  try {
    events = parseTrajectoryJson(content.toString('utf8'));
  } catch (error) {
    throw new Error(`${task.bug_id} ${label}解析失败：${error.message}`);
  }
  const validation = readTrajectoryEnvelope(events, task.bug_id || task.name, filename);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  if (validation.sessionId !== sessionId) throw new Error(`${task.bug_id} ${label}正文 Session 不一致`);
  if (Number(artifact.eventCount) !== validation.eventCount) throw new Error(`${task.bug_id} ${label}事件数与恢复记录不一致`);
  if (Number(artifact.totalBytes) !== content.length) throw new Error(`${task.bug_id} ${label}字节数与恢复记录不一致`);
  if (String(artifact.sha256 || '').toLowerCase() !== sha256) throw new Error(`${task.bug_id} ${label}SHA-256 与恢复记录不一致`);
  return { ...validation, content, filename, sourcePath, totalBytes: content.length, sha256 };
}

async function buildArchivedValidatedTrajectory(task) {
  if (!task?.archiveExportReady) throw new Error(`${task?.bug_id || task?.name || '该任务'} 的云盘原件尚未恢复`);
  const sessionId = String(task.sessionId || '').trim().toLowerCase();
  const trajectoryUrl = String(task.trajectoryUrl || task.trajectory || '').trim();
  if (!trajectoryUrl.startsWith('https://') || !trajectoryUrl.includes(`trajectory_${sessionId}.jsonl`)) {
    throw new Error(`${task.bug_id} 的云盘主轨迹未绑定当前 Session`);
  }
  const artifact = await readArchivedArtifact(task, {
    path: task.archiveTrajectoryPath,
    sessionId,
    eventCount: task.eventCount,
    totalBytes: task.totalBytes,
    sha256: task.sha256,
  }, '主轨迹');
  return {
    ...artifact,
    policyValidation: {
      ok: true,
      policy: 'historical-cloud-original',
      errors: [],
      warnings: [],
      stats: {
        eventCount: artifact.eventCount,
        sessionId: artifact.sessionId,
        taskName: artifact.taskName,
        format: artifact.format,
      },
    },
    manifest: null,
  };
}

async function buildValidatedTrajectory(task, { requireV4 = false } = {}) {
  if (task?.archived) return buildArchivedValidatedTrajectory(task);
  if (!task?.taskDir) {
    throw new Error(`${task?.bug_id || task?.name || '该任务'} 仅保留历史恢复记录，本地轨迹文件尚未恢复`);
  }
  const deliverySource = await resolveTrajectoryDeliverySource(task);
  const source = await fsp.readFile(deliverySource.path, 'utf8');
  let events;
  try {
    events = parseTrajectoryJson(source);
  } catch (error) {
    throw new Error(`${task.bug_id || task.name} 轨迹解析失败：${error.message}`);
  }
  const validation = readTrajectoryEnvelope(events, task.bug_id || task.name, deliverySource.filename || deliverySource.path);
  const filename = deliverySource.filename || (deliverySource.native ? path.basename(deliverySource.path) : `trajectory_${validation.sessionId}.json`);
  const v4 = await loadV4TrajectoryArtifacts(task, deliverySource, source, events, { requireV4 });
  const policyValidation = {
    ok: true,
    policy: 'capture-only-no-trajectory-audit',
    errors: [],
    warnings: [],
    stats: validation,
  };
  const content = deliverySource.native ? source : `${JSON.stringify(events, null, 2)}\n`;
  return {
    ...validation,
    policyValidation,
    manifest: v4?.manifest || null,
    content,
    filename,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

async function readTrajectoryMetadata(task, { requireV4 = false } = {}) {
  if (task?.archived) {
    const sourcePath = resolveArchivedArtifactPath(task.archiveTrajectoryPath, task.archiveTrajectoryFilename);
    const info = await fsp.stat(sourcePath);
    const cached = trajectoryMetadataCache.get(task.id);
    if (cached?.sourcePath === sourcePath && cached?.mtimeMs === info.mtimeMs && cached?.rawBytes === info.size) return cached.value;
    const trajectory = await buildArchivedValidatedTrajectory(task);
    const value = {
      sessionId: trajectory.sessionId,
      eventCount: trajectory.eventCount,
      totalBytes: trajectory.totalBytes,
      sha256: trajectory.sha256,
    };
    trajectoryMetadataCache.set(task.id, {
      sourcePath,
      mtimeMs: info.mtimeMs,
      rawBytes: info.size,
      v4Validated: false,
      value,
    });
    return value;
  }
  const source = await resolveTrajectoryDeliverySource(task);
  const info = await fsp.stat(source.path);
  const cached = trajectoryMetadataCache.get(task.id);
  if (cached?.sourcePath === source.path
    && cached?.mtimeMs === info.mtimeMs
    && cached?.rawBytes === info.size
    && (!requireV4 || cached.v4Validated)) return cached.value;
  const trajectory = await buildValidatedTrajectory(task, { requireV4 });
  const value = {
    sessionId: trajectory.sessionId,
    eventCount: trajectory.eventCount,
    totalBytes: trajectory.totalBytes,
    sha256: trajectory.sha256,
  };
  trajectoryMetadataCache.set(task.id, {
    sourcePath: source.path,
    mtimeMs: info.mtimeMs,
    rawBytes: info.size,
    v4Validated: requireV4 || Boolean(trajectory.manifest),
    value,
  });
  return value;
}

async function requiresV4Trajectory(task) {
  if (task?.archived) return false;
  return pathExists(path.join(task.taskDir, '.trajectory-policy-v4'));
}

async function uploadTrajectory(taskId, { allowPipelineFinalize = false, taskOverride = null } = {}) {
  const task = taskOverride || (await discoverTasks()).find((item) => item.id === taskId);
  if (!task || (!allowPipelineFinalize && task.status !== 'passed')) throw new Error('任务不存在或轨迹尚未完成');
  // The pipeline-finalize endpoint already validates the persisted qualified
  // review record together with exact Job/Bug ownership and proof stages.
  // task.reviewStatus remains null until delivery_ready, so checking that
  // derived display field here would recreate the completion cycle.
  if (!allowPipelineFinalize && task.reviewStatus !== 'qualified') throw new Error('轨迹尚未完成人工确认');
  const requireV4 = await requiresV4Trajectory(task);
  const trajectory = await buildValidatedTrajectory(task, { requireV4 });
  return uploadValidatedTrajectory(task, trajectory);
}

async function uploadValidatedTrajectory(task, trajectory) {
  return runSerializedCloudUpload(task, 'main', () => uploadValidatedTrajectoryLocked(task, trajectory, 'main'));
}

async function runSerializedCloudUpload(task, artifactKind, callback) {
  const key = `${task.id}:${artifactKind}`;
  const previous = cloudUploadTails.get(key) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  cloudUploadTails.set(key, turn);
  const queuedAt = Date.now();
  await previous.catch(() => {});
  const waitMs = Date.now() - queuedAt;
  if (waitMs >= 1000) addLog('info', `${task.bug_id} ${artifactKind} 上传等待 ${Math.round(waitMs / 1000)} 秒后开始`);
  try {
    return await callback();
  } finally {
    release();
    if (cloudUploadTails.get(key) === turn) cloudUploadTails.delete(key);
  }
}

async function persistTaskTrajectoryUrl(task, trajectory, signedUrl, uploadedAt) {
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
  if (metadata.test_model_fix_session_id && metadata.test_model_fix_session_id !== trajectory.sessionId) {
    throw new Error(`${task.bug_id} 的上传轨迹 session 与 test_model_fix_session_id 不一致`);
  }
  metadata.trajectory = signedUrl;
  metadata.trajectory_uploaded_at = uploadedAt;
  const temporaryPath = `${publicPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, publicPath);
  invalidateTaskDiscoveryCache({ graceMs: TASK_DISCOVERY_DIRTY_SNAPSHOT_TTL_MS });
}

function verificationPhaseForArtifact(artifactKind) {
  if (artifactKind === 'verify_pre') return 'pre_fix';
  if (artifactKind === 'verify_post') return 'post_fix';
  throw new Error(`不支持的验证证明附件类型：${artifactKind}`);
}

async function readVerificationProof(task, artifactKind) {
  const phase = verificationPhaseForArtifact(artifactKind);
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
  const evidence = metadata.verification_evidence?.[phase];
  if (!evidence?.local_manifest) throw new Error(`${task.bug_id} 缺少 ${phase} 本地证明 manifest`);
  const manifestPath = path.resolve(task.taskDir, evidence.local_manifest);
  if (!manifestPath.startsWith(`${path.resolve(task.taskDir)}${path.sep}`)) throw new Error(`${phase} manifest 路径越出任务目录`);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const proofDir = path.dirname(manifestPath);
  const trajectoryPath = path.resolve(proofDir, manifest.trajectory_filename || '');
  if (!trajectoryPath.startsWith(`${proofDir}${path.sep}`)) throw new Error(`${phase} 轨迹路径越出证明目录`);
  const [content, rawStreamContent, promptContent, resultContent, commandResultsContent] = await Promise.all([
    fsp.readFile(trajectoryPath, 'utf8'),
    fsp.readFile(path.join(proofDir, 'raw.stream.jsonl'), 'utf8'),
    fsp.readFile(path.join(proofDir, 'PROMPT.md'), 'utf8'),
    fsp.readFile(path.join(proofDir, 'verification-result.json'), 'utf8'),
    fsp.readFile(path.join(proofDir, 'verification-command-results.jsonl'), 'utf8'),
  ]);
  const otherPhase = phase === 'pre_fix' ? 'post_fix' : 'pre_fix';
  const allowHistoricalDiagnosisModelRepro = metadata.task_type === 'diagnosis'
    && Array.isArray(metadata.verify_cmds)
    && metadata.verify_cmds.length > 0
    && metadata.verify_cmds.every((command) => /^MODEL_REPRO=1\s+go\s+test\b/i.test(String(command).trim()))
    && evidence.verify_cmds_sha256 === verificationCommandsSha256(metadata.verify_cmds);
  const checked = validateVerificationProofBundle({
    phase,
    taskName: task.name,
    taskType: metadata.task_type,
    mainSessionId: metadata.test_model_fix_session_id,
    otherSessionId: metadata.verification_evidence?.[otherPhase]?.session_id,
    bugBaseCommit: metadata.bug_base_commit,
    preFixCommit: Number(metadata.git_commit_layout_policy_version || 0) >= GIT_COMMIT_LAYOUT_POLICY_VERSION
      ? metadata.red_commit
      : metadata.bug_base_commit,
    testModelFixCommit: metadata.test_model_fix_commit,
    verifyCmds: metadata.verify_cmds,
    evidence,
    manifest,
    trajectoryContent: content,
    rawStreamContent,
    promptContent,
    resultContent,
    commandResultsContent,
    allowHistoricalDiagnosisModelRepro,
  });
  if (!checked.ok) throw new Error(`${phase} 验证证明不完整或绑定失效：${checked.issues.join('；')}`);
  return {
    sessionId: checked.sessionId,
    eventCount: checked.eventCount,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    sha256: checked.sha256,
    content: `${content.trimEnd()}\n`,
    filename: path.basename(trajectoryPath),
    manifest,
  };
}

async function validateArchivedExcelVerification(task) {
  if (!hasCurrentArchivedExportPolicy(task, CURRENT_VERIFICATION_POLICY_VERSION)) {
    throw new Error(`${task.bug_id} 禁止 Excel 导出：历史证明策略版本不足`);
  }
  await buildArchivedValidatedTrajectory(task);

  const requiredFields = [
    'repo_url',
    'go_version',
    'repro_determinism',
    'user_query',
    'verify_cmds',
    'gold_root_cause',
    'success_criteria',
    'verify_result',
    'harness',
    'generator_model',
  ];
  const missing = requiredFields.filter((field) => !String(task[field] || '').trim());
  if (missing.length) throw new Error(`${task.bug_id} 禁止 Excel 导出：历史记录缺少 ${missing.join('、')}`);

  let verifyResult;
  try {
    verifyResult = JSON.parse(task.verify_result);
  } catch (error) {
    throw new Error(`${task.bug_id} 禁止 Excel 导出：verify_result 不是有效 JSON：${error.message}`);
  }
  const phases = task.task_type === 'diagnosis'
    ? ['pre_fix']
    : task.task_type === 'bugfix'
      ? ['pre_fix', 'post_fix']
      : [];
  if (!phases.length) throw new Error(`${task.bug_id} 禁止 Excel 导出：任务类型不合法`);
  if (task.task_type === 'diagnosis' && (verifyResult.post_fix || task.verification_evidence?.post_fix)) {
    throw new Error(`${task.bug_id} 禁止 Excel 导出：diagnosis 不应包含修复后证明`);
  }

  for (const phase of phases) {
    const expectedResult = phase === 'pre_fix' ? 'red' : 'green';
    const evidence = task.verification_evidence?.[phase];
    const resultEvidence = verifyResult?.[phase];
    const proof = task.archiveProofs?.[phase];
    if (!evidence || !resultEvidence || !proof) throw new Error(`${task.bug_id} 禁止 Excel 导出：${phase} 云盘证明不完整`);
    if (evidence.session_id !== resultEvidence.session_id
      || evidence.trajectory_url !== resultEvidence.trajectory_url
      || evidence.result !== resultEvidence.result
      || evidence.result !== expectedResult) {
      throw new Error(`${task.bug_id} 禁止 Excel 导出：${phase} 证明与 verify_result 不一致`);
    }
    let proofUrl;
    try {
      proofUrl = new URL(evidence.trajectory_url);
    } catch {
      throw new Error(`${task.bug_id} 禁止 Excel 导出：${phase} 云盘链接无效`);
    }
    if (proofUrl.protocol !== 'https:' || path.basename(proofUrl.pathname) !== `trajectory_${evidence.session_id}.jsonl`) {
      throw new Error(`${task.bug_id} 禁止 Excel 导出：${phase} 云盘链接未绑定证明 Session`);
    }
    if (proof.sessionId !== evidence.session_id || proof.result !== expectedResult || proof.trajectoryUrl !== evidence.trajectory_url) {
      throw new Error(`${task.bug_id} 禁止 Excel 导出：${phase} 本地恢复证明与云盘记录不一致`);
    }
    await readArchivedArtifact(task, proof, `${phase} 证明`);
  }
  return { phases };
}

async function validateTaskExcelVerification(task) {
  if (task?.archived) return validateArchivedExcelVerification(task);
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
  const policy = assertVerificationExportMetadata(metadata, { aggregatedVerifyCmds: task.verify_cmds });
  if (Number(metadata.verification_coverage_policy_version || 0) > 0) {
    const graderDir = path.join(task.taskDir, 'grader');
    const modelPolicy = Number(metadata.verification_coverage_policy_version || 0) >= VERIFICATION_COVERAGE_POLICY_VERSION;
    const filesListName = modelPolicy ? 'model-test-files.txt' : 'test-files.txt';
    const testsRootName = modelPolicy ? 'model-tests' : 'gold-tests';
    const listed = (await fsp.readFile(path.join(graderDir, filesListName), 'utf8'))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const goldTests = [];
    for (const filename of listed) {
      if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..') || !filename.endsWith('_test.go')) {
        throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：公开模型测试路径不安全：${filename}`);
      }
      goldTests.push({
        path: filename.replaceAll('\\', '/'),
        content: await fsp.readFile(path.join(graderDir, testsRootName, filename), 'utf8'),
      });
    }
    // Coverage reports are generated during the pipeline review. Some older
    // deliveries have the report in the pipeline artifact directory because a
    // cleanup step removed the copy under grader/. Prefer the task-local copy,
    // then recover the immutable review artifact without weakening validation.
    const readCoverageReport = async () => {
      const localPath = path.join(graderDir, 'verification-coverage.json');
      try {
        return JSON.parse(await fsp.readFile(localPath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const jobId = String(metadata.pipeline_job_id || task.pipelineJobId || '').trim();
      const bugIndex = Number(metadata.bug_index);
      if (!/^pipeline-[a-z0-9-]+$/i.test(jobId) || !Number.isInteger(bugIndex) || bugIndex < 1) {
        throw new Error('缺少隐藏 grader/verification-coverage.json 覆盖报告');
      }
      const artifactPath = path.join(pipelineJobsRoot, jobId, 'artifacts', `bug${bugIndex}-verification-coverage-review.json`);
      try {
        return JSON.parse(await fsp.readFile(artifactPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('缺少隐藏 grader/verification-coverage.json 覆盖报告');
        throw error;
      }
    };
    const coverageReport = await readCoverageReport();
    assertVerificationCoverage(metadata, { modelTests: goldTests, goldTests, report: coverageReport });
    if (modelPolicy && metadata.task_type === 'bugfix') {
      for (const filename of metadata.verification_test_files || []) {
        if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..') || !String(filename).endsWith('_test.go')) {
          throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：metadata 模型测试路径不安全：${filename}`);
        }
      }
      const workspaceSources = await Promise.all((metadata.verification_test_files || []).map(async (filename) => ({
        path: filename,
        content: await fsp.readFile(path.join(task.taskDir, 'workspace', filename), 'utf8'),
      })));
      const modelIssues = modelVerificationPlanIssues(metadata, workspaceSources);
      if (modelIssues.length) throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：公开模型测试与工作区不一致：${modelIssues.join('；')}`);
    }
  }
  if (Number(metadata.verification_policy_version || 0) >= CURRENT_VERIFICATION_POLICY_VERSION
    && metadata.verification_test_overlay === 'repository-tests') {
    const files = Array.isArray(metadata.verification_test_files) ? metadata.verification_test_files : [];
    if (!files.length) throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：repository-tests 缺少 verification_test_files`);
    for (const filename of files) {
      if (path.isAbsolute(filename) || String(filename).split(/[\\/]/).includes('..') || !String(filename).endsWith('_test.go')) {
        throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：公开验证测试路径不安全：${filename}`);
      }
      const diagnosisPublishedTest = metadata.task_type === 'diagnosis'
        && metadata.verification_test_published === true
        && metadata.verification_fixture_published === true
        && metadata.verification_test_storage === 'repository-red-branch';
      const fixtureDir = diagnosisPublishedTest ? path.resolve(String(metadata.verification_fixture_dir || '')) : '';
      const taskRoot = path.resolve(task.taskDir);
      if (diagnosisPublishedTest && (!fixtureDir || (fixtureDir !== taskRoot && !fixtureDir.startsWith(`${taskRoot}${path.sep}`)))) {
        throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：diagnosis 系统验证测试目录越出任务目录`);
      }
      const sourcePath = diagnosisPublishedTest
        ? path.join(fixtureDir, filename)
        : path.join(task.taskDir, 'workspace', filename);
      try {
        await fsp.access(sourcePath);
      } catch {
        throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：缺少已发布公开验证测试：${filename}`);
      }
      if (diagnosisPublishedTest && /^[a-f0-9]{64}$/i.test(String(metadata.verification_test_sha256 || ''))) {
        const digest = crypto.createHash('sha256').update(await fsp.readFile(sourcePath)).digest('hex');
        if (digest !== metadata.verification_test_sha256) {
          throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：diagnosis 已发布验证测试哈希不一致：${filename}`);
        }
      }
    }
  }
  for (const phase of policy.phases) {
    const artifactKind = phase === 'pre_fix' ? 'verify_pre' : 'verify_post';
    try {
      await readVerificationProof(task, artifactKind);
    } catch (error) {
      throw new Error(`${metadata.bug_id || task.bug_id} 禁止 Excel 导出：${phase} 证明校验失败：${error.message}`);
    }
  }
  return policy;
}

async function persistTaskProofUrl(task, artifactKind, proof, signedUrl, uploadedAt) {
  const phase = verificationPhaseForArtifact(artifactKind);
  const publicPath = path.join(task.taskDir, 'public.json');
  const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
  const current = metadata.verification_evidence?.[phase];
  if (!current || current.session_id !== proof.sessionId || current.trajectory_sha256 !== proof.sha256) {
    throw new Error(`${task.bug_id} 的 ${phase} 上传内容与本地证明不一致`);
  }
  metadata.verification_evidence = {
    ...(metadata.verification_evidence || {}),
    [phase]: { ...current, trajectory_url: signedUrl, uploaded_at: uploadedAt },
  };
  const phases = metadata.task_type === 'diagnosis' ? ['pre_fix'] : ['pre_fix', 'post_fix'];
  const completeEvidence = phases.every((candidate) => {
    const evidence = metadata.verification_evidence?.[candidate];
    return evidence?.session_id && evidence?.trajectory_url;
  });
  if (completeEvidence) {
    metadata.verify_result = JSON.stringify(Object.fromEntries(phases.map((candidate) => {
      const evidence = metadata.verification_evidence[candidate];
      return [candidate, {
        trajectory_url: evidence.trajectory_url,
        session_id: evidence.session_id,
        result: candidate === 'pre_fix' ? 'red' : 'green',
      }];
    })));
  }
  const temporaryPath = `${publicPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await fsp.rename(temporaryPath, publicPath);
  invalidateTaskDiscoveryCache({ graceMs: TASK_DISCOVERY_DIRTY_SNAPSHOT_TTL_MS });
}

async function uploadValidatedTrajectoryLocked(task, trajectory, artifactKind = 'main') {
  const existingRecords = await readCloudUploads();
  const existing = existingRecords.find((record) => record.taskId === task.id
    && String(record.artifactKind || 'main') === artifactKind
    && record.sha256 === trajectory.sha256);
  if (existing) {
    const signedUrl = selectPermanentSignedUrl(existing, cloudUploadBaseUrl);
    if (artifactKind === 'main') await persistTaskTrajectoryUrl(task, trajectory, signedUrl, existing.uploadedAt || new Date().toISOString());
    else await persistTaskProofUrl(task, artifactKind, trajectory, signedUrl, existing.uploadedAt || new Date().toISOString());
    return { ...existing, signedUrl, skipped: true };
  }

  await ensureCloudSession({ reason: `${task.bug_id} ${artifactKind} 上传` });
  let response = null;
  let payload = {};
  let lastError = null;
  let authRefreshed = false;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const form = new FormData();
    form.append('files', new Blob([trajectory.content], { type: trajectory.filename.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json' }), trajectory.filename);
    form.append('expire', 'forever');
    try {
      response = await fetch(`${cloudUploadBaseUrl}/api/upload`, {
        method: 'POST',
        headers: { cookie: cloudSessionCookie },
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(90_000),
      });
      lastError = null;
    } catch (error) {
      lastError = error;
      response = null;
      if (attempt >= 3 || !isCloudTransientFailure(0, error)) break;
      const delayMs = cloudUploadRetryDelayMs(attempt);
      addLog('warn', `${task.bug_id} ${artifactKind} 云盘临时网络失败，第 ${attempt + 1}/4 次后 ${delayMs}ms 重试：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const location = response.headers.get('location') || '';
    const authenticationFailure = isCloudAuthenticationFailure(response.status, location, cloudUploadBaseUrl);
    if (authenticationFailure) {
      await clearCloudSession();
      if (authRefreshed || !shouldRetryCloudUpload(0, response.status, location, cloudUploadBaseUrl)) {
        throw new Error('云盘自动登录后仍被拒绝，请重新连接账号');
      }
      authRefreshed = true;
      await ensureCloudSession({ reason: `${task.bug_id} ${artifactKind} 上传时会话失效` });
      continue;
    }
    payload = await response.json().catch(() => ({}));
    if (!isCloudTransientFailure(response.status)) {
      break;
    }
    if (!shouldRetryCloudUpload(attempt, response.status, location, cloudUploadBaseUrl)) break;
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.min(30_000, retryAfterSeconds * 1000)
      : cloudUploadRetryDelayMs(attempt);
    addLog('warn', `${task.bug_id} ${artifactKind} 云盘返回 HTTP ${response.status}，${delayMs}ms 后重试`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!response) {
    const detail = lastError?.name === 'TimeoutError' ? '请求超过 90 秒' : (lastError?.message || '网络请求失败');
    throw new Error(`[cloud_transient] ${task.bug_id} ${artifactKind} 上传失败：${detail}`);
  }
  const uploaded = payload.files?.[0];
  if (!response.ok || !payload.ok || !uploaded) {
    const category = isCloudTransientFailure(response.status) ? 'cloud_transient' : 'cloud_response';
    throw new Error(`[${category}] ${payload.error || `${task.bug_id} ${artifactKind} 上传失败（HTTP ${response.status}）`}`);
  }
  const signedUrl = selectPermanentSignedUrl(uploaded, cloudUploadBaseUrl);
  const record = {
    taskId: task.id,
    task: task.name,
    bugId: task.bug_id,
    artifactKind,
    sessionId: trajectory.sessionId,
    filename: trajectory.filename,
    eventCount: trajectory.eventCount,
    totalBytes: trajectory.totalBytes,
    sha256: trajectory.sha256,
    signedUrl,
    key: uploaded.key || '',
    expiresAt: uploaded.expiresAt || uploaded.expires_at || 'forever',
    uploadedAt: new Date().toISOString(),
    uploadDurationMs: Date.now() - startedAt,
  };
  let persistedRecord = record;
  await withCloudUploadsLock(async () => {
    const latestRecords = await readCloudUploads();
    const duplicate = latestRecords.find((item) => item.taskId === task.id
      && String(item.artifactKind || 'main') === artifactKind
      && item.sha256 === trajectory.sha256);
    if (duplicate) {
      persistedRecord = duplicate;
      return;
    }
    const records = latestRecords.filter((item) => !(item.taskId === task.id && String(item.artifactKind || 'main') === artifactKind));
    records.push(record);
    await writeCloudUploadsUnlocked(records);
  });
  try {
    const persistedUrl = selectPermanentSignedUrl(persistedRecord, cloudUploadBaseUrl);
    if (artifactKind === 'main') await persistTaskTrajectoryUrl(task, trajectory, persistedUrl, persistedRecord.uploadedAt);
    else await persistTaskProofUrl(task, artifactKind, trajectory, persistedUrl, persistedRecord.uploadedAt);
  } catch (error) {
    throw new Error(`[cloud_persistence] ${task.bug_id} ${artifactKind} 已上传但本地回填失败；重试会复用现有链接：${error.message}`);
  }
  addLog('success', `${task.bug_id} ${artifactKind} 云盘上传完成（${record.uploadDurationMs}ms）`);
  return { ...persistedRecord, signedUrl: selectPermanentSignedUrl(persistedRecord, cloudUploadBaseUrl), skipped: persistedRecord !== record };
}

async function uploadProofTrajectory(taskId, artifactKind) {
  let task = (await discoverTasks()).find((item) => item.id === taskId);
  if (!task) {
    // Active pipeline tasks can appear while a deliberately retained task
    // snapshot is still serving UI reads. Proof upload is a write boundary, so
    // a cache miss must be confirmed against the filesystem before failing.
    invalidateTaskDiscoveryCache();
    task = (await discoverTasksFresh()).find((item) => item.id === taskId);
  }
  if (!task) throw new Error('验证证明对应的任务不存在');
  const proof = await readVerificationProof(task, artifactKind);
  return runSerializedCloudUpload(task, artifactKind, () => uploadValidatedTrajectoryLocked(task, proof, artifactKind));
}

async function uploadTrajectoryFile(filename, content) {
  const filenameSessionId = extractTrajectorySessionId(filename);
  let events;
  try {
    const text = content.toString('utf8').replace(/^\uFEFF/u, '');
    events = parseTrajectoryJson(text);
  } catch (error) {
    throw new Error(`${filename} 不是合法 JSON/JSONL：${error.message}`);
  }
  if (!Array.isArray(events)) throw new Error(`${filename} 的 trajectory 正文必须能解析为事件数组`);
  const validation = readTrajectoryEnvelope(events, filename, filename);
  if (validation.sessionId.toLowerCase() !== filenameSessionId) {
    throw new Error(`${filename} 的文件名 session ID 与 JSON 内容不一致`);
  }

  const task = requireUniquePassedTaskForSession(await discoverTasks(), filenameSessionId, filename);
  if (task.reviewStatus !== 'qualified') throw new Error(`${filename} 对应任务尚未完成人工确认`);
  const local = await buildValidatedTrajectory(task, { requireV4: true });
  const uploadedHash = crypto.createHash('sha256').update(content).digest('hex');
  if (filename !== local.filename || uploadedHash !== local.sha256 || validation.eventCount !== local.eventCount) {
    throw new Error(`${filename} 与本机 runner manifest 绑定的原始交付轨迹不一致，禁止手工修补后上传`);
  }
  return uploadValidatedTrajectory(task, local);
}

async function cloudPublicState() {
  const uploads = await readCloudUploads();
  return createCloudPublicState({
    connected: Boolean(cloudSessionCookie),
    connectedAs: cloudConnectedAs || (cloudAutoLoginConfigured ? cloudAutoLoginAccount : ''),
    autoLoginConfigured: cloudAutoLoginConfigured,
    lastCheckedAt: cloudLastCheckedAt,
    lastRefreshedAt: cloudLastRefreshedAt,
    lastError: cloudLastError,
  }, uploads.map(({ taskId, bugId, artifactKind, sessionId, filename, eventCount, totalBytes, sha256, signedUrl, url, key, expiresAt, uploadedAt }) => ({
      taskId,
      bugId,
      artifactKind: artifactKind || 'main',
      sessionId,
      filename,
      eventCount,
      totalBytes,
      sha256,
      signedUrl: signedUrl || url || '',
      key,
      expiresAt,
      uploadedAt,
    })));
}

async function autoUploadCompletedTrajectories() {
  if (!cloudSessionCookie || automaticUploadRunning) return;
  automaticUploadRunning = true;
  try {
    const tasks = await discoverTasks();
    const existingUploads = new Map((await readCloudUploads())
      .filter((record) => !record.artifactKind || record.artifactKind === 'main')
      .map((record) => [record.taskId, record]));
    const nowMs = Date.now();
    const candidates = tasks.filter((task) => task.productionFlowEligible
      && task.status === 'passed'
      && task.reviewStatus === 'qualified'
      && !task.ruleIssues.length
      && nowMs >= (automaticUploadRetryAt.get(task.id) || 0))
      .filter((task) => {
        const existing = existingUploads.get(task.id);
        if (!existing || existing.sha256 !== task.sha256) return true;
        try {
          return task.trajectory !== selectPermanentSignedUrl(existing, cloudUploadBaseUrl);
        } catch {
          return true;
        }
      });
    for (const task of candidates) {
      try {
        const trajectory = await buildValidatedTrajectory(task, { requireV4: true });
        const uploaded = await uploadValidatedTrajectory(task, trajectory);
        automaticUploadRetryAt.delete(task.id);
        if (!uploaded.skipped) addLog('success', `自动上传轨迹并回填 Excel 链接：${task.bug_id}`);
      } catch (error) {
        automaticUploadRetryAt.set(task.id, Date.now() + 30_000);
        addLog('warn', `自动上传 ${task.bug_id} 暂未完成：${error.message}`);
        if (!cloudSessionCookie) break;
      }
    }
  } finally {
    automaticUploadRunning = false;
  }
}

async function discoverPendingTasks() {
  return (await discoverTasks()).filter((task) => task.status === 'queued'
    && !task.pipelineManaged
    && task.productionFlowEligible
    && task.gitPreparationEligible);
}

async function discoverTasks({ allowStale = false } = {}) {
  if (taskDiscoveryCache.value && Date.now() < taskDiscoveryCache.expiresAt) return taskDiscoveryCache.value;
  if (taskDiscoveryCache.promise) {
    return allowStale && taskDiscoveryCache.value
      ? taskDiscoveryCache.value
      : taskDiscoveryCache.promise;
  }
  const generation = taskDiscoveryCache.generation;
  const discovery = discoverTasksFresh().then((value) => {
    if (generation !== taskDiscoveryCache.generation) {
      // The scan is still newer than the snapshot currently shown to the UI.
      // Keep it briefly as a stale-while-revalidate value, but do not grant the
      // normal cache lifetime because files changed while it was being built.
      taskDiscoveryCache.value = value;
      taskDiscoveryCache.expiresAt = Date.now() + TASK_DISCOVERY_DIRTY_SNAPSHOT_TTL_MS;
      return value;
    }
    taskDiscoveryCache.value = value;
    taskDiscoveryCache.expiresAt = Date.now() + TASK_DISCOVERY_CACHE_TTL_MS;
    return value;
  });
  taskDiscoveryCache.promise = discovery;
  discovery.then(
    () => {
      if (taskDiscoveryCache.promise === discovery) taskDiscoveryCache.promise = null;
    },
    (error) => {
      if (taskDiscoveryCache.promise === discovery) taskDiscoveryCache.promise = null;
      addLog('warn', `任务索引刷新失败：${error.message}`);
    },
  );
  if (allowStale && taskDiscoveryCache.value) {
    discovery.then(() => broadcast('data'), () => {});
    return taskDiscoveryCache.value;
  }
  return discovery;
}

async function discoverTasksFresh() {
  const tasks = [];
  const labelRecordMap = await readLabelExportRecords();
  const taskExportMap = new Map((await readTaskExportRecords()).map((record) => [record.taskId, record]));
  const submissionPlatformRecordMap = new Map((await readSubmissionPlatformRecords()).map((record) => [record.taskId, record]));
  const pipelineJobs = await listPipelineJobs();
  const pipelineTaskOwners = new Map();
  for (const job of pipelineJobs) {
    for (const bug of job.bugs || []) {
      if (bug.task?.taskName) pipelineTaskOwners.set(bug.task.taskName, job);
    }
  }
  for (const source of await discoverTaskSources()) {
    const manifestMap = new Map(source.manifest.map((item) => [item.task, item]));
    const entries = await fsp.readdir(source.tasksRoot, { withFileTypes: true });
    const taskEntries = entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (let offset = 0; offset < taskEntries.length; offset += TASK_DISCOVERY_CONCURRENCY) {
      await Promise.all(taskEntries.slice(offset, offset + TASK_DISCOVERY_CONCURRENCY).map(async (entry) => {
        const taskDir = path.join(source.tasksRoot, entry.name);
      try {
        const meta = normalizeDiagnosisGitMetadata(JSON.parse(await fsp.readFile(path.join(taskDir, 'public.json'), 'utf8')));
        await fsp.access(path.join(taskDir, 'PROMPT.md'));
        const id = globalTaskId(source.id, entry.name);
        const hasTrajectory = await pathExists(path.join(taskDir, 'trajectory', 'trajectory.stream.jsonl'));
        const [policyV4, policyV3, policyV2] = await Promise.all([
          pathExists(path.join(taskDir, '.trajectory-policy-v4')),
          pathExists(path.join(taskDir, '.trajectory-policy-v3')),
          pathExists(path.join(taskDir, '.trajectory-policy-v2')),
        ]);
        const trajectoryPolicyVersion = policyV4 ? 4 : policyV3 ? 3 : policyV2 ? 2 : 0;
        const hasRaw = await pathExists(path.join(taskDir, 'trajectory', 'raw.stream.jsonl'));
        const hasFailure = await pathExists(path.join(taskDir, 'trajectory', 'last_failure.json'));
        const hasWorkspace = await pathExists(path.join(taskDir, 'workspace'));
        const hasGoMod = await pathExists(path.join(taskDir, 'pristine', 'go.mod')) || await pathExists(path.join(taskDir, 'workspace', 'go.mod'));
        const record = manifestMap.get(entry.name) || manifestMap.get(meta.sample_id);
        let resolvedHarness = meta.harness || '';
        if (hasTrajectory && getClaudeHarnessIssues(resolvedHarness).length) {
          const claudeVersion = await readTaskClaudeCodeVersion(taskDir);
          if (claudeVersion) resolvedHarness = upsertClaudeCodeHarness(resolvedHarness, claudeVersion);
        }
        const baseTask = { ...meta, harness: resolvedHarness, id, name: entry.name, sourceId: source.id, taskDir };
        if (hasTrajectory && !String(baseTask.generator_model || '').trim()) {
          baseTask.generator_model = await readTaskGeneratorModel(taskDir);
        }
        const pipelineOwner = pipelineJobs.find((job) => job.id === meta.pipeline_job_id) || pipelineTaskOwners.get(entry.name) || null;
        const pipelineOutcome = pipelineTaskOutcome(pipelineOwner, { taskName: entry.name, bugIndex: meta.bug_index });
        const pipelineBug = pipelineOwner?.bugs?.find((item) => item?.task?.taskName === entry.name)
          || pipelineOwner?.bugs?.find((item) => Number(item?.bugIndex) === Number(meta.bug_index))
          || null;
        const pipelineDeliveryIncomplete = Boolean(
          pipelineOwner && !isPipelineBugDeliveryComplete(pipelineOwner, Number(meta.bug_index)),
        );
        const exportRecord = taskExportMap.get(id) || {};
        const labelRecord = labelRecordMap.get(meta.bug_id || entry.name) || {};
        const verificationPolicyV5 = Number(meta.verification_policy_version || 0) >= CURRENT_VERIFICATION_POLICY_VERSION;
        const configuredVerifyCmds = verificationPolicyV5 ? meta.verify_cmds : (labelRecord.verify_cmds || meta.verify_cmds || '');
        const configuredVerifyText = Array.isArray(configuredVerifyCmds) ? configuredVerifyCmds.join('\n') : String(configuredVerifyCmds);
        if (verificationPolicyV5) {
          baseTask.verify_cmds = meta.verify_cmds;
        } else if (meta.task_type === 'bugfix' && !/go test[^\n]*-run\b/i.test(configuredVerifyText)) {
          const context = await fsp.readFile(path.join(taskDir, 'grader/v4-context.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => null);
          if (/^\.(?:\/[A-Za-z0-9_.-]+)+$/.test(String(context?.gold_test_package || ''))
            && /^Test[A-Za-z0-9_]+$/.test(String(context?.gold_test_name || ''))) {
            const focused = publicTargetCommandForTask('bugfix', context);
            baseTask.verify_cmds = explicitDockerVerifyCmds(meta.sample_id || entry.name, 'bugfix', focused);
          }
        } else if (meta.task_type === 'diagnosis' && !/(?:go test[^\n]*-run\b|\/grader\/run_target\.sh\s+\/workspace\b)/i.test(configuredVerifyText)
          && await pathExists(path.join(taskDir, 'grader/run_target.sh'))
          && await pathExists(path.join(taskDir, 'grader/run_full.sh'))) {
          baseTask.verify_cmds = packagedDockerVerifyCmds(meta.sample_id || entry.name, 'diagnosis');
        } else {
          baseTask.verify_cmds = configuredVerifyCmds;
        }
        let localTrajectory = null;
        let trajectoryValidationError = '';
        if (hasTrajectory) {
          try {
            localTrajectory = await readTrajectoryMetadata(baseTask);
          } catch (error) {
            trajectoryValidationError = error.message;
          }
        }
        const prompt = await fsp.readFile(path.join(taskDir, 'PROMPT.md'), 'utf8').then((value) => value.replace(/^# 用户题面\s*/u, '').trim()).catch(() => '');
        const goldRootCause = await fsp.readFile(path.join(taskDir, 'gold/gold_root_cause.md'), 'utf8').then((value) => value.trim()).catch(() => '');
        const resolvedGoldFiles = pipelineBug?.discovery?.target_files || meta.gold_files || meta.target_files || [];
        const resolvedGoldSymbols = pipelineBug?.discovery?.symbols || meta.gold_symbols || meta.symbols || [];
        let resolvedRootCause = meta.gold_root_cause || goldRootCause;
        if (!resolvedRootCause && pipelineBug?.discovery?.failure_mechanism) {
          resolvedRootCause = (() => {
            try {
              return buildGoldRootCause(pipelineBug.discovery);
            } catch {
              return resolvedRootCause;
            }
          })();
        }
        const resolvedGoVersion = resolvePinnedGoVersion(
          labelRecord.go_version || meta.go_version || '',
          meta.go_mod_version || '',
        );
        const goVersionIssues = getGoVersionRuleIssues(resolvedGoVersion, { hasGoMod });
        const rawTrajectoryRuleIssues = hasTrajectory ? await cachedTrajectoryHardRuleIssues(taskDir, {
          ...baseTask,
          go_version: resolvedGoVersion,
          hasGoMod,
          gold_root_cause: resolvedRootCause,
          gold_files: resolvedGoldFiles,
          gold_symbols: resolvedGoldSymbols,
          verify_result: labelRecord.verify_result || meta.verify_result || '',
          verify_cmds: baseTask.verify_cmds || configuredVerifyCmds,
        }) : [];
        const trajectoryRuleIssues = pipelineDeliveryIncomplete
          ? rawTrajectoryRuleIssues.filter((issue) => !/^(?:verify_result\b|bugfix 的 verify_result\b|diagnosis 的 verify_result\b|test_model_fix_(?:commit|pushed)\b|repo_url\b|pre_fix\.|post_fix\.|主轨迹、pre_fix)/i.test(issue))
          : rawTrajectoryRuleIssues;
        // Publication and proof metadata are populated only after test
        // authoring, red/green, Docker, Git and cloud finalization. Do not
        // report those downstream fields as malformed while the owning
        // pipeline Bug is still in an earlier phase.
        const productionFlowIssues = pipelineDeliveryIncomplete ? [] : getProductionFlowRuleIssues(meta);
        const gitPreparationIssues = getGitPreparationRuleIssues(meta);
        const gitWorkflowIssues = getGitWorkflowRuleIssues(meta);
        const productionFlowEligible = isManagedProductionTask(meta);
        const gitPreparationEligible = isManagedGitPreparation(meta);
        const gitWorkflowEligible = isManagedGitWorkflow(meta);
        const manualRecoveryCandidate = meta.status === 'manual_recovery_passed';
        let gitProjectValidation = null;
        const gitProjectIssues = [];
        if (productionFlowEligible || manualRecoveryCandidate) {
          if (!hasWorkspace) {
            gitProjectIssues.push('Git 项目缺少可校验的 workspace');
          } else {
            try {
              gitProjectValidation = await cachedWorkspaceProjectValidation(baseTask, {
                enforcePinnedToolchain: policyV4,
                cacheable: hasTrajectory,
              });
              gitProjectIssues.push(...gitProjectValidation.issues);
            } catch (error) {
              gitProjectIssues.push(`Git 项目规范校验失败：${error.message}`);
            }
          }
        }
        const hasGitMetadata = Object.hasOwn(meta || {}, 'git_flow')
          || Object.hasOwn(meta || {}, 'repo_url')
          || Object.hasOwn(meta || {}, 'main_commit')
          || Object.hasOwn(meta || {}, 'bug_main_commit')
          || Object.hasOwn(meta || {}, 'bug_base_commit')
          || Object.hasOwn(meta || {}, 'test_model_fix_commit')
          || Object.hasOwn(meta || {}, 'gold_model_fix_commit');
        if (productionFlowEligible && !hasGitMetadata && !gitPreparationIssues.length) {
          const message = Number(meta.workflow_version || 1) >= CURRENT_WORKFLOW_VERSION
            ? '新流程任务运行前必须包含 Codex 出题、Claude 生成 main、bug_index、独立 orphan green 基线与 Claude 修复提交的 Git 元数据'
            : '旧流程任务运行前必须包含 main、bug_main / BUG_BASE 和 gold_model_fix 的 Git 元数据';
          gitPreparationIssues.push(message);
          gitWorkflowIssues.push(message);
        }
        const activeGitIssues = pipelineDeliveryIncomplete ? [] : getApplicableGitRuleIssues(meta, { hasTrajectory });
        const rawRuleIssues = [...goVersionIssues, ...trajectoryRuleIssues, ...productionFlowIssues, ...activeGitIssues, ...gitProjectIssues];
        let manualRecoveryValidation = null;
        try {
          manualRecoveryValidation = await readManualRecoveryValidation(taskDir, meta, pipelineOwner, pipelineBug);
        } catch (error) {
          manualRecoveryValidation = { ok: false, issues: [`人工恢复工件校验失败：${error.message}`] };
        }
        const manualRecoveryPassed = Boolean(
          manualRecoveryValidation?.ok
          && gitProjectValidation?.ok,
        );
        const ruleIssues = manualRecoveryPassed ? [] : rawRuleIssues;
        const trajectoryInfo = localTrajectory || record || {};
        const trajectoryStat = hasTrajectory ? await fsp.stat(path.join(taskDir, 'trajectory', 'trajectory.stream.jsonl')).catch(() => null) : null;
        const pipelineWorkerStatus = String(pipelineBug?.workerExecution?.status || '');
        const incompletePipelineStatus = pipelineOutcome?.disposition === 'skipped'
          || pipelineWorkerStatus === 'fast_lane_failed'
          || Boolean(pipelineOutcome?.failureReason)
          ? 'failed'
          : pipelineWorkerStatus === 'fast_lane_running'
            ? 'running'
            : 'queued';
        tasks.push({
          ...baseTask,
          go_version: resolvedGoVersion,
          hasGoMod,
          user_query: meta.user_query || prompt,
          gold_root_cause: resolvedRootCause,
          gold_files: resolvedGoldFiles,
          gold_symbols: resolvedGoldSymbols,
          gold_patch: meta.gold_patch || (meta.repository && meta.fix_commit ? `${meta.repository}/commit/${meta.fix_commit} (${meta.fix_commit})` : ''),
          title: titleFromId(meta.bug_id || entry.name),
          status: pipelineDeliveryIncomplete
            ? incompletePipelineStatus
            : manualRecoveryPassed
              ? 'passed'
            : ruleIssues.length || hasFailure || trajectoryValidationError
              ? 'failed'
              : hasTrajectory && localTrajectory
                ? 'passed'
                : hasRaw && activeProcesses.has(id)
                  ? 'running'
                  : hasWorkspace && !hasRaw ? 'queued' : 'failed',
          workspaceAvailable: hasWorkspace,
          sessionId: trajectoryInfo.sessionId || null,
          eventCount: trajectoryInfo.eventCount || 0,
          totalBytes: trajectoryInfo.totalBytes || 0,
          sha256: trajectoryInfo.sha256 || null,
          ruleIssues,
          recoveryWarnings: manualRecoveryPassed ? rawRuleIssues : [],
          manualRecoveryValidated: manualRecoveryPassed,
          manualRecoveryValidation,
          trajectoryPolicyVersion,
          productionFlowEligible,
          gitPreparationEligible,
          gitWorkflowEligible,
          gitStatus: hasGitMetadata ? (gitWorkflowEligible ? 'passed' : gitPreparationEligible ? 'prepared' : 'failed') : 'missing',
          gitProjectValidation,
          gitProjectStatus: productionFlowEligible || manualRecoveryCandidate
            ? (gitProjectValidation?.ok ? 'passed' : 'failed')
            : 'historical',
          trajectoryValidationError,
          startedAt: null,
          finishedAt: manualRecoveryPassed
            ? String(meta.manual_recovery?.recovered_at || '') || null
            : trajectoryStat?.mtime?.toISOString() || null,
          exportCount: Number(exportRecord.count || 0),
          trajectoryExportCount: Number(exportRecord.trajectoryCount || 0),
          excelExportCount: Number(exportRecord.excelCount || 0),
          lastExportedAt: exportRecord.lastExportedAt || null,
          pipelineManaged: Boolean(meta.pipeline_job_id || pipelineOwner),
          pipelineJobId: meta.pipeline_job_id || pipelineOwner?.id || null,
          pipelineJobStatus: pipelineOwner?.status || null,
          pipelineDisposition: pipelineOutcome?.disposition || '',
          pipelineSkippedAt: pipelineOutcome?.skippedAt || null,
          pipelineSkipReason: pipelineOutcome?.skipReason || '',
          pipelineFailureStage: pipelineOutcome?.failureStage || '',
          pipelineFailureReason: pipelineOutcome?.failureReason || '',
          pipelineAttemptCount: pipelineOutcome?.attemptCount || 0,
        });
      } catch {}
      }));
    }
  }
  const sorted = mergeArchivedTaskRecords(tasks, await readArchivedTasks()).sort((a, b) => {
    if (a.finishedAt && b.finishedAt) return b.finishedAt.localeCompare(a.finishedAt);
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    return a.bug_id.localeCompare(b.bug_id);
  });
  const reviewMap = new Map((await readReviewStatuses()).map((record) => [record.taskId, record]));
  const reviewed = annotateIdentityConflicts(sorted).map((task) => {
    const duplicateImport = task.duplicateFields.includes('bug_id');
    const hardRuleFailure = task.ruleIssues.length > 0 || Boolean(task.workflowConflict);
    const pipelineSkipped = task.pipelineDisposition === 'skipped';
    const legacyReviewEligible = pipelineSkipped
      && task.trajectoryPolicyVersion > 0
      && task.trajectoryPolicyVersion < 4
      && task.status === 'passed'
      && !hardRuleFailure;
    const reviewRecord = reviewMap.get(task.id);
    const platformImport = platformImportState(submissionPlatformRecordMap.get(task.id));
    const manualStatus = reviewRecord?.status || 'pending';
    const manualRecoveryQualified = task.manualRecoveryValidated && !duplicateImport && !task.workflowConflict;
    return {
      ...task,
      ...platformImport,
      status: duplicateImport || task.workflowConflict ? 'duplicate' : pipelineSkipped && !legacyReviewEligible ? 'skipped' : task.status,
      finishedAt: pipelineSkipped ? (task.pipelineSkippedAt || task.finishedAt) : task.finishedAt,
      qualificationBlocked: false,
      qualificationIssues: [],
      reviewStatus: pipelineSkipped && !legacyReviewEligible
        ? 'unqualified'
        : task.archived
          ? task.reviewStatus
        : manualRecoveryQualified
          ? 'qualified'
          : task.status === 'passed' ? (hardRuleFailure ? 'unqualified' : manualStatus) : null,
      reviewStatusSource: pipelineSkipped && !legacyReviewEligible
        ? 'pipeline'
        : task.archived
          ? 'historical-archive'
        : manualRecoveryQualified
          ? 'pipeline-manual-recovery'
        : task.status === 'passed' && hardRuleFailure
          ? 'rule'
          : reviewRecord?.source?.startsWith('pipeline-') ? 'pipeline' : (reviewRecord ? 'manual' : null),
      reviewedAt: task.archived
        ? task.reviewedAt || task.archiveRecoveredAt || null
        : manualRecoveryQualified
        ? String(task.manual_recovery?.recovered_at || '') || null
        : reviewRecord?.updatedAt || null,
    };
  });
  return reviewed.sort((a, b) => {
    if (a.finishedAt && b.finishedAt) return b.finishedAt.localeCompare(a.finishedAt);
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    return a.bug_id.localeCompare(b.bug_id);
  });
}

async function streamStats(taskDir) {
  const candidates = [
    path.join(taskDir, 'trajectory', 'raw.stream.jsonl'),
    path.join(taskDir, 'trajectory', 'trajectory.stream.jsonl'),
  ];
  for (const file of candidates) {
    try {
      const info = await fsp.stat(file);
      return { file: path.basename(file), bytes: info.size };
    } catch {}
  }
  return { file: null, bytes: 0 };
}

async function runTask(item) {
  const runningTask = { id: item.id, name: item.name, bugId: item.bug_id, phase: 'starting', streamFile: null, streamBytes: 0 };
  state.currentTasks = [...state.currentTasks, runningTask];
  state.queue = state.queue.map((task) => task.id === item.id ? { ...task, status: 'running' } : task);
  addLog('info', `启动 Claude Code CLI：${item.bug_id}`);
  broadcast();

  await fsp.writeFile(path.join(item.taskDir, '.trajectory-policy-v4'), 'original-session-events=preserved\ncomplete-conversation=required\nbalanced-tool-events=required\nimmutable-runner-manifest=required\ncontent-quality-review=paused\n', 'utf8');
  const env = { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'local' };
  const child = spawn('/bin/bash', [runnerPath, item.taskDir], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  activeProcesses.set(item.id, child);
  state.currentTasks = state.currentTasks.map((task) => task.id === item.id ? { ...task, phase: 'running' } : task);
  broadcast();

  const timer = setInterval(async () => {
    const stats = await streamStats(item.taskDir);
    state.currentTasks = state.currentTasks.map((task) => task.id === item.id ? { ...task, streamFile: stats.file, streamBytes: stats.bytes } : task);
    broadcast('progress');
  }, 500);
  pollTimers.set(item.id, timer);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) addLog('success', `CLI 完成：${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) addLog('warn', text);
  });

  let result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: 1, signal: null, error: error.message }));
  });
  clearInterval(timer);
  pollTimers.delete(item.id);
  activeProcesses.delete(item.id);
  if (result.code === 0) {
    try {
      await buildValidatedTrajectory(item);
      await fsp.rm(path.join(item.taskDir, 'trajectory', 'last_failure.json'), { force: true });
      await fsp.rm(path.join(item.taskDir, 'regeneration-instructions.txt'), { force: true });
    } catch (error) {
      const streamPath = path.join(item.taskDir, 'trajectory', 'trajectory.stream.jsonl');
      const rejectedPath = path.join(item.taskDir, 'trajectory', `trajectory.stream.${Date.now()}.rejected.jsonl`);
      if (await pathExists(streamPath)) await fsp.rename(streamPath, rejectedPath);
      result = { code: 6, signal: null, error: error.message };
    }
  }
  if (result.code !== 0) {
    await fsp.mkdir(path.join(item.taskDir, 'trajectory'), { recursive: true });
    await fsp.writeFile(path.join(item.taskDir, 'trajectory', 'last_failure.json'), `${JSON.stringify({
      failedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      message: result.error || 'Claude Code CLI 或轨迹采集登记失败',
    }, null, 2)}\n`, 'utf8');
  }
  if (result.code === 0) {
    state.completed += 1;
    state.queue = state.queue.map((task) => task.id === item.id ? { ...task, status: 'passed' } : task);
    addLog('success', `题目完成并登记主轨迹：${item.bug_id}`);
  } else {
    state.failed += 1;
    state.queue = state.queue.map((task) => task.id === item.id ? { ...task, status: 'failed', exitCode: result.code, signal: result.signal } : task);
    addLog('error', `题目运行失败：${item.bug_id}（exit=${result.code ?? 'null'} signal=${result.signal ?? 'none'}）${result.error ? `：${result.error}` : ''}`);
  }
  state.currentTasks = state.currentTasks.filter((task) => task.id !== item.id);
  broadcast();
  return result.code === 0;
}

async function runQueue(queue, concurrency, { autoFill = true } = {}) {
  state.phase = 'running';
  state.status = 'running';
  state.message = `Claude Code CLI 正在执行，自动补位并保持最多 ${concurrency} 路并发`;
  state.total = queue.length;
  state.completed = 0;
  state.failed = 0;
  state.concurrency = concurrency;
  state.currentTasks = [];
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.logs = [];
  state.queue = queue.map((item) => ({ id: item.id, name: item.name, bugId: item.bug_id, status: 'queued' }));
  broadcast();

  const claimedIds = new Set();
  const activeRuns = new Map();
  let initialIndex = 0;
  const claimNext = async () => {
    let next = queue[initialIndex];
    initialIndex += 1;
    if (!next && autoFill) {
      const pending = await discoverPendingTasks();
      next = pending.find((task) => !claimedIds.has(task.id));
      if (next && !state.queue.some((task) => task.id === next.id)) {
        state.queue.push({ id: next.id, name: next.name, bugId: next.bug_id, status: 'queued' });
        state.total += 1;
        addLog('info', `检测到新导入任务并加入运行队列：${next.bug_id}`);
      }
    }
    if (!next || claimedIds.has(next.id)) return null;
    claimedIds.add(next.id);
    return next;
  };

  while (state.status !== 'stopping') {
    while (state.status !== 'stopping' && activeRuns.size < concurrency) {
      const next = await claimNext();
      if (!next) break;
      const promise = runTask(next)
        .catch((error) => addLog('error', `任务调度异常：${next.bug_id}（${error.message}）`))
        .finally(() => activeRuns.delete(next.id));
      activeRuns.set(next.id, promise);
    }
    if (!activeRuns.size) break;
    await Promise.race(activeRuns.values());
  }
  await Promise.allSettled(activeRuns.values());
  if (state.status === 'stopping') {
    state.message = '已停止，未运行题目保留在队列中';
    state.status = 'stopped';
  } else {
    state.phase = 'idle';
    state.status = state.failed ? 'completed_with_errors' : 'completed';
    state.message = state.failed ? '任务执行完成，但存在失败题目' : '任务执行完成';
  }
  state.currentTasks = [];
  state.finishedAt = new Date().toISOString();
  broadcast('complete');
}

function regenerationStamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

async function moveIfPresent(source, destination) {
  if (!await pathExists(source)) return false;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.rename(source, destination);
  return true;
}

async function prepareTasksForRegeneration(taskIds, feedback = '', feedbackByTask = {}) {
  const requested = [...new Set(Array.isArray(taskIds) ? taskIds.map(String) : [])];
  if (!requested.length) throw new Error('请至少选择一道需要重新生成轨迹的任务');
  const tasks = await discoverTasks();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const selected = requested.map((id) => taskMap.get(id));
  if (selected.some((task) => !task)) throw new Error('选择中包含不存在的任务');
  if (selected.some((task) => activeProcesses.has(task.id) || task.status === 'running')) throw new Error('运行中的任务不能重新生成轨迹');
  if (selected.some((task) => !task.productionFlowEligible || !task.gitWorkflowEligible)) throw new Error('只能重新生成已完成双修复交付的任务：每个项目最多 5 个编号 bug，每个 bug_main / BUG_BASE 对应一组 Claude 与 Codex 独立修复分支');
  if (selected.some((task) => task.status === 'duplicate' || task.workflowConflict || task.duplicateFields?.includes('bug_id'))) {
    throw new Error('重复 bug_id 或流程冲突任务不能重新生成；一个 bug 只能保留一条轨迹');
  }
  for (const task of selected) {
    if (!await pathExists(path.join(task.taskDir, 'pristine'))) throw new Error(`${task.bug_id} 缺少 pristine，不能安全重建 workspace`);
  }

  const commonFeedback = String(feedback || '').trim().slice(0, 4000);
  const stamp = regenerationStamp();
  for (const task of selected) {
    const archiveRoot = path.join(task.taskDir, 'history', `regeneration-${stamp}`);
    const taskFeedback = String(feedbackByTask?.[task.id] || commonFeedback || task.trajectoryValidationError || '').trim().slice(0, 4000);
    await fsp.mkdir(archiveRoot, { recursive: true });
    await fsp.writeFile(path.join(archiveRoot, 'regeneration.json'), `${JSON.stringify({
      archivedAt: new Date().toISOString(),
      taskId: task.id,
      bugId: task.bug_id,
      previousSessionId: task.sessionId || null,
      internalReviewNote: taskFeedback,
      forwardedToClaude: false,
    }, null, 2)}\n`, 'utf8');
    await moveIfPresent(path.join(task.taskDir, 'trajectory'), path.join(archiveRoot, 'trajectory'));
    await moveIfPresent(path.join(task.taskDir, 'workspace'), path.join(archiveRoot, 'workspace'));
    await fsp.cp(path.join(task.taskDir, 'pristine'), path.join(task.taskDir, 'workspace'), { recursive: true, preserveTimestamps: true });
    await moveIfPresent(path.join(packagesRoot, task.id), path.join(archiveRoot, 'package'));
    await moveIfPresent(path.join(packageEvidenceRoot, task.id), path.join(archiveRoot, 'package-evidence'));
    await fsp.rm(path.join(task.taskDir, 'regeneration-instructions.txt'), { force: true });
    const publicPath = path.join(task.taskDir, 'public.json');
    const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
    delete metadata.trajectory;
    delete metadata.trajectory_uploaded_at;
    const temporaryPublicPath = `${publicPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporaryPublicPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await fsp.rename(temporaryPublicPath, publicPath);
    trajectoryMetadataCache.delete(task.id);
    trajectoryHardRuleCache.delete(task.id);
  }

  await writeReviewStatuses((await readReviewStatuses()).filter((record) => !requested.includes(record.taskId)));
  await writePackageValidations((await readPackageValidations()).filter((record) => !requested.includes(record.taskId)));
  await writeCloudUploads((await readCloudUploads()).filter((record) => !requested.includes(record.taskId)));
  const refreshed = new Map((await discoverTasks()).map((task) => [task.id, task]));
  return requested.map((id) => refreshed.get(id)).filter(Boolean);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBuffer(request, maxBytes = 512 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error(`上传文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function streamRequestToFile(request, filename, maxBytes) {
  const declaredBytes = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`远程任务包不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const output = fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 });
  let totalBytes = 0;
  try {
    for await (const chunk of request) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw new Error(`远程任务包不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    return totalBytes;
  } catch (error) {
    output.destroy();
    await fsp.rm(filename, { force: true }).catch(() => {});
    throw error;
  }
}

function validateRemoteTaskArchiveListing(stdout, taskName) {
  const entries = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!entries.length) throw new Error('远程任务包为空');
  for (const entry of entries) {
    if (entry.includes('\\') || entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) throw new Error(`远程任务包包含绝对路径：${entry}`);
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    const parts = normalized.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`远程任务包包含越界路径：${entry}`);
    if (parts[0] !== taskName) throw new Error(`远程任务包根目录必须是 ${taskName}`);
  }
  return entries;
}

async function assertNoSymbolicLinks(root) {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    const stat = await fsp.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`远程任务包不能包含符号链接：${path.relative(root, filename)}`);
    if (stat.isDirectory()) await assertNoSymbolicLinks(filename);
  }
}

async function importRemoteTaskPackage(request, jobId, taskName, identity, leaseId) {
  if (!/^pipeline-[a-z0-9-]+$/i.test(jobId)) throw new Error('pipeline id 不合法');
  if (!/^[a-z0-9][a-z0-9._-]{2,160}$/i.test(taskName) || path.basename(taskName) !== taskName) throw new Error('taskName 不合法');
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('远程任务包对应的项目不存在');
  const lease = assertRemoteLeaseOwner(job, identity.workerId, leaseId);
  if (lease.status === 'cancel_requested') {
    const error = new Error('远程项目已经收到停止请求');
    error.code = 'REMOTE_CANCEL_REQUESTED';
    throw error;
  }
  const importRoot = await fsp.mkdtemp(path.join(pipelineRefillRoot, 'remote-task-import-'));
  const archivePath = path.join(importRoot, 'task.tar.gz');
  const extractionRoot = path.join(importRoot, 'extracted');
  try {
    const bytes = await streamRequestToFile(request, archivePath, REMOTE_TASK_PACKAGE_MAX_BYTES);
    if (!bytes) throw new Error('远程任务包为空');
    const listing = await runCapturedCommand('tar', ['-tzf', archivePath], { cwd: importRoot, timeoutMs: 2 * 60_000 });
    if (listing.exitCode !== 0) throw new Error(`远程任务包目录读取失败：${compactCapturedOutput(listing).slice(-1000)}`);
    validateRemoteTaskArchiveListing(listing.stdout, taskName);
    const verbose = await runCapturedCommand('tar', ['-tvzf', archivePath], { cwd: importRoot, timeoutMs: 2 * 60_000 });
    if (verbose.exitCode !== 0 || String(verbose.stdout || '').split(/\r?\n/).some((line) => /^[lh]/.test(line) || / link to /.test(line))) {
      throw new Error('远程任务包包含不允许的链接条目');
    }
    await fsp.mkdir(extractionRoot, { recursive: true });
    const extracted = await runCapturedCommand('tar', ['-xzf', archivePath, '-C', extractionRoot], { cwd: importRoot, timeoutMs: 10 * 60_000 });
    if (extracted.exitCode !== 0) throw new Error(`远程任务包解压失败：${compactCapturedOutput(extracted).slice(-1000)}`);
    const extractedTask = path.join(extractionRoot, taskName);
    const taskStat = await fsp.stat(extractedTask).catch(() => null);
    if (!taskStat?.isDirectory()) throw new Error('远程任务包缺少任务根目录');
    await assertNoSymbolicLinks(extractedTask);
    const metadata = JSON.parse(await fsp.readFile(path.join(extractedTask, 'public.json'), 'utf8'));
    if (String(metadata.pipeline_job_id || '') !== jobId) throw new Error('远程任务包的 pipeline_job_id 不匹配');
    const knownTask = (job.bugs || []).some((bug) => bug.task?.taskName === taskName);
    if (!knownTask) throw new Error('远程任务包不属于当前项目');
    await fsp.mkdir(tasksRoot, { recursive: true });
    const target = path.join(tasksRoot, taskName);
    const backup = path.join(importRoot, 'previous-task');
    const hadPrevious = Boolean(await fsp.stat(target).catch(() => null));
    if (hadPrevious) await fsp.rename(target, backup);
    try {
      await fsp.rename(extractedTask, target);
    } catch (error) {
      if (hadPrevious) await fsp.rename(backup, target).catch(() => {});
      throw error;
    }
    await fsp.rm(backup, { recursive: true, force: true });
    invalidateTaskDiscoveryCache({ graceMs: 0 });
    scheduleDatastoreEvent('data');
    return { taskName, bytes, taskDir: target };
  } finally {
    await fsp.rm(importRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendRemoteTaskPackage(response, jobId, taskName, identity, leaseId) {
  const job = await readPipelineJob(jobId);
  if (!job) throw new Error('远程任务包对应的项目不存在');
  const lease = assertRemoteLeaseOwner(job, identity.workerId, leaseId);
  if (lease.status === 'cancel_requested') {
    const error = new Error('远程项目已经收到停止请求');
    error.code = 'REMOTE_CANCEL_REQUESTED';
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,160}$/i.test(taskName) || path.basename(taskName) !== taskName) throw new Error('taskName 不合法');
  const taskDir = path.join(tasksRoot, taskName);
  if (!await fsp.stat(taskDir).catch(() => null)) {
    const error = new Error('A 电脑尚未保存这个任务检查点');
    error.statusCode = 404;
    throw error;
  }
  const exportRoot = await fsp.mkdtemp(path.join(pipelineRefillRoot, 'remote-task-export-'));
  const archivePath = path.join(exportRoot, `${taskName}.tar.gz`);
  try {
    const packed = await runCapturedCommand('tar', [
      '-czf', archivePath,
      '--exclude=.verification-cache',
      '--exclude=node_modules',
      '-C', tasksRoot,
      taskName,
    ], { cwd: tasksRoot, timeoutMs: 20 * 60_000 });
    if (packed.exitCode !== 0) throw new Error(`远程任务检查点压缩失败：${compactCapturedOutput(packed).slice(-1000)}`);
    const stat = await fsp.stat(archivePath);
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename="${taskName}.tar.gz"`,
      'cache-control': 'no-store',
    });
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(archivePath);
      input.once('error', reject);
      response.once('error', reject);
      response.once('finish', resolve);
      input.pipe(response);
    });
  } finally {
    await fsp.rm(exportRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function trajectoryDownload(response, trajectory) {
  response.writeHead(200, {
    'content-type': trajectory.filename.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${trajectory.filename}"`,
    'content-length': String(trajectory.totalBytes),
    'cache-control': 'no-store',
  });
  response.end(trajectory.content);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = zipTimestamp();
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.content);
    const compressed = deflateRawSync(data, { level: 6 });
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((file.mode || 0o100644) & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function zipDownload(response, archive, filename = `trajectory-selected-${new Date().toISOString().slice(0, 10)}.zip`) {
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': String(archive.length),
    'cache-control': 'no-store',
  });
  response.end(archive);
}

async function updateTaskReviews(taskIds, reviewStatus, { source = 'manual', pipelineJobId = '', bugIndex = null } = {}) {
  const previous = reviewUpdateTail;
  let release;
  reviewUpdateTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await updateTaskReviewsLocked(taskIds, reviewStatus, source, { pipelineJobId, bugIndex });
  } finally {
    release();
  }
}

// Pipeline finalization already carries the exact Job/Bug owner. Loading the
// whole task library here performs workspace validation for every historical
// row and can block the event loop long enough for the runner's 120s request
// timeout. Build the single task record directly from that immutable owner.
async function loadPipelineReviewTask(job, bugIndex, taskId) {
  const bug = (job?.bugs || []).find((item) => Number(item?.bugIndex) === Number(bugIndex));
  const taskName = String(bug?.task?.taskName || '').trim();
  const taskDir = String(bug?.task?.taskDir || '').trim();
  if (!taskName || !taskDir || globalTaskId('go-task-library', taskName) !== String(taskId)) {
    throw new Error('流水线回填任务与 Job/Bug 归属不一致');
  }
  const metadata = normalizeDiagnosisGitMetadata(JSON.parse(await fsp.readFile(path.join(taskDir, 'public.json'), 'utf8')));
  const hasTrajectory = await pathExists(path.join(taskDir, 'trajectory', 'trajectory.stream.jsonl'));
  if (!hasTrajectory) throw new Error(`${metadata.bug_id || taskName} 尚未生成主轨迹`);
  const session = await readTrajectoryMetadata({ ...metadata, id: taskId, taskDir, name: taskName, bug_id: metadata.bug_id || taskName });
  const resolvedGoVersion = resolvePinnedGoVersion(metadata.go_version || '', metadata.go_mod_version || '');
  const trajectoryIssues = (await cachedTrajectoryHardRuleIssues(taskDir, {
    ...metadata,
    id: taskId,
    taskDir,
    go_version: resolvedGoVersion,
    hasGoMod: true,
    verify_cmds: metadata.verify_cmds || [],
  })).filter((issue) => !/^(?:verify_result\b|bugfix 的 verify_result\b|diagnosis 的 verify_result\b|test_model_fix_(?:commit|pushed)\b|repo_url\b|pre_fix\.|post_fix\.|主轨迹、pre_fix)/i.test(issue));
  const task = {
    ...metadata,
    id: taskId,
    name: taskName,
    bug_id: metadata.bug_id || taskName,
    taskDir,
    status: 'queued',
    sessionId: session.sessionId,
    eventCount: session.eventCount,
    totalBytes: session.totalBytes,
    sha256: session.sha256,
    ruleIssues: trajectoryIssues,
    pipelineJobId: job.id,
    bug_index: Number(bugIndex),
    pipelineManaged: true,
  };
  return task;
}

async function updateTaskReviewsLocked(taskIds, reviewStatus, source, { pipelineJobId = '', bugIndex = null } = {}) {
  if (!REVIEW_STATUSES.has(reviewStatus)) throw new Error('人工状态只能是待审核、合格或不合格');
  const requested = [...new Set(taskIds.map(String))];
  if (!requested.length) throw new Error('请至少选择一道已生成轨迹的任务');

  let pipelineFinalize = source === 'pipeline-verification-finalize';
  let effectivePipelineJobId = String(pipelineJobId || '');
  let effectiveBugIndex = Number(bugIndex);
  let tasks;
  let selected;
  if (pipelineFinalize && effectivePipelineJobId && Number.isInteger(effectiveBugIndex)) {
    const pipelineJob = await readPipelineJob(effectivePipelineJobId);
    const directTask = await loadPipelineReviewTask(pipelineJob, effectiveBugIndex, requested[0]);
    tasks = [directTask];
    selected = requested.map((id) => id === directTask.id ? directTask : undefined);
  } else {
    invalidateTaskDiscoveryCache();
    tasks = await discoverTasksFresh();
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    selected = requested.map((id) => taskMap.get(id));
  }
  // Runners already alive when pipeline-verification-finalize was introduced
  // still send the older integrity source without explicit ownership fields.
  // Infer that ownership only for one pipeline-managed task whose exact Bug is
  // currently inside verification_finalize; ordinary/manual reviews cannot
  // enter this compatibility path.
  if (!pipelineFinalize && source === 'pipeline-integrity-originality' && selected.length === 1 && selected[0]) {
    const inferredPipelineJobId = String(selected[0].pipelineJobId || selected[0].pipeline_job_id || '');
    const inferredBugIndex = Number(selected[0].bug_index);
    if (inferredPipelineJobId && Number.isInteger(inferredBugIndex)) {
      const inferredJob = await readPipelineJob(inferredPipelineJobId);
      const inferredStage = (inferredJob?.stages || []).find((stage) => stage.id === `bug${inferredBugIndex}_verification_finalize`);
      if (inferredStage?.status === 'running') {
        pipelineFinalize = true;
        effectivePipelineJobId = inferredPipelineJobId;
        effectiveBugIndex = inferredBugIndex;
      }
    }
  }
  let pipelineProofReady = false;
  if (pipelineFinalize && effectivePipelineJobId && Number.isInteger(effectiveBugIndex)) {
    const job = await readPipelineJob(effectivePipelineJobId);
    const prefix = `bug${effectiveBugIndex}_`;
    const proofStages = (job?.stages || []).filter((stage) => stage.id === `${prefix}pre_verify`
      || stage.id === `${prefix}post_verify`
      || stage.id === `${prefix}red_green`
      || stage.id === `${prefix}docker_validation`
      || stage.id === `${prefix}git_publication`
      || stage.id === `${prefix}cloud_upload`
      || stage.id === `${prefix}verification_finalize`);
    pipelineProofReady = Boolean(job && proofStages.length
      && proofStages.every((stage) => ['passed', 'skipped'].includes(stage.status)
        || (stage.id === `${prefix}verification_finalize` && stage.status === 'running')));
  }
  if (selected.some((task) => !task || (!pipelineProofReady && task.status !== 'passed'))
    || (pipelineFinalize && selected.some((task) => String(task.pipelineJobId || task.pipeline_job_id || '') !== effectivePipelineJobId))) {
    throw new Error('选择中包含不存在或尚未生成完整轨迹的任务');
  }

  const records = await readReviewStatuses();
  const recordMap = new Map(records.map((record) => [record.taskId, record]));
  const updatedAt = new Date().toISOString();
  for (const taskId of requested) {
    if (reviewStatus === 'pending') recordMap.delete(taskId);
    else recordMap.set(taskId, {
      taskId,
      status: reviewStatus,
      updatedAt,
      ...(['pipeline-sol-readonly-quality', 'pipeline-integrity-originality', 'pipeline-verification-finalize'].includes(source) ? { source } : {}),
    });
  }
  if (reviewStatus === 'qualified') {
    for (const task of selected) {
      const requireV4 = await requiresV4Trajectory(task);
      await buildValidatedTrajectory(task, { requireV4 });
    }
    const pipelineSource = ['pipeline-sol-readonly-quality', 'pipeline-integrity-originality', 'pipeline-verification-finalize'].includes(source);
    if (pipelineSource) {
      // A pipeline delivery must not be blocked by unrelated historical rows.
      // The selected task still goes through the same hard-rule and identity checks.
      const selectedIds = new Set(selected.map((task) => task.id));
      assertQualifiedTasksPassHardRules(selected, selectedIds);
      assertQualifiedIdentitiesUnique(selected, selectedIds);
    } else {
      const qualifiedIds = new Set([...recordMap.values()].filter((record) => record.status === 'qualified').map((record) => record.taskId));
      assertQualifiedTasksPassHardRules(tasks, qualifiedIds);
      assertQualifiedIdentitiesUnique(tasks, qualifiedIds);
    }
  }
  // Re-read immediately before the atomic write.  The pipeline runner can
  // update the same JSON file in another process while validation/building is
  // in progress; writing the original snapshot would silently erase that
  // newer row even though both writers use the file lock.
  await withFileLock(reviewStatusesLockPath, async () => {
    const latestRecords = await readReviewStatuses();
    const latestMap = new Map(latestRecords.map((record) => [record.taskId, record]));
    for (const taskId of requested) {
      if (reviewStatus === 'pending') latestMap.delete(taskId);
      else latestMap.set(taskId, {
        taskId,
        status: reviewStatus,
        updatedAt,
        ...(['pipeline-sol-readonly-quality', 'pipeline-integrity-originality', 'pipeline-verification-finalize'].includes(source) ? { source } : {}),
      });
    }
    await writeReviewStatusesUnlocked([...latestMap.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)));
  });
  invalidateTaskDiscoveryCache();
  return { count: requested.length, reviewStatus, updatedAt };
}

async function readWorkspacePackageEntries(task, { forValidation = false, directoryName = 'workspace' } = {}) {
  const workspaceRoot = path.join(task.taskDir, directoryName);
  const entries = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory = '') {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.name === '.git' || child.name === '.DS_Store') continue;
      if (forValidation && child.isDirectory() && ['node_modules', 'dist'].includes(child.name)) {
        entries.push({ path: `${relativePath}/.forbidden`, content: Buffer.alloc(0), mode: 0o100644 });
        continue;
      }
      if (isExcludedWorkspacePath(relativePath)) continue;
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`workspace 包含符号链接，需先转为普通文件：${relativePath}`);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!child.isFile()) continue;
      const stat = await fsp.stat(absolutePath);
      totalBytes += stat.size;
      if (entries.length >= 20_000) throw new Error('Git 项目文件数量超过 20,000');
      if (totalBytes > 1024 * 1024 * 1024) throw new Error('Git 项目文件总大小超过 1 GB');
      entries.push({ path: relativePath, content: await fsp.readFile(absolutePath), mode: stat.mode });
    }
  }
  await visit(workspaceRoot);
  return entries;
}

function storedPackageFilename(task) {
  const base = String(task.bug_id || task.name || task.id).replace(/[^a-z0-9._-]+/gi, '-');
  return `${base || task.id}.zip`;
}

function storedPackagePath(task) {
  return path.join(packagesRoot, task.id, storedPackageFilename(task));
}

const MAX_PACKAGE_COMMAND_OUTPUT = 2 * 1024 * 1024;

function runCapturedCommand(command, args, { cwd, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutHandle;
    let killHandle;
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length <= MAX_PACKAGE_COMMAND_OUTPUT) return next;
      truncated = true;
      return next.slice(-MAX_PACKAGE_COMMAND_OUTPUT);
    };
    const finish = (exitCode, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      resolve({
        command,
        args,
        exitCode,
        signal,
        error: error?.message || '',
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    let child;
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, null, error);
      return;
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killHandle = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
  });
}

function formatCapturedCommand(result) {
  if (!result) return '(未执行)';
  const command = [result.command, ...result.args].join(' ');
  return [
    `$ ${command}`,
    `exit=${result.exitCode ?? 'none'} signal=${result.signal || 'none'} duration_ms=${result.durationMs} timed_out=${result.timedOut}`,
    result.error ? `error: ${result.error}` : '',
    result.stdout ? `--- stdout ---\n${result.stdout}` : '',
    result.stderr ? `--- stderr ---\n${result.stderr}` : '',
    result.truncated ? '[输出超过限制，仅保留末尾内容]' : '',
  ].filter(Boolean).join('\n');
}

function compactCapturedOutput(result) {
  if (!result) return '';
  return [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').slice(-12_000);
}

async function writePackageEntries(directory, rawEntries) {
  const { entries } = normalizePackageEntries(rawEntries);
  for (const entry of entries) {
    const target = path.join(directory, entry.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.content);
  }
  await fsp.chmod(path.join(directory, 'build_benzhi_docker.sh'), 0o755);
  return entries;
}

async function persistPackageEvidence(task, content) {
  const directory = path.join(packageEvidenceRoot, task.id);
  await fsp.mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `docker-validation-${timestamp}.log`;
  const target = path.join(directory, filename);
  await fsp.writeFile(target, `${content.trim()}\n`, 'utf8');
  return { filename };
}

async function runDockerPackageValidation(task, entries, frontendDir, options = {}) {
  const platforms = ['linux/arm64', 'linux/amd64'];
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-package-'));
  const imageName = `benzhi-verify-${crypto.randomBytes(8).toString('hex')}`;
  const checkedAt = new Date().toISOString();
  let preflight = null;
  const platformResults = [];
  const issues = [];
  let evidenceFilename = '';
  try {
    const normalizedEntries = await writePackageEntries(temporaryDirectory, entries);
    const verificationPlan = createContainerVerificationPlan(normalizedEntries, frontendDir, options);
    preflight = await runCapturedCommand('docker', ['version', '--format', 'client={{.Client.Version}} server={{.Server.Version}} os={{.Server.Os}} arch={{.Server.Arch}}'], {
      cwd: temporaryDirectory,
      timeoutMs: 30_000,
    });
    if (preflight.exitCode !== 0) {
      issues.push('Docker Desktop 未启动或 Docker daemon 不可用，无法完成文档要求的真实镜像构建');
    } else {
      for (const platform of platforms) {
        const platformTag = platform.replace(/^linux\//, '');
        const platformImageName = `${imageName}-${platformTag}`;
        const imageReference = `${platformImageName}:latest`;
        const build = await runCapturedCommand(path.join(temporaryDirectory, 'build_benzhi_docker.sh'), [platformImageName, platform], {
          cwd: temporaryDirectory,
        });
        let verify = null;
        if (build.exitCode !== 0) {
          issues.push(`${platform} Docker 镜像构建失败${build.timedOut ? '（超时）' : ''}`);
        } else {
          verify = await runCapturedCommand('docker', [
            'run', '--rm', '--network', 'none', '--platform', platform,
            imageReference, ...CONTAINER_SHELL_ARGS, verificationPlan.script,
          ], { cwd: temporaryDirectory, timeoutMs: 10 * 60 * 1000 });
          if (verify.exitCode !== 0) {
            issues.push(`${platform} 容器离线验证失败${verify.timedOut ? '（超时）' : ''}；请检查构建、测试或任务元数据中的预期失败计划`);
          }
        }
        const cleanup = await runCapturedCommand('docker', ['image', 'rm', '-f', imageReference], {
          cwd: temporaryDirectory,
          timeoutMs: 60_000,
        });
        platformResults.push({ platform, imageReference, build, verify, cleanup });
      }
    }
  } catch (error) {
    issues.push(`Docker 验证过程异常：${error.message}`);
  } finally {
    const evidence = [
      `task_id=${task.id}`,
      `bug_id=${task.bug_id}`,
      `checked_at=${checkedAt}`,
      `platforms=${platforms.join(',')}`,
      '',
      '=== Docker preflight ===',
      formatCapturedCommand(preflight),
      ...platformResults.flatMap(({ platform, build, verify, cleanup }) => [
        '',
        `=== Docker build (${platform}) ===`,
        formatCapturedCommand(build),
        '',
        `=== Offline container verification (${platform}) ===`,
        formatCapturedCommand(verify),
        '',
        `=== Temporary image cleanup (${platform}) ===`,
        formatCapturedCommand(cleanup),
      ]),
    ].join('\n');
    try {
      const savedEvidence = await persistPackageEvidence(task, evidence);
      evidenceFilename = savedEvidence.filename;
    } catch (error) {
      issues.push(`Docker 验证证据保存失败：${error.message}`);
    }
    await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
  const buildResults = platformResults.map((result) => result.build);
  const verifyResults = platformResults.map((result) => result.verify);
  return {
    ok: issues.length === 0,
    issues,
    dockerVerified: issues.length === 0,
    dockerArchitectureVerified: issues.length === 0 && platformResults.length === platforms.length,
    dockerPlatform: platforms.join(','),
    dockerPlatforms: platforms,
    dockerBuilds: platformResults.map(({ platform, build }) => ({ platform, exitCode: build?.exitCode ?? null, timedOut: Boolean(build?.timedOut) })),
    dockerVerifications: platformResults.map(({ platform, verify }) => ({ platform, exitCode: verify?.exitCode ?? null, timedOut: Boolean(verify?.timedOut) })),
    dockerBuildExitCode: buildResults.length === platforms.length && buildResults.every((result) => result?.exitCode === 0) ? 0 : (buildResults.find((result) => result?.exitCode !== 0)?.exitCode ?? null),
    dockerVerifyExitCode: verifyResults.length === platforms.length && verifyResults.every((result) => result?.exitCode === 0) ? 0 : (verifyResults.find((result) => result && result.exitCode !== 0)?.exitCode ?? null),
    dockerBuildOutput: buildResults.map((result, index) => `=== ${platforms[index]} ===\n${compactCapturedOutput(result)}`).filter(Boolean).join('\n'),
    dockerVerifyOutput: verifyResults.map((result, index) => `=== ${platforms[index]} ===\n${compactCapturedOutput(result)}`).filter(Boolean).join('\n'),
    dockerEvidenceFilename: evidenceFilename,
    dockerCheckedAt: checkedAt,
  };
}

async function persistPackageArchive(task, archive) {
  const target = storedPackagePath(task);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, archive);
  await fsp.rename(temporaryPath, target);
  return storedPackageFilename(task);
}

async function validateTaskPackage(taskId, filename, archive, { source = 'uploaded' } = {}) {
  const task = (await discoverTasks()).find((item) => item.id === taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'passed') throw new Error('Claude 尚未完成该任务，不能打包模型修改后的 workspace');
  if (!filename || path.basename(filename) !== filename || !filename.toLowerCase().endsWith('.zip')) throw new Error('请选择合法的 .zip 项目包');
  if (!archive.length) throw new Error('项目包 ZIP 为空');
  const entries = parseZipEntries(archive, { crc32 });
  const enforcePinnedToolchain = await pathExists(path.join(task.taskDir, '.trajectory-policy-v4'));
  const packageOptions = projectPackageRuleOptions(task);
  const staticValidation = validateGoPackage(entries, { enforcePinnedToolchain, ...packageOptions });
  const workspaceEntries = await readWorkspacePackageEntries(task);
  const workspaceValidation = comparePackageWithWorkspace(entries, workspaceEntries);
  const canRunDocker = staticValidation.ok && workspaceValidation.ok;
  const dockerValidation = canRunDocker
    ? await runDockerPackageValidation(task, entries, staticValidation.frontendDir, packageOptions)
    : { ok: false, issues: [], dockerVerified: false, dockerArchitectureVerified: false, dockerPlatform: 'linux/arm64,linux/amd64', dockerPlatforms: ['linux/arm64', 'linux/amd64'], dockerBuilds: [], dockerVerifications: [], dockerBuildExitCode: null, dockerVerifyExitCode: null, dockerBuildOutput: '', dockerVerifyOutput: '', dockerEvidenceFilename: '', dockerCheckedAt: null };
  const issues = [...staticValidation.issues, ...workspaceValidation.issues, ...dockerValidation.issues];
  const ok = canRunDocker && dockerValidation.ok;
  const storedFilename = ok ? await persistPackageArchive(task, archive) : '';
  const record = {
    taskId: task.id,
    bugId: task.bug_id,
    filename: storedFilename || filename,
    sourceFilename: filename,
    source,
    checkedAt: new Date().toISOString(),
    archiveBytes: archive.length,
    archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'),
    ...staticValidation,
    ...dockerValidation,
    ok,
    issues,
    warnings: ok ? [] : staticValidation.warnings,
    modelWorkspaceVerified: workspaceValidation.ok,
    workspaceCheckedFiles: workspaceValidation.checkedFiles,
    canDownload: ok,
  };
  const records = (await readPackageValidations()).filter((item) => item.taskId !== task.id);
  records.push(record);
  await writePackageValidations(records.sort((a, b) => a.taskId.localeCompare(b.taskId)));
  return record;
}

async function generateTaskPackage(taskId) {
  const task = (await discoverTasks()).find((item) => item.id === taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'passed') throw new Error('Claude 尚未完成该任务，不能生成项目包');
  const workspaceEntries = await readWorkspacePackageEntries(task);
  const supportFiles = createPackageSupportFiles(task, workspaceEntries);
  const root = `${String(task.bug_id || task.name).replace(/[^a-z0-9._-]+/gi, '-')}/`;
  const files = [...workspaceEntries, ...supportFiles].map((entry) => ({
    name: `${root}${entry.path}`,
    content: entry.content,
    mode: entry.mode,
  }));
  const filename = storedPackageFilename(task);
  return validateTaskPackage(task.id, filename, createZip(files), { source: 'generated-from-model-workspace' });
}

async function downloadTaskPackage(taskId, response) {
  const task = (await discoverTasks()).find((item) => item.id === taskId);
  if (!task) return json(response, 404, { message: '任务不存在' });
  if (task.packageStatus !== 'passed' || !task.packageValidation?.canDownload) return json(response, 409, { message: '任务尚未生成通过校验的项目包' });
  const archive = await fsp.readFile(storedPackagePath(task)).catch(() => null);
  if (!archive) return json(response, 404, { message: '项目包文件不存在，请重新生成或上传' });
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${storedPackageFilename(task)}"`,
    'content-length': String(archive.length),
    'cache-control': 'no-store',
  });
  response.end(archive);
}

async function downloadTaskPackageEvidence(taskId, response) {
  const task = (await discoverTasks()).find((item) => item.id === taskId);
  if (!task) return json(response, 404, { message: '任务不存在' });
  const filename = task.packageValidation?.dockerEvidenceFilename || '';
  if (!filename || path.basename(filename) !== filename) return json(response, 404, { message: '该任务尚无 Docker 验证证据' });
  const content = await fsp.readFile(path.join(packageEvidenceRoot, task.id, filename)).catch(() => null);
  if (!content) return json(response, 404, { message: 'Docker 验证证据文件不存在，请重新校验项目包' });
  response.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': String(content.length),
    'cache-control': 'no-store',
  });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/api/pipeline/workers' && request.method === 'GET') {
      return json(response, 200, await publicRemoteWorkerState());
    }
    if (request.url === '/api/pipeline/workers/submission-stats' && request.method === 'GET') {
      try {
        assertRemoteWorkerAuthorized(request);
        normalizeRemoteWorkerIdentity({
          workerId: request.headers['x-go-pipeline-worker-id'],
          role: 'repair-worker',
          protocolVersion: request.headers['x-go-pipeline-worker-protocol'],
        });
        return json(response, 200, await remoteWorkerSubmissionStats());
      } catch (error) {
        return json(response, error.statusCode || 400, { message: error.message });
      }
    }
    if (request.url === '/api/pipeline/workers/register' && request.method === 'POST') {
      try {
        assertRemoteWorkerAuthorized(request);
        const body = await readJson(request);
        const identity = normalizeRemoteWorkerIdentity(body);
        const worker = await recordRemoteWorker(identity, {
          status: 'online',
          hostname: body.hostname,
          platform: body.platform,
          codeVersion: body.codeVersion,
          currentJobId: '',
        });
        return json(response, 200, { protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION, leaseTtlMs: REMOTE_LEASE_TTL_MS, worker });
      } catch (error) {
        return json(response, error.statusCode || 409, { message: error.message });
      }
    }
    if (request.url === '/api/pipeline/workers/claim' && request.method === 'POST') {
      try {
        assertRemoteWorkerAuthorized(request);
        const body = await readJson(request);
        const identity = normalizeRemoteWorkerIdentity(body);
        const assignment = await claimRemoteRepairAssignment(identity, {
          hostname: body.hostname,
          platform: body.platform,
          codeVersion: body.codeVersion,
        });
        return json(response, 200, { protocolVersion: DISTRIBUTED_WORKER_PROTOCOL_VERSION, assignment });
      } catch (error) {
        return json(response, error.statusCode || 409, { message: error.message });
      }
    }
    const remoteHeartbeat = request.url.match(/^\/api\/pipeline\/workers\/jobs\/([^/?]+)\/heartbeat$/);
    if (remoteHeartbeat && request.method === 'POST') {
      try {
        assertRemoteWorkerAuthorized(request);
        const body = await readJson(request);
        const identity = normalizeRemoteWorkerIdentity(body);
        const result = await heartbeatRemoteRepairAssignment(
          decodeURIComponent(remoteHeartbeat[1]), identity, String(body.leaseId || ''), body,
        );
        return json(response, 200, result);
      } catch (error) {
        return json(response, error.statusCode || (error.code === 'REMOTE_LEASE_LOST' ? 409 : 400), { message: error.message, code: error.code || '' });
      }
    }
    const remoteSnapshot = request.url.match(/^\/api\/pipeline\/workers\/jobs\/([^/?]+)\/snapshot$/);
    if (remoteSnapshot && request.method === 'PUT') {
      try {
        assertRemoteWorkerAuthorized(request);
        const body = await readJson(request);
        const identity = normalizeRemoteWorkerIdentity(body);
        const job = await acceptRemoteJobSnapshot(
          decodeURIComponent(remoteSnapshot[1]), identity, String(body.leaseId || ''), body.job,
        );
        return json(response, 200, { accepted: true, updatedAt: job.updatedAt });
      } catch (error) {
        return json(response, error.statusCode || (['REMOTE_LEASE_LOST', 'REMOTE_CANCEL_REQUESTED'].includes(error.code) ? 409 : 400), { message: error.message, code: error.code || '' });
      }
    }
    const remoteComplete = request.url.match(/^\/api\/pipeline\/workers\/jobs\/([^/?]+)\/complete$/);
    if (remoteComplete && request.method === 'POST') {
      try {
        assertRemoteWorkerAuthorized(request);
        const body = await readJson(request);
        const identity = normalizeRemoteWorkerIdentity(body);
        const job = await finishRemoteRepairAssignment(
          decodeURIComponent(remoteComplete[1]), identity, String(body.leaseId || ''), body.job, String(body.outcome || ''),
        );
        return json(response, 200, { accepted: true, status: job.status });
      } catch (error) {
        return json(response, error.statusCode || (error.code === 'REMOTE_LEASE_LOST' ? 409 : 400), { message: error.message, code: error.code || '' });
      }
    }
    const remoteTaskPackage = request.url.match(/^\/api\/pipeline\/workers\/jobs\/([^/?]+)\/tasks\/([^/?]+)\/package$/);
    if (remoteTaskPackage && request.method === 'GET') {
      try {
        assertRemoteWorkerAuthorized(request);
        const identity = normalizeRemoteWorkerIdentity({
          workerId: request.headers['x-go-pipeline-worker-id'],
          role: 'repair-worker',
          protocolVersion: request.headers['x-go-pipeline-worker-protocol'],
        });
        await sendRemoteTaskPackage(
          response,
          decodeURIComponent(remoteTaskPackage[1]),
          decodeURIComponent(remoteTaskPackage[2]),
          identity,
          String(request.headers['x-go-pipeline-lease-id'] || ''),
        );
        return;
      } catch (error) {
        return json(response, error.statusCode || (error.code === 'REMOTE_LEASE_LOST' ? 409 : 400), { message: error.message, code: error.code || '' });
      }
    }
    if (remoteTaskPackage && request.method === 'PUT') {
      try {
        assertRemoteWorkerAuthorized(request);
        const identity = normalizeRemoteWorkerIdentity({
          workerId: request.headers['x-go-pipeline-worker-id'],
          role: 'repair-worker',
          protocolVersion: request.headers['x-go-pipeline-worker-protocol'],
        });
        const result = await importRemoteTaskPackage(
          request,
          decodeURIComponent(remoteTaskPackage[1]),
          decodeURIComponent(remoteTaskPackage[2]),
          identity,
          String(request.headers['x-go-pipeline-lease-id'] || ''),
        );
        return json(response, 200, { imported: true, taskName: result.taskName, bytes: result.bytes });
      } catch (error) {
        return json(response, error.statusCode || (error.code === 'REMOTE_LEASE_LOST' ? 409 : 400), { message: error.message, code: error.code || '' });
      }
    }
    if (request.url === '/api/pipeline/repository/next' && request.method === 'GET') {
      try {
        return json(response, 200, await getSequentialRepositoryStatus());
      } catch (error) {
        return json(response, 503, { connected: false, message: error.message });
      }
    }
    if (request.url === '/api/pipeline/jobs' && request.method === 'GET') {
      const jobs = await listPipelineJobs();
      const occupiedJobIds = pipelineOccupiedJobIds(jobs);
      const rollout = pipelineRolloutDecision(jobs, CURRENT_WORKFLOW_VERSION, pipelineRolloutState);
      const refill = publicPipelineRefillState(await readPipelineRefillState(), jobs);
      const resourcePolicy = currentPipelineResourcePolicy();
      const resourceSlots = await activePipelineResourceSlotSnapshot();
      return json(response, 200, {
        jobs,
        activeJobIds: [...occupiedJobIds],
        activeCount: occupiedJobIds.size,
        activeWeight: pipelineOccupiedWeight(jobs),
        resourcePools: pipelineResourcePoolState(jobs, resourcePolicy.effectiveMaxConcurrency, resourceSlots.counts),
        maxConcurrency: MAX_PIPELINE_CONCURRENCY,
        effectiveMaxConcurrency: resourcePolicy.effectiveMaxConcurrency,
        maxAutoRetries: MAX_PIPELINE_AUTO_RETRIES,
        autoFillEnabled: pipelineAutoFillEnabled,
        controlMode: pipelineControlMode,
        refillPaused: pipelineRefillPaused,
        budget: currentPipelineBudget(jobs),
        resourcePolicy,
        resourceMaintenance: pipelineResourceMaintenanceState,
        distributedWorkers: await publicRemoteWorkerState(),
        performance: pipelinePerformanceSnapshot(jobs, {
          workflowVersion: CURRENT_WORKFLOW_VERSION,
          verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
        }),
        draftCount: jobs.filter((job) => job.status === 'draft').length,
        waitingResourceCount: jobs.filter((job) => job.status === 'waiting_resource').length,
        rollout: {
          mode: rollout.mode,
          canaryJobId: rollout.canaryJobId || '',
          legacyActiveCount: rollout.legacyActiveCount,
          updatedAt: pipelineRolloutState.updatedAt,
        },
        refill,
        submissionQuality: {
          blockedContributors: submissionQualityState.blockedContributors,
          incidentCount: submissionQualityState.incidents.length,
        },
      });
    }
    if (request.url === '/api/system/health' && request.method === 'GET') {
      return json(response, 200, await publicSystemHealth());
    }
    if (request.url === '/api/pipeline/control' && request.method === 'POST') {
      const body = await readJson(request);
      if (!['running', 'paused', 'draining', 'emergency_stopped'].includes(body.mode)) return json(response, 400, { message: '不支持的流水线控制模式' });
      const message = await controlPipelineScheduler(body.mode);
      return json(response, 202, { message, controlMode: pipelineControlMode, autoFillEnabled: pipelineAutoFillEnabled });
    }
    if (request.url === '/api/pipeline/refill/large-canary' && request.method === 'POST') {
      try {
        const body = await readJson(request);
        const largeProjectCanary = await configureLargeProjectCanary(body.count);
        if (pipelineAutoFillEnabled) void fillPipelineSlots();
        return json(response, 202, {
          message: largeProjectCanary.targetCount
            ? `接下来 ${largeProjectCanary.targetCount} 个自动补题项目将使用超大型规格`
            : '超大型自动补题试跑已取消',
          largeProjectCanary,
        });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/pipeline/refill/control' && request.method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      pipelineRefillPaused = body.paused !== false;
      await writePipelineSchedulerState();
      addLog(pipelineRefillPaused ? 'warn' : 'success', pipelineRefillPaused
        ? '已暂停自动补题与新项目规划，现有项目继续由中央调度运行'
        : '已恢复自动补题与新项目规划');
      if (!pipelineRefillPaused) void ensurePipelineRefill();
      return json(response, 202, {
        message: pipelineRefillPaused ? '新项目规划已暂停，现有项目继续运行' : '新项目规划已恢复',
        refillPaused: pipelineRefillPaused,
        autoFillEnabled: pipelineAutoFillEnabled,
        controlMode: pipelineControlMode,
      });
    }
    if (request.url === '/api/system/maintenance/docker' && request.method === 'POST') {
      try {
        const result = await runDockerResourceMaintenance();
        return json(response, 200, { message: 'Docker 缓存清理完成', result });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/pipeline/jobs' && request.method === 'POST') {
      try {
        const job = await createPipelineJob(await readJson(request));
        if (pipelineAutoFillEnabled) void fillPipelineSlots();
        return json(response, 201, { message: `已自动创建 ${job.request.repository} 并加入流水线${pipelineAutoFillEnabled ? '，空闲槽位将自动启动' : '草稿'}`, job });
      } catch (error) {
        return json(response, 400, { message: error.message });
      }
    }
    const pipelineBugAction = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/bugs\/(\d+)\/(start|retry|switch|close)$/);
    if (pipelineBugAction && request.method === 'POST') {
      try {
        const body = await readJson(request).catch(() => ({}));
        const result = await controlPipelineBug(
          decodeURIComponent(pipelineBugAction[1]),
          Number(pipelineBugAction[2]),
          pipelineBugAction[3],
          body,
        );
        return json(response, 202, result);
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    const pipelineBugReset = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/bugs\/(\d+)\/reset$/);
    if (pipelineBugReset && request.method === 'POST') {
      try {
        const result = await resetPipelineBugForRetry(
          decodeURIComponent(pipelineBugReset[1]),
          Number(pipelineBugReset[2]),
        );
        return json(response, 202, result);
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    const pipelineInjectionReview = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/injection-review$/);
    if (pipelineInjectionReview && request.method === 'POST') {
      try {
        const body = await readJson(request).catch(() => ({}));
        const result = await resolvePipelineInjectionReview(
          decodeURIComponent(pipelineInjectionReview[1]),
          body.action,
        );
        return json(response, 202, result);
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    const pipelineBugUserQuery = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/bugs\/(\d+)\/user-query$/);
    if (pipelineBugUserQuery && request.method === 'PATCH') {
      try {
        const body = await readJson(request).catch(() => ({}));
        const result = await reviewPipelineBugUserQuery(
          decodeURIComponent(pipelineBugUserQuery[1]),
          Number(pipelineBugUserQuery[2]),
          body,
        );
        return json(response, 200, result);
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    const pipelineBugWorkbench = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/bug-workbench$/);
    if (pipelineBugWorkbench && request.method === 'PATCH') {
      try {
        const body = await readJson(request).catch(() => ({}));
        const job = await updateBugWorkbench(decodeURIComponent(pipelineBugWorkbench[1]), (current, execution) => {
          if (body.selectedBugIndex !== undefined) {
            const selected = Number(body.selectedBugIndex);
            if (!Number.isInteger(selected) || selected < 1) throw new Error('selectedBugIndex 不合法');
            if (!(current.bugs || []).some((bug) => Number(bug.bugIndex) === selected)) throw new Error(`Bug ${selected} 不存在`);
            execution.selectedBugIndex = selected;
          }
          if (body.autoContinue !== undefined) execution.autoContinue = Boolean(body.autoContinue);
          if (body.workerLimitOverride !== undefined) {
            const workerLimit = Number(body.workerLimitOverride);
            if (body.workerLimitOverride === null || workerLimit === 0) delete current.bugWorkerLimitOverride;
            else {
              if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 4) throw new Error('workerLimitOverride 必须是 1-4 的整数');
              current.bugWorkerLimitOverride = workerLimit;
            }
          }
          execution.lastAction = 'workbench_settings';
        });
        return json(response, 200, { message: 'Bug 工作台设置已保存', job: publicPipelineJob(job) });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    const pipelineBugAttempts = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/bugs\/(\d+)\/attempts$/);
    if (pipelineBugAttempts && request.method === 'GET') {
      const job = await readPipelineJob(decodeURIComponent(pipelineBugAttempts[1]));
      if (!job) return json(response, 404, { message: '流水线作业不存在' });
      const bug = (job.bugs || []).find((item) => Number(item.bugIndex) === Number(pipelineBugAttempts[2]));
      if (!bug) return json(response, 404, { message: 'Bug 不存在' });
      const attempts = (bug.attempts || []).map(({ taskDir, goldDir, ...attempt }) => attempt);
      const failures = attempts.filter((attempt) => attempt?.status === 'failed');
      return json(response, 200, {
        jobId: job.id,
        bugIndex: Number(pipelineBugAttempts[2]),
        attempts,
        firstFailure: bug.firstFailure || failures[0] || null,
        lastFailure: bug.lastFailure || failures.at(-1) || null,
      });
    }
    const pipelineAction = request.url.match(/^\/api\/pipeline\/jobs\/([^/?]+)\/(start|retry|stop)$/);
    if (pipelineAction && request.method === 'POST') {
      const jobId = decodeURIComponent(pipelineAction[1]);
      const action = pipelineAction[2];
      try {
        if (action === 'stop') {
          await stopPipelineJob(jobId, { pauseScheduling: false });
          if (pipelineAutoFillEnabled) void fillPipelineSlots();
          return json(response, 202, { message: '流水线停止请求已发送，其他任务和自动补位继续运行' });
        }
        const resumeWhilePaused = pipelineControlMode === 'paused';
        if (!resumeWhilePaused) await setPipelineAutoFillEnabled(true);
        let requestedJob = await readPipelineJob(jobId);
        if (requestedJob?.manualHold) {
          delete requestedJob.manualHold;
          requestedJob.updatedAt = new Date().toISOString();
          await writePipelineJob(requestedJob);
        }
        if (requestedJob?.status === 'abandoned' && action === 'retry') {
          const replacement = requestedJob.replacementJobId
            ? await readPipelineJob(requestedJob.replacementJobId)
            : null;
          if (replacement && ['queued', 'running', 'waiting_resource'].includes(replacement.status)) {
            throw new Error(`请先停止正在运行的替补项目 ${replacement.id}，再恢复当前项目`);
          }
          const reopened = reopenPipelineAbandonmentForManualRetry(requestedJob);
          requestedJob = reopened.job;
          await writePipelineJob(requestedJob);
        }
        if (requestedJob && Number(requestedJob.verificationPolicyVersion || 0) < CURRENT_VERIFICATION_POLICY_VERSION) {
          requestedJob.legacyAutoRetryEnabled = true;
          requestedJob.updatedAt = new Date().toISOString();
          await writePipelineJob(requestedJob);
        }
        if (requestedJob && action === 'retry') {
          requestedJob.manualRetryRequestedAt = new Date().toISOString();
          requestedJob.retryRequestedAt = requestedJob.manualRetryRequestedAt;
          requestedJob.updatedAt = requestedJob.manualRetryRequestedAt;
          reactivateFailedPipelineBugsForManualRetry(requestedJob, requestedJob.manualRetryRequestedAt);
          await writePipelineJob(requestedJob);
        }
        let job;
        try {
          job = await startPipelineJob(jobId, { externalResume: resumeWhilePaused });
        } catch (error) {
          if (!isRetryablePipelineStartError(error)) throw error;
          const waiting = await readPipelineJob(jobId);
          // A task may already be parked in the central queue after a
          // previous capacity rejection. Treat another manual retry as an
          // idempotent queue request instead of returning a misleading 409.
          const confirmedReviewWait = waiting?.status === 'waiting_review'
            && pipelineUserQueryReadiness(waiting).ready
            && (waiting.stages || [])
              .filter((stage) => stage.stage === 'user_query_review')
              .every((stage) => ['passed', 'skipped'].includes(stage.status));
          if (!waiting || (!['failed', 'stopped', 'waiting_resource'].includes(waiting.status) && !confirmedReviewWait)) throw error;
          const queued = queuePipelineManualRetry(waiting);
          queued.autoRetryCount = 0;
          await writePipelineJob(queued);
          if (!resumeWhilePaused) void fillPipelineSlots();
          return json(response, 202, {
            message: `当前动态容量已满，任务已转为等待中央调度并加入人工重试优先队列`,
            job: publicPipelineJob(queued),
            activeCount: pipelineOccupiedJobIds(await listPipelineJobs()).size,
            maxConcurrency: MAX_PIPELINE_CONCURRENCY,
            autoFillEnabled: pipelineAutoFillEnabled,
          });
        }
        if (!resumeWhilePaused) await fillPipelineSlots();
        const activeCount = pipelineOccupiedJobIds(await listPipelineJobs()).size;
        return json(response, 202, {
          message: `${action === 'retry' ? '流水线已从未通过阶段重试' : '流水线已启动'}，当前 ${activeCount} 个任务，动态容量 ${currentPipelineResourcePolicy().effectiveMaxConcurrency}/${MAX_PIPELINE_CONCURRENCY}`,
          job,
          activeCount,
          maxConcurrency: MAX_PIPELINE_CONCURRENCY,
          autoFillEnabled: pipelineAutoFillEnabled,
        });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/run/status' && request.method === 'GET') {
      // Building the full task index validates hundreds of repositories and
      // can take over a minute. Serve the last complete snapshot immediately
      // while discoverTasks refreshes it in the background.
      const tasks = await discoverTasks({ allowStale: true });
      const pending = tasks.filter((task) => task.status === 'queued' && !task.pipelineManaged);
      const completed = tasks.filter((task) => task.status === 'passed');
      const reviewCounts = Object.fromEntries(['pending', 'qualified', 'unqualified'].map((status) => [status, completed.filter((task) => task.reviewStatus === status).length]));
      const identityConflicts = {
        sessionId: tasks.filter((task) => task.duplicateFields.includes('sessionId')).length,
        bug_id: tasks.filter((task) => task.duplicateFields.includes('bug_id')).length,
      };
      return json(response, 200, { state: publicState(), pendingCount: pending.length, pendingTasks: pending.map(publicTask), tasks: tasks.map(publicTask), reviewCounts, identityConflicts, importPath: tasksRoot, maxConcurrency: 4 });
    }
    if (request.url === '/api/run/events' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      response.write(`data: ${JSON.stringify({ type: 'snapshot', state: publicState() })}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.url === '/api/cloud/status' && request.method === 'GET') {
      return json(response, 200, await cloudPublicState());
    }
    if (request.url === '/api/submission-platform/status' && request.method === 'GET') {
      return json(response, 200, await submissionPlatformPublicState());
    }
    if (request.url === '/api/submission-platform/sync' && request.method === 'POST') {
      try {
        const result = await reconcileSubmissionPlatformReviews();
        return json(response, 200, { message: `已同步 ${result.updated} 条审核变化`, result, ...(await submissionPlatformPublicState()) });
      } catch (error) {
        return json(response, 409, { message: error.message, ...(await submissionPlatformPublicState().catch(() => ({}))) });
      }
    }
    if (request.url === '/api/submission-platform/connect' && request.method === 'POST') {
      const body = await readJson(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return json(response, 400, { message: '请输入提交平台账号和密码' });
      try {
        await connectSubmissionPlatform(username, password);
        await reconcileSubmissionPlatformReviews();
        const resumed = await resumeSubmissionPlatformWaiters();
        return json(response, 200, { message: `提交平台已连接，自动登录已启用${resumed.resumedProjects ? `；已恢复 ${resumed.resumedProjects} 个项目、${resumed.resumedBugs} 个延期 Bug` : ''}`, ...(await submissionPlatformPublicState()) });
      } catch (error) {
        return json(response, 409, { message: error.message, ...(await submissionPlatformPublicState().catch(() => ({}))) });
      }
    }
    if (request.url === '/api/submission-platform/disconnect' && request.method === 'POST') {
      try {
        await setSubmissionPlatformSyncPaused(true, '人工断开质检提交平台');
        await clearSubmissionPlatformSession({ forgetCredentials: true });
        return json(response, 200, { message: '提交平台已断开，钥匙串凭据已删除', ...(await submissionPlatformPublicState()) });
      } catch (error) {
        return json(response, 409, { message: error.message, ...(await submissionPlatformPublicState().catch(() => ({}))) });
      }
    }
    if (request.url === '/api/submission-platform/control' && request.method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const paused = body.paused !== false;
      await setSubmissionPlatformSyncPaused(paused, body.reason || (paused ? '人工暂停质检平台同步' : ''));
      const resumed = !paused && submissionPlatformCookie
        ? await resumeSubmissionPlatformWaiters()
        : { resumedProjects: 0, resumedBugs: 0 };
      return json(response, 200, {
        message: paused
          ? '质检平台同步与自动提交已暂停'
          : `质检平台同步与自动提交已恢复${resumed.resumedBugs ? `；已重新排队 ${resumed.resumedBugs} 个延期 Bug` : ''}`,
        ...(await submissionPlatformPublicState()),
      });
    }
    if (request.url === '/api/submission-platform/submit' && request.method === 'POST') {
      const body = await readJson(request);
      const pipelineJobId = String(body.pipelineJobId || '');
      const bugIndex = Number(body.bugIndex);
      const taskId = String(body.taskId || '');
      if (!pipelineJobId || !Number.isInteger(bugIndex) || bugIndex < 1 || !taskId) {
        return json(response, 400, { message: 'pipelineJobId、bugIndex 和 taskId 必填' });
      }
      const deferred = (reason) => ({
        deferred: true,
        deferredAt: new Date().toISOString(),
        reason: String(reason || '质检提交平台维护中，等待统一补交'),
        pipelineJobId,
        bugIndex,
        taskId,
      });
      if (submissionPlatformSyncPaused) {
        const submission = deferred(submissionPlatformSyncPauseReason);
        return json(response, 202, { message: submission.reason, submission });
      }
      try {
        const submission = await submitPipelineTaskToPlatform(pipelineJobId, bugIndex, taskId, {
          allowLegacyDeliveredBackfill: body.legacyDeliveredBackfill === true,
        });
        return json(response, 200, { message: submission.skipped ? '提交平台记录已存在，已完成幂等确认' : '已提交质检平台', submission });
      } catch (error) {
        if (isSubmissionPlatformUnavailableError(error)) {
          await setSubmissionPlatformSyncPaused(true, error.message);
          const submission = deferred(error.message);
          addLog('warn', `质检平台暂不可用，Bug ${bugIndex} 已延期统一补交：${error.message}`);
          return json(response, 202, { message: submission.reason, submission });
        }
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/submission-platform/resubmit' && request.method === 'POST') {
      const body = await readJson(request);
      const taskId = String(body.taskId || '').trim();
      const submissionId = String(body.submissionId || '').trim();
      if (!taskId || !submissionId) return json(response, 400, { message: 'taskId 和 submissionId 必填' });
      try {
        const submission = await resubmitTaskToPlatform(taskId, submissionId, {
          allowLegacyReadmeOnlyDifficultyOverride: body.allowLegacyReadmeOnlyDifficultyOverride === true,
        });
        return json(response, 200, { message: '已返修并重新提交质检平台', submission });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/cloud/connect' && request.method === 'POST') {
      const body = await readJson(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return json(response, 400, { message: '请输入云盘账号和密码' });
      await connectCloudUpload(username, password);
      void autoUploadCompletedTrajectories();
      void reconcileUploadedPipelineJobs();
      return json(response, 200, { message: '轨迹云盘已连接，自动登录已启用', ...(await cloudPublicState()) });
    }
    if (request.url === '/api/cloud/disconnect' && request.method === 'POST') {
      if (cloudSessionCookie) {
        await fetch(`${cloudUploadBaseUrl}/api/logout`, { method: 'POST', headers: { cookie: cloudSessionCookie } }).catch(() => {});
      }
      await clearCloudSession({ forgetCredentials: true });
      return json(response, 200, { message: '轨迹云盘已断开，钥匙串凭据已删除', ...(await cloudPublicState()) });
    }
    if (request.url === '/api/cloud/upload' && request.method === 'POST') {
      const body = await readJson(request);
      const requested = Array.isArray(body.tasks) ? body.tasks.map(String) : [];
      const pipelineFinalizeIds = new Set();
      const directPipelineTasks = new Map();
      if (body.source === 'pipeline-verification-finalize'
        && body.pipelineJobId
        && Number.isInteger(Number(body.bugIndex))) {
        const pipelineJobId = String(body.pipelineJobId);
        const bugIndex = Number(body.bugIndex);
        const job = await readPipelineJob(pipelineJobId);
        const prefix = `bug${bugIndex}_`;
        const proofStages = (job?.stages || []).filter((stage) => stage.id === `${prefix}pre_verify`
          || stage.id === `${prefix}post_verify`
          || stage.id === `${prefix}red_green`
          || stage.id === `${prefix}docker_validation`
          || stage.id === `${prefix}git_publication`
          || stage.id === `${prefix}cloud_upload`
          || stage.id === `${prefix}verification_finalize`);
        const proofReady = Boolean(job && proofStages.length
          && proofStages.every((stage) => ['passed', 'skipped'].includes(stage.status)
            || (stage.id === `${prefix}verification_finalize` && stage.status === 'running')));
        if (proofReady) {
          // discoverTasks intentionally hides reviewStatus until the task is
          // fully passed. Pipeline finalization runs before delivery_ready, so
          // consult the persisted review record here to avoid a circular
          // dependency between main trajectory upload and task completion.
          const qualifiedReviewIds = new Set((await readReviewStatuses())
            .filter((record) => record.status === 'qualified')
            .map((record) => record.taskId));
          if (requested.length === 1) {
            const task = await loadPipelineReviewTask(job, bugIndex, requested[0]);
            if (requested.includes(task.id) && qualifiedReviewIds.has(task.id)) {
              directPipelineTasks.set(task.id, task);
              pipelineFinalizeIds.add(task.id);
            }
          }
        }
      }
      const availableTasks = pipelineFinalizeIds.size ? [...directPipelineTasks.values()] : await discoverTasks();
      const passedIds = new Set(availableTasks.filter((task) => task.status === 'passed').map((task) => task.id));
      const allowedIds = new Set([...passedIds, ...pipelineFinalizeIds]);
      const taskIds = requested.length ? requested.filter((id) => allowedIds.has(id)) : [...passedIds];
      if (!taskIds.length) return json(response, 400, { message: '没有可上传的校验通过轨迹' });
      const uploaded = [];
      for (const taskId of taskIds) uploaded.push(await uploadTrajectory(taskId, {
        allowPipelineFinalize: pipelineFinalizeIds.has(taskId),
        taskOverride: directPipelineTasks.get(taskId) || null,
      }));
      return json(response, 200, { message: `已处理 ${uploaded.length} 条轨迹`, uploaded, ...(await cloudPublicState()) });
    }
    if (request.url === '/api/cloud/upload-proof' && request.method === 'POST') {
      const body = await readJson(request);
      const taskId = String(body.taskId || '');
      const artifactKind = String(body.artifactKind || '');
      if (!taskId || !['verify_pre', 'verify_post'].includes(artifactKind)) {
        return json(response, 400, { message: 'taskId 和合法的 artifactKind 必填' });
      }
      try {
        const uploaded = await uploadProofTrajectory(taskId, artifactKind);
        return json(response, 200, { message: `${artifactKind} 已上传`, uploaded, ...(await cloudPublicState()) });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/cloud/upload-file' && request.method === 'POST') {
      const encodedFilename = String(request.headers['x-trajectory-filename'] || '');
      let filename;
      try {
        filename = decodeURIComponent(encodedFilename);
      } catch {
        return json(response, 400, { message: 'trajectory 文件名编码不合法' });
      }
      if (!filename || path.basename(filename) !== filename) return json(response, 400, { message: 'trajectory 文件名不合法' });
      const content = await readBuffer(request);
      if (!content.length) return json(response, 400, { message: 'trajectory JSON 文件为空' });
      const uploaded = await uploadTrajectoryFile(filename, content);
      return json(response, 200, { message: `${filename} 已上传并匹配 ${uploaded.bugId}`, uploaded, ...(await cloudPublicState()) });
    }
    if (request.url === '/api/tasks/review' && request.method === 'POST') {
      const body = await readJson(request);
      const taskIds = Array.isArray(body.tasks) ? body.tasks : [];
      try {
        const source = ['pipeline-sol-readonly-quality', 'pipeline-integrity-originality', 'pipeline-verification-finalize'].includes(body.source) ? body.source : 'manual';
        const result = await updateTaskReviews(taskIds, String(body.status || ''), {
          source,
          pipelineJobId: String(body.pipelineJobId || ''),
          bugIndex: body.bugIndex,
        });
        return json(response, 200, { message: `已将 ${result.count} 条轨迹修改为${result.reviewStatus === 'qualified' ? '合格' : result.reviewStatus === 'unqualified' ? '不合格' : '待审核'}`, ...result });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (request.url === '/api/tasks/regenerate' && request.method === 'POST') {
      if (activePipelineProcesses.size) return json(response, 409, { message: '生产流水线正在运行，不能同时重新生成任务轨迹' });
      if (state.status === 'running' || state.status === 'stopping') return json(response, 409, { message: '当前已有任务在运行，请等待完成或先停止运行' });
      const body = await readJson(request);
      try {
        const queue = await prepareTasksForRegeneration(body.tasks, body.feedback, body.feedbackByTask);
        if (!queue.length) return json(response, 409, { message: '没有可重新生成的任务' });
        void runQueue(queue, 4, { autoFill: false });
        return json(response, 202, {
          message: `已归档旧结果并重新生成 ${queue.length} 道轨迹，最多 4 路并发`,
          queue: queue.map(({ id, name, bug_id }) => ({ id, name, bugId: bug_id })),
          concurrency: 4,
        });
      } catch (error) {
        return json(response, 409, { message: error.message });
      }
    }
    if (/^\/api\/tasks\/[^/?]+\/package(?:\/(?:validate|generate|evidence|evidence-image))?$/.test(request.url)) {
      return json(response, 410, { message: '项目 ZIP 流程已停用；请按 Git 提交流程交付' });
    }
    if (request.url === '/api/tasks/export-record' && request.method === 'POST') {
      const body = await readJson(request);
      const requested = [...new Set(Array.isArray(body.tasks) ? body.tasks.map(String) : [])];
      if (!requested.length) return json(response, 400, { message: '请至少提供一道导出任务' });
      if (body.kind !== 'excel') return json(response, 400, { message: '前端导出记录仅支持 Excel 类型' });
      const validationTokens = Array.isArray(body.validationTokens) ? body.validationTokens.map(String) : [];
      const tokenValidated = body.validateOnly !== true
        && excelExportValidationTokens.consume(validationTokens, requested);
      if (!tokenValidated && requested.length > EXCEL_EXPORT_VALIDATION_BATCH_SIZE) {
        return json(response, 413, { message: `单次最多校验 ${EXCEL_EXPORT_VALIDATION_BATCH_SIZE} 道 Excel 记录，请刷新页面后重新导出` });
      }
      const available = new Map((await discoverTasks({ allowStale: true })).map((task) => [task.id, task]));
      if (requested.some((taskId) => !available.has(taskId))) return json(response, 404, { message: '导出记录包含不存在的任务' });
      let validationFailures = [];
      if (!tokenValidated) {
        const validationResults = await Promise.all(requested.map(async (taskId) => {
          const task = available.get(taskId);
          try {
            if (task.status !== 'passed' || task.reviewStatus !== 'qualified' || !/^https:\/\//i.test(task.trajectory || '')) throw new Error(`${task.bug_id} 尚未完成人工确认和云盘回填`);
            await validateTaskExcelVerification(task);
            if (task.ruleIssues?.length) throw new Error(`${task.bug_id} 尚未满足交付规则：${task.ruleIssues.join('；')}`);
            const requireV4 = await requiresV4Trajectory(task);
            await readTrajectoryMetadata(task, { requireV4 });
            requireDockerHarness(task.harness, task.bug_id);
            return null;
          } catch (error) {
            return { taskId, bugId: task.bug_id, message: error.message };
          }
        }));
        validationFailures = validationResults.filter(Boolean);
        if (validationFailures.length && body.allowPartial !== true) {
          throw new Error(validationFailures[0].message);
        }
      }
      if (body.validateOnly === true) {
        const failedIds = new Set(validationFailures.map((failure) => failure.taskId));
        const validated = requested.filter((taskId) => !failedIds.has(taskId));
        if (!validated.length && body.allowPartial !== true) return json(response, 422, { message: validationFailures[0]?.message || '没有通过校验的 Excel 记录', failures: validationFailures });
        const validationToken = validated.length ? excelExportValidationTokens.issue(validated) : '';
        return json(response, 200, {
          message: `已校验 ${validated.length} 道任务，可生成 Excel`,
          validated: validated.length,
          validationToken,
          failures: validationFailures,
        });
      }
      const records = await recordTaskExports(requested, 'excel');
      return json(response, 200, { message: `已记录 ${records.length} 道任务的 Excel 导出`, records });
    }
    const trajectoryMatch = request.url.match(/^\/api\/tasks\/([^/?]+)\/trajectory$/);
    if (trajectoryMatch && request.method === 'GET') {
      const taskId = decodeURIComponent(trajectoryMatch[1]);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(taskId)) return json(response, 400, { message: '任务名称不合法' });
      const task = (await discoverTasks()).find((item) => item.id === taskId);
      if (!task) return json(response, 404, { message: '任务不存在' });
      if (task.status !== 'passed') return json(response, 409, { message: '任务尚未生成可导出的完整轨迹' });
      const trajectory = await buildValidatedTrajectory(task, { requireV4: true });
      await recordTaskExports([task.id], 'trajectory');
      return trajectoryDownload(response, trajectory);
    }
    if (request.url === '/api/trajectories/export' && request.method === 'POST') {
      if (bulkTrajectoryExportRunning) return json(response, 409, { message: '已有轨迹 ZIP 正在生成，请等待当前导出完成' });
      const body = await readJson(request);
      const requested = [...new Set(Array.isArray(body.tasks) ? body.tasks.map(String) : [])];
      if (!requested.length) return json(response, 400, { message: '请至少选择一道已通过任务' });
      bulkTrajectoryExportRunning = true;
      try {
        const available = new Map((await discoverTasks()).filter((task) => task.status === 'passed').map((task) => [task.id, task]));
        const selected = requested.map((id) => available.get(id)).filter(Boolean);
        if (selected.length !== requested.length) return json(response, 409, { message: '选择中包含不存在或尚未完成的任务' });
        const files = [];
        for (const task of selected) {
          const trajectory = await buildValidatedTrajectory(task, { requireV4: true });
          files.push({ name: trajectory.filename, content: trajectory.content });
        }
        await recordTaskExports(selected.map((task) => task.id), 'trajectory');
        return zipDownload(response, createZip(files));
      } finally {
        bulkTrajectoryExportRunning = false;
      }
    }
    if (request.url === '/api/packages/export') {
      return json(response, 410, { message: '项目 ZIP 导出已停用；请按 Git 提交流程交付' });
    }
    if (request.url === '/api/run/start' && request.method === 'POST') {
      if (pipelineOccupiedJobIds(await listPipelineJobs()).size) return json(response, 409, { message: '生产流水线正在运行，不能同时启动任务队列' });
      if (state.status === 'running' || state.status === 'stopping') return json(response, 409, { message: '当前已有任务在运行' });
      const body = await readJson(request);
      const concurrency = 4;
      const requested = [...new Set(Array.isArray(body.tasks) ? body.tasks.map(String) : [])];
      const pending = await discoverPendingTasks();
      const requestedSet = new Set(requested);
      const queue = requested.length ? pending.filter((task) => requestedSet.has(task.id)) : pending;
      if (!queue.length) return json(response, 409, { message: '没有待运行任务，请先将题目导入任务库' });
      void runQueue(queue, concurrency);
      return json(response, 202, { message: `已启动 ${queue.length} 道已导入任务，最多 ${concurrency} 路并发`, queue: queue.map(({ id, name, bug_id }) => ({ id, name, bugId: bug_id })), concurrency });
    }
    if (request.url === '/api/run/stop' && request.method === 'POST') {
      if (!activeProcesses.size || state.status !== 'running') return json(response, 409, { message: '当前没有正在运行的 CLI 任务' });
      state.status = 'stopping';
      state.message = '正在停止所有 Claude Code CLI';
      addLog('warn', `收到停止请求，正在结束 ${activeProcesses.size} 个 CLI 进程`);
      for (const child of activeProcesses.values()) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      broadcast();
      return json(response, 202, { message: '停止请求已发送' });
    }
    return json(response, 404, { message: 'Not found' });
  } catch (error) {
    addLog('error', error.stack || error.message);
    return json(response, 500, { message: error.message });
  }
});

async function restoreRuntimeAfterRestart() {
  // Adopt live project runners before slower cloud/datastore reconciliation.
  // The HTTP listener is already accepting requests at this point, so delaying
  // adoption would briefly expose active jobs as idle after every API restart.
  await adoptPipelineRunnerProcesses();
  submissionQualityState = await readSubmissionQualityState();
  await restorePipelineHealthState();
  const watchdogRecovery = recoverInterruptedPipelineTriages(await readPipelineWatchdogState());
  if (watchdogRecovery.recoveredCount) {
    await writePipelineWatchdogState(watchdogRecovery.state);
    addLog('warn', `服务重启后重新排队 ${watchdogRecovery.recoveredCount} 个未完成的 Codex 只读分诊`);
  }
  try {
    await restoreCloudSession();
  } catch (error) {
    if (error.code !== 'ENOENT') addLog('warn', error.message);
  }
  try {
    await restoreSubmissionPlatformControl();
    await restoreSubmissionPlatformSession();
    if (!submissionPlatformSyncPaused) {
      await reconcileSubmissionPlatformReviews();
      await resumeSubmissionPlatformWaiters();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') addLog('warn', `提交平台会话恢复失败：${error.message}`);
  }
  await upgradePersistedPipelineBugQuotas();
  await upgradePersistedSubmissionPlatformStages();
  await reconcileUploadedPipelineJobs();
  void autoUploadCompletedTrajectories();
  const scheduler = await readPipelineSchedulerState();
  pipelineControlMode = normalizePipelineControlMode(scheduler.controlMode, scheduler.autoFillEnabled !== false);
  pipelineAutoFillEnabled = pipelineControlMode === 'running';
  pipelineRefillPaused = scheduler.refillPaused === true;
  pipelineRolloutState = normalizePipelineRolloutState(scheduler.rollout);
  pipelineRateLimitCooldownUntil = Math.max(0, Number(scheduler.rateLimitCooldownUntil || 0));
  pipelineResourceMaintenanceState = scheduler.resourceMaintenance && typeof scheduler.resourceMaintenance === 'object'
    ? { ...pipelineResourceMaintenanceState, ...scheduler.resourceMaintenance }
    : pipelineResourceMaintenanceState;
  if (pipelineResourceMaintenanceState.status === 'running') {
    pipelineResourceMaintenanceState = {
      ...pipelineResourceMaintenanceState,
      status: 'pending',
      startedAt: null,
      reason: '服务重启前 Docker 维护未完成，重新进入安全排空',
    };
  }
  if (pipelineResourceMaintenanceState.status === 'idle' && pipelineResourceMaintenanceState.finishedAt) {
    pipelineLastResourceMaintenanceAt = pipelineResourceMaintenanceState.finishedAt;
  }
  const datastoreHealthy = await checkDatastoreIntegrity();
  if (!scheduler.rollout) {
    pipelineRolloutState.updatedAt = new Date().toISOString();
    await writePipelineSchedulerState();
    addLog('info', '已启用排空切换：旧流程全部退出后只运行一个 V2 canary');
  }
  await adoptPipelineRunnerProcesses();
  await reapOrphanedPipelineProcesses();
  const jobs = await listPipelineJobs();
  const occupied = pipelineOccupiedJobIds(jobs);
  const currentWorkflowOccupied = jobs.filter((job) => occupied.has(job.id) && Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION);
  if (currentWorkflowOccupied.length) {
    addLog('info', `服务重启后检测到 ${currentWorkflowOccupied.length} 条 V2 未结束作业，保持控制模式 ${pipelineControlMode}`);
  } else if (pipelineAutoFillEnabled) {
    addLog('info', '服务重启后恢复生产流水线闭环调度');
  }
  await runSystemHealthChecks();
  if (pipelineAutoFillEnabled && datastoreHealthy) void fillPipelineSlots();
  else if (pipelineControlMode === 'paused' && datastoreHealthy) {
    await resumePausedManualBugQueues('服务恢复后继续人工 Bug');
  }
  void runPipelineWatchdog();
}

async function upgradePersistedPipelineBugQuotas() {
  const visibleJobs = await listPipelineJobsFresh();
  let upgraded = 0;
  let skippedLive = 0;
  for (const visibleJob of visibleJobs) {
    const job = await readPipelineJob(visibleJob.id);
    if (!job || processIsAlive(Number(job.runnerPid))) {
      if (job && processIsAlive(Number(job.runnerPid))) skippedLive += 1;
      continue;
    }
    const result = upgradeUnfinishedPipelineBugQuota(job);
    if (!result.changed) continue;
    const at = new Date().toISOString();
    result.job.updatedAt = at;
    result.job.logs = [...(result.job.logs || []), {
      at,
      level: 'info',
      stageId: result.job.currentStage,
      message: `服务恢复时将项目 Bug 配额从 ${result.previousBugCount} 补齐为 ${result.bugCount}，新增槽位：${result.addedBugSlots.join(', ')}`,
    }].slice(-300);
    await writePipelineJob(result.job);
    upgraded += 1;
  }
  if (upgraded || skippedLive) {
    addLog('info', `服务恢复完成 Bug 配额迁移：已补齐 ${upgraded} 个未完成项目${skippedLive ? `，${skippedLive} 个正在运行的项目留待下次重启` : ''}`);
  }
}

let submissionPlatformStageMigrationRunning = false;

async function upgradePersistedSubmissionPlatformStages() {
  if (submissionPlatformStageMigrationRunning) return;
  submissionPlatformStageMigrationRunning = true;
  try {
    const visibleJobs = await listPipelineJobsFresh();
    let upgraded = 0;
    for (const visibleJob of visibleJobs) {
      const job = await readPipelineJob(visibleJob.id);
      if (!job || ['passed', 'abandoned'].includes(String(job.status || ''))) continue;
      const result = upgradeSubmissionPlatformStageLayout(job);
      if (!result.changed) continue;
      const at = new Date().toISOString();
      result.job.updatedAt = at;
      result.job.logs = [...(result.job.logs || []), {
        at,
        level: 'info',
        stageId: result.job.currentStage || 'pipeline_resume',
        message: `恢复提交平台阶段布局：补齐 ${result.addedStageIds.length} 个自动导入节点并保留现有进度`,
      }].slice(-300);
      await writePipelineJob(result.job);
      upgraded += 1;
    }
    if (upgraded) addLog('info', `服务恢复提交平台阶段布局：已修复 ${upgraded} 个在途项目`);
  } finally {
    submissionPlatformStageMigrationRunning = false;
  }
}

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Go task monitor API 已在 ${apiHost}:${port} 运行，当前实例退出`);
    process.exitCode = 0;
    return;
  }
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

server.listen(port, apiHost, () => {
  console.log(`Go task monitor API listening on http://${apiHost}:${port} (${pipelineNodeRole})`);
  if (startupRecoveryEnabled) {
    void startDatastoreWatcher();
    void restoreRuntimeAfterRestart().catch((error) => addLog('warn', `恢复系统运行状态失败：${error.message}`));
  }
});

setInterval(() => { void autoUploadCompletedTrajectories(); }, 30_000).unref();
setInterval(() => { void autoConfirmStaleUserQueryReviews(); }, 30_000).unref();
setInterval(() => { void autoResolveStaleInjectionReviews(); }, 30_000).unref();
setInterval(() => { void reconcileUploadedPipelineJobs(); }, 30_000).unref();
setInterval(() => {
  void upgradePersistedSubmissionPlatformStages()
    .catch((error) => addLog('warn', `恢复提交平台阶段布局失败：${error.message}`));
}, 30_000).unref();
setInterval(() => { void fillPipelineSlots(); }, 30_000).unref();
setInterval(() => {
  void resumePausedManualBugQueues('检测到外部加入的人工返修队列')
    .catch((error) => addLog('warn', `人工返修续跑扫描失败：${error.message}`));
}, 30_000).unref();
setInterval(() => { void ensurePipelineRefill(); }, 30_000).unref();
setInterval(() => { void runPipelineWatchdog(); }, PIPELINE_WATCHDOG_INTERVAL_MS).unref();
setInterval(() => { void runSystemHealthChecks(); }, PIPELINE_HEALTH_INTERVAL_MS).unref();
setInterval(() => { void enforceDockerGraderCpuLimit(); }, 5_000).unref();
setInterval(() => { void reconcileAdoptedPipelineProcesses(); }, 30_000).unref();
setInterval(() => { void reapOrphanedPipelineProcesses(); }, 30_000).unref();
setInterval(() => { void checkDatastoreIntegrity(); }, 60_000).unref();
setInterval(() => {
  void maintainCloudSession().catch((error) => addLog('warn', `云盘自动恢复暂未成功：${error.message}`));
}, 60_000).unref();
setInterval(() => {
  if (submissionPlatformSyncPaused) return;
  void (async () => {
    await reconcileSubmissionPlatformReviews();
    await resumeSubmissionPlatformWaiters();
  })()
    .catch((error) => addLog('warn', `提交平台审核状态同步失败：${error.message}`));
}, 60_000).unref();
