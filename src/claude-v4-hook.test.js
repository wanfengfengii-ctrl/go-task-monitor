import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const hook = path.resolve(import.meta.dirname, '../scripts/claude-v4-hook.mjs');
const sessionId = '4a158f08-9b97-4e0a-a6d5-f1bd2c70609e';

function toolUse(id, name, input) {
  return { type: 'assistant', sessionId, message: { model: 'model', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResult(id, isError = false) {
  return { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: '' }] } };
}

async function fixture({ includeFull }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-stop-hook-'));
  const workspace = path.join(root, 'workspace');
  const transcript = path.join(root, 'session.jsonl');
  const audit = path.join(root, 'audit.jsonl');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'queue.go'), 'package queue\n\nfunc Pop() {}\n');
  await writeFile(path.join(workspace, 'queue_test.go'), 'package queue\n');
  const events = [
    { type: 'user', sessionId, cwd: workspace, message: { role: 'user', content: '请修复队列问题。' } },
    toolUse('read', 'Read', { file_path: path.join(workspace, 'queue.go') }), toolResult('read'),
    toolUse('test', 'Write', { file_path: path.join(workspace, 'queue_test.go'), content: 'package queue' }), toolResult('test'),
    toolUse('red', 'Bash', { command: "go test ./... -run '^TestModel_Queue$' -count=1" }), toolResult('red', true),
    toolUse('fix', 'Edit', { file_path: path.join(workspace, 'queue.go') }), toolResult('fix'),
    toolUse('green', 'Bash', { command: "go test ./... -run '^TestModel_Queue$' -count=1" }), toolResult('green'),
    ...(includeFull ? [toolUse('full', 'Bash', { command: 'go test ./... -count=1' }), toolResult('full')] : []),
    { type: 'assistant', sessionId, cwd: workspace, message: { model: 'model', content: [{ type: 'text', text: '修复完成。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '请修复队列问题。' },
  ];
  await writeFile(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const files = { 'workspace/queue.go': 'old-source' };
  const withTest = { ...files, 'workspace/queue_test.go': 'new-test' };
  const fixed = { ...withTest, 'workspace/queue.go': 'new-source' };
  const auditRecords = [
    { event: 'V4Baseline', files },
    { event: 'PreToolUse', tool_use_id: 'test', tool_name: 'Write', files },
    { event: 'PostToolUse', tool_use_id: 'test', tool_name: 'Write', files: withTest },
    { event: 'PreToolUse', tool_use_id: 'red', tool_name: 'Bash', files: withTest },
    { event: 'PostToolUseFailure', tool_use_id: 'red', tool_name: 'Bash', files: withTest },
    { event: 'PreToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: withTest },
    { event: 'PostToolUse', tool_use_id: 'fix', tool_name: 'Edit', files: fixed },
    { event: 'PreToolUse', tool_use_id: 'green', tool_name: 'Bash', files: fixed },
    { event: 'PostToolUse', tool_use_id: 'green', tool_name: 'Bash', files: fixed },
    ...(includeFull ? [
      { event: 'PreToolUse', tool_use_id: 'full', tool_name: 'Bash', files: fixed },
      { event: 'PostToolUse', tool_use_id: 'full', tool_name: 'Bash', files: fixed },
    ] : []),
  ];
  await writeFile(audit, `${auditRecords.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { root, workspace, transcript, audit };
}

function runStopHook(paths, stopHookActive = false) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: paths.transcript,
      stop_hook_active: stopHookActive,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      V4_TASK_TYPE: 'bugfix',
      V4_WORKSPACE_ROOT: paths.workspace,
      V4_TEMP_ROOT: paths.root,
      V4_AUDIT_LOG: paths.audit,
    },
  });
}

test('bugfix Stop hook blocks completion until a direct full-suite test succeeds', async () => {
  const paths = await fixture({ includeFull: false });
  try {
    const result = runStopHook(paths);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /go test \.\/\.\.\. -count=1/);
    assert.match(output.reason, /不得使用管道/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix Stop hook allows completion after direct green and full-suite evidence', async () => {
  const paths = await fixture({ includeFull: true });
  try {
    const result = runStopHook(paths);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix Stop hook does not block repeatedly after an earlier Stop intervention', async () => {
  const paths = await fixture({ includeFull: false });
  try {
    const result = runStopHook(paths, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix hook denies decisive validation commands that mask the Go exit status', async () => {
  const paths = await fixture({ includeFull: false });
  try {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_use_id: 'masked-full',
        tool_name: 'Bash',
        tool_input: { command: 'go test ./... -count=1 2>&1 | tail -20' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        V4_TASK_TYPE: 'bugfix',
        V4_WORKSPACE_ROOT: paths.workspace,
        V4_TEMP_ROOT: paths.root,
        V4_AUDIT_LOG: paths.audit,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /掩盖真实退出码/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('hook forbids diagnosis test-source inspection and keeps bugfix source-first ordering', async () => {
  const paths = await fixture({ includeFull: false });
  const sourceFirstState = path.join(paths.root, 'source-first-state.json');
  const runTool = (event, id, filePath, taskType = 'diagnosis', statePath = sourceFirstState) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: event,
      tool_use_id: id,
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      V4_TASK_TYPE: taskType,
      V4_WORKSPACE_ROOT: paths.workspace,
      V4_TEMP_ROOT: paths.root,
      V4_AUDIT_LOG: paths.audit,
      V4_SOURCE_FIRST_STATE: statePath,
    },
  });
  try {
    const denied = runTool('PreToolUse', 'test-first', path.join(paths.workspace, 'queue_test.go'));
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

    assert.equal(runTool('PreToolUse', 'source', path.join(paths.workspace, 'queue.go')).stdout, '');
    assert.equal(runTool('PostToolUse', 'source', path.join(paths.workspace, 'queue.go')).stdout, '');
    assert.equal(JSON.parse(await readFile(sourceFirstState, 'utf8')).implementationReadObserved, true);
    const diagnosisAfterSource = runTool('PreToolUse', 'test-after-source', path.join(paths.workspace, 'queue_test.go'));
    assert.equal(JSON.parse(diagnosisAfterSource.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const bugfixState = path.join(paths.root, 'bugfix-source-first-state.json');
    const bugfixDenied = runTool('PreToolUse', 'bugfix-test-first', path.join(paths.workspace, 'queue_test.go'), 'bugfix', bugfixState);
    assert.equal(JSON.parse(bugfixDenied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(runTool('PreToolUse', 'bugfix-source', path.join(paths.workspace, 'queue.go'), 'bugfix', bugfixState).stdout, '');
    assert.equal(runTool('PostToolUse', 'bugfix-source', path.join(paths.workspace, 'queue.go'), 'bugfix', bugfixState).stdout, '');
    assert.equal(runTool('PreToolUse', 'bugfix-test-after-source', path.join(paths.workspace, 'queue_test.go'), 'bugfix', bugfixState).stdout, '');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix hook blocks test mutations immediately while allowing production edits', async () => {
  const paths = await fixture({ includeFull: false });
  const runTool = (toolUseId, toolName, toolInput) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      V4_TASK_TYPE: 'bugfix',
      V4_WORKSPACE_ROOT: paths.workspace,
      V4_TEMP_ROOT: paths.root,
      V4_AUDIT_LOG: paths.audit,
    },
  });
  try {
    const editTest = runTool('edit-test', 'Edit', { file_path: path.join(paths.workspace, 'queue_test.go') });
    assert.equal(editTest.status, 0, editTest.stderr);
    assert.equal(JSON.parse(editTest.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const writeFixture = runTool('write-fixture', 'Write', { file_path: path.join(paths.workspace, 'testdata/case.json') });
    assert.equal(writeFixture.status, 0, writeFixture.stderr);
    assert.equal(JSON.parse(writeFixture.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const bashTest = runTool('bash-test', 'Bash', { command: `printf changed > ${paths.workspace}/queue_test.go` });
    assert.equal(bashTest.status, 0, bashTest.stderr);
    assert.equal(JSON.parse(bashTest.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const tempHelper = runTool('temp-helper', 'Bash', { command: 'cat > /tmp/verify_queue.go <<EOF\npackage main\nEOF' });
    assert.equal(tempHelper.status, 0, tempHelper.stderr);
    assert.equal(JSON.parse(tempHelper.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const workspaceHelper = runTool('workspace-helper', 'Bash', { command: `mkdir -p ${paths.workspace}/cmd/verifyqueue` });
    assert.equal(workspaceHelper.status, 0, workspaceHelper.stderr);
    assert.equal(JSON.parse(workspaceHelper.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const editSource = runTool('edit-source', 'Edit', { file_path: path.join(paths.workspace, 'queue.go') });
    assert.equal(editSource.status, 0, editSource.stderr);
    assert.equal(editSource.stdout, '');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix hook gives two bounded exploration reminders before allowing final context reads', async () => {
  const paths = await fixture({ includeFull: false });
  const explorationState = path.join(paths.root, 'exploration-state.json');
  const sourceProgressState = path.join(paths.root, 'source-progress.json');
  const editRequiredState = path.join(paths.root, 'edit-required.json');
  const runTool = (toolUseId, toolName, toolInput, event = 'PreToolUse') => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: event,
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      V4_TASK_TYPE: 'bugfix',
      V4_WORKSPACE_ROOT: paths.workspace,
      V4_TEMP_ROOT: paths.root,
      V4_AUDIT_LOG: paths.audit,
      V4_EXPLORATION_STATE: explorationState,
      V4_SOURCE_PROGRESS_STATE: sourceProgressState,
      V4_EDIT_REQUIRED_STATE: editRequiredState,
      V4_EXPLORATION_LIMIT: '2',
    },
  });
  try {
    assert.equal(runTool('read-1', 'Read', { file_path: path.join(paths.workspace, 'queue.go') }).stdout, '');
    assert.equal(runTool('read-2', 'Grep', { pattern: 'Pop' }).stdout, '');
    assert.equal(JSON.parse(await readFile(editRequiredState, 'utf8')).explorationCount, 2);
    const denied = runTool('read-3', 'Glob', { pattern: '**/*.go' });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /下一步直接使用 Edit\/Write/);
    assert.equal(JSON.parse(await readFile(editRequiredState, 'utf8')).explorationCount, 3);

    const bashAfterFirstReminder = runTool('bash-after-first-reminder', 'Bash', { command: 'rg Pop internal' });
    assert.equal(bashAfterFirstReminder.status, 0, bashAfterFirstReminder.stderr);
    assert.equal(JSON.parse(bashAfterFirstReminder.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(JSON.parse(bashAfterFirstReminder.stdout).hookSpecificOutput.permissionDecisionReason, /剩余的 2 次定向/);

    const readAfterReminder = runTool('read-after-reminder', 'Read', { file_path: path.join(paths.workspace, 'queue.go') });
    assert.equal(readAfterReminder.status, 0, readAfterReminder.stderr);
    assert.equal(readAfterReminder.stdout, '');
    assert.equal(JSON.parse(await readFile(editRequiredState, 'utf8')).explorationCount, 4);
    const finalDenied = runTool('final-reminder', 'Grep', { pattern: 'Push' });
    assert.equal(finalDenied.status, 0, finalDenied.stderr);
    assert.equal(JSON.parse(finalDenied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(JSON.parse(finalDenied.stdout).hookSpecificOutput.permissionDecisionReason, /最后提醒/);
    assert.equal(JSON.parse(await readFile(editRequiredState, 'utf8')).explorationCount, 5);

    const readAfterFinalReminder = runTool('read-after-final-reminder', 'Read', { file_path: path.join(paths.workspace, 'queue.go') });
    assert.equal(readAfterFinalReminder.status, 0, readAfterFinalReminder.stderr);
    assert.equal(JSON.parse(readAfterFinalReminder.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const bashAfterFinalReminder = runTool('bash-after-final-reminder', 'Bash', { command: 'rg Pop internal' });
    assert.equal(bashAfterFinalReminder.status, 0, bashAfterFinalReminder.stderr);
    assert.equal(JSON.parse(bashAfterFinalReminder.stdout).hookSpecificOutput.permissionDecision, 'deny');

    const edited = runTool('edit-source', 'Edit', { file_path: path.join(paths.workspace, 'queue.go') }, 'PostToolUse');
    assert.equal(edited.status, 0, edited.stderr);
    await assert.rejects(readFile(editRequiredState, 'utf8'), /ENOENT/);
    assert.equal(runTool('read-after-edit', 'Read', { file_path: path.join(paths.workspace, 'queue.go') }).stdout, '');
    assert.equal(runTool('bash-after-edit', 'Bash', { command: 'go test ./internal/queue' }).stdout, '');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bugfix exploration counter serializes parallel tool hooks', async () => {
  const paths = await fixture({ includeFull: false });
  const explorationState = path.join(paths.root, 'exploration-state.json');
  const sourceProgressState = path.join(paths.root, 'source-progress.json');
  const env = {
    ...process.env,
    V4_TASK_TYPE: 'bugfix',
    V4_WORKSPACE_ROOT: paths.workspace,
    V4_TEMP_ROOT: paths.root,
    V4_AUDIT_LOG: paths.audit,
    V4_EXPLORATION_STATE: explorationState,
    V4_SOURCE_PROGRESS_STATE: sourceProgressState,
    V4_EXPLORATION_LIMIT: '100',
  };
  const runParallelTool = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `hook exited ${code}`)));
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_use_id: `parallel-read-${index}`,
      tool_name: 'Read',
      tool_input: { file_path: path.join(paths.workspace, 'queue.go') },
    }));
  });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => runParallelTool(index)));
    const state = JSON.parse(await readFile(explorationState, 'utf8'));
    assert.equal(state.count, 8);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('diagnosis hook records denied source-writing Bash calls in the mutation audit', async () => {
  const paths = await fixture({ includeFull: false });
  try {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_use_id: 'diagnosis-write',
        tool_name: 'Bash',
        tool_input: { command: "printf 'package main' > /tmp/repro.go" },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        V4_TASK_TYPE: 'diagnosis',
        V4_WORKSPACE_ROOT: paths.workspace,
        V4_TEMP_ROOT: paths.root,
        V4_AUDIT_LOG: paths.audit,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const records = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const denied = records.find((record) => record.tool_use_id === 'diagnosis-write');
    assert.equal(denied.event, 'PreToolUse');
    assert.equal(denied.permission_decision, 'deny');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('diagnosis hook denies generic filesystem and persistent configuration writes', async () => {
  const paths = await fixture({ includeFull: false });
  const commands = [
    `printf probe > ${paths.workspace}/probe.txt`,
    `mkdir ${paths.workspace}/probe-dir`,
    `chmod u+w ${paths.workspace}/queue.go`,
    'go env -w GOFLAGS=',
  ];
  try {
    for (const [index, command] of commands.entries()) {
      const result = spawnSync(process.execPath, [hook], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_use_id: `generic-write-${index}`,
          tool_name: 'Bash',
          tool_input: { command },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          V4_TASK_TYPE: 'diagnosis',
          V4_WORKSPACE_ROOT: paths.workspace,
          V4_TEMP_ROOT: paths.root,
          V4_AUDIT_LOG: paths.audit,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', command);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('mutation snapshots exclude Claude internal shell snapshot files', async () => {
  const paths = await fixture({ includeFull: false });
  try {
    const shellSnapshots = path.join(paths.root, 'claude-config/shell-snapshots');
    await mkdir(shellSnapshots, { recursive: true });
    await writeFile(path.join(shellSnapshots, 'snapshot.sh'), '# internal shell state\n');
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'V4Final' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        V4_TASK_TYPE: 'diagnosis',
        V4_WORKSPACE_ROOT: paths.workspace,
        V4_TEMP_ROOT: paths.root,
        V4_AUDIT_LOG: paths.audit,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const records = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const final = records.at(-1);
    assert.equal(final.event, 'V4Final');
    assert.equal(Object.keys(final.files).some((filename) => filename.includes('claude-config/shell-snapshots')), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
