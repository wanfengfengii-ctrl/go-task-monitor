import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUG_DIFFICULTY_POLICY_VERSION,
  BUG_POLICY_VERSION,
  BUG_QUERY_POLICY_VERSION,
  assessBugDifficulty,
  assessUserQueryAuthorship,
  assignFrontendFlags,
  bugDifficultyPolicyText,
  frontendRatioStatus,
  userQueryAuthoringPolicyText,
  userQuerySimilarity,
  validateBugDifficulty,
  validateBugTaxonomy,
  validateRootCauseFileConcentration,
  validateUserQueryDraft,
} from './bug-policy.js';

function difficultBug(overrides = {}) {
  return {
    runtime_mechanisms: ['transaction_atomicity', 'numeric_overflow_or_precision'],
    affected_layers: ['service_or_orchestration', 'persistence_or_transaction', 'external_observable_behavior'],
    state_or_resource_impact: '溢出的容量计算先创建持久化 Session，再让预约写入失败，数据库会遗留不可达的孤立会话。',
    difficulty_evidence: '请求先经过服务容量计算，再跨入事务持久化 Session 与预约；int64 边界使两步结果分裂，必须同时验证失败返回、事务回滚和数据库不存在孤立 Session，不能靠替换一个展示值完成验证。',
    ...overrides,
  };
}

test('bug taxonomy keeps task subtype independent from the defect mechanism', () => {
  assert.equal(validateBugTaxonomy({ taskType: 'bugfix', taskSubtype: '业务逻辑修复', bugCategory: 'slice' }).ok, true);
  assert.equal(validateBugTaxonomy({ taskType: 'diagnosis', taskSubtype: '业务逻辑修复', bugCategory: 'slice' }).ok, false);
  assert.equal(validateBugTaxonomy({ taskType: 'diagnosis', taskSubtype: '异常排查', bugCategory: 'unknown' }).ok, false);
});

test('one root-cause file is capped at 30 percent of project bugs', () => {
  const bug = (file) => ({ gold: { root_cause_file: file } });
  assert.equal(validateRootCauseFileConcentration([bug('a.go'), bug('a.go'), bug('a.go')], { totalBugCount: 10 }).ok, true);
  assert.equal(validateRootCauseFileConcentration([bug('a.go'), bug('a.go'), bug('a.go'), bug('a.go')], { totalBugCount: 10 }).ok, false);
  assert.equal(validateRootCauseFileConcentration(Array.from({ length: 9 }, () => bug('a.go')), { totalBugCount: 30 }).ok, true);
  assert.equal(validateRootCauseFileConcentration(Array.from({ length: 10 }, () => bug('a.go')), { totalBugCount: 30 }).ok, false);
  assert.equal(validateRootCauseFileConcentration([bug('a.go'), bug('a.go'), bug('a.go')]).ok, true);
});

test('frontend assignment maintains a rolling contributor ratio of at least 30 percent', () => {
  assert.deepEqual(assignFrontendFlags(10), [true, true, true, false, false, false, false, false, false, false]);
  assert.deepEqual(assignFrontendFlags(4, 10, 2), [true, true, true, false]);
  assert.equal(frontendRatioStatus(14, 5).ok, true);
});

test('V4 combines strict difficulty with independent user-query authorship policy', () => {
  assert.equal(BUG_POLICY_VERSION, BUG_QUERY_POLICY_VERSION);
  assert.equal(BUG_QUERY_POLICY_VERSION, BUG_DIFFICULTY_POLICY_VERSION);
  assert.equal(validateBugDifficulty(difficultBug()).ok, true);
  assert.equal(validateBugDifficulty(difficultBug({
    runtime_mechanisms: ['concurrency_race', 'resource_lifecycle'],
    affected_layers: ['concurrency_or_scheduler', 'resource_lifecycle', 'persistence_or_transaction'],
    state_or_resource_impact: '关闭流程先释放文件存储，而仍在发送的后台协调器随后继续追加事件并触发进程级 panic。',
    difficulty_evidence: 'Close 与后台 run 协程存在确定性阻塞交错，资源关闭顺序穿过发送、事件追加和文件生命周期；测试必须用同步屏障固定顺序，并证明 Close 幂等且后台写入完成后才释放存储。',
  })).ok, true);
  assert.equal(validateBugDifficulty(difficultBug({
    runtime_mechanisms: ['aliasing_or_shared_state_pollution'],
    affected_layers: ['caller_owned_memory', 'persistence_or_transaction', 'external_observable_behavior'],
    state_or_resource_impact: '列表结果与缓冲区内部条目及 Payload 底层数组共享，调用方修改返回值后会污染后续持久化读取结果。',
    difficulty_evidence: '问题跨越 slice 指针复制、条目对象所有权和 Payload 底层数组三个层次，必须在公开读取后修改状态与字节，再次读取并验证内部缓冲区未被污染，浅复制检查不足以覆盖完整机制。',
  })).ok, true);
  assert.equal(validateBugDifficulty(difficultBug({
    state_or_resource_impact: '状态异常',
    difficulty_evidence: '跨层传播',
  })).ok, true);
});

test('V4 accepts a concrete reporter-style query with situation, trigger and observed evidence', () => {
  const query = '调度模块在并发分配任务时偶发状态对不上：两个协程同时调用 scheduler.Assign 后，待处理数量比预期少一条，日志里还能看到同一个 taskID 被分配了两次，麻烦帮我排查一下这个并发问题。';
  const result = assessUserQueryAuthorship(query);
  assert.equal(result.ok, true, result.issues.join('；'));
  assert.equal(result.issues.length, 0);
});

test('V4 rejects instruction templates, batch traces and field-heading prose', () => {
  const template = assessUserQueryAuthorship('请排查本批次第 3 题。问题现象：服务返回失败。复现步骤：调用接口。验证要求：修复测试。');
  assert.equal(template.ok, false);
  assert.match(template.issues.join('；'), /模板指令开头/);
  assert.match(template.issues.join('；'), /批量、模板、题号或模型生成痕迹/);
  assert.match(template.issues.join('；'), /字段小标题套写/);
});

test('V4 keeps concrete trigger and observation as checks but treats natural request as a review hint', () => {
  const result = assessUserQueryAuthorship('我们线上这个任务模块最近行为不太正常，希望保持所有功能符合预期。');
  assert.equal(result.ok, false);
  assert.match(result.issues.join('；'), /触发问题/);
  assert.match(result.issues.join('；'), /可观察现象/);
  assert.doesNotMatch(result.issues.join('；'), /自然提出/);
  assert.match(result.warnings.join('；'), /人工题面确认/);
});

test('technical Bug discovery accepts a Chinese draft without a natural request for later human review', () => {
  const draft = '孵化场管理员取消批次后补传照检，接口返回 terminal_state，但 timeline 没有 rejected 记录。';
  assert.equal(assessUserQueryAuthorship(draft).ok, false);
  assert.match(assessUserQueryAuthorship(draft).warnings.join('；'), /人工题面确认/);
  assert.deepEqual(validateUserQueryDraft(draft), { ok: true, issues: [] });
  assert.equal(validateUserQueryDraft('Gold patch is hidden').ok, false);
});

test('V4 rejects high-similarity wording within one project', () => {
  const first = '调度模块在并发分配任务时偶发状态对不上：两个协程同时调用 scheduler.Assign 后，待处理数量比预期少一条，日志里还能看到同一个 taskID 被分配了两次，麻烦帮我排查一下这个并发问题。';
  const repeated = '调度模块在并发分配任务时偶发状态不对：两个协程同时调用 scheduler.Assign 后，待处理数量比预期少一条，日志里也看到同一个 taskID 被分配了两次，麻烦帮我排查一下这个并发问题。';
  assert.ok(userQuerySimilarity(first, repeated) >= 0.72);
  const result = assessUserQueryAuthorship(repeated, [first]);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('；'), /相似度/);
  assert.match(userQueryAuthoringPolicyText(), /real business situation/);
});

test('V3 bug difficulty rejects records that only describe shallow local edits', () => {
  const shallowCases = [
    ['flag address 写成 addr', '字段、参数名或常量拼写错误'],
    ['终态枚举漏掉一个值', '枚举或关键字漏掉一个映射'],
    ['缺少 nil 检查', '单个 nil、空值或必填字段漏判'],
    ['截止时间应使用大于而非大于等于', '单个比较符、下标、计数器或偏移量错误'],
    ['memory DSN 多拼接 file 前缀', '字符串前缀、空白、转义或分隔符处理错误'],
    ['漏调 DisallowUnknownFields', '漏调单个 decoder 或 validator 配置项'],
    ['查询只按 operation_id 并移除 task_id 条件', '单个 SQL WHERE、查询或过滤条件增删'],
    ['覆盖检查把全部孔位集合替换成当前请求孔', '把集合、字段或函数参数替换成当前单项'],
  ];
  for (const [description] of shallowCases) {
    const assessment = assessBugDifficulty({
      runtime_mechanisms: [],
      affected_layers: ['command_or_api'],
      state_or_resource_impact: description,
      difficulty_evidence: `读取一个局部函数即可发现并通过单点修改修复：${description}`,
    });
    assert.equal(assessment.ok, false, description);
    assert.match(assessment.issues.join('；'), /缺少真实运行时机制|affected_layers/);
  }
  const policy = bugDifficultyPolicyText();
  for (const [, policyPhrase] of shallowCases) assert.match(policy, new RegExp(policyPhrase));
  assert.throws(() => validateBugDifficulty({}), /Bug 难度门禁未通过/);
});

test('V4 rejects shallow SQL filters and collection argument swaps despite claimed cross-layer impact', () => {
  const sql = assessBugDifficulty(difficultBug({
    failure_mechanism: '把查询从 WHERE task_id=? AND operation_id=? 改为只按 operation_id=? 查找，并同步移除 taskID 参数。',
  }));
  assert.equal(sql.ok, false);
  assert.match(sql.issues.join('；'), /SQL WHERE/);

  const argument = assessBugDifficulty(difficultBug({
    failure_mechanism: '将覆盖检查的全部孔位集合参数改为只检查当前请求孔，随后状态机提前推进。',
  }));
  assert.equal(argument.ok, false);
  assert.match(argument.issues.join('；'), /当前单项/);
});

test('V4 accepts cross-layer persistence identity defects that require schema and query changes', () => {
  const assessment = assessBugDifficulty(difficultBug({
    target_files: ['internal/store/schema.go', 'internal/store/curing.go', 'internal/app/curing.go'],
    runtime_mechanisms: [
      'persistence_recovery_or_replay',
      'aliasing_or_shared_state_pollution',
      'cross_layer_data_flow',
    ],
    affected_layers: [
      'command_or_api',
      'domain_state_machine',
      'persistence_or_transaction',
      'external_observable_behavior',
    ],
    failure_mechanism: 'curing_cells 的主键和查询范围没有 task_id，写入不记录任务标识，读取只按 generation，导致多个任务共享同一持久化命名空间。',
  }));
  assert.equal(assessment.ok, true, assessment.issues.join('；'));
});
