import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRecoveryState,
  recoveryPromptDocument,
} from '../scripts/restore-archived-diagnosis-rejection.mjs';

test('archived diagnosis recovery preserves the public user query verbatim', () => {
  const userQuery = '窗口外读数没有阻止完成，请定位原因。';
  assert.equal(recoveryPromptDocument(`  ${userQuery}\n`), `${userQuery}\n`);
  assert.doesNotMatch(recoveryPromptDocument(userQuery), /^# 用户题面/u);
});

test('archived diagnosis recovery queues only the rejected bug', () => {
  const createdAt = '2026-08-25T08:00:00.000Z';
  const libraryRoot = path.join(os.tmpdir(), 'go-task-library-recovery-test');
  const record = {
    id: 'task-957dc3628811035d',
    name: 'facadelatch-silicone-joint-release-bug9-out-of-window-attempt-ignored-by',
    bug_id: 'nyh-go-0246-bug-09',
    bug_index: 9,
    pipeline_job_id: 'pipeline-20260822023527-a74d7e88',
    repository: 'https://github.com/example/go-0246',
    main_branch: 'main',
    red_branch: 'bug9_red',
    red_commit: '491d2dad17309b23fb09f25dc30b51274f451709',
    task_type: 'diagnosis',
    title: 'service.processCureAttempt异常根因定位',
    user_query: '窗口外读数没有阻止完成，请定位原因。',
    success_criteria: '窗口外读数必须阻止完成。',
    gold_root_cause: 'service/cure.go、cure/duty.go 中的 service.processCureAttempt 根本原因是完成判定过滤掉无效读数，最终错误标记为 completed。',
    verify_cmds: "go test ./service -run '^TestModel_CureCompletionAccountsForInvalidHistory$' -count=1 -v",
    verification_evidence: { pre_fix: { session_id: '331dd878-0fb8-4669-98b2-1383ddadbf84' } },
  };
  const state = buildRecoveryState({
    record,
    libraryRoot,
    mainCommit: 'a66e48c2599d4e62a735853ac86712ee40d0402e',
    testFile: 'service/cure_invalid_history_model_test.go',
    testName: 'TestModel_CureCompletionAccountsForInvalidHistory',
    testSha256: 'a385275d20a12338c375e12808007a71c1718399a541df9e91a6cde1f06dd439',
    createdAt,
  });

  assert.equal(state.job.status, 'waiting_resource');
  assert.equal(state.job.currentStage, 'bug9_claude_fix');
  assert.equal(state.job.waitingResource.pool, 'compute-repair');
  assert.equal(state.job.bugs.length, 10);
  assert.equal(state.job.bugs.find((bug) => bug.bugIndex === 9).workerExecution.status, 'fast_lane_queued');
  assert.equal(state.job.bugs.filter((bug) => bug.disposition === 'skipped').length, 9);
  assert.equal(state.job.stages.find((stage) => stage.id === 'bug9_test_author').status, 'passed');
  assert.equal(state.job.stages.find((stage) => stage.id === 'bug9_pre_verify').status, 'pending');
  assert.equal(state.metadata.verification_test_overlay, 'none');
  assert.deepEqual(state.metadata.verify_cmds, []);
  assert.equal(state.authored.testName, 'TestModel_CureCompletionAccountsForInvalidHistory');
  assert.deepEqual(state.graderContext.gold_files, ['service/cure.go', 'cure/duty.go']);
  assert.match(state.graderContext.failure_mechanism, /错误标记为 completed/);
});
