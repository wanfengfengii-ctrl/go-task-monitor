import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  EXCEL_EXPORT_FIELDS,
  buildGoldRootCause,
  hasChineseText,
  hasEnglishProse,
  isCloudTrajectoryFileUrl,
  isCloudTrajectoryUrl,
  isGitCommitUrl,
  isGitTestModelBranchUrl,
  naturalizeGoldRootCause,
  prepareExcelRecord,
  requireCloudTrajectoryUrl,
  requireGitCommitUrl,
  requireGitTestModelBranchUrl,
  requireChineseGoldRootCause,
  requireChineseText,
  requireNonEmptyText,
  requireDockerHarness,
  requireDockerVerifyCmds,
  requirePinnedGoVersion,
  requireDirectPublicVerifyCmd,
  requireVerificationPolicyV5,
  sanitizeHarness,
  stripMarkdownBackticks,
  stripVerifyPassPrefix,
} from './export-rules.js';

const dockerVerifyCmd = [
  'docker build --platform linux/arm64 -f benzhi.Dockerfile -t sample-task-grader-arm64:latest .',
  'docker run --rm --network none --platform linux/arm64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-arm64:latest bash -c \'GOTOOLCHAIN=local go test -count=1 -run "^TestRegression$" ./...\'',
  'docker run --rm --network none --platform linux/arm64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-arm64:latest bash -c \'GOTOOLCHAIN=local go test ./... -count=1\'',
  'docker run --rm --network none --platform linux/arm64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-arm64:latest bash -c \'GOTOOLCHAIN=local go vet ./...\'',
  'docker build --platform linux/amd64 -f benzhi.Dockerfile -t sample-task-grader-amd64:latest .',
  'docker run --rm --network none --platform linux/amd64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-amd64:latest bash -c \'GOTOOLCHAIN=local go test -count=1 -run "^TestRegression$" ./...\'',
  'docker run --rm --network none --platform linux/amd64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-amd64:latest bash -c \'GOTOOLCHAIN=local go test ./... -count=1\'',
  'docker run --rm --network none --platform linux/amd64 -e GOTOOLCHAIN=local -v "$(pwd):/workspace:ro" -w /workspace sample-task-grader-amd64:latest bash -c \'GOTOOLCHAIN=local go vet ./...\'',
  'docker image rm -f sample-task-grader-arm64:latest sample-task-grader-amd64:latest',
].join('\n');
const dockerHarness = 'backend=docker-target; isolation=workspace-without-.git; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code); go=go1.25.6; hidden_target_runs=20/20;';
const packagedDockerVerifyCmd = [
  'docker build --platform linux/arm64 -f workspace/benzhi.Dockerfile -t sample-task-grader-arm64:latest workspace',
  'docker run --rm --network none --platform linux/arm64 -e GO_BIN=go -e GOTOOLCHAIN=local -v "${PWD}/grader:/grader:ro" sample-task-grader-arm64:latest /grader/run_target.sh /app',
  'docker run --rm --network none --platform linux/arm64 -e GO_BIN=go -e GOTOOLCHAIN=local -v "${PWD}/grader:/grader:ro" sample-task-grader-arm64:latest /grader/run_full.sh /app',
  'docker build --platform linux/amd64 -f workspace/benzhi.Dockerfile -t sample-task-grader-amd64:latest workspace',
  'docker run --rm --network none --platform linux/amd64 -e GO_BIN=go -e GOTOOLCHAIN=local -v "${PWD}/grader:/grader:ro" sample-task-grader-amd64:latest /grader/run_target.sh /app',
  'docker run --rm --network none --platform linux/amd64 -e GO_BIN=go -e GOTOOLCHAIN=local -v "${PWD}/grader:/grader:ro" sample-task-grader-amd64:latest /grader/run_full.sh /app',
].join('\n');
const directVerifyCmd = "go test ./internal/sample -run '^TestRegression$' -count=1 -v";
const mainSession = '11111111-1111-4111-8111-111111111111';
const verifyResult = {
  pre_fix: {
    trajectory_url: 'https://upload.example.com/trajectory_22222222-2222-4222-8222-222222222222.jsonl',
    session_id: '22222222-2222-4222-8222-222222222222',
    result: 'red',
  },
  post_fix: {
    trajectory_url: 'https://upload.example.com/trajectory_33333333-3333-4333-8333-333333333333.jsonl',
    session_id: '33333333-3333-4333-8333-333333333333',
    result: 'green',
  },
};
const v5ExportFields = {
  'session  id': mainSession,
  verification_policy_version: 5,
  verify_result: verifyResult,
};

test('sanitizeHarness removes runtime counters and workspace policy', () => {
  const input = 'backend=docker-target; trajectory_events=8354; api_retry=0; permission_denial=0; permission_prompt=none; workspace_policy=patched; go=go1.25.6 linux/arm64;';
  assert.equal(
    sanitizeHarness(input),
    'backend=docker-target; go=go1.25.6 linux/arm64;',
  );
});

test('sanitizeHarness preserves unrelated environment and grader evidence', () => {
  const input = 'backend=docker-target; isolation=workspace-without-.git; hidden_target_agent=20/20; platform=linux/arm64,linux/amd64';
  assert.equal(
    sanitizeHarness(input),
    'backend=docker-target; isolation=workspace-without-.git; hidden_target_agent=20/20; platform=linux/arm64,linux/amd64;',
  );
});

test('Chinese export fields allow Go identifiers and root cause removes Markdown backticks', () => {
  const value = '`lex.go` 的 `lexer.errorf` 在 EOF 前无换行时错误回退行号，导致后续错误位置少报一行。';
  assert.equal(hasChineseText(value), true);
  assert.equal(stripMarkdownBackticks(value), 'lex.go 的 lexer.errorf 在 EOF 前无换行时错误回退行号，导致后续错误位置少报一行。');
  assert.equal(requireChineseGoldRootCause(value, 'sample-task'), 'lex.go 的 lexer.errorf 在 EOF 前无换行时错误回退行号，导致后续错误位置少报一行。');
  assert.equal(requireChineseText('请修复 queue.go 的空队列错误。', 'user_query', 'sample-task'), '请修复 queue.go 的空队列错误。');
  assert.throws(
    () => requireChineseGoldRootCause('EOF handling always decremented the line number.', 'sample-task'),
    /gold_root_cause 必须以中文为主体/,
  );
  assert.throws(() => requireChineseText('Fix the queue failure.', 'user_query', 'sample-task'), /user_query 必须以中文为主体/);
});

test('Chinese export fields reject embedded English narrative but keep identifiers and commands', () => {
  const mixed = 'internal/arbitrator/sqlarbiter.go、internal/catalog/catalog.go 中，根本原因是The probe API validates generation and digests but persists any target string. RecordProbe inserts the target as evidence, and EvidenceClosed only counts passing rows for the task.';
  assert.equal(hasChineseText(mixed), true);
  assert.equal(hasEnglishProse(mixed), true);
  assert.throws(() => requireChineseGoldRootCause(mixed, 'sample-task'), /不能夹带英文叙述段落/);
  assert.equal(
    requireChineseText('修复后运行 `go test ./... -run TestProbe -count=1`，RecordProbe 和 EvidenceClosed 必须按 target 校验证据。', 'success_criteria', 'sample-task'),
    '修复后运行 `go test ./... -run TestProbe -count=1`，RecordProbe 和 EvidenceClosed 必须按 target 校验证据。',
  );
  const curlQuery = '分批上报清洗循环后错误通过，请排查跨请求校验。\n\n公开复现命令：curl -i -X POST http://localhost:8080/v1/clearances/TASK_ID/cleaning-cycles -H \'Content-Type: application/json\' --data \'{"operation_id":"clean-cycle-2","expected_version":12,"cells":[{"segment_id":"A","parameter":"flow_rate_ml_per_min","value":100}]}\'';
  assert.equal(requireChineseText(curlQuery, 'user_query', 'sample-task'), curlQuery);
});

test('Gold root cause builder rejects code prose that becomes English after Markdown removal', () => {
  assert.throws(
    () => buildGoldRootCause({
      target_files: ['store/schema.go'],
      symbols: ['schemaDDL'],
      failure_mechanism: "注入时把 `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seed_lot_open ON tasks(seed_lot) WHERE status NOT IN ('released','cancelled')` 改成普通唯一索引，旧终态记录因此持续占用批号，最终导致新任务创建失败。",
    }),
    /gold_root_cause 必须以中文为主体/,
  );
});

test('success criteria export requires Chinese acceptance prose', () => {
  assert.equal(requireChineseText('目标行为已修复，定向测试与全量测试均通过。', 'success_criteria', 'sample-task'), '目标行为已修复，定向测试与全量测试均通过。');
  assert.throws(() => requireChineseText('Target behavior is fixed and the focused test passes.', 'success_criteria', 'sample-task'), /success_criteria 必须以中文为主体/);
  assert.throws(() => requireNonEmptyText('   ', 'success_criteria', 'sample-task'), /success_criteria 不能为空/);
});

test('Excel root cause restores legacy fixed headings to a natural causal paragraph', () => {
  const fixed = '问题文件：api/service_terminal.go、store/store.go；问题符号：api.Service.recordTerminalRejection、store.Store.WithTx；失效机制：内部原因是事务回调写入拒绝记录后返回领域错误；传播过程是 Store.WithTx 对任何错误执行回滚；最终导致 HTTP 返回 410 但拒绝记录没有持久化。';
  assert.equal(
    naturalizeGoldRootCause(fixed),
    'api/service_terminal.go、store/store.go 中的 api.Service.recordTerminalRejection、store.Store.WithTx 根本原因是事务回调写入拒绝记录后返回领域错误；Store.WithTx 对任何错误执行回滚，最终导致HTTP 返回 410 但拒绝记录没有持久化。',
  );
  assert.equal(
    naturalizeGoldRootCause('问题文件：domain/lock.go；问题符号：domain.ExpandInterval；失效机制：未检查纳秒字段，导致重叠锁被接受。'),
    'domain/lock.go 中的 domain.ExpandInterval 根本原因是未检查纳秒字段，导致重叠锁被接受。',
  );
});

test('Excel root cause rejects a code summary without an explicit symptom causality chain', () => {
  const incomplete = 'internal/qc/qc.go、internal/sequencing/flow.go 中的 SubmitSplit 根本原因是该路径只检查当前状态、操作号和拆分序号，然后写入 splits；最后一个序号会把批次推进到 SPLIT_QC。';
  assert.throws(
    () => requireChineseGoldRootCause(incomplete, 'sample-task'),
    /必须说明完整失效机制.*为什么导致题面症状/,
  );
});

test('Docker export evidence must explicitly list both platforms and grader stages', () => {
  assert.equal(requireDockerVerifyCmds(dockerVerifyCmd, 'bugfix', 'sample-task'), dockerVerifyCmd);
  assert.equal(requireDockerVerifyCmds(packagedDockerVerifyCmd, 'diagnosis', 'sample-task'), packagedDockerVerifyCmd);
  const withoutStatic = dockerVerifyCmd.split('\n').filter((line) => !/go vet/.test(line)).join('\n');
  assert.equal(requireDockerVerifyCmds(withoutStatic, 'bugfix', 'sample-task'), withoutStatic);
  assert.equal(requireDockerHarness(dockerHarness, 'sample-task'), dockerHarness);
  assert.throws(
    () => requireDockerVerifyCmds('./grader/run_docker.sh workspace bugfix', 'bugfix', 'sample-task'),
    /不能只填写 run_docker\.sh 封装命令/,
  );
  assert.throws(
    () => requireDockerVerifyCmds(dockerVerifyCmd.replace('./...', 'undefined'), 'bugfix', 'sample-task'),
    /完整单词 undefined/,
  );
  assert.throws(
    () => requireDockerHarness('backend=local-target; platform=linux/arm64,linux/amd64;', 'sample-task'),
    /不能使用 local-target/,
  );
  assert.throws(
    () => requireDockerHarness('backend=docker-target; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI;', 'sample-task'),
    /target_cli_version/,
  );
});

test('diagnosis export accepts one direct public reproduction command', () => {
  const command = 'go test ./internal/dispatch -run TestManualReviewReadDoesNotExposeBufferedEntry -count=1 -v';
  assert.equal(requireDockerVerifyCmds(command, 'diagnosis', 'sample-diagnosis'), command);
  assert.equal(requireDockerVerifyCmds(command, 'bugfix', 'sample-bugfix'), command);
  assert.throws(
    () => requireDockerVerifyCmds('go test ./... | tail -20', 'diagnosis', 'sample-diagnosis'),
    /只读直接命令|不能写文件|必须是可直接执行/,
  );
});

test('V5 Excel export preserves every direct verify command in order', () => {
  const commands = [
    "go test ./internal/sample -run '^TestRegression$' -count=1 -v",
    'go test ./... -count=1',
    'go vet ./...',
  ];
  assert.equal(requireDirectPublicVerifyCmd(commands, 'bugfix', 'sample-task'), commands.join('\n'));
  assert.equal(
    requireDirectPublicVerifyCmd(
      ["go test -race ./internal/sample -run '^TestRegression$' -count=20 -v"],
      'bugfix',
      'sample-concurrency-task',
      { concurrency: true },
    ),
    "go test -race ./internal/sample -run '^TestRegression$' -count=20 -v",
  );
  assert.throws(
    () => requireDirectPublicVerifyCmd(
      ["go test ./internal/sample -run '^TestRegression$' -count=1 -v"],
      'bugfix',
      'sample-concurrency-task',
      { concurrency: true },
    ),
    /-race/,
  );
});

test('trajectory export requires an HTTPS cloud link', () => {
  const url = 'https://upload.example.com/trajectory_sample-task.json?download=1';
  const jsonlUrl = 'https://upload.example.com/trajectory_sample-task.jsonl?download=1';
  assert.equal(isCloudTrajectoryUrl(url), true);
  assert.equal(isCloudTrajectoryFileUrl(url), true);
  assert.equal(isCloudTrajectoryFileUrl(jsonlUrl), true);
  assert.equal(requireCloudTrajectoryUrl(url, 'sample-task'), url);
  assert.equal(requireCloudTrajectoryUrl(jsonlUrl, 'sample-task'), jsonlUrl);
  assert.throws(
    () => requireCloudTrajectoryUrl('完整原始 JSON trajectory 正文见 trajectory_chunks 工作表。', 'sample-task'),
    /缺少已上传的 trajectory 云盘链接/,
  );
});

test('Excel export requires toolchain and go.mod versions in go_version', () => {
  const value = 'go1.25.6; go.mod go 1.23';
  assert.equal(requirePinnedGoVersion(value, 'sample-task'), value);
  assert.throws(() => requirePinnedGoVersion('go1.25.6; go.mod go 未声明', 'sample-task'), /已取消 Excel 导出/);
});

test('Excel export removes a duplicated go.mod version', () => {
  const sha = 'a'.repeat(40);
  const row = prepareExcelRecord({
    ...v5ExportFields,
    bug_id: 'sample-task',
    task_type: 'bugfix',
    go_version: 'go1.25.6; go.mod go 1.23; go.mod go 1.23',
    go_mod_version: '1.23',
    trajectory: 'https://upload.example.com/trajectory_sample-task.json',
    repo_url: 'https://git.example.com/team/task/tree/bug1_green',
    user_query: '请修复空输入触发的异常，并补充回归测试。',
    verify_cmds: directVerifyCmd,
    gold_root_cause: 'sample.go 的 sample.Run 未检查空输入，导致 panic。',
    gold_patch: `https://git.example.com/team/task/commit/${sha}`,
    success_criteria: '空输入不再触发异常，目标测试、全量测试和静态检查均通过。',
    harness: dockerHarness,
  });
  assert.equal(row.go_version, 'go1.25.6; go.mod go 1.23');
});

test('Excel export writes bug_category using the annotation labels', () => {
  const sha = 'a'.repeat(40);
  const row = prepareExcelRecord({
    ...v5ExportFields,
    bug_id: 'sample-category',
    task_type: 'bugfix',
    bug_category: 'concurrency',
    go_version: 'go1.25.6; go.mod go 1.23',
    go_mod_version: '1.23',
    trajectory: 'https://upload.example.com/trajectory_sample-category.jsonl',
    repo_url: 'https://git.example.com/team/task/tree/bug1_green',
    user_query: '请修复并发访问导致的异常，并补充回归测试。',
    verify_cmds: "go test -race ./internal/sample -run '^TestRegression$' -count=20 -v",
    gold_root_cause: 'sample.go 的 run 存在并发访问错误，导致状态不一致。',
    gold_patch: `https://git.example.com/team/task/commit/${sha}`,
    success_criteria: '目标行为已修复，定向测试和全量测试均通过，且不得通过规避方式通过验收。',
    harness: dockerHarness,
  });
  assert.equal(row.bug_category, 'concurrency并发问题');

  const legacyRow = prepareExcelRecord({
    ...v5ExportFields,
    bug_id: 'sample-category-legacy',
    task_type: 'bugfix',
    bug_category: 'slice相关问题',
    go_version: 'go1.25.6; go.mod go 1.23',
    go_mod_version: '1.23',
    trajectory: 'https://upload.example.com/trajectory_sample-category-legacy.jsonl',
    repo_url: 'https://git.example.com/team/task/tree/bug1_green',
    user_query: '请修复切片处理错误，并补充回归测试。',
    verify_cmds: directVerifyCmd,
    gold_root_cause: 'sample.go 的 run 错误复用了切片底层数组，导致数据污染。',
    gold_patch: `https://git.example.com/team/task/commit/${sha}`,
    success_criteria: '切片数据不再被错误修改，目标测试、全量测试和静态检查均通过。',
    harness: dockerHarness,
  });
  assert.equal(legacyRow.bug_category, 'slice相关问题');
});

test('Excel export requires a test-model branch URL and a gold commit URL', () => {
  const sha = 'a'.repeat(40);
  const url = `https://git.example.com/team/task/commit/${sha}`;
  assert.equal(isGitCommitUrl(url), true);
  const branchUrl = 'https://git.example.com/team/task/tree/bug2_red';
  assert.equal(isGitTestModelBranchUrl(branchUrl), true);
  assert.equal(requireGitTestModelBranchUrl(branchUrl, 'sample-task', 'diagnosis'), branchUrl);
  const greenBranchUrl = 'https://git.example.com/team/task/tree/bug2_green';
  assert.equal(isGitTestModelBranchUrl(greenBranchUrl), true);
  assert.equal(requireGitTestModelBranchUrl(greenBranchUrl, 'sample-task', 'bugfix'), greenBranchUrl);
  assert.equal(isGitTestModelBranchUrl('https://git.example.com/team/task/tree/bug2/green2', 'green'), true);
  assert.equal(isGitTestModelBranchUrl('https://git.example.com/team/task/tree/red', 'red'), true);
  const legacyBranchUrl = 'https://git.example.com/team/task/tree/bug-02/test_model_fix';
  assert.equal(isGitTestModelBranchUrl(legacyBranchUrl), false);
  assert.throws(() => requireGitTestModelBranchUrl(legacyBranchUrl, 'sample-task', 'bugfix'), /无法识别红绿角色/);
  assert.throws(() => requireGitTestModelBranchUrl(greenBranchUrl, 'sample-task', 'diagnosis'), /显式 red/);
  assert.throws(() => requireGitTestModelBranchUrl(url, 'sample-task'), /red\/green/);
  assert.throws(() => requireGitCommitUrl(sha, 'gold_patch', 'sample-task'), /完整 HTTPS Git commit 地址/);
});

test('Excel export canonicalizes historical diagnosis MODEL_REPRO commands', () => {
  const row = prepareExcelRecord({
    ...v5ExportFields,
    bug_id: 'sample-diagnosis-history',
    task_type: 'diagnosis',
    go_version: 'go1.25.6; go.mod go 1.23',
    go_mod_version: '1.23',
    trajectory: 'https://upload.example.com/trajectory_sample-diagnosis-history.jsonl',
    repo_url: 'https://git.example.com/team/task/tree/bug1_red',
    user_query: '请排查重复读取导致的异常，并给出根因证据。',
    verify_cmds: "MODEL_REPRO=1 go test ./internal/sample -run '^TestRegression$' -count=1 -v",
    verify_result: {
      pre_fix: verifyResult.pre_fix,
    },
    gold_root_cause: 'sample.go 的 read 重复读取时错误删除了结果，导致后续请求失败。',
    gold_patch: `https://git.example.com/team/task/commit/${'a'.repeat(40)}`,
    success_criteria: '稳定复现问题并准确定位根因，诊断过程不修改工作区。',
    harness: dockerHarness,
  });
  assert.equal(row.verify_cmds, directVerifyCmd);
});

test('verify result removes only the leading PASS marker and punctuation', () => {
  assert.equal(stripVerifyPassPrefix('PASS；问题情况：目标测试通过。'), '问题情况：目标测试通过。');
  assert.equal(stripVerifyPassPrefix('  PASS: 诊断结论与源码一致。'), '诊断结论与源码一致。');
  assert.equal(stripVerifyPassPrefix('验证结论：通过。'), '验证结论：通过。');
});

test('prepared Excel row keeps Chinese root cause and excludes blocked harness fields', () => {
  const row = prepareExcelRecord({
    ...v5ExportFields,
    bug_id: 'sample-task',
    task_type: 'bugfix',
    go_version: 'go1.25.6; go.mod go 1.23',
    trajectory: 'https://upload.example.com/trajectory_sample-task.json',
    repo_url: 'https://git.example.com/team/task/tree/bug1_green',
    user_query: '请修复空输入触发的异常，并补充回归测试。',
    verify_cmds: directVerifyCmd,
    gold_root_cause: '`sample.go` 的 `run` 在空输入时错误访问索引并触发 panic。',
    gold_patch: `https://git.example.com/team/task/commit/${'b'.repeat(40)}`,
    success_criteria: '空输入不再触发异常，目标测试、全量测试和静态检查均通过。',
    harness: 'backend=docker-target; trajectory_events=120; api_retry=0; permission_denial=0; workspace_policy=patched; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code);',
    environment_zip: '',
    创建人: 'should-not-be-exported',
  });
  const sheet = XLSX.utils.json_to_sheet([row]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '智能表1');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const reopened = XLSX.read(bytes, { type: 'buffer' });
  const [exported] = XLSX.utils.sheet_to_json(reopened.Sheets['智能表1']);
  const [headers] = XLSX.utils.sheet_to_json(reopened.Sheets['智能表1'], { header: 1 });

  assert.deepEqual(headers, EXCEL_EXPORT_FIELDS);
  assert.deepEqual(Object.keys(row), EXCEL_EXPORT_FIELDS);
  assert.equal(exported.gold_root_cause, 'sample.go 的 run 在空输入时错误访问索引并触发 panic。');
  assert.equal(exported.trajectory, 'https://upload.example.com/trajectory_sample-task.json');
  assert.equal(exported.repo_url, row.repo_url);
  assert.equal('gold_patch' in exported, false);
  assert.equal('gold_patch' in row, false);
  assert.equal(exported.verify_result, JSON.stringify(verifyResult));
  assert.equal(exported.harness, 'backend=docker-target; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code);');
  assert.equal('environment_zip' in exported, false);
  assert.equal('状态' in exported, false);
  assert.equal('问题' in exported, false);
  assert.equal('创建人' in exported, false);
});

test('V5 Excel export serializes independent red and green proof trajectories', () => {
  const row = prepareExcelRecord({
    'session  id': mainSession,
    verification_policy_version: 5,
    bug_id: 'sample-v5-task',
    task_type: 'bugfix',
    go_version: 'go1.25.6; go.mod go 1.23',
    trajectory: `https://upload.example.com/trajectory_${mainSession}.jsonl`,
    repo_url: 'https://git.example.com/team/task/tree/bug1_green',
    user_query: '请修复空输入触发的异常，并补充回归测试。',
    verify_cmds: directVerifyCmd,
    gold_root_cause: 'sample.go 的 run 在空输入时错误访问索引并触发 panic。',
    gold_patch: `https://git.example.com/team/task/commit/${'c'.repeat(40)}`,
    success_criteria: '空输入不再触发异常，目标测试、全量测试和静态检查均通过。',
    verify_result: verifyResult,
    harness: 'backend=docker-target; platform=linux/arm64,linux/amd64; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code);',
  });
  assert.equal(row.verify_result, JSON.stringify(verifyResult));
});

test('Excel export rejects pre-V5 tasks without independently verifiable proofs', () => {
  assert.throws(() => requireVerificationPolicyV5(4, 'legacy-task'), /legacy-task[\s\S]*旧任务没有可核验的独立红绿证明/);
});
