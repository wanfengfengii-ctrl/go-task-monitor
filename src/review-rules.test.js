import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateIdentityConflicts,
  assertQualifiedIdentitiesUnique,
  assertQualifiedTasksPassHardRules,
  getGoVersionRuleIssues,
  getHardRuleIssues,
  getGitPreparationRuleIssues,
  getGitWorkflowRuleIssues,
  getApplicableGitRuleIssues,
  getProductionFlowRuleIssues,
  isManagedGitWorkflow,
  isManagedGitPreparation,
  isManagedProductionTask,
  normalizeDiagnosisGitMetadata,
  resolvePinnedGoVersion,
} from './review-rules.js';

test('go_version requires a patch-level toolchain and go.mod language version', () => {
  assert.deepEqual(getGoVersionRuleIssues('go1.25.6; go.mod go 1.23', { hasGoMod: true }), []);
  assert.match(getGoVersionRuleIssues('go1.25.6; go.mod go 未声明', { hasGoMod: true })[0], /必须同时固定/);
  assert.match(getGoVersionRuleIssues('go1.25; go.mod go 1.23', { hasGoMod: true })[0], /工具链补丁版本/);
  assert.match(getGoVersionRuleIssues('go1.25.6; go.mod go pre-modules', { hasGoMod: false })[0], /必须包含 go\.mod/);
});

test('diagnosis workspace policy requires an explicit zero-mutation result', () => {
  assert.match(getHardRuleIssues({
    task_type: 'diagnosis',
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: false,
  }).join(';'), /工作区零修改校验/);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: true,
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    diagnosis_workspace_policy_version: 1,
    diagnosis_workspace_unchanged: false,
    diagnosis_workspace_check_status: 'pending',
  }), []);
});

test('go_version resolution emits one canonical toolchain and go.mod pair', () => {
  assert.equal(resolvePinnedGoVersion('go1.25.6; go.mod go 1.23', '1.23'), 'go1.25.6; go.mod go 1.23');
  assert.equal(resolvePinnedGoVersion('go1.25.6; go.mod go 1.23; go.mod go 1.23', '1.23'), 'go1.25.6; go.mod go 1.23');
  assert.equal(resolvePinnedGoVersion('go1.25.6', '1.23'), 'go1.25.6; go.mod go 1.23');
  assert.equal(resolvePinnedGoVersion('go1.25.6; go.mod go 1.24', '1.23'), 'go1.25.6; go.mod go 1.24');
});

test('identity conflicts annotate duplicate session IDs and bug IDs independently', () => {
  const tasks = annotateIdentityConflicts([
    { id: 'one', sessionId: 'session-a', bug_id: 'bug-a', task_type: 'bugfix' },
    { id: 'two', sessionId: 'session-b', bug_id: 'bug-a', task_type: 'bugfix' },
    { id: 'three', sessionId: 'session-b', bug_id: 'bug-c', task_type: 'diagnosis' },
  ]);
  assert.deepEqual(tasks.map((task) => task.duplicateFields), [
    ['bug_id'],
    ['sessionId', 'bug_id'],
    ['sessionId'],
  ]);
  assert.equal(tasks[0].workflowConflict, '');
});

test('production flow requires one generated project, one discovered bug, and one trajectory', () => {
  assert.deepEqual(getProductionFlowRuleIssues({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'codex_cli',
    project_generation_provider: 'codex',
    project_generation_session_id: 'generation-session-a',
    bug_discovery_stage: 'in_generated_main_before_trajectory',
    bug_discovery_author: 'codex',
    bug_discovery_id: 'discovery-a',
    bug_index: 1,
    trajectory_count: 1,
    task_type: 'bugfix',
  }), []);
  assert.match(getProductionFlowRuleIssues({
    production_flow: 'repository_search',
    project_origin: 'github',
    bug_discovery_stage: 'unknown',
    bug_index: 6,
    trajectory_count: 2,
    task_type: 'diagnosis',
  }).join(';'), /generated_0to1|trajectory_count/);
  assert.match(getProductionFlowRuleIssues({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'claude_code_cli',
    project_generation_session_id: 'generation-session-a',
    bug_discovery_stage: 'in_generated_main_before_trajectory',
    bug_discovery_author: 'codex',
    bug_index: 1,
    bug_id: 'bug-a',
    trajectory_count: 1,
    task_type: 'bugfix',
  }).join(';'), /bug_discovery_id/);
});

test('legacy repository tasks are not eligible for the new production queue', () => {
  assert.equal(isManagedProductionTask({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'claude_code_cli',
    project_generation_session_id: 'generation-session-a',
    bug_discovery_stage: 'in_generated_main_before_trajectory',
    bug_discovery_author: 'codex',
    bug_discovery_id: 'discovery-a',
    bug_index: 1,
    trajectory_count: 1,
    task_type: 'diagnosis',
  }), true);
  assert.equal(isManagedProductionTask({ repository: 'https://github.com/example/project', task_type: 'bugfix' }), false);
  assert.equal(isManagedProductionTask({ production_flow: 'repository_search', project_origin: 'github' }), false);
});

test('historical recovered tasks without internal Git metadata do not receive V2 Git errors', () => {
  assert.deepEqual(getApplicableGitRuleIssues({
    bug_id: 'recovered-bug',
    task_type: 'bugfix',
    recovered_from_export: true,
  }, { hasTrajectory: true }), []);
});

test('git delivery requires BUG_BASE and parallel model-fix commit links', () => {
  const base = 'a'.repeat(40);
  const testFix = 'b'.repeat(40);
  const goldFix = 'c'.repeat(40);
  const record = {
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/task',
    bug_index: 2,
    main_branch: 'main',
    main_commit: base,
    main_pushed: true,
    bug_main_branch: 'bug2_main',
    bug_main_commit: base,
    bug_main_pushed: true,
    bug_main_unchanged: true,
    bug_base_branch: 'BUG_BASE2',
    bug_base_commit: base,
    bug_base_pushed: true,
    main_unchanged: true,
    test_model_fix_branch: 'bug-02/test_model_fix',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: base,
    test_model_fix_commit: testFix,
    test_model_fix_pushed: true,
    gold_model_fix_branch: 'bug-02/gold_model_fix',
    gold_model_fix_actor: 'codex',
    gold_model_fix_base_commit: base,
    gold_model_fix_commit: goldFix,
    gold_model_fix_pushed: true,
    repo_url: 'https://git.example.com/team/task/tree/bug-02/test_model_fix',
    gold_patch: `https://git.example.com/team/task/commit/${goldFix}`,
  };
  assert.deepEqual(getGitWorkflowRuleIssues(record), []);
  assert.deepEqual(getGitPreparationRuleIssues({ ...record, test_model_fix_commit: undefined, test_model_fix_pushed: undefined, repo_url: undefined }), []);
  assert.equal(isManagedGitPreparation({ ...record, test_model_fix_commit: undefined, test_model_fix_pushed: undefined, repo_url: undefined }), true);
  assert.equal(isManagedGitWorkflow(record), true);
  assert.match(getGitWorkflowRuleIssues({ ...record, main_unchanged: false }).join(';'), /main_unchanged/);
  assert.match(getGitWorkflowRuleIssues({ ...record, bug_base_commit: 'd'.repeat(40) }).join(';'), /自然 Bug 的 bug_base_commit/);
  assert.match(getGitWorkflowRuleIssues({ ...record, test_model_fix_branch: 'bug-01/test_model_fix' }).join(';'), /bug-02\/test_model_fix/);
  assert.match(getGitWorkflowRuleIssues({ ...record, repo_url: 'https://other.example.com/team/task/tree/bug-02/test_model_fix' }).join(';'), /当前 repository/);
  assert.deepEqual(getGitWorkflowRuleIssues({ ...record, task_type: 'diagnosis', test_model_fix_commit: base }), []);
  assert.match(getGitWorkflowRuleIssues({ ...record, task_type: 'diagnosis', test_model_fix_commit: testFix }).join(';'), /必须等于 bug_base_commit/);
  assert.match(getGitWorkflowRuleIssues({ ...record, task_type: 'bugfix', test_model_fix_commit: base }).join(';'), /必须产生修复提交/);
  assert.equal(isManagedGitWorkflow({ repository: 'https://github.com/example/task' }), false);
});

test('V2 permits natural or independent injected BUG_BASE commits before Git publication', () => {
  const main = 'a'.repeat(40);
  const injected = 'b'.repeat(40);
  const gold = 'c'.repeat(40);
  const common = {
    workflow_version: 2,
    production_flow: 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_dual_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'claude_code_cli',
    project_generation_session_id: 'generation-session-v2',
    bug_discovery_stage: 'before_git_main_publish',
    bug_discovery_author: 'codex',
    bug_discovery_id: 'selection-v2',
    bug_source_private_to_pipeline: true,
    test_model_git_metadata_available: false,
    test_model_repository_identity_available: false,
    bug_index: 1,
    trajectory_count: 1,
    task_type: 'bugfix',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/v2-project',
    main_branch: 'main',
    main_commit: main,
    main_pushed: true,
    bug_main_branch: 'bug1_main',
    bug_main_commit: main,
    bug_main_pushed: true,
    bug_main_unchanged: true,
    bug_base_branch: 'BUG_BASE1',
    bug_base_pushed: true,
    main_unchanged: true,
    test_model_fix_branch: 'bug-01/test_model_fix',
    test_model_fix_actor: 'claude_code_cli',
    gold_model_fix_branch: 'bug-01/gold_model_fix',
    gold_model_fix_actor: 'codex',
    gold_model_fix_commit: gold,
    gold_model_fix_pushed: true,
    gold_patch: `https://git.example.com/team/v2-project/commit/${gold}`,
  };
  const natural = {
    ...common,
    bug_source: 'natural',
    bug_base_commit: main,
    test_model_fix_base_commit: main,
    gold_model_fix_base_commit: main,
  };
  assert.deepEqual(getProductionFlowRuleIssues(natural), []);
  assert.deepEqual(getGitPreparationRuleIssues(natural), []);

  const prepared = {
    ...common,
    bug_source: 'injected',
    bug_base_commit: injected,
    bug_base_parent_commit: main,
    test_model_fix_base_commit: injected,
    gold_model_fix_base_commit: injected,
  };
  assert.deepEqual(getProductionFlowRuleIssues(prepared), []);
  assert.deepEqual(getGitPreparationRuleIssues(prepared), []);
  assert.match(getGitPreparationRuleIssues({ ...prepared, bug_base_parent_commit: 'd'.repeat(40) }).join(';'), /直接子提交/);
});

test('V3 accepts Claude-only Git delivery without Gold metadata', () => {
  const base = 'a'.repeat(40);
  const fix = 'b'.repeat(40);
  const record = {
    workflow_version: 3,
    workflow_policy_version: 4,
    verification_policy_version: 5,
    production_flow: 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix',
    project_origin: 'generated_0to1',
    project_prompt_author: 'codex',
    project_generator: 'claude_code_cli',
    project_generation_session_id: 'generation-session-v3',
    bug_discovery_stage: 'before_git_main_publish',
    bug_discovery_author: 'codex',
    bug_discovery_id: 'selection-v3',
    bug_source: 'natural',
    bug_source_private_to_pipeline: true,
    test_model_git_metadata_available: false,
    test_model_repository_identity_available: false,
    bug_index: 1,
    trajectory_count: 1,
    task_type: 'bugfix',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/v3-project',
    main_branch: 'main',
    main_commit: base,
    main_pushed: true,
    bug_base_branch: 'bug1_green',
    bug_base_commit: base,
    bug_base_root: true,
    bug_base_source_commit: base,
    green_branch: 'bug1_green',
    green_baseline_commit: base,
    green_baseline_pushed: true,
    red_branch: 'bug1_red',
    red_commit: 'c'.repeat(40),
    red_pushed: true,
    model_input_branch: 'bug1_green',
    model_input_commit: base,
    model_input_snapshot: 'single-branch-single-commit-no-tests',
    bug_base_pushed: true,
    main_unchanged: true,
    test_model_fix_branch: 'bug1_green',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: base,
    test_model_fix_commit: fix,
    test_model_fix_pushed: true,
    repo_url: 'https://git.example.com/team/v3-project/tree/bug1_green',
  };
  assert.deepEqual(getProductionFlowRuleIssues(record), []);
  assert.deepEqual(getGitWorkflowRuleIssues(record), []);
  assert.equal('gold_model_fix_commit' in record, false);
  assert.equal('gold_patch' in record, false);
  assert.match(getGitPreparationRuleIssues({ ...record, green_branch: undefined }).join(';'), /green_branch/);
  assert.match(getGitWorkflowRuleIssues({ ...record, red_commit: undefined }).join(';'), /red_commit/);
  assert.match(getGitWorkflowRuleIssues({ ...record, red_pushed: false }).join(';'), /red_pushed/);

  const diagnosisRed = 'd'.repeat(40);
  const diagnosis = {
    ...record,
    task_type: 'diagnosis',
    bug_base_branch: '',
    bug_base_commit: diagnosisRed,
    bug_base_pushed: false,
    green_branch: '',
    green_baseline_commit: '',
    green_baseline_pushed: false,
    red_branch: 'bug1_red',
    red_commit: diagnosisRed,
    red_pushed: true,
    model_input_branch: '',
    model_input_commit: '',
    test_model_fix_branch: 'bug1_red',
    test_model_fix_base_commit: diagnosisRed,
    test_model_fix_commit: diagnosisRed,
    repo_url: 'https://git.example.com/team/v3-project/tree/bug1_red',
  };
  assert.deepEqual(getGitWorkflowRuleIssues(diagnosis), []);
  assert.match(getGitWorkflowRuleIssues({ ...diagnosis, green_branch: 'bug1_green' }).join(';'), /不得创建 green 分支/);

  const staleRetryMetadata = {
    ...diagnosis,
    bug_base_commit: base,
    test_model_fix_base_commit: base,
    test_model_fix_commit: null,
    test_model_fix_pushed: null,
    repo_url: null,
  };
  const normalized = normalizeDiagnosisGitMetadata(staleRetryMetadata);
  assert.equal(normalized.bug_base_commit, diagnosisRed);
  assert.equal(normalized.test_model_fix_base_commit, diagnosisRed);
  assert.equal(normalized.test_model_fix_commit, diagnosisRed);
  assert.equal(normalized.test_model_fix_pushed, true);
  assert.equal(normalized.repo_url, 'https://git.example.com/team/v3-project/tree/bug1_red');
  assert.deepEqual(getGitWorkflowRuleIssues(staleRetryMetadata), []);
  assert.notEqual(normalizeDiagnosisGitMetadata({ ...staleRetryMetadata, red_pushed: false }).test_model_fix_commit, diagnosisRed);
});

test('historical V3 Git records retain the numbered BUG_BASE delivery layout', () => {
  const base = 'a'.repeat(40);
  const record = {
    workflow_version: 3,
    production_flow: 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix',
    git_flow: 'main_numbered_bug_bases_parallel_model_fixes',
    repository: 'https://git.example.com/team/v3-legacy-project',
    bug_index: 1,
    task_type: 'diagnosis',
    bug_source: 'natural',
    main_branch: 'main',
    main_commit: base,
    main_pushed: true,
    bug_main_branch: 'bug1_main',
    bug_main_commit: base,
    bug_main_pushed: true,
    bug_main_unchanged: true,
    bug_base_branch: 'BUG_BASE1',
    bug_base_commit: base,
    bug_base_pushed: true,
    main_unchanged: true,
    test_model_fix_branch: 'bug-01/test_model_fix',
    test_model_fix_actor: 'claude_code_cli',
    test_model_fix_base_commit: base,
    test_model_fix_commit: base,
    test_model_fix_pushed: true,
    repo_url: 'https://git.example.com/team/v3-legacy-project/tree/bug-01/test_model_fix',
  };
  assert.deepEqual(getGitPreparationRuleIssues(record), []);
  assert.deepEqual(getGitWorkflowRuleIssues(record), []);
});

test('identity annotation records mixed task types for the same bug', () => {
  const tasks = annotateIdentityConflicts([
    { id: 'one', sessionId: 'session-a', bug_id: 'bug-a', task_type: 'bugfix' },
    { id: 'two', sessionId: 'session-b', bug_id: 'bug-a', task_type: 'diagnosis' },
  ]);
  assert.match(tasks[0].workflowConflict, /bugfix \/ diagnosis/);
  assert.match(tasks[1].workflowConflict, /只允许一种 task_type/);
});

test('standard generated projects permit ten numbered bugs and reject an eleventh', () => {
  const ten = annotateIdentityConflicts(Array.from({ length: 10 }, (_, index) => ({
    id: `task-${index + 1}`,
    bug_id: `bug-${index + 1}`,
    bug_index: index + 1,
    task_type: 'bugfix',
    project_origin: 'generated_0to1',
    main_commit: 'a'.repeat(40),
    project_generation_session_id: 'project-session-a',
    project_quality_policy_version: 2,
    project_tier: 'standard',
    repository: 'https://git.example.com/team/project',
  })));
  assert.ok(ten.every((task) => task.workflowConflict === ''));

  const eleven = annotateIdentityConflicts([...ten, {
    id: 'task-11',
    bug_id: 'bug-11',
    bug_index: 1,
    task_type: 'diagnosis',
    project_origin: 'generated_0to1',
    main_commit: 'a'.repeat(40),
    project_generation_session_id: 'project-session-a',
    project_quality_policy_version: 2,
    project_tier: 'standard',
    repository: 'https://git.example.com/team/project.git',
  }]);
  assert.ok(eleven.every((task) => /最多只能对应 10 个 bug/.test(task.workflowConflict)));
  assert.match(eleven[0].workflowConflict, /bug_index 1 重复/);
  assert.match(eleven[10].workflowConflict, /编号分支会互相覆盖/);
});

test('large generated projects permit thirty numbered bugs', () => {
  const tasks = annotateIdentityConflicts(Array.from({ length: 30 }, (_, index) => ({
    id: `large-${index + 1}`,
    bug_id: `large-bug-${index + 1}`,
    bug_index: index + 1,
    task_type: 'bugfix',
    project_origin: 'generated_0to1',
    main_commit: 'b'.repeat(40),
    project_generation_session_id: 'project-session-large',
    project_quality_policy_version: 2,
    project_tier: 'large',
    repository: 'https://git.example.com/team/large-project',
  })));
  assert.ok(tasks.every((task) => task.workflowConflict === ''));
});

test('bugs in one generated repository share the project commit and generation session', () => {
  const tasks = annotateIdentityConflicts([
    { id: 'one', bug_id: 'bug-a', bug_index: 1, task_type: 'bugfix', project_origin: 'generated_0to1', repository: 'https://git.example.com/team/project', main_commit: 'a'.repeat(40), project_generation_session_id: 'generation-a' },
    { id: 'two', bug_id: 'bug-b', bug_index: 2, task_type: 'diagnosis', project_origin: 'generated_0to1', repository: 'https://git.example.com/team/project', main_commit: 'b'.repeat(40), project_generation_session_id: 'generation-b' },
  ]);
  assert.ok(tasks.every((task) => /main_commit 不一致/.test(task.workflowConflict)));
  assert.ok(tasks.every((task) => /project_generation_session_id 不一致/.test(task.workflowConflict)));
});

test('qualified tasks require globally unique identities', () => {
  const tasks = [
    { id: 'one', sessionId: 'session-a', bug_id: 'bug-a' },
    { id: 'two', sessionId: 'session-b', bug_id: 'bug-a' },
  ];
  assert.doesNotThrow(() => assertQualifiedIdentitiesUnique(tasks, new Set(['one'])));
  assert.throws(() => assertQualifiedIdentitiesUnique(tasks, new Set(['one', 'two'])), /bug_id 不能重复/);
});

test('qualified tasks require a session ID', () => {
  const tasks = [{ id: 'one', sessionId: null, bug_id: 'bug-a' }];
  assert.throws(() => assertQualifiedIdentitiesUnique(tasks, new Set(['one'])), /尚未生成 session-id/);
});

test('root cause requires a Go filename, symbol, and failure mechanism', () => {
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    gold_root_cause: '旧实现只写入时间戳，导致同毫秒顺序随机。',
  }), [
    'gold_root_cause 必须包含 Gold 结构化记录中的具体文件名',
    'gold_root_cause 必须包含 Gold 结构化记录中的具体函数、方法或类型符号',
  ]);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    gold_root_cause: 'version7.go 的 makeV7 没有维护同毫秒序列，导致后生成 UUID 可能更小。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    target_files: ['cmd/service/main.go'],
    symbols: ['main'],
    failure_mechanism: '错误忽略启动参数',
    gold_root_cause: 'main.go 的 main 没有检查启动参数，导致服务进入错误模式。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    gold_root_cause: 'commands.go 中 Coordinator.handleAlert 未校验角色，造成未授权工单创建。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    gold_root_cause: 'gc.go 中的 (*Tx).SweepCandidate 未比较全局最小摘要，最终提前结束回收轮次。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    gold_root_cause: 'service.go 中的 Store.Save 只校验资源编号，没有检查当前代次；错误请求随后写入任务状态，所以公开接口错误返回处理成功。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    gold_root_cause: '问题文件：domain/lock.go；问题符号：domain.ExpandInterval；失效机制：未检查纳秒字段，导致重叠锁被接受。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    gold_root_cause: 'store/schema.go 中的 schema rejudgements table 根本原因是把 PRIMARY KEY (task_id, generation) 改为 PRIMARY KEY (task_id, reason)，使后续代次的同类复判命中历史 reason 约束，最终导致新复判返回 rejudgement_exists。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'diagnosis',
    target_files: ['internal/qc/qc.go'],
    symbols: ['SubmitSplit'],
    gold_root_cause: 'internal/qc/qc.go 中的 SubmitSplit 只检查当前状态和拆分序号，然后写入 splits；最后一个序号会把批次推进到 SPLIT_QC。',
  }), [
    'gold_root_cause 必须说明完整失效机制：先写具体实现缺陷和错误操作，再说明其传播后为什么导致题面症状',
  ]);
});

test('bugfix verification requires explicit before and after results', () => {
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    verify_result: 'PASS；问题情况：超长名称被接受。解决情况：目标测试通过。',
  }), ['bugfix 的 verify_result 必须同时写清修复前失败和修复后成功；修复前失败只需定性描述，不要求次数']);
  assert.deepEqual(getHardRuleIssues({
    task_type: 'bugfix',
    verify_result: 'PASS；修复前：超长名称被接受。修复后：超长名称被拒绝。',
  }), []);
});

test('current production verification requires complete named sections', () => {
  assert.deepEqual(getHardRuleIssues({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    task_type: 'bugfix',
    verify_result: 'PASS；修复前目标回归失败；修复后目标测试通过。',
  }), ['bugfix 的 verify_result 缺少完整分段：问题情况、处理过程、解决情况、验证结论']);
  assert.deepEqual(getHardRuleIssues({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    task_type: 'bugfix',
    verify_result: 'PASS；问题情况：空输入 panic。处理过程：定位 queue.go 并修改。解决情况：修复前目标测试失败，修复后 10/10 通过。验证结论：全量测试和 go vet 通过。',
  }), []);
  assert.deepEqual(getHardRuleIssues({
    production_flow: 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix',
    task_type: 'diagnosis',
    verify_result: 'PASS；问题情况：空输入 panic。处理过程：复现并阅读源码，工作区未改。诊断结论：缺少 nil 检查。验证结论：pristine/workspace 无差异，判定通过。',
  }), []);
});

test('V5 verification uses proof JSON instead of legacy prose sections', () => {
  const verifyResult = JSON.stringify({
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
  });
  assert.deepEqual(getHardRuleIssues({
    verification_policy_version: 5,
    task_type: 'bugfix',
    sessionId: '11111111-1111-4111-8111-111111111111',
    verify_result: verifyResult,
  }), []);
  assert.match(getHardRuleIssues({ verification_policy_version: 5, task_type: 'bugfix', verify_result: '' })[0], /JSON/);
});

test('diagnosis requires reliable clean-workspace evidence and rejects dirty status output', () => {
  const missing = getHardRuleIssues({ task_type: 'diagnosis', verify_result: 'PASS；工作区未修改。' });
  assert.match(missing[0], /pristine\/workspace/);

  const dirty = getHardRuleIssues({
    task_type: 'diagnosis',
    verify_result: 'PASS；工作区未修改。',
    verify_cmds: 'diff -qr --exclude=.git pristine workspace',
  }, { trajectoryText: 'git status --short .\\n?? ./\\n' });
  assert.equal(dirty.length, 1);
  assert.match(dirty[0], /git status\/diff/);
});

test('qualified tasks cannot contain hard-rule failures', () => {
  const tasks = [{ id: 'one', bug_id: 'bug-a', ruleIssues: ['缺少文件名'] }];
  assert.throws(() => assertQualifiedTasksPassHardRules(tasks, new Set(['one'])), /未通过硬校验/);
});
