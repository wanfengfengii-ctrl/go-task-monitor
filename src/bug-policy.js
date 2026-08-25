export const BUG_TAXONOMY_POLICY_VERSION = 2;
export const BUG_DIFFICULTY_POLICY_VERSION = 3;
export const BUG_QUERY_POLICY_VERSION = 4;
export const BUG_POLICY_VERSION = BUG_QUERY_POLICY_VERSION;
export const USER_QUERY_SIMILARITY_THRESHOLD = 0.72;

const USER_QUERY_CONTEXT_PATTERN = /我们|我这边|同事|用户|客户|现场|线上|生产环境|实际使用|最近|今天|昨天|刚才|偶尔|偶发|每次|发现|遇到|看起来|原本|正常情况下|[\p{Script=Han}a-z0-9_.-]{2,}(?:模块|服务|命令|接口|页面|任务|流程|功能)/iu;
const USER_QUERY_TRIGGER_PATTERN = /调用|执行|运行|启动|重启|关闭|并发|同时|提交|读取|写入|删除|更新|上传|下载|导入|导出|请求|点击|切换|恢复|重放|重试|处理|收到|发送|传入|设置|使用/u;
const USER_QUERY_OBSERVATION_PATTERN = /报错|错误|异常|日志|退出码|返回|输出|结果|状态|金额|数量|计数|为空|丢失|重复|不一致|无效|失败|panic|超时|卡住|没有|未能|少(?:了|扣|算|记)|多(?:了|算|记)/iu;
const USER_QUERY_REQUEST_PATTERN = /麻烦|帮(?:我|忙)?|能不能|可以帮|想请|想确认|请看|看看|查一下|处理一下|修一下|定位一下|排查一下|调查一下|需要(?:修复|排查|定位|确认)/u;
const USER_QUERY_TEMPLATE_START = /^\s*请(?:以[^，。；]{0,20})?(?:修复|排查|诊断|定位|调查)/u;
const USER_QUERY_BATCH_PATTERN = /批量生成|批量出题|套(?:用)?模板|模板化|本批次|第\s*\d+\s*(?:题|条)|上一题|下一题|同上|按上述格式|统一生成|占位符|模型生成|AI\s*生成/iu;
const USER_QUERY_FIELD_HEADING_PATTERN = /(?:问题现象|复现步骤|期望行为|影响范围|验证要求|验收标准|任务要求)\s*[：:]/gu;

function normalizedUserQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/`[^`]*`/g, ' 标识符 ')
    .replace(/[a-z_][a-z0-9_./:-]*/gi, ' 标识符 ')
    .replace(/\d+/g, ' 数值 ')
    .replace(/[^\p{Script=Han}a-z]+/gu, '');
}

function characterNgrams(value, size = 3) {
  const normalized = normalizedUserQuery(value);
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  return new Set(Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size)));
}

export function userQuerySimilarity(left, right) {
  const leftGrams = characterNgrams(left);
  const rightGrams = characterNgrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

export function assessUserQueryAuthorship(value, previousQueries = []) {
  const query = String(value || '').trim();
  const issues = [];
  const warnings = [];
  if (USER_QUERY_TEMPLATE_START.test(query)) issues.push('user_query 不能以“请修复/请排查/请诊断”等模板指令开头');
  if (USER_QUERY_BATCH_PATTERN.test(query)) issues.push('user_query 出现批量、模板、题号或模型生成痕迹');
  const headings = query.match(USER_QUERY_FIELD_HEADING_PATTERN) || [];
  if (headings.length >= 2) issues.push('user_query 不能按问题现象、期望行为、验证要求等字段小标题套写');
  if (!USER_QUERY_CONTEXT_PATTERN.test(query)) issues.push('user_query 缺少本项目的真实业务场景或实际使用语境');
  if (!USER_QUERY_TRIGGER_PATTERN.test(query)) issues.push('user_query 缺少触发问题的具体操作、调用路径或状态变化');
  if (!USER_QUERY_OBSERVATION_PATTERN.test(query)) issues.push('user_query 缺少实际输出、错误、日志、状态或数值差异等可观察现象');
  if (!USER_QUERY_REQUEST_PATTERN.test(query)) warnings.push('user_query 尚未包含提问者自然提出的排查、修复或确认请求，交由人工题面确认补充');

  let closest = { index: -1, similarity: 0, query: '' };
  (Array.isArray(previousQueries) ? previousQueries : []).forEach((previous, index) => {
    const similarity = userQuerySimilarity(query, previous);
    if (similarity > closest.similarity) closest = { index, similarity, query: String(previous || '') };
  });
  if (closest.similarity >= USER_QUERY_SIMILARITY_THRESHOLD) {
    issues.push(`user_query 与已有题面相似度 ${(closest.similarity * 100).toFixed(1)}%，达到 ${Math.round(USER_QUERY_SIMILARITY_THRESHOLD * 100)}% 打回阈值`);
  }
  return { ok: issues.length === 0, issues, warnings, closest };
}

// Technical Bug discovery must not fail merely because a model-written report
// sounds too formal. The final wording is reviewed and confirmed by a human
// after the Bug source has been prepared.
export function validateUserQueryDraft(value) {
  const query = String(value || '').trim();
  const issues = [];
  if (!query) issues.push('user_query 不能为空');
  if (query && !/\p{Script=Han}/u.test(query)) issues.push('user_query 必须包含中文说明');
  if (/(?:fix_commit|parent_sha|gold|hidden\s+test|修复提交|隐藏测试|标准答案|上游 issue)/i.test(query)) {
    issues.push('user_query 不得泄漏修复提交、标准答案或隐藏验收信息');
  }
  return { ok: issues.length === 0, issues };
}

export function userQueryAuthoringPolicyText() {
  return [
    'Write one draft user_query for this one Bug; never draft several queries, describe a batch, or reuse a sentence template.',
    'Write in Chinese from the real project context, including the real business situation, trigger path, and observed behavior when those details are known. This is a draft for human editing; wording style and whether it ends with a natural request are reviewed later and must not reject the technical Bug.',
    'Never invent an error message just to satisfy a writing rule. Do not reveal the root-cause file, internal symbol, Gold answer, commit, patch, or hidden acceptance.',
    'Keep the wording concrete and concise. A human reviewer will edit and confirm the final user_query after the Bug source is prepared.',
    'Do not mention AI, a model, generation, a template, a batch, a question number, a benchmark, hidden evaluation, or these writing rules in user_query.',
    'The system records any style concerns as review hints; they are not a reason to discard a technically valid Bug.',
  ].join(' ');
}

export const TASK_SUBTYPES = Object.freeze({
  diagnosis: Object.freeze([
    '报错原因分析',
    '运行异常诊断',
    '安全问题定位',
    '异常排查',
    '环境问题诊断',
  ]),
  bugfix: Object.freeze([
    '环境 / 配置 / 依赖修复',
    '语法 / 编译修复',
    '业务逻辑修复',
    '运行时异常 / 稳定性修复',
    '数据正确性 / 数据修复',
    '其他类',
  ]),
});

export const BUG_MECHANISMS = Object.freeze([
  'concurrency',
  'nil',
  'slice',
  'error',
  'context',
  'defer',
  'other',
]);

export const BUG_RUNTIME_MECHANISMS = Object.freeze([
  'concurrency_race',
  'context_cancellation',
  'timeout_or_background_lifecycle',
  'transaction_atomicity',
  'persistence_recovery_or_replay',
  'state_machine_transition',
  'error_propagation_or_partial_failure',
  'panic_or_process_crash',
  'aliasing_or_shared_state_pollution',
  'cross_layer_data_flow',
  'resource_lifecycle',
  'protocol_or_stream_integrity',
  'idempotency_or_duplicate_delivery',
  'numeric_overflow_or_precision',
]);

export const BUG_AFFECTED_LAYERS = Object.freeze([
  'command_or_api',
  'service_or_orchestration',
  'domain_state_machine',
  'persistence_or_transaction',
  'recovery_or_replay',
  'concurrency_or_scheduler',
  'transport_or_protocol',
  'resource_lifecycle',
  'caller_owned_memory',
  'external_observable_behavior',
]);

export const BUG_DIFFICULTY_POLICY = Object.freeze({
  minimumAffectedLayers: 2,
  shallowPatterns: Object.freeze([
    '字段、参数名或常量拼写错误',
    '枚举或关键字漏掉一个映射',
    '单个 nil、空值或必填字段漏判',
    '单个比较符、下标、计数器或偏移量错误',
    '字符串前缀、空白、转义或分隔符处理错误',
    '漏调单个 decoder 或 validator 配置项',
  ]),
});

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function assessBugDifficulty(record = {}) {
  const runtimeMechanisms = uniqueStrings(record.runtime_mechanisms);
  const affectedLayers = uniqueStrings(record.affected_layers);
  const stateOrResourceImpact = String(record.state_or_resource_impact || '').trim();
  const difficultyEvidence = String(record.difficulty_evidence || '').trim();
  const issues = [];
  const unknownMechanisms = runtimeMechanisms.filter((value) => !BUG_RUNTIME_MECHANISMS.includes(value));
  const unknownLayers = affectedLayers.filter((value) => !BUG_AFFECTED_LAYERS.includes(value));

  if (!runtimeMechanisms.length) issues.push('缺少真实运行时机制');
  if (unknownMechanisms.length) issues.push(`runtime_mechanisms 包含未知值：${unknownMechanisms.join(', ')}`);
  if (affectedLayers.length < BUG_DIFFICULTY_POLICY.minimumAffectedLayers) {
    issues.push(`affected_layers 至少需要 ${BUG_DIFFICULTY_POLICY.minimumAffectedLayers} 个不同边界`);
  }
  if (unknownLayers.length) issues.push(`affected_layers 包含未知值：${unknownLayers.join(', ')}`);
  return {
    ok: issues.length === 0,
    issues,
    runtimeMechanisms,
    affectedLayers,
    stateOrResourceImpact,
    difficultyEvidence,
  };
}

export function validateBugDifficulty(record = {}) {
  const assessment = assessBugDifficulty(record);
  if (!assessment.ok) throw new Error(`Bug 难度门禁未通过：${assessment.issues.join('；')}`);
  return assessment;
}

export function bugDifficultyPolicyText() {
  return [
    'This Bug must require reasoning about a real runtime mechanism, not a one-line shallow data transformation.',
    `Set runtime_mechanisms to one or more exact values from: ${BUG_RUNTIME_MECHANISMS.join(', ')}.`,
    `Set affected_layers to at least ${BUG_DIFFICULTY_POLICY.minimumAffectedLayers} exact values from: ${BUG_AFFECTED_LAYERS.join(', ')}.`,
    'state_or_resource_impact must identify the concrete state, persisted data, transaction, goroutine, resource, protocol stream, or caller-owned memory that becomes incorrect.',
    'difficulty_evidence must give a three-link causal chain from the internal operation, through the runtime propagation path, to public behavior, and explain why locating and verifying the defect requires more than reading one local branch.',
    `Reject shallow defects whose essential repair is only one of: ${BUG_DIFFICULTY_POLICY.shallowPatterns.join('；')}. A shallow-looking operation qualifies only when actual code evidence shows a non-trivial concurrency, transaction, recovery, resource-lifecycle, shared-state, or cross-layer invariant; dramatic wording does not make it difficult.`,
    'The affected production path must be reachable from a documented public command, API, or workflow. Do not select unused, toy, duplicate, or test-only components.',
  ].join(' ');
}

export const BUG_CATEGORY_LABELS = Object.freeze({
  concurrency: 'concurrency并发问题',
  nil: 'nil相关问题',
  slice: 'slice相关问题',
  error: 'error异常错误',
  context: 'context相关问题',
  defer: 'defer相关问题',
  other: '其他问题',
});

const LEGACY_BUG_MECHANISMS = Object.freeze({
  'concurrency并发问题': 'concurrency',
  'nil相关问题': 'nil',
  'slice相关问题': 'slice',
  'error异常错误': 'error',
  'context相关问题': 'context',
  'defer相关问题': 'defer',
  '其他问题': 'other',
});

export function normalizeBugCategory(value) {
  const normalized = String(value || '').trim();
  return BUG_MECHANISMS.includes(normalized) ? normalized : LEGACY_BUG_MECHANISMS[normalized] || '';
}

export function bugCategoryLabel(value) {
  const normalized = normalizeBugCategory(value);
  return BUG_CATEGORY_LABELS[normalized] || '';
}

export function normalizeTaskType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'diagnosis' ? 'diagnosis' : normalized === 'bugfix' ? 'bugfix' : '';
}

export function validateBugTaxonomy({ taskType, taskSubtype, bugCategory } = {}) {
  const normalizedType = normalizeTaskType(taskType);
  const issues = [];
  if (!normalizedType) issues.push('task_type 必须是 bugfix 或 diagnosis');
  if (normalizedType && !TASK_SUBTYPES[normalizedType].includes(String(taskSubtype || '').trim())) {
    issues.push(`task_subtype 不属于 ${normalizedType} 允许的二级分类`);
  }
  const normalizedCategory = normalizeBugCategory(bugCategory);
  if (!normalizedCategory) issues.push('bug_category 缺陷机制不合法');
  return { ok: issues.length === 0, issues, taskType: normalizedType, bugCategory: normalizedCategory };
}

export function maxRootCauseFilesForBugCount(count) {
  const total = Math.max(0, Number(count) || 0);
  if (total < 4) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(total * 0.3));
}

function rootCauseFileOf(bug) {
  const explicit = String(bug?.gold?.root_cause_file || bug?.gold?.rootCauseFile || bug?.root_cause_file || '').trim();
  if (explicit) return explicit;
  const targetFiles = bug?.discovery?.target_files || bug?.target_files;
  return Array.isArray(targetFiles) && targetFiles.length === 1 ? String(targetFiles[0] || '').trim() : '';
}

export function validateRootCauseFileConcentration(bugs = [], { totalBugCount } = {}) {
  const records = Array.isArray(bugs) ? bugs : [];
  const delivered = records.filter((bug) => bug && bug.disposition !== 'skipped');
  const policyTotal = Math.max(delivered.length, Number(totalBugCount) || 0);
  const limit = maxRootCauseFilesForBugCount(policyTotal);
  if (!Number.isFinite(limit)) return { ok: true, total: delivered.length, policyTotal, limit, counts: {}, issues: [] };
  const counts = {};
  for (const bug of delivered) {
    const file = rootCauseFileOf(bug);
    if (file) counts[file] = Number(counts[file] || 0) + 1;
  }
  const issues = Object.entries(counts)
    .filter(([, count]) => count > limit)
    .map(([file, count]) => `根因文件 ${file} 命中 ${count} 个 Bug，超过项目 ${policyTotal} 个 Bug 允许的 ${limit} 个上限`);
  return { ok: issues.length === 0, total: delivered.length, policyTotal, limit, counts, issues };
}

export function frontendRatioStatus(total = 0, frontend = 0, minimumRatio = 0.3) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  const normalizedFrontend = Math.max(0, Number(frontend) || 0);
  const required = normalizedTotal ? Math.ceil(normalizedTotal * minimumRatio) : 0;
  return {
    total: normalizedTotal,
    frontend: normalizedFrontend,
    required,
    ok: normalizedFrontend >= required,
    debt: Math.max(0, required - normalizedFrontend),
    ratio: normalizedTotal ? normalizedFrontend / normalizedTotal : 0,
  };
}

export function assignFrontendFlags(count, existingTotal = 0, existingFrontend = 0, minimumRatio = 0.3) {
  const batchSize = Math.max(0, Number(count) || 0);
  const total = Math.max(0, Number(existingTotal) || 0);
  const frontend = Math.max(0, Number(existingFrontend) || 0);
  const requiredAfterBatch = frontendRatioStatus(total + batchSize, frontend, minimumRatio).required;
  const needed = Math.min(batchSize, Math.max(0, requiredAfterBatch - frontend));
  return Array.from({ length: batchSize }, (_, index) => index < needed);
}
