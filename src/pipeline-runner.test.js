import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { adaptiveBugSourceWorkerLimit, applyInjectionInfrastructureFailures, applyInjectionPreparationFailures, assertGoldTestsUsePublicBehavior, bugCandidatePoolSchema, bugCandidateReviewSchema, bugNarrativeLanguageInstruction, bugSchema, bugSchemaForPolicy, buildPreparedVerifyResult, bugfixEffort, bugfixModel, bugWorkerOrder, canonicalizeGoldDescriptor, changedTestFiles, claudeProjectArgs, codexFailureMessage, codexSandboxArgs, codexStreamRecoveryConfigArgs, createCodexStreamRecoveryMonitor, createCurrentQualityReviewBundle, createDockerGraderScript, createOrphanDiagnosisRedSnapshot, criticalDatastoreFiles, discoveryRootCauseDescriptor, elasticProjectBugWorkerLimit, ensureDiagnosisWorkspaceUnchanged, existingDiagnosisVerificationPlan, explicitDockerVerifyCmds, extractFailedGoTestNames, finalizeVerificationResult, goModVersion, injectionPlanningBatch, inspectBugfixRepairWorkspace, inspectClaudeSessionMetadata, inspectDiagnosisWorkspace, isGoldCheckpointSemanticFailure, isRecoverableInjectionCandidateFailure, isRetryableInjectionInfrastructureFailure, materializeVerificationTest, modelFacingDiagnosisQuery, NATURAL_BUG_MIN_REVIEW_SCORE, naturalBugCandidateSeedResult, naturalBugFinderFailureCount, NaturalBugFinderInfrastructureError, normalizeBugCandidateFinders, normalizedPipelineCloneUrl, normalizeDiagnosisVerificationTests, numberedBugId, numberedGreenBranch, numberedRedBranch, numberedModelFixBranch, packagedDockerVerifyCmds, persistVerificationManifest, pipelineHealthPathForJob, pipelineTasksRootForJob, prepareTrajectoryRetry, prepareVerificationProofInputs, projectBugWorkerCeiling, projectGenerationPrompt, projectGeneratorConfig, projectGeneratorGatewayEnvironment, projectGeneratorSessionMismatch, projectGoEnvironment, promotePublishedVerificationFixture, publicTargetCommandForTask, readJson, recoverGoldCheckpoint, rejectGoldCheckpoint, remainingProjectGenerationTimeout, removeGeneratedBuildArtifacts, removeGeneratedCompilerArtifacts, resolveGoldTestPackage, restoreArchivedTrajectoryArtifacts, restoreVerificationEvidenceFromManifests, retainValidInjectionPlanCandidates, runAdaptiveBoundedWorkers, runCommand, safeDiagnosisPublicReproductionCommand, safeSlug, sanitizeModelFacingDiagnosisTask, selectReviewedBugCandidates, shellSingleQuote, snapshotRunnerScript, syncAuthoredVerificationMetadata, terminateProcessTree, validateDiscoveredBug, validateGoldTestDescriptor, validateInjectedBugWorktree, verificationCoverageSchema, writeGrader, migrateWorkflowPolicyVersion } from '../scripts/run-production-pipeline.mjs';
import { reopenBug } from '../scripts/reopen-skipped-bug.mjs';
import { reopenQualityRejectedBug } from '../scripts/reopen-quality-rejected-diagnosis.mjs';
import { BUG_DIFFICULTY_POLICY_VERSION, BUG_TAXONOMY_POLICY_VERSION } from './bug-policy.js';
import { verificationCommandsSha256 } from './verification-proof.js';
import { pipelineTaskOutcome, reactivateFrozenVerificationFailures } from './pipeline-rules.js';

test('pipeline runner normalizes identifiers and parses go.mod language versions', () => {
  assert.equal(safeSlug('  Queue API / Bug #1  '), 'queue-api-bug-1');
  assert.equal(safeSlug('中文项目', 'fallback-project'), 'fallback-project');
  assert.equal(safeSlug('a'.repeat(90)).length, 72);
  assert.equal(goModVersion('module example.test/app\n\ngo 1.25.6\n'), '1.25.6');
  assert.equal(goModVersion('module example.test/app\n'), '');
});

test('delivered pipeline tasks retain failure audit without exposing a current failure', () => {
  const outcome = pipelineTaskOutcome({
    bugs: [{
      bugIndex: 1,
      disposition: 'delivered',
      task: { taskName: 'sample-task' },
      attempts: [{ status: 'passed' }],
      lastFailure: { stage: 'bug1_cloud_upload', error: 'historical upload failure' },
    }],
  }, { taskName: 'sample-task', bugIndex: 1 });
  assert.equal(outcome.disposition, 'delivered');
  assert.equal(outcome.failureStage, '');
  assert.equal(outcome.failureReason, '');
});

test('generated compiler cleanup removes only binaries absent from BUG_BASE', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-compiler-cleanup-'));
  const workspace = path.join(root, 'workspace');
  const baseline = path.join(root, 'baseline');
  try {
    await Promise.all([mkdir(workspace), mkdir(baseline)]);
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]);
    await Promise.all([
      writeFile(path.join(workspace, 'generated'), elf),
      writeFile(path.join(workspace, 'tracked-tool'), elf),
      writeFile(path.join(baseline, 'tracked-tool'), elf),
      writeFile(path.join(workspace, 'source.go'), 'package sample\n'),
    ]);
    assert.deepEqual(await removeGeneratedCompilerArtifacts(workspace, baseline), ['generated']);
    await assert.rejects(stat(path.join(workspace, 'generated')), /ENOENT/);
    assert.equal((await stat(path.join(workspace, 'tracked-tool'))).isFile(), true);
    assert.equal((await stat(path.join(workspace, 'source.go'))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated project cleanup removes nested dependency and build outputs only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-build-cleanup-'));
  try {
    await Promise.all([
      mkdir(path.join(root, 'web', 'node_modules', 'sample'), { recursive: true }),
      mkdir(path.join(root, 'web', 'dist'), { recursive: true }),
      mkdir(path.join(root, 'internal', 'distribution'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'web', 'node_modules', 'sample', 'index.js'), 'module.exports = {}\n'),
      writeFile(path.join(root, 'web', 'dist', 'index.html'), '<main>built</main>\n'),
      writeFile(path.join(root, 'web', 'source.js'), 'export const source = true\n'),
      writeFile(path.join(root, 'internal', 'distribution', 'source.go'), 'package distribution\n'),
    ]);

    assert.deepEqual(await removeGeneratedBuildArtifacts(root), ['web/dist', 'web/node_modules']);
    await assert.rejects(stat(path.join(root, 'web', 'dist')), /ENOENT/);
    await assert.rejects(stat(path.join(root, 'web', 'node_modules')), /ENOENT/);
    assert.equal((await stat(path.join(root, 'web', 'source.js'))).isFile(), true);
    assert.equal((await stat(path.join(root, 'internal', 'distribution', 'source.go'))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated project cleanup preserves dist required by Go embed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-embedded-build-cleanup-'));
  try {
    await Promise.all([
      mkdir(path.join(root, 'webembed', 'dist'), { recursive: true }),
      mkdir(path.join(root, 'web', 'dist'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'webembed', 'assets.go'), 'package webembed\nimport "embed"\n//go:embed all:dist\nvar assets embed.FS\n'),
      writeFile(path.join(root, 'webembed', 'dist', 'index.html'), '<main>embedded</main>\n'),
      writeFile(path.join(root, 'web', 'dist', 'index.html'), '<main>ordinary build</main>\n'),
    ]);

    assert.deepEqual(await removeGeneratedBuildArtifacts(root), ['web/dist']);
    assert.equal((await stat(path.join(root, 'webembed', 'dist', 'index.html'))).isFile(), true);
    await assert.rejects(stat(path.join(root, 'web', 'dist')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resuming a current V3 job backfills the missing workflow policy version', () => {
  const migrated = migrateWorkflowPolicyVersion({ workflowVersion: 3, verificationPolicyVersion: 5 });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.job.workflowPolicyVersion, 4);
  assert.equal(migrated.job.workflowVersion, 3);

  const legacy = migrateWorkflowPolicyVersion({ workflowVersion: 2, verificationPolicyVersion: 5 });
  assert.equal(legacy.changed, false);
  assert.equal(legacy.job.workflowPolicyVersion, undefined);

  const current = migrateWorkflowPolicyVersion({ workflowVersion: 3, workflowPolicyVersion: 4 });
  assert.equal(current.changed, false);
});

test('migrated V3 jobs recover only the missing frozen-verification failure', () => {
  const job = {
    workflowVersion: 3,
    workflowPolicyVersion: 4,
    bugs: [
      {
        bugIndex: 1,
        disposition: 'failed',
        failureDisposition: 'auto_continued',
        failureReason: 'bugfix 缺少在 Claude 前冻结的可执行验证命令',
      },
      {
        bugIndex: 2,
        disposition: 'failed',
        failureDisposition: 'auto_continued',
        failureReason: 'Claude 修复失败（exit=1）',
      },
    ],
    stages: [
      { id: 'bug1_task_prepare', bugIndex: 1, status: 'skipped' },
      { id: 'bug1_claude_fix', bugIndex: 1, status: 'skipped' },
      { id: 'bug2_task_prepare', bugIndex: 2, status: 'skipped' },
    ],
  };
  const result = reactivateFrozenVerificationFailures(job);
  assert.deepEqual(result.reactivated, [1]);
  assert.equal(job.bugs[0].disposition, undefined);
  assert.equal(job.bugs[1].disposition, 'failed');
  assert.equal(job.stages[0].status, 'pending');
  assert.equal(job.stages[1].status, 'pending');
  assert.equal(job.stages[2].status, 'skipped');
});

test('manual Bug workbench mode queues only the selected Bug', () => {
  const job = {
    request: { bugCount: 4 },
    bugExecution: { selectedBugIndex: 3, autoContinue: false },
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }, { bugIndex: 3 }, { bugIndex: 4 }],
    stages: [],
  };
  assert.deepEqual(bugWorkerOrder(job), [3]);
  assert.deepEqual(bugWorkerOrder(job, { selectedBugIndex: 3, autoContinue: true }), [3, 1, 2, 4]);
});

test('Bug worker order replaces a stale delivered cursor with the next unfinished Bug', () => {
  const job = {
    request: { bugCount: 4 },
    bugExecution: { selectedBugIndex: 4, autoContinue: false },
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }, { bugIndex: 3 }, { bugIndex: 4, disposition: 'delivered' }],
    stages: [{ id: 'bug4_delivery_ready', bugIndex: 4, status: 'passed' }],
  };
  assert.deepEqual(bugWorkerOrder(job), [1]);
  assert.deepEqual(bugWorkerOrder(job, { selectedBugIndex: 4, autoContinue: true }), [1, 2, 3]);
});

test('manual retry queue takes priority when a fresh project Runner starts', () => {
  const job = {
    request: { bugCount: 4 },
    bugExecution: { selectedBugIndex: 2, autoContinue: true },
    pendingBugRetries: [3, 1, 3],
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }, { bugIndex: 3 }, { bugIndex: 4 }],
  };
  assert.deepEqual(bugWorkerOrder(job), [1, 3, 2, 4]);
});

test('task preparation failures can reopen before a task directory exists', () => {
  const failure = {
    status: 'failed',
    stage: 'bug3_task_prepare',
    error: 'diagnosis verify_cmds 指向的公开测试不存在',
  };
  const job = {
    id: 'pipeline-test',
    request: { taskType: 'diagnosis' },
    bugs: [{
      bugIndex: 3,
      disposition: 'failed',
      failureDisposition: 'auto_continued',
      failureStage: 'bug3_task_prepare',
      failureReason: failure.error,
      lastFailure: failure,
      attempts: [],
      stageAutoRetries: { bug3_task_prepare: { retryCount: 3, exhausted: true } },
    }],
    stages: [
      { id: 'bug3_task_prepare', bugIndex: 3, phase: 'delivery', stage: 'task_prepare', status: 'skipped' },
      { id: 'bug3_claude_fix', bugIndex: 3, phase: 'delivery', stage: 'claude_fix', status: 'skipped' },
      { id: 'bug3_test_author', bugIndex: 3, phase: 'delivery', stage: 'test_author', status: 'skipped' },
      { id: 'bug3_pre_verify', bugIndex: 3, phase: 'delivery', stage: 'pre_verify', status: 'skipped' },
    ],
  };
  const reopened = reopenBug(job, 3, '2026-08-23T00:00:00.000Z');
  assert.equal(reopened.task, undefined);
  assert.equal(reopened.disposition, undefined);
  assert.equal(reopened.failureStage, undefined);
  assert.equal(reopened.lastFailure, failure);
  assert.equal(reopened.stageAutoRetries, undefined);
  assert.equal(reopened.stageAutoRetryBudgetHistory[0].reason, 'task_prepare_flow_migration');
  assert.deepEqual(job.stages.map((stage) => stage.status), ['pending', 'pending', 'pending', 'pending']);
});

test('reopening a Bug counts only failed attempts against model recovery limits', () => {
  const job = {
    id: 'pipeline-test',
    request: { taskType: 'bugfix' },
    bugs: [{
      bugIndex: 1,
      task: { taskDir: '/tmp/task', taskName: 'task' },
      attempts: [
        { status: 'failed', error: 'Claude 修复失败' },
        { status: 'stopped', error: '人工停止' },
        { status: 'passed', error: '' },
      ],
    }],
    stages: [{ id: 'bug1_claude_fix', bugIndex: 1, phase: 'delivery', stage: 'claude_fix', status: 'failed' }],
  };
  const reopened = reopenBug(job, 1, '2026-08-23T00:00:00.000Z');
  assert.equal(reopened.attempts.length, 1);
});

test('quality rejection recovery archives delivered diagnosis state and reopens only runnable stages', () => {
  const at = '2026-08-25T01:00:00.000Z';
  const job = {
    id: 'pipeline-quality-rejection',
    bugs: [{
      bugIndex: 2,
      disposition: 'delivered',
      deliveredAt: '2026-08-24T01:00:00.000Z',
      task: { taskDir: '/tmp/task', taskName: 'sample-task', bugId: 'sample-bug-02' },
      attempts: [{ status: 'passed', sessionId: 'old-session' }],
      verificationTestAuthor: { testFile: 'sample_test.go' },
      verificationEvidence: { pre_fix: { result: 'red' } },
    }],
    stages: [
      { id: 'bug2_claude_fix', bugIndex: 2, status: 'passed', attempts: [{ status: 'passed' }] },
      { id: 'bug2_test_author', bugIndex: 2, status: 'passed', attempts: [{ status: 'passed' }] },
      { id: 'bug2_pre_verify', bugIndex: 2, status: 'passed', attempts: [{ status: 'passed' }] },
      { id: 'bug2_post_verify', bugIndex: 2, status: 'skipped', reason: 'old reason' },
      { id: 'bug2_delivery_ready', bugIndex: 2, status: 'passed', sessionId: 'old-session' },
    ],
  };

  const bug = reopenQualityRejectedBug(job, 2, at, '轨迹违反 diagnosis 只读规则');
  assert.equal(bug.disposition, undefined);
  assert.deepEqual(bug.attempts, []);
  assert.equal(bug.verificationTestAuthor, undefined);
  assert.equal(bug.qualityRejectionHistory[0].attempts[0].sessionId, 'old-session');
  assert.deepEqual(job.stages.map((stage) => stage.status), ['pending', 'pending', 'pending', 'skipped', 'pending']);
  assert.deepEqual(job.stages[0].attempts, []);
  assert.match(job.stages[3].reason, /diagnosis/);
  assert.equal(bug.workerExecution.currentStage, 'bug2_claude_fix');
});

test('diagnosis task preparation registers the focused repository test', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-verification-plan-'));
  try {
    await mkdir(path.join(root, 'internal/integration'), { recursive: true });
    const source = 'package integration_test\n\nimport "testing"\n\nfunc TestModel_Replay(t *testing.T) {}\n';
    await writeFile(path.join(root, 'internal/integration/model_replay_test.go'), source);
    const plan = await existingDiagnosisVerificationPlan(
      root,
      "go test ./internal/integration -run '^TestModel_Replay$' -count=1 -v",
    );
    assert.equal(plan.verification_test_overlay, 'repository-tests');
    assert.deepEqual(plan.verification_test_files, ['internal/integration/model_replay_test.go']);
    assert.deepEqual(plan.verification_test_names, ['TestModel_Replay']);
    assert.match(plan.verification_test_manifest[0].sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      existingDiagnosisVerificationPlan(root, "go test ./internal/integration -run '^TestModel_Missing$' -count=1 -v"),
      /公开测试不存在/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model-facing diagnosis query omits an unverified guessed test command', () => {
  const query = '接口在重启后仍停留在处理中，请排查恢复状态没有推进的问题。';
  assert.equal(modelFacingDiagnosisQuery(query, ''), query);
  assert.doesNotMatch(modelFacingDiagnosisQuery(query, ''), /TestRecoveryAdvancesCompletedDutiesToReview/);
  assert.match(
    modelFacingDiagnosisQuery(query, "go run ./cmd/quorumforge -h"),
    /公开复现命令：go run \.\/cmd\/quorumforge -h/,
  );
});

test('diagnosis task preparation defers unsafe scenarios to the independent test author', () => {
  assert.equal(safeDiagnosisPublicReproductionCommand('GOCACHE=/tmp/cache go run /tmp/repro.go'), '');
  assert.equal(safeDiagnosisPublicReproductionCommand('在事务里临时制造一次 SQLite 写入错误'), '');
  assert.equal(
    safeDiagnosisPublicReproductionCommand("go test ./service -run '^TestExisting$' -count=1 -v"),
    "go test ./service -run '^TestExisting$' -count=1 -v",
  );
});

test('a saved repair checkpoint still waits for post-Claude test authoring', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  assert.match(runner, /verification_test_overlay_now" != "repository-tests" \]\]; then\s+post_claude_codex_flow=1/);
  assert.doesNotMatch(runner, /verification_test_overlay_now" != "repository-tests"[\s\\]+&& ! -d "\$repair_checkpoint"/);
});

test('bugfix repair checkpoint requires a non-test workspace change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugfix-repair-diff-'));
  const baseline = path.join(root, 'baseline');
  const fixed = path.join(root, 'fixed');
  try {
    await Promise.all([mkdir(baseline), mkdir(fixed)]);
    await Promise.all([
      writeFile(path.join(baseline, 'service.go'), 'package sample\n'),
      writeFile(path.join(fixed, 'service.go'), 'package sample\n'),
      writeFile(path.join(fixed, 'service_test.go'), 'package sample\n'),
    ]);
    assert.deepEqual(await inspectBugfixRepairWorkspace(baseline, fixed), {
      valid: false,
      changedNonTestFiles: [],
    });
    await writeFile(path.join(fixed, 'service.go'), 'package repaired\n');
    assert.deepEqual(await inspectBugfixRepairWorkspace(baseline, fixed), {
      valid: true,
      changedNonTestFiles: ['service.go'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale diagnosis task prompts are sanitized before a Claude retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-prompt-sanitize-'));
  try {
    await mkdir(path.join(root, 'pristine'), { recursive: true });
    await writeFile(path.join(root, 'public.json'), JSON.stringify({
      task_type: 'diagnosis',
      user_query: '旧题面\n\n公开复现命令：go test ./service -run TestGuessed -count=1',
      verify_cmds: [],
    }));
    await writeFile(path.join(root, 'PROMPT.md'), '旧题面');
    const result = await sanitizeModelFacingDiagnosisTask({ taskDir: root, taskType: 'diagnosis' }, {
      discovery: { user_query: '重启后任务仍停在处理中，请排查恢复状态没有推进。' },
    });
    assert.equal(result.sanitized, true);
    assert.equal(result.publicTargetCommand, '');
    assert.equal((await readFile(path.join(root, 'PROMPT.md'), 'utf8')).includes('TestGuessed'), false);
    assert.equal((await readFile(path.join(root, 'PROMPT.md'), 'utf8')).includes('重启后任务仍停在处理中'), true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'public.json'), 'utf8')).user_query.includes('TestGuessed'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnosis normalization makes the public test run without an internal prefix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-test-normalize-'));
  try {
    const filename = 'internal/integration/model_replay_test.go';
    await mkdir(path.join(root, 'internal/integration'), { recursive: true });
    await writeFile(path.join(root, filename), [
      'package integration_test',
      '',
      'import (',
      '    "os"',
      '    "testing"',
      ')',
      '',
      'func TestModel_Replay(t *testing.T) {',
      '    if os.Getenv("MODEL_REPRO") != "1" { t.Skip("target reproduction only") }',
      '}',
      '',
    ].join('\n'));
    assert.deepEqual(
      await normalizeDiagnosisVerificationTests(root, "go test ./internal/integration -run '^TestModel_Replay$' -count=1 -v"),
      [filename],
    );
    const normalized = await readFile(path.join(root, filename), 'utf8');
    assert.match(normalized, /os\.Getenv\("MODEL_REPRO"\) == "0"/);
    assert.match(normalized, /target reproduction only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proof input preflight restores a repository test from its checkpoint before Claude starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-proof-preflight-'));
  try {
    const taskDir = path.join(root, 'task');
    const sourceDir = path.join(root, 'bug-base');
    const testFile = 'internal/service/model_regression_test.go';
    await Promise.all([
      mkdir(path.join(taskDir, 'workspace'), { recursive: true }),
      mkdir(path.join(taskDir, '.test-author-checkpoint/workspace/internal/service'), { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
    ]);
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      verify_cmds: ["go test ./internal/service -run '^TestModel_Regression$' -count=1"],
      verification_test_overlay: 'repository-tests',
      verification_test_files: [testFile],
    })}\n`);
    await writeFile(
      path.join(taskDir, '.test-author-checkpoint/workspace', testFile),
      'package service\n\nfunc TestModel_Regression() {}\n',
    );

    const result = await prepareVerificationProofInputs(taskDir, 'pre_fix', sourceDir);
    assert.deepEqual(result.testFiles, [testFile]);
    assert.equal(await readFile(path.join(taskDir, 'workspace', testFile), 'utf8'), 'package service\n\nfunc TestModel_Regression() {}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proof input preflight rejects an empty verify_cmds before starting a Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-proof-empty-'));
  try {
    const taskDir = path.join(root, 'task');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      verify_cmds: [],
      success_criteria: '并发行为应保持一致。',
      gold_root_cause: 'service.go 中的共享状态未同步。',
    })}\n`);
    await assert.rejects(
      prepareVerificationProofInputs(taskDir, 'pre_fix', root),
      /证明前置检查失败：public\.json\.verify_cmds 为空/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry rehydrates public verification metadata from the frozen Codex test', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-metadata-recovery-'));
  try {
    const taskDir = path.join(root, 'task');
    const sourceDir = path.join(root, 'test-author');
    const testFile = 'internal/service/model_retry_test.go';
    const source = `package service\n\nimport "testing"\n\nfunc TestModel_Retry(t *testing.T) {\n\ttests := []struct { name string }{{name: "restored"}}\n\tfor _, tt := range tests { t.Run(tt.name, func(t *testing.T) {}) }\n}\n`;
    await Promise.all([
      mkdir(taskDir, { recursive: true }),
      mkdir(path.join(sourceDir, 'internal/service'), { recursive: true }),
    ]);
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({ verify_cmds: [] })}\n`);
    await writeFile(path.join(sourceDir, testFile), source);
    const plan = await syncAuthoredVerificationMetadata(taskDir, {
      sourceDir,
      testFile,
      sessionId: 'test-author-session',
      repairSessionId: 'old-repair-session',
      sha256: createHash('sha256').update(source).digest('hex'),
    }, { taskType: 'bugfix', repairSessionId: 'new-repair-session' });
    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.deepEqual(metadata.verify_cmds, plan.verify_cmds);
    assert.deepEqual(metadata.verification_test_files, [testFile]);
    assert.equal(metadata.verification_test_overlay, 'repository-tests');
    assert.equal(metadata.verification_test_repair_session_id, 'new-repair-session');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retry preserves concurrency verification policy in public metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'concurrency-verification-metadata-'));
  try {
    const taskDir = path.join(root, 'task');
    const sourceDir = path.join(root, 'test-author');
    const testFile = 'internal/service/model_concurrency_test.go';
    const source = `package service\n\nimport "testing"\n\nfunc TestModel_Concurrent(t *testing.T) {}\n`;
    await Promise.all([
      mkdir(taskDir, { recursive: true }),
      mkdir(path.join(sourceDir, 'internal/service'), { recursive: true }),
    ]);
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({ verify_cmds: [] })}\n`);
    await writeFile(path.join(sourceDir, testFile), source);
    const plan = await syncAuthoredVerificationMetadata(taskDir, {
      sourceDir,
      testFile,
      sessionId: 'concurrency-test-author-session',
      sha256: createHash('sha256').update(source).digest('hex'),
    }, { taskType: 'bugfix', concurrency: true });
    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.deepEqual(plan.verify_cmds, ["go test -race ./internal/service -run '^TestModel_Concurrent$' -count=20 -v"]);
    assert.equal(metadata.concurrency_verification, true);
    assert.equal(metadata.verification_repeat_count, 20);
    assert.match(metadata.success_criteria, /固定并发轮次/);
    assert.match(metadata.success_criteria, /go test -race .* -count=20 -v/);
    assert.match(metadata.gold_root_cause, /固定并发轮次/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnosis verification metadata keeps the authored test outside workspace and Git', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-verification-metadata-'));
  try {
    const taskDir = path.join(root, 'task');
    const sourceDir = path.join(taskDir, 'verification-test-bug1');
    const testFile = 'internal/service/model_diagnosis_test.go';
    const source = `package service\n\nimport "testing"\n\nfunc TestModel_Diagnosis(t *testing.T) {}\n`;
    await mkdir(path.join(sourceDir, 'internal/service'), { recursive: true });
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({ task_type: 'diagnosis' })}\n`);
    await writeFile(path.join(sourceDir, testFile), source);

    await syncAuthoredVerificationMetadata(taskDir, {
      sourceDir,
      testFile,
      sessionId: 'test-author-session',
      sha256: createHash('sha256').update(source).digest('hex'),
    }, { taskType: 'diagnosis' });

    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.equal(metadata.verification_test_overlay, 'private-fixture');
    assert.equal(metadata.verification_fixture_dir, sourceDir);
    assert.equal(metadata.verification_fixture_published, false);
    assert.equal(metadata.verification_fixture_materialized, false);
    assert.equal(metadata.verification_test_storage, 'system-fixture-only');
    assert.equal(metadata.diagnosis_workspace_policy_version, 1);
    assert.equal(await stat(path.join(taskDir, 'workspace', testFile)).then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proof input preflight rejects a declared test that is not materialized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-proof-missing-test-'));
  try {
    const taskDir = path.join(root, 'task');
    const sourceDir = path.join(root, 'bug-base');
    await Promise.all([
      mkdir(path.join(taskDir, 'workspace'), { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
    ]);
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      verify_cmds: ["go test ./internal/service -run '^TestModel_Missing$' -count=1"],
      verification_test_overlay: 'repository-tests',
      verification_test_files: ['internal/service/missing_model_test.go'],
    })}\n`);

    await assert.rejects(
      prepareVerificationProofInputs(taskDir, 'pre_fix', sourceDir),
      /证明前置检查失败：验证测试文件未物化到任务工作区：internal\/service\/missing_model_test\.go/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude fix uses a fifteen-minute stream-idle timeout without a file-progress deadline', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /GO_PIPELINE_CLAUDE_FIX_IDLE_TIMEOUT_MS \|\| 15 \* 60_000/);
  assert.match(pipeline, /GO_PIPELINE_CLAUDE_FIX_TIMEOUT_MS \|\| 120 \* 60_000/);
  assert.match(pipeline, /timeoutMs: CLAUDE_FIX_TIMEOUT_MS/);
  assert.match(pipeline, /GO_PIPELINE_CLAUDE_FIX_PROGRESS_TIMEOUT_MS \|\| 0/);
  assert.match(pipeline, /const CLAUDE_FIX_PROGRESS_TIMEOUT_MS[\s\S]*?\n  : 0;/);
  assert.match(pipeline, /GO_PIPELINE_CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS \|\| 0/);
  assert.match(pipeline, /const CLAUDE_FIX_INITIAL_PROGRESS_GRACE_MS[\s\S]*?\n  : 0;/);
});

test('pipeline stage transitions refresh the Bug worker heartbeat', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const setStageStart = pipeline.indexOf('async function setStage(');
  const setStageEnd = pipeline.indexOf('\nasync function assertStagePrerequisites(', setStageStart);
  assert.notEqual(setStageStart, -1);
  assert.notEqual(setStageEnd, -1);
  assert.match(pipeline.slice(setStageStart, setStageEnd), /lastHeartbeatAt: changedAt/);
});

test('runner snapshots remain executable when the project path contains spaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runner snapshot path '));
  try {
    const jobFile = path.join(root, 'job.json');
    const source = path.join(root, 'source.sh');
    await writeFile(source, '#!/usr/bin/env bash\nprintf "%s\\n" snapshot-ok\n', 'utf8');
    const snapshot = await snapshotRunnerScript(jobFile, source, 'bug1-claude-attempt-1');
    assert.equal((await stat(snapshot)).mode & 0o111, 0o111);
    const result = spawnSync('/bin/bash', [snapshot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'snapshot-ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project Go checks follow the Dockerfile toolchain instead of the host Go version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'go-project-env-'));
  try {
    await writeFile(path.join(root, 'go.mod'), 'module example.test/app\n\ngo 1.25\n\ntoolchain go1.25.6\n');
    await writeFile(path.join(root, 'benzhi.Dockerfile'), 'FROM golang:1.25.6\nENV GOTOOLCHAIN=local\n');
    const env = await projectGoEnvironment(root);
    assert.equal(env.GOTOOLCHAIN, 'go1.25.6');
    assert.equal(env.GOSUMDB, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project Go checks do not turn a two-part Docker language version into an invalid toolchain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'go-project-language-version-'));
  try {
    await writeFile(path.join(root, 'go.mod'), 'module example.test/app\n\ngo 1.23\n');
    await writeFile(path.join(root, 'benzhi.Dockerfile'), 'FROM golang:1.23\n');
    const env = await projectGoEnvironment(root);
    assert.equal(env.GOTOOLCHAIN, 'local');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coverage review issue schema requires its discriminator', () => {
  const item = verificationCoverageSchema.properties.issues.items;
  assert.deepEqual(item.required, ['category', 'contract_level', 'message', 'evidence']);
  assert.ok(item.properties.category);
  assert.ok(item.properties.contract_level);
  assert.ok(verificationCoverageSchema.properties.requirements.items.required.includes('contract_level'));
});

test('project generation can use DeepSeek through Claude Code without changing other Claude stages', () => {
  const config = projectGeneratorConfig({
    GO_PIPELINE_PROJECT_GENERATOR_PROVIDER: 'deepseek',
    GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN: 'test-token',
  });
  assert.deepEqual(config, {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'test-token',
    model: 'deepseek-v4-pro[1m]',
    subagentModel: 'deepseek-v4-flash',
    effort: 'low',
  });
  const args = claudeProjectArgs('generate project', config);
  assert.equal(args.includes('--bare'), true);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'deepseek-v4-pro[1m]']);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low']);
  assert.equal(args.at(-1), 'generate project');

  const original = projectGeneratorConfig({ CLAUDE_EFFORT: 'medium' });
  assert.equal(original.provider, 'claude');
  assert.equal(original.model, '');
  assert.equal(claudeProjectArgs('original', original).includes('--bare'), false);
  assert.equal(claudeProjectArgs('original', original).includes('--model'), false);
});

test('DeepSeek project generation refuses to start without its isolated API key', () => {
  assert.throws(
    () => projectGeneratorConfig({ GO_PIPELINE_PROJECT_GENERATOR_PROVIDER: 'deepseek' }),
    /GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN/,
  );
});

test('Claude project generation selects the fastest healthy gateway for its current model', async () => {
  const config = projectGeneratorConfig({});
  const delays = new Map([
    ['https://slow.example', [25, 200]],
    ['https://fast.example', [0, 200]],
    ['https://broken.example', [0, 504]],
  ]);
  const routing = await projectGeneratorGatewayEnvironment(config, {
    environment: {
      ANTHROPIC_MODEL: 'model_hub/glm-52-coding',
      GO_PIPELINE_CLAUDE_GATEWAYS_JSON: JSON.stringify({
        'model_hub/glm-52-coding': [...delays.keys()],
      }),
    },
    fetchImpl: async (url) => {
      const [delay, status] = delays.get(url);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response('', { status });
    },
  });
  assert.equal(routing.selected, 'https://fast.example');
  assert.deepEqual(routing.env, { ANTHROPIC_BASE_URL: 'https://fast.example' });
  assert.equal(routing.probes.length, 3);
});

test('DeepSeek project generation keeps its isolated fixed endpoint', async () => {
  const config = projectGeneratorConfig({
    GO_PIPELINE_PROJECT_GENERATOR_PROVIDER: 'deepseek',
    GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN: 'test-token',
  });
  const routing = await projectGeneratorGatewayEnvironment(config, {
    environment: { GO_PIPELINE_CLAUDE_GATEWAYS_JSON: JSON.stringify(['https://other.example']) },
    fetchImpl: async () => { throw new Error('must not probe'); },
  });
  assert.deepEqual(routing, { env: {}, selected: '', probes: [], model: '' });
});

test('DeepSeek generation rejects a Session that reports another model', () => {
  const config = projectGeneratorConfig({
    GO_PIPELINE_PROJECT_GENERATOR_PROVIDER: 'deepseek',
    GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN: 'test-token',
  });
  const raw = `${JSON.stringify({ type: 'system', subtype: 'init', model: 'model_hub/glm-52-coding', session_id: 's1' })}\n`;
  const metadata = inspectClaudeSessionMetadata(raw);
  assert.equal(metadata.model, 'model_hub/glm-52-coding');
  assert.match(projectGeneratorSessionMismatch(config, metadata), /期望 deepseek-v4-pro\[1m\].*实际 model_hub\/glm-52-coding/);
  assert.equal(projectGeneratorSessionMismatch(config, { model: 'deepseek-v4-pro[1m]' }), '');
});

test('Bug fixing uses the dedicated GLM model independently of project generation', () => {
  assert.equal(bugfixModel({}), 'model_hub/glm-52-coding');
  assert.equal(bugfixModel({ GO_PIPELINE_BUGFIX_MODEL: 'model_hub/glm-52-coding' }), 'model_hub/glm-52-coding');
  assert.equal(bugfixModel({ GO_PIPELINE_BUGFIX_MODEL: '  ' }), 'model_hub/glm-52-coding');
  assert.equal(bugfixEffort(1, {}), 'low');
  assert.equal(bugfixEffort(2, {}), 'medium');
  assert.equal(bugfixEffort(1, { GO_PIPELINE_BUGFIX_EFFORT: 'high' }), 'high');
  assert.equal(bugfixEffort(2, { GO_PIPELINE_BUGFIX_RETRY_EFFORT: 'low' }), 'low');
  assert.equal(bugfixEffort(1, { GO_PIPELINE_BUGFIX_EFFORT: 'invalid' }), 'low');
});

test('pipeline child commands never inherit the project-generator secret variable', async () => {
  const result = await runCommand('/usr/bin/env', [], {
    env: {
      GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN: 'must-not-leak',
      PIPELINE_SAFE_TEST_VALUE: 'visible',
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /PIPELINE_SAFE_TEST_VALUE=visible/);
  assert.doesNotMatch(result.stdout, /must-not-leak|GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN/);
});

test('pipeline runner safely quotes shell arguments', () => {
  assert.equal(shellSingleQuote("./pkg/it's-safe"), "'./pkg/it'\"'\"'s-safe'");
});

test('pipeline runner repairs a missing clone URL from origin or repository metadata', () => {
  assert.equal(
    normalizedPipelineCloneUrl(
      { cloneUrl: 'undefined', repository: 'https://github.com/example/recovered-repo' },
      'https://github.com/example/origin-repo.git',
    ),
    'https://github.com/example/origin-repo.git',
  );
  assert.equal(
    normalizedPipelineCloneUrl({ repository: 'https://github.com/example/recovered-repo/' }),
    'https://github.com/example/recovered-repo.git',
  );
  assert.equal(
    normalizedPipelineCloneUrl({ cloneUrl: 'git@github.com:example/ssh-repo.git' }),
    'git@github.com:example/ssh-repo.git',
  );
  assert.equal(normalizedPipelineCloneUrl({ cloneUrl: 'null' }), '');
});

test('pipeline runner derives the shared task root for a legacy job', () => {
  assert.equal(
    pipelineTasksRootForJob('/private/library/pipeline-jobs/pipeline-example/job.json'),
    '/private/library/tasks',
  );
});

test('project generation prompts create an early checkpoint and repair in place', () => {
  const plan = { project_slug: 'checkpoint-demo', title: 'Checkpoint demo', overview: 'A bounded Go project for checkpoint testing.' };
  const foundation = projectGenerationPrompt(plan, { phase: 'foundation' });
  assert.match(foundation, /first code-creation action/i);
  assert.match(foundation, /PROJECT_SPEC\.md/);
  assert.match(foundation, /minimal Go project plan|supplied Go project plan/i);
  const repair = projectGenerationPrompt(plan, { phase: 'repair', failure: 'go test ./... failed: missing package' });
  assert.match(repair, /Repair the existing generated Go project/);
  assert.match(repair, /missing package/);
  assert.match(repair, /rewrite only the smoke probe to use an explicit loopback host/);
  assert.match(repair, /Do not add vendor, -mod=vendor, or COPY vendor/);
  assert.match(repair, /initialize Git|create ZIP files/);
});

test('generated project validation persists five checkpoints and resets only Docker infrastructure', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /\['mod', 'edit', `-toolchain=go\$\{toolchainVersion\}`\]/);
  assert.match(pipeline, /checkpoint\.static/);
  assert.match(pipeline, /checkpoint\.go/);
  assert.match(pipeline, /checkpoint\.frontend/);
  assert.match(pipeline, /checkpoint\.platforms\[outcome\.platform\]/);
  assert.match(pipeline, /Go build\/test\/vet 检查点/);
  assert.match(pipeline, /前端 npm ci\/build 检查点/);
  assert.match(pipeline, /重置共享 Builder 后只重跑当前架构，不调用 Claude/);
  assert.match(pipeline, /'buildx', 'inspect', 'benzhi-builder', '--bootstrap'/);
  assert.match(pipeline, /Promise\.all\(\[\s*runGoCheckpoint\(\),\s*runFrontendCheckpoint\(\)/);
  assert.match(pipeline, /acquireStageResourceSlot\(jobFile, 'project_validate', \{ optional: true \}\)/);
  assert.match(pipeline, /docker-infrastructure-reset\.lock/);
});

test('automatic Docker maintenance waits only for a live compute-docker lease', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(pipeline, /hasDockerCommand[\s\S]{0,300}acquireStageResourceSlot\(jobFile, `bug\$\{bugIndex\}_docker_validation`/);
  assert.match(server, /activePipelineResourceSlotSnapshot\(\)/);
  assert.match(server, /dockerOccupiedCount === 0/);
  assert.doesNotMatch(server, /dockerBusy\.size/);
  assert.match(server, /async function enforceDockerGraderCpuLimit\(\)/);
  assert.match(server, /docker', \['update', '--cpus', String\(DOCKER_RUN_CPU_LIMIT\), id\]/);
});

test('automatic refill can pause without stopping existing project scheduling', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  const start = server.indexOf("request.url === '/api/pipeline/refill/control'");
  const end = server.indexOf("request.url === '/api/system/maintenance/docker'", start);
  const handler = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(server, /if \(pipelineRefillPaused \|\| pipelineAutoRefillRunning/);
  assert.match(handler, /pipelineRefillPaused = body\.paused !== false/);
  assert.match(handler, /现有项目继续运行/);
  assert.doesNotMatch(handler, /setPipelineControlMode|pipelineAutoFillEnabled = false/);
});

test('project generation command fails fast when no go.mod checkpoint appears', async () => {
  const missing = path.join(os.tmpdir(), `go-project-missing-${process.pid}-${Date.now()}.mod`);
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    timeoutMs: 2_000,
    requiredPath: missing,
    requiredPathDeadlineMs: 60,
  });
  assert.match(result.error, /仍未生成 go-project-missing/);
  assert.notEqual(result.exitCode, 0);
});

test('pipeline runner stops a silent child at the idle timeout', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5_000,
    idleTimeoutMs: 80,
  });
  assert.equal(result.timedOut, true);
  assert.match(result.error, /连续 1 秒未产生子进程事件/);
  assert.ok(result.durationMs < 2_000);
});

test('pipeline runner resets the idle timeout whenever the child reports progress', async () => {
  const script = "let count = 0; const timer = setInterval(() => { process.stdout.write('progress\\n'); count += 1; if (count === 5) { clearInterval(timer); } }, 30);";
  const result = await runCommand(process.execPath, ['-e', script], {
    timeoutMs: 2_000,
    idleTimeoutMs: 500,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /progress/);
});

test('pipeline runner distinguishes real workspace progress from log output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-progress-test-'));
  const marker = path.join(directory, 'workspace-progress.json');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const marker = ${JSON.stringify(marker)};`,
      "let count = 0;",
      "const timer = setInterval(() => { process.stdout.write('CLAUDE_PROGRESS\\n'); fs.writeFileSync(marker, String(++count)); if (count === 3) clearInterval(timer); }, 35);",
    ].join(' ')], {
      timeoutMs: 2_000,
      idleTimeoutMs: 500,
      progressPaths: [marker],
      progressTimeoutMs: 500,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressTimedOut, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner observes nested workspace tree changes as real progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-tree-progress-test-'));
  const nested = path.join(directory, 'internal', 'service.go');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const nested = ${JSON.stringify(nested)};`,
      "fs.mkdirSync(require('path').dirname(nested), { recursive: true });",
      "let count = 0;",
      "const timer = setInterval(() => { fs.writeFileSync(nested, String(++count)); if (count === 4) clearInterval(timer); }, 35);",
    ].join(' ')], {
      timeoutMs: 2_000,
      progressTreePaths: [directory],
      progressTimeoutMs: 120,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressTimedOut, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project generation uses workspace progress instead of model output as its stall clock', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /progressTreePaths: \[cwd\]/);
  assert.match(pipeline, /GO_PIPELINE_PROJECT_GENERATION_PROGRESS_TIMEOUT_MS/);
  assert.match(pipeline, /PROJECT_GENERATION_ACTIVE_WORK_GRACE_MS/);
});

test('Claude analysis grace allows a first production edit without counting activity as progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-initial-progress-grace-test-'));
  const progress = path.join(directory, 'workspace-progress.json');
  const activity = path.join(directory, 'claude-activity.json');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const progress = ${JSON.stringify(progress)};`,
      `const activity = ${JSON.stringify(activity)};`,
      "setTimeout(() => { fs.writeFileSync(progress, 'changed'); }, 180);",
      "setInterval(() => fs.writeFileSync(activity, String(Date.now())), 25);",
      "setTimeout(() => process.exit(0), 260);",
    ].join(' ')], {
      timeoutMs: 1_000,
      idleTimeoutMs: 400,
      progressPaths: [progress],
      activityPaths: [activity],
      initialProgressGraceMs: 300,
      progressTimeoutMs: 80,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressTimedOut, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude activity can keep a live child from idle timeout but never satisfies real progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-activity-liveness-test-'));
  const progress = path.join(directory, 'workspace-progress.json');
  const activity = path.join(directory, 'claude-activity.json');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const activity = ${JSON.stringify(activity)};`,
      "setInterval(() => fs.writeFileSync(activity, String(Date.now())), 20);",
    ].join(' ')], {
      timeoutMs: 2_000,
      idleTimeoutMs: 1_000,
      progressPaths: [progress],
      activityPaths: [activity],
      progressTimeoutMs: 500,
    });
    assert.equal(result.progressTimedOut, true);
    assert.match(result.error, /真实文件进展/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude activity observations refresh telemetry without enabling a progress deadline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-activity-observer-test-'));
  const activity = path.join(directory, 'claude-activity.json');
  let observations = 0;
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const activity = ${JSON.stringify(activity)};`,
      "setTimeout(() => fs.writeFileSync(activity, String(Date.now())), 80);",
      "setTimeout(() => process.exit(0), 1250);",
    ].join(' ')], {
      timeoutMs: 2_000,
      idleTimeoutMs: 1_500,
      activityPaths: [activity],
      progressTimeoutMs: 0,
      onActivityObservation: () => { observations += 1; },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressTimedOut, false);
    assert.equal(observations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner does not count Claude activity or api_retry events as file progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-activity-test-'));
  const progress = path.join(directory, 'workspace-progress.json');
  const activity = path.join(directory, 'claude-activity.json');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      `const activity = ${JSON.stringify(activity)};`,
      "let count = 0;",
      "setInterval(() => { process.stdout.write('CLAUDE_PROGRESS\\n'); fs.writeFileSync(activity, JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: ++count })); }, 25);",
    ].join(' ')], {
      timeoutMs: 3_000,
      idleTimeoutMs: 1_500,
      progressPaths: [progress],
      activityPaths: [activity],
      progressTimeoutMs: 500,
    });
    assert.equal(result.progressTimedOut, true);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /真实文件进展/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude task runner terminates a repeated permission-denial loop', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-permission-denial-test-'));
  const activity = path.join(directory, 'claude-activity.json');
  const functionStart = runner.indexOf('write_activity_state() {');
  const functionEnd = runner.indexOf('\nstart_progress_watcher() {', functionStart);
  assert.match(runner, /permission_denied_limit="\$\{GO_PIPELINE_CLAUDE_PERMISSION_DENIAL_LIMIT:-8\}"/);
  assert.match(runner, /permission_denied_count=\$\(\(permission_denied_count \+ 1\)\)/);
  assert.match(runner, /permission denial guard reached \(\$\{permission_denial_stop_reason\}\)/);
  assert.match(runner, /terminate_claude_pipeline_siblings "\$claude_pipeline_parent_pid"/);
  assert.match(runner, /pipeline_status\[2\].*-eq 86/);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  try {
    const functions = runner.slice(functionStart, functionEnd);
    const script = [
      `activity_state=${shellSingleQuote(activity)}`,
      `workspace=${shellSingleQuote(directory)}`,
      'task_type=bugfix',
      'permission_denied_count=0',
      'permission_denied_limit=3',
      'diagnosis_mutation_denied_count=0',
      'diagnosis_mutation_denied_limit=0',
      'permission_denial_stop_reason=""',
      functions,
      'while IFS= read -r line; do',
      '  if ! record_stream_activity "$line"; then exit 86; fi',
      'done',
    ].join('\n');
    const denied = JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      message: 'Permission to use Bash has been denied.',
    });
    const toolResult = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'denied' }] },
    });
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      input: `${denied}\n${toolResult}\n${denied}\n${denied}\n`,
    });

    assert.equal(result.status, 86, result.stderr);
    const savedActivity = JSON.parse(await readFile(activity, 'utf8'));
    assert.equal(savedActivity.event_type, 'system');
    assert.equal(savedActivity.event_subtype, 'permission_denied');
    assert.equal(savedActivity.permission_denied_count, 3);
    assert.equal(savedActivity.workspace, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude task runner distinguishes read-only diagnosis denials from mutation attempts', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const classifier = path.resolve(import.meta.dirname, '../scripts/classify-diagnosis-permission-denial.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-diagnosis-denial-test-'));
  const activity = path.join(directory, 'claude-activity.json');
  const functionStart = runner.indexOf('write_activity_state() {');
  const functionEnd = runner.indexOf('\nstart_progress_watcher() {', functionStart);
  const functions = runner.slice(functionStart, functionEnd);
  const base = [
    `activity_state=${shellSingleQuote(activity)}`,
    `workspace=${shellSingleQuote(directory)}`,
    `node_bin=${shellSingleQuote(process.execPath)}`,
    `diagnosis_denial_classifier=${shellSingleQuote(classifier)}`,
    'task_type=diagnosis',
    'permission_denied_count=0',
    'permission_denied_limit=8',
    'diagnosis_mutation_denied_count=0',
    'diagnosis_mutation_denied_limit=1',
    'permission_denial_stop_reason=""',
    functions,
    'while IFS= read -r line; do',
    '  if ! record_stream_activity "$line"; then exit 86; fi',
    'done',
  ].join('\n');
  const readOnlyDenial = JSON.stringify({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    message: 'Permission to use Bash with command ls -la && git log --oneline -5 2>/dev/null has been denied.',
  });
  const mutationDenial = JSON.stringify({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    message: 'Permission to use Bash with command cat > /tmp/fix.py <<\'EOF\'\\nprint(1)\\nEOF has been denied.',
  });
  const hookMutationDenial = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'hook-denied',
        is_error: true,
        content: 'diagnosis 任务禁止任何文件或持久配置写入（filesystem-write: /tmp/repro）',
      }],
    },
  });

  try {
    const readOnly = spawnSync('bash', ['-c', base], { encoding: 'utf8', input: `${readOnlyDenial}\n` });
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.deepEqual(
      (({ permission_denied_count, diagnosis_mutation_denied_count }) => ({ permission_denied_count, diagnosis_mutation_denied_count }))(
        JSON.parse(await readFile(activity, 'utf8')),
      ),
      { permission_denied_count: 1, diagnosis_mutation_denied_count: 0 },
    );

    const mutation = spawnSync('bash', ['-c', base], { encoding: 'utf8', input: `${readOnlyDenial}\n${mutationDenial}\n` });
    assert.equal(mutation.status, 86, mutation.stderr);
    const savedActivity = JSON.parse(await readFile(activity, 'utf8'));
    assert.equal(savedActivity.permission_denied_count, 2);
    assert.equal(savedActivity.diagnosis_mutation_denied_count, 1);

    const hookMutation = spawnSync('bash', ['-c', base], { encoding: 'utf8', input: `${hookMutationDenial}\n` });
    assert.equal(hookMutation.status, 86, hookMutation.stderr);
    const hookActivity = JSON.parse(await readFile(activity, 'utf8'));
    assert.equal(hookActivity.permission_denied_count, 1);
    assert.equal(hookActivity.diagnosis_mutation_denied_count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude task runner rejects diagnosis write attempts before saving a checkpoint', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const baseline = runner.indexOf('{"hook_event_name":"V4Baseline"}');
  const final = runner.indexOf('{"hook_event_name":"V4Final"}');
  const checker = runner.indexOf('"$diagnosis_readonly_checker" "$native_candidate" "$audit_log" "$sandbox_workspace"');
  const checkpoint = runner.indexOf('\nsave_repair_checkpoint\n', checker);
  assert.match(runner, /--settings "\$hook_settings"/);
  assert.match(runner, /audit_hook_source="\$runner_root\/scripts\/claude-v4-hook\.mjs"/);
  assert.match(runner, /cp "\$audit_hook_source" "\$hook_runtime\/scripts\/claude-v4-hook\.mjs"/);
  assert.match(runner, /audit_hook="\$hook_runtime\/scripts\/claude-v4-hook\.mjs"/);
  assert.match(runner, /if \[\[ "\$task_type" == "diagnosis" \]\]; then[\s\S]+diagnosis_mutation_denied_limit=1/);
  assert.ok(baseline >= 0);
  assert.ok(final > baseline);
  assert.ok(checker > final);
  assert.ok(checkpoint > checker);
  assert.match(runner.slice(final, checkpoint), /diff -qr --exclude='\.git' "\$sandbox_pristine" "\$sandbox_workspace"/);
  assert.match(runner.slice(final, checkpoint), /rejecting the Session before checkpoint save/);
  const restoreStart = runner.indexOf('restore_repair_checkpoint() {');
  const restoreEnd = runner.indexOf('\nsave_test_author_checkpoint() {', restoreStart);
  const restore = runner.slice(restoreStart, restoreEnd);
  assert.match(restore, /"\$task_type" == "diagnosis"/);
  assert.match(restore, /"\$diagnosis_readonly_checker"[\s\S]+"\$repair_checkpoint\/raw\.native\.jsonl"/);
  assert.match(restore, /discarding diagnosis repair checkpoint with a write attempt/);
});

test('production trajectory validation hard-enforces diagnosis read-only audit', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const validatorStart = source.indexOf('async function runTrajectoryValidator');
  const validatorEnd = source.indexOf('\nexport async function createCurrentQualityReviewBundle', validatorStart);
  const validator = source.slice(validatorStart, validatorEnd);
  assert.match(validator, /task\.taskType === 'diagnosis'/);
  assert.match(validator, /mutation-audit\.jsonl/);
  assert.match(validator, /validateDiagnosisReadOnlyEvents/);
  assert.match(validator, /requireAudit: true/);
  assert.match(validator, /basic-integrity\+diagnosis-read-only/);
});

test('Claude task runner terminates a hanging upstream process after permission denial', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const functionStart = runner.indexOf('terminate_claude_pipeline_siblings() {');
  const functionEnd = runner.indexOf('\n\nstart_progress_watcher() {', functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const script = [
    'set +e',
    runner.slice(functionStart, functionEnd),
    'pipeline_parent_pid="$$"',
    'sleep 30 &',
    'upstream_pid=$!',
    '( terminate_claude_pipeline_siblings "$pipeline_parent_pid" )',
    'wait "$upstream_pid"',
    'upstream_exit=$?',
    '[[ "$upstream_exit" -eq 143 ]]',
  ].join('\n');
  const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 2_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('Claude task runner gives diagnosis sessions an unambiguous read-only prompt', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const promptStart = runner.indexOf('append_system_prompt="Work only on the user request');
  const promptBranch = runner.indexOf('if [[ "$task_type" == "diagnosis" ]]', promptStart);
  const toolPolicy = runner.indexOf('disallowed_tools=(', promptBranch);
  const promptBlock = runner.slice(promptStart, toolPolicy);

  assert.ok(promptStart >= 0 && promptBranch > promptStart && toolPolicy > promptBranch);
  assert.match(promptBlock, /This is a read-only diagnosis task/);
  assert.match(promptBlock, /workspace is intentionally read-only/);
  assert.match(promptBlock, /do not attempt a fix/);
  assert.match(promptBlock, /Never invoke Edit, Write, NotebookEdit, shell redirection, chmod/);
  assert.match(promptBlock, /else[\s\S]+This is a bugfix task[\s\S]+make the smallest appropriate production fix/);
  assert.doesNotMatch(promptBlock.slice(0, promptBranch - promptStart), /make the smallest appropriate production fix|After locating the implementation cause/);
});

test('Claude runner resumes an empty-audit publish checkpoint without rerunning Claude or Docker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-publish-resume-test-'));
  const taskDir = path.join(root, 'library', 'tasks', 'task-one');
  const monitor = path.join(root, 'monitor');
  const checkpoint = path.join(taskDir, '.publish-checkpoint');
  const verificationSource = path.join(taskDir, 'verification-test-resume');
  const publishMarker = path.join(root, 'publisher-called.txt');
  const publishCount = path.join(root, 'publisher-count.txt');
  const claudeMarker = path.join(root, 'claude-called.txt');
  const dockerMarker = path.join(root, 'docker-called.txt');
  const promptContent = 'unused because the publish checkpoint must be resumed\n';
  const pristineContent = 'package resumed\n\nconst Value = 0\n';
  const verificationContent = 'package resumed\n\nfunc TestModelResume(t *testing.T) {}\n';
  const verificationSha256 = createHash('sha256').update(verificationContent).digest('hex');
  const promptSha256 = createHash('sha256').update(promptContent).digest('hex');
  const pristineFileSha256 = createHash('sha256').update(pristineContent).digest('hex');
  const pristineSha256 = createHash('sha256')
    .update(Buffer.concat([Buffer.from('./value.go\0'), Buffer.from(`${pristineFileSha256}  ./value.go\n`)]))
    .digest('hex');
  try {
    await Promise.all([
      mkdir(path.join(taskDir, 'workspace'), { recursive: true }),
      mkdir(path.join(taskDir, 'pristine'), { recursive: true }),
      mkdir(path.join(taskDir, 'grader'), { recursive: true }),
      mkdir(path.join(checkpoint, 'workspace'), { recursive: true }),
      mkdir(path.join(verificationSource, 'api'), { recursive: true }),
      mkdir(path.join(monitor, 'scripts'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
        task_type: 'bugfix',
        workflow_version: 3,
        user_query: promptContent.trim(),
        verification_test_overlay: 'repository-tests',
        verification_test_files: ['api/model_resume_test.go'],
        verification_test_manifest: [{ path: 'api/model_resume_test.go', sha256: verificationSha256 }],
        verification_test_sha256: verificationSha256,
        verification_test_source_dir: verificationSource,
      })}\n`),
      writeFile(path.join(taskDir, 'PROMPT.md'), promptContent),
      writeFile(path.join(taskDir, 'workspace', 'value.go'), 'package resumed\n\nconst Value = 0\n'),
      writeFile(path.join(taskDir, 'pristine', 'value.go'), pristineContent),
      writeFile(path.join(checkpoint, 'workspace', 'value.go'), 'package resumed\n\nconst Value = 1\n'),
      writeFile(path.join(checkpoint, 'checkpoint.json'), `${JSON.stringify({
        version: 1,
        stage: 'docker_complete',
        session_id: 'resume-session',
        task_type: 'bugfix',
        workflow_version: 3,
        prompt_sha256: promptSha256,
        pristine_sha256: pristineSha256,
      })}\n`),
      writeFile(path.join(checkpoint, 'trajectory.stream.jsonl'), '{"type":"result"}\n'),
      writeFile(path.join(checkpoint, 'raw.native.jsonl'), '{"type":"assistant"}\n'),
      writeFile(path.join(checkpoint, 'trajectory.jsonl'), '{"type":"assistant"}\n'),
      writeFile(path.join(checkpoint, 'mutation-audit.jsonl'), ''),
      writeFile(path.join(checkpoint, 'runner-manifest.json'), '{}\n'),
      writeFile(path.join(verificationSource, 'api', 'model_resume_test.go'), verificationContent),
      symlink(
        path.resolve(import.meta.dirname, '../scripts/run-with-timeout.mjs'),
        path.join(monitor, 'scripts', 'run-with-timeout.mjs'),
      ),
      writeFile(path.join(monitor, 'scripts', 'run-docker-task-grader.sh'), `#!/bin/bash\nprintf 'docker ran\\n' >${shellSingleQuote(dockerMarker)}\nexit 99\n`),
      writeFile(path.join(monitor, 'publish_test_model_fix.sh'), `#!/bin/bash\ncount=$(cat ${shellSingleQuote(publishCount)} 2>/dev/null || printf 0)\ncount=$((count + 1))\nprintf '%s\\n' "$count" >${shellSingleQuote(publishCount)}\nprintf '%s\\n' "$*" >${shellSingleQuote(publishMarker)}\nif [[ "$count" -eq 1 ]]; then\n  echo 'simulated transient Git failure' >&2\n  exit 1\nfi\nprintf '1111111111111111111111111111111111111111\\n'\n`),
      writeFile(path.join(root, 'fake-claude.sh'), `#!/bin/bash\nprintf 'claude ran\\n' >${shellSingleQuote(claudeMarker)}\nexit 99\n`),
    ]);
    await Promise.all([
      chmod(path.join(monitor, 'scripts', 'run-docker-task-grader.sh'), 0o755),
      chmod(path.join(monitor, 'publish_test_model_fix.sh'), 0o755),
      chmod(path.join(root, 'fake-claude.sh'), 0o755),
    ]);

    const result = spawnSync('/bin/bash', [path.resolve(import.meta.dirname, '../run_one_claude.sh'), taskDir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        TMPDIR: root,
        GO_PIPELINE_MONITOR_ROOT: monitor,
        GO_PIPELINE_CLAUDE_BIN: path.join(root, 'fake-claude.sh'),
        GO_PIPELINE_GIT_PUBLISH_RETRY_DELAY_SECONDS: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /resuming validated Claude checkpoint/);
    assert.match(result.stderr, /Git publication failed \(1\/3\)/);
    assert.equal(await readFile(publishCount, 'utf8'), '2\n');
    assert.match(await readFile(publishMarker, 'utf8'), /resume-session/);
    await assert.rejects(readFile(claudeMarker, 'utf8'), /ENOENT/);
    await assert.rejects(readFile(dockerMarker, 'utf8'), /ENOENT/);
    assert.equal(await readFile(path.join(taskDir, 'trajectory', 'mutation-audit.jsonl'), 'utf8'), '');
    assert.match(await readFile(path.join(taskDir, 'workspace', 'value.go'), 'utf8'), /Value = 1/);
    assert.equal(
      await readFile(path.join(taskDir, 'workspace', 'api', 'model_resume_test.go'), 'utf8'),
      verificationContent,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pipeline runner allows a real compiler descendant to finish without source changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-compiler-progress-test-'));
  const progress = path.join(directory, 'workspace-progress.json');
  const compiler = path.join(directory, 'compile');
  try {
    await symlink('/bin/sleep', compiler);
    const result = await runCommand('/bin/bash', ['-c', `${shellSingleQuote(compiler)} 0.35 & wait`], {
      timeoutMs: 2_000,
      idleTimeoutMs: 1_000,
      progressPaths: [progress],
      progressTimeoutMs: 120,
      activeWorkGraceMs: 500,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.progressTimedOut, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Git publication timeout terminates the entire stalled process tree', () => {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, '../scripts/run-with-timeout.mjs'),
    '1',
    '/bin/bash',
    '-c',
    'sleep 30 & wait',
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 124, result.stderr || result.stdout);
  assert.match(result.stderr, /exceeded 1 second timeout/);
  assert.ok(Date.now() - startedAt < 4_000, `timeout took ${Date.now() - startedAt}ms`);
});

test('an active compiler cannot refresh the real-progress timeout indefinitely', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bounded-compiler-test-'));
  const progress = path.join(directory, 'workspace-progress.json');
  const compiler = path.join(directory, 'compile');
  try {
    await symlink('/bin/sleep', compiler);
    const result = await runCommand('/bin/bash', ['-c', `${shellSingleQuote(compiler)} 2 & wait`], {
      timeoutMs: 3_000,
      idleTimeoutMs: 2_500,
      progressPaths: [progress],
      progressTimeoutMs: 120,
      activeWorkGraceMs: 180,
    });
    assert.equal(result.progressTimedOut, true);
    assert.match(result.error, /真实文件进展/);
    assert.ok(result.durationMs < 1_500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline termination removes descendants that created independent process groups', async () => {
  const root = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    "process.stdout.write(String(child.pid) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join(' ')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(root.stdout, 'data');
  const descendantPid = Number(String(chunk).trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
  const result = await terminateProcessTree(root.pid, { graceMs: 50 });
  await Promise.race([once(root, 'close'), new Promise((resolve) => setTimeout(resolve, 500))]);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(root.pid), false);
  assert.equal(alive(descendantPid), false);
  assert.ok(result.terminated.includes(root.pid));
});

test('pipeline progress timeout also removes an independent tool process group', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-timeout-tree-test-'));
  const marker = path.join(directory, 'workspace-progress.json');
  const pidFile = path.join(directory, 'descendant.pid');
  try {
    const result = await runCommand(process.execPath, ['-e', [
      "const fs = require('fs');",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => process.stdout.write('CLAUDE_PROGRESS\\n'), 25);",
    ].join(' ')], {
      timeoutMs: 3_000,
      idleTimeoutMs: 1_500,
      progressPaths: [marker],
      progressTimeoutMs: 500,
    });
    const descendantPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(result.progressTimedOut, true);
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner terminates continuous log output without real file progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-progress-stall-test-'));
  const marker = path.join(directory, 'workspace-progress.json');
  try {
    const result = await runCommand(process.execPath, ['-e', "setInterval(() => process.stdout.write('CLAUDE_PROGRESS\\n'), 10)"], {
      timeoutMs: 2_000,
      idleTimeoutMs: 500,
      progressPaths: [marker],
      progressTimeoutMs: 120,
    });
    assert.equal(result.progressTimedOut, true);
    assert.match(result.error, /真实文件进展/);
    assert.equal(result.timedOut, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline stop signals retain their origin instead of impersonating a user stop', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(pipeline, /stop-request\.json/);
  assert.match(pipeline, /job\.lastStopRequest = stopRequest/);
  assert.match(pipeline, /请求来源：/);
  assert.match(pipeline, /watchdog_retry: '系统看门狗终止并重试'/);
  assert.match(pipeline, /external_signal: '外部进程信号'/);
  assert.doesNotMatch(pipeline, /action: signal === 'SIGTERM' \? 'user_stopped'/);
  assert.match(server, /runnerPid = Number\(activePipelineProcesses\.get\(jobId\)\?\.pid\) \|\| null/);
  assert.match(server, /delete current\.manualHold/);
  assert.match(server, /writePipelineStopRequest\(incident\.jobId, 'watchdog_retry', 'pipeline_watchdog'\)/);
  assert.match(server, /writePipelineStopRequest\(jobId, 'emergency_stop', 'scheduler_control'\)/);
  assert.match(server, /reason: 'user_switched'/);
  assert.match(server, /await stopPipelineJob\(jobId, \{ pauseScheduling: false \}\);/);
  assert.match(server, /其他任务和自动补位继续运行/);
  assert.match(server, /const resumeWhilePaused = pipelineControlMode === 'paused'/);
  assert.match(server, /startPipelineJob\(jobId, \{ externalResume: resumeWhilePaused \}\)/);
  assert.match(server, /if \(!resumeWhilePaused\) await fillPipelineSlots\(\)/);
});

test('post-Claude delivery cannot silently launch a new repair without a trusted checkpoint', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /checkpointRoots = \['\.publish-checkpoint', '\.repair-checkpoint'\]/);
  assert.match(pipeline, /String\(checkpoint\.session_id \|\| ''\) !== expectedSessionId/);
  assert.match(pipeline, /\[system:repair_checkpoint\][^`]+已阻止重复运行 Claude/);
});

test('fresh Claude sessions receive ordinary project context without acceptance-gate feedback', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  assert.doesNotMatch(runner, /\.retry-feedback|Retry feedback from the system-side acceptance gate|retry_feedback/);
  assert.doesNotMatch(runner, /repair_trajectory_auditor|audit-repair-trajectory|repair trajectory hard audit failed/);
  assert.match(runner, /focused ordinary Go tests, focused package builds, and public reproduction commands/);
  assert.match(runner, /Bash\(\*verify_cmds\*\)/);
  assert.doesNotMatch(runner, /Bash\(go test \*\)/);
  assert.match(runner, /Bash\(\*go test \.\/\.\.\.\*\)/);
  assert.match(runner, /Bash\(\*go vet \.\/\.\.\.\*\)/);
  assert.match(runner, /Bash\(\*go build \.\/\.\.\.\*\)/);
  assert.doesNotMatch(runner, /prune_repair_material/);
  assert.doesNotMatch(runner, /Early public-test coverage checklist/);
  assert.match(runner, /follow its direct call chain; avoid surveying unrelated packages/);
  assert.match(runner, /Run only an explicitly public reproduction/);
  assert.match(runner, /Do not run broad go test \.\/\.\.\., go vet \.\/\.\.\., go build \.\/\.\.\., Docker/);
  assert.match(runner, /Do not author any new bug-specific test, TestModel_ test, helper, script, or fixture/);
  assert.match(runner, /never create a new TestModel_ or other bug-specific test/);
  assert.match(runner, /-iname 'BUG_REPRO\*'/);
  assert.doesNotMatch(runner, /-iname '\*answer\*'|-iname '\*solution\*'|-iname '\*patch\*'|-iname '\*gold\*'/);
  assert.match(runner, /deny file-read\* \(subpath \\"\$project_root\\"\)/);
  assert.match(runner, /allow file-read\* \(subpath \\"\$work_root\/toolchains\\"\)/);
  assert.match(runner, /requires sandbox-exec; refusing to run without filesystem read isolation/);
  assert.match(runner, /exit 79/);
});

test('critical datastore snapshots include metadata but exclude live workspaces and artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'go-critical-snapshot-test-'));
  try {
    const files = [
      ['pipeline-jobs/job-a/job.json', '{}\n'],
      ['pipeline-jobs/job-a/artifacts/live.jsonl', '{}\n'],
      ['tasks/task-a/public.json', '{}\n'],
      ['tasks/task-a/workspace/main.go', 'package main\n'],
      ['validation/reviews.json', '{}\n'],
      ['validation/cloud_session.json', '{"cookie":"secret"}\n'],
      ['validation/cloud_session 2.json', '{"cookie":"secret-copy"}\n'],
      ['pipeline-refill/scheduler.json', '{}\n'],
      ['pipeline-refill/health.json', '{}\n'],
    ];
    for (const [relative, content] of files) {
      const filename = path.join(root, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content);
    }
    const selected = (await criticalDatastoreFiles(root)).map((filename) => path.relative(root, filename));
    assert.deepEqual(selected, [
      'pipeline-jobs/job-a/job.json',
      'pipeline-refill/scheduler.json',
      'tasks/task-a/public.json',
      'validation/reviews.json',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project generation timeout is bounded by the remaining attempt budget', () => {
  assert.equal(remainingProjectGenerationTimeout(50_000, 30_000, 10_000), 30_000);
  assert.equal(remainingProjectGenerationTimeout(25_000, 30_000, 10_000), 15_000);
  assert.throws(() => remainingProjectGenerationTimeout(10_000, 30_000, 10_000), /当前总预算/);
});

test('project generation uses an unlimited timeout sentinel', () => {
  assert.equal(remainingProjectGenerationTimeout(Infinity, 30_000, 10_000), 0);
});

test('verification finalization persists independent proof URLs from the task directory', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'verification-finalize-'));
  try {
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      task_type: 'bugfix',
      verification_evidence: {
        pre_fix: {
          trajectory_url: 'https://cos.example.test/trajectory_11111111-1111-4111-8111-111111111111.jsonl',
          session_id: '11111111-1111-4111-8111-111111111111',
          result: 'red',
          uploaded_at: '2026-08-18T15:00:00.000Z',
        },
        post_fix: {
          trajectory_url: 'https://cos.example.test/trajectory_22222222-2222-4222-8222-222222222222.jsonl',
          session_id: '22222222-2222-4222-8222-222222222222',
          result: 'green',
          uploaded_at: '2026-08-18T15:01:00.000Z',
        },
      },
    }, null, 2)}\n`);
    const result = await finalizeVerificationResult(taskDir, '33333333-3333-4333-8333-333333333333');
    assert.equal(result.pre_fix.result, 'red');
    assert.equal(result.post_fix.result, 'green');
    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.deepEqual(JSON.parse(metadata.verify_result), result);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('verification finalization refuses to create JSON before proof upload', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'verification-finalize-upload-gate-'));
  try {
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      task_type: 'diagnosis',
      verification_evidence: {
        pre_fix: {
          session_id: '11111111-1111-4111-8111-111111111111',
          result: 'red',
          local_manifest: 'verification/pre_fix/attempt-1/manifest.json',
        },
      },
    }, null, 2)}\n`);
    await assert.rejects(
      finalizeVerificationResult(taskDir, '33333333-3333-4333-8333-333333333333'),
      /pre_fix 修复证明尚未完成云盘上传/,
    );
    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.equal(Object.hasOwn(metadata, 'verify_result'), false);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('published private verification fixture is materialized only after Git publication', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'verification-fixture-promotion-'));
  try {
    const testFile = 'internal/service/model_release_test.go';
    const fixtureDir = path.join(taskDir, 'private-verification-bug1');
    const source = 'package service\n\nimport "testing"\n\nfunc TestModel_Release(t *testing.T) {}\n';
    const sha256 = createHash('sha256').update(source).digest('hex');
    await mkdir(path.join(fixtureDir, 'internal/service'), { recursive: true });
    await writeFile(path.join(fixtureDir, testFile), source);
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      verification_test_overlay: 'private-fixture',
      verification_test_files: [testFile],
      verification_fixture_dir: fixtureDir,
      verification_fixture_sha256: sha256,
      verification_fixture_published: true,
    }, null, 2)}\n`);

    const promoted = await promotePublishedVerificationFixture(taskDir);
    assert.deepEqual(promoted, { promoted: true, testFile, sha256 });
    assert.equal(await readFile(path.join(taskDir, 'workspace', testFile), 'utf8'), source);
    const metadata = JSON.parse(await readFile(path.join(taskDir, 'public.json'), 'utf8'));
    assert.equal(metadata.verification_test_overlay, 'repository-tests');
    assert.deepEqual(metadata.verification_test_manifest, [{ path: testFile, sha256 }]);
    assert.equal(metadata.verification_fixture_materialized, true);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('private verification fixture cannot be promoted before Git publication', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'verification-fixture-unpublished-'));
  try {
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      verification_test_overlay: 'private-fixture',
      verification_fixture_published: false,
    }, null, 2)}\n`);
    await assert.rejects(
      promotePublishedVerificationFixture(taskDir),
      /私有验证夹具尚未发布到提交仓库/,
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('Codex bug discovery schema requires every declared property', () => {
  assert.deepEqual(new Set(bugSchema.required), new Set(Object.keys(bugSchema.properties)));
  const legacy = bugSchemaForPolicy(BUG_TAXONOMY_POLICY_VERSION);
  assert.deepEqual(new Set(legacy.required), new Set(Object.keys(legacy.properties)));
  assert.equal(Object.hasOwn(legacy.properties, 'runtime_mechanisms'), false);
  assert.equal(Object.hasOwn(bugSchemaForPolicy(BUG_DIFFICULTY_POLICY_VERSION).properties, 'runtime_mechanisms'), true);
});

test('project-level Bug discovery pools candidates and selects only batch-reviewed unique records', () => {
  const makeBug = (bugId, targetFile, symbol, suffix = '') => ({
    found: true,
    reason: `公开工作流可以稳定复现该候选问题${suffix}，并能观察到持久化状态与接口结果不一致。`,
    bug_id: bugId,
    title: `事务状态传播异常${suffix}`,
    task_subtype: '业务逻辑修复',
    bug_category: 'error',
    user_query: `操作员通过公开接口提交批次${suffix}后收到失败响应，但重启查询发现状态已经部分写入，请修复事务边界并保持幂等重试行为。`,
    target_files: [targetFile],
    symbols: [symbol],
    failure_mechanism: `${symbol} 在事务中先写入聚合状态，再把后续领域错误返回给通用封装；封装没有撤销前一项写入，重启读取因此暴露半提交状态${suffix}。`,
    reproduction_evidence: `通过公开接口触发${suffix}后响应为失败，关闭并重新打开数据库仍能读取到本应回滚的聚合状态。`,
    reproduction_command: '',
    success_criteria: `失败请求不得留下任何聚合状态${suffix}；成功请求、同内容幂等重试、重启恢复、全量测试和静态检查保持通过。`,
    runtime_mechanisms: ['transaction_atomicity', 'error_propagation_or_partial_failure', 'persistence_recovery_or_replay'],
    affected_layers: ['command_or_api', 'service_or_orchestration', 'persistence_or_transaction', 'external_observable_behavior'],
    state_or_resource_impact: `数据库中的批次状态${suffix}在失败事务后仍被提交，重启恢复会把该半成品当成有效聚合。`,
    difficulty_evidence: `公开请求先跨入服务层和事务层写入状态${suffix}，后续领域错误经封装传播到接口；定位需要联合检查 API、事务提交、错误映射和重启读取，验证还必须覆盖失败后的持久化状态。`,
  });
  const first = makeBug('batch-partial-commit', 'internal/store/tx.go', 'Store.WithTx', '甲');
  const duplicate = {
    ...structuredClone(first),
    bug_id: 'same-partial-commit',
    title: '事务错误返回后仍保留部分状态',
    failure_mechanism: 'Store.WithTx 先持久化聚合记录，随后才传播领域失败；事务包装器在错误路径仍提交写入，因此重新加载时会读到失败请求留下的半成品。',
  };
  const second = makeBug('replay-stale-state', 'internal/replay/recover.go', 'Recover.Load', '乙');
  const finders = [
    { partition: 'public-domain', sessionId: 'session-a', output: { candidates: [first] } },
    { partition: 'state-lifecycle', sessionId: 'session-b', output: { candidates: [duplicate, second] } },
  ];
  const request = { bugCount: 10, bugPolicyVersion: BUG_DIFFICULTY_POLICY_VERSION };
  const normalized = normalizeBugCandidateFinders(finders, [], { request });
  assert.deepEqual(normalized.candidates.map((item) => item.candidate.bug_id), ['batch-partial-commit', 'replay-stale-state']);
  assert.equal(normalized.rejected.some((item) => item.bugId === 'same-partial-commit'), true);

  const selected = selectReviewedBugCandidates(finders, {
    reviews: [
      { bug_id: 'batch-partial-commit', approved: true, score: 4, summary: '跨事务边界证据完整', issues: [] },
      { bug_id: 'replay-stale-state', approved: true, score: 5, summary: '恢复链路证据更强', issues: [] },
    ],
  }, [], { limit: 1, request });
  assert.equal(selected.selected.length, 1);
  assert.equal(selected.selected[0].candidate.bug_id, 'replay-stale-state');
  assert.equal(selected.selected[0].finderSessionId, 'session-b');
  assert.equal(selected.rejected.some((item) => item.bugId === 'same-partial-commit'), true);

  const lowDifficulty = selectReviewedBugCandidates(finders, {
    reviews: [
      { bug_id: 'batch-partial-commit', approved: true, score: NATURAL_BUG_MIN_REVIEW_SCORE - 1, summary: '证据不足', issues: [] },
      { bug_id: 'replay-stale-state', approved: true, score: NATURAL_BUG_MIN_REVIEW_SCORE, summary: '跨层证据充分', issues: [] },
    ],
  }, [], { limit: 10, request });
  assert.deepEqual(lowDifficulty.selected.map((item) => item.candidate.bug_id), ['replay-stale-state']);
  assert.match(lowDifficulty.rejected.find((item) => item.bugId === 'batch-partial-commit').reason, /评分/);
});

test('batch Bug schemas bound finder and reviewer output sizes', () => {
  const pool = bugCandidatePoolSchema(BUG_DIFFICULTY_POLICY_VERSION, 7);
  const review = bugCandidateReviewSchema(14);
  assert.equal(pool.properties.candidates.maxItems, 7);
  assert.equal(pool.properties.candidates.items, bugSchema);
  for (const field of ['reason', 'title', 'user_query', 'failure_mechanism', 'reproduction_evidence', 'success_criteria', 'state_or_resource_impact', 'difficulty_evidence']) {
    assert.match(pool.properties.candidates.items.properties[field].description, /Chinese/, `${field} must carry the Chinese narrative contract in the schema`);
  }
  assert.equal(review.properties.reviews.maxItems, 14);
  assert.deepEqual(review.properties.reviews.items.required, ['bug_id', 'approved', 'score', 'summary', 'issues']);
});

test('every batch Bug producer receives the Chinese narrative contract', async () => {
  const instruction = bugNarrativeLanguageInstruction();
  assert.match(instruction, /reason/);
  assert.match(instruction, /title/);
  assert.match(instruction, /success_criteria/);
  assert.match(instruction, /Chinese/);
  assert.match(instruction, /hard output-schema requirement/);
  assert.match(instruction, /Go identifiers/);

  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const naturalFinder = pipeline.slice(
    pipeline.indexOf('function naturalBugFinderPrompt'),
    pipeline.indexOf('async function runNaturalBugFinder'),
  );
  const injectionPlanner = pipeline.slice(
    pipeline.indexOf('async function ensureInjectionPlan'),
    pipeline.indexOf('async function injectionPlanAssignment'),
  );
  assert.match(naturalFinder, /bugNarrativeLanguageInstruction\(\)/);
  assert.match(injectionPlanner, /bugNarrativeLanguageInstruction\(\)/);
});

test('natural Bug recovery seeds stay inside artifacts and enter as one finder pool', async () => {
  const jobDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-natural-seed-test-'));
  const artifacts = path.join(jobDir, 'artifacts');
  const artifact = path.join(artifacts, 'recovered.json');
  try {
    await mkdir(artifacts);
    await writeFile(artifact, `${JSON.stringify({ scope_summary: '恢复历史技术候选并重新执行正式审核。', candidates: [{ bug_id: 'recovered-one' }] })}\n`);
    const result = await naturalBugCandidateSeedResult(jobDir, {
      artifact: 'artifacts/recovered.json',
      sessionId: 'recovery-session',
    });
    assert.equal(result.partition, 'recovered-candidates');
    assert.equal(result.sessionId, 'recovery-session');
    assert.equal(result.output.candidates[0].bug_id, 'recovered-one');
    await assert.rejects(
      naturalBugCandidateSeedResult(jobDir, { artifact: '../outside.json' }),
      /路径越出流水线作业目录/,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('incremental injection planning retains valid candidates and replaces only rejected records', () => {
  const makeBug = (bugId, file, symbol, text) => ({
    found: true,
    reason: `公开工作流能够稳定观察到${text}导致的事务状态异常。`,
    bug_id: bugId,
    title: `${text}导致状态传播异常`,
    task_subtype: '业务逻辑修复',
    bug_category: 'error',
    user_query: `操作员执行${text}后接口返回失败，但重新读取持久化记录发现状态已被部分提交，请修复事务边界并保持正常流程。`,
    target_files: [file],
    symbols: [symbol],
    failure_mechanism: `${symbol} 先写入事务状态，再把后续领域错误交给服务层；服务层返回失败却没有回滚，重启恢复最终暴露半提交记录。`,
    reproduction_evidence: `通过公开接口执行${text}，响应失败后重新加载数据库可以稳定看到不应存在的记录。`,
    reproduction_command: '',
    success_criteria: `${text}失败不得留下记录；正常请求、重启恢复、全量测试与静态检查保持通过。`,
    runtime_mechanisms: ['transaction_atomicity', 'error_propagation_or_partial_failure', 'persistence_recovery_or_replay'],
    affected_layers: ['command_or_api', 'service_or_orchestration', 'persistence_or_transaction', 'external_observable_behavior'],
    state_or_resource_impact: `${text}失败后数据库遗留半提交状态，恢复流程会把它当成有效记录。`,
    difficulty_evidence: `定位${text}需要跨 API、服务事务、错误传播与重启恢复四个边界，并验证失败前后数据库状态。`,
  });
  const job = { request: { taskType: 'bugfix', bugCount: 10, bugPolicyVersion: BUG_DIFFICULTY_POLICY_VERSION } };
  const first = makeBug('reservation-partial-commit', 'internal/store/reserve.go', 'Store.Reserve', '预约容量冲突');
  const invalid = { ...makeBug('invalid-candidate', 'internal/store/invalid.go', 'Store.Invalid', '无效写入'), found: false };
  const rejectedIds = new Set();
  const rejectedFingerprints = new Set();
  const initial = retainValidInjectionPlanCandidates([first, invalid], { job, rejectedIds, rejectedFingerprints });
  assert.deepEqual(initial.accepted.map((item) => item.bug_id), ['reservation-partial-commit']);
  assert.deepEqual(initial.rejected.map((item) => item.bugId), ['invalid-candidate']);

  const replacement = makeBug('recovery-orphan-record', 'internal/recovery/load.go', 'Recovery.Load', '恢复孤立记录');
  const completed = retainValidInjectionPlanCandidates([replacement], {
    job,
    accepted: initial.accepted,
    rejectedIds,
    rejectedFingerprints,
  });
  assert.deepEqual(completed.accepted.map((item) => item.bug_id), ['reservation-partial-commit', 'recovery-orphan-record']);
  assert.equal(completed.rejected.length, 0);

  const reusedId = makeBug('invalid-candidate', 'internal/recovery/reconcile.go', 'Recovery.Reconcile', '恢复对账冲突');
  const renamed = retainValidInjectionPlanCandidates([reusedId], {
    job,
    accepted: completed.accepted,
    rejectedIds,
    rejectedFingerprints,
  });
  assert.equal(renamed.rejected.length, 0);
  assert.match(renamed.accepted.at(-1).bug_id, /^invalid-candidate-retry-[0-9a-f]{8}$/);

  const repeatedMutation = makeBug('different-id', 'internal/store/invalid.go', 'Store.Invalid', '无效写入');
  const duplicate = retainValidInjectionPlanCandidates([repeatedMutation], {
    job,
    accepted: completed.accepted,
    rejectedIds,
    rejectedFingerprints,
  });
  assert.equal(duplicate.accepted.length, completed.accepted.length);
  assert.match(duplicate.rejected[0].reason, /重复了已拒绝候选/);
});

test('injection planning splits a large remainder into bounded incremental batches', () => {
  const bugIndexes = Array.from({ length: 21 }, (_, index) => index + 10);
  assert.deepEqual(injectionPlanningBatch(bugIndexes, 0), {
    totalRemaining: 21,
    requestCount: 4,
    requestedSlots: [10, 11, 12, 13],
  });
  assert.deepEqual(injectionPlanningBatch(bugIndexes, 0, 7), {
    totalRemaining: 21,
    requestCount: 7,
    requestedSlots: [10, 11, 12, 13, 14, 15, 16],
  });
  assert.deepEqual(injectionPlanningBatch(bugIndexes, 14, 7), {
    totalRemaining: 7,
    requestCount: 7,
    requestedSlots: [24, 25, 26, 27, 28, 29, 30],
  });
  assert.deepEqual(injectionPlanningBatch(bugIndexes, 21, 7), {
    totalRemaining: 0,
    requestCount: 0,
    requestedSlots: [],
  });
});

test('Bug source concurrency follows analysis-pool occupancy and real host pressure', () => {
  const healthy = { memoryAvailablePercent: 62, loadRatio: 1.2, diskUsedPercent: 91 };
  assert.equal(adaptiveBugSourceWorkerLimit({ resources: healthy, analysisRunnerCount: 1, analysisPoolLimit: 4 }), 4);
  assert.equal(adaptiveBugSourceWorkerLimit({ resources: healthy, analysisRunnerCount: 2, analysisPoolLimit: 4 }), 2);
  assert.equal(adaptiveBugSourceWorkerLimit({ resources: healthy, analysisRunnerCount: 4, analysisPoolLimit: 4 }), 1);
  assert.equal(adaptiveBugSourceWorkerLimit({ resources: { ...healthy, memoryAvailablePercent: 30 }, analysisRunnerCount: 1 }), 2);
  assert.equal(adaptiveBugSourceWorkerLimit({ resources: { ...healthy, loadRatio: 3.1 }, analysisRunnerCount: 1 }), 1);
});

test('injected candidate deterministic gates run before model scope review', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const start = pipeline.indexOf('const injection = await validateInjectedBugWorktree');
  const end = pipeline.indexOf("await git(bugBaseDir, ['add', '-A']);", start);
  const confirmation = pipeline.slice(start, end);
  const tests = confirmation.indexOf("await runRequired('Injected candidate full tests'");
  const vet = confirmation.indexOf("await runRequired('Injected candidate static checks'");
  const review = confirmation.indexOf('await reviewBroadInjectedBug');
  assert.ok(start >= 0 && end > start);
  assert.ok(tests >= 0 && vet > tests && review > vet);
  assert.match(confirmation, /\['test', '-timeout=5m', '\.\/\.\.\.'\]/);
});

test('controlled injection rejects baseline defects before accepting a writer result', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /controlled mutation planning, not natural Bug discovery/);
  assert.match(pipeline, /current baseline must enforce the correct retained invariant/i);
  assert.match(pipeline, /return found=false and begin reason with BASELINE_ALREADY_DEFECTIVE/);
  assert.match(pipeline, /result\.output\?\.found !== true/);
  assert.match(pipeline, /Bug injection must produce a real production diff against the frozen main/);
});

test('project Bug workers use four healthy lanes and degrade under pressure', async () => {
  const { adaptiveProjectBugWorkerLimit } = await import('../scripts/run-production-pipeline.mjs');
  const gib = 1024 ** 3;
  const healthy = {
    diskUsedPercent: 40,
    diskFreeBytes: 300 * gib,
    memoryAvailablePercent: 60,
    loadRatio: 1.2,
  };
  assert.equal(adaptiveProjectBugWorkerLimit({ resources: healthy, activeRunnerCount: 1 }), 4);
  assert.equal(adaptiveProjectBugWorkerLimit({ resources: healthy, activeRunnerCount: 2 }), 2);
  assert.equal(adaptiveProjectBugWorkerLimit({ resources: { ...healthy, loadRatio: 2.7 }, activeRunnerCount: 1 }), 2);
  assert.equal(adaptiveProjectBugWorkerLimit({ resources: { ...healthy, loadRatio: 3.2 }, activeRunnerCount: 1 }), 1);
  assert.equal(adaptiveProjectBugWorkerLimit({
    configuredMin: 2,
    resources: { ...healthy, loadRatio: 3.2 },
    activeRunnerCount: 4,
  }), 2);
  assert.equal(adaptiveProjectBugWorkerLimit({
    configuredMax: 1,
    configuredMin: 2,
    resources: healthy,
    activeRunnerCount: 1,
  }), 1);
});

test('an idle project slot is lent to the active project with the most remaining Bugs', () => {
  const activeJobs = [
    { id: 'job-small-a', status: 'running', bugs: [{ workbench: { status: 'fast_lane_running' } }] },
    { id: 'job-large', status: 'running', bugs: Array.from({ length: 5 }, () => ({ workbench: { status: 'fast_lane_stopped' } })) },
    { id: 'job-small-b', status: 'running', bugs: [{ workbench: { status: 'bug_ready' } }] },
  ];
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-large', baseLimit: 2, activeJobs, projectCapacity: 4 }), 3);
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-small-a', baseLimit: 2, activeJobs, projectCapacity: 4 }), 2);
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-small-b', baseLimit: 2, activeJobs, projectCapacity: 4 }), 2);
});

test('a project worker override can raise only that project to four healthy lanes', () => {
  const activeJobs = [
    { id: 'job-priority', status: 'running', bugWorkerLimitOverride: 4, bugs: Array.from({ length: 6 }, () => ({ workbench: { status: 'bug_ready' } })) },
    { id: 'job-other-a', status: 'running', bugs: [{ workbench: { status: 'bug_ready' } }] },
    { id: 'job-other-b', status: 'running', bugs: [{ workbench: { status: 'bug_ready' } }] },
  ];
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-priority', baseLimit: 2, activeJobs, projectCapacity: 4 }), 4);
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-other-a', baseLimit: 2, activeJobs, projectCapacity: 4 }), 2);
  assert.equal(elasticProjectBugWorkerLimit({ jobId: 'job-priority', baseLimit: 2, maxWorkerLimit: 2, activeJobs, projectCapacity: 4 }), 2);
});

test('an explicit project worker limit survives degraded load while starts remain allowed', () => {
  assert.equal(projectBugWorkerCeiling({
    baseLimit: 1,
    resourceLimit: 1,
    workerLimitOverride: 4,
    canStart: true,
  }), 4);
  assert.equal(projectBugWorkerCeiling({
    baseLimit: 1,
    resourceLimit: 1,
    workerLimitOverride: 4,
    canStart: false,
  }), 1);
  assert.equal(projectBugWorkerCeiling({
    baseLimit: 1,
    resourceLimit: 1,
  }), 1);
});

test('an adaptive Bug worker pool grows without interrupting its current worker', async () => {
  let targetLimit = 1;
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let reportSecondStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondStarted = new Promise((resolve) => { reportSecondStarted = resolve; });
  const started = [];
  const run = runAdaptiveBoundedWorkers([1, 2, 3], 1, async (item) => {
    started.push(item);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (item === 1) await firstGate;
    if (item === 2) reportSecondStarted();
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, {
    refreshLimit: async () => targetLimit,
    refreshIntervalMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  targetLimit = 2;
  await secondStarted;
  releaseFirst();
  await run;
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maxActive, 2);
});

test('pipeline runner builds a natural-language Gold root cause from structured causal fields', () => {
  const gold = {
    root_cause_file: 'internal/queue/queue.go',
    root_cause_symbols: ['Queue.Pop'],
    internal_cause: 'Queue.Pop 未检查底层切片长度便准备读取首元素',
    propagation_path: '空切片继续进入索引读取分支并访问不存在的下标',
    observable_failure: '空队列调用发生越界 panic',
    mechanism_keywords: ['长度检查', '首元素', '空队列'],
    test_package: './internal/queue',
    test_name: 'TestGoldB1_abc12345_EmptyQueue',
    verification_summary: '目标测试在基线失败并在最小修复后通过，全量测试和静态检查均通过。',
  };
  const normalized = validateGoldTestDescriptor(gold, {
    requiredPrefix: 'TestGoldB1_abc12345_',
    expectedFiles: ['internal/queue/queue.go'],
    expectedSymbols: ['(*Queue).Pop'],
  });
  assert.equal(
    normalized.gold_root_cause,
    'internal/queue/queue.go 中的 Queue.Pop 根本原因是Queue.Pop 未检查底层切片长度便准备读取首元素；空切片继续进入索引读取分支并访问不存在的下标，最终导致空队列调用发生越界 panic。',
  );
  assert.doesNotMatch(normalized.gold_root_cause, /问题文件：|问题符号：|失效机制：|传播过程是/);
});

test('Claude-only discovery root cause uses the natural legacy prose style', () => {
  const descriptor = discoveryRootCauseDescriptor({
    target_files: ['internal/store/store.go'],
    symbols: ['store.Store.WithTx'],
    failure_mechanism: 'store.Store.WithTx 对任意领域错误执行回滚，导致已经写入的拒绝记录丢失。',
  });
  assert.equal(
    descriptor.gold_root_cause,
    'internal/store/store.go 中的 store.Store.WithTx 根本原因是store.Store.WithTx 对任意领域错误执行回滚，导致已经写入的拒绝记录丢失。',
  );
  assert.doesNotMatch(descriptor.gold_root_cause, /问题文件：|问题符号：|失效机制：/);

  const normalizedCausality = discoveryRootCauseDescriptor({
    target_files: ['internal/store/leases.go'],
    symbols: ['store.Store.ReleaseLeasesForTask'],
    failure_mechanism: 'store.Store.ReleaseLeasesForTask 去掉 task_id 约束并释放所有任务的开放 lease，导致其他任务仍在使用的资源被错误解除占用。',
  });
  assert.equal(
    normalizedCausality.gold_root_cause,
    'internal/store/leases.go 中的 store.Store.ReleaseLeasesForTask 根本原因是store.Store.ReleaseLeasesForTask 去掉 task_id 约束并释放所有任务的开放 lease，导致其他任务仍在使用的资源被错误解除占用。',
  );
  assert.throws(
    () => discoveryRootCauseDescriptor({
      target_files: ['service/frames.go'],
      symbols: ['(*Engine).SubmitFrames'],
      failure_mechanism: 'The frame loop continues after a rejection and advances the persisted prefix.',
    }),
    /failure_mechanism 不是中文主体/,
  );
});

test('Gold validation treats source locations as the same implicated Go file', () => {
  const gold = {
    root_cause_file: 'internal/domain/domain.go',
    root_cause_symbols: ['Config.ValidateParams'],
    internal_cause: 'ValidateParams 错误使用非严格上界比较，将合法端点判断为越界。',
    propagation_path: '参数校验失败使 decideReport 提前返回错误并跳过状态更新。',
    observable_failure: '合法上界输入返回 PARAM_OUT_OF_RANGE，流程状态没有推进。',
    mechanism_keywords: ['非严格比较', '闭区间上界', '提前返回'],
    test_package: './internal/domain',
    test_name: 'TestGoldB1_abc12345_MaxTemperature',
    verification_summary: '目标测试在基线失败并在修复之后通过，全量测试和静态检查均通过。',
  };
  assert.doesNotThrow(() => validateGoldTestDescriptor(gold, {
    expectedFiles: ['internal/domain/domain.go:253', 'internal/domain/domain.go#L253'],
    expectedSymbols: ['Config.ValidateParams'],
  }));
});

test('Gold validation accepts a concrete arithmetic threshold mechanism', () => {
  const gold = {
    root_cause_file: 'bracket/bracket.go',
    root_cause_symbols: ['bracket.ScoreRule.WinnerSide'],
    internal_cause: 'ScoreGameScores 分支使用 (BestOf+1)/2 计算胜者门槛，偶数 BestOf 经整数除法只得到半数。',
    propagation_path: '该阈值使 WinnerSide 返回错误的合法性结果，进而进入提交分支。',
    observable_failure: 'BestOf=4 时 2-0 被接受，3-0 反而被拒绝。',
    mechanism_keywords: ['整数除法', '多数阈值', 'BestOf'],
    test_package: './...',
    test_name: 'TestGoldB3_EvenBestOfMajority',
  };
  assert.doesNotThrow(() => validateGoldTestDescriptor(gold));
});

test('Gold validation accepts a concrete call-and-commit propagation path', () => {
  const gold = {
    root_cause_file: 'internal/api/api.go',
    root_cause_symbols: ['decodeJSON'],
    internal_cause: 'decodeJSON 使用默认 json.Decoder 后直接成功返回，缺少 DisallowUnknownFields 检查。',
    propagation_path: '默认解码器不报错，使 handleConsent 越过请求校验分支并调用 RecordConsent，事务提交后修订对外可见。',
    observable_failure: '带未声明字段的请求返回 HTTP 200 并创建修订。',
    mechanism_keywords: ['DisallowUnknownFields', '请求校验', '事务提交'],
    test_package: './internal/api_test',
    test_name: 'TestGoldB5_RejectsUnknownField',
  };
  assert.doesNotThrow(() => validateGoldTestDescriptor(gold));
});

test('Gold validation accepts transactional partial-apply and strict-boundary mechanisms', () => {
  const partialApply = {
    root_cause_file: 'logstore/store.go',
    root_cause_symbols: ['logstore.Open', 'logstore.State.Apply'],
    internal_cause: 'logstore.Open 恢复记录时直接对已提交投影原地调用 State.Apply，后续事件失败时缺少基于副本的整事务提交控制。',
    propagation_path: '首个事件先更新投影，后续事件返回错误后停止重放，但已部分修改的投影被保留。',
    observable_failure: 'LastGoodSeq 没有前进，View 却包含被拒事务的状态。',
    mechanism_keywords: ['原地修改', '整事务提交', '部分应用'],
    test_package: './...',
    test_name: 'TestGoldB4_RecoveryAtomicity',
  };
  const deadlineEdge = {
    root_cause_file: 'internal/service/commands.go',
    root_cause_symbols: ['service.Service.SubmitReceipt'],
    internal_cause: 'SubmitReceipt 使用非严格截止比较 !now.Before(p.Deadline)，将时钟等于 Deadline 的情况错误归入过期分支。',
    propagation_path: '该分支在写入前返回过期错误，HTTP 层进而映射为冲突响应。',
    observable_failure: '合法截止时刻提交返回 DEADLINE_EXPIRED。',
    mechanism_keywords: ['非严格比较', '截止边界', '过期分支'],
    test_package: './...',
    test_name: 'TestGoldB5_DeadlineEquality',
  };
  assert.doesNotThrow(() => validateGoldTestDescriptor(partialApply));
  assert.doesNotThrow(() => validateGoldTestDescriptor(deadlineEdge));
});

test('pipeline runner accepts fully qualified Go method symbols', () => {
  const normalized = validateGoldTestDescriptor({
    root_cause_file: 'internal/service/service.go',
    root_cause_symbols: ['service.Service.SubmitDecision'],
    internal_cause: 'SubmitDecision 未检查决策类型白名单便进入终局分支',
    propagation_path: '非法类型继续进入驳回分支并写入持久化状态',
    observable_failure: '非法决策被接受并形成不可逆终局',
    mechanism_keywords: ['类型白名单', '驳回分支', '非法终局'],
    test_package: './internal/service',
    test_name: 'TestGoldB4_abc12345_InvalidDecision',
    verification_summary: '目标测试在基线失败并在修复之后通过，全量测试和静态检查均通过。',
  });
  assert.deepEqual(normalized.root_cause_symbols, ['service.Service.SubmitDecision']);
});

test('pipeline runner canonicalizes package-qualified pointer receiver symbols', () => {
  const normalized = validateGoldTestDescriptor({
    root_cause_file: 'internal/coordinator/recover.go',
    root_cause_symbols: ['(*coordinator.Coordinator).handleSelfCheck'],
    internal_cause: 'handleSelfCheck 未检查设备状态便进入通过分支并更新恢复游标',
    propagation_path: '错误分支选择使恢复条件继续提交并调用状态推进逻辑',
    observable_failure: '故障设备被公开接口错误标记为 recovered',
    mechanism_keywords: ['设备状态', '通过分支', '恢复游标'],
    test_package: './internal/coordinator',
    test_name: 'TestGoldB1_abc12345_SelfCheckStatus',
    verification_summary: '目标测试在基线失败并在修复之后通过，全量测试和静态检查均通过。',
  }, {
    expectedSymbols: ['(*coordinator.Coordinator).handleSelfCheck'],
  });
  assert.deepEqual(normalized.root_cause_symbols, ['coordinator.(*Coordinator).handleSelfCheck']);
});

test('Gold symbol matching accepts a more precise package-qualified receiver', () => {
  const gold = {
    root_cause_file: 'internal/store/sqlite/sqlite.go',
    root_cause_symbols: ['sqlite.(*Store).LoadAggregate'],
    internal_cause: 'LoadAggregate 的范围恢复循环只追加 Scope，遗漏了 ParticipantScope 字段同步更新。',
    propagation_path: '数据库重启恢复时该空字段继续传入聚合查询和 Snapshot，导致冻结范围丢失。',
    observable_failure: '恢复出的 Snapshot 不再包含原先冻结的参与人。',
    mechanism_keywords: ['范围恢复', '字段同步', '聚合快照'],
    test_package: './internal/store/sqlite',
    test_name: 'TestGoldB6_40554d99_RestartRecovery',
  };
  assert.doesNotThrow(() => validateGoldTestDescriptor(gold, {
    expectedFiles: ['internal/store/sqlite/sqlite.go'],
    expectedSymbols: ['(*Store).LoadAggregate'],
  }));
  assert.throws(() => validateGoldTestDescriptor({
    ...gold,
    root_cause_symbols: ['sqlite.(*OtherStore).LoadAggregate'],
  }, {
    expectedFiles: ['internal/store/sqlite/sqlite.go'],
    expectedSymbols: ['(*Store).LoadAggregate'],
  }), /必须命中已定位符号/);
});

test('pipeline runner derives Gold test package from the declaration file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gold-package-'));
  try {
    await mkdir(path.join(root, 'internal/mirror'), { recursive: true });
    await writeFile(path.join(root, 'internal/mirror/grader_test.go'), 'package mirror_test\n\nfunc TestGoldB5_example() {}\n');
    assert.equal(
      await resolveGoldTestPackage(root, ['internal/mirror/grader_test.go'], 'TestGoldB5_example'),
      './internal/mirror',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pipeline runner rejects Gold mechanisms that only repeat the symptom', () => {
  const symptomOnly = {
    root_cause_file: 'queue.go',
    root_cause_symbols: ['Queue.Pop'],
    internal_cause: '空队列调用会发生越界 panic',
    propagation_path: '用户因此无法正常读取空队列中的数据',
    observable_failure: '空队列读取发生 panic',
    mechanism_keywords: ['空队列', '读取', 'panic'],
    test_package: '.',
    test_name: 'TestGoldB1_abc12345_EmptyQueue',
    verification_summary: '目标测试在基线失败并在修复之后通过，全量测试和静态检查均通过。',
  };
  assert.throws(() => validateGoldTestDescriptor(symptomOnly), /internal_cause/);
  assert.equal(canonicalizeGoldDescriptor({ gold_root_cause: '`queue.go` 的 `Queue.Pop` 缺少检查，导致 panic。' }).gold_root_cause, 'queue.go 的 Queue.Pop 缺少检查，导致 panic。');
});

test('pipeline runner reads shared health state beside the pipeline-jobs directory', () => {
  const jobFile = path.join('/tmp', 'go-task-library', 'pipeline-jobs', 'pipeline-a', 'job.json');
  assert.equal(pipelineHealthPathForJob(jobFile), path.join('/tmp', 'go-task-library', 'pipeline-refill', 'health.json'));
});

test('pipeline runner creates a real dual-platform Docker target grader', () => {
  const script = createDockerGraderScript('bugfix');
  assert.match(script, /platforms=\(linux\/arm64 linux\/amd64\)/);
  assert.match(script, /image_stem="go-task-grader-go\$\{go_version\}-\$\{module_fingerprint\}"/);
  assert.match(script, /docker image inspect "\$image_reference"/);
  assert.match(script, /REFRESH_GRADER_IMAGES/);
  assert.match(script, /awk/);
  assert.doesNotMatch(script, /sed -nE/);
  assert.match(script, /check_toolchain\(\)/);
  assert.match(script, /command -v go/);
  assert.doesNotMatch(script, /bash -lc[^\n]*command -v go/);
  assert.match(script, /acquire_cache_lock/);
  assert.doesNotMatch(script, /cache-from|cache-to/);
  assert.match(script, /GO_PIPELINE_DOCKER_LOCK_ROOT/);
  assert.doesNotMatch(script, /docker image rm -f/);
  assert.match(script, /docker run --rm --network none --platform/);
  assert.match(script, /--cpus 4/);
  assert.match(script, /run_target\.sh/);
  assert.match(script, /run_compile\.sh/);
  assert.match(script, /run_full\.sh/);
  assert.match(script, /run_static\.sh/);
  assert.doesNotMatch(script, /backend=local-target/);
});

test('pipeline runner exports explicit Docker commands instead of a wrapper command', () => {
  const commands = explicitDockerVerifyCmds('sample-task', 'bugfix', "go test -count=1 -run '^TestRegression$' ./...");
  assert.equal(commands.length, 8);
  assert.doesNotMatch(commands.join('\n'), /run_docker\.sh|docker image rm/);
  assert.equal(commands.filter((command) => command.startsWith('docker run ')).every((command) => command.includes('--cpus 4')), true);
  for (const platform of ['linux/arm64', 'linux/amd64']) {
    assert.ok(commands.some((command) => command.startsWith(`docker build --platform ${platform}`)));
    assert.ok(commands.some((command) => command.includes(`--platform ${platform}`) && /go test[^\n]*-run/.test(command)));
    assert.ok(commands.some((command) => command.includes(`--platform ${platform}`) && /go test \.\/\.\.\./.test(command)));
    assert.ok(commands.some((command) => command.includes(`--platform ${platform}`) && /go vet \.\/\.\.\./.test(command)));
  }
  assert.doesNotMatch(commands.join('\n'), /\/grader\/|workspace\/benzhi\.Dockerfile|\$\(pwd\)\/workspace/);
});

test('bugfix uses the Gold regression while diagnosis preserves a real public reproduction command', () => {
  const command = publicTargetCommandForTask('bugfix', {
    test_package: './internal/logstore',
    test_name: 'TestReplayDropsPersistedUncommittedTail',
  });
  assert.equal(command, "go test ./internal/logstore -run '^TestReplayDropsPersistedUncommittedTail$' -count=1 -v");
  assert.equal(
    publicTargetCommandForTask('bugfix', {
      test_package: './internal/logstore',
      test_name: 'TestReplayDropsPersistedUncommittedTail',
    }, '', true),
    "go test -race ./internal/logstore -run '^TestReplayDropsPersistedUncommittedTail$' -count=20 -v",
  );
  assert.equal(
    publicTargetCommandForTask('diagnosis', {
      test_package: './internal/checkpoint',
      test_name: 'TestGoldHistoryBinding',
    }, "go run ./cmd/quorumforge -h"),
    'go run ./cmd/quorumforge -h',
  );
  assert.equal(
    publicTargetCommandForTask('diagnosis', {
      test_package: './internal/checkpoint',
      test_name: 'TestModel_HistoryBinding',
    }, "MODEL_REPRO=1 go test ./internal/checkpoint -run '^TestModel_HistoryBinding$' -count=1 -v"),
    "go test ./internal/checkpoint -run '^TestModel_HistoryBinding$' -count=1 -v",
  );
  assert.equal(
    publicTargetCommandForTask('diagnosis', {
      test_package: './cmd/quorumforge',
      test_name: 'TestGoldB1_HelpExitsZero',
    }),
    "go test ./cmd/quorumforge -run '^TestGoldB1_HelpExitsZero$' -count=1 -v",
  );
  assert.throws(
    () => publicTargetCommandForTask('diagnosis', {}, 'go run /tmp/quorumforge.go'),
    /不能依赖本地临时路径/,
  );
});

test('historical diagnosis export can use the isolated external grader commands', () => {
  const commands = packagedDockerVerifyCmds('sample-task', 'diagnosis');
  assert.equal(commands.length, 6);
  assert.equal(commands.filter((command) => command.startsWith('docker run ')).every((command) => command.includes('--cpus 4')), true);
  for (const platform of ['linux/arm64', 'linux/amd64']) {
    assert.ok(commands.some((command) => command.startsWith(`docker build --platform ${platform}`)));
    assert.ok(commands.some((command) => command.includes(`--platform ${platform}`) && command.includes('/grader/run_target.sh /app')));
    assert.ok(commands.some((command) => command.includes(`--platform ${platform}`) && command.includes('/grader/run_full.sh /app')));
  }
  assert.doesNotMatch(commands.join('\n'), /run_static\.sh|bash -c|\$\(pwd\)|docker image rm/);
});

test('pipeline runner requires Chinese delivery prose before task packaging', () => {
  const bug = {
    found: true,
    reason: '',
    bug_id: 'queue-empty-pop',
    title: '空队列读取发生 panic',
    bug_category: 'slice相关问题',
    user_query: '请修复空队列读取触发 panic 的问题，并补充覆盖空队列与连续读取场景的目标回归测试；保持现有非空队列、并发访问和错误返回行为不变，禁止通过跳过输入校验规避问题。',
    target_files: ['queue.go'],
    symbols: ['Queue.Pop'],
    failure_mechanism: 'queue.go 的 Queue.Pop 未检查切片长度便访问首个元素，空队列因此发生越界 panic。',
    reproduction_evidence: '构造空队列并调用 Pop 可以稳定复现 panic。',
    reproduction_command: '',
    success_criteria: '空队列读取稳定返回既有错误且不再触发 panic，非空队列行为保持不变；目标测试、全量测试和静态检查均通过，禁止通过跳过验证或删除断言规避问题。',
  };
  assert.equal(validateDiscoveredBug(bug), true);
  assert.equal(validateDiscoveredBug({ ...bug, user_query: '请修复空队列读取触发 panic 的问题，并补充回归测试。' }), true);
  assert.equal(validateDiscoveredBug({ ...bug, success_criteria: '目标测试、全量测试和静态检查均通过。' }), true);
  assert.throws(() => validateDiscoveredBug({ ...bug, user_query: '' }), /user_query 为空/);
  assert.throws(() => validateDiscoveredBug({ ...bug, success_criteria: '' }), /success_criteria 为空/);
  assert.throws(
    () => validateDiscoveredBug({ ...bug, user_query: 'Please fix empty queue reads and add regression tests without changing non-empty behavior.' }),
    /user_query 必须以中文为主体/,
  );
  assert.throws(
    () => validateDiscoveredBug({ ...bug, success_criteria: 'Target tests, full tests, and static checks must pass without workarounds.' }),
    /success_criteria 必须以中文为主体/,
  );
  assert.throws(
    () => validateDiscoveredBug({ ...bug, failure_mechanism: 'The queue reads the first element without checking whether the slice is empty, which causes a panic.' }),
    /failure_mechanism 必须以中文为主体/,
  );
  assert.throws(
    () => validateDiscoveredBug({
      ...bug,
      failure_mechanism: "queue.go 中注入时把 `CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_open ON queue(item) WHERE status NOT IN ('done','cancelled')` 改成普通唯一索引，旧终态记录因此持续占用资源，最终导致 Queue.Pop 无法处理同名新记录。",
    }),
    /failure_mechanism 去除 Markdown 后仍必须以中文为主体/,
  );
  assert.throws(
    () => validateDiscoveredBug({ ...bug, reproduction_evidence: 'Create an empty queue and call Pop to reproduce the panic every time.' }),
    /reproduction_evidence 必须以中文为主体/,
  );
  assert.throws(
    () => validateDiscoveredBug({ ...bug, title: 'Empty queue pop panics' }),
    /title 必须以中文为主体/,
  );
  assert.equal(validateDiscoveredBug({ ...bug, reproduction_command: "go test ./internal/queue -run '^TestQueueCLI$' -count=1" }, 'diagnosis'), true);
  assert.throws(() => validateDiscoveredBug(bug, 'diagnosis'), /reproduction_command 为空/);
  assert.equal(validateDiscoveredBug({ ...bug, reproduction_command: 'POST `/v1/tasks/{id}/lock` 两次，第二次观察返回状态和持久化记录。' }, 'diagnosis'), true);
});

test('candidate pools retain scenario drafts and deduplicate partition overlap', () => {
  const candidate = {
    found: true,
    reason: '',
    bug_id: 'queue-lock-replay',
    title: '重复锁定请求污染队列状态',
    task_subtype: 'diagnosis',
    bug_category: 'error',
    user_query: '请排查重复锁定请求后队列状态被污染的问题，并确认公开接口返回与持久化状态是否一致。',
    target_files: ['internal/queue/lock.go'],
    symbols: ['queue.Lock'],
    failure_mechanism: '重复锁定请求绕过已有状态判断并再次写入队列，错误传播到持久化层后使后续读取观察到错误状态。',
    reproduction_evidence: '对同一资源连续发起两次锁定操作，可以稳定看到第二次响应和后续读取状态不一致。',
    reproduction_command: 'HTTP 场景：对同一资源连续发起两次锁定，观察第二次响应与后续读取状态。',
    success_criteria: '目标行为保持稳定，定向复现与全量回归检查均通过，且不得使用规避方案。',
  };
  const normalized = normalizeBugCandidateFinders([
    { partition: 'public-domain', sessionId: 's1', output: { candidates: [candidate] } },
    { partition: 'state-lifecycle', sessionId: 's2', output: { candidates: [structuredClone(candidate)] } },
  ], [], { taskType: 'diagnosis' });
  assert.equal(normalized.candidates.length, 1);
  assert.equal(normalized.candidates[0].candidate.reproduction_command, candidate.reproduction_command);
  assert.equal(normalized.rejected.length, 1);
  assert.match(normalized.rejected[0].reason, /duplicates/);
});

test('pipeline runner applies V3 difficulty fields without changing V2 records', () => {
  const legacyBug = {
    found: true,
    reason: '',
    bug_id: 'reservation-overflow-orphan-session',
    title: '容量溢出后遗留孤立会话',
    task_subtype: '业务逻辑修复',
    bug_category: 'error',
    user_query: '请修复极端容量输入使预约失败后仍遗留孤立会话的问题，并补充覆盖溢出边界、事务回滚、正常预约和数据库状态的公开回归测试，保持现有错误码与幂等行为不变。',
    target_files: ['internal/service/reserve.go', 'internal/store/tx.go'],
    symbols: ['Service.Reserve', 'Tx.CreateSession'],
    failure_mechanism: '容量乘法在进入事务前发生 int64 溢出，后续先持久化 Session 再拒绝预约，错误传播没有回滚已写入的会话，导致数据库遗留没有预约引用的孤立 Session。',
    reproduction_evidence: '使用接近 int64 上限的数量调用公开预约 API，响应稳定失败，但数据库查询能看到没有预约引用的 Session。',
    reproduction_command: '',
    success_criteria: '极端输入必须返回既有错误且事务结束后不存在孤立 Session；正常预约、幂等重试、全量测试和静态检查保持通过。',
  };
  assert.equal(validateDiscoveredBug(legacyBug, 'bugfix', { bugPolicyVersion: BUG_TAXONOMY_POLICY_VERSION }), true);
  assert.throws(
    () => validateDiscoveredBug(legacyBug, 'bugfix', { bugPolicyVersion: BUG_DIFFICULTY_POLICY_VERSION }),
    /Bug 难度门禁未通过/,
  );
  assert.equal(validateDiscoveredBug({
    ...legacyBug,
    runtime_mechanisms: ['numeric_overflow_or_precision', 'transaction_atomicity'],
    affected_layers: ['service_or_orchestration', 'persistence_or_transaction', 'external_observable_behavior'],
    state_or_resource_impact: '失败请求已经持久化一个没有预约引用的 Session，破坏数据库事务原子性并影响后续容量核算。',
    difficulty_evidence: '容量运算结果跨越服务层进入事务写入，Session 创建与预约拒绝被错误拆开；定位需要跟踪算术边界、事务提交和错误传播，验证还必须查询提交后的数据库并覆盖正常与幂等路径。',
  }, 'bugfix', { bugPolicyVersion: BUG_DIFFICULTY_POLICY_VERSION }), true);
});

test('diagnosis Docker grader requires target reproduction and an unchanged workspace', () => {
  const script = createDockerGraderScript('diagnosis');
  assert.match(script, /diagnosis target unexpectedly passed/);
  assert.match(script, /diff -qr --exclude='\.git'/);
});

test('diagnosis system grader excludes the intentionally red repository proof from baseline tests', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../scripts/run-docker-task-grader.sh'), 'utf8');
  assert.match(runner, /run_diagnosis_baseline/);
  assert.match(runner, /done <\/grader\/test-files\.txt/);
  assert.match(runner, /rm -f "\$scratch\/workspace\/\$test_file"/);
  assert.match(runner, /GOTOOLCHAIN=local go test \.\/\.\.\. -count=1/);
  assert.doesNotMatch(runner, /bash -lc[^\n]*command -v go/);
  assert.match(runner, /acquire_cache_lock/);
});

test('pipeline runner uses zero-padded per-bug model-fix branches', () => {
  assert.equal(numberedModelFixBranch(1, 'test'), 'bug-01/test_model_fix');
  assert.equal(numberedModelFixBranch(5, 'gold'), 'bug-05/gold_model_fix');
});

test('pipeline runner uses orphan green and red branches for V3 snapshots', () => {
  assert.equal(numberedGreenBranch(1), 'bug1_green');
  assert.equal(numberedRedBranch(10), 'bug10_red');
});

test('diagnosis orphan red creation can recover before its metadata is persisted', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-red-recovery-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(repository, 'go.mod'), 'module example.test/diagnosis\n\ngo 1.23\n');
    await writeFile(path.join(repository, 'value.go'), 'package diagnosis\n\nfunc Value() int { return 0 }\n');
    git('add', '.');
    git('commit', '-m', 'main');
    const sourceCommit = git('rev-parse', 'HEAD');

    await createOrphanDiagnosisRedSnapshot(repository, sourceCommit, 1);
    const recoveredCommit = await createOrphanDiagnosisRedSnapshot(repository, sourceCommit, 1);
    assert.equal(git('branch', '--show-current'), 'bug1_red');
    assert.equal(git('rev-list', '--parents', '-n', '1', recoveredCommit).split(/\s+/).length, 1);
    assert.equal(git('show', `${recoveredCommit}:value.go`), 'package diagnosis\n\nfunc Value() int { return 0 }');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('pipeline runner uses repository and zero-padded slot for new bug IDs', () => {
  assert.equal(numberedBugId('https://github.com/team/go-0130', 3), 'nyh-go-0130-bug-03');
  assert.equal(numberedBugId('git@github.com:team/nyh-go-0130.git', 5), 'nyh-go-0130-bug-05');
  assert.throws(() => numberedBugId('', 1), /无法从 repository 解析/);
});

test('pipeline runner prepares a four-section bugfix verification result', () => {
  const result = buildPreparedVerifyResult({
    taskType: 'bugfix',
    bug: { title: '空队列读取发生 panic', target_files: ['queue.go'], symbols: ['Queue.Pop'] },
    gold: { test_name: 'TestEmptyQueue' },
    mainCommit: 'a'.repeat(40),
    goldCommit: 'b'.repeat(40),
    redGreen: { redExitCode: 1 },
  });
  for (const section of ['问题情况：', '处理过程：', '解决情况：', '验证结论：']) assert.ok(result.includes(section));
  assert.match(result, /修复前[\s\S]+修复后[\s\S]+20\/20[\s\S]+go vet/);
});

test('pipeline runner does not combine mutually exclusive Codex sandbox flags', () => {
  assert.deepEqual(codexSandboxArgs('workspace-write'), ['--approve-for-me']);
  assert.deepEqual(codexSandboxArgs('read-only'), ['-s', 'read-only']);
});

test('Claude runner quotes the publisher path for workspaces containing spaces', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  assert.ok(runner.includes('"$publisher" "$task_dir" "$validated_workspace" "$validated_session"'));
  assert.match(runner, /workflow_policy_version/);
  assert.match(runner, /verification_policy_version/);
  assert.match(runner, /v4_publisher=.*publish-v4-git-layout\.sh/);
  assert.match(runner, /publisher="\$v4_publisher"/);
  assert.match(runner, /new_private_fixture_flow/);
  assert.match(runner, /verification_test_overlay/);
  assert.doesNotMatch(runner, /GO_PIPELINE_DEFER_MODEL_TESTS|run_model_test_author\.sh/);
  assert.doesNotMatch(runner, /request_phase_resource "red_green_validation"/);
  assert.match(runner, /prune_private_fixture_material/);
  assert.match(runner, /remove_writable_tree "\$test_author_checkpoint"/);
  assert.match(runner, /remove_writable_tree "\$red_green_checkpoint"/);
  const infrastructureGuard = runner.indexOf('error waiting for container:[[:space:]]*unexpected EOF');
  const invalidRepair = runner.indexOf("FAILURE_CLASS=(public_compile|hidden_target|public_target|public_full|public_static)");
  const infrastructureReuse = runner.indexOf('elif [[ "$new_private_fixture_flow" -eq 1 ]]', invalidRepair);
  assert.ok(infrastructureGuard >= 0 && invalidRepair > infrastructureGuard && infrastructureReuse > invalidRepair);
  const infrastructureFailure = runner.slice(infrastructureGuard, invalidRepair);
  assert.doesNotMatch(infrastructureFailure, /remove_writable_tree "\$repair_checkpoint"|remove_writable_tree "\$test_author_checkpoint"|INVALID_REPAIR_CHECKPOINT=1/);
  assert.match(infrastructureFailure, /REUSABLE_REPAIR_CHECKPOINT=1/);
  assert.match(runner, /remove_writable_tree "\$repair_checkpoint"[\s\S]+remove_writable_tree "\$test_author_checkpoint"[\s\S]+INVALID_REPAIR_CHECKPOINT=1/);
  assert.match(runner, /remove_generated_compiler_artifacts\(\)[\s\S]+description="\$\(file -b "\$candidate"/);
  assert.match(runner, /save_repair_checkpoint\(\)[\s\S]+remove_generated_compiler_artifacts "\$sandbox_workspace" "\$sandbox_pristine"/);
  assert.match(runner, /bugfix_workspace_has_non_test_change/);
  assert.match(runner, /INVALID_REPAIR_OUTPUT=1/);
  assert.match(runner, /remove_generated_compiler_artifacts "\$workspace" "\$sandbox_pristine"/);
  assert.match(runner, /publish_validated_workspace\(\)[\s\S]+env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM -u GH_CONFIG_DIR/);
  const packageFailure = runner.slice(runner.indexOf('Git project packaging validation failed'), runner.indexOf('save_publish_checkpoint()'));
  assert.doesNotMatch(packageFailure, /remove_writable_tree "\$repair_checkpoint"|INVALID_REPAIR_CHECKPOINT=1/);
  assert.match(packageFailure, /REUSABLE_REPAIR_CHECKPOINT=1/);
  assert.ok(runner.includes('$(publish_validated_workspace "$sandbox_workspace" "$session_id")'));
  assert.doesNotMatch(runner, /\brg\s+-q\b/);
  assert.match(runner, /Claude API Error: \\?\(\.error_status/);
  assert.match(runner, /subtype == "api_retry"/);
});

test('independent test author streams liveness without contaminating its JSON result', async () => {
  const author = await readFile(path.resolve(import.meta.dirname, '../run_model_test_author.sh'), 'utf8');
  assert.match(author, /tee "\$raw_stream"/);
  assert.match(author, /CLAUDE_TEST_AUTHOR_PROGRESS/);
  assert.match(author, /GO_PIPELINE_TEST_AUTHOR_EFFORT:-low/);
  assert.match(author, /You are not given the unmodified BUG_BASE/);
  assert.match(author, /repaired production files are listed below/);
  assert.match(author, /do not survey unrelated packages/);
  assert.match(author, /Run only that exact TestModel_ function/);
  assert.match(author, /system independently runs the exact test against BUG_BASE and requires it to fail/);
  assert.match(author, /test-author Session must execute the exact \$added_model_test_name with -run and -count=1/);
  assert.match(author, /executed a prohibited broad, race, build, vet, or Docker command/);
  assert.match(author, /claude_exit="\$\{PIPESTATUS\[0\]\}"/);
  assert.match(author, /stdout is reserved for the final JSON/);
});

test('Claude runner captures an original complete trajectory and keeps Docker target acceptance', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(runner, /run-docker-task-grader\.sh/);
  assert.match(runner, /2>&1 \| tee -a "\$validation_log"/);
  assert.match(runner, /install -m 0755 "\$docker_grader" "\$task_dir\/grader\/run_docker\.sh"/);
  assert.match(runner, /backend=docker-target/);
  assert.match(runner, /target_cli=Claude Code CLI/);
  assert.match(runner, /target_cli_version=\$claude_code_version \(Claude Code\)/);
  assert.match(pipeline, /Claude runner exited successfully without required trajectory capture/);
  assert.match(runner, /validator_args=\(--static-only/);
  assert.match(runner, /--baseline=\$sandbox_pristine/);
  assert.match(runner, /complete-conversation=required/);
  assert.match(runner, /balanced-tool-events=required/);
  assert.match(runner, /immutable-runner-manifest=required/);
  assert.match(runner, /content-quality-review=paused/);
  assert.match(runner, /disallowed_tools=\([\s\S]*"Bash\(git \*\)" "Bash\(gh \*\)"/);
  assert.doesNotMatch(runner, /Bash\(go test \*\)/);
  assert.match(runner, /Bash\(\*go test \.\/\.\.\.\*\)/);
  assert.match(runner, /Bash\(\*go vet \.\/\.\.\.\*\)/);
  assert.match(runner, /Bash\(\*go build \.\/\.\.\.\*\)/);
  assert.match(runner, /Bash\(docker \*\)/);
  assert.match(runner, /pipeline performs those broad checks independently after the model task/);
  assert.match(runner, /This is a bugfix task[\s\S]+make the smallest appropriate production fix requested by the user/);
  assert.doesNotMatch(runner, /SOURCE_FILE_BUDGET|Never enumerate or read the repository package by package|Do not bypass these budgets/);
  assert.match(runner, /--allow-dangerously-skip-permissions/);
  assert.match(runner, /Claude task runner already active/);
  assert.match(runner, /GO_PIPELINE_CLAUDE_LOCK_WAIT_SECONDS/);
  assert.match(runner, /sleep 0\.5/);
  assert.match(runner, /\.claude-run\.lock/);
  assert.match(runner, /publish_checkpoint="\$task_dir\/\.publish-checkpoint"/);
  assert.match(runner, /resume_publish_checkpoint/);
  assert.match(runner, /resuming validated Claude checkpoint; retrying Git publication/);
  assert.match(runner, /GO_PIPELINE_GIT_PUBLISH_ATTEMPT_TIMEOUT_SECONDS:-600/);
  assert.match(runner, /save_publish_checkpoint/);
  assert.match(runner, /remove_writable_tree/);
  assert.match(runner, /chmod -R u\+w "\$target"/);
  assert.match(runner, /rsync -a --checksum --delete "\$sandbox_workspace\//);
  const publisher = await readFile(path.resolve(import.meta.dirname, '../publish_test_model_fix.sh'), 'utf8');
  assert.match(publisher, /rsync -a --checksum --delete/);
  assert.match(runner, /workspace_fingerprint/);
  assert.doesNotMatch(runner, /progress_checkpoint_request|\.progress-checkpoint|\.coverage-repair-mode|\.coverage-repair-workspace/);
  assert.match(runner, /task_library_root="\$\(cd "\$task_dir\/\.\.\/\.\." && pwd\)"/);
  assert.match(runner, /retry_history="\$task_library_root\/retry-history\//);
  assert.doesNotMatch(runner, /retry_history="\$work_root\/retry-history\//);
  assert.match(runner, /native\.session\.jsonl/);
  assert.match(runner, /trajectory_\$\{session_id\}\.jsonl/);
  assert.match(runner, /deny file-read\* \(subpath/);
  assert.match(runner, /--append-system-prompt "\$append_system_prompt"/);
  assert.match(runner, /PreToolUse: \[\{matcher:/);
  assert.match(runner, /PostToolUse: \[\{matcher:/);
  assert.doesNotMatch(runner, /Stop: \[\{matcher:/);
  assert.doesNotMatch(runner, /--bare/);
  assert.match(runner, /\.env\.ANTHROPIC_AUTH_TOKEN \/\/ empty/);
  assert.match(runner, /claude_model="\$\{GO_PIPELINE_BUGFIX_MODEL:-model_hub\/glm-52-coding\}"/);
  assert.match(runner, /Claude Bug 修复模型不匹配/);
  assert.match(runner, /gold_test_name="\$\(jq -r/);
  assert.match(runner, /workflow_version.*-lt 3/);
  assert.match(runner, /Claude-only workflow has no Gold test/);
  assert.match(runner, /export CLAUDE_CONFIG_DIR="\$run_root\/claude-config"/);
  assert.match(runner, /prompt_file="\$run_root\/user-prompt\.txt"/);
  assert.match(runner, /\.user_query \| strings \| select\(length > 0\)/);
  assert.doesNotMatch(runner, /prompt_file="\$task_dir\/PROMPT\.md"/);
  assert.doesNotMatch(runner, /workspace contains a model instruction file/);
  assert.doesNotMatch(runner, /Exploratory commands may format output|mandatory phase sequence|focused test with one direct Bash command/);
  assert.doesNotMatch(runner, /at most two mutation operations per workspace file/);
  assert.match(runner, /export TMPDIR="\$GOTMPDIR"/);
  assert.match(runner, /GO_PIPELINE_MONITOR_ROOT/);
  assert.match(runner, /"medium"/);
  assert.doesNotMatch(runner, /retry_count[^\n]*-ne 0/);
  assert.doesNotMatch(runner, /CLAUDE_USER_PREFIX|CLAUDE_APPEND_SYSTEM_PROMPT|regeneration-instructions\.txt/);
  assert.doesNotMatch(runner, /found one existing bug|branches point to the same original commit/i);
  const runnerSyntax = spawnSync('/bin/bash', ['-n', path.resolve(import.meta.dirname, '../run_one_claude.sh')], { encoding: 'utf8' });
  assert.equal(runnerSyntax.status, 0, runnerSyntax.stderr);
  const dockerRunner = path.resolve(import.meta.dirname, '../scripts/run-docker-task-grader.sh');
  const syntax = spawnSync('/bin/bash', ['-n', dockerRunner], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('long-running Claude and proof sessions execute immutable runner snapshots', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /snapshotRunnerScript\(jobFile, taskRunnerPath/);
  assert.match(pipeline, /snapshotRunnerScript\(jobFile, verificationRunnerPath/);
  assert.match(pipeline, /GO_PIPELINE_MONITOR_ROOT: monitorRoot/);
});

test('verification retries isolate Codex workspaces and allow the uploader retry window', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(pipeline, /PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS = 12 \* 60 \* 1000/);
  assert.match(pipeline, /GO_PIPELINE_CODEX_JSON_IDLE_TIMEOUT_MS \|\| 6 \* 60_000/);
  assert.match(pipeline, /idleTimeoutMs = CODEX_JSON_IDLE_TIMEOUT_MS/);
  assert.match(pipeline, /stderrPath,[\s\S]{0,120}idleTimeoutMs,/);
  assert.match(pipeline, /upload-proof[\s\S]{0,500}PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS/);
  assert.match(pipeline, /api\/cloud\/upload[\s\S]{0,500}PIPELINE_CLOUD_UPLOAD_TIMEOUT_MS/);
  assert.match(pipeline, /codex-test-author-bug\$\{bugIndex\}-attempt-\$\{attemptId\}/);
  assert.match(pipeline, /codex-diagnosis-test-author-bug\$\{bugIndex\}-attempt-\$\{attemptId\}/);
  assert.match(pipeline, /codex-test-red-bug\$\{bugIndex\}-attempt-\$\{attemptId\}/);
  assert.match(pipeline, /codex-diagnosis-test-red-bug\$\{bugIndex\}-attempt-\$\{attemptId\}/);
  assert.match(pipeline, /copyFileReplacing\(path\.join\(authorDir, descriptor\.test_file\)/);
  assert.doesNotMatch(pipeline, /await fsp\.rm\(authorDir, \{ recursive: true, force: true \}\)/);
  assert.match(server, /CLOUD_CONTROL_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(server, /validateCloudCookie[\s\S]{0,500}AbortSignal\.timeout\(CLOUD_CONTROL_REQUEST_TIMEOUT_MS\)/);
  assert.match(server, /api\/login[\s\S]{0,500}AbortSignal\.timeout\(CLOUD_CONTROL_REQUEST_TIMEOUT_MS\)/);
});

test('verification test materialization restores a read-only task workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-materialize-'));
  const taskDir = path.join(root, 'task');
  const sourceDir = path.join(root, 'source');
  const testFile = 'internal/api/model_permission_test.go';
  const workspacePackage = path.join(taskDir, 'workspace', 'internal', 'api');
  const sourcePackage = path.join(sourceDir, 'internal', 'api');
  try {
    await mkdir(workspacePackage, { recursive: true });
    await mkdir(sourcePackage, { recursive: true });
    await writeFile(path.join(sourcePackage, 'model_permission_test.go'), 'package api\n');
    await chmod(workspacePackage, 0o500);
    await chmod(path.dirname(workspacePackage), 0o500);
    await chmod(path.join(taskDir, 'workspace'), 0o555);

    const destination = await materializeVerificationTest(taskDir, sourceDir, testFile);

    assert.equal(await readFile(destination, 'utf8'), 'package api\n');
    assert.notEqual((await stat(workspacePackage)).mode & 0o200, 0);
  } finally {
    await chmod(path.join(taskDir, 'workspace'), 0o700).catch(() => {});
    await chmod(path.dirname(workspacePackage), 0o700).catch(() => {});
    await chmod(workspacePackage, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnosis workspace guard removes only a byte-identical legacy system test', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-workspace-guard-'));
  const taskDir = path.join(root, 'task');
  const pristineDir = path.join(taskDir, 'pristine');
  const workspaceDir = path.join(taskDir, 'workspace');
  const testFile = 'internal/service/model_legacy_test.go';
  const productionFile = 'internal/service/service.go';
  const testSource = 'package service\n';
  try {
    await Promise.all([
      mkdir(path.join(pristineDir, 'internal/service'), { recursive: true }),
      mkdir(path.join(workspaceDir, 'internal/service'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(pristineDir, productionFile), 'package service\n'),
      writeFile(path.join(workspaceDir, productionFile), 'package service\n'),
      writeFile(path.join(workspaceDir, testFile), testSource),
    ]);
    assert.deepEqual(await inspectDiagnosisWorkspace(pristineDir, workspaceDir), {
      valid: false,
      added: [testFile],
      removed: [],
      modified: [],
    });
    const clean = await ensureDiagnosisWorkspaceUnchanged(taskDir, {
      testFile,
      sha256: createHash('sha256').update(testSource).digest('hex'),
    });
    assert.equal(clean.valid, true);
    assert.equal(await stat(path.join(workspaceDir, testFile)).then(() => true).catch(() => false), false);

    await writeFile(path.join(workspaceDir, productionFile), 'package changed\n');
    await assert.rejects(
      ensureDiagnosisWorkspaceUnchanged(taskDir),
      /diagnosis 禁止持久修改被测仓库源码或测试.*修改 internal\/service\/service\.go/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only bugfix test authors materialize through the writable workspace boundary', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const calls = pipeline.match(/materializeVerificationTest\(taskDir, authorDir, descriptor\.test_file\)/g) || [];
  assert.equal(calls.length, 1);
  assert.doesNotMatch(pipeline, /publishV3DiagnosisVerificationTest/);
  assert.match(pipeline, /finalizeV3DiagnosisImmutableDelivery/);
  assert.match(pipeline, /qualityRejectionHistory[\s\S]+createOrphanDiagnosisRedSnapshot[\s\S]+--force-with-lease=refs\/heads/);
  assert.match(pipeline, /quality_rejection_read_only_rebind/);
  assert.doesNotMatch(pipeline, /copyFileReplacing\(path\.join\(authorDir, descriptor\.test_file\), path\.join\(taskDir, 'workspace'/);
});

test('V5 proof execution avoids duplicate red-green runs and protects parallel evidence merges', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const verifier = await readFile(path.resolve(import.meta.dirname, '../run_verify_claude.sh'), 'utf8');
  assert.match(pipeline, /prepareVerificationProofInputs\(/);
  assert.match(pipeline, /runVerificationProof\(jobFile, bugIndex, 'pre_fix'/);
  assert.match(pipeline, /runVerificationProof\(jobFile, bugIndex, 'post_fix'/);
  assert.match(pipeline, /uploadVerificationProof\(verifiedTask\.taskName, 'verify_pre'/);
  assert.match(pipeline, /finalizeVerificationResult\(/);
  assert.match(pipeline, /verification_policy_version/);
  assert.match(pipeline, /if \(job\.request\.taskType === 'bugfix'\) \{[\s\S]{0,300}runStage\(jobFile, `bug\$\{bugIndex\}_post_verify`/);
  assert.match(verifier, /verification_cache="\$task_dir\/\.verification-cache"/);
  assert.match(verifier, /export GOCACHE="\$verification_cache\/gocache"/);
  assert.match(verifier, /export GOMODCACHE="\$verification_cache\/gomodcache"/);
  assert.match(verifier, /select-claude-gateway\.mjs/);
  assert.match(verifier, /GO_PIPELINE_CLAUDE_GATEWAYS_JSON/);
  assert.match(pipeline, /\.post-fix-checkpoint\/checkpoint\.json/);
  assert.match(pipeline, /复用已发布的本地 post_fix 检查点/);
  assert.doesNotMatch(pipeline, /cleanupVerificationDockerImages\(task\.taskDir\)/);
});

test('current workflow uses four Bug partitions and incrementally fills injection slots', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /GO_PIPELINE_NATURAL_BUG_FINDER_TIMEOUT_MS \|\| 15 \* 60_000/);
  assert.match(pipeline, /const NATURAL_BUG_FINDER_TIMEOUT_MS[\s\S]*?\n  : 15 \* 60_000;/);
  assert.match(pipeline, /GO_PIPELINE_NATURAL_BUG_BATCH_REVIEW_TIMEOUT_MS \|\| 12 \* 60_000/);
  assert.match(pipeline, /GO_PIPELINE_NATURAL_BUG_FINDER_SOFT_BUDGET_MS \|\| 8 \* 60_000/);
  assert.match(pipeline, /ensureInjectionPlan\(jobFile, projectDir, naturalBatch\)/);
  for (const partition of ['api-orchestration', 'state-persistence', 'concurrency-resources', 'protocol-recovery']) {
    assert.match(pipeline, new RegExp(`id: '${partition}'`));
  }
  assert.match(pipeline, /4 个互补分区/);
  assert.match(pipeline, /runBoundedSettled\(NATURAL_BUG_SEARCH_PARTITIONS, finderConcurrency/);
  assert.match(pipeline, /GO_PIPELINE_INJECTION_PLAN_BATCH_SIZE \|\| 4/);
  assert.match(pipeline, /GO_PIPELINE_INJECTION_PLAN_TIMEOUT_MS \|\| 15 \* 60_000/);
  assert.match(pipeline, /GO_PIPELINE_INJECTION_PLAN_IDLE_TIMEOUT_MS \|\| 6 \* 60_000/);
  assert.match(pipeline, /timeoutMs: INJECTION_PLAN_TIMEOUT_MS/);
  assert.match(pipeline, /idleTimeoutMs: INJECTION_PLAN_IDLE_TIMEOUT_MS/);
  assert.match(pipeline, /acquireStageResourceSlot\(jobFile, 'codex_injection_plan'/);
  assert.match(pipeline, /streamRecoveryWindowMs: STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS/);
  assert.match(pipeline, /reasoningEffort: 'medium',[\s\S]{0,120}ignoreUserConfig: true,[\s\S]{0,80}ephemeral: true/);
  assert.match(pipeline, /Math\.ceil\(bugIndexes\.length \/ INJECTION_PLAN_BATCH_SIZE\)/);
  assert.match(pipeline, /reusableCodexJson\(jobFile, attemptName\)/);
  assert.match(pipeline, /从 \$\{planningSessionIds\.length\} 个已落盘规划批次恢复/);
  assert.match(pipeline, /最高第 \$\{recoveredPlanningAttempts\} 轮/);
  assert.match(pipeline, /recoveredPlanningAttempts \+ 1/);
  assert.match(pipeline, /Return exactly \$\{planningBatch\.requestCount\} NEW independent found=true Bug records/);
  assert.match(pipeline, /inspect at most 4 directly related existing \*_test\.go files/);
  assert.match(pipeline, /reject any candidate whose planned faulty behavior is already asserted there/);
  assert.match(pipeline, /Test inspection is exclusion-only: never make a candidate conditional on a fixture/);
  assert.match(pipeline, /Do not run tests, inspect testdata or test helpers, choose test-only code, or scan the full test suite/);
  assert.match(pipeline, /any find fallback must prune \.git and other metadata directories/);
  assert.match(pipeline, /Inspect those named tests first when their production path overlaps a new candidate/);
  assert.match(pipeline, /Never make the mutation conditional on test fixtures, clock or concrete types/);
  assert.match(pipeline, /const codexToolDir = path\.isAbsolute\(codexBin\) \? path\.dirname\(codexBin\) : ''/);
  assert.match(pipeline, /PATH: \[\.\.\.new Set\(\[codexToolDir, env\.PATH \|\| '', process\.env\.PATH \|\| ''\]/);
  assert.match(pipeline, /Inspect at most 15 additional production files/);
  assert.match(pipeline, /继续补剩余 \$\{remaining\} 个/);
  assert.match(pipeline, /Do not search for or substitute a different Bug/);
  assert.match(pipeline, /GO_PIPELINE_PROJECT_BUG_WORKER_LIMIT \|\| 4/);
  assert.match(pipeline, /currentProjectBugWorkerLimit\(job\.id\)/);
  assert.match(pipeline, /mode: FAST_COPY_MODE/);
  assert.match(pipeline, /COPYFILE_FICLONE/);
  assert.match(pipeline, /PROJECT_BUG_SOURCE_MAX_WORKER_LIMIT/);
  assert.match(pipeline, /runBoundedWorkers\(sourcePreparations, sourceWorkerLimit/);
  assert.doesNotMatch(pipeline, /runBoundedWorkers\(sourcePreparations, sourceWorkerLimit,[^\n]+stopOnError: true/);
  assert.match(pipeline, /Previously rejected injection candidates that either broke retained behavior, overlapped a defect already present in main/);
  assert.match(pipeline, /while \(true\) \{\s+const result = await prepareV2BugSourcesPass/);
  assert.match(pipeline, /PIPELINE_INJECTION_REVIEW_WAIT/);
  assert.match(pipeline, /runAdaptiveBoundedWorkers\(bugOrder, workerLimit, processBug/);
  assert.match(pipeline, /workerExecution/);
  assert.match(pipeline, /bug && \['running', 'passed', 'failed', 'skipped'\]\.includes\(status\)/);
  assert.doesNotMatch(pipeline, /项目级并行搜索没有找到任何满足技术门禁的自然 Bug/);
  assert.doesNotMatch(pipeline, /项目级批量复核没有批准任何自然 Bug/);
  assert.match(pipeline, /全部 \$\{remainingCount\} 个槽位转入分批受控注入/);
  assert.doesNotMatch(pipeline, /两个 Bug 候选搜索分区均未完成，无法建立候选池/);
  assert.match(pipeline, /自然 Bug 搜索分区均未返回有效结果/);
  assert.match(pipeline, /return processBug\(bugIndex\)/);
  assert.match(pipeline, /error\.pipelineFatalFailure/);
  assert.match(pipeline, /cycleStages\.has\(stage\.id\).*!\['passed', 'skipped'\]\.includes\(stage\.status\)/s);
  assert.match(pipeline, /acquireStageResourceSlot\(jobFile, stageId, \{ waitForCapacity: concurrent \}\)/);
  assert.match(pipeline, /Gold 20 次稳定性目标回归测试/);
});

test('natural Bug finder failures remain retryable infrastructure failures', async () => {
  assert.equal(naturalBugFinderFailureCount([
    { status: 'rejected', reason: new Error('gateway unavailable') },
    { status: 'fulfilled', value: {} },
  ]), 1);
  assert.equal(naturalBugFinderFailureCount([
    { status: 'fulfilled', value: {} },
    { status: 'fulfilled', value: {} },
  ]), 0);
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /自然 Bug 搜索基础设施失败[\s\S]{0,1600}不转入受控注入/);
  assert.match(pipeline, /throw new NaturalBugFinderInfrastructureError/);
  assert.match(pipeline, /finderStatus: retainedFinders\.length \? 'partial' : 'failed'/);
  assert.match(pipeline, /retainedCandidateCount/);
  assert.match(pipeline, /仅重试失败分区/);
  assert.match(pipeline, /This analysis sandbox may reject TCP listeners/);
  assert.throws(
    () => { throw new NaturalBugFinderInfrastructureError('gateway unavailable', { failureCount: 1 }); },
    /\[system:natural_bug_finder\]/,
  );
});

test('Codex structured stream failures expose the real gateway error', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }),
    JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected before completion: gateway unavailable' } }),
  ].join('\n');
  assert.equal(codexFailureMessage(events), 'stream disconnected before completion: gateway unavailable');
  assert.equal(codexFailureMessage('{not-json}'), '');
});

test('Codex stream recovery monitor allows two minutes without retrying business failures', () => {
  let clock = 1_000;
  const monitor = createCodexStreamRecoveryMonitor(120_000, () => clock);
  assert.equal(monitor('stdout', `${JSON.stringify({ type: 'error', message: 'schema validation failed' })}\n`), null);
  assert.equal(monitor('stderr', 'Reconnecting... 1/100\n'), null);

  assert.deepEqual(
    monitor('stdout', `${JSON.stringify({ type: 'error', message: 'Reconnecting... 1/100' })}\n`),
    { deadlineMs: 120_000, reason: '模型网关断流后连续 2 分钟未恢复，已结束当前分区并保留其他分区候选' },
  );
  clock += 119_000;
  assert.deepEqual(
    monitor('stdout', `${JSON.stringify({ type: 'error', message: 'Reconnecting... 8/100' })}\n`),
    { deadlineMs: 1_000, reason: '模型网关断流后连续 2 分钟未恢复，已结束当前分区并保留其他分区候选' },
  );
  assert.deepEqual(
    monitor('stdout', `${JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } })}\n`),
    { clearDeadline: true },
  );

  clock += 5_000;
  assert.deepEqual(
    monitor('stdout', `${JSON.stringify({ type: 'error', message: 'Reconnecting... 1/100' })}\n`),
    { deadlineMs: 120_000, reason: '模型网关断流后连续 2 分钟未恢复，已结束当前分区并保留其他分区候选' },
  );
  clock += 120_001;
  assert.deepEqual(
    monitor('stdout', `${JSON.stringify({ type: 'error', message: 'Reconnecting... 9/100' })}\n`),
    { expired: true, reason: '模型网关断流后连续 2 分钟未恢复，已结束当前分区并保留其他分区候选' },
  );
});

test('Codex stream recovery never invents an unconfigured custom provider', () => {
  assert.deepEqual(codexStreamRecoveryConfigArgs(120_000, undefined), []);
  assert.deepEqual(codexStreamRecoveryConfigArgs(120_000, ''), []);
  assert.deepEqual(codexStreamRecoveryConfigArgs(120_000, 'openai'), []);
  assert.deepEqual(codexStreamRecoveryConfigArgs(0, 'custom'), []);
  assert.deepEqual(codexStreamRecoveryConfigArgs(120_000, 'custom'), [
    '-c',
    'model_providers.custom.stream_max_retries=100',
  ]);
  assert.throws(() => codexStreamRecoveryConfigArgs(120_000, 'bad.provider'), /非法 Codex provider 标识/);
});

test('project planning is bounded independently from deep Bug analysis', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(pipeline, /GO_PIPELINE_PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS \|\| 2 \* 60_000/);
  assert.match(pipeline, /GO_PIPELINE_PROJECT_PLAN_TIMEOUT_MS \|\| 15 \* 60_000/);
  assert.match(pipeline, /Previous project titles to avoid duplicating/);
  assert.doesNotMatch(pipeline, /previous\.project\.overview/);
  assert.match(pipeline, /name: 'project-plan',[\s\S]{0,400}reasoningEffort: 'low'/);
  assert.match(pipeline, /name: 'project-plan',[\s\S]{0,500}ignoreUserConfig: true,[\s\S]{0,80}ephemeral: true/);
  assert.match(pipeline, /if \(ephemeral\) args\.push\('--ephemeral'\)/);
  assert.match(pipeline, /if \(ignoreUserConfig\) args\.push\('--ignore-user-config'\)/);
  assert.match(pipeline, /streamRecoveryWindowMs: PROJECT_PLAN_STREAM_RECOVERY_WINDOW_MS/);
  assert.match(pipeline, /overview: \{ type: 'string', minLength: 30, maxLength: 700 \}/);
  assert.doesNotMatch(server, /autoRetryCount = MAX_PIPELINE_AUTO_RETRIES - 1/);
  assert.match(server, /已达到 \$\{MAX_PIPELINE_AUTO_RETRIES\} 次自动重试上限，不再重复加入队列/);
});

test('structured Codex calls use clean sessions, real health probes, and shared limits', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const operations = await readFile(path.resolve(import.meta.dirname, './pipeline-operations.js'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  for (const name of ['post-claude-verification-test', 'diagnosis-verification-test']) {
    const end = pipeline.indexOf(`name: \`bug\${bugIndex}-${name}\``);
    const call = pipeline.slice(end, end + 500);
    assert.match(call, /timeoutMs: STRUCTURED_CODEX_TIMEOUT_MS/);
    assert.match(call, /streamRecoveryWindowMs: STRUCTURED_CODEX_STREAM_RECOVERY_WINDOW_MS/);
    assert.match(call, /reasoningEffort: 'medium'/);
    assert.match(call, /ignoreUserConfig: true/);
    assert.match(call, /ephemeral: true/);
  }
  assert.match(operations, /stage === 'project_plan' \|\| stage === 'codex_injection_plan' \|\| stage\.endsWith\('_test_author'\)/);
  assert.match(operations, /return \{ pool: 'codex-structured', limit: 2, weight: 1 \}/);
  assert.match(operations, /loadRatio >= 1\.2 \? 1 : limit/);
  assert.match(server, /GO_PIPELINE_CODEX_INFERENCE_PROBE_INTERVAL_MS \|\| 5 \* 60_000/);
  assert.match(server, /'exec', '--ephemeral', '--ignore-user-config'/);
  assert.match(server, /'--output-schema', schemaPath, '-o', outputPath/);
  assert.match(server, /inferenceStatus: 'degraded'/);
});

test('injection candidate failures stay slot-scoped and preserve prepared BUG_BASE slots', () => {
  const candidate = {
    bug_id: 'restart-audit-loss',
    target_files: ['internal/store/recovery.go'],
    symbols: ['store.(*Store).Recover'],
    failure_mechanism: 'Recovery skips committed audit records after reopening the database.',
  };
  const job = {
    injectionPlan: { key: 'old-plan' },
    bugs: [
      { bugIndex: 1, bugBaseCommit: 'a'.repeat(40), injectionPreparation: { status: 'passed' } },
      { bugIndex: 2, discovery: { found: false } },
    ],
    stages: [
      { id: 'bug1_bug_source_prepare', status: 'passed', result: { bugBaseCommit: 'a'.repeat(40) } },
      { id: 'bug2_bug_source_prepare', status: 'failed', error: 'audit events = 0, want 5' },
    ],
  };
  const failure = { item: { bugIndex: 2, plannedCandidate: candidate }, error: new Error('audit events = 0, want 5') };

  const first = applyInjectionPreparationFailures(job, [failure], '2026-08-22T00:00:00.000Z');
  assert.deepEqual(first, { failedBugIndexes: [2], exhaustedBugIndexes: [] });
  assert.equal(job.stages[0].status, 'passed');
  assert.equal(job.bugs[0].bugBaseCommit, 'a'.repeat(40));
  assert.equal(job.stages[1].status, 'pending');
  assert.equal(job.bugs[1].injectionPreparation.attempts, 1);
  assert.equal(job.bugs[1].injectionPreparation.status, 'retry_pending');
  assert.equal(job.bugs[1].injectionPreparation.rejectedCandidates[0].bugId, candidate.bug_id);
  assert.match(job.bugs[1].injectionPreparation.rejectedCandidates[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(job.injectionPlan, undefined);

  job.stages[1].status = 'failed';
  applyInjectionPreparationFailures(job, [failure], '2026-08-22T00:01:00.000Z');
  job.stages[1].status = 'failed';
  const third = applyInjectionPreparationFailures(job, [failure], '2026-08-22T00:02:00.000Z');
  assert.deepEqual(third, { failedBugIndexes: [2], exhaustedBugIndexes: [2] });
  assert.equal(job.bugs[1].injectionPreparation.status, 'review_required');
  assert.equal(job.stages[1].status, 'failed');
  assert.match(job.stages[1].reason, /连续 3 次/);
});

test('injection failures retain concrete failed test names for candidate review', () => {
  assert.deepEqual(
    extractFailedGoTestNames('--- FAIL: TestRollbackLeavesNoOrphans (0.01s)\n--- FAIL: TestRollbackLeavesNoOrphans (0.01s)\n--- FAIL: TestLeaseWinner'),
    ['TestRollbackLeavesNoOrphans', 'TestLeaseWinner'],
  );
  const candidate = {
    bug_id: 'rollback-commit',
    target_files: ['internal/store/store.go'],
    symbols: ['store.(*Store).RollbackTx'],
    failure_mechanism: 'A failed transaction is committed instead of rolled back.',
  };
  const job = {
    injectionPlan: { key: 'old-plan' },
    bugs: [{ bugIndex: 1 }],
    stages: [{ id: 'bug1_bug_source_prepare', status: 'failed' }],
  };
  applyInjectionPreparationFailures(job, [{
    item: { bugIndex: 1, plannedCandidate: candidate },
    error: new Error('Injected affected-package tests失败：\n--- FAIL: TestRollbackLeavesNoOrphans (0.01s)'),
  }], '2026-08-22T00:00:00.000Z');
  assert.deepEqual(job.bugs[0].injectionPreparation.rejectedCandidates[0].failedTests, ['TestRollbackLeavesNoOrphans']);
  assert.equal(job.bugs[0].injectionPreparation.rejectedCandidates[0].retainedTestEvidence, undefined);
});

test('injection preparation classifies candidate regressions and Codex infrastructure failures independently', () => {
  assert.equal(isRecoverableInjectionCandidateFailure(new Error(
    'Injected candidate full tests失败（exit=1）：\n--- FAIL: TestConcurrentStartSharedSectorSingleWinner',
  )), true);
  assert.equal(isRetryableInjectionInfrastructureFailure(new Error(
    'Codex CLI失败（exit=1）：\nInvalid prompt: your prompt was flagged as potentially violating our usage policy.',
  )), true);
  assert.equal(isRetryableInjectionInfrastructureFailure(Object.assign(new Error('等待资源'), { code: 'PIPELINE_RESOURCE_WAIT' })), false);
});

test('injection preparation classifies baseline overlap as a recoverable slot failure', () => {
  const candidate = {
    bug_id: 'already-present-defect',
    target_files: ['service/rejudge.go'],
    symbols: ['Service.Rejudge'],
    failure_mechanism: '弱化复判前置条件',
  };
  const error = new Error('Bug injection must produce a real production diff against the frozen main; the approved mutation may already exist in the baseline');
  const job = {
    injectionPlan: { key: 'old-plan' },
    bugs: [{ bugIndex: 9 }],
    stages: [{ id: 'bug9_bug_source_prepare', status: 'failed' }],
  };

  assert.equal(isRecoverableInjectionCandidateFailure(error), true);
  applyInjectionPreparationFailures(job, [{ item: { bugIndex: 9, plannedCandidate: candidate }, error }], '2026-08-24T00:00:00.000Z');
  assert.equal(job.bugs[0].injectionPreparation.rejectedCandidates[0].failureKind, 'baseline_overlap_or_no_mutation');
  assert.match(job.stages[0].reason, /与 main 现状重合或未形成生产改动/);
});

test('injection infrastructure failures retry only their slot without rejecting the candidate', () => {
  const job = {
    injectionPlan: { key: 'old-plan' },
    bugs: [{
      bugIndex: 9,
      injectionPreparation: {
        attempts: 1,
        rejectedCandidates: [{ bugId: 'bad-candidate' }],
      },
    }],
    stages: [{
      id: 'bug9_bug_source_prepare',
      status: 'failed',
      startedAt: 'old',
      finishedAt: 'old',
      error: 'Codex CLI失败',
    }],
  };
  const failure = {
    item: { bugIndex: 9, plannedCandidate: { bug_id: 'next-candidate' } },
    error: new Error('Codex CLI失败（exit=1）：Invalid prompt'),
  };

  const recovery = applyInjectionInfrastructureFailures(job, [failure], '2026-08-24T00:00:00.000Z');

  assert.deepEqual(recovery, { failedBugIndexes: [9], exhaustedBugIndexes: [] });
  assert.equal(job.stages[0].status, 'pending');
  assert.equal(job.stages[0].error, '');
  assert.equal(job.bugs[0].injectionPreparation.infrastructureAttempts, 1);
  assert.equal(job.bugs[0].injectionPreparation.attempts, 1);
  assert.deepEqual(job.bugs[0].injectionPreparation.rejectedCandidates, [{ bugId: 'bad-candidate' }]);
  assert.equal(job.injectionPlan, undefined);
});

test('diagnosis discovery accepts a focused command before red proof is generated', () => {
  const candidate = {
    found: true,
    reason: '终态资源释放遗漏会阻塞后续任务。',
    bug_id: 'terminal-resource-leak',
    title: '终态检测仪租约未释放',
    task_subtype: '运行异常诊断',
    bug_category: 'other',
    user_query: '任务结束后检测仪仍显示占用，后续任务无法启动，请排查终态资源释放流程。',
    target_files: ['internal/store/leases.go'],
    symbols: ['store.(*Store).ReleaseLeasesForTask'],
    failure_mechanism: '终态释放路径只更新一种设备类型，导致其他设备的持久化租约仍保持开放并阻塞后续任务。',
    reproduction_evidence: '现有公开测试暂未覆盖该边界，最终由隔离验证测试确认。',
    reproduction_command: "go test ./internal/store -run '^TestTerminalLeaseRelease$' -count=1",
    success_criteria: '终态提交后所有设备租约都释放，后续任务可以重新申请设备。',
    runtime_mechanisms: ['resource_lifecycle'],
    affected_layers: ['persistence_or_transaction'],
    state_or_resource_impact: '开放租约索引持续占用检测仪。',
    difficulty_evidence: '需要串联终态事务、租约索引和后续竞争请求。',
  };
  assert.doesNotThrow(() => validateDiscoveredBug(candidate, 'diagnosis', { bugPolicyVersion: 0 }));
});

test('Claude repair leaves red-green proof and broad checks to later system stages', async () => {
  const runner = await readFile(path.resolve(import.meta.dirname, '../run_one_claude.sh'), 'utf8');
  const dockerIndex = runner.indexOf('"$docker_grader" "$task_dir" "$docker_workspace" "$task_type"');
  const checkpointIndex = runner.indexOf('mark_runner_phase "claude_repair_checkpoint_saved"');
  assert.ok(checkpointIndex >= 0 && dockerIndex > checkpointIndex);
  assert.doesNotMatch(runner, /run-model-verification-fast-gate\.mjs|model_verification_fast_gate/);
  assert.match(runner, /Do not run broad go test \.\/\.\.\./);
  assert.match(runner, /private fixture overlay/);
});

test('historical Bugfix command backfill preserves the public count-one replay contract', async () => {
  const backfill = await readFile(path.resolve(import.meta.dirname, '../scripts/backfill-bugfix-verify-cmds.mjs'), 'utf8');
  assert.match(backfill, /-count=1/);
  assert.doesNotMatch(backfill, /-count=20/);
});

test('Gold and verification prompts keep user_query as the hard contract', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /Treat user_query as the hard behavior contract/);
  assert.match(pipeline, /Treat issue-specific behavior in user_query as the authoritative hard contract/);
  assert.match(pipeline, /do not require a dedicated concurrent-operation test merely for wording/);
  assert.match(pipeline, /Concurrency remains hard when it is the Bug trigger or requested observable scenario/);
  assert.match(pipeline, /GOLD_PUBLIC_CONTRACT_CONFLICT/);
  assert.match(pipeline, /coverage=user-query-hard-contract-success-criteria-clarification-only/);
  assert.doesNotMatch(pipeline, /coverage=all-user-query-and-success-criteria-behaviors-must-be-publicly-tested/);
});

test('manual trajectory regeneration archives review notes without forwarding them to Claude', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(server, /internalReviewNote: taskFeedback/);
  assert.match(server, /forwardedToClaude: false/);
  assert.match(server, /\.trajectory-policy-v4/);
  assert.doesNotMatch(server, /validateTrajectoryIntegrityEvents/);
  assert.match(server, /buildValidatedTrajectory\(task, \{ requireV4: true \}\)/);
  assert.match(server, /capture-only-no-trajectory-audit/);
  assert.doesNotMatch(server, /Review feedback:/);
  assert.doesNotMatch(server, /\|\| retries \|\|/);
  assert.doesNotMatch(server, /writeFile\(path\.join\(task\.taskDir, 'regeneration-instructions\.txt'/);
});

test('task discovery defers proof and publication field errors until pipeline delivery completes', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(server, /pipelineDeliveryIncomplete \? \[\] : getProductionFlowRuleIssues/);
  assert.match(server, /pipelineDeliveryIncomplete \? \[\] : getApplicableGitRuleIssues/);
  assert.match(server, /rawTrajectoryRuleIssues\.filter/);
  assert.match(server, /verify_result\\b/);
});

test('export record writes invalidate the task snapshot before the UI refreshes counts', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  const start = server.indexOf('async function writeTaskExportRecords');
  const end = server.indexOf('async function recordTaskExports', start);
  const writer = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(writer, /invalidateTaskDiscoveryCache\(\);/);
  assert.doesNotMatch(writer, /graceMs/);
});

test('completed Bug workbench requests are idempotently ignored after delivery', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(server, /isPipelineBugDeliveryComplete\(job, index\)/);
  assert.match(server, /Bug \$\{index\} 已交付，忽略重复的/);
  assert.match(server, /isPipelineBugDeliveryComplete\(job, index\) && !\(action === 'retry' && missingIndependentTest\)/);
  assert.match(server, /撤销假交付并从 test_author 恢复/);
});

test('an adopted live Runner remains authoritative when persisted job status is stale', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(server, /async function restoreRuntimeAfterRestart\(\) \{\s*\/\/ Adopt live project runners[\s\S]*?await adoptPipelineRunnerProcesses\(\);/);
  assert.match(server, /if \(!activePipelineProcesses\.has\(jobId\)\) \{\s*const liveRunner = \(await scanPipelineRunnerProcesses\(\)\)\.get\(jobId\);/);
  assert.match(server, /const runnerHandle = activePipelineProcesses\.get\(jobId\);/);
  assert.match(server, /const runnerActive = Boolean\(runnerHandle && processIsAlive\(Number\(runnerHandle\.pid\)\)\);/);
  assert.doesNotMatch(server, /const runnerActive = activePipelineProcesses\.has\(jobId\)\s*&& \['queued', 'running'\]\.includes/);
  assert.match(server, /const existingRunner = liveRunners\.get\(jobId\);[\s\S]*?error\.code = 'PIPELINE_RUNNER_ACTIVE'/);
});

test('injection review retry cannot leave a queued job without a live Runner', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  const start = server.indexOf('async function resolvePipelineInjectionReview');
  const end = server.indexOf('async function controlPipelineBug', start);
  const review = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(review, /current\.status = normalizedAction === 'continue' \? 'waiting_review' : 'waiting_resource'/);
  assert.match(review, /stage\.reviewStartedAt \|\|= at/);
  assert.match(review, /current\.userQueryReviewStartedAt \|\|= at/);
  assert.match(review, /queuePipelineManualRetry\(waiting, new Date\(\)\.toISOString\(\), error\.message\)/);
  assert.doesNotMatch(review, /queued\.status = 'queued'/);
  assert.match(server, /pipelineStageResourceProfile,\s*\n\s*pipelineStageStartCapacity,/);
  assert.match(server, /await reconcileStaleQueuedPipelineReservations\(\)/);
});

test('production trajectory cycle skips Sol content review after integrity validation', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const exporter = await readFile(path.resolve(import.meta.dirname, '../scripts/export-canonical-trajectory.mjs'), 'utf8');
  assert.match(pipeline, /content-quality-review=paused/);
  assert.match(pipeline, /setStage\(jobFile, qualityStage, 'skipped'/);
  assert.doesNotMatch(pipeline, /const quality = await runSolQuality/);
  assert.doesNotMatch(exporter, /assertNoPrivatePolicyLeak/);
});

test('verification proof retries archive task-local attempts inside the task root', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /archiveDirectory\(task\.taskDir, outputDir, `bug\$\{bugIndex\}-\$\{phase\}-attempt-\$\{attempt\}`\)/);
  assert.doesNotMatch(pipeline, /archiveDirectory\(path\.dirname\(jobFile\), outputDir, `bug\$\{bugIndex\}-\$\{phase\}-attempt-\$\{attempt\}`\)/);
});

test('central resource yielding is not converted into a failed pipeline job', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const resourceGuard = /if \(error\?\.code === 'PIPELINE_RESOURCE_WAIT'\) throw error;/;
  const failureAssignment = /current\.status = 'failed';\s*current\.error = error\.message;/;
  const guardIndex = pipeline.indexOf("// Resource yielding is a normal scheduler hand-off");
  const failureIndex = pipeline.indexOf('current.status = \'failed\';', guardIndex);
  assert.ok(guardIndex >= 0, 'the trajectory-cycle catch must document the scheduler hand-off');
  assert.match(pipeline.slice(guardIndex, failureIndex), resourceGuard);
  assert.match(pipeline.slice(failureIndex), failureAssignment);
});

test('transient dependency outages wait for recovery instead of failing or skipping a Bug', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /error\.code = 'PIPELINE_DEPENDENCY_WAIT'/);
  assert.match(pipeline, /await queueDependencyWait\(jobFile, stageId, error\)/);
  assert.match(pipeline, /job\.status = 'waiting_resource'/);
  assert.match(pipeline, /job\.dependencyWaitService = service/);
  assert.doesNotMatch(pipeline, /PIPELINE_DEPENDENCY_WAIT[\s\S]{0,500}markPipelineBugFailed/);
});

test('post-Claude delivery releases Docker capacity before network-only Git publication', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const start = pipeline.indexOf('async function runPostClaudeDelivery');
  const end = pipeline.indexOf('async function previousProjectContext', start);
  const delivery = pipeline.slice(start, end);
  assert.doesNotMatch(delivery, /acquireStageResourceSlot/);
  assert.match(delivery, /GO_PIPELINE_PHASE_RESOURCE_HANDSHAKE: '1'/);
  assert.match(delivery, /if \(String\(request\?\.phase \|\| ''\) !== 'git_publication'\) return;/);
  const switchStart = delivery.indexOf('onPhaseRequest: async (request) =>');
  const switchEnd = delivery.indexOf('onPhaseObservation:', switchStart);
  const switchBody = delivery.slice(switchStart, switchEnd);
  assert.ok(switchBody.indexOf('await releaseResource();') < switchBody.indexOf("setStage(jobFile, `bug${bugIndex}_git_publication`, 'running')"));
});

test('pipeline verification finalization is bound to its Job and Bug before review upload', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(pipeline, /source: verificationFinalize \? 'pipeline-verification-finalize'/);
  assert.match(pipeline, /pipelineJobId: job\.id, bugIndex/);
  assert.match(pipeline, /qualifyTask\(latest, verifiedTask, \{ verificationFinalize: true \}\)/);
  assert.match(pipeline, /source: 'pipeline-verification-finalize',[\s\S]*pipelineJobId,[\s\S]*bugIndex/);
  assert.match(server, /let pipelineFinalize = source === 'pipeline-verification-finalize'/);
  assert.match(server, /source === 'pipeline-integrity-originality' && selected\.length === 1/);
  assert.match(server, /inferredStage\?\.status === 'running'/);
  assert.match(server, /const pipelineFinalizeIds = new Set\(\)/);
  assert.match(server, /const qualifiedReviewIds = new Set\(\(await readReviewStatuses\(\)\)/);
  assert.match(server, /qualifiedReviewIds\.has\(task\.id\)/);
  assert.doesNotMatch(server, /Number\(task\.bug_index\) === bugIndex\s*&& task\.reviewStatus === 'qualified'/);
  assert.match(server, /if \(!allowPipelineFinalize && task\.reviewStatus !== 'qualified'\)/);
  assert.match(server, /allowPipelineFinalize: pipelineFinalizeIds\.has\(taskId\)/);
  assert.match(server, /readPipelineJob\(effectivePipelineJobId\)/);
  assert.match(server, /stage\.id === `\$\{prefix\}verification_finalize` && stage\.status === 'running'/);
  assert.match(server, /task\.pipelineJobId \|\| task\.pipeline_job_id/);
});

test('stage transitions keep the project runner lease instead of preempting the pipeline', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.ok(pipeline.includes('A scheduler admission belongs to the whole pipeline runner'));
  assert.ok(pipeline.includes('job.schedulerLease?.runnerPid === process.pid'));
  assert.ok(pipeline.includes('async function clearSchedulerAdmission(jobFile, stageId, { release = false } = {})'));
  assert.ok(pipeline.includes('Keep the project-level lease across stage transitions'));
  assert.ok(pipeline.includes('clearSchedulerAdmission(jobFile, stageId, { release: !bugScoped })'));
  assert.ok(pipeline.includes('clearSchedulerAdmission(jobFile, stageId, { release: !concurrent })'));
});

test('Bug-scoped failures auto-continue while infrastructure failures still stop the project', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /queuePipelineBugStageRetry\(current, bugIndex/);
  assert.match(pipeline, /保留已通过检查点并自动重试当前阶段/);
  assert.match(pipeline, /return processBug\(bugIndex\)/);
  assert.match(pipeline, /MAX_BUG_STAGE_AUTO_RETRIES/);
  assert.match(pipeline, /markPipelineBugFailed\(current, bugIndex/);
  assert.match(pipeline, /auto_continue_after_failure/);
  assert.match(pipeline, /const infrastructureFailure = new Set\(\[/);
  assert.match(pipeline, /if \(infrastructureFailure \|\| !\/\^bug\\d\+_\//);
  assert.match(pipeline, /current\.status = 'running';/);
  assert.match(pipeline, /current\.status = 'failed';/);
  assert.match(pipeline, /自动切换到 Bug/);
});

test('Gold contract conflicts retry the current Bug and preserve the production candidate', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /保留 Gold 生产修复，仅替换第/);
  assert.match(pipeline, /archiveGoldContractCandidate\(/);
  assert.match(pipeline, /queuePipelineGoldContractRetry\(/);
  assert.match(pipeline, /gold_contract_review_retry/);
  assert.match(pipeline, /Gold 公共契约复核连续失败，已暂停当前 Bug 等待人工复核/);
  assert.doesNotMatch(pipeline, /GOLD_PUBLIC_CONTRACT_CONFLICT[\s\S]{0,200}markPipelineBugFailed/);
});

test('trajectory exhaustion finalizes independent V5 proofs before marking a bug skipped', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const skippedIndex = pipeline.indexOf('if (verifiedTask.skipped) {');
  assert.ok(skippedIndex >= 0, 'the skipped trajectory branch must be explicit');
  const branch = pipeline.slice(skippedIndex, pipeline.indexOf('if (usesVerificationEvidence) {', skippedIndex));
  const proofIndex = branch.indexOf("uploadVerificationProof(skippedTask.taskName, 'verify_pre')");
  const finalizeIndex = branch.indexOf('finalizeVerificationResult(currentBug?.task?.taskDir, mainSessionId)');
  const markIndex = branch.indexOf('markPipelineBugSkipped(current, bugIndex, verifiedTask.reason');
  assert.ok(proofIndex >= 0, 'the skipped branch must upload the pre-fix proof');
  assert.ok(finalizeIndex > proofIndex, 'verify_result must be finalized after proof upload');
  assert.ok(markIndex > finalizeIndex, 'the bug must be marked skipped only after proof finalization');
});

test('injected bug validation accepts reasonably scoped source or configuration changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-injection-test-'));
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    runGit('init', '-b', 'main');
    runGit('config', 'user.name', 'Pipeline Test');
    runGit('config', 'user.email', 'pipeline-test@local.invalid');
    await writeFile(path.join(directory, 'app.go'), 'package app\n\nfunc Value() int { return 1 }\n', 'utf8');
    await writeFile(path.join(directory, 'app_test.go'), 'package app\n', 'utf8');
    runGit('add', '.');
    runGit('commit', '-m', 'base');
    const baseCommit = runGit('rev-parse', 'HEAD');
    await assert.rejects(
      validateInjectedBugWorktree(directory, baseCommit),
      /real production diff against the frozen main/,
    );
    await writeFile(path.join(directory, 'app.go'), 'package app\n\nfunc Value() int { return 2 }\n', 'utf8');
    assert.deepEqual(await validateInjectedBugWorktree(directory, baseCommit), { files: ['app.go'], changedLines: 2, reviewRequired: false, reviewReasons: [] });
    await writeFile(path.join(directory, 'settings.yaml'), 'timeout: 0\n', 'utf8');
    const withConfig = await validateInjectedBugWorktree(directory, baseCommit);
    assert.deepEqual(withConfig.files.sort(), ['app.go', 'settings.yaml']);
    assert.equal(withConfig.reviewRequired, false);
    for (const name of ['limits.yaml', 'routing.yaml', 'storage.yaml', 'timeouts.yaml']) {
      await writeFile(path.join(directory, name), 'enabled: true\n', 'utf8');
    }
    const broad = await validateInjectedBugWorktree(directory, baseCommit);
    assert.equal(broad.reviewRequired, true);
    assert.match(broad.reviewReasons.join(';'), /涉及 6 个文件/);
    await writeFile(path.join(directory, 'app_test.go'), 'package app\n\n// changed\n', 'utf8');
    await assert.rejects(validateInjectedBugWorktree(directory, baseCommit), /cannot modify tests/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner optional JSON reads preserve null fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  try {
    assert.equal(await readJson(path.join(directory, 'missing.json'), null), null);
    await writeFile(path.join(directory, 'valid.json'), '{"ok":true}\n', 'utf8');
    assert.deepEqual(await readJson(path.join(directory, 'valid.json')), { ok: true });
    await assert.rejects(readJson(path.join(directory, 'missing.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner restores a missing job file from its durable mirror', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-job-backup-'));
  const jobId = 'pipeline-backup-test';
  const jobFile = path.join(directory, 'go-task-library', 'pipeline-jobs', jobId, 'job.json');
  const backupFile = path.join(directory, 'go-task-library', 'pipeline-refill', 'job-backups', `${jobId}.json`);
  const expected = { id: jobId, status: 'waiting_resource' };
  try {
    await mkdir(path.dirname(backupFile), { recursive: true });
    await writeFile(backupFile, `${JSON.stringify(expected)}\n`, 'utf8');
    assert.deepEqual(await readJson(jobFile), expected);
    assert.deepEqual(JSON.parse(await readFile(jobFile, 'utf8')), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner restores the shared tasks root on every resumed job', async () => {
  const pipeline = await readFile(path.resolve(import.meta.dirname, '../scripts/run-production-pipeline.mjs'), 'utf8');
  const start = pipeline.indexOf('async function runPipeline(jobFile)');
  const end = pipeline.indexOf("await fsp.mkdir(path.join(jobDir, 'artifacts')", start);
  const resume = pipeline.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(resume, /current\.jobDir = jobDir;\s*current\.tasksRoot = tasksRoot;/);
});

test('pipeline job listing attempts mirror recovery before skipping a missing job file', async () => {
  const server = await readFile(path.resolve(import.meta.dirname, '../server.mjs'), 'utf8');
  assert.match(server, /if \(!stat\) \{\s*restoredJob = await readPipelineJob\(entry\.name\);\s*stat = restoredJob/);
  assert.match(server, /const parsed = restoredJob \|\| await readPipelineJob\(entry\.name\)/);
});

test('Gold test discovery includes newly created untracked Go test files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-gold-tests-'));
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    runGit('init', '-b', 'main');
    runGit('config', 'user.name', 'Pipeline Test');
    runGit('config', 'user.email', 'pipeline-test@local.invalid');
    await writeFile(path.join(directory, 'app.go'), 'package app\n', 'utf8');
    runGit('add', 'app.go');
    runGit('commit', '-m', 'base');
    const baseCommit = runGit('rev-parse', 'HEAD');
    await writeFile(path.join(directory, 'app_test.go'), 'package app\n\nfunc TestNewRegression() {}\n', 'utf8');
    assert.deepEqual(await changedTestFiles(directory, baseCommit, 'TestNewRegression'), ['app_test.go']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gold retry reuses a complete local checkpoint after a model gateway failure', async () => {
  const jobDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-gold-checkpoint-'));
  const source = path.join(jobDir, 'history/gold-bug2-retry-2026-08-19T00-00-00-000Z');
  const goldDir = path.join(jobDir, 'gold-bug2');
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(source, 'pkg'), { recursive: true });
    await mkdir(path.join(jobDir, 'artifacts'), { recursive: true });
    runGit('init', '-b', 'main');
    runGit('config', 'user.name', 'Pipeline Test');
    runGit('config', 'user.email', 'pipeline-test@local.invalid');
    await writeFile(path.join(source, 'pkg/store.go'), 'package pkg\n\nfunc (s *Store) Load() int { return 1 }\ntype Store struct{}\n', 'utf8');
    runGit('add', '.');
    runGit('commit', '-m', 'base');
    const baseCommit = runGit('rev-parse', 'HEAD');
    await writeFile(path.join(source, 'pkg/store.go'), 'package pkg\n\nfunc (s *Store) Load() int { return 2 }\ntype Store struct{}\n', 'utf8');
    await writeFile(path.join(source, 'pkg/grader_b2_abc_test.go'), 'package pkg_test\n\nfunc TestGoldB2_abc_Restart() {}\n', 'utf8');
    await writeFile(path.join(jobDir, 'artifacts/bug2-gold.json'), `${JSON.stringify({
      root_cause_file: 'pkg/store.go',
      root_cause_symbols: ['pkg.(*Store).Load'],
      internal_cause: 'Load 的恢复循环错误更新状态字段。',
      propagation_path: '错误状态随后传入读取结果，导致返回值异常。',
      observable_failure: '重启后公开读取返回了错误结果。',
      mechanism_keywords: ['状态恢复', '循环更新', '重启读取'],
      test_package: './pkg',
      test_name: 'TestGoldB2_abc_Restart',
      verification_summary: 'focused and full tests passed',
    })}\n`, 'utf8');
    await writeFile(path.join(jobDir, 'artifacts/bug2-gold.codex.jsonl'), `${JSON.stringify({ thread_id: 'checkpoint-session' })}\n`, 'utf8');

    const recovered = await recoverGoldCheckpoint({
      jobDir,
      goldDir,
      bugIndex: 2,
      bugBaseCommit: baseCommit,
      requiredPrefix: 'TestGoldB2_abc_',
      expectedFiles: ['pkg/store.go'],
      expectedSymbols: ['(*Store).Load'],
    });
    assert.equal(recovered.sessionId, 'checkpoint-session');
    assert.deepEqual(recovered.productionChanges, ['pkg/store.go']);
    assert.match(await readFile(path.join(goldDir, 'pkg/store.go'), 'utf8'), /return 2/);
    assert.match(await readFile(path.join(goldDir, 'pkg/grader_b2_abc_test.go'), 'utf8'), /TestGoldB2_abc_Restart/);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('Gold retry rejects a checkpoint whose patch omits the reported root-cause file', async () => {
  const jobDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-gold-checkpoint-mismatch-'));
  const source = path.join(jobDir, 'history/gold-bug1-retry-2026-08-19T00-00-00-000Z');
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(source, 'pkg'), { recursive: true });
    await mkdir(path.join(jobDir, 'artifacts'), { recursive: true });
    runGit('init', '-b', 'main');
    runGit('config', 'user.name', 'Pipeline Test');
    runGit('config', 'user.email', 'pipeline-test@local.invalid');
    await writeFile(path.join(source, 'pkg/store.go'), 'package pkg\n\ntype Store struct{}\nfunc (s *Store) Load() int { return 1 }\n', 'utf8');
    await writeFile(path.join(source, 'pkg/other.go'), 'package pkg\n\nfunc Other() int { return 1 }\n', 'utf8');
    runGit('add', '.');
    runGit('commit', '-m', 'base');
    const baseCommit = runGit('rev-parse', 'HEAD');
    await writeFile(path.join(source, 'pkg/other.go'), 'package pkg\n\nfunc Other() int { return 2 }\n', 'utf8');
    await writeFile(path.join(source, 'pkg/grader_b1_xyz_test.go'), 'package pkg_test\n\nfunc TestGoldB1_xyz_Restart() {}\n', 'utf8');
    await writeFile(path.join(jobDir, 'artifacts/bug1-gold.json'), `${JSON.stringify({
      root_cause_file: 'pkg/store.go',
      root_cause_symbols: ['pkg.(*Store).Load'],
      internal_cause: 'Load 的恢复循环错误更新状态字段。',
      propagation_path: '错误状态随后传入读取结果，导致返回值异常。',
      observable_failure: '重启后公开读取返回了错误结果。',
      mechanism_keywords: ['状态恢复', '循环更新', '重启读取'],
      test_package: './pkg',
      test_name: 'TestGoldB1_xyz_Restart',
      verification_summary: 'focused and full tests passed',
    })}\n`, 'utf8');
    const recovered = await recoverGoldCheckpoint({
      jobDir,
      goldDir: path.join(jobDir, 'gold-bug1'),
      bugIndex: 1,
      bugBaseCommit: baseCommit,
      requiredPrefix: 'TestGoldB1_xyz_',
      expectedFiles: ['pkg/store.go'],
      expectedSymbols: ['(*Store).Load'],
    });
    assert.equal(recovered, null);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('Gold retry never reuses a checkpoint rejected by downstream contract verification', async () => {
  const jobDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-gold-checkpoint-rejected-'));
  const source = path.join(jobDir, 'gold-bug1');
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(source, 'pkg'), { recursive: true });
    await mkdir(path.join(jobDir, 'artifacts'), { recursive: true });
    runGit('init', '-b', 'main');
    runGit('config', 'user.name', 'Pipeline Test');
    runGit('config', 'user.email', 'pipeline-test@local.invalid');
    await writeFile(path.join(source, 'pkg/store.go'), 'package pkg\n\ntype Store struct{}\nfunc (s *Store) Load() int { return 1 }\n', 'utf8');
    runGit('add', '.');
    runGit('commit', '-m', 'base');
    const baseCommit = runGit('rev-parse', 'HEAD');
    await writeFile(path.join(source, 'pkg/store.go'), 'package pkg\n\ntype Store struct{}\nfunc (s *Store) Load() int { return 2 }\n', 'utf8');
    await writeFile(path.join(source, 'pkg/grader_b1_xyz_test.go'), 'package pkg_test\n\nfunc TestGoldB1_xyz_Restart() {}\n', 'utf8');
    await writeFile(path.join(jobDir, 'artifacts/bug1-gold.json'), `${JSON.stringify({
      root_cause_file: 'pkg/store.go',
      root_cause_symbols: ['pkg.(*Store).Load'],
      internal_cause: 'Load 错误更新恢复状态字段。',
      propagation_path: '错误状态随后传入读取结果，导致返回值异常。',
      observable_failure: '重启后公开读取返回错误结果。',
      mechanism_keywords: ['状态恢复', '错误更新', '重启读取'],
      test_package: './pkg',
      test_name: 'TestGoldB1_xyz_Restart',
      verification_summary: 'focused and full tests passed successfully',
    })}\n`, 'utf8');
    await rejectGoldCheckpoint(jobDir, 1, 'GOLD_PUBLIC_CONTRACT_CONFLICT');
    assert.equal(await recoverGoldCheckpoint({
      jobDir,
      goldDir: source,
      bugIndex: 1,
      bugBaseCommit: baseCommit,
      requiredPrefix: 'TestGoldB1_xyz_',
      expectedFiles: ['pkg/store.go'],
      expectedSymbols: ['(*Store).Load'],
    }), null);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('Gold semantic failures invalidate a reusable checkpoint', () => {
  assert.equal(isGoldCheckpointSemanticFailure('Gold 全量测试失败：public test conflict'), true);
  assert.equal(isGoldCheckpointSemanticFailure('Gold 回归测试题面契约复核不通过：GOLD_QUERY_SCOPE_CONFLICT'), true);
  assert.equal(isGoldCheckpointSemanticFailure('GOLD_PUBLIC_CONTRACT_CONFLICT existing behavior'), true);
  assert.equal(isGoldCheckpointSemanticFailure('Gold internal_cause 必须说明实现内部的错误检查、状态或控制流，不能填写可观察现象'), true);
  assert.equal(isGoldCheckpointSemanticFailure('Codex CLI gateway timeout'), false);
});

test('Gold regression tests may use the same package but cannot bypass public behavior boundaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-public-test-'));
  try {
    await writeFile(path.join(directory, 'public_test.go'), 'package sample_test\n\nfunc TestPublic(t *testing.T) {}\n', 'utf8');
    assert.deepEqual(await assertGoldTestsUsePublicBehavior(directory, ['public_test.go']), { samePackageFiles: [] });
    await writeFile(path.join(directory, 'private_test.go'), 'package sample\n\nfunc TestPrivate(t *testing.T) {}\n', 'utf8');
    assert.deepEqual(await assertGoldTestsUsePublicBehavior(directory, ['private_test.go']), { samePackageFiles: ['private_test.go'] });
    await writeFile(path.join(directory, 'unsafe_test.go'), 'package sample\n\nimport "unsafe"\nfunc TestUnsafe(t *testing.T) { _ = unsafe.Pointer(nil) }\n', 'utf8');
    await assert.rejects(assertGoldTestsUsePublicBehavior(directory, ['unsafe_test.go']), /unsafe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Sol quality review bundle contains only the current delivery candidate', async () => {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-quality-source-'));
  const trajectoryFilename = path.join(sourceDirectory, 'trajectory_session.json');
  let bundle;
  try {
    await writeFile(trajectoryFilename, '[{"type":"result","session_id":"session-current"}]\n', 'utf8');
    bundle = await createCurrentQualityReviewBundle({
      taskMeta: { sample_id: 'sample-task', trajectory_count: 1 },
      validationReport: { ok: true, reports: [{ file: '/task/history/old/trajectory.json', ok: true }] },
      redGreen: { redExitCode: 1, greenExitCode: 0 },
      trajectoryFilename,
    });
    assert.deepEqual((await readdir(bundle.directory)).sort(), ['public.json', 'red-green.json', 'trajectory.json', 'validator.json']);
    assert.equal((await readJson(path.join(bundle.directory, 'validator.json'))).reports[0].file, 'trajectory.json');
    assert.match(await readFile(bundle.trajectoryFilename, 'utf8'), /session-current/);
  } finally {
    if (bundle?.directory) await rm(bundle.directory, { recursive: true, force: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test('Sol quality review bundle preserves a native JSONL candidate', async () => {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-quality-jsonl-'));
  const trajectoryFilename = path.join(sourceDirectory, 'trajectory_session.jsonl');
  let bundle;
  try {
    await writeFile(trajectoryFilename, '{"type":"assistant","sessionId":"session-current"}\n', 'utf8');
    bundle = await createCurrentQualityReviewBundle({
      taskMeta: { sample_id: 'sample-task', trajectory_count: 1 },
      validationReport: { ok: true, reports: [{ file: trajectoryFilename, ok: true }] },
      redGreen: { redExitCode: 1, greenExitCode: 0 },
      trajectoryFilename,
    });
    assert.deepEqual((await readdir(bundle.directory)).sort(), ['public.json', 'red-green.json', 'trajectory.jsonl', 'validator.json']);
    assert.equal((await readJson(path.join(bundle.directory, 'validator.json'))).reports[0].file, 'trajectory.jsonl');
  } finally {
    if (bundle?.directory) await rm(bundle.directory, { recursive: true, force: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test('trajectory retry moves prior attempts outside the task and rebuilds a pristine workspace', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-retry-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskDir = path.join(tasksRoot, 'sample-task');
  try {
    await mkdir(path.join(taskDir, 'pristine'), { recursive: true });
    await mkdir(path.join(taskDir, 'workspace'), { recursive: true });
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await mkdir(path.join(taskDir, 'history', 'old-attempt'), { recursive: true });
    await mkdir(path.join(library, 'validation'), { recursive: true });
    await writeFile(path.join(taskDir, 'pristine/app.go'), 'package app\n', 'utf8');
    await writeFile(path.join(taskDir, 'workspace/app.go'), 'package changed\n', 'utf8');
    await writeFile(path.join(taskDir, 'trajectory/trajectory.stream.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(taskDir, 'history/old-attempt/validator.json'), '{"ok":true}\n', 'utf8');
    await writeFile(path.join(taskDir, 'regeneration-instructions.txt'), 'leaked previous fix details\n', 'utf8');
    await writeFile(path.join(taskDir, 'public.json'), JSON.stringify({
      sample_id: 'sample-task',
      verification_policy_version: 5,
      verify_cmds: ['go test ./...'],
      verify_result: '{"pre_fix":{},"post_fix":{}}',
      verification_evidence: {
        pre_fix: { session_id: 'pre-session', result: 'red' },
        post_fix: { session_id: 'post-session', result: 'green' },
      },
      generator_model: 'old-model',
      test_model_fix_commit: 'old-commit',
      test_model_fix_session_id: 'old-session',
      repo_url: 'https://example.test/old',
    }), 'utf8');
    await writeFile(path.join(library, 'validation/review_statuses.json'), '[{"taskId":"old"}]\n', 'utf8');

    await prepareTrajectoryRetry({ tasksRoot }, { taskDir, taskName: 'sample-task' });

    assert.equal(await readFile(path.join(taskDir, 'workspace/app.go'), 'utf8'), 'package app\n');
    await assert.rejects(readFile(path.join(taskDir, 'trajectory/trajectory.stream.jsonl'), 'utf8'));
    await assert.rejects(readFile(path.join(taskDir, 'regeneration-instructions.txt'), 'utf8'));
    const publicMetadata = await readJson(path.join(taskDir, 'public.json'));
    assert.equal(publicMetadata.generator_model, '');
    assert.equal(Object.hasOwn(publicMetadata, 'test_model_fix_commit'), false);
    assert.deepEqual(publicMetadata.verify_cmds, ['go test ./...']);
    assert.equal(publicMetadata.verification_evidence.pre_fix.session_id, 'pre-session');
    assert.equal(Object.hasOwn(publicMetadata.verification_evidence, 'post_fix'), false);
    assert.equal(Object.hasOwn(publicMetadata, 'verify_result'), false);
    const retryRoots = await readdir(path.join(library, 'retry-history', 'sample-task'));
    assert.equal(retryRoots.length, 1);
    assert.match(await readFile(path.join(library, 'retry-history', 'sample-task', retryRoots[0], 'earlier-attempts/old-attempt/validator.json'), 'utf8'), /true/);
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('trajectory retry archives an unchanged bugfix repair checkpoint instead of reusing it', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-invalid-repair-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskDir = path.join(tasksRoot, 'sample-task');
  try {
    await Promise.all([
      mkdir(path.join(taskDir, 'pristine'), { recursive: true }),
      mkdir(path.join(taskDir, 'workspace'), { recursive: true }),
      mkdir(path.join(taskDir, 'trajectory'), { recursive: true }),
      mkdir(path.join(taskDir, '.repair-checkpoint/workspace'), { recursive: true }),
      mkdir(path.join(library, 'validation'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(taskDir, 'pristine/app.go'), 'package app\n'),
      writeFile(path.join(taskDir, 'workspace/app.go'), 'package app\n'),
      writeFile(path.join(taskDir, 'trajectory/trajectory.stream.jsonl'), '{}\n'),
      writeFile(path.join(taskDir, '.repair-checkpoint/workspace/app.go'), 'package app\n'),
      writeFile(path.join(taskDir, '.repair-checkpoint/workspace/app_test.go'), 'package app\n'),
      writeFile(path.join(taskDir, '.repair-checkpoint/checkpoint.json'), '{"stage":"claude_repair_complete"}\n'),
      writeFile(path.join(taskDir, 'public.json'), JSON.stringify({
        task_type: 'bugfix',
        workflow_policy_version: 4,
        verification_policy_version: 5,
        verification_test_files: [],
      })),
    ]);

    const result = await prepareTrajectoryRetry({ tasksRoot }, { taskDir, taskName: 'sample-task' }, 'REUSABLE_REPAIR_CHECKPOINT=1');

    assert.equal(result.reuseLevel, 0);
    await assert.rejects(stat(path.join(taskDir, '.repair-checkpoint/checkpoint.json')), /ENOENT/);
    const retries = await readdir(path.join(library, 'retry-history', 'sample-task'));
    assert.equal(await stat(path.join(library, 'retry-history', 'sample-task', retries[0], 'internal-retry-state/.repair-checkpoint/checkpoint.json')).then(() => true), true);
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('trajectory retry preserves a Docker-complete checkpoint across a monitor restart', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-publish-retry-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskDir = path.join(tasksRoot, 'sample-task');
  try {
    await mkdir(path.join(taskDir, 'pristine'), { recursive: true });
    await mkdir(path.join(taskDir, 'workspace'), { recursive: true });
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await mkdir(path.join(taskDir, '.publish-checkpoint', 'workspace'), { recursive: true });
    await writeFile(path.join(taskDir, 'pristine/app.go'), 'package app\n', 'utf8');
    await writeFile(path.join(taskDir, 'workspace/app.go'), 'package fixed\n', 'utf8');
    await writeFile(path.join(taskDir, 'trajectory/pending.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(taskDir, '.publish-checkpoint/workspace/app.go'), 'package fixed\n', 'utf8');
    await writeFile(path.join(taskDir, '.publish-checkpoint/checkpoint.json'), '{"stage":"docker_complete"}\n', 'utf8');
    const publicMetadata = {
      verification_policy_version: 5,
      task_type: 'bugfix',
      verify_cmds: ['go test . -run ^TestModel_Bug$ -count=1'],
      generator_model: 'model_hub/glm-52-coding',
      verification_test_author_session_id: 'author-session',
    };
    await writeFile(path.join(taskDir, 'public.json'), JSON.stringify(publicMetadata), 'utf8');

    const result = await prepareTrajectoryRetry({ tasksRoot }, { taskDir, taskName: 'sample-task' });

    assert.equal(result.reuseLevel, 4);
    assert.equal(await readFile(path.join(taskDir, '.publish-checkpoint/workspace/app.go'), 'utf8'), 'package fixed\n');
    assert.deepEqual(await readJson(path.join(taskDir, 'public.json')), publicMetadata);
    assert.equal(await readFile(path.join(taskDir, 'workspace/app.go'), 'utf8'), 'package app\n');
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('a passed trajectory is restored from a hash-bound retry archive before Claude can rerun', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-trajectory-restore-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskName = 'sample-task';
  const taskDir = path.join(tasksRoot, taskName);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const archive = path.join(library, 'retry-history', taskName, 'runner-retry-2');
  const stream = '{"type":"system","session_id":"11111111-1111-4111-8111-111111111111"}\n';
  const delivery = '{"type":"system","session_id":"11111111-1111-4111-8111-111111111111","uuid":"one"}\n';
  const raw = '{"type":"system","session_id":"11111111-1111-4111-8111-111111111111","raw":true}\n';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(taskDir, 'trajectory/incomplete.log'), 'interrupted retry\n');
    await Promise.all([
      writeFile(path.join(archive, 'trajectory.stream.jsonl'), stream),
      writeFile(path.join(archive, `trajectory_${sessionId}.jsonl`), delivery),
      writeFile(path.join(archive, `raw.native.${sessionId}.jsonl`), raw),
      writeFile(path.join(archive, 'mutation-audit.jsonl'), ''),
      writeFile(path.join(archive, 'session_id.txt'), `${sessionId}\n`),
      writeFile(path.join(archive, `validator-${sessionId}.json`), JSON.stringify({
        ok: true,
        reports: [{ ok: true, stats: { sessionId } }],
      })),
      writeFile(path.join(archive, 'runner-manifest.json'), JSON.stringify({
        session_id: sessionId,
        delivery_filename: `trajectory_${sessionId}.jsonl`,
        raw_filename: `raw.native.${sessionId}.jsonl`,
        stream_sha256: digest(stream),
        delivery_sha256: digest(delivery),
        raw_sha256: digest(raw),
        audit_sha256: digest(''),
      })),
    ]);

    const result = await restoreArchivedTrajectoryArtifacts(
      { tasksRoot },
      { taskDir, taskName },
      { attempts: [{ status: 'passed', sessionId }] },
    );

    assert.equal(result.restored, true);
    assert.equal(result.sessionId, sessionId);
    assert.equal(await readFile(path.join(taskDir, 'trajectory/trajectory.stream.jsonl'), 'utf8'), stream);
    const history = await readdir(path.join(library, 'retry-history', taskName));
    const replaced = history.find((name) => name.startsWith('recovery-replaced-'));
    assert.ok(replaced);
    assert.equal(await readFile(path.join(library, 'retry-history', taskName, replaced, 'incomplete.log'), 'utf8'), 'interrupted retry\n');
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('reusable trajectories are revalidated and existing Git layouts repopulate public delivery metadata', async () => {
  const source = await readFile(path.join(process.cwd(), 'scripts/run-production-pipeline.mjs'), 'utf8');
  assert.match(source, /const validation = await runTrajectoryValidator\(task, trajectory\);\n\s+await updateTaskAfterTrajectory\(task\.taskDir, trajectory, validation\);/);
  assert.match(source, /publicationPassed[\s\S]*remoteHead\(job\.request\.cloneUrl, existing\.green_branch, layoutDir\)/);
  assert.match(source, /passedRepairAttempts[\s\S]*\.at\(-1\)\?\.sessionId/);
  assert.match(source, /test_model_fix_commit: existing\.green_commit[\s\S]*test_model_fix_session_id: repairSessionId[\s\S]*red_pushed: publicationPassed/);
  assert.match(source, /test_model_fix_commit: greenCommit[\s\S]*test_model_fix_session_id: repairSessionId[\s\S]*red_pushed: false/);
});

test('coverage preflight retry archives the old fix and rebuilds from pristine', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-coverage-retry-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskDir = path.join(tasksRoot, 'sample-task');
  try {
    await mkdir(path.join(taskDir, 'pristine'), { recursive: true });
    await mkdir(path.join(taskDir, 'workspace'), { recursive: true });
    await mkdir(path.join(taskDir, '.coverage-repair-workspace'), { recursive: true });
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await mkdir(path.join(library, 'validation'), { recursive: true });
    await writeFile(path.join(taskDir, 'pristine/app.go'), 'package app\n', 'utf8');
    await writeFile(path.join(taskDir, 'workspace/app.go'), 'package stale\n', 'utf8');
    await writeFile(path.join(taskDir, '.coverage-repair-workspace/app.go'), 'package repaired\n', 'utf8');
    await writeFile(path.join(taskDir, '.coverage-repair-workspace/missing_test.go'), 'package app\n', 'utf8');
    await writeFile(path.join(taskDir, '.retry-feedback'), 'stale hidden acceptance details\n', 'utf8');
    await writeFile(path.join(taskDir, 'public.json'), JSON.stringify({
      verification_policy_version: 5,
      task_type: 'bugfix',
      verify_cmds: [],
      verification_evidence: {},
    }), 'utf8');

    await prepareTrajectoryRetry({ tasksRoot }, { taskDir, taskName: 'sample-task' }, 'COVERAGE_PREFLIGHT: missing quarantined');

    assert.equal(await readFile(path.join(taskDir, 'workspace/app.go'), 'utf8'), 'package app\n');
    await assert.rejects(readFile(path.join(taskDir, 'workspace/missing_test.go'), 'utf8'));
    await assert.rejects(readFile(path.join(taskDir, '.coverage-repair-workspace/app.go'), 'utf8'));
    await assert.rejects(readFile(path.join(taskDir, '.retry-feedback'), 'utf8'));
    const retryRoots = await readdir(path.join(library, 'retry-history', 'sample-task'));
    assert.equal(await readFile(path.join(library, 'retry-history', 'sample-task', retryRoots[0], 'internal-retry-state/.coverage-repair-workspace/app.go'), 'utf8'), 'package repaired\n');
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('trajectory retry archives a timeout checkpoint and rebuilds from pristine', async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), 'pipeline-progress-retry-library-'));
  const tasksRoot = path.join(library, 'tasks');
  const taskDir = path.join(tasksRoot, 'sample-task');
  try {
    await mkdir(path.join(taskDir, 'pristine'), { recursive: true });
    await mkdir(path.join(taskDir, 'workspace'), { recursive: true });
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await mkdir(path.join(taskDir, '.progress-checkpoint/workspace'), { recursive: true });
    await mkdir(path.join(library, 'validation'), { recursive: true });
    await writeFile(path.join(taskDir, 'pristine/app.go'), 'package app\n', 'utf8');
    await writeFile(path.join(taskDir, 'workspace/app.go'), 'package stale\n', 'utf8');
    await writeFile(path.join(taskDir, '.progress-checkpoint/workspace/app.go'), 'package resumed\n', 'utf8');
    await writeFile(path.join(taskDir, '.progress-checkpoint/checkpoint.json'), '{"reason":"real_workspace_progress_timeout"}\n', 'utf8');
    await writeFile(path.join(taskDir, 'public.json'), JSON.stringify({
      verification_policy_version: 5,
      task_type: 'bugfix',
      verify_cmds: [],
      verification_evidence: {},
    }), 'utf8');

    await prepareTrajectoryRetry({ tasksRoot }, { taskDir, taskName: 'sample-task' });

    assert.equal(await readFile(path.join(taskDir, 'workspace/app.go'), 'utf8'), 'package app\n');
    await assert.rejects(readFile(path.join(taskDir, '.progress-checkpoint/checkpoint.json'), 'utf8'));
    const retryRoots = await readdir(path.join(library, 'retry-history', 'sample-task'));
    assert.match(await readFile(path.join(library, 'retry-history', 'sample-task', retryRoots[0], 'internal-retry-state/.progress-checkpoint/checkpoint.json'), 'utf8'), /real_workspace_progress_timeout/);
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});

test('verification manifest recovery restores public evidence only for the current commands and commit', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'verification-manifest-recovery-'));
  const manifestPath = path.join(taskDir, 'verification/pre_fix/attempt-1/manifest.json');
  const verifyCmds = ['docker build --platform linux/amd64 .', 'docker run grader /grader/run_target.sh /workspace'];
  const sourceCommit = 'a'.repeat(40);
  const manifest = {
    policy_version: 5,
    phase: 'pre_fix',
    command_mode: 'direct_verify_cmds_v2',
    command_count: verifyCmds.length,
    session_id: '11111111-1111-4111-8111-111111111111',
    result: 'red',
    source_commit: sourceCommit,
    verify_cmds_sha256: verificationCommandsSha256(verifyCmds),
    trajectory_sha256: '1'.repeat(64),
    raw_stream_sha256: '2'.repeat(64),
    prompt_sha256: '3'.repeat(64),
    result_sha256: '4'.repeat(64),
    command_results_sha256: '5'.repeat(64),
  };
  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
      bug_base_commit: sourceCommit,
      verify_cmds: verifyCmds,
      verification_evidence: {},
    }, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const evidence = await persistVerificationManifest(taskDir, 'pre_fix', manifest, manifestPath);
    assert.equal(evidence.verify_cmds_sha256, verificationCommandsSha256(verifyCmds));
    assert.equal(evidence.local_manifest, 'verification/pre_fix/attempt-1/manifest.json');
    const restored = await readJson(path.join(taskDir, 'public.json'));
    assert.equal(restored.verification_evidence.pre_fix.session_id, manifest.session_id);

    restored.verify_cmds = ['go test ./...'];
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify(restored, null, 2)}\n`, 'utf8');
    await assert.rejects(
      persistVerificationManifest(taskDir, 'pre_fix', manifest, manifestPath),
      /verify_cmds 已失效/,
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('proof recovery restores matching evidence and reopens a stale post-fix commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-evidence-resume-'));
  const taskDir = path.join(root, 'task');
  const jobFile = path.join(root, 'job.json');
  const commands = ["go test ./internal/sample -run '^TestModel_Sample$' -count=1 -v"];
  const commandsSha = verificationCommandsSha256(commands);
  const baseCommit = 'a'.repeat(40);
  const fixedCommit = 'b'.repeat(40);
  const manifest = (phase, sourceCommit, sessionId) => ({
    policy_version: 5,
    phase,
    command_mode: 'direct_verify_cmds_v2',
    command_count: 1,
    session_id: sessionId,
    result: phase === 'pre_fix' ? 'red' : 'green',
    source_commit: sourceCommit,
    verify_cmds_sha256: commandsSha,
    trajectory_sha256: '1'.repeat(64),
    raw_stream_sha256: '2'.repeat(64),
    prompt_sha256: '3'.repeat(64),
    result_sha256: '4'.repeat(64),
    command_results_sha256: '5'.repeat(64),
  });
  try {
    await Promise.all([
      mkdir(path.join(taskDir, 'verification/pre_fix/attempt-1'), { recursive: true }),
      mkdir(path.join(taskDir, 'verification/post_fix/attempt-1'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
        bug_base_commit: baseCommit,
        test_model_fix_commit: fixedCommit,
        verify_cmds: commands,
        verification_evidence: {},
      }, null, 2)}\n`),
      writeFile(path.join(taskDir, 'verification/pre_fix/attempt-1/manifest.json'), `${JSON.stringify(manifest('pre_fix', baseCommit, '11111111-1111-4111-8111-111111111111'))}\n`),
      writeFile(path.join(taskDir, 'verification/post_fix/attempt-1/manifest.json'), `${JSON.stringify(manifest('post_fix', 'c'.repeat(40), '22222222-2222-4222-8222-222222222222'))}\n`),
      writeFile(jobFile, `${JSON.stringify({ bugs: [{
        bugIndex: 1,
        verificationEvidence: { post_fix: { session_id: 'stale-session' } },
      }], stages: [
        { id: 'bug1_pre_verify', status: 'passed', result: { result: 'red' } },
        { id: 'bug1_post_verify', status: 'passed', result: { result: 'green' } },
      ] }, null, 2)}\n`),
    ]);
    const recovered = await restoreVerificationEvidenceFromManifests(jobFile, 1, taskDir, 'bugfix');
    assert.deepEqual(recovered.restored, ['pre_fix']);
    assert.equal(recovered.reset.length, 1);
    const metadata = await readJson(path.join(taskDir, 'public.json'));
    assert.equal(metadata.verification_evidence.pre_fix.local_manifest, 'verification/pre_fix/attempt-1/manifest.json');
    assert.equal(metadata.verification_evidence.post_fix, undefined);
    const job = await readJson(jobFile);
    assert.equal(job.stages[0].status, 'passed');
    assert.equal(job.stages[1].status, 'pending');
    assert.equal(job.stages[1].resultHistory[0].result.result, 'green');
    assert.equal(job.bugs[0].verificationEvidence.pre_fix.session_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(job.bugs[0].verificationEvidence.post_fix, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pipeline runner flushes complete command artifacts beyond the in-memory output limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-output-test-'));
  const output = path.join(directory, 'events.jsonl');
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-large' });
  const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-large' });
  const script = [
    `process.stdout.write(${JSON.stringify(`${init}\n`)})`,
    `for (let index = 0; index < 33; index += 1) process.stdout.write('x'.repeat(64 * 1024))`,
    `process.stdout.write(${JSON.stringify(`\n${success}\n`)})`,
  ].join(';');
  try {
    const result = await runCommand(process.execPath, ['-e', script], { stdoutPath: output, timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes(init), false, 'the bounded in-memory tail should discard the first event');
    const persisted = await readFile(output, 'utf8');
    assert.ok(persisted.startsWith(`${init}\n`));
    assert.ok(persisted.endsWith(`${success}\n`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pipeline runner emits syntactically valid hidden grader scripts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pipeline-grader-test-'));
  const taskDir = path.join(directory, 'task');
  const goldDir = path.join(directory, 'gold');
  try {
    await mkdir(path.join(goldDir, 'pkg'), { recursive: true });
    await writeFile(path.join(goldDir, 'pkg/regression_test.go'), 'package pkg\n', 'utf8');
    await writeGrader(taskDir, goldDir, ['pkg/regression_test.go'], { test_package: './pkg', test_name: 'TestRegression' });
    for (const scriptName of ['run_target.sh', 'run_compile.sh', 'run_full.sh', 'run_static.sh', 'run_docker.sh']) {
      const script = path.join(taskDir, 'grader', scriptName);
      await chmod(script, 0o755);
      const result = spawnSync('/bin/bash', ['-n', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const target = await readFile(path.join(taskDir, 'grader/run_target.sh'), 'utf8');
    assert.match(target, /\$\{1:\?workspace is required\}/);
    assert.ok(target.includes(`"$go_bin" test './pkg' -run '^TestRegression$' -count=20`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
