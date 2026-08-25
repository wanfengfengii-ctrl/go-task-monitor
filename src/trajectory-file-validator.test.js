import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnosisBashMutationIntents,
  parseTrajectoryJson,
  validateDiagnosisReadOnlyEvents,
  validateTrajectoryEvents,
  validateTrajectoryIntegrityEvents,
} from './trajectory-file-validator.js';

const sessionId = 'd5889c13-4327-499d-bea1-5f3da042aee5';
const workspace = '/work/tasks/sample/workspace';

function toolUse(id, name, input) {
  return { type: 'assistant', session_id: sessionId, message: { model: 'model', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResult(id, isError = false) {
  return { type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: '' }] } };
}

function baseEvents(extra = []) {
  return [
    { type: 'system', subtype: 'init', session_id: sessionId, cwd: workspace, model: 'model' },
    ...extra,
    { type: 'result', subtype: 'success', is_error: false, permission_denials: [], session_id: sessionId },
  ];
}

function normalizedEvents(extra = [], prompt = '请处理这个问题。') {
  return [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: prompt } },
    ...extra,
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: '处理结束。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: prompt },
  ];
}

test('integrity-only validation accepts process-quality problems when the capture is complete', () => {
  const events = normalizedEvents([
    toolUse('edit-1', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('edit-1'),
    toolUse('edit-2', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('edit-2'),
    toolUse('edit-3', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('edit-3'),
    toolUse('failed', 'Bash', { command: 'go test ./... | tee /tmp/test.log' }), toolResult('failed', true),
  ]);
  const result = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
  assert.equal(result.warnings.length, 0);
});

test('integrity-only validation rejects an incomplete final answer or last-prompt', () => {
  const missingFinal = normalizedEvents().filter((event) => event.type !== 'assistant');
  const finalResult = validateTrajectoryIntegrityEvents(missingFinal, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(finalResult.errors.some((item) => item.code === 'final-assistant'), true);

  const missingPrompt = normalizedEvents().filter((event) => event.type !== 'last-prompt');
  const promptResult = validateTrajectoryIntegrityEvents(missingPrompt, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(promptResult.errors.some((item) => item.code === 'last-prompt-count'), true);
});

test('integrity-only validation accepts multiple original last-prompt records', () => {
  const events = normalizedEvents();
  events.push({ type: 'last-prompt', sessionId, lastPrompt: '中间记录' });
  events.push({ type: 'last-prompt', sessionId, lastPrompt: '另一个原始记录' });
  const result = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
});

test('integrity-only validation rejects unpaired tools and filename/session mismatches', () => {
  const events = normalizedEvents([toolUse('unpaired', 'Read', { file_path: `${workspace}/main.go` })]);
  const result = validateTrajectoryIntegrityEvents(events, { filename: 'trajectory_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl' });
  assert.equal(result.errors.some((item) => item.code === 'tool-balance'), true);
  assert.equal(result.errors.some((item) => item.code === 'session-filename'), true);
});

test('integrity-only validation accepts one external root boundary but still rejects duplicate UUIDs', () => {
  const rootUuid = '11111111-1111-4111-8111-111111111111';
  const childUuid = '22222222-2222-4222-8222-222222222222';
  const events = normalizedEvents();
  events[0] = { ...events[0], uuid: rootUuid };
  events[1] = { ...events[1], uuid: childUuid, parentUuid: '33333333-3333-4333-8333-333333333333' };
  events[2] = { ...events[2], uuid: childUuid, parentUuid: rootUuid };
  const result = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(result.errors.some((item) => item.code === 'parent-chain'), false);
  assert.equal(result.errors.some((item) => item.code === 'event-uuid-duplicate'), true);
  assert.equal(result.warnings.some((item) => item.code === 'external-root-parent'), true);
  assert.equal(result.stats.externalRootParentLinks, 1);
});

test('integrity-only validation still rejects an unknown parent after the internal chain begins', () => {
  const rootUuid = '11111111-1111-4111-8111-111111111111';
  const childUuid = '22222222-2222-4222-8222-222222222222';
  const events = normalizedEvents();
  events[0] = { ...events[0], uuid: rootUuid };
  events[1] = { ...events[1], uuid: childUuid, parentUuid: rootUuid };
  events[2] = { ...events[2], uuid: '33333333-3333-4333-8333-333333333333', parentUuid: '44444444-4444-4444-8444-444444444444' };
  const result = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(result.errors.some((item) => item.code === 'parent-chain'), true);
  assert.equal(result.stats.brokenParentLinks, 1);
});

test('integrity-only validation accepts a complete original event UUID chain', () => {
  const rootUuid = '11111111-1111-4111-8111-111111111111';
  const childUuid = '22222222-2222-4222-8222-222222222222';
  const finalUuid = '33333333-3333-4333-8333-333333333333';
  const events = normalizedEvents();
  events[0] = { ...events[0], uuid: rootUuid };
  events[1] = { ...events[1], uuid: childUuid, parentUuid: rootUuid };
  events[2] = { ...events[2], uuid: finalUuid, parentUuid: childUuid };
  const result = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
  assert.equal(result.stats.brokenParentLinks, 0);
  assert.equal(result.stats.parentLinks, 2);
});

test('integrity-only stream validation requires one successful result and a final assistant answer', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: sessionId, cwd: workspace },
    { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: '完成。' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: sessionId },
  ];
  const valid = validateTrajectoryIntegrityEvents(events, { filename: `trajectory_${sessionId}.json` });
  assert.equal(valid.ok, true, valid.errors.map((item) => item.message).join('; '));
  const failed = validateTrajectoryIntegrityEvents([...events.slice(0, -1), { type: 'result', subtype: 'error', is_error: true, session_id: sessionId }], { filename: `trajectory_${sessionId}.json` });
  assert.equal(failed.errors.some((item) => item.code === 'result-status'), true);
});

test('trajectory parser rejects a truncated JSONL event instead of silently accepting it', () => {
  assert.throws(() => parseTrajectoryJson(`{"type":"user","sessionId":"${sessionId}"}\n{"type":`), /JSON/);
});

test('diagnosis mutation intent detection covers historical Bash write paths', () => {
  const commands = [
    `cp /tmp/verify_cure_bug.go ${workspace}/service/zz_verify_cure_bug_test.go`,
    `cat > ${workspace}/internal/aggregate/lease.go <<'EOF'\npackage aggregate\nEOF`,
    `tee ${workspace}/internal/aggregate/margins_math.go < /dev/null`,
    `touch ${workspace}/probe.txt`,
    `mkdir ${workspace}/probe-dir`,
    `chmod u+w ${workspace}/internal/aggregate/finalize.go`,
    'go env -w GOFLAGS=',
  ];
  for (const command of commands) {
    assert.notEqual(diagnosisBashMutationIntents(command, workspace).length, 0, command);
  }
});

test('diagnosis mutation intent detection ignores quoted and heredoc comparison operators', () => {
  const commands = [
    `rg -n 'a > math.MaxInt64-b|budget > 0' internal/aggregate/margins_math.go`,
    `python3 - <<'PY'\nif a > math.MaxInt64-b:\n    print('over budget')\nPY`,
  ];
  for (const command of commands) {
    assert.equal(diagnosisBashMutationIntents(command, workspace).length, 0, command);
  }
  assert.notEqual(diagnosisBashMutationIntents(`printf done > ${workspace}/result.txt`, workspace).length, 0);
});

test('diagnosis read-only validation rejects denied or cleaned-up write attempts', () => {
  const events = normalizedEvents([
    toolUse('write-attempt', 'Bash', { command: `printf probe > ${workspace}/probe.txt` }),
    toolResult('write-attempt', true),
  ]);
  const files = { 'workspace/main.go': 'same' };
  const result = validateDiagnosisReadOnlyEvents(events, {
    workspaceRoot: workspace,
    requireAudit: true,
    auditRecords: [
      { event: 'V4Baseline', files },
      {
        event: 'PreToolUse',
        tool_use_id: 'write-attempt',
        tool_name: 'Bash',
        permission_decision: 'deny',
        files,
      },
      { event: 'V4Final', files },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((item) => item.code === 'diagnosis-write-command'), true);
  assert.equal(result.errors.some((item) => item.code === 'diagnosis-persistent-write'), false);
});

test('diagnosis read-only validation accepts read-only commands and stderr redirection', () => {
  const events = normalizedEvents([
    toolUse('read-only', 'Bash', { command: 'go test ./internal/aggregate -run TestLease -count=1 2>&1' }),
    toolResult('read-only'),
  ]);
  const files = { 'workspace/main.go': 'same' };
  const result = validateDiagnosisReadOnlyEvents(events, {
    workspaceRoot: workspace,
    requireAudit: true,
    auditRecords: [
      { event: 'V4Baseline', files },
      { event: 'PreToolUse', tool_use_id: 'read-only', tool_name: 'Bash', files },
      { event: 'PostToolUse', tool_use_id: 'read-only', tool_name: 'Bash', files },
      { event: 'V4Final', files },
    ],
  });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
});

test('diagnosis read-only validation accepts a CLI-denied read-only command without a post snapshot', () => {
  const events = normalizedEvents([
    toolUse('cli-denied', 'Bash', { command: 'git log --oneline -5 2>/dev/null' }),
    { type: 'system', subtype: 'permission_denied', tool_use_id: 'cli-denied', tool_name: 'Bash' },
    toolResult('cli-denied', true),
  ]);
  const files = { 'workspace/main.go': 'same' };
  const result = validateDiagnosisReadOnlyEvents(events, {
    workspaceRoot: workspace,
    requireAudit: true,
    auditRecords: [
      { event: 'V4Baseline', files },
      { event: 'PreToolUse', tool_use_id: 'cli-denied', tool_name: 'Bash', files },
      { event: 'V4Final', files },
    ],
  });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
});

test('diagnosis read-only validation accepts a multiline denied command without a post snapshot', () => {
  const command = `python3 -c "\nprint(1 > 0)\n"`;
  const events = normalizedEvents([
    toolUse('multiline-denied', 'Bash', { command }),
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'multiline-denied',
          is_error: true,
          content: `Permission to use Bash with command ${command} has been denied.`,
        }],
      },
    },
  ]);
  const files = { 'workspace/main.go': 'same' };
  const result = validateDiagnosisReadOnlyEvents(events, {
    workspaceRoot: workspace,
    requireAudit: true,
    auditRecords: [
      { event: 'V4Baseline', files },
      { event: 'PreToolUse', tool_use_id: 'multiline-denied', tool_name: 'Bash', files },
      { event: 'V4Final', files },
    ],
  });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
});

test('accepts a closed diagnosis trajectory with temp-only writes and clean proof', () => {
  const events = baseEvents([
    toolUse('one', 'Write', { file_path: '/tmp/repro/main.go', content: 'package main' }),
    toolResult('one'),
    toolUse('target', 'Bash', { command: 'go test -count=1 -run TestRepro /tmp/repro' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
    toolUse('two', 'Bash', { command: 'cd /work/tasks/sample && diff -qr --exclude=.git pristine workspace' }),
    toolResult('two'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'diagnosis' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.workspaceMutations, 0);
});

test('routes the third write to semantic review instead of rejecting by count', () => {
  const events = baseEvents([
    toolUse('one', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('one'),
    toolUse('two', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('two'),
    toolUse('three', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('three'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(result.errors.some((item) => item.code === 'repeated-mutation'), false);
  assert.equal(result.warnings.some((item) => item.code === 'repeated-mutation'), true);
});

test('rejects gold and hidden grader reads', () => {
  const events = baseEvents([
    toolUse('one', 'Read', { file_path: '/work/tasks/sample/gold/gold.patch' }), toolResult('one'),
    toolUse('two', 'Read', { file_path: '/work/tasks/sample/grader/hidden_test.go' }), toolResult('two'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'diagnosis' });
  assert.equal(result.errors.filter((item) => item.code === 'protected-access').length, 2);
});

test('rejects diagnosis workspace mutations and filename mismatch', () => {
  const events = baseEvents([toolUse('one', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('one')]);
  const result = validateTrajectoryEvents(events, {
    filename: 'trajectory_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json',
    taskType: 'diagnosis',
  });
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes('session-filename'));
  assert.ok(codes.includes('diagnosis-mutation'));
});

test('accepts a closed Claude native JSONL diagnosis transcript', () => {
  const events = [
    { type: 'queue-operation', operation: 'enqueue', sessionId },
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: 'diagnose' } },
    toolUse('target', 'Bash', { command: 'go test -count=1 -run TestRepro /tmp/repro' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
    toolUse('clean', 'Bash', { command: 'cd /work/tasks/sample && diff -qr --exclude=.git pristine workspace' }), toolResult('clean'),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: 'Diagnosis complete.' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: 'diagnose' },
  ];
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.jsonl`, taskType: 'diagnosis' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.format, 'claude-native-jsonl');
});

test('accepts one mutation per bugfix file with direct target, full, and static validation', () => {
  const events = baseEvents([
    toolUse('write-source', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write-source'),
    toolUse('write-test', 'Write', { file_path: `${workspace}/main_test.go`, content: 'package main' }), toolResult('write-test'),
    toolUse('target', 'Bash', { command: 'go test -count=1 -run TestRegression ./...' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.workspaceMutations, 2);
});

test('accepts diagnosis with focused reproduction and clean proof without mandatory full/static commands', () => {
  const events = baseEvents([
    toolUse('read', 'Read', { file_path: `${workspace}/main.go` }), toolResult('read'),
    toolUse('repro', 'Bash', { command: 'cd /tmp/diag-repro && ./repro.sh' }), toolResult('repro'),
    toolUse('clean', 'Bash', { command: 'cd /work/tasks/sample && diff -qr --exclude=.git pristine workspace' }), toolResult('clean'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'diagnosis' });
  assert.equal(result.ok, true);
});

test('marks masked exploratory validation commands as warnings', () => {
  const events = baseEvents([
    toolUse('write', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write'),
    toolUse('target', 'Bash', { command: 'go test -count=1 -run TestRegression ./... 2>&1 | tee /tmp/target.log' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...; echo $?' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.filter((item) => item.code === 'masked-exploratory-exit').length, 2);
});

test('treats a completed API retry as a warning rather than a trajectory failure', () => {
  const events = baseEvents([
    { type: 'system', subtype: 'api_retry', session_id: sessionId },
    toolUse('write', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write'),
    toolUse('target', 'Bash', { command: 'go test -count=1 -run TestRegression ./...' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
  ]);
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((item) => item.code === 'api-retry'), true);
});

test('keeps historical V2 diagnosis trajectories on their original policy', () => {
  const events = baseEvents([
    toolUse('full', 'Bash', { command: 'go test ./... 2>&1 | tail -20; echo $?' }), toolResult('full'),
    toolUse('clean', 'Bash', { command: 'cd /work/tasks/sample && diff -qr --exclude=.git pristine workspace' }), toolResult('clean'),
  ]);
  const result = validateTrajectoryEvents(events, {
    filename: `trajectory_${sessionId}.json`,
    taskType: 'diagnosis',
    executionPolicyVersion: 2,
    maxWrites: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.errors.some((item) => item.code === 'masked-validation-exit'), false);
});

test('parses compact JSONL into an event array', () => {
  const events = parseTrajectoryJson('{"type":"user"}\n{"type":"assistant"}\n');
  assert.deepEqual(events.map((event) => event.type), ['user', 'assistant']);
});

test('V4 bugfix enforces a real ordered red-to-green workflow using tool outcomes', () => {
  const events = [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: '请修复 queue.go 中 Queue.Pop 的空队列错误。' } },
    toolUse('read', 'Read', { file_path: `${workspace}/queue.go` }), toolResult('read'),
    toolUse('test-write', 'Write', { file_path: `${workspace}/queue_test.go`, content: 'package queue' }), toolResult('test-write'),
    toolUse('red', 'Bash', { command: "go test -count=1 -run '^TestEmptyQueue$' ./..." }), toolResult('red', true),
    toolUse('fix', 'Edit', { file_path: `${workspace}/queue.go` }), toolResult('fix'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('green', 'Bash', { command: "go test -count=1 -run '^TestEmptyQueue$' ./..." }), toolResult('green'),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: 'queue.go 的 Queue.Pop 已完成修复。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '请修复 queue.go 中 Queue.Pop 的空队列错误。' },
  ];
  const auditRecords = [
    { event: 'V4Baseline', files: { 'workspace/queue.go': 'source-old' } },
    { event: 'PreToolUse', tool_use_id: 'test-write', tool_name: 'Write', files: { 'workspace/queue.go': 'source-old' } },
    { event: 'PostToolUse', tool_use_id: 'test-write', tool_name: 'Write', files: { 'workspace/queue.go': 'source-old', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PreToolUse', tool_use_id: 'red', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-old', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PostToolUseFailure', tool_use_id: 'red', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-old', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PreToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/queue.go': 'source-old', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PostToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PreToolUse', tool_use_id: 'green', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PostToolUse', tool_use_id: 'green', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PreToolUse', tool_use_id: 'full', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PostToolUse', tool_use_id: 'full', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PreToolUse', tool_use_id: 'static', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'PostToolUse', tool_use_id: 'static', tool_name: 'Bash', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
    { event: 'V4Final', files: { 'workspace/queue.go': 'source-new', 'workspace/queue_test.go': 'test-new' } },
  ];
  const result = validateTrajectoryEvents(events, {
    filename: `trajectory_${sessionId}.jsonl`,
    taskType: 'bugfix',
    executionPolicyVersion: 4,
    auditRecords,
    goldFiles: ['queue.go'],
  });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
  assert.deepEqual(result.stats.verification, {
    readBeforeFix: true,
    firstSourceMutation: 4,
    lastFixMutation: 4,
    redOrdinal: 3,
    greenOrdinal: 7,
    fullOrdinal: 6,
    staticOrdinal: 5,
    focusedCommand: "go test -count=1 -run '^TestEmptyQueue$' ./...",
  });
});

test('V4 bugfix rejects command presence without a failing pre-fix result', () => {
  const events = [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: '请修复 queue.go 中 Queue.Pop 的空队列错误。' } },
    toolUse('read', 'Read', { file_path: `${workspace}/queue.go` }), toolResult('read'),
    toolUse('fix', 'Edit', { file_path: `${workspace}/queue.go` }), toolResult('fix'),
    toolUse('green', 'Bash', { command: "go test -count=1 -run '^TestEmptyQueue$' ./..." }), toolResult('green'),
    toolUse('full', 'Bash', { command: 'go test -count=1 ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: '完成' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '请修复 queue.go 中 Queue.Pop 的空队列错误。' },
  ];
  const result = validateTrajectoryEvents(events, {
    filename: `trajectory_${sessionId}.jsonl`, taskType: 'bugfix', executionPolicyVersion: 4, goldFiles: ['queue.go'],
    auditRecords: [
      { event: 'V4Baseline', files: { 'workspace/queue.go': 'old' } },
      { event: 'PreToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/queue.go': 'old' } },
      { event: 'PostToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/queue.go': 'new' } },
      { event: 'V4Final', files: { 'workspace/queue.go': 'new' } },
    ],
  });
  assert.equal(result.errors.some((item) => item.code === 'red-before-fix'), true);
});

test('V4 diagnosis uses external mutation audit without requiring a fixed diff command', () => {
  const prompt = '请只诊断 queue.go 中 Queue.Pop 的空队列错误，不要修改代码。';
  const events = [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: prompt } },
    toolUse('read', 'Read', { file_path: `${workspace}/queue.go` }), toolResult('read'),
    toolUse('repro', 'Bash', { command: "go test -count=1 -run '^TestEmptyQueue$' ./..." }), toolResult('repro', true),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: 'queue.go 的 Queue.Pop 缺少长度检查，空队列索引导致 panic；工作区未修改。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: prompt },
  ];
  const baseOptions = {
    filename: `trajectory_${sessionId}.jsonl`, taskType: 'diagnosis', executionPolicyVersion: 4,
    goldFiles: ['queue.go'], goldSymbols: ['Queue.Pop'], mechanismKeywords: ['长度检查', '空队列', '索引', 'panic'],
  };
  const cleanAudit = [
    { event: 'V4Baseline', files: { 'workspace/queue.go': 'same' } },
    { event: 'PreToolUse', tool_use_id: 'repro', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
    { event: 'PostToolUseFailure', tool_use_id: 'repro', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
  ];
  const clean = validateTrajectoryEvents(events, {
    ...baseOptions,
    auditRecords: [...cleanAudit, { event: 'V4Final', files: { 'workspace/queue.go': 'same' } }],
  });
  assert.equal(clean.ok, true, clean.errors.map((item) => item.message).join('; '));
  const synonymousEvents = events.map((event) => event?.type === 'assistant' && event?.message?.content?.some((block) => block.type === 'text')
    ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'queue.go 的 Queue.Pop 在元素数为零时仍访问首元素，因而发生运行时越界；工作区未修改。' }] } }
    : event);
  const synonymous = validateTrajectoryEvents(synonymousEvents, {
    ...baseOptions,
    auditRecords: [...cleanAudit, { event: 'V4Final', files: { 'workspace/queue.go': 'same' } }],
  });
  assert.equal(synonymous.ok, true);
  assert.equal(synonymous.warnings.some((item) => item.code === 'diagnosis-mechanism-semantic-review'), true);
  const dirty = validateTrajectoryEvents(events, {
    ...baseOptions,
    auditRecords: [...cleanAudit, { event: 'V4Final', files: { 'workspace/queue.go': 'same', 'temp-source/repro.go': 'new' } }],
  });
  assert.equal(dirty.errors.some((item) => item.code === 'diagnosis-global-code-write'), true);
});

test('masked exploratory commands warn while pipefail commands remain usable evidence', () => {
  const unsafe = command => validateTrajectoryEvents(baseEvents([
    toolUse('write', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write'),
    toolUse('target', 'Bash', { command }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test ./...' }), toolResult('full'),
    toolUse('static', 'Bash', { command: 'go vet ./...' }), toolResult('static'),
  ]), { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(unsafe('go test -run TestOne ./... | tee /tmp/out').warnings.some((item) => item.code === 'masked-exploratory-exit'), true);
  assert.equal(unsafe('set -o pipefail; go test -run TestOne ./... | tee /tmp/out').warnings.some((item) => item.code === 'masked-exploratory-exit'), false);
});

test('a recovered permission denial is a warning when the session succeeds', () => {
  const events = baseEvents([
    toolUse('write', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write'),
    toolUse('target', 'Bash', { command: 'go test -run TestOne ./...' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test ./...' }), toolResult('full'),
  ]);
  events.at(-1).permission_denials = ['Bash denied once'];
  const result = validateTrajectoryEvents(events, { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix' });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((item) => item.code === 'permission-denial-recovered'), true);
});

test('single and repeated restores are routed to contextual review instead of failing by count', () => {
  const validate = (restoreCount) => validateTrajectoryEvents(baseEvents([
    toolUse('write', 'Edit', { file_path: `${workspace}/main.go` }), toolResult('write'),
    ...Array.from({ length: restoreCount }, (_, index) => [
      toolUse(`restore-${index}`, 'Bash', { command: 'git restore main.go' }),
      toolResult(`restore-${index}`),
    ]).flat(),
    toolUse('target', 'Bash', { command: 'go test -run TestOne ./...' }), toolResult('target'),
    toolUse('full', 'Bash', { command: 'go test ./...' }), toolResult('full'),
  ]), { filename: `trajectory_${sessionId}.json`, taskType: 'bugfix', maxWrites: 4 });
  const single = validate(1);
  assert.equal(single.ok, true);
  assert.equal(single.warnings.some((item) => item.code === 'single-rollback'), true);
  const repeated = validate(2);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.errors.some((item) => item.code === 'repeated-rollback'), false);
  assert.equal(repeated.warnings.some((item) => item.code === 'repeated-rollback-semantic-review'), true);
});

test('V4 accepts a non-Go configuration fix with reliable red, green, and full evidence', () => {
  const prompt = '请修复 go.mod 的依赖版本错误并运行测试。';
  const events = [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: prompt } },
    toolUse('read', 'Read', { file_path: `${workspace}/go.mod` }), toolResult('read'),
    toolUse('red', 'Bash', { command: "go test -run '^TestDependencyBehavior$' ./..." }), toolResult('red', true),
    toolUse('fix', 'Edit', { file_path: `${workspace}/go.mod` }), toolResult('fix'),
    toolUse('green', 'Bash', { command: "go test -run '^TestDependencyBehavior$' ./..." }), toolResult('green'),
    toolUse('full', 'Bash', { command: 'go test ./...' }), toolResult('full'),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: 'go.mod 的依赖约束已修复。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: prompt },
  ];
  const auditRecords = [
    { event: 'V4Baseline', files: { 'workspace/go.mod': 'old' } },
    { event: 'PreToolUse', tool_use_id: 'red', tool_name: 'Bash', files: { 'workspace/go.mod': 'old' } },
    { event: 'PostToolUseFailure', tool_use_id: 'red', tool_name: 'Bash', files: { 'workspace/go.mod': 'old' } },
    { event: 'PreToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/go.mod': 'old' } },
    { event: 'PostToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: { 'workspace/go.mod': 'new' } },
    { event: 'PreToolUse', tool_use_id: 'green', tool_name: 'Bash', files: { 'workspace/go.mod': 'new' } },
    { event: 'PostToolUse', tool_use_id: 'green', tool_name: 'Bash', files: { 'workspace/go.mod': 'new' } },
    { event: 'PreToolUse', tool_use_id: 'full', tool_name: 'Bash', files: { 'workspace/go.mod': 'new' } },
    { event: 'PostToolUse', tool_use_id: 'full', tool_name: 'Bash', files: { 'workspace/go.mod': 'new' } },
    { event: 'V4Final', files: { 'workspace/go.mod': 'new' } },
  ];
  const result = validateTrajectoryEvents(events, {
    filename: `trajectory_${sessionId}.jsonl`, taskType: 'bugfix', executionPolicyVersion: 4,
    auditRecords, goldFiles: ['go.mod'],
  });
  assert.equal(result.ok, true, result.errors.map((item) => item.message).join('; '));
});
