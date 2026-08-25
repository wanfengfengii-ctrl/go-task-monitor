import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginBugAttempt,
  bugExecutionPhaseIndex,
  enqueueBugRetry,
  finishBugAttempt,
  nextIncompleteBugIndex,
  normalizeBugExecution,
  publicBugWorkbench,
  summarizeBugAttempts,
  isBugFailed,
  takeBugRetryQueue,
} from './bug-workbench.js';

test('checkpoint subphases advance the workbench past source locating', () => {
  assert.equal(bugExecutionPhaseIndex('diagnosis_repair_checkpoint_saved', 'bug1_claude_fix'), 3);
  assert.equal(bugExecutionPhaseIndex('claude_repair_checkpoint_saved', 'bug1_claude_fix'), 3);
  assert.equal(bugExecutionPhaseIndex('', 'bug1_pre_verify'), 3);
});

test('manual retry queue is deduplicated and consumed only by a fresh runner', () => {
  const job = {};
  enqueueBugRetry(job, 2, '2026-08-23T00:00:00.000Z');
  enqueueBugRetry(job, 2, '2026-08-23T00:01:00.000Z');
  enqueueBugRetry(job, 1, '2026-08-23T00:02:00.000Z');
  assert.deepEqual(job.pendingBugRetries, [1, 2]);
  assert.deepEqual(takeBugRetryQueue(job), [1, 2]);
  assert.equal('pendingBugRetries' in job, false);
});

test('workbench keeps first failure while later retry succeeds', () => {
  const started = beginBugAttempt({ bugIndex: 1 }, { attempt: 1, startedAt: '2026-08-20T00:00:00.000Z' });
  const failed = finishBugAttempt(started, { status: 'failed', stage: 'bug1_claude_fix', error: '第一次失败' }, '2026-08-20T00:01:00.000Z');
  const retry = beginBugAttempt(failed, { attempt: 2, startedAt: '2026-08-20T00:02:00.000Z', action: 'manual_retry' });
  const passed = finishBugAttempt(retry, { status: 'passed', stage: 'bug1_trajectory_validate' }, '2026-08-20T00:03:00.000Z');
  assert.equal(passed.firstFailure.error, '第一次失败');
  assert.equal(passed.lastFailure.error, '第一次失败');
  assert.equal(summarizeBugAttempts(passed).count, 2);
  assert.equal(summarizeBugAttempts(passed).totalDurationMs, 120000);
});

test('next incomplete bug uses selected order but falls back to the first pending bug', () => {
  const job = {
    bugs: [{ bugIndex: 1 }, { bugIndex: 2 }, { bugIndex: 3 }],
    stages: [
      { id: 'bug1_delivery_ready', status: 'passed' },
      { id: 'bug2_delivery_ready', status: 'pending' },
      { id: 'bug3_delivery_ready', status: 'pending' },
    ],
  };
  assert.equal(nextIncompleteBugIndex(job, 2), 2);
  assert.equal(nextIncompleteBugIndex(job, 4), 2);
});

test('failed Bug is terminal for automatic selection but remains visibly failed', () => {
  const job = {
    bugs: [
      { bugIndex: 1, disposition: 'failed', failureDisposition: 'auto_continued', lastFailure: { stage: 'bug1_gold_fix', error: 'Gold 失败' } },
      { bugIndex: 2 },
    ],
    stages: [
      { id: 'bug1_delivery_ready', status: 'skipped', bugIndex: 1 },
      { id: 'bug2_delivery_ready', status: 'pending', bugIndex: 2 },
    ],
    bugExecution: { selectedBugIndex: 2, status: 'fast_lane_running', currentStage: 'bug2_gold_fix' },
  };
  assert.equal(isBugFailed(job, 1), true);
  assert.equal(nextIncompleteBugIndex(job, 1), 2);
  assert.equal(publicBugWorkbench(job, 1).status, 'fast_lane_failed');
  assert.equal(publicBugWorkbench(job, 1).lastFailure.error, 'Gold 失败');
});

test('failed Bug displays its finalization failure instead of a stale test-author checkpoint', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    bugs: [{
      bugIndex: 6,
      disposition: 'failed',
      failureDisposition: 'auto_continued',
      lastFailure: {
        status: 'failed',
        stage: 'bug6_verification_finalize',
        error: 'finalization failed',
      },
      workerExecution: {
        status: 'fast_lane_failed',
        currentStage: 'bug6_verification_finalize',
        subphase: 'awaiting_codex_test_author',
        resourceStage: 'bug6_claude_fix',
      },
    }],
    stages: [{
      id: 'bug6_verification_finalize',
      bugIndex: 6,
      status: 'skipped',
      label: '回填 verify_result 验证证明',
    }],
  }, 6);

  assert.equal(visible.status, 'fast_lane_failed');
  assert.equal(visible.currentStage, 'bug6_verification_finalize');
  assert.equal(visible.currentStageLabel, '回填 verify_result 验证证明');
  assert.equal(visible.subphase, '');
  assert.equal(visible.resourceStage, 'bug6_verification_finalize');
  assert.equal(bugExecutionPhaseIndex(visible.subphase, visible.currentStage || visible.resourceStage), 5);
});

test('running Bug displays a later Git stage instead of a stale test-author subphase', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    bugs: [{
      bugIndex: 8,
      workerExecution: {
        status: 'fast_lane_running',
        currentStage: 'bug8_git_publication',
        subphase: 'awaiting_codex_test_author',
        resourceStage: 'bug8_claude_fix',
      },
    }],
    stages: [{
      id: 'bug8_git_publication',
      bugIndex: 8,
      status: 'running',
      label: 'Git 发布',
    }],
  }, 8);

  assert.equal(visible.status, 'fast_lane_running');
  assert.equal(visible.currentStage, 'bug8_git_publication');
  assert.equal(visible.currentStageLabel, 'Git 发布');
  assert.equal(bugExecutionPhaseIndex(visible.subphase, visible.currentStage), 5);
});

test('normalizes workbench defaults without changing explicit auto-continue', () => {
  assert.deepEqual(normalizeBugExecution({ autoContinue: false, selectedBugIndex: '3' }), {
    mode: 'workbench', selectedBugIndex: 3, autoContinue: false, status: 'bug_ready',
    startedAt: null, updatedAt: null, currentAttempt: 0, currentStage: '',
    subphase: '', resourceStage: '',
    lastHeartbeatAt: null, blockedReason: '', lastAction: '',
  });
});

test('public workbench exposes complete attempt history and active state', () => {
  const failed = finishBugAttempt(
    beginBugAttempt({ bugIndex: 2 }, {
      attempt: 1,
      stage: 'bug2_claude_fix',
      sessionId: 'session-1',
      startedAt: '2026-08-20T00:00:00.000Z',
    }),
    {
      status: 'failed',
      failureCategory: 'verification',
      exitCode: 7,
      error: '完整失败原因',
    },
    '2026-08-20T00:01:00.000Z',
  );
  const running = beginBugAttempt(failed, {
    attempt: 2,
    stage: 'bug2_claude_fix',
    sessionId: 'session-2',
    startedAt: '2026-08-20T00:02:00.000Z',
  });
  const visible = publicBugWorkbench({
    bugExecution: {
      selectedBugIndex: 2,
      status: 'fast_lane_running',
      startedAt: '2026-08-20T00:02:00.000Z',
      updatedAt: '2026-08-20T00:02:30.000Z',
      blockedReason: '等待验证资源',
      lastAction: 'manual_retry',
    },
    bugs: [running],
    stages: [{ id: 'bug2_claude_fix', bugIndex: 2, status: 'running', label: 'Claude 修复' }],
    currentStage: 'bug2_claude_fix',
  }, 2, Date.parse('2026-08-20T00:03:00.000Z'));
  assert.equal(visible.status, 'fast_lane_running');
  assert.equal(visible.attemptCount, 2);
  assert.equal(visible.attempts.length, 2);
  assert.equal(visible.firstFailure.failureCategory, 'verification');
  assert.equal(visible.firstFailure.exitCode, 7);
  assert.equal(visible.lastFailure.error, '完整失败原因');
  assert.equal(visible.blockedReason, '等待验证资源');
  assert.equal(visible.lastAction, 'manual_retry');
  assert.equal('taskDir' in visible.attempts[0], false);
});

test('workbench does not count queue time before the first Bug attempt begins', () => {
  const visible = publicBugWorkbench({
    status: 'waiting_resource',
    processActive: false,
    bugExecution: {
      selectedBugIndex: 1,
      status: 'fast_lane_queued',
      startedAt: '2026-08-20T00:00:00.000Z',
      currentStage: 'bug1_gold_fix',
    },
    bugs: [{ bugIndex: 1 }],
    stages: [{ id: 'bug1_gold_fix', bugIndex: 1, status: 'pending', label: 'Gold 修复' }],
  }, 1, Date.parse('2026-08-20T00:02:00.000Z'));
  assert.equal(visible.status, 'fast_lane_queued');
  assert.equal(visible.elapsedMs, 0);
  assert.equal(visible.startedAt, null);
});

test('workbench shows a selected waiting-resource Bug as queued with its timer paused', () => {
  const visible = publicBugWorkbench({
    status: 'waiting_resource',
    processActive: false,
    waitingResource: { stageId: 'bug1_gold_fix', pool: 'compute-heavy' },
    bugExecution: {
      selectedBugIndex: 1,
      status: 'fast_lane_running',
      startedAt: '2026-08-20T00:00:00.000Z',
      currentStage: 'bug1_gold_fix',
    },
    bugs: [{ bugIndex: 1 }],
    stages: [{ id: 'bug1_gold_fix', bugIndex: 1, status: 'pending', label: 'Gold 修复' }],
  }, 1, Date.parse('2026-08-20T00:02:03.000Z'));
  assert.equal(visible.status, 'fast_lane_queued');
  assert.equal(visible.elapsedMs, 0);
  assert.equal(visible.startedAt, null);
});

test('workbench shows a finalization retry queued behind another active Bug without stale test-author state', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    pendingBugRetries: [6],
    bugExecution: {
      selectedBugIndex: 4,
      status: 'fast_lane_running',
      currentStage: 'bug4_test_author',
    },
    bugs: [{
      bugIndex: 6,
      lastFailure: { status: 'failed', stage: 'bug6_verification_finalize', error: 'fetch failed' },
      workerExecution: {
        selectedBugIndex: 6,
        status: 'fast_lane_queued',
        currentStage: 'bug6_verification_finalize',
        subphase: 'awaiting_codex_test_author',
      },
    }],
    stages: [
      { id: 'bug4_test_author', bugIndex: 4, status: 'running', label: '独立测试编写' },
      { id: 'bug6_verification_finalize', bugIndex: 6, status: 'pending', label: '回填 verify_result 验证证明' },
      { id: 'bug6_delivery_ready', bugIndex: 6, status: 'pending', label: '交付字段就绪' },
    ],
  }, 6, Date.parse('2026-08-23T02:30:00.000Z'));
  assert.equal(visible.status, 'fast_lane_queued');
  assert.equal(visible.currentStage, 'bug6_verification_finalize');
  assert.equal(visible.currentStageLabel, '回填 verify_result 验证证明');
  assert.equal(visible.subphase, '');
  assert.equal(visible.elapsedMs, 0);
});

test('workbench ignores an orphaned running attempt after its stage returned to pending', () => {
  const bug = beginBugAttempt({ bugIndex: 3 }, {
    attempt: 2,
    stage: 'bug3_claude_fix',
    startedAt: '2026-08-20T00:00:00.000Z',
  });
  const visible = publicBugWorkbench({
    status: 'waiting_resource',
    processActive: true,
    bugExecution: {
      selectedBugIndex: 4,
      status: 'fast_lane_queued',
      currentStage: 'bug4_gold_fix',
    },
    bugs: [bug, { bugIndex: 4 }],
    stages: [
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'pending', label: 'Claude 修复' },
      { id: 'bug4_gold_fix', bugIndex: 4, status: 'pending', label: 'Gold 修复' },
    ],
    currentStage: 'bug4_gold_fix',
  }, 3, Date.parse('2026-08-20T00:05:00.000Z'));
  assert.equal(visible.status, 'bug_ready');
  assert.equal(visible.currentAttempt, 0);
});

test('workbench reports the newest attempt when an interrupted older attempt was not closed', () => {
  const older = beginBugAttempt({ bugIndex: 3 }, {
    attempt: 1,
    stage: 'bug3_claude_fix',
    startedAt: '2026-08-20T00:00:00.000Z',
  });
  const newer = beginBugAttempt(older, {
    attempt: 2,
    stage: 'bug3_claude_fix',
    startedAt: '2026-08-20T00:02:00.000Z',
  });
  const summary = summarizeBugAttempts(newer, Date.parse('2026-08-20T00:03:00.000Z'));
  assert.equal(summary.currentAttempt, 2);
  assert.equal(summary.current.startedAt, '2026-08-20T00:02:00.000Z');
});

test('abandoned jobs never present a selected Bug as running', () => {
  const visible = publicBugWorkbench({
    status: 'abandoned',
    processActive: false,
    bugExecution: { selectedBugIndex: 2, status: 'fast_lane_running', currentStage: 'bug2_gold_fix' },
    bugs: [{ bugIndex: 2 }],
    stages: [{ id: 'bug2_gold_fix', bugIndex: 2, status: 'running', label: 'Gold 修复' }],
    currentStage: 'bug2_gold_fix',
  }, 2);
  assert.equal(visible.status, 'fast_lane_stopped');
});

test('skipped Bug does not expose a stale discovery stage label', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    currentStage: 'bug3_bug_discovery',
    bugExecution: { selectedBugIndex: 5, status: 'fast_lane_running', currentStage: 'bug5_claude_fix' },
    bugs: [{ bugIndex: 3, disposition: 'skipped' }, { bugIndex: 5 }],
    stages: [
      { id: 'bug3_bug_discovery', bugIndex: 3, status: 'passed', label: 'Sol 优先寻找自然 Bug' },
      { id: 'bug5_claude_fix', bugIndex: 5, status: 'running', label: 'Claude 修复并生成公开回归测试' },
    ],
  }, 3);
  assert.equal(visible.currentStage, '');
  assert.equal(visible.currentStageLabel, '');
  assert.equal(visible.status, 'fast_lane_stopped');
});

test('workbench exposes two independently active Bug workers in one project', () => {
  const job = {
    status: 'running',
    processActive: true,
    currentStage: 'bug2_claude_fix',
    bugExecution: { selectedBugIndex: 1, status: 'fast_lane_running', currentStage: 'bug1_claude_fix' },
    bugs: [
      { bugIndex: 1, workerExecution: { status: 'fast_lane_running', currentStage: 'bug1_claude_fix', startedAt: '2026-08-21T01:00:00Z' } },
      { bugIndex: 2, workerExecution: { status: 'fast_lane_running', currentStage: 'bug2_claude_fix', startedAt: '2026-08-21T01:00:01Z' } },
    ],
    stages: [
      { id: 'bug1_claude_fix', bugIndex: 1, status: 'running', label: 'Claude 修复 Bug 1' },
      { id: 'bug2_claude_fix', bugIndex: 2, status: 'running', label: 'Claude 修复 Bug 2' },
    ],
  };
  const first = publicBugWorkbench(job, 1, Date.parse('2026-08-21T01:00:11Z'));
  const second = publicBugWorkbench(job, 2, Date.parse('2026-08-21T01:00:11Z'));
  assert.equal(first.status, 'fast_lane_running');
  assert.equal(second.status, 'fast_lane_running');
  assert.equal(first.currentStage, 'bug1_claude_fix');
  assert.equal(second.currentStage, 'bug2_claude_fix');
  assert.equal(second.selected, true);
  assert.equal(second.elapsedMs, 10_000);
});

test('running test author is not hidden by a stale diagnosis checkpoint label', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    bugs: [{
      bugIndex: 5,
      workerExecution: {
        status: 'fast_lane_running',
        currentStage: 'bug5_test_author',
        startedAt: '2026-08-23T09:44:30Z',
        subphase: 'diagnosis_repair_checkpoint_saved',
      },
    }],
    stages: [{
      id: 'bug5_test_author',
      bugIndex: 5,
      status: 'running',
      label: 'Codex 独立编写诊断回归测试',
    }],
  }, 5, Date.parse('2026-08-23T09:45:30Z'));

  assert.equal(visible.currentStage, 'bug5_test_author');
  assert.equal(visible.currentStageLabel, 'Codex 独立编写诊断回归测试');
  assert.equal(visible.elapsedMs, 60_000);
});

test('delivered workbench clears stale retry blockers from the live view', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    bugs: [{
      bugIndex: 5,
      workerExecution: {
        status: 'fast_lane_running',
        currentStage: 'bug5_test_author',
        blockedReason: '阶段自动重试 1/3',
        lastAction: 'automatic_stage_retry',
      },
    }],
    stages: [{ id: 'bug5_delivery_ready', bugIndex: 5, status: 'passed' }],
  }, 5);

  assert.equal(visible.status, 'delivered');
  assert.equal(visible.blockedReason, '');
  assert.equal(visible.lastAction, 'delivered');
});

test('workbench ignores stale running metadata after BUG_BASE preparation passed', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    currentStage: 'bug1_claude_fix',
    bugExecution: { selectedBugIndex: 1, status: 'fast_lane_running', currentStage: 'bug1_claude_fix' },
    bugs: [
      {
        bugIndex: 8,
        workerExecution: {
          status: 'fast_lane_running',
          currentStage: 'bug8_bug_source_prepare',
          startedAt: '2026-08-21T13:44:50.152Z',
        },
      },
      { bugIndex: 1 },
    ],
    stages: [
      { id: 'bug8_bug_source_prepare', bugIndex: 8, status: 'passed', label: '确定独立 BUG_BASE' },
      { id: 'bug8_task_prepare', bugIndex: 8, status: 'pending', label: '创建 Claude 隔离任务' },
      { id: 'bug1_claude_fix', bugIndex: 1, status: 'running', label: 'Claude 修复并生成公开回归测试' },
    ],
  }, 8, Date.parse('2026-08-21T17:05:00Z'));

  assert.equal(visible.status, 'bug_ready');
  assert.equal(visible.selected, false);
  assert.equal(visible.currentStage, '');
  assert.equal(visible.elapsedMs, 0);
});

test('workbench ignores a stopped source-preparation cursor after review is confirmed', () => {
  const visible = publicBugWorkbench({
    status: 'stopped',
    processActive: false,
    currentStage: 'bug5_claude_fix',
    bugs: [{
      bugIndex: 8,
      bugSource: 'injected',
      bugBaseCommit: '9b6cc6e10fb4aaca34e4c47903a26a981593d4f6',
      userQueryReviewStatus: 'confirmed',
      workerExecution: {
        status: 'fast_lane_stopped',
        currentStage: 'bug8_bug_source_prepare',
        lastAction: 'external_signal',
      },
    }],
    stages: [
      { id: 'bug8_bug_source_prepare', bugIndex: 8, status: 'passed', label: '确定独立 BUG_BASE' },
      { id: 'bug8_user_query_review', bugIndex: 8, status: 'passed', label: '人工确认题面' },
      { id: 'bug8_task_prepare', bugIndex: 8, status: 'pending', label: '创建 Claude 隔离任务' },
    ],
  }, 8);

  assert.equal(visible.status, 'fast_lane_stopped');
  assert.equal(visible.currentStage, '');
  assert.equal(visible.currentStageLabel, '');
  assert.equal(visible.selected, false);
});

test('workbench restores an untouched pending Bug after a watchdog retry', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    currentStage: 'bug3_claude_fix',
    bugs: [{
      bugIndex: 6,
      attempts: [],
      workerExecution: {
        status: 'fast_lane_stopped',
        currentStage: '',
        blockedReason: '等待中央调度资源',
        lastAction: 'watchdog_retry',
      },
    }],
    stages: [
      { id: 'bug3_claude_fix', bugIndex: 3, status: 'running' },
      { id: 'bug6_task_prepare', bugIndex: 6, status: 'pending' },
    ],
  }, 6);

  assert.equal(visible.status, 'bug_ready');
  assert.equal(visible.selected, false);
  assert.equal(visible.blockedReason, '');
});

test('workbench restores an untouched pending Bug after a manual project resume', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    bugs: [{
      bugIndex: 15,
      workerExecution: {
        status: 'fast_lane_stopped',
        lastAction: 'user_stopped',
      },
    }],
    stages: [{ id: 'bug15_task_prepare', bugIndex: 15, status: 'pending' }],
  }, 15);

  assert.equal(visible.status, 'bug_ready');
  assert.equal(visible.selected, false);
});

test('workbench ignores a selected pending retry stage after injection failure', () => {
  const visible = publicBugWorkbench({
    status: 'running',
    processActive: true,
    currentStage: 'bug2_bug_source_prepare',
    bugExecution: {
      selectedBugIndex: 2,
      status: 'fast_lane_running',
      currentStage: 'bug2_bug_source_prepare',
    },
    bugs: [{
      bugIndex: 2,
      workerExecution: {
        status: 'fast_lane_failed',
        currentStage: 'bug2_bug_source_prepare',
        updatedAt: '2026-08-21T17:05:05.937Z',
      },
    }],
    stages: [{
      id: 'bug2_bug_source_prepare',
      bugIndex: 2,
      status: 'pending',
      label: '确定独立 BUG_BASE',
    }],
  }, 2);

  assert.equal(visible.status, 'fast_lane_failed');
  assert.equal(visible.selected, false);
  assert.equal(visible.currentStage, '');
  assert.equal(visible.currentStageLabel, '');
  assert.equal(visible.elapsedMs, 0);
});
