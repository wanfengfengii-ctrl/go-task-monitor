import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertNoPrivatePolicyLeak,
  canonicalizeClaudeTranscript,
  createTrajectoryManifest,
  resolveTrajectoryManifestPrompt,
  serializeCanonicalTrajectory,
  validateTrajectoryManifest,
} from './trajectory-v4.js';
import { validateTrajectoryEvents, validateTrajectoryIntegrityEvents } from './trajectory-file-validator.js';

const sessionId = 'd5889c13-4327-499d-bea1-5f3da042aee5';

test('canonical export keeps the complete conversation and emits one exact last-prompt', () => {
  const raw = [
    { type: 'queue-operation', sessionId },
    { type: 'user', sessionId, message: { content: '修复这个问题' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'tool_use', id: 'one', name: 'Read', input: { file_path: 'a.go' } }] } },
    { type: 'user', sessionId, toolUseResult: { duplicate: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'package a' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '修复' },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '已完成' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '修复这个' },
  ];
  const result = canonicalizeClaudeTranscript(raw, { expectedPrompt: '修复这个问题' });
  assert.deepEqual(result.events.map((event) => event.type), ['user', 'assistant', 'user', 'assistant', 'last-prompt']);
  assert.equal(result.events.at(-1).lastPrompt, '修复这个问题');
  assert.equal(Object.hasOwn(result.events[2], 'toolUseResult'), false);
});

test('canonical export rejects multiple human turns', () => {
  const raw = [
    { type: 'user', sessionId, message: { content: '第一轮' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '答复' }] } },
    { type: 'user', sessionId, message: { content: '第二轮' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '答复' }] } },
  ];
  assert.throws(() => canonicalizeClaudeTranscript(raw), /只有一轮用户输入/);
});

test('canonical export removes internal Stop hook feedback while preserving the repaired tool flow', () => {
  const raw = [
    { type: 'user', sessionId, message: { content: '修复这个问题' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '初次准备结束' }] } },
    { type: 'user', sessionId, message: { content: 'Stop hook feedback:\n请单独运行 go test ./... -count=1。' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'tool_use', id: 'full', name: 'Bash', input: { command: 'go test ./... -count=1' } }] } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'full', is_error: false, content: 'ok' }] } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '验证完成' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '修复这个问题' },
  ];
  const result = canonicalizeClaudeTranscript(raw, { expectedPrompt: '修复这个问题' });
  const delivery = serializeCanonicalTrajectory(result.events);
  assert.equal(result.events.filter((event) => userPromptTextForTest(event)).length, 1);
  assert.doesNotMatch(delivery, /Stop hook feedback/);
  assert.match(delivery, /go test \.\/\.\.\. -count=1/);
});

test('canonical export removes Claude no-visible-output continuation while retaining the continued answer', () => {
  const continuation = '[Your previous response had no visible output. Please continue and produce a user-visible response.]';
  const raw = [
    { type: 'user', sessionId, message: { content: '修复这个问题' } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.go' } }] } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'package a' }] } },
    { type: 'assistant', sessionId, message: { content: [] } },
    { type: 'user', sessionId, isSynthetic: true, message: { content: continuation } },
    { type: 'assistant', sessionId, message: { content: [{ type: 'text', text: '修复和验证已经完成。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: '修复这个问题' },
  ];
  const result = canonicalizeClaudeTranscript(raw, { expectedPrompt: '修复这个问题' });
  const delivery = serializeCanonicalTrajectory(result.events);
  assert.doesNotMatch(delivery, /previous response had no visible output/);
  assert.equal(result.events.at(-2).message.content[0].text, '修复和验证已经完成。');

  const nativeValidation = validateTrajectoryEvents(raw, {
    filename: `trajectory_${sessionId}.jsonl`,
    taskType: 'diagnosis',
    executionPolicyVersion: 4,
  });
  assert.equal(nativeValidation.errors.some((item) => item.code === 'single-user-turn'), false);

  const nonSynthetic = raw.map((event) => event.isSynthetic ? { ...event, isSynthetic: false } : event);
  assert.throws(() => canonicalizeClaudeTranscript(nonSynthetic), /只有一轮用户输入/);
});

test('canonical export removes only external root parent links and preserves retained links', () => {
  const externalRoot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const assistantUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const raw = [
    { type: 'user', sessionId, uuid: userUuid, parentUuid: null, message: { content: '诊断这个问题' } },
    { type: 'assistant', sessionId, uuid: assistantUuid, parentUuid: externalRoot, message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'main.go' } }] } },
    { type: 'assistant', sessionId, uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', parentUuid: assistantUuid, message: { content: [{ type: 'text', text: '已完成诊断。' }] } },
  ];
  const result = canonicalizeClaudeTranscript(raw, { expectedPrompt: '诊断这个问题' });
  assert.equal(result.events[1].parentUuid, null);
  assert.equal(result.events[2].parentUuid, assistantUuid);
  const integrity = validateTrajectoryIntegrityEvents(result.events, { filename: `trajectory_${sessionId}.jsonl` });
  assert.equal(integrity.errors.some((item) => item.code === 'parent-chain'), false, integrity.errors.map((item) => item.message).join('; '));
});

function userPromptTextForTest(event) {
  if (event?.type !== 'user') return '';
  const content = event?.message?.content;
  return typeof content === 'string' ? content : '';
}

test('V4 manifest binds prompt, raw captures, delivery, and audit hashes', () => {
  const delivery = serializeCanonicalTrajectory([{ type: 'last-prompt', sessionId }]);
  const values = {
    sessionId,
    taskType: 'bugfix',
    prompt: '题面',
    rawNativeContent: 'native\n',
    rawStreamContent: 'stream\n',
    deliveryContent: delivery,
    auditContent: 'audit\n',
    deliveryFilename: `trajectory_${sessionId}.jsonl`,
    rawFilename: `raw.native.${sessionId}.jsonl`,
    rawEventCount: 4,
    eventCount: 1,
    goVersion: 'go version go1.25.6 darwin/arm64',
  };
  const manifest = createTrajectoryManifest(values);
  assert.equal(manifest.exporter_version, 'v4.1.1');
  assert.equal(manifest.upload_source, 'raw_native');
  assert.equal(manifest.upload_filename, `trajectory_${sessionId}.jsonl`);
  assert.equal(manifest.upload_sha256, manifest.raw_sha256);
  assert.equal(validateTrajectoryManifest(manifest, {
    prompt: values.prompt,
    rawNativeContent: values.rawNativeContent,
    rawStreamContent: values.rawStreamContent,
    deliveryContent: values.deliveryContent,
    auditContent: values.auditContent,
  }).ok, true);
  assert.match(validateTrajectoryManifest(manifest, { ...values, deliveryContent: 'changed' }).issues.join(';'), /delivery_sha256/);
});

test('V4 manifest accepts the immutable prompt with or without its fixed Markdown heading', () => {
  const body = '修复终局持久化问题';
  const document = `# 用户题面\n\n${body}\n`;
  assert.equal(resolveTrajectoryManifestPrompt({ prompt_sha256: createTrajectoryManifest({
    sessionId,
    taskType: 'bugfix',
    prompt: body,
    rawNativeContent: 'native',
    rawStreamContent: 'stream',
    deliveryContent: 'delivery',
    auditContent: 'audit',
    deliveryFilename: `trajectory_${sessionId}.jsonl`,
    rawFilename: `raw.native.${sessionId}.jsonl`,
    rawEventCount: 1,
    eventCount: 1,
  }).prompt_sha256 }, document), body);

  const fullHash = createTrajectoryManifest({
    sessionId,
    taskType: 'bugfix',
    prompt: document,
    rawNativeContent: 'native',
    rawStreamContent: 'stream',
    deliveryContent: 'delivery',
    auditContent: 'audit',
    deliveryFilename: `trajectory_${sessionId}.jsonl`,
    rawFilename: `raw.native.${sessionId}.jsonl`,
    rawEventCount: 1,
    eventCount: 1,
  }).prompt_sha256;
  assert.equal(resolveTrajectoryManifestPrompt({ prompt_sha256: fullHash }, document), document.trim());
});

test('current manifest rejects normalized-upload fallback while legacy manifests remain readable', () => {
  const values = {
    sessionId,
    taskType: 'bugfix',
    prompt: '题面',
    rawNativeContent: 'native\n',
    rawStreamContent: 'stream\n',
    deliveryContent: 'delivery\n',
    auditContent: 'audit\n',
    deliveryFilename: `trajectory_${sessionId}.jsonl`,
    rawFilename: `raw.native.${sessionId}.jsonl`,
    rawEventCount: 2,
    eventCount: 2,
  };
  const current = createTrajectoryManifest(values);
  delete current.upload_source;
  assert.match(validateTrajectoryManifest(current, values).issues.join(';'), /原生轨迹作为上传源/);

  const legacy = { ...current, exporter_version: 'v4.0.0' };
  assert.doesNotMatch(validateTrajectoryManifest(legacy, values).issues.join(';'), /原生轨迹作为上传源/);
});

test('canonical delivery rejects leaked hidden policy text', () => {
  assert.equal(assertNoPrivatePolicyLeak('普通用户题面和工具轨迹'), true);
  assert.throws(() => assertNoPrivatePolicyLeak('You are the test model in a controlled benchmark trajectory.'), /隐藏系统约束/);
});

test('canonical exporter and V4 validator bind a complete diagnosis capture end to end', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trajectory-v4-e2e-'));
  const trajectoryDir = path.join(directory, 'trajectory');
  const graderDir = path.join(directory, 'grader');
  const prompt = '# 用户题面\n\n请只诊断 queue.go 中 Queue.Pop 的空队列错误，不要修改代码。';
  const rawNative = path.join(trajectoryDir, `raw.native.${sessionId}.jsonl`);
  const rawStream = path.join(trajectoryDir, 'trajectory.stream.jsonl');
  const audit = path.join(trajectoryDir, 'mutation-audit.jsonl');
  const delivery = path.join(trajectoryDir, `trajectory_${sessionId}.jsonl`);
  const manifest = path.join(trajectoryDir, 'runner-manifest.json');
  const event = (value) => JSON.stringify(value);
  const events = [
    { type: 'user', sessionId, cwd: '/isolated/workspace', message: { role: 'user', content: prompt } },
    { type: 'assistant', sessionId, cwd: '/isolated/workspace', message: { model: 'model', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/isolated/workspace/queue.go' } }] } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'read', is_error: false, content: 'package queue' }] } },
    { type: 'assistant', sessionId, cwd: '/isolated/workspace', message: { model: 'model', content: [{ type: 'tool_use', id: 'repro', name: 'Bash', input: { command: "go test -count=1 -run '^TestEmptyQueue$' ./..." } }] } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'repro', is_error: true, content: 'panic: index out of range' }] } },
    { type: 'assistant', sessionId, cwd: '/isolated/workspace', message: { model: 'model', content: [{ type: 'tool_use', id: 'clean', name: 'Bash', input: { command: "cd .. && diff -qr --exclude='.git' pristine workspace" } }] } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'clean', is_error: false, content: '' }] } },
    { type: 'assistant', sessionId, cwd: '/isolated/workspace', message: { model: 'model', content: [{ type: 'text', text: 'queue.go 的 Queue.Pop 缺少长度检查，空队列直接索引导致 panic；工作区未修改。' }] } },
    { type: 'last-prompt', sessionId, lastPrompt: prompt },
  ];
  const auditRecords = [
    { event: 'V4Baseline', files: { 'workspace/queue.go': 'same' } },
    { event: 'PreToolUse', tool_use_id: 'repro', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
    { event: 'PostToolUseFailure', tool_use_id: 'repro', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
    { event: 'PreToolUse', tool_use_id: 'clean', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
    { event: 'PostToolUse', tool_use_id: 'clean', tool_name: 'Bash', files: { 'workspace/queue.go': 'same' } },
    { event: 'V4Final', files: { 'workspace/queue.go': 'same' } },
  ];
  try {
    await mkdir(trajectoryDir, { recursive: true });
    await mkdir(graderDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, 'PROMPT.md'), `${prompt}\n`, 'utf8'),
      writeFile(path.join(directory, 'public.json'), `${JSON.stringify({ sample_id: 'sample', task_type: 'diagnosis', go_version: 'go1.25.6; go.mod go 1.23' })}\n`, 'utf8'),
      writeFile(path.join(directory, '.trajectory-policy-v4'), 'policy=4\n', 'utf8'),
      writeFile(path.join(graderDir, 'v4-context.json'), `${JSON.stringify({ gold_files: ['queue.go'], gold_symbols: ['Queue.Pop'], mechanism_keywords: ['长度检查', '空队列', '索引', 'panic'] })}\n`, 'utf8'),
      writeFile(rawNative, `${events.map(event).join('\n')}\n`, 'utf8'),
      writeFile(rawStream, `${event({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId })}\n`, 'utf8'),
      writeFile(audit, `${auditRecords.map(event).join('\n')}\n`, 'utf8'),
    ]);
    const exporter = path.resolve(import.meta.dirname, '../scripts/export-canonical-trajectory.mjs');
    const exported = spawnSync(process.execPath, [
      exporter,
      `--native=${rawNative}`,
      `--stream=${rawStream}`,
      `--prompt=${path.join(directory, 'PROMPT.md')}`,
      `--audit=${audit}`,
      `--output=${delivery}`,
      `--manifest=${manifest}`,
      '--task-type=diagnosis',
      '--go-version=go version go1.25.6 darwin/arm64',
    ], { encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);

    const validator = path.resolve(import.meta.dirname, '../scripts/validate-trajectories.mjs');
    const validate = () => spawnSync(process.execPath, [validator, '--json', `--task-root=${directory}`, delivery], { encoding: 'utf8' });
    const passed = validate();
    assert.equal(passed.status, 0, passed.stderr || passed.stdout);
    assert.equal(JSON.parse(passed.stdout).ok, true);

    await writeFile(rawStream, `${await readFile(rawStream, 'utf8')}tampered\n`, 'utf8');
    const rejected = validate();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /stream_sha256 与本地不可变文件不一致/);
    await chmod(manifest, 0o644);
    await chmod(delivery, 0o644);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
