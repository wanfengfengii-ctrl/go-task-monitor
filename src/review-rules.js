import { isVerificationPolicyV5, verificationResultIssues } from './verification-evidence.js';

export const REVIEW_STATUSES = new Set(['pending', 'qualified', 'unqualified']);
export const LEGACY_PRODUCTION_FLOW = 'codex_design_claude_generate_then_discover_one_bug_then_dual_fix';
export const PARALLEL_DUAL_FIX_PRODUCTION_FLOW = 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_dual_fix';
export const CURRENT_PRODUCTION_FLOW = 'codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix';
export const PARALLEL_BUG_WORKFLOW_VERSION = 2;
export const CURRENT_WORKFLOW_VERSION = 3;
export const CURRENT_GIT_FLOW = 'main_numbered_bug_bases_parallel_model_fixes';
export const MAX_BUGS_PER_GENERATED_PROJECT = 30;
export const STANDARD_BUGS_PER_GENERATED_PROJECT = 10;
export const LEGACY_BUGS_PER_GENERATED_PROJECT = 5;

const GO_FILENAME_PATTERN = /(?:^|[\s`'"(（，。；：、])(?:[\w.-]+\/)*[\w.-]+\.go(?=$|[\s`'"),:;#，。；：、）])/i;
const GO_SYMBOL_PATTERN = /(?:函数|方法|类型|符号)\s*[：:]?\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\.go(?:\s*文件)?\s*(?:中的|的)\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/;
const FAILURE_INTERNAL_FAULT_PATTERN = /未|没有|缺少|忽略|遗漏|漏掉|错误|不正确|不当|非严格|无条件|仅|只|才|之后|之前|去掉|移除|跳过|绕过|误用|错用|过早|过晚|提前|延后|后置|相反|颠倒|反转|折叠|退化|破坏|多算|少算|覆盖|清空|丢失|丢弃|吞掉|竞态|竞争|随机|未同步|未更新|未检查|未传播|未保留|溢出|越界/i;
const FAILURE_INTERNAL_OPERATION_PATTERN = /分支|使用|采用|执行|计算|比较|判断|检查|校验|更新|修改|改为|替换|更换|设置|赋值|写入|读取|访问|删除|追加|递增|递减|加锁|解锁|同步|维护|缓存|阈值|约束|建表|索引|切片|map|通道|channel|循环|返回|回退|传递|解析|编码|解码|取整|截断|位移|状态|字段|投影|事务|提交|恢复|重放|构造|保存|调用|查询|统计|分组|复制|释放|推进|接收|持久化|匹配/i;
const FAILURE_CAUSAL_LINK_PATTERN = /最终导致|从而导致|因而导致|进而导致|导致|(?<!构)造成|引发|致使|使得|使(?!用)|从而|因此|因而|进而|所以|最终|结果是|触发/i;
const RELIABLE_WORKSPACE_EVIDENCE_PATTERN = /diff\s+-qr[\s\S]{0,160}pristine[\s\S]{0,160}workspace|(?:workspace|工作区)[\s\S]{0,120}(?:sha-?256|哈希)[\s\S]{0,120}(?:一致|相同|match)|(?:sha-?256|哈希)[\s\S]{0,120}(?:一致|相同|match)[\s\S]{0,120}(?:workspace|工作区)|(?:pristine|基线)[\s\S]{0,120}(?:workspace|工作区)[\s\S]{0,120}(?:无差异|一致|相同)/i;
const SUSPICIOUS_WORKSPACE_STATUS_PATTERN = /(?:\\n|\n)[ \t]*(?:\?\?\s+\.\/|[MDARCU?!]{1,2}\s+(?:\.DS_Store|benchmark-reference|deliverables\/|enterprise-intel|[^\\\n"]+\.go(?:\\n|\n)))/;
const BEFORE_FIX_PATTERN = /修复前|修改前|补丁前|旧版本|旧实现|原实现|回退到旧/i;
const AFTER_FIX_PATTERN = /修复后|修改后|补丁后|新实现|应用补丁后/i;
const VERIFY_SECTION_PATTERNS = {
  problem: /问题情况\s*[：:]/,
  process: /处理过程\s*[：:]/,
  resolution: /解决情况\s*[：:]/,
  diagnosis: /诊断结论\s*[：:]/,
  conclusion: /验证结论\s*[：:]/,
};
const TOOLCHAIN_VERSION_PATTERN = /(?:^|[;\s])(?:go\s+version\s+)?go\d+\.\d+\.\d+\b/i;
const GO_MOD_VERSION_PATTERN = /\bgo\.mod\s+go\s+\d+\.\d+(?:\.\d+)?\b/i;
const TOOLCHAIN_VERSION_CAPTURE_PATTERN = /(?:^|[;\s])(?:go\s+version\s+)?(go\d+\.\d+\.\d+)\b/i;
const GO_MOD_VERSION_CAPTURE_PATTERN = /\bgo\.mod\s+go\s+(\d+\.\d+(?:\.\d+)?)\b/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const GIT_COMMIT_URL_PATTERN = /^https?:\/\/[^\s]+\/commit\/[0-9a-f]{40}(?:[^\s]*)?$/i;

function numberedModelFixBranch(bugIndex, actor) {
  return `bug-${String(bugIndex).padStart(2, '0')}/${actor}_model_fix`;
}

function numberedGreenBranch(bugIndex) {
  return `bug${Number(bugIndex)}_green`;
}

function numberedRedBranch(bugIndex) {
  return `bug${Number(bugIndex)}_red`;
}

function usesPrivateFixtureGitLayout(record) {
  return Number(record?.workflow_policy_version || 0) >= 4
    && Number(record?.verification_policy_version || 0) >= 5;
}

// Policy-4 diagnosis publishes one immutable red branch. The generic task
// schema still exposes test_model_fix_* aliases, so derive those aliases from
// the authoritative red commit instead of letting stale retry metadata make a
// valid red-only delivery look like an unfinished green fix.
export function normalizeDiagnosisGitMetadata(record = {}) {
  if (!usesPrivateFixtureGitLayout(record) || record.task_type !== 'diagnosis') return record;
  const bugIndex = Number(record.bug_index);
  const redCommit = String(record.red_commit || '').trim();
  if (!Number.isInteger(bugIndex) || bugIndex < 1 || !GIT_SHA_PATTERN.test(redCommit) || record.red_pushed !== true) {
    return record;
  }
  const redBranch = numberedRedBranch(bugIndex);
  const repository = String(record.repository || '').trim().replace(/\.git$/i, '').replace(/\/$/, '');
  return {
    ...record,
    bug_base_branch: '',
    bug_base_commit: redCommit,
    red_branch: redBranch,
    test_model_fix_branch: redBranch,
    test_model_fix_base_commit: redCommit,
    test_model_fix_commit: redCommit,
    test_model_fix_pushed: true,
    ...(repository ? { repo_url: `${repository}/tree/${redBranch}` } : {}),
  };
}

function usesLegacyV3GitLayout(record, bugIndex) {
  return Number(record?.workflow_version) === CURRENT_WORKFLOW_VERSION
    && record?.production_flow === CURRENT_PRODUCTION_FLOW
    && record?.bug_base_branch === `BUG_BASE${bugIndex}`
    && record?.test_model_fix_branch === numberedModelFixBranch(bugIndex, 'test')
    && !String(record?.green_branch || '').trim()
    && !String(record?.red_branch || '').trim()
    && !String(record?.model_input_branch || '').trim();
}

function textValue(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

function structuredValues(record, ...fields) {
  return [...new Set(fields.flatMap((field) => {
    const value = record?.[field];
    return Array.isArray(value) ? value : value ? [value] : [];
  }).map((value) => String(value).trim()).filter(Boolean))];
}

function includesAny(text, values, transform = (value) => value) {
  return values.some((value) => text.includes(transform(value)));
}

export function bugLimitForGeneratedProject(record = {}) {
  if (Number(record.project_quality_policy_version || 0) < 2) return LEGACY_BUGS_PER_GENERATED_PROJECT;
  return record.project_tier === 'large' ? MAX_BUGS_PER_GENERATED_PROJECT : STANDARD_BUGS_PER_GENERATED_PROJECT;
}

export function getGoVersionRuleIssues(value, { hasGoMod } = {}) {
  const issues = [];
  const text = textValue(value).trim();
  if (hasGoMod === false) issues.push('项目必须包含 go.mod，不能使用 pre-modules、GOPATH 或“go.mod go 未声明”代替');
  if (!TOOLCHAIN_VERSION_PATTERN.test(text) || !GO_MOD_VERSION_PATTERN.test(text)) {
    issues.push('go_version 必须同时固定工具链补丁版本和 go.mod 语言版本（格式：go1.25.6; go.mod go 1.23）');
  }
  return issues;
}

export function resolvePinnedGoVersion(value, fallbackGoModVersion = '') {
  const text = textValue(value).trim();
  const toolchainVersion = text.match(TOOLCHAIN_VERSION_CAPTURE_PATTERN)?.[1]?.toLowerCase() || '';
  const declaredGoModVersion = text.match(GO_MOD_VERSION_CAPTURE_PATTERN)?.[1] || '';
  const fallback = /^\d+\.\d+(?:\.\d+)?$/.test(String(fallbackGoModVersion || '').trim())
    ? String(fallbackGoModVersion).trim()
    : '';

  if (toolchainVersion && (declaredGoModVersion || fallback)) {
    return `${toolchainVersion}; go.mod go ${declaredGoModVersion || fallback}`;
  }
  if (text && fallback && !GO_MOD_VERSION_PATTERN.test(text)) {
    return `${text}; go.mod go ${fallback}`;
  }
  return text;
}

export function getProductionFlowRuleIssues(record) {
  const hasFlowMetadata = Object.hasOwn(record || {}, 'production_flow')
    || Object.hasOwn(record || {}, 'workflow_version')
    || Object.hasOwn(record || {}, 'project_origin')
    || Object.hasOwn(record || {}, 'bug_source')
    || Object.hasOwn(record || {}, 'bug_discovery_stage')
    || Object.hasOwn(record || {}, 'bug_index')
    || Object.hasOwn(record || {}, 'trajectory_count')
    || Object.hasOwn(record || {}, 'bug_discovery_id');
  if (!hasFlowMetadata) return [];
  const issues = [];
  const workflowVersion = Number(record.workflow_version || 1);
  const isV3 = workflowVersion >= CURRENT_WORKFLOW_VERSION || record.production_flow === CURRENT_PRODUCTION_FLOW;
  const isV2 = !isV3 && (workflowVersion >= PARALLEL_BUG_WORKFLOW_VERSION || record.production_flow === PARALLEL_DUAL_FIX_PRODUCTION_FLOW);
  const expectedFlow = isV3 ? CURRENT_PRODUCTION_FLOW : isV2 ? PARALLEL_DUAL_FIX_PRODUCTION_FLOW : LEGACY_PRODUCTION_FLOW;
  if (record.production_flow !== expectedFlow) issues.push(`production_flow 必须为 ${expectedFlow}`);
  if (record.project_origin !== 'generated_0to1') issues.push('project_origin 必须为 generated_0to1，后续题目不能以外部仓库检索作为项目来源');
  if (record.project_prompt_author !== 'codex') issues.push('project_prompt_author 必须为 codex，由 Codex 设计 0-1 项目题目');
  if (!['codex_cli', 'claude_code_cli'].includes(record.project_generator)) issues.push('project_generator 必须记录为 codex_cli 或历史 claude_code_cli');
  if (record.project_generation_provider === 'codex' && record.project_generator !== 'codex_cli') issues.push('Codex 生成项目的 project_generator 必须为 codex_cli');
  if (!String(record.project_generation_session_id || '').trim()) issues.push('必须记录生成 0-1 项目的 project_generation_session_id');
  if (isV2 || isV3) {
    const expectedVersion = isV3 ? CURRENT_WORKFLOW_VERSION : PARALLEL_BUG_WORKFLOW_VERSION;
    if (Number(record.workflow_version) !== expectedVersion) issues.push(`workflow_version 必须为 ${expectedVersion}`);
    if (record.bug_discovery_stage !== 'before_git_main_publish') issues.push('必须在发布 Git main 之前完成自然 Bug 寻找和 BUG_BASE 准备');
    if (!['natural', 'injected'].includes(record.bug_source)) issues.push('bug_source 必须为 natural 或 injected');
    if (record.bug_source_private_to_pipeline !== true) issues.push('Bug 来源和注入记录必须仅保存在流水线私有区域');
    if (record.test_model_git_metadata_available !== false) issues.push('Claude 工作区不得包含 Git 元数据');
    if (record.test_model_repository_identity_available !== false) issues.push('Claude 工作区不得暴露仓库地址或提交身份');
  } else if (record.bug_discovery_stage !== 'in_generated_main_before_trajectory') {
    issues.push('V1 bug_discovery_stage 必须为 in_generated_main_before_trajectory');
  }
  if (record.bug_discovery_author !== 'codex') issues.push('bug_discovery_author 必须为 codex');
  const bugIndex = Number(record.bug_index);
  const bugLimit = bugLimitForGeneratedProject(record);
  if (!Number.isInteger(bugIndex) || bugIndex < 1 || bugIndex > bugLimit) issues.push(`bug_index 必须是 1-${bugLimit} 的整数；该层级 0-1 项目最多找 ${bugLimit} 个 bug`);
  if (Number(record.trajectory_count) !== 1) issues.push('一个 bug 只能生成 1 条轨迹，trajectory_count 必须为 1');
  if (!String(record.bug_discovery_id || '').trim()) issues.push('必须明确记录唯一的 bug_discovery_id，不能用 bug_id 代替');
  if (!['bugfix', 'diagnosis'].includes(record.task_type)) issues.push('新流程的 task_type 只能选择 bugfix 或 diagnosis，不能为同一 bug 同时创建两种轨迹');
  return issues;
}

export function isManagedProductionTask(record) {
  const hasFlowMetadata = Object.hasOwn(record || {}, 'production_flow')
    || Object.hasOwn(record || {}, 'workflow_version')
    || Object.hasOwn(record || {}, 'project_origin')
    || Object.hasOwn(record || {}, 'bug_source')
    || Object.hasOwn(record || {}, 'bug_discovery_stage')
    || Object.hasOwn(record || {}, 'bug_index')
    || Object.hasOwn(record || {}, 'trajectory_count')
    || Object.hasOwn(record || {}, 'bug_discovery_id');
  return hasFlowMetadata && getProductionFlowRuleIssues(record).length === 0;
}

export function getGitWorkflowRuleIssues(record) {
  record = normalizeDiagnosisGitMetadata(record);
  const issues = getGitPreparationRuleIssues(record);
  const repository = String(record.repository || '').trim().replace(/\.git$/i, '').replace(/\/$/, '');
  const bugIndex = Number(record.bug_index);
  const privateFixtureGit = usesPrivateFixtureGitLayout(record);
  const v3 = (Number(record.workflow_version || 1) >= CURRENT_WORKFLOW_VERSION
    || record.production_flow === CURRENT_PRODUCTION_FLOW)
    && !usesLegacyV3GitLayout(record, bugIndex);
  const expectedBranch = privateFixtureGit && record.task_type === 'diagnosis'
    ? numberedRedBranch(bugIndex)
    : v3 ? numberedGreenBranch(bugIndex) : numberedModelFixBranch(bugIndex, 'test');
  const expectedRepoUrl = `${repository}/tree/${expectedBranch}`;
  if (!GIT_SHA_PATTERN.test(String(record.test_model_fix_commit || ''))) {
    issues.push('test_model_fix_commit 必须是 40 位 Git commit SHA');
  } else if (record.task_type === 'diagnosis'
    && record.test_model_fix_commit !== record.bug_base_commit
    && record.verification_test_only_commit !== true
    && !privateFixtureGit) {
    issues.push('diagnosis 不修改代码，test_model_fix_commit 必须等于 bug_base_commit');
  } else if (record.task_type === 'bugfix' && record.test_model_fix_commit === record.bug_base_commit) {
    issues.push('bugfix 必须产生修复提交，test_model_fix_commit 不能等于 bug_base_commit');
  }
  const publishedBranchLabel = privateFixtureGit && record.task_type === 'diagnosis'
    ? 'diagnosis red 分支'
    : v3 ? 'green 修复分支' : '测试模型分支';
  if (record.test_model_fix_pushed !== true) issues.push(`test_model_fix_pushed 必须为 true，${publishedBranchLabel}必须推送到远端`);
  if (String(record.repo_url || '') !== expectedRepoUrl) issues.push(`repo_url 必须是当前 repository 下的测试模型分支地址：${expectedRepoUrl}`);
  if (privateFixtureGit && record.task_type === 'bugfix') {
    if (record.red_branch !== numberedRedBranch(bugIndex)) issues.push(`bugfix red_branch 必须为 ${numberedRedBranch(bugIndex)}`);
    if (!GIT_SHA_PATTERN.test(String(record.red_commit || ''))) issues.push('bugfix red_commit 必须是 40 位 Git commit SHA');
    if (record.red_pushed !== true) issues.push('bugfix red_pushed 必须为 true');
  }
  return issues;
}

export function getGitPreparationRuleIssues(record) {
  record = normalizeDiagnosisGitMetadata(record);
  const hasGitMetadata = Object.hasOwn(record || {}, 'git_flow')
    || Object.hasOwn(record || {}, 'repo_url')
    || Object.hasOwn(record || {}, 'main_commit')
    || Object.hasOwn(record || {}, 'bug_main_commit')
    || Object.hasOwn(record || {}, 'bug_base_commit')
    || Object.hasOwn(record || {}, 'test_model_fix_commit')
    || Object.hasOwn(record || {}, 'gold_model_fix_commit');
  if (!hasGitMetadata) return [];
  const issues = [];
  const repository = String(record.repository || '').trim().replace(/\.git$/i, '').replace(/\/$/, '');
  const bugIndex = Number(record.bug_index);
  const bugLimit = bugLimitForGeneratedProject(record);
  const hasValidBugIndex = Number.isInteger(bugIndex) && bugIndex >= 1 && bugIndex <= bugLimit;
  const privateFixtureGit = usesPrivateFixtureGitLayout(record);
  const isV3Git = (Number(record.workflow_version || 1) >= CURRENT_WORKFLOW_VERSION
    || record.production_flow === CURRENT_PRODUCTION_FLOW)
    && !usesLegacyV3GitLayout(record, bugIndex);
  const diagnosisRedOnly = privateFixtureGit && record.task_type === 'diagnosis';
  if (!hasValidBugIndex) issues.push(`bug_index 必须是 1-${bugLimit} 的整数`);
  if (record.git_flow !== CURRENT_GIT_FLOW) issues.push(`git_flow 必须为 ${CURRENT_GIT_FLOW}`);
  if (typeof record.repository !== 'string' || !/^https?:\/\/[^\s]+$/i.test(record.repository.trim())) issues.push('repository 必须是 Git 仓库地址');
  if (record.main_branch !== 'main') issues.push('main_branch 必须为 main');
  if (!GIT_SHA_PATTERN.test(String(record.main_commit || ''))) issues.push('main_commit 必须是 Claude 生成的 0-1 项目在 main 上的 40 位 commit SHA');
  if (record.main_pushed !== true) issues.push('main_pushed 必须为 true，0-1 项目必须先推送到远端 main');
  if (!isV3Git) {
    if (hasValidBugIndex && record.bug_main_branch !== `bug${bugIndex}_main`) issues.push(`bug_main_branch 必须为 bug${bugIndex}_main`);
    if (!GIT_SHA_PATTERN.test(String(record.bug_main_commit || ''))) issues.push('bug_main_commit 必须是 40 位 Git commit SHA');
    if (record.bug_main_commit !== record.main_commit) issues.push('bug_main_commit 必须等于 main_commit；每个 Bug 必须基于同一个初始项目 commit');
    if (record.bug_main_pushed !== true) issues.push('bug_main_pushed 必须为 true，编号 bug_main 分支必须推送到远端');
    if (record.bug_main_unchanged !== true) issues.push('bug_main_unchanged 必须为 true，找到 bug 后编号 bug_main 分支不得继续修改');
  }
  const expectedBaseBranch = diagnosisRedOnly ? '' : isV3Git ? numberedGreenBranch(bugIndex) : `BUG_BASE${bugIndex}`;
  if (hasValidBugIndex && String(record.bug_base_branch || '') !== expectedBaseBranch) {
    issues.push(`bug_base_branch 必须为 ${expectedBaseBranch || '空（Diagnosis 仅发布 red 分支）'}`);
  }
  if (!GIT_SHA_PATTERN.test(String(record.bug_base_commit || ''))) issues.push('bug_base_commit 必须是 40 位 Git commit SHA');
  const isParallelWorkflow = Number(record.workflow_version || 1) >= PARALLEL_BUG_WORKFLOW_VERSION
    || [PARALLEL_DUAL_FIX_PRODUCTION_FLOW, CURRENT_PRODUCTION_FLOW].includes(record.production_flow);
  const bugSource = isParallelWorkflow ? record.bug_source : (record.bug_source || 'natural');
  if (!['natural', 'injected'].includes(bugSource)) {
    issues.push('bug_source 必须为 natural 或 injected');
  } else if (bugSource === 'natural' && !isV3Git && record.bug_base_commit !== record.bug_main_commit
    && record.verification_test_only_commit !== true) {
    issues.push('自然 Bug 的 bug_base_commit 必须等于 bug_main_commit');
  } else if (bugSource === 'injected' && !isV3Git) {
    if (record.bug_base_commit === record.bug_main_commit) issues.push('注入 Bug 的 bug_base_commit 必须不同于 bug_main_commit');
    if (record.bug_base_parent_commit !== record.main_commit) issues.push('注入 Bug 的 BUG_BASE 必须是初始 main_commit 的直接子提交');
  }
  if (isV3Git && !diagnosisRedOnly) {
    if (record.bug_base_root !== true) issues.push('V3 green G1 必须标记为 orphan 根提交');
    if (record.bug_base_source_commit !== record.main_commit) issues.push('V3 green G1 必须记录来自冻结 main 的源提交');
    if (record.green_branch !== numberedGreenBranch(bugIndex)) issues.push(`green_branch 必须为 ${numberedGreenBranch(bugIndex)}`);
    if (record.green_baseline_commit !== record.bug_base_commit) issues.push('green_baseline_commit 必须等于 bug_base_commit');
    if (record.green_baseline_pushed !== true) issues.push('green_baseline_pushed 必须为 true');
    if (record.red_branch !== numberedRedBranch(bugIndex) && record.red_commit) issues.push(`red_branch 必须为 ${numberedRedBranch(bugIndex)}`);
    if (record.model_input_branch !== numberedGreenBranch(bugIndex)) issues.push(`model_input_branch 必须为 ${numberedGreenBranch(bugIndex)}`);
    if (record.model_input_commit !== record.bug_base_commit) issues.push('model_input_commit 必须等于 G1 基座提交');
    if (record.model_input_snapshot !== 'single-branch-single-commit-no-tests') issues.push('model_input_snapshot 必须标记为单分支单提交且无验收测试');
  }
  if (diagnosisRedOnly) {
    if (record.green_branch) issues.push('diagnosis 新 Git 标准不得创建 green 分支');
    if (record.model_input_branch || record.model_input_commit) issues.push('diagnosis 新 Git 标准不得暴露 model_input 分支或提交');
    if (record.red_branch !== numberedRedBranch(bugIndex)) issues.push(`diagnosis red_branch 必须为 ${numberedRedBranch(bugIndex)}`);
    if (!GIT_SHA_PATTERN.test(String(record.red_commit || ''))) issues.push('diagnosis red_commit 必须是 40 位 Git commit SHA');
    if (record.red_pushed !== true) issues.push('diagnosis red_pushed 必须为 true');
  }
  if (record.verification_test_only_commit === true) {
    if (record.task_type !== 'diagnosis') issues.push('verification_test_only_commit 只能用于 diagnosis');
    if (record.bug_base_parent_commit !== record.main_commit) issues.push('验证测试专用基线必须直接从 main_commit 派生');
    const files = Array.isArray(record.verification_test_only_files)
      ? record.verification_test_only_files.map(String).filter(Boolean)
      : [];
    if (!files.length || files.some((filename) => filename.startsWith('/') || filename.split(/[\\/]/).includes('..') || !filename.endsWith('_test.go'))) {
      issues.push('验证测试专用基线必须记录安全的 *_test.go 文件清单');
    }
  }
  if (!diagnosisRedOnly && record.bug_base_pushed !== true) issues.push('bug_base_pushed 必须为 true，BUG_BASE 必须推送到远端');
  if (record.main_unchanged !== true) issues.push('main_unchanged 必须为 true，BUG_BASE 后主分支不得继续修改');
  const expectedTestBranch = diagnosisRedOnly
    ? numberedRedBranch(bugIndex)
    : isV3Git ? numberedGreenBranch(bugIndex) : numberedModelFixBranch(bugIndex, 'test');
  if (hasValidBugIndex && record.test_model_fix_branch !== expectedTestBranch) issues.push(`test_model_fix_branch 必须为 ${expectedTestBranch}`);
  if (record.test_model_fix_actor !== 'claude_code_cli') issues.push('test_model_fix_actor 必须为 claude_code_cli');
  if (record.test_model_fix_base_commit !== record.bug_base_commit) issues.push('test_model_fix_base_commit 必须等于 bug_base_commit，Claude 修复必须从 BUG_BASE 派生');
  const claudeOnly = Number(record.workflow_version || 1) >= CURRENT_WORKFLOW_VERSION || record.production_flow === CURRENT_PRODUCTION_FLOW;
  if (!claudeOnly) {
    if (hasValidBugIndex && record.gold_model_fix_branch !== numberedModelFixBranch(bugIndex, 'gold')) issues.push(`gold_model_fix_branch 必须为 ${numberedModelFixBranch(bugIndex, 'gold')}`);
    if (record.gold_model_fix_actor !== 'codex') issues.push('gold_model_fix_actor 必须为 codex，高阶修复由 Codex 独立完成');
    if (record.gold_model_fix_base_commit !== record.bug_base_commit) issues.push('gold_model_fix_base_commit 必须等于 bug_base_commit，两条修复线必须从同一个 BUG_BASE 派生');
    if (!GIT_SHA_PATTERN.test(String(record.gold_model_fix_commit || ''))) issues.push('gold_model_fix_commit 必须是 40 位 Git commit SHA');
    if (record.gold_model_fix_pushed !== true) issues.push('gold_model_fix_pushed 必须为 true，Codex 修复必须推送到远端 gold_model_fix');
    if (!GIT_COMMIT_URL_PATTERN.test(String(record.gold_patch || '')) || !String(record.gold_patch).includes(record.gold_model_fix_commit) || !String(record.gold_patch).startsWith(`${repository}/commit/`)) issues.push('gold_patch 必须是当前 repository 下 gold_model_fix 的完整 commit 地址');
  }
  return issues;
}

export function isManagedGitPreparation(record) {
  const hasGitMetadata = Object.hasOwn(record || {}, 'git_flow')
    || Object.hasOwn(record || {}, 'main_commit')
    || Object.hasOwn(record || {}, 'bug_main_commit')
    || Object.hasOwn(record || {}, 'bug_base_commit')
    || Object.hasOwn(record || {}, 'gold_model_fix_commit');
  return hasGitMetadata && getGitPreparationRuleIssues(record).length === 0;
}

export function isManagedGitWorkflow(record) {
  const hasGitMetadata = Object.hasOwn(record || {}, 'git_flow')
    || Object.hasOwn(record || {}, 'repo_url')
    || Object.hasOwn(record || {}, 'bug_base_commit')
    || Object.hasOwn(record || {}, 'test_model_fix_commit')
    || Object.hasOwn(record || {}, 'gold_model_fix_commit');
  return hasGitMetadata && getGitWorkflowRuleIssues(record).length === 0;
}

export function getApplicableGitRuleIssues(record, { hasTrajectory = false } = {}) {
  const hasGitMetadata = Object.hasOwn(record || {}, 'git_flow')
    || Object.hasOwn(record || {}, 'repo_url')
    || Object.hasOwn(record || {}, 'main_commit')
    || Object.hasOwn(record || {}, 'bug_main_commit')
    || Object.hasOwn(record || {}, 'bug_base_commit')
    || Object.hasOwn(record || {}, 'test_model_fix_commit')
    || Object.hasOwn(record || {}, 'gold_model_fix_commit');
  if (!hasGitMetadata) return [];
  return hasTrajectory ? getGitWorkflowRuleIssues(record) : getGitPreparationRuleIssues(record);
}

export function getGoldRootCauseRuleIssues(record) {
  const issues = [];
  const rootCause = textValue(typeof record === 'string' ? record : record?.gold_root_cause).trim();
  if (!rootCause) return issues;

  const expectedFiles = typeof record === 'string' ? [] : structuredValues(record, 'gold_files', 'target_files');
  const expectedSymbols = typeof record === 'string' ? [] : structuredValues(record, 'gold_symbols', 'symbols');
  const hasFile = expectedFiles.length
    ? includesAny(rootCause, expectedFiles, (value) => value.split('/').at(-1))
    : GO_FILENAME_PATTERN.test(rootCause);
  const hasSymbol = expectedSymbols.length
    ? includesAny(rootCause, expectedSymbols)
    : GO_SYMBOL_PATTERN.test(rootCause);
  if (!hasFile) issues.push('gold_root_cause 必须包含 Gold 结构化记录中的具体文件名');
  if (!hasSymbol) issues.push('gold_root_cause 必须包含 Gold 结构化记录中的具体函数、方法或类型符号');

  const causalMatch = FAILURE_CAUSAL_LINK_PATTERN.exec(rootCause);
  const internalExplanation = causalMatch ? rootCause.slice(0, causalMatch.index) : rootCause;
  const observableExplanation = causalMatch
    ? rootCause.slice(causalMatch.index + causalMatch[0].length).replace(/^[，,：:\s]+/u, '').trim()
    : '';
  const hasInternalMechanism = (FAILURE_INTERNAL_FAULT_PATTERN.test(internalExplanation)
    || /根本原因是|内部原因是/u.test(internalExplanation))
    && FAILURE_INTERNAL_OPERATION_PATTERN.test(internalExplanation);
  const hasCausalSymptom = Boolean(causalMatch && observableExplanation.length >= 4);
  if (!hasInternalMechanism || !hasCausalSymptom) {
    issues.push('gold_root_cause 必须说明完整失效机制：先写具体实现缺陷和错误操作，再说明其传播后为什么导致题面症状');
  }
  return issues;
}

export function getHardRuleIssues(record, { trajectoryText = '', includeGoVersion = true } = {}) {
  const issues = [];
  const rootCause = textValue(record?.gold_root_cause).trim();
  const verifyResult = textValue(record?.verify_result).trim();
  const verifyCmds = textValue(record?.verify_cmds).trim();
  const taskType = record?.task_type;
  const verificationV5 = isVerificationPolicyV5(record);

  if (includeGoVersion && (Object.hasOwn(record || {}, 'go_version') || record?.hasGoMod === false)) {
    issues.push(...getGoVersionRuleIssues(record?.go_version, { hasGoMod: record?.hasGoMod }));
  }

  if (rootCause) issues.push(...getGoldRootCauseRuleIssues(record));

  if (verificationV5) {
    issues.push(...verificationResultIssues(verifyResult, {
      taskType,
      mainSessionId: record?.sessionId || record?.['session  id'] || record?.test_model_fix_session_id,
    }));
  } else if (taskType === 'bugfix' && verifyResult) {
    if (!BEFORE_FIX_PATTERN.test(verifyResult) || !AFTER_FIX_PATTERN.test(verifyResult)) {
      issues.push('bugfix 的 verify_result 必须同时写清修复前失败和修复后成功；修复前失败只需定性描述，不要求次数');
    }
  }

  if (!verificationV5 && [CURRENT_PRODUCTION_FLOW, PARALLEL_DUAL_FIX_PRODUCTION_FLOW, LEGACY_PRODUCTION_FLOW].includes(record?.production_flow) && verifyResult) {
    const requiredSections = taskType === 'diagnosis'
      ? [['问题情况', VERIFY_SECTION_PATTERNS.problem], ['处理过程', VERIFY_SECTION_PATTERNS.process], ['诊断结论', VERIFY_SECTION_PATTERNS.diagnosis], ['验证结论', VERIFY_SECTION_PATTERNS.conclusion]]
      : [['问题情况', VERIFY_SECTION_PATTERNS.problem], ['处理过程', VERIFY_SECTION_PATTERNS.process], ['解决情况', VERIFY_SECTION_PATTERNS.resolution], ['验证结论', VERIFY_SECTION_PATTERNS.conclusion]];
    const missingSections = requiredSections.filter(([, pattern]) => !pattern.test(verifyResult)).map(([name]) => name);
    if (missingSections.length) issues.push(`${taskType} 的 verify_result 缺少完整分段：${missingSections.join('、')}`);
  }

  if (taskType === 'diagnosis' && !verificationV5) {
    const workspaceEvidence = `${verifyResult}\n${verifyCmds}`;
    if (workspaceEvidence.trim() && !RELIABLE_WORKSPACE_EVIDENCE_PATTERN.test(workspaceEvidence)) {
      issues.push('diagnosis 必须用 pristine/workspace 差异或前后文件哈希证明工作区未改，不能只写“未修改”或依赖已删除 .git 后的 git status');
    }
    if (trajectoryText && SUSPICIOUS_WORKSPACE_STATUS_PATTERN.test(trajectoryText)) {
      issues.push('diagnosis 轨迹中的 git status/diff 显示工作区或父仓库有改动，当前证据不能证明工作区干净');
    }
  }
  if (taskType === 'diagnosis' && Number(record?.diagnosis_workspace_policy_version || 0) >= 1
    && record?.diagnosis_workspace_unchanged !== true
    && record?.diagnosis_workspace_check_status !== 'pending') {
    issues.push('diagnosis 必须保持被测仓库源码和测试不变，并通过工作区零修改校验');
  }

  return issues;
}

export function annotateIdentityConflicts(tasks) {
  const counts = { sessionId: new Map(), bug_id: new Map() };
  const bugTypes = new Map();
  const generatedRepositories = new Map();
  const generatedRepositorySlots = new Map();
  const generatedRepositoryMainCommits = new Map();
  const generatedRepositorySessions = new Map();
  const generatedRepositoryLimits = new Map();
  for (const task of tasks) {
    if (task.sessionId) counts.sessionId.set(task.sessionId, (counts.sessionId.get(task.sessionId) || 0) + 1);
    if (task.bug_id) {
      counts.bug_id.set(task.bug_id, (counts.bug_id.get(task.bug_id) || 0) + 1);
      if (!bugTypes.has(task.bug_id)) bugTypes.set(task.bug_id, new Set());
      bugTypes.get(task.bug_id).add(task.task_type);
    }
    if (task.project_origin === 'generated_0to1' && task.repository) {
      const repository = String(task.repository).replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
      generatedRepositories.set(repository, (generatedRepositories.get(repository) || 0) + 1);
      const currentLimit = generatedRepositoryLimits.get(repository);
      const taskLimit = bugLimitForGeneratedProject(task);
      generatedRepositoryLimits.set(repository, currentLimit == null ? taskLimit : Math.min(currentLimit, taskLimit));
      if (!generatedRepositoryMainCommits.has(repository)) generatedRepositoryMainCommits.set(repository, new Set());
      if (!generatedRepositorySessions.has(repository)) generatedRepositorySessions.set(repository, new Set());
      if (task.main_commit) generatedRepositoryMainCommits.get(repository).add(task.main_commit);
      if (task.project_generation_session_id) generatedRepositorySessions.get(repository).add(task.project_generation_session_id);
      const bugIndex = Number(task.bug_index);
      if (Number.isInteger(bugIndex)) {
        const slot = `${repository}#${bugIndex}`;
        generatedRepositorySlots.set(slot, (generatedRepositorySlots.get(slot) || 0) + 1);
      }
    }
  }
  return tasks.map((task) => {
    const repository = String(task.repository || '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
    const conflicts = [];
    if (task.bug_id && bugTypes.get(task.bug_id)?.size > 1) conflicts.push(`同一 bug_id 同时存在 ${[...bugTypes.get(task.bug_id)].join(' / ')} 轨迹；新流程只允许一种 task_type`);
    const repositoryLimit = generatedRepositoryLimits.get(repository) || bugLimitForGeneratedProject(task);
    if (task.project_origin === 'generated_0to1' && repository && generatedRepositories.get(repository) > repositoryLimit) conflicts.push(`同一个 0-1 Git 仓库最多只能对应 ${repositoryLimit} 个 bug 和 ${repositoryLimit} 条轨迹`);
    if (task.project_origin === 'generated_0to1' && repository && generatedRepositoryMainCommits.get(repository)?.size > 1) conflicts.push(`同一 0-1 Git 仓库的 main_commit 不一致，项目内最多 ${repositoryLimit} 个 Bug 必须来自同一个项目版本`);
    if (task.project_origin === 'generated_0to1' && repository && generatedRepositorySessions.get(repository)?.size > 1) conflicts.push(`同一 0-1 Git 仓库的 project_generation_session_id 不一致，项目内最多 ${repositoryLimit} 个 Bug 必须来自同一次 Claude 项目生成`);
    const bugIndex = Number(task.bug_index);
    if (task.project_origin === 'generated_0to1' && repository && Number.isInteger(bugIndex) && generatedRepositorySlots.get(`${repository}#${bugIndex}`) > 1) conflicts.push(`同一仓库的 bug_index ${bugIndex} 重复，编号分支会互相覆盖`);
    return {
      ...task,
      duplicateFields: [
        ...(task.sessionId && counts.sessionId.get(task.sessionId) > 1 ? ['sessionId'] : []),
        ...(task.bug_id && counts.bug_id.get(task.bug_id) > 1 ? ['bug_id'] : []),
      ],
      workflowConflict: conflicts.join('；'),
    };
  });
}

export function assertQualifiedIdentitiesUnique(tasks, qualifiedIds) {
  const qualified = tasks.filter((task) => qualifiedIds.has(task.id));
  const missingSession = qualified.find((task) => !task.sessionId);
  if (missingSession) throw new Error(`${missingSession.bug_id} 尚未生成 session-id，不能标记为合格`);

  for (const field of ['sessionId', 'bug_id']) {
    const seen = new Map();
    for (const task of qualified) {
      const value = task[field];
      if (seen.has(value)) {
        const label = field === 'sessionId' ? 'session-id' : 'bug_id';
        throw new Error(`${label} 不能重复：${value}`);
      }
      seen.set(value, task.id);
    }
  }
}

export function assertQualifiedTasksPassHardRules(tasks, qualifiedIds) {
  const invalid = tasks.find((task) => qualifiedIds.has(task.id) && task.ruleIssues?.length);
  if (!invalid) return;
  throw new Error(`${invalid.bug_id} 未通过硬校验：${invalid.ruleIssues.join('；')}`);
}
