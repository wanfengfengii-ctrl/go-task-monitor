#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeBugExecution } from '../src/bug-workbench.js';
import { pipelineStageResourceProfile } from '../src/pipeline-operations.js';
import {
  createPipelineStages,
  CURRENT_BUG_POLICY_VERSION,
  CURRENT_VERIFICATION_POLICY_VERSION,
  CURRENT_WORKFLOW_POLICY_VERSION,
  CURRENT_WORKFLOW_VERSION,
} from '../src/pipeline-rules.js';

const exec = promisify(execFile);
const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function recoveryPromptDocument(userQuery) {
  return `${String(userQuery || '').trim()}\n`;
}

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

async function git(args, cwd = monitorRoot) {
  const result = await exec('git', args, {
    cwd,
    timeout: 10 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return String(result.stdout || '').trim();
}

async function copyWithoutGit(source, destination) {
  await fsp.cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (entry) => path.basename(entry) !== '.git',
  });
}

function managedTaskId(taskName) {
  return `task-${crypto.createHash('sha256').update(`go-task-library/${taskName}`).digest('hex').slice(0, 16)}`;
}

function commandTestName(command) {
  return String(command || '').match(/\^?(TestModel_[A-Za-z0-9_]+)\$?/)?.[1] || '';
}

function rootCauseContext(rootCause) {
  const text = String(rootCause || '').trim();
  const prefix = text.split('根本原因是')[0] || '';
  const files = [...new Set(prefix.match(/[A-Za-z0-9_./-]+\.go/g) || [])];
  const symbolText = prefix.replace(/^[\s\S]*?中的\s*/, '').trim();
  const symbols = symbolText ? [symbolText.split(/\s+根本原因/)[0].trim()] : [];
  const failureMechanism = text.includes('根本原因是') ? text.split('根本原因是').slice(1).join('根本原因是').trim() : text;
  return { files, symbols: symbols.filter(Boolean), failureMechanism };
}

function completedStage(stage, status, at, reason = '') {
  return {
    ...stage,
    status,
    startedAt: at,
    finishedAt: at,
    error: '',
    ...(reason ? { reason } : {}),
  };
}

export function buildRecoveryState({
  record,
  libraryRoot,
  mainCommit,
  testFile,
  testName,
  testSha256,
  createdAt,
}) {
  const bugIndex = Number(record.bug_index);
  const bugCount = Math.max(10, bugIndex);
  const jobId = String(record.pipeline_job_id || record.pipelineJobId || '');
  const jobDir = path.join(libraryRoot, 'pipeline-jobs', jobId);
  const taskDir = path.join(libraryRoot, 'tasks', record.name);
  const projectDir = path.join(jobDir, 'project');
  const verificationDir = path.join(taskDir, `verification-test-bug${bugIndex}-quality-recovery`);
  const verificationCommand = Array.isArray(record.verify_cmds)
    ? String(record.verify_cmds[0] || '')
    : String(record.verify_cmds || '');
  const context = rootCauseContext(record.gold_root_cause);
  const stages = createPipelineStages(
    bugCount,
    CURRENT_WORKFLOW_VERSION,
    CURRENT_VERIFICATION_POLICY_VERSION,
    'diagnosis',
    CURRENT_WORKFLOW_POLICY_VERSION,
    0,
  ).map((stage) => completedStage(stage, 'skipped', createdAt, '历史归档返修不重跑无关阶段'));

  const pass = (stageId) => {
    const stage = stages.find((item) => item.id === stageId);
    if (stage) Object.assign(stage, completedStage(stage, 'passed', createdAt));
  };
  for (const stageId of ['project_plan', 'project_generate', 'project_validate', 'main_freeze', 'main_publish']) pass(stageId);
  for (const suffix of ['bug_discovery', 'bug_source_prepare', 'user_query_review', 'task_prepare', 'test_author']) {
    pass(`bug${bugIndex}_${suffix}`);
  }
  for (const suffix of ['claude_fix', 'trajectory_validate', 'pre_verify', 'cloud_upload', 'verification_finalize', 'delivery_ready']) {
    const stage = stages.find((item) => item.id === `bug${bugIndex}_${suffix}`);
    if (!stage) continue;
    stage.status = 'pending';
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.error = '';
    delete stage.reason;
  }

  const placeholders = Array.from({ length: bugCount }, (_, offset) => offset + 1)
    .filter((index) => index !== bugIndex)
    .map((index) => ({
      bugIndex: index,
      disposition: 'skipped',
      failureDisposition: 'historical_recovery_placeholder',
      trajectorySkipReason: '历史单题返修不包含此 Bug',
      attempts: [],
      workerExecution: {
        status: 'fast_lane_completed',
        currentStage: '',
        currentAttempt: 0,
        updatedAt: createdAt,
        blockedReason: '',
      },
    }));
  const authored = {
    testFile,
    testPackage: `./${path.dirname(testFile)}`.replace('/.', ''),
    testName,
    command: verificationCommand,
    sessionId: record.verification_evidence?.pre_fix?.session_id || record.sessionId,
    sourceDir: verificationDir,
    sha256: testSha256,
    redExitCode: 1,
    greenExitCode: null,
    authoredBy: 'historical_repository_test_recovered',
    diagnosisSessionId: record.sessionId || '',
    frozenAt: createdAt,
  };
  const discovery = {
    found: true,
    bug_id: record.bug_id,
    title: record.title,
    task_type: 'diagnosis',
    task_subtype: '报错原因分析',
    bug_category: record.bug_category || 'other',
    user_query: record.user_query,
    success_criteria: record.success_criteria,
    reproduction_command: verificationCommand,
    target_files: context.files,
    symbols: context.symbols,
    failure_mechanism: context.failureMechanism,
    reason: '外部质检退回后按当前只读 Diagnosis 规则恢复',
  };
  const task = {
    taskName: record.name,
    taskDir,
    bugId: record.bug_id,
    taskType: 'diagnosis',
  };
  const recoveredBug = {
    bugIndex,
    discovery,
    userQueryDraft: record.user_query,
    userQueryConfirmedAt: createdAt,
    bugSource: 'natural',
    attempts: [],
    bugBaseDir: projectDir,
    diagnosisSourceCommit: mainCommit,
    bugBaseCommit: record.red_commit,
    redBranch: record.red_branch,
    redCommit: record.red_commit,
    task,
    verificationTestAuthor: authored,
    qualityRejectionHistory: [{
      rejectedAt: createdAt,
      reason: '外部质检退回：旧 Diagnosis 主轨迹存在源码写入',
      previousSessionId: record.sessionId || null,
      previousTrajectory: record.trajectory || null,
    }],
    workerExecution: {
      status: 'fast_lane_queued',
      currentStage: `bug${bugIndex}_claude_fix`,
      resourceStage: `bug${bugIndex}_claude_fix`,
      currentAttempt: 0,
      startedAt: null,
      updatedAt: createdAt,
      blockedReason: '等待中央调度重跑历史质检退回数据',
      lastAction: 'historical_quality_recovery',
    },
  };
  const profile = pipelineStageResourceProfile(`bug${bugIndex}_claude_fix`);
  const job = {
    id: jobId,
    workflowVersion: CURRENT_WORKFLOW_VERSION,
    workflowPolicyVersion: CURRENT_WORKFLOW_POLICY_VERSION,
    verificationPolicyVersion: CURRENT_VERIFICATION_POLICY_VERSION,
    submissionPlatformPolicyVersion: 0,
    verificationCoveragePolicyVersion: 0,
    projectQualityPolicyVersion: 3,
    projectPackagePolicyVersion: 2,
    status: 'waiting_resource',
    createdAt: record.finishedAt || createdAt,
    updatedAt: createdAt,
    startedAt: record.finishedAt || createdAt,
    finishedAt: null,
    currentStage: `bug${bugIndex}_claude_fix`,
    request: {
      projectBrief: '历史归档 Diagnosis 质检返修',
      repository: record.repository,
      cloneUrl: record.repository,
      bugCount,
      maxTrajectoryAttempts: 3,
      taskType: 'diagnosis',
      taskSubtype: '报错原因分析',
      bugCategory: record.bug_category || 'other',
      projectTier: 'standard',
      frontendRequired: false,
      contributorId: 'codex-auto-refill',
      creator: 'codex-auto-refill',
      bugPolicyVersion: CURRENT_BUG_POLICY_VERSION,
    },
    jobDir,
    tasksRoot: path.join(libraryRoot, 'tasks'),
    mainCommit,
    project: {
      project_slug: record.name.split(`-bug${bugIndex}`)[0] || record.name,
      project_type: 'web',
      project_summary: '历史归档 Diagnosis 质检返修项目。',
      overview: '恢复旧轨迹并按当前只读规则重新采集。',
      components: [],
      acceptance: [],
      quality: { projectTier: 'standard', bugQuota: bugCount, productionGoFiles: 20, productionCodeLines: 2000 },
    },
    generation: {
      provider: record.project_generation_provider || 'deepseek',
      model: record.generator_model || '',
      sessionId: '',
    },
    stages,
    bugs: [...placeholders, recoveredBug].sort((left, right) => left.bugIndex - right.bugIndex),
    bugExecution: normalizeBugExecution({
      selectedBugIndex: bugIndex,
      autoContinue: true,
      status: 'fast_lane_queued',
      currentStage: `bug${bugIndex}_claude_fix`,
      resourceStage: `bug${bugIndex}_claude_fix`,
      currentAttempt: 0,
      startedAt: null,
      updatedAt: createdAt,
      blockedReason: '等待中央调度重跑历史质检退回数据',
      lastAction: 'historical_quality_recovery',
    }),
    repositoryDisposition: 'partial',
    waitingResource: {
      stageId: `bug${bugIndex}_claude_fix`,
      pool: profile.pool || 'compute-repair',
      limit: profile.limit || null,
      queuedAt: createdAt,
      reason: 'historical_quality_recovery',
    },
    logs: [{
      at: createdAt,
      level: 'warn',
      stageId: `bug${bugIndex}_claude_fix`,
      message: `从历史归档恢复 ${record.bug_id}，按当前只读 Diagnosis 规则重新生成主轨迹与红测证明`,
    }],
    error: '',
    autoRetryCount: 0,
    recovery: {
      type: 'archived_diagnosis_quality_rejection',
      taskId: record.id,
      previousSessionId: record.sessionId || null,
      previousTrajectory: record.trajectory || null,
      restoredAt: createdAt,
    },
  };

  const metadata = {
    sample_id: record.name,
    bug_id: record.bug_id,
    title: record.title,
    task_type: 'diagnosis',
    task_subtype: '报错原因分析',
    bug_category: record.bug_category || 'other',
    language: 'Go',
    workflow_version: CURRENT_WORKFLOW_VERSION,
    workflow_policy_version: CURRENT_WORKFLOW_POLICY_VERSION,
    verification_policy_version: CURRENT_VERIFICATION_POLICY_VERSION,
    verification_coverage_policy_version: 0,
    pipeline_job_id: jobId,
    project_tier: 'standard',
    contributor_id: 'codex-auto-refill',
    bug_policy_version: CURRENT_BUG_POLICY_VERSION,
    production_flow: 'historical_archived_diagnosis_quality_recovery',
    project_origin: record.project_origin || 'generated_0to1',
    project_generation_provider: record.project_generation_provider || 'deepseek',
    bug_source: 'natural',
    bug_source_private_to_pipeline: true,
    bug_index: bugIndex,
    trajectory_count: 1,
    repository: record.repository,
    clone_url: record.repository,
    main_branch: record.main_branch || 'main',
    main_commit: mainCommit,
    main_pushed: true,
    bug_base_branch: '',
    bug_base_commit: record.red_commit,
    bug_base_root: true,
    bug_base_source_commit: mainCommit,
    red_branch: record.red_branch,
    red_commit: record.red_commit,
    red_pushed: true,
    model_input_snapshot: 'single-branch-single-commit-no-tests',
    bug_base_pushed: false,
    main_unchanged: true,
    test_model_fix_branch: record.red_branch,
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: record.red_commit,
    validation_policy_version: 4,
    trajectory_exporter_version: 'v4.0.0',
    go_version: record.go_version || 'go1.25.6',
    go_mod_version: record.go_mod_version || '',
    repro_determinism: record.repro_determinism || 'deterministic',
    workspace: 'workspace',
    user_query_file: 'PROMPT.md',
    user_query: record.user_query,
    verify_cmds: [],
    verification_test_overlay: 'none',
    verification_test_files: [],
    verification_test_names: [],
    verification_test_manifest: [],
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: false,
    diagnosis_workspace_check_status: 'pending',
    verification_test_storage: 'system-fixture-only',
    success_criteria: record.success_criteria,
    gold_root_cause: record.gold_root_cause,
    verification_evidence: {},
    gold_verification_summary: '',
    harness: 'backend=docker-target; isolation=independent-workspace-without-.git + system-side-public-model-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=claude; go=go1.25.6; public_target_runs=pending',
    generator_model: record.generator_model || '',
    创建人: 'codex-auto-refill',
  };
  const graderContext = {
    policy_version: CURRENT_WORKFLOW_POLICY_VERSION,
    task_type: 'diagnosis',
    gold_files: context.files,
    gold_symbols: context.symbols,
    mechanism_keywords: [],
    failure_mechanism: context.failureMechanism,
    concurrency: false,
    gold_test_package: '',
    gold_test_name: '',
    gold_test_namespace: '',
    public_reproduction_command: '',
  };
  return { job, metadata, graderContext, authored, taskDir, jobDir, projectDir, verificationDir };
}

async function inspectRepository(record, temporaryRoot) {
  const repositoryDir = path.join(temporaryRoot, 'repository');
  await git(['clone', '--quiet', '--no-checkout', record.repository, repositoryDir]);
  await git(['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'], repositoryDir);
  const mainBranch = record.main_branch || 'main';
  const mainCommit = await git(['rev-parse', `refs/remotes/origin/${mainBranch}`], repositoryDir);
  const remoteRedCommit = await git(['rev-parse', `refs/remotes/origin/${record.red_branch}`], repositoryDir);
  if (remoteRedCommit !== record.red_commit) {
    throw new Error(`${record.bug_id} 远端 ${record.red_branch} 已变化：${remoteRedCommit} != ${record.red_commit}`);
  }
  const changes = (await git(['diff', '--name-status', mainCommit, record.red_commit], repositoryDir))
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...parts] = line.split('\t');
      return { status, file: parts.at(-1) || '' };
    });
  const verificationCommand = Array.isArray(record.verify_cmds) ? record.verify_cmds[0] : record.verify_cmds;
  const testName = commandTestName(verificationCommand);
  const testChanges = changes.filter((entry) => entry.status === 'A' && entry.file.endsWith('_test.go'));
  if (changes.length !== 1 || testChanges.length !== 1) {
    throw new Error(`${record.bug_id} 历史 red 分支必须仅新增一个公开回归测试，实际：${JSON.stringify(changes)}`);
  }
  const testFile = testChanges[0].file;
  const testSource = await git(['show', `${record.red_commit}:${testFile}`], repositoryDir);
  const names = [...testSource.matchAll(/\bfunc\s+(TestModel_[A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
  if (!testName || names.length !== 1 || names[0] !== testName) {
    throw new Error(`${record.bug_id} verify_cmds 与历史回归测试不一致：${testName || '未解析'} / ${names.join('、') || '无 TestModel_'}`);
  }
  return {
    repositoryDir,
    mainCommit,
    testFile,
    testName,
    testSource,
    testSha256: crypto.createHash('sha256').update(testSource).digest('hex'),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const bugId = String(args.find((value) => value.startsWith('--bug-id=')) || '').slice('--bug-id='.length);
  const rootArgument = String(args.find((value) => value.startsWith('--library-root=')) || '').slice('--library-root='.length);
  if (!bugId) throw new Error('用法：node scripts/restore-archived-diagnosis-rejection.mjs [--apply] --bug-id=nyh-go-XXXX-bug-YY [--library-root=PATH]');
  const libraryRoot = path.resolve(rootArgument || path.join(monitorRoot, '..', '.task_work/go-task-library'));
  const archivePath = path.join(libraryRoot, 'validation', 'archived_tasks.json');
  const archive = await readJson(archivePath);
  const rows = Array.isArray(archive) ? archive : archive.tasks || archive.archivedTasks || [];
  const record = rows.find((item) => item.bug_id === bugId);
  if (!record) throw new Error(`历史归档中找不到 ${bugId}`);
  if (record.task_type !== 'diagnosis') throw new Error(`${bugId} 不是 diagnosis 任务`);
  if (!record.name || !record.pipeline_job_id || !record.red_branch || !/^[a-f0-9]{40}$/i.test(record.red_commit || '')) {
    throw new Error(`${bugId} 历史 Git/任务元数据不完整`);
  }
  if (record.id !== managedTaskId(record.name)) throw new Error(`${bugId} 历史 task id 与任务名不匹配`);

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'archived-diagnosis-recovery-'));
  let stagedTask = '';
  let stagedJob = '';
  let taskInstalled = false;
  try {
    const repository = await inspectRepository(record, temporaryRoot);
    const createdAt = new Date().toISOString();
    const state = buildRecoveryState({
      record,
      libraryRoot,
      mainCommit: repository.mainCommit,
      testFile: repository.testFile,
      testName: repository.testName,
      testSha256: repository.testSha256,
      createdAt,
    });
    const preview = {
      apply,
      bugId,
      jobId: state.job.id,
      taskId: record.id,
      mainCommit: repository.mainCommit,
      previousRedCommit: record.red_commit,
      testFile: repository.testFile,
      testName: repository.testName,
      nextStage: state.job.currentStage,
      queuePool: state.job.waitingResource.pool,
    };
    if (!apply) {
      process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      return;
    }
    const existingJob = await readJson(path.join(state.jobDir, 'job.json')).catch(() => null);
    const existingTask = await readJson(path.join(state.taskDir, 'recovery.json')).catch(() => null);
    if (existingJob?.recovery?.type === state.job.recovery.type && existingTask?.bugId === bugId) {
      process.stdout.write(`${JSON.stringify({ ...preview, reused: true }, null, 2)}\n`);
      return;
    }
    if (existingJob || await fsp.stat(state.jobDir).catch(() => null)) throw new Error(`${state.job.id} 流水线目录已存在，拒绝覆盖`);
    if (await fsp.stat(state.taskDir).catch(() => null)) throw new Error(`${record.name} 任务目录已存在，拒绝覆盖`);

    stagedJob = path.join(path.dirname(state.jobDir), `.${path.basename(state.jobDir)}-${crypto.randomUUID()}`);
    stagedTask = path.join(path.dirname(state.taskDir), `.${path.basename(state.taskDir)}-${crypto.randomUUID()}`);
    await Promise.all([fsp.mkdir(stagedJob, { recursive: true }), fsp.mkdir(stagedTask, { recursive: true })]);
    const stagedProject = path.join(stagedJob, 'project');
    await git(['clone', '--quiet', '--no-checkout', record.repository, stagedProject]);
    await git(['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'], stagedProject);
    await git(['switch', '--detach', repository.mainCommit], stagedProject);
    await Promise.all([
      copyWithoutGit(stagedProject, path.join(stagedTask, 'pristine')),
      copyWithoutGit(stagedProject, path.join(stagedTask, 'workspace')),
      fsp.mkdir(path.join(stagedTask, 'grader'), { recursive: true }),
      fsp.mkdir(path.join(stagedTask, 'trajectory'), { recursive: true }),
    ]);
    const stagedVerificationDir = path.join(stagedTask, path.relative(state.taskDir, state.verificationDir));
    await fsp.mkdir(path.dirname(path.join(stagedVerificationDir, repository.testFile)), { recursive: true });
    await fsp.writeFile(path.join(stagedVerificationDir, repository.testFile), repository.testSource, 'utf8');
    await writeJsonAtomic(path.join(stagedVerificationDir, 'test-manifest.json'), {
      ...state.authored,
      sourceDir: state.verificationDir,
    });
    await Promise.all([
      writeJsonAtomic(path.join(stagedTask, 'public.json'), state.metadata),
      writeJsonAtomic(path.join(stagedTask, 'grader/v4-context.json'), state.graderContext),
      writeJsonAtomic(path.join(stagedTask, 'recovery.json'), {
        version: 1,
        bugId,
        taskId: record.id,
        pipelineJobId: state.job.id,
        restoredAt: createdAt,
        previousSessionId: record.sessionId || null,
      }),
      fsp.writeFile(path.join(stagedTask, 'PROMPT.md'), recoveryPromptDocument(record.user_query), 'utf8'),
      fsp.writeFile(path.join(stagedTask, '.trajectory-policy-v4'), 'original-session-events=preserved\ncomplete-conversation=required\nbalanced-tool-events=required\nimmutable-runner-manifest=required\ncontent-quality-review=paused\n', 'utf8'),
      fsp.writeFile(path.join(stagedTask, '.verification-policy-v5'), 'main-trajectory=integrity-and-originality-only\nverification-test-source=historical-repository-test-recovered-as-private-fixture\ndiagnosis-workspace=immutable-source-and-tests\npre-fix=fresh-claude-session-red\ndiagnosis-post-fix=not-required\n', 'utf8'),
    ]);
    await fsp.mkdir(path.join(stagedJob, 'artifacts'), { recursive: true });
    await writeJsonAtomic(path.join(stagedJob, 'artifacts', 'historical-recovery.json'), preview);
    await writeJsonAtomic(path.join(stagedJob, 'job.json'), state.job);

    await fsp.rename(stagedTask, state.taskDir);
    taskInstalled = true;
    stagedTask = '';
    await fsp.rename(stagedJob, state.jobDir);
    stagedJob = '';
    process.stdout.write(`${JSON.stringify({ ...preview, queuedAt: createdAt, restored: true }, null, 2)}\n`);
  } catch (error) {
    if (taskInstalled) {
      const taskDir = path.join(libraryRoot, 'tasks', record.name);
      const jobDir = path.join(libraryRoot, 'pipeline-jobs', record.pipeline_job_id);
      if (!await fsp.stat(jobDir).catch(() => null)) await fsp.rm(taskDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await Promise.all([
      fsp.rm(temporaryRoot, { recursive: true, force: true }),
      stagedTask ? fsp.rm(stagedTask, { recursive: true, force: true }) : Promise.resolve(),
      stagedJob ? fsp.rm(stagedJob, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
