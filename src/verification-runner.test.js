import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { platformCompatibleVerificationProofIssues, validateVerificationProofBundle, verificationCommandsSha256, verificationProofPrompt } from './verification-proof.js';

const runner = path.resolve(import.meta.dirname, '../run_verify_claude.sh');

test('verification proof sessions use the dedicated Bug-fix GLM model', async () => {
  const source = await readFile(runner, 'utf8');
  assert.match(source, /claude_model="\$\{GO_PIPELINE_BUGFIX_MODEL:-model_hub\/glm-52-coding\}"/);
  assert.match(source, /Claude 验证模型不匹配/);
  assert.match(source, /\.test-author-checkpoint\/workspace/);
  assert.match(source, /grader\/model-tests/);
  assert.match(source, /repository verification test materialization failed/);
});

test('platform proof compatibility requires a paired non-zero Go failure with recognizable output', () => {
  const command = "go test ./internal/service -run '^TestRegression$' -count=1 -v";
  const trajectory = (output) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: output }] } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(platformCompatibleVerificationProofIssues({
    phase: 'pre_fix',
    taskType: 'bugfix',
    verifyCmds: [command],
    trajectoryContent: trajectory('Exit code 1\n=== RUN   TestRegression\n--- FAIL: TestRegression (0.01s)\nFAIL\n'),
  }), []);
  assert.match(platformCompatibleVerificationProofIssues({
    phase: 'pre_fix',
    taskType: 'bugfix',
    verifyCmds: [command],
    trajectoryContent: trajectory('Exit code 1\n==================\nWARNING: DATA RACE\nRead at 0x00c0000142f8\n'),
  }).join('；'), /没有执行到目标测试/);
  assert.match(platformCompatibleVerificationProofIssues({
    phase: 'pre_fix',
    taskType: 'bugfix',
    verifyCmds: [command],
    trajectoryContent: trajectory('Exit code 1\n# sample/service_test\nservice_test.go:12: undefined: FixedOnlyAPI\nFAIL sample/service [build failed]\nFAIL\n'),
  }).join('；'), /构建或初始化失败/);
  assert.match(platformCompatibleVerificationProofIssues({
    phase: 'pre_fix',
    taskType: 'bugfix',
    verifyCmds: [command],
    trajectoryContent: trajectory('Exit code 1\ncommand stopped\n'),
  }).join('；'), /没有执行到目标测试/);
});

test('proof validator accepts the exact direct-command timeout prompt template', () => {
  const verifyCmds = ["go test ./internal/service -run '^TestRegression$' -count=1 -v"];
  const currentPrompt = verificationProofPrompt('pre_fix', verifyCmds);
  const promptContent = `${currentPrompt.replace(
    '\nDo not inspect files',
    '\nSet every Bash tool timeout to 600000 milliseconds so each verification command can finish.\nDo not inspect files',
  )}\n`;
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const contents = {
    trajectoryContent: '',
    rawStreamContent: '',
    promptContent,
    resultContent: '{}',
    commandResultsContent: '',
  };
  const manifest = {
    policy_version: 5,
    phase: 'pre_fix',
    command_mode: 'direct_verify_cmds_v2',
    command_count: verifyCmds.length,
    session_id: '11111111-1111-4111-8111-111111111111',
    source_commit: 'a'.repeat(40),
    verify_cmds_sha256: verificationCommandsSha256(verifyCmds),
    trajectory_sha256: hash(contents.trajectoryContent),
    trajectory_filename: 'trajectory_11111111-1111-4111-8111-111111111111.jsonl',
    raw_stream_sha256: hash(contents.rawStreamContent),
    prompt_sha256: hash(contents.promptContent),
    result_sha256: hash(contents.resultContent),
    command_results_sha256: hash(contents.commandResultsContent),
    result: 'red',
  };
  const checked = validateVerificationProofBundle({
    phase: 'pre_fix',
    bugBaseCommit: manifest.source_commit,
    verifyCmds,
    evidence: manifest,
    manifest,
    ...contents,
  });
  assert.doesNotMatch(checked.issues.join(';'), /提示词与系统固定提示不一致/);

  const previousPromptContent = `${currentPrompt.replace(
    '\nIf a Bash result contains a <persisted-output> notice because its output is large, do not read, tail, cat, or otherwise inspect that temporary file. Treat the original Bash tool result and exit status as the complete command result.',
    '',
  )}\n`;
  const previousContents = { ...contents, promptContent: previousPromptContent };
  const previousManifest = { ...manifest, prompt_sha256: hash(previousPromptContent) };
  const previousChecked = validateVerificationProofBundle({
    phase: 'pre_fix',
    bugBaseCommit: previousManifest.source_commit,
    verifyCmds,
    evidence: previousManifest,
    manifest: previousManifest,
    ...previousContents,
  });
  assert.doesNotMatch(previousChecked.issues.join(';'), /提示词与系统固定提示不一致/);

  const legacyPromptContent = `${currentPrompt.replace(
    'Execute every command verbatim. Shell quoting, $(pwd), or bash -c already present inside a listed Docker command is part of that command and must be preserved. Do not combine commands, add another wrapper, add prefixes or suffixes, retry them, or skip later commands after a failure.',
    'Execute every command verbatim. Do not combine commands, wrap them in another command or script, add prefixes or suffixes, retry them, or skip later commands after a failure.',
  ).replace(
    '\nIf a Bash result contains a <persisted-output> notice because its output is large, do not read, tail, cat, or otherwise inspect that temporary file. Treat the original Bash tool result and exit status as the complete command result.',
    '',
  ).replace(
    '\nDo not inspect files',
    '\nSet every Bash tool timeout to 600000 milliseconds so each verification command can finish.\nDo not inspect files',
  )}\n`;
  const legacyContents = { ...contents, promptContent: legacyPromptContent };
  const legacyManifest = { ...manifest, prompt_sha256: hash(legacyPromptContent) };
  const legacyChecked = validateVerificationProofBundle({
    phase: 'pre_fix',
    bugBaseCommit: legacyManifest.source_commit,
    verifyCmds,
    evidence: legacyManifest,
    manifest: legacyManifest,
    ...legacyContents,
  });
  assert.doesNotMatch(legacyChecked.issues.join(';'), /提示词与系统固定提示不一致/);
});

test('V5 proof validator rejects wrapper-script verification evidence', () => {
  const verifyCmds = ['go test ./internal/service -run TestRegression -count=1'];
  const manifest = {
    policy_version: 5,
    phase: 'pre_fix',
    command_mode: 'inline_verify_cmds_v1',
    command_count: 1,
    session_id: '11111111-1111-4111-8111-111111111111',
    source_commit: 'a'.repeat(40),
    verify_cmds_sha256: verificationCommandsSha256(verifyCmds),
    result: 'red',
  };
  const checked = validateVerificationProofBundle({
    phase: 'pre_fix',
    bugBaseCommit: manifest.source_commit,
    verifyCmds,
    evidence: manifest,
    manifest,
  });
  assert.equal(checked.ok, false);
  assert.match(checked.issues.join(';'), /V5 .*direct|V5 .*verify_cmds/);
});

test('historical diagnosis proof accepts MODEL_REPRO while retaining the raw command binding', () => {
  const verifyCmds = ["MODEL_REPRO=1 go test ./internal/service -run '^TestRegression$' -count=1 -v"];
  const manifest = {
    policy_version: 5,
    phase: 'pre_fix',
    command_mode: 'direct_verify_cmds_v2',
    command_count: 1,
    session_id: '11111111-1111-4111-8111-111111111111',
    source_commit: 'a'.repeat(40),
    verify_cmds_sha256: verificationCommandsSha256(verifyCmds),
    result: 'red',
  };
  const checked = validateVerificationProofBundle({
    phase: 'pre_fix',
    taskType: 'diagnosis',
    bugBaseCommit: manifest.source_commit,
    verifyCmds,
    evidence: manifest,
    manifest,
    allowHistoricalDiagnosisModelRepro: true,
  });
  assert.doesNotMatch(checked.issues.join(';'), /MODEL_REPRO/);
  assert.equal(checked.ok, false);
  assert.match(checked.issues.join(';'), /证明原始轨迹无法解析|证明提示词与系统固定提示不一致/);
});

test('verification runner captures independent red and green Claude proof sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'verification-runner-test-'));
  try {
    const taskDir = path.join(root, 'task');
    const preSource = path.join(root, 'pre-source');
    const postSource = path.join(root, 'post-source');
    const preOutput = path.join(root, 'pre-output');
    const postOutput = path.join(root, 'post-output');
    const fakeHome = path.join(root, 'home');
    const fakeBin = path.join(root, 'bin');
    const fakeClaude = path.join(root, 'fake-claude.sh');
    await Promise.all([
      mkdir(path.join(taskDir, 'grader/gold-tests'), { recursive: true }),
      mkdir(path.join(taskDir, 'workspace'), { recursive: true }),
      mkdir(preSource, { recursive: true }),
      mkdir(postSource, { recursive: true }),
      mkdir(fakeHome, { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
    ]);
    await writeFile(path.join(preSource, 'sample.go'), 'package sample\n\nfunc Fixed() bool { return false }\n');
    await writeFile(path.join(postSource, 'sample.go'), 'package sample\n\nfunc Fixed() bool { return true }\n');
    await writeFile(path.join(preSource, 'go.mod'), 'module example.test/sample\n\ngo 1.23\n');
    await writeFile(path.join(postSource, 'go.mod'), 'module example.test/sample\n\ngo 1.23\n');
    const regressionTest = `package sample

import "testing"

func TestRegression(t *testing.T) {
	if !Fixed() { t.Fatal("bug is present") }
}
`;
    await writeFile(path.join(postSource, 'sample_regression_test.go'), regressionTest);
    await writeFile(path.join(taskDir, 'workspace/sample_regression_test.go'), regressionTest);
    await writeFile(path.join(taskDir, 'grader/test-files.txt'), 'sample_regression_test.go\n');
    await writeFile(path.join(taskDir, 'grader/gold-tests/sample_regression_test.go'), regressionTest);
    const publicMetadata = {
      task_type: 'bugfix',
      verify_cmds: [
        "go test . -run '^TestRegression$' -count=1 -v",
        'go test ./... -count=1',
      ],
      verification_test_overlay: 'repository-tests',
      verification_test_files: ['sample_regression_test.go'],
      bug_base_commit: 'a'.repeat(40),
      test_model_fix_commit: 'b'.repeat(40),
    };
    await writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify(publicMetadata, null, 2)}\n`);
    await writeFile(path.join(fakeHome, '.bash_profile'), `export PATH="${fakeBin}:$PATH"\n`);
    await writeFile(fakeClaude, `#!/usr/bin/env bash
set -euo pipefail
phase=post_fix
session_id=22222222-2222-4222-8222-222222222222
if [[ "$*" == *"pre_fix"* ]]; then
  phase=pre_fix
  session_id=11111111-1111-4111-8111-111111111111
fi
stream="$(mktemp)"
jq -cn --arg sid "$session_id" '{type:"system",subtype:"init",session_id:$sid,claude_code_version:"9.9.9",model:"model_hub/glm-52-coding"}' >>"$stream"
index=0
metadata=public.json
[[ -f "$metadata" ]] || metadata=../public.json
while IFS= read -r command; do
  index=$((index + 1))
  tool_id="tool-$index"
  jq -cn --arg sid "$session_id" --arg command "$command" --arg tool_id "$tool_id" '{type:"assistant",session_id:$sid,message:{role:"assistant",content:[{type:"tool_use",id:$tool_id,name:"Bash",input:{command:$command}}]}}' >>"$stream"
  set +e
  eval "$command" >command.out 2>&1
  command_exit=$?
  set -e
  command_content="$(cat command.out)"
  if [[ "$command_exit" -ne 0 ]]; then command_content="Exit code $command_exit
$command_content"; fi
  jq -cn --arg sid "$session_id" --arg tool_id "$tool_id" --arg content "$command_content" --argjson failed "$([[ "$command_exit" -ne 0 ]] && echo true || echo false)" '{type:"user",session_id:$sid,message:{role:"user",content:[{type:"tool_result",tool_use_id:$tool_id,content:$content,is_error:$failed}]}}' >>"$stream"
done < <(jq -r '.verify_cmds[]' "$metadata")
jq -cn --arg sid "$session_id" --arg phase "$phase" '{type:"assistant",session_id:$sid,message:{role:"assistant",content:[{type:"text",text:(if $phase == "pre_fix" then "red" else "green" end)}]}}' >>"$stream"
jq -cn --arg sid "$session_id" '{type:"result",subtype:"success",session_id:$sid,is_error:false,result:"complete"}' >>"$stream"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/fake"
cp "$stream" "$CLAUDE_CONFIG_DIR/projects/fake/$session_id.jsonl"
cat "$stream"
`);
    await chmod(fakeClaude, 0o755);

    const run = (phase, source, output) => spawnSync('/bin/bash', [runner, taskDir, phase, source, output], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}`, GO_PIPELINE_CLAUDE_BIN: fakeClaude },
    });
    const preRun = run('pre_fix', preSource, preOutput);
    assert.equal(preRun.status, 0, preRun.stderr);
    const postRun = run('post_fix', postSource, postOutput);
    assert.equal(postRun.status, 0, postRun.stderr);

    const preManifest = JSON.parse(await readFile(path.join(preOutput, 'manifest.json'), 'utf8'));
    const postManifest = JSON.parse(await readFile(path.join(postOutput, 'manifest.json'), 'utf8'));
    assert.equal(preManifest.result, 'red');
    assert.equal(preManifest.exit_code, 1);
    assert.equal(preManifest.source_commit, 'a'.repeat(40));
    assert.equal(postManifest.result, 'green');
    assert.equal(postManifest.exit_code, 0);
    assert.equal(postManifest.source_commit, 'b'.repeat(40));
    assert.notEqual(preManifest.session_id, postManifest.session_id);
    for (const manifest of [preManifest, postManifest]) {
      assert.match(manifest.verify_cmds_sha256, /^[a-f0-9]{64}$/);
      assert.match(manifest.trajectory_sha256, /^[a-f0-9]{64}$/);
      assert.equal(manifest.claude_code_version, '9.9.9');
      assert.equal(manifest.policy_version, 5);
      assert.equal(manifest.command_mode, 'direct_verify_cmds_v2');
      assert.equal(manifest.command_count, publicMetadata.verify_cmds.length);
      const proofTrajectory = await readFile(path.join(manifest.phase === 'pre_fix' ? preOutput : postOutput, manifest.trajectory_filename), 'utf8');
      for (const command of publicMetadata.verify_cmds) assert.match(proofTrajectory, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const validateOutput = async (phase, output, manifest, otherSessionId) => {
      const read = (filename) => readFile(path.join(output, filename), 'utf8');
      return validateVerificationProofBundle({
        phase,
        taskName: 'test-task',
        taskType: publicMetadata.task_type,
        mainSessionId: '33333333-3333-4333-8333-333333333333',
        otherSessionId,
        bugBaseCommit: publicMetadata.bug_base_commit,
        testModelFixCommit: publicMetadata.test_model_fix_commit,
        verifyCmds: publicMetadata.verify_cmds,
        evidence: manifest,
        manifest,
        trajectoryContent: await read(manifest.trajectory_filename),
        rawStreamContent: await read('raw.stream.jsonl'),
        promptContent: await read('PROMPT.md'),
        resultContent: await read('verification-result.json'),
        commandResultsContent: await read('verification-command-results.jsonl'),
      });
    };
    const checkedPre = await validateOutput('pre_fix', preOutput, preManifest, postManifest.session_id);
    const checkedPost = await validateOutput('post_fix', postOutput, postManifest, preManifest.session_id);
    assert.deepEqual(checkedPre.issues, []);
    assert.deepEqual(checkedPost.issues, []);
    const staleCommands = validateVerificationProofBundle({
      phase: 'pre_fix',
      bugBaseCommit: publicMetadata.bug_base_commit,
      verifyCmds: ['go test ./...'],
      evidence: preManifest,
      manifest: preManifest,
    });
    assert.equal(staleCommands.ok, false);
    assert.match(staleCommands.issues.join(';'), /当前 verify_cmds/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
