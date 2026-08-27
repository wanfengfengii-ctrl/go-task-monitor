import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  CheckCircle2,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudUpload,
  Clock3,
  Download,
  FileJson,
  FileSpreadsheet,
  GitBranch,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldAlert,
  TerminalSquare,
  Trash2,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';
import './styles.css';
import { EXCEL_EXPORT_FIELDS, isChineseDescription, isCloudTrajectoryFileUrl, isCloudTrajectoryUrl, isGitTestModelBranchUrl, prepareExcelRecord, requireDirectPublicVerifyCmd, requireDockerVerifyCmds, sanitizeHarness } from './export-rules.js';
import { splitExportBatches } from './export-coordinator.js';
import { getClaudeHarnessIssues } from './harness-rules.js';
import { resolvePinnedGoVersion } from './review-rules.js';
import { extractTrajectorySessionId } from './trajectory-upload-rules.js';
import { getGoVersionRuleIssues, getHardRuleIssues } from './review-rules.js';
import { CURRENT_WORKFLOW_VERSION, DEFAULT_BUG_COUNT, pipelineUserQueryReadiness } from './pipeline-rules.js';
import { selectPipelineDisplayStage } from './pipeline-operations.js';
import { bugExecutionPhaseIndex } from './bug-workbench.js';
import { VERIFICATION_POLICY_VERSION } from './verification-evidence.js';
import { isConcurrencyVerificationRecord } from './verification-proof.js';

let labelExportRecordMap = new Map();
let cloudUploadMap = new Map();

const statusLabel = { passed: '已生成', running: '运行中', queued: '排队中', skipped: '轨迹不合格', duplicate: 'ID 重复', failed: '失败' };
const reviewStatusLabel = { pending: '待审核', qualified: '合格', unqualified: '不合格' };
const pipelineStatusLabel = { draft: '草稿', waiting_review: '等待题面确认', waiting_resource: '等待资源', queued: '准备启动', running: '运行中', passed: '已完成', failed: '失败', abandoned: '已废弃', stopped: '已停止' };
const bugWorkbenchStatusLabel = {
  bug_ready: '待启动',
  fast_lane_queued: '已排队',
  fast_lane_running: '运行中',
  fast_lane_switching: '切换中',
  fast_lane_stopped: '已关闭',
  fast_lane_failed: '失败',
  fast_lane_completed: '已完成',
  delivered: '已交付',
};
const bugExecutionPhases = [
  { key: 'source_locating', label: '源码定位' },
  { key: 'first_source_edit', label: '首次修改' },
  { key: 'independent_test_authoring', label: '独立测试编写' },
  { key: 'red_green_validation', label: '红绿验证' },
  { key: 'docker_validation', label: 'Docker' },
  { key: 'git_publication', label: '发布' },
];

function pipelineStageDisplayLabel(stage = {}) {
  const id = String(stage?.id || stage?.currentStage || '');
  if (id.endsWith('_test_author')) {
    return /诊断/.test(String(stage?.label || stage?.currentStageLabel || ''))
      ? 'Codex 独立编写诊断回归测试'
      : 'Codex 独立编写回归测试';
  }
  if (stage?.stage === 'verification_coverage' || id.endsWith('_verification_coverage')) {
    return 'verify_cmds 题面覆盖预检';
  }
  if (stage?.stage === 'trajectory_validate' || id.endsWith('_trajectory_validate')) {
    return '主轨迹采集登记';
  }
  return stage?.label || stage?.currentStageLabel || id;
}

function pipelineBugStatuses(job) {
  return [
    job?.bugExecution?.status,
    ...(job?.bugs || []).map((bug) => bug?.workbench?.status),
  ].filter(Boolean);
}

function pipelineJobMatchesStatus(job, requested) {
  if (requested === 'all') return true;
  const statuses = pipelineBugStatuses(job);
  if (requested === 'running') return job?.status === 'running'
    || Boolean(job?.processActive)
    || statuses.some((status) => ['fast_lane_running', 'fast_lane_switching'].includes(status));
  if (requested === 'queued') return job?.status === 'queued'
    || statuses.includes('fast_lane_queued');
  if (requested === 'waiting_review') return job?.status === 'waiting_review';
  if (requested === 'failed') return job?.status === 'failed'
    || statuses.includes('fast_lane_failed');
  if (requested === 'stopped') return job?.status === 'stopped'
    || statuses.includes('fast_lane_stopped');
  return job?.status === requested;
}

function pipelineJobSearchText(job) {
  const bugText = (job?.bugs || []).flatMap((bug) => {
    const workbench = bug?.workbench || {};
    const attempts = (workbench.attempts || []).flatMap((attempt) => [
      attempt.attempt,
      attempt.status,
      attempt.stage,
      attempt.sessionId,
      attempt.model,
      attempt.claudeCodeVersion,
      attempt.failureCategory,
      attempt.exitCode,
      attempt.action,
      attempt.error,
    ]);
    return [
      bug.discovery?.bug_id,
      bug.task?.bugId,
      bug.task?.taskName,
      bug.bugIndex,
      workbench.status,
      bugWorkbenchStatusLabel[workbench.status],
      workbench.currentStage,
      workbench.currentStageLabel,
      workbench.blockedReason,
      workbench.lastAction,
      workbench.firstFailure?.error,
      workbench.lastFailure?.error,
      ...attempts,
    ];
  });
  return [
    job?.id,
    job?.status,
    pipelineStatusLabel[job?.status],
    job?.currentStage,
    job?.error,
    job?.request?.repository,
    job?.request?.taskType,
    job?.request?.projectBrief,
    job?.bugExecution?.status,
    bugWorkbenchStatusLabel[job?.bugExecution?.status],
    job?.bugExecution?.currentStage,
    job?.bugExecution?.blockedReason,
    job?.bugExecution?.lastAction,
    ...bugText,
  ].filter((value) => value !== null && value !== undefined).join(' ').toLowerCase();
}

function formatWorkbenchDuration(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function largeCanarySummary(canary = {}) {
  const benchmark = canary.benchmark || {};
  if (!Number(canary.targetCount || 0)) return '自动补题默认创建标准项目。';
  if (Number(canary.remainingCount || 0) > 0) return `自动补题试跑剩余 ${canary.remainingCount} 个超大型项目待创建。`;
  if (benchmark.status === 'completed') return `超大型试跑 ${benchmark.passedCount}/${benchmark.targetCount} 已完成，总墙钟时间 ${formatWorkbenchDuration(benchmark.wallElapsedMs)}。`;
  if (benchmark.status === 'needs_attention') return `超大型试跑已创建 ${benchmark.createdCount}/${benchmark.targetCount}，完成 ${benchmark.passedCount}，异常 ${benchmark.failedCount}。`;
  return `超大型试跑已创建 ${benchmark.createdCount || canary.createdJobIds?.length || 0}/${benchmark.targetCount || canary.targetCount}，完成 ${benchmark.passedCount || 0}，已运行 ${formatWorkbenchDuration(benchmark.wallElapsedMs)}。`;
}

const ruleRequiredFields = EXCEL_EXPORT_FIELDS;
const ruleAllowedFields = new Set(ruleRequiredFields);
const ruleBugCategories = new Set(['concurrency', 'nil', 'slice', 'error', 'context', 'defer', 'other', 'concurrency并发问题', 'nil相关问题', 'slice相关问题', 'error异常错误', 'context相关问题', 'defer相关问题', '其他问题']);
const ruleSections = {
  schema: '字段与结构',
  principle: '总体原则',
  setup: '仓库与环境',
  consistency: '任务一致性',
  process: '生产流程',
  delivery: '提交前检查',
};

function ruleIssue(section, message, severity = 'error') {
  return { section: ruleSections[section] || section, message, severity };
}

function hasAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function parseTrajectoryEvents(trajectory) {
  if (typeof trajectory !== 'string' || !trajectory.trim()) return { events: [], parseError: 'trajectory 为空' };
  try {
    const parsed = JSON.parse(trajectory);
    return { events: Array.isArray(parsed) ? parsed : [parsed], parseError: '' };
  } catch {
    const events = [];
    for (const line of trajectory.split(/\r?\n/).filter((value) => value.trim())) {
      try {
        events.push(JSON.parse(line));
      } catch {
        return { events: [], parseError: 'trajectory 包含无法解析或被截断的 JSONL 事件' };
      }
    }
    return { events, parseError: '' };
  }
}

function inspectTrajectory(trajectory) {
  const { events, parseError } = parseTrajectoryEvents(trajectory);
  const toolUseIds = [];
  const toolResultIds = [];
  const visitContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_use') toolUseIds.push(item.id || '');
      if (item.type === 'tool_result') toolResultIds.push(item.tool_use_id || '');
    }
  };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'tool_use') toolUseIds.push(event.id || '');
    if (event.type === 'tool_result') toolResultIds.push(event.tool_use_id || '');
    visitContent(event.content);
    visitContent(event.message?.content);
  }
  const useCounts = new Map(toolUseIds.map((id) => [id, toolUseIds.filter((value) => value === id).length]));
  const resultCounts = new Map(toolResultIds.map((id) => [id, toolResultIds.filter((value) => value === id).length]));
  const toolsBalanced = !toolUseIds.includes('')
    && !toolResultIds.includes('')
    && [...useCounts].every(([id, count]) => count === 1 && resultCounts.get(id) === 1)
    && [...resultCounts].every(([id, count]) => count === 1 && useCounts.get(id) === 1);
  return { events, parseError, toolUses: toolUseIds.length, toolResults: toolResultIds.length, toolsBalanced };
}

function isTrajectoryUrl(value) {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value.trim());
}

function hasTargetVerifyEvidence(value) {
  return /run_docker\.sh|run_target\.sh|目标(?:验收|测试|行为).{0,30}(?:通过|pass|成功)|target.{0,30}(?:通过|pass|success)|go\s+test\b[^\n]*-run\b/i.test(value);
}

function hasFullVerifyEvidence(value) {
  return /run_docker\.sh|run_full\.sh|全量(?:测试|回归)?[^\n]{0,40}(?:通过|pass|成功)|full(?:\s+test|\s+regression)?.{0,40}(?:通过|pass|success)|go\s+test\b[^\n]*(?:\.\/\.\.\.|\.{2}\/\.\.\.)/i.test(value);
}

function hasRepeatEvidence(value) {
  return /\b\d+\s*\/\s*\d+\b|(?:重复|连续|稳定).{0,30}(?:次|通过|失败|复现)|\b(?:repeat|runs?)\b|(?:-count(?:=|\s+)\d+|count\s*=\s*\d+)/i.test(value);
}

function hasUploadedVerificationEvidence(task) {
  if (Number(task?.verification_policy_version || 0) < VERIFICATION_POLICY_VERSION) return true;
  const evidence = task.verification_evidence || {};
  const preReady = evidence.pre_fix?.result === 'red' && isCloudTrajectoryFileUrl(evidence.pre_fix?.trajectory_url || '');
  if (!preReady) return false;
  if (task.task_type === 'diagnosis') return !evidence.post_fix;
  return evidence.post_fix?.result === 'green' && isCloudTrajectoryFileUrl(evidence.post_fix?.trajectory_url || '');
}

function canExportArchivedTask(task) {
  return !task?.archived || task.archiveExportReady === true;
}

function validateRuleRecord(record, index, records) {
  const issues = [];
  const prefix = `第 ${index + 1} 条`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [ruleIssue('schema', `${prefix} 必须是 JSON 对象`)];
  const add = (section, message, severity = 'error') => issues.push(ruleIssue(section, `${prefix} ${message}`, severity));
  for (const field of ruleRequiredFields) if (!(field in record)) add('schema', `缺少必填字段：${field}`);
  for (const field of Object.keys(record)) if (!ruleAllowedFields.has(field)) add('schema', `存在未定义字段：${field}`);
  if (typeof record['session  id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record['session  id'] || '')) add('schema', 'session  id 必须是小写 UUID');
  if (typeof record.bug_id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.bug_id || '')) add('schema', 'bug_id 必须是 kebab-case 小写标识');
  if (records.filter((item) => item?.bug_id === record.bug_id).length > 1) add('principle', 'bug_id 在本次导出中重复，违反“一行一道题”原则');
  if (records.filter((item) => item?.['session  id'] === record['session  id']).length > 1) add('principle', 'session  id 在本次导出中重复，不能代表唯一有效运行');
  if (!['diagnosis', 'bugfix'].includes(record.task_type)) add('schema', 'task_type 只能是 diagnosis 或 bugfix');
  if (!ruleBugCategories.has(record.bug_category)) add('schema', 'bug_category 不在规则枚举中');
  for (const message of getGoVersionRuleIssues(record.go_version)) add('setup', message);
  if (record.repro_determinism !== 'deterministic') add('process', 'repro_determinism 必须为 deterministic');
  if (record.repro_determinism === 'deterministic' && !hasRepeatEvidence(`${record.verify_result || ''}\n${record.harness || ''}\n${record.verify_cmds || ''}`)) add('process', '验证记录、harness 或 verify_cmds 必须提供确定性复现的重复次数');
  if (typeof record.user_query !== 'string' || !record.user_query.trim()) add('schema', 'user_query 不能为空');
  if (typeof record.trajectory !== 'string' || !record.trajectory.trim()) add('schema', 'trajectory 不能为空');
  if (typeof record.trajectory === 'string' && record.trajectory.length > 32767) add('delivery', 'trajectory 超过 Excel 单元格 32,767 字符上限');
  const query = record.user_query || '';
  const trajectory = record.trajectory || '';
  const trajectoryIsUrl = isTrajectoryUrl(trajectory);
  const verify = record.verify_result || '';
  const verificationV5 = typeof verify === 'string' && /^\s*\{/.test(verify);
  const rootCause = record.gold_root_cause || '';
  const repoUrl = record.repo_url || '';
  const success = record.success_criteria || '';
  const harness = record.harness || '';
  if (typeof query === 'string' && query.trim() && !isChineseDescription(query)) add('delivery', 'user_query 必须以中文为主体，Go 标识符可以保留英文，但不能夹带英文叙述段落');
  if (hasAny(query, [/fix_commit/i, /parent_sha/i, /gold/i, /hidden\s+test/i, /上游 issue/i, /修复提交/i, /隐藏测试/i, /github\.com\/[^\s]+\/(?:commit|issues?|pull)/i])) add('principle', 'user_query 疑似泄漏修复提交、标准答案、隐藏验收或上游证据');
  // Natural request wording and task-specific phrasing are completed in the
  // Bug workbench after technical discovery and BUG_BASE preparation. They
  // must not reject an otherwise valid export.
  if (trajectoryIsUrl && !isCloudTrajectoryFileUrl(trajectory)) add('delivery', 'trajectory 云端链接必须指向 JSON 或 JSONL 文件');
  if (typeof trajectory === 'string' && record['session  id'] && !trajectory.includes(record['session  id'])) add('process', 'trajectory 未包含对应 session  id，无法证明是该轮真实轨迹');
  if (!trajectoryIsUrl && typeof trajectory === 'string' && record.generator_model && !trajectory.includes(record.generator_model)) add('process', 'trajectory 未包含 generator_model，无法证明模型来源');
  if (!trajectoryIsUrl && typeof trajectory === 'string' && (/^(trajectory content|summary|摘要|待补充|未提供|trajectory_[\w-]+\.(txt|json))$/i.test(trajectory.trim()) || /完整原始.*(见|附件|工作表)|逐字符还原|附件名|轨迹摘要|chunk_text/i.test(trajectory))) add('delivery', 'trajectory 不能是摘要、占位符、附件名或分块说明，必须是完整原始 UTF-8 文字正文或校验后上传的 HTTPS 链接');
  const trajectoryInfo = trajectoryIsUrl ? { events: [], parseError: '', toolUses: 0, toolResults: 0, toolsBalanced: true } : inspectTrajectory(trajectory);
  if (!trajectoryIsUrl && typeof trajectory === 'string' && (!trajectoryInfo.events.length || trajectoryInfo.parseError)) add('process', trajectoryInfo.parseError || 'trajectory 必须能解析为原始 Agent 事件（JSON 数组或 JSONL），或填写校验后上传的 HTTPS 链接');
  // Main trajectory content is captured as source evidence. Tool pairing and
  // parent-chain quality belong to optional diagnostics, never an export gate.
  if (typeof record.verify_cmds !== 'string' || !record.verify_cmds.trim()) add('schema', 'verify_cmds 不能为空，必须填写实际可执行的验证命令');
  if (typeof record.verify_cmds === 'string' && record.verify_cmds.trim() && record.task_type) {
    try {
      if (verificationV5) requireDirectPublicVerifyCmd(record.verify_cmds, record.task_type, record.bug_id, {
        concurrency: isConcurrencyVerificationRecord(record),
      });
      else requireDockerVerifyCmds(record.verify_cmds, record.task_type, record.bug_id);
    } catch (error) {
      add('process', error.message);
    }
  }
  if (typeof record.verify_cmds === 'string' && !hasTargetVerifyEvidence(record.verify_cmds)) add('process', 'verify_cmds 必须包含目标验收命令（如 run_target.sh、go test -run 或明确的目标测试）');
  if (!verificationV5 && typeof record.verify_cmds === 'string' && !hasFullVerifyEvidence(record.verify_cmds)) add('process', '旧版 verify_cmds 必须包含全量回归命令（如 run_full.sh 或 go test ./...）');
  if (typeof rootCause !== 'string' || !rootCause.trim()) add('delivery', 'gold_root_cause 必须填写 Gold 文件、符号和失效机制');
  for (const message of getHardRuleIssues({ ...record, verification_policy_version: verificationV5 ? VERIFICATION_POLICY_VERSION : 0 }, { includeGoVersion: false })) add('delivery', message);
  if (typeof rootCause === 'string' && rootCause.trim() && !isChineseDescription(rootCause)) add('delivery', 'gold_root_cause 必须以中文为主体，文件名、函数名和 Go 标识符可以保留英文，但不能夹带英文叙述段落');
  if (typeof rootCause === 'string' && /`/.test(rootCause)) add('delivery', 'gold_root_cause 不得包含 Markdown 反引号，导出时会自动清理');
  const expectedGitRole = record.task_type === 'diagnosis' ? 'red' : record.task_type === 'bugfix' ? 'green' : '';
  if (typeof repoUrl !== 'string' || !isGitTestModelBranchUrl(repoUrl, expectedGitRole)) {
    add('delivery', `repo_url 必须是显式 ${expectedGitRole || 'red/green'} 分支地址；test_model_fix 等无法识别红绿角色的分支禁止提交`);
  }
  if (typeof success !== 'string' || success.trim().length < 20 || !isChineseDescription(success)) add('delivery', 'success_criteria 必须使用中文填写可观察、可自动验收的完成条件，不能夹带英文叙述段落');
  if (record.task_type === 'diagnosis' && (typeof success !== 'string' || !hasAny(success, [/诊断|调查|定位|根因|复现|证据|行为|diagnos|investigat|locat|root\s*cause|reproduc|evidence|behavio(?:u)?r|failure|issue/i]) || !hasAny(success, [/不修改|不得|禁止|无代码|工作区.*(一致|未改|零)|no\s+(?:code|source)\s+(?:change|modif)|without\s+(?:changing|modif)|read[- ]only|unchanged|pristine|workspace.*(?:unchanged|untouched)|must\s+not\s+(?:modify|change)/i]))) add('delivery', 'diagnosis 的 success_criteria 必须以正确根因/调查证据为终点，并明确禁止代码修改');
  if (record.task_type === 'bugfix' && (typeof success !== 'string' || !hasAny(success, [/目标|修复|行为|验收|测试|target|fix|repair|behavio(?:u)?r|accept|test|issue/i]) || !hasAny(success, [/回归|全量|相关测试|测试通过|通过|regression|full[- ]suite|related\s+tests?|tests?\s+(?:pass|passing)|pass(?:ed)?|green/i]) || !hasAny(success, [/禁止|不得|不能|规避|no\s+workaround|without\s+(?:a\s+)?workaround|must\s+not\s+(?:skip|weaken)|do\s+not\s+(?:skip|weaken|bypass)|no\s+bypass/i]))) add('delivery', 'bugfix 的 success_criteria 必须覆盖目标行为、相关/全量回归和禁止规避项');
  if (!verificationV5 && !/^(PASS|FAIL)\b/.test(verify)) add('schema', 'verify_result 必须以 PASS 或 FAIL 开头');
  if (!verificationV5 && verify.startsWith('PASS')) {
    if (record.task_type === 'diagnosis' && (!hasAny(verify, [/复现|repro|panic|失败|错误|异常/i]) || !hasAny(verify, [/根因|定位|诊断|源码|调用|机制|一致/i]) || !hasAny(verify, [/未修改|不修改|无代码|工作区.*(一致|未改|零)|pristine/i]) || !hasRepeatEvidence(verify))) add('process', 'diagnosis 的 verify_result=PASS 必须证明可重复复现、诊断命中根因且工作区无代码修改');
    if (record.task_type === 'bugfix' && (!hasTargetVerifyEvidence(verify) || !hasFullVerifyEvidence(verify) || !hasRepeatEvidence(verify))) add('process', 'bugfix 的 verify_result=PASS 必须证明修复后目标验收、全量回归和重复运行；适用的静态检查可作为补充证据');
  }
  if (typeof harness !== 'string' || harness.trim().length < 20 || !hasAny(harness, [/CLI|后端|backend/i]) || !hasAny(harness, [/隔离|workspace|容器|镜像|platform|平台/i]) || !hasAny(harness, [/Go|go\d/i]) || !hasAny(harness, [/公开|public|隐藏|hidden|grader|target/i]) || !hasAny(harness, [/重复|repeat|runs?|\b\d+\/\d+\b/i])) add('process', 'harness 必须记录后端、隔离方式、平台/镜像、Go/CLI 版本、系统侧目标测试和重复次数');
  if (typeof harness === 'string' && !/\bbackend\s*=\s*docker-target\b/i.test(harness)) add('process', 'harness 必须填写 backend=docker-target，且目标与全量验收须在 Docker 中真实执行');
  for (const issue of getClaudeHarnessIssues(harness)) add('process', `harness ${issue}`);
  for (const field of ['gold_root_cause', 'success_criteria', 'harness', 'generator_model']) if (typeof record[field] !== 'string' || !record[field].trim()) add('schema', `${field} 不能为空`);
  return issues;
}

function validateRuleSet(records) {
  return records.flatMap((record, index) => validateRuleRecord(record, index, records));
}

function normalizeValidationInput(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.tasks)) return value.tasks;
  return [value];
}

function taskToRuleRecord(task) {
  const harness = sanitizeHarness(task.harness || [
    'backend=docker-target',
    'isolation=independent-workspace-without-.git + external-hidden-grader',
    'platform=linux/arm64,linux/amd64',
    'go=go1.25.6',
    'hidden_target_runs=20/20',
  ].join('; ') + ';');
  return {
    'session  id': task.sessionId || '',
    bug_id: task.bug_id || '',
    task_type: task.task_type || '',
    bug_category: task.bug_category || '',
    repo_url: task.repo_url || '',
    go_version: resolvePinnedGoVersion(task.go_version, task.go_mod_version),
    repro_determinism: task.repro_determinism || '',
    user_query: task.user_query || '',
    trajectory: task.trajectoryUrl || task.trajectory || '',
    verify_cmds: Array.isArray(task.verify_cmds) ? task.verify_cmds.join('\n') : (task.verify_cmds || ''),
    gold_root_cause: task.gold_root_cause || '',
    success_criteria: task.success_criteria || '',
    verify_result: task.verify_result || '',
    harness,
    generator_model: task.generator_model || '',
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${formatNumber(bytes)} B`;
}

const completionTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatCompletionTime(value) {
  if (!value) return '未完成';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间无效' : completionTimeFormatter.format(date).replaceAll('/', '-');
}

function projectGeneratorLabel(task) {
  if (task?.project_generator !== 'claude_code_cli') return '生成器未记录';
  return task.project_generation_provider === 'deepseek'
    ? `Claude Code CLI（DeepSeek ${task.project_generation_model || 'V4 Pro'}）`
    : 'Claude Code CLI（原有模型）';
}

function completionDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59.999+08:00' : 'T00:00:00.000+08:00';
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function normalizeApiTask(task) {
  const repoName = task.project_origin === 'generated_0to1'
    ? '本地生成项目'
    : String(task.repository || '').replace('https://github.com/', '').replace(/\.git$/, '') || '历史项目';
  return {
    ...task,
    go_version: resolvePinnedGoVersion(task.go_version, task.go_mod_version),
    title: task.title || task.bug_id,
    repoName,
    sessionId: task.sessionId,
    eventCount: task.eventCount || 0,
    totalBytes: task.totalBytes || 0,
    chunkCount: task.chunkCount || 0,
    status: task.status || 'queued',
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
  };
}

function hasRecordedTrajectoryUpload(task) {
  return Boolean(task?.trajectoryUploadRecorded)
    || isCloudTrajectoryUrl(task?.trajectoryUrl || task?.trajectory || '');
}

async function downloadTaskTrajectory(task) {
  if (!task.id) throw new Error('任务缺少可用于导出轨迹的 ID');
  const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/trajectory`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || '轨迹 JSON 导出失败');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const matchedFilename = disposition.match(/filename="([^"]+)"/i)?.[1];
  const filename = matchedFilename || `trajectory_${task.sessionId || task.id}.jsonl`;
  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportExcel(tasks) {
  const rows = tasks.map((task) => prepareExcelRecord({
    ...taskToRuleRecord(task),
    verification_policy_version: task.verification_policy_version || 0,
    test_model_fix_session_id: task.test_model_fix_session_id || '',
  }));
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.json_to_sheet(rows, { header: ruleRequiredFields });
  const columnWidths = [38, 38, 12, 20, 68, 26, 20, 64, 64, 64, 64, 76, 76, 64, 32];
  sheet['!cols'] = columnWidths.map((wch) => ({ wch }));
  sheet['!autofilter'] = { ref: `A1:O${rows.length + 1}` };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '智能表1');
  const content = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([content], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `GO语言标注-通过题目-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [completedFrom, setCompletedFrom] = useState('');
  const [completedTo, setCompletedTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [refreshed, setRefreshed] = useState('刚刚');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runState, setRunState] = useState({ status: 'idle', message: '等待启动', total: 0, completed: 0, failed: 0, currentTasks: [], concurrency: 4, queue: [], logs: [] });
  const [pendingCount, setPendingCount] = useState(0);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [regenerateTaskIds, setRegenerateTaskIds] = useState([]);
  const [regenerateFeedback, setRegenerateFeedback] = useState('');
  const [regenerateBusy, setRegenerateBusy] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [reviewFilter, setReviewFilter] = useState('all');
  const [trajectoryUploadFilter, setTrajectoryUploadFilter] = useState('all');
  const [exportCountFilter, setExportCountFilter] = useState('all');
  // A bulk status action should start in the non-destructive review state.
  // The list itself still defaults to showing all review statuses.
  const [reviewTargetStatus, setReviewTargetStatus] = useState('pending');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');
  const [runError, setRunError] = useState('');
  const [excelExportProgress, setExcelExportProgress] = useState({ busy: false, phase: '', completed: 0, total: 0 });
  const [excelRejectedTaskIds, setExcelRejectedTaskIds] = useState(() => new Set());
  const [trajectoryExportBusy, setTrajectoryExportBusy] = useState(false);
  const [exportFeedback, setExportFeedback] = useState({ message: '', error: false });
  const [showRuleValidator, setShowRuleValidator] = useState(false);
  const [ruleInput, setRuleInput] = useState('');
  const [ruleResult, setRuleResult] = useState(null);
  const [ruleFileName, setRuleFileName] = useState('');
  const [cloudState, setCloudState] = useState({ connected: false, connectedAs: '', autoLoginConfigured: false, lastCheckedAt: null, lastRefreshedAt: null, lastError: '', uploads: [] });
  const [showCloudLogin, setShowCloudLogin] = useState(false);
  const [cloudUsername, setCloudUsername] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState('');
  const [submissionPlatformState, setSubmissionPlatformState] = useState({ connected: false, connectedAs: '', autoLoginConfigured: false, syncPaused: false, syncPausedAt: null, syncPauseReason: '', deferredSubmissionCount: 0, lastCheckedAt: null, lastRefreshedAt: null, lastError: '', reviewLastSyncedAt: null, reviewLastError: '', pendingRepairCount: 0, reviewCounts: {}, submittedCount: 0, submissions: [] });
  const [showSubmissionPlatformLogin, setShowSubmissionPlatformLogin] = useState(false);
  const [submissionPlatformUsername, setSubmissionPlatformUsername] = useState('');
  const [submissionPlatformPassword, setSubmissionPlatformPassword] = useState('');
  const [submissionPlatformBusy, setSubmissionPlatformBusy] = useState(false);
  const [submissionPlatformMessage, setSubmissionPlatformMessage] = useState('');
  const [showTrajectoryUpload, setShowTrajectoryUpload] = useState(false);
  const [trajectoryFiles, setTrajectoryFiles] = useState([]);
  const [trajectoryUploadMessage, setTrajectoryUploadMessage] = useState('');
  const [trajectoryDragActive, setTrajectoryDragActive] = useState(false);
  const [pipelineJobs, setPipelineJobs] = useState([]);
  const [pipelineRuntime, setPipelineRuntime] = useState({ autoFillEnabled: false, controlMode: 'paused', activeCount: 0, activeWeight: 0, waitingResourceCount: 0, maxConcurrency: 4, effectiveMaxConcurrency: 4, maxAutoRetries: 2, draftCount: 0, resourcePools: {}, distributedWorkers: { enabled: false, workers: [] }, refill: { status: 'idle', plannedCount: 0, createdCount: 0, largeProjectCanary: { status: 'idle', targetCount: 0, remainingCount: 0, createdJobIds: [] } }, submissionQuality: { blockedContributors: [], incidentCount: 0 } });
  const [systemHealth, setSystemHealth] = useState({ updatedAt: null, services: {}, rollout: { mode: 'drain_to_v2', canaryJobId: '' }, watchdog: { activeIncidentCount: 0, triaging: false, incidents: [] } });
  const [pipelineCreatedFrom, setPipelineCreatedFrom] = useState('');
  const [pipelineCreatedTo, setPipelineCreatedTo] = useState('');
  const [pipelineStatusFilter, setPipelineStatusFilter] = useState('all');
  const [pipelineQuery, setPipelineQuery] = useState('');
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineMessage, setPipelineMessage] = useState('');
  const [userQueryDrafts, setUserQueryDrafts] = useState({});
  const [workbenchNow, setWorkbenchNow] = useState(() => Date.now());
  const [pipelineRepositoryStatus, setPipelineRepositoryStatus] = useState({ connected: false, loading: true, owner: '', nextName: '', repository: '', message: '' });
  const [pipelineForm, setPipelineForm] = useState({
    projectBrief: '',
    bugCount: DEFAULT_BUG_COUNT,
    projectTier: 'standard',
    taskType: 'bugfix',
    maxTrajectoryAttempts: 3,
    creator: 'niuyuhang',
  });
  const trajectoryFileInputRef = useRef(null);
  const syncRunnerRequestRef = useRef(null);
  const excelExportLockRef = useRef(false);
  const trajectoryExportLockRef = useRef(false);

  const mergeCloudUploads = (sourceTasks, uploads = [...cloudUploadMap.values()]) => {
    const uploadMap = new Map(uploads.filter((item) => !item.artifactKind || item.artifactKind === 'main').map((item) => [item.taskId, item]));
    return sourceTasks.map((task) => {
      const upload = uploadMap.get(task.id);
      return upload?.signedUrl ? { ...task, trajectoryUrl: upload.signedUrl, cloudUpload: upload } : task;
    });
  };

  const applyCloudState = (payload) => {
    const next = {
      connected: Boolean(payload.connected),
      connectedAs: payload.connectedAs || '',
      autoLoginConfigured: Boolean(payload.autoLoginConfigured),
      lastCheckedAt: payload.lastCheckedAt || null,
      lastRefreshedAt: payload.lastRefreshedAt || null,
      lastError: payload.lastError || '',
      uploads: Array.isArray(payload.uploads) ? payload.uploads : [],
    };
    cloudUploadMap = new Map(next.uploads.filter((item) => !item.artifactKind || item.artifactKind === 'main').map((item) => [item.taskId, item]));
    setCloudState(next);
    setTasks((current) => mergeCloudUploads(current, next.uploads));
  };

  const syncCloud = async () => {
    try {
      const response = await fetch('/api/cloud/status');
      if (response.ok) applyCloudState(await response.json());
    } catch {}
  };

  const applySubmissionPlatformState = (payload) => {
    setSubmissionPlatformState({
      connected: Boolean(payload.connected),
      connectedAs: payload.connectedAs || '',
      autoLoginConfigured: Boolean(payload.autoLoginConfigured),
      syncPaused: Boolean(payload.syncPaused),
      syncPausedAt: payload.syncPausedAt || null,
      syncPauseReason: payload.syncPauseReason || '',
      deferredSubmissionCount: Number(payload.deferredSubmissionCount || 0),
      lastCheckedAt: payload.lastCheckedAt || null,
      lastRefreshedAt: payload.lastRefreshedAt || null,
      lastError: payload.lastError || '',
      reviewLastSyncedAt: payload.reviewLastSyncedAt || null,
      reviewLastError: payload.reviewLastError || '',
      pendingRepairCount: Number(payload.pendingRepairCount || 0),
      reviewCounts: payload.reviewCounts && typeof payload.reviewCounts === 'object' ? payload.reviewCounts : {},
      submittedCount: Number(payload.submittedCount || 0),
      submissions: Array.isArray(payload.submissions) ? payload.submissions : [],
    });
  };

  const syncSubmissionPlatform = async () => {
    try {
      const response = await fetch('/api/submission-platform/status');
      if (response.ok) applySubmissionPlatformState(await response.json());
    } catch {}
  };

  const syncRunner = () => {
    if (syncRunnerRequestRef.current) return syncRunnerRequestRef.current;
    const request = (async () => {
      try {
        const response = await fetch('/api/run/status');
        if (!response.ok) return;
        const payload = await response.json();
        setRunState(payload.state);
        setPendingCount(payload.pendingCount);
        if (Array.isArray(payload.tasks)) {
          setTasks((current) => payload.tasks.map((task) => {
            const existing = current.find((item) => item.id === task.id);
            const exportRecord = labelExportRecordMap.get(task.bug_id) || {};
            const normalized = { ...exportRecord, ...existing, ...normalizeApiTask(task) };
            const upload = cloudUploadMap.get(task.id);
            return upload?.signedUrl ? { ...normalized, trajectoryUrl: upload.signedUrl, cloudUpload: upload } : normalized;
          }));
        }
      } catch {
        // The page still works in read-only mode if the local runner is offline.
      }
    })();
    syncRunnerRequestRef.current = request;
    request.finally(() => {
      if (syncRunnerRequestRef.current === request) syncRunnerRequestRef.current = null;
    });
    return request;
  };

  const syncPipeline = async () => {
    try {
      const response = await fetch('/api/pipeline/jobs');
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.jobs)) setPipelineJobs(payload.jobs);
      setPipelineRuntime({
        autoFillEnabled: Boolean(payload.autoFillEnabled),
        activeCount: Number(payload.activeCount) || 0,
        activeWeight: Number(payload.activeWeight) || 0,
        waitingResourceCount: Number(payload.waitingResourceCount) || 0,
        maxConcurrency: Number(payload.maxConcurrency) || 4,
        effectiveMaxConcurrency: Number(payload.effectiveMaxConcurrency) || 0,
        resourcePools: payload.resourcePools || {},
        distributedWorkers: payload.distributedWorkers || { enabled: false, workers: [] },
        maxAutoRetries: Number(payload.maxAutoRetries) || 2,
        controlMode: payload.controlMode || (payload.autoFillEnabled ? 'running' : 'paused'),
        budget: payload.budget || null,
        resourcePolicy: payload.resourcePolicy || null,
        resourceMaintenance: payload.resourceMaintenance || { status: 'idle' },
        performance: payload.performance || null,
        draftCount: Number(payload.draftCount) || 0,
        rollout: payload.rollout || { mode: 'drain_to_v2', canaryJobId: '', legacyActiveCount: 0 },
        refill: payload.refill || { status: 'idle', plannedCount: 0, createdCount: 0, largeProjectCanary: { status: 'idle', targetCount: 0, remainingCount: 0, createdJobIds: [] } },
        submissionQuality: payload.submissionQuality || { blockedContributors: [], incidentCount: 0 },
      });
    } catch {
      // Existing task management remains available when the pipeline API is offline.
    }
  };

  const syncSystemHealth = async () => {
    try {
      const response = await fetch('/api/system/health');
      if (response.ok) setSystemHealth(await response.json());
    } catch {}
  };

  const syncPipelineRepository = async () => {
    setPipelineRepositoryStatus((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch('/api/pipeline/repository/next');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'GitHub 自动仓库状态读取失败');
      setPipelineRepositoryStatus({ ...payload, loading: false, message: '' });
    } catch (error) {
      setPipelineRepositoryStatus({ connected: false, loading: false, owner: '', nextName: '', repository: '', message: error.message });
    }
  };

  const refresh = async () => {
    setIsRefreshing(true);
    await Promise.all([syncRunner(), syncCloud(), syncSubmissionPlatform(), syncPipeline(), syncPipelineRepository(), syncSystemHealth()]);
    setRefreshed('刚刚');
    window.setTimeout(() => setIsRefreshing(false), 400);
  };

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const response = await fetch('/label_export_records.json');
        if (response.ok) {
          const records = await response.json();
          if (Array.isArray(records)) labelExportRecordMap = new Map(records.map((item) => [item.bug_id, item]));
        }
      } catch {}
      if (!cancelled) await refresh();
    };
    initialize();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    syncRunner();
    const events = new EventSource('/api/run/events');
    let syncTimer = null;
    const scheduleSync = () => {
      if (syncTimer) window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        syncTimer = null;
        void syncRunner();
        void syncCloud();
        void syncSubmissionPlatform();
        void syncPipeline();
        void syncSystemHealth();
      }, 250);
    };
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.state) setRunState(payload.state);
      if (['data', 'pipeline', 'complete'].includes(payload.type)) scheduleSync();
    };
    const timer = window.setInterval(scheduleSync, 30_000);
    return () => { events.close(); window.clearInterval(timer); if (syncTimer) window.clearTimeout(syncTimer); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setWorkbenchNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const updatePipelineForm = (field, value) => setPipelineForm((current) => ({ ...current, [field]: value }));

  const createPipeline = async (event) => {
    event.preventDefault();
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch('/api/pipeline/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pipelineForm),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '流水线作业创建失败');
      setPipelineMessage(payload.message);
      setPipelineForm((current) => ({ ...current, projectBrief: '' }));
      await Promise.all([syncPipeline(), syncPipelineRepository()]);
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const controlPipeline = async (job, action) => {
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '流水线操作失败');
      setPipelineMessage(payload.message);
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const controlBugWorkbench = async (job, bugIndex, action, autoContinue = true) => {
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/bugs/${bugIndex}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoContinue }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Bug 工作台操作失败');
      setPipelineMessage(payload.message);
      if (payload.job?.id) {
        setPipelineJobs((current) => current.map((item) => item.id === payload.job.id ? payload.job : item));
      }
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const resetBugAttempts = async (job, bugIndex) => {
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/bugs/${bugIndex}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Bug 尝试次数重置失败');
      setPipelineMessage(payload.message);
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const resolveInjectionReview = async (job, action) => {
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/injection-review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '注入复核处理失败');
      setPipelineMessage(payload.message);
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const updateBugWorkbenchSettings = async (job, changes) => {
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/bug-workbench`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Bug 工作台设置保存失败');
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const reviewBugUserQuery = async (job, bug, confirm) => {
    const key = `${job.id}:${bug.bugIndex}`;
    const userQuery = userQueryDrafts[key] ?? bug.discovery?.user_query ?? '';
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/bugs/${bug.bugIndex}/user-query`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_query: userQuery, confirm }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'user_query 保存失败');
      setPipelineMessage(payload.message);
      if (payload.job?.id) setPipelineJobs((current) => current.map((item) => item.id === payload.job.id ? payload.job : item));
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const confirmAllBugUserQueries = async (job, bugs) => {
    const pending = bugs.filter((bug) => {
      const stage = (job.stages || []).find((item) => item.id === `bug${bug.bugIndex}_user_query_review`);
      return stage && !['passed', 'skipped'].includes(stage.status);
    });
    if (!pending.length) return;
    setPipelineBusy(true);
    setPipelineMessage('正在保存并确认全部 user_query…');
    try {
      for (const bug of pending) {
        const key = `${job.id}:${bug.bugIndex}`;
        const userQuery = (userQueryDrafts[key] ?? bug.discovery?.user_query ?? '').trim();
        const response = await fetch(`/api/pipeline/jobs/${encodeURIComponent(job.id)}/bugs/${bug.bugIndex}/user-query`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_query: userQuery, confirm: true }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `Bug ${bug.bugIndex} user_query 确认失败`);
      }
      setPipelineMessage('全部 user_query 已确认，流水线继续执行');
      await syncPipeline();
    } catch (error) {
      setPipelineMessage(error.message);
      await syncPipeline();
    } finally {
      setPipelineBusy(false);
    }
  };

  const setPipelineControl = async (mode) => {
    if (mode === 'emergency_stopped' && !window.confirm('确认紧急停止全部流水线 Runner？未完成阶段会被标记为停止。')) return;
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch('/api/pipeline/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '流水线控制失败');
      setPipelineMessage(payload.message);
      await Promise.all([syncPipeline(), syncSystemHealth()]);
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const cleanDockerResources = async () => {
    if (!window.confirm('仅在没有流水线运行时清理 7 天前的 Docker 构建缓存和悬空镜像，确认继续？')) return;
    setPipelineBusy(true);
    setPipelineMessage('');
    try {
      const response = await fetch('/api/system/maintenance/docker', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Docker 清理失败');
      setPipelineMessage(payload.message);
      await syncSystemHealth();
    } catch (error) {
      setPipelineMessage(error.message);
    } finally {
      setPipelineBusy(false);
    }
  };

  const startRun = async () => {
    setRunError('');
    try {
      const response = await fetch('/api/run/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ concurrency: 4 }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '启动失败');
      setRunState((current) => ({ ...current, status: 'running', message: payload.message, total: payload.queue.length, concurrency: payload.concurrency, queue: payload.queue }));
    } catch (error) {
      setRunError(error.message);
    }
  };

  const stopRun = async () => {
    setRunError('');
    try {
      const response = await fetch('/api/run/stop', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '停止失败');
    } catch (error) {
      setRunError(error.message);
    }
  };

  const connectCloud = async (event) => {
    event.preventDefault();
    setCloudBusy(true);
    setCloudMessage('');
    try {
      const response = await fetch('/api/cloud/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: cloudUsername, password: cloudPassword }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '云盘连接失败');
      applyCloudState(payload);
      setCloudPassword('');
      setShowCloudLogin(false);
      setCloudMessage(payload.message);
    } catch (error) {
      setCloudMessage(error.message);
    } finally {
      setCloudPassword('');
      setCloudBusy(false);
    }
  };

  const openCloudLogin = () => {
    setCloudUsername((current) => current || cloudState.connectedAs || '');
    setCloudMessage('');
    setShowCloudLogin(true);
  };

  const disconnectCloud = async () => {
    setCloudBusy(true);
    setCloudMessage('');
    try {
      const response = await fetch('/api/cloud/disconnect', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '云盘断开失败');
      applyCloudState(payload);
      setCloudPassword('');
      setCloudMessage(payload.message);
    } catch (error) {
      setCloudMessage(error.message);
      await syncCloud();
    } finally {
      setCloudBusy(false);
    }
  };

  const connectSubmissionPlatform = async (event) => {
    event.preventDefault();
    setSubmissionPlatformBusy(true);
    setSubmissionPlatformMessage('');
    try {
      const response = await fetch('/api/submission-platform/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: submissionPlatformUsername, password: submissionPlatformPassword }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '提交平台连接失败');
      applySubmissionPlatformState(payload);
      setShowSubmissionPlatformLogin(false);
      setSubmissionPlatformMessage(payload.message);
    } catch (error) {
      setSubmissionPlatformMessage(error.message);
    } finally {
      setSubmissionPlatformPassword('');
      setSubmissionPlatformBusy(false);
    }
  };

  const openSubmissionPlatformLogin = () => {
    setSubmissionPlatformUsername((current) => current || submissionPlatformState.connectedAs || '');
    setSubmissionPlatformMessage('');
    setShowSubmissionPlatformLogin(true);
  };

  const disconnectSubmissionPlatform = async () => {
    setSubmissionPlatformBusy(true);
    setSubmissionPlatformMessage('');
    try {
      const response = await fetch('/api/submission-platform/disconnect', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '提交平台断开失败');
      applySubmissionPlatformState(payload);
      setSubmissionPlatformMessage(payload.message);
    } catch (error) {
      setSubmissionPlatformMessage(error.message);
      await syncSubmissionPlatform();
    } finally {
      setSubmissionPlatformBusy(false);
    }
  };

  const controlSubmissionPlatform = async (paused) => {
    setSubmissionPlatformBusy(true);
    setSubmissionPlatformMessage('');
    try {
      const response = await fetch('/api/submission-platform/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '提交平台控制失败');
      applySubmissionPlatformState(payload);
      setSubmissionPlatformMessage(payload.message);
    } catch (error) {
      setSubmissionPlatformMessage(error.message);
      await syncSubmissionPlatform();
    } finally {
      setSubmissionPlatformBusy(false);
    }
  };

  const openTrajectoryUpload = () => {
    setTrajectoryFiles([]);
    setTrajectoryUploadMessage('');
    setTrajectoryDragActive(false);
    setShowTrajectoryUpload(true);
  };

  const addTrajectoryFiles = (files) => {
    const selected = [];
    const rejected = [];
    for (const file of Array.from(files || [])) {
      try {
        selected.push({
          file,
          sessionId: extractTrajectorySessionId(file.name),
          status: 'ready',
          message: '等待上传',
        });
      } catch (error) {
        rejected.push(`${file.name}：${error.message}`);
      }
    }
    setTrajectoryFiles((current) => {
      const next = new Map(current.map((item) => [item.file.name, item]));
      for (const item of selected) next.set(item.file.name, item);
      return [...next.values()];
    });
    setTrajectoryUploadMessage(rejected.length ? rejected.join('；') : '');
  };

  const updateTrajectoryFile = (filename, patch) => {
    setTrajectoryFiles((current) => current.map((item) => (
      item.file.name === filename ? { ...item, ...patch } : item
    )));
  };

  const uploadSelectedTrajectories = async () => {
    if (!cloudState.connected) {
      setTrajectoryUploadMessage('请先连接轨迹云盘，再开始上传');
      openCloudLogin();
      return;
    }
    setCloudBusy(true);
    setCloudMessage('');
    setTrajectoryUploadMessage('');
    let uploadedCount = 0;
    let failedCount = 0;
    for (const item of trajectoryFiles) {
      updateTrajectoryFile(item.file.name, { status: 'uploading', message: '正在校验并上传' });
      try {
        const response = await fetch('/api/cloud/upload-file', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-trajectory-filename': encodeURIComponent(item.file.name),
          },
          body: item.file,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || '轨迹上传失败');
        applyCloudState(payload);
        uploadedCount += 1;
        updateTrajectoryFile(item.file.name, {
          status: 'uploaded',
          message: payload.uploaded?.skipped ? '已存在，签名链接已匹配' : '已上传，签名链接已匹配',
        });
      } catch (error) {
        failedCount += 1;
        updateTrajectoryFile(item.file.name, { status: 'failed', message: error.message });
        if (/登录|连接/.test(error.message)) {
          setShowCloudLogin(true);
          break;
        }
      }
    }
    const message = failedCount
      ? `上传完成：${uploadedCount} 个成功，${failedCount} 个失败`
      : `已上传并匹配 ${uploadedCount} 个永久签名链接`;
    setTrajectoryUploadMessage(message);
    setCloudMessage(message);
    setCloudBusy(false);
  };

  const validateRuleJson = (raw = ruleInput) => {
    setRuleResult(null);
    if (!raw.trim()) {
      setRuleResult({ ok: false, issues: [ruleIssue('schema', '请粘贴 JSON 内容或选择 JSON 文件')] });
      return;
    }
    try {
      const records = normalizeValidationInput(JSON.parse(raw));
      const issues = validateRuleSet(records);
      setRuleResult({ ok: issues.length === 0, count: records.length, issues });
    } catch (error) {
      setRuleResult({ ok: false, issues: [ruleIssue('schema', `JSON 解析失败：${error.message}`)] });
    }
  };

  const validateTask = (task) => {
    setRuleInput(JSON.stringify(taskToRuleRecord(task), null, 2));
    setRuleFileName(`任务：${task.bug_id || task.title}`);
    setRuleResult(null);
    setShowRuleValidator(true);
  };

  const exportTaskTrajectory = async (task) => {
    if (trajectoryExportLockRef.current) return;
    trajectoryExportLockRef.current = true;
    setTrajectoryExportBusy(true);
    setExportFeedback({ message: '正在生成轨迹文件…', error: false });
    setRunError('');
    try {
      await downloadTaskTrajectory(task);
      setExportFeedback({ message: '轨迹文件已开始下载', error: false });
      await syncRunner();
    } catch (error) {
      setRunError(error.message);
      setExportFeedback({ message: error.message, error: true });
    } finally {
      trajectoryExportLockRef.current = false;
      setTrajectoryExportBusy(false);
    }
  };

  const exportSelectedTrajectories = async () => {
    if (trajectoryExportLockRef.current) return;
    trajectoryExportLockRef.current = true;
    setTrajectoryExportBusy(true);
    setExportFeedback({ message: `正在生成 ${selectedTaskIds.length} 条轨迹 ZIP…`, error: false });
    setRunError('');
    try {
      const response = await fetch('/api/trajectories/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks: selectedTaskIds }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || '批量轨迹导出失败');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || `trajectory-selected-${new Date().toISOString().slice(0, 10)}.zip`;
      downloadBlob(blob, filename);
      setExportFeedback({ message: `${selectedTaskIds.length} 条轨迹 ZIP 已开始下载`, error: false });
      await syncRunner();
    } catch (error) {
      setRunError(error.message);
      setExportFeedback({ message: error.message, error: true });
    } finally {
      trajectoryExportLockRef.current = false;
      setTrajectoryExportBusy(false);
    }
  };

  const exportExcelWithTracking = async (exportTasks, clearExportedSelection = false) => {
    if (!exportTasks.length || excelExportLockRef.current) return;
    excelExportLockRef.current = true;
    const total = exportTasks.length;
    setRunError('');
    setExportFeedback({ message: `正在校验 0/${total} 条 Excel 记录`, error: false });
    setExcelExportProgress({ busy: true, phase: 'validating', completed: 0, total });
    try {
      const validationTokens = [];
      const validatedTasks = [];
      const validationErrors = [];
      const validateBatch = async (batch) => {
        const response = await fetch('/api/tasks/export-record', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tasks: batch.map((task) => task.id), kind: 'excel', validateOnly: true, allowPartial: true }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Excel 导出校验失败');
        const failedById = new Map((payload.failures || []).map((failure) => [failure.taskId, failure]));
        const accepted = batch.filter((task) => !failedById.has(task.id));
        if (accepted.length && !payload.validationToken) throw new Error('Excel 导出校验缺少确认令牌');
        if (payload.validationToken) validationTokens.push(payload.validationToken);
        validatedTasks.push(...accepted);
        validationErrors.push(...batch
          .filter((task) => failedById.has(task.id))
          .map((task) => ({ task, message: failedById.get(task.id).message })));
      };
      let completed = 0;
      for (const batch of splitExportBatches(exportTasks)) {
        await validateBatch(batch);
        completed += batch.length;
        setExcelExportProgress({ busy: true, phase: 'validating', completed, total });
        setExportFeedback({ message: `正在校验 ${completed}/${total} 条 Excel 记录`, error: false });
      }
      if (!validatedTasks.length) throw new Error(validationErrors[0]?.message || '没有通过校验的 Excel 记录');
      const exportedTotal = validatedTasks.length;
      setExcelExportProgress({ busy: true, phase: 'generating', completed: exportedTotal, total: exportedTotal });
      setExportFeedback({ message: `校验完成，正在生成 ${exportedTotal} 条 Excel 记录`, error: false });
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      await exportExcel(validatedTasks);
      setExcelExportProgress({ busy: true, phase: 'recording', completed: exportedTotal, total: exportedTotal });
      setExportFeedback({ message: '文件已开始下载，正在登记导出次数', error: false });
      const recordResponse = await fetch('/api/tasks/export-record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks: validatedTasks.map((task) => task.id), kind: 'excel', validationTokens }),
      });
      const recordPayload = await recordResponse.json().catch(() => ({}));
      if (!recordResponse.ok) throw new Error(recordPayload.message || 'Excel 已生成，但导出次数登记失败');
      await syncRunner();
      if (clearExportedSelection) {
        const exportedTaskIds = new Set(validatedTasks.map((task) => task.id));
        setSelectedTaskIds((current) => current.filter((id) => !exportedTaskIds.has(id)));
      }
      const skipped = validationErrors.length
        ? `，跳过 ${validationErrors.length} 条：${validationErrors.slice(0, 3).map(({ task }) => task.bug_id || task.id).join('、')}${validationErrors.length > 3 ? ' 等' : ''}`
        : '';
      if (validationErrors.length) {
        setExcelRejectedTaskIds((current) => new Set([
          ...current,
          ...validationErrors.map(({ task }) => task.id),
        ]));
      }
      setExportFeedback({ message: `Excel 已导出 ${exportedTotal} 条记录${skipped}`, error: false });
    } catch (error) {
      setRunError(`Excel 导出已阻止：${error.message}`);
      setExportFeedback({ message: `Excel 导出失败：${error.message}`, error: true });
    } finally {
      excelExportLockRef.current = false;
      setExcelExportProgress({ busy: false, phase: '', completed: 0, total: 0 });
    }
  };

  const toggleTaskSelection = (taskId) => {
    setSelectedTaskIds((current) => current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]);
  };

  const openRegenerateConfirm = (taskIds = selectedTaskIds) => {
    const ids = [...new Set(taskIds)].filter(Boolean);
    if (!ids.length) return;
    setRegenerateTaskIds(ids);
    setRegenerateFeedback('');
    setShowRegenerateConfirm(true);
  };

  const regenerateTrajectories = async () => {
    setRegenerateBusy(true);
    setRunError('');
    try {
      const response = await fetch('/api/tasks/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks: regenerateTaskIds, feedback: regenerateFeedback }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '重新生成轨迹启动失败');
      setRunState((current) => ({ ...current, status: 'running', message: payload.message, total: payload.queue.length, completed: 0, failed: 0, concurrency: payload.concurrency, queue: payload.queue }));
      setSelectedTaskIds([]);
      setActiveTask(null);
      setShowRegenerateConfirm(false);
      await syncRunner();
    } catch (error) {
      setRunError(error.message);
    } finally {
      setRegenerateBusy(false);
    }
  };

  const updateSelectedReviewStatus = async () => {
    setRunError('');
    setReviewMessage('');
    setReviewBusy(true);
    try {
      const response = await fetch('/api/tasks/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks: selectedTaskIds, status: reviewTargetStatus }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '人工状态修改失败');
      setReviewMessage(payload.message);
      setSelectedTaskIds([]);
      await syncRunner();
    } catch (error) {
      setRunError(error.message);
    } finally {
      setReviewBusy(false);
    }
  };

  const handleRuleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setRuleFileName(file.name);
    setRuleInput(await file.text());
    setRuleResult(null);
  };

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const fitsFilter = filter === 'all' || task.task_type === filter;
    const fitsReview = reviewFilter === 'all' || task.reviewStatus === reviewFilter;
    const trajectoryUploaded = hasRecordedTrajectoryUpload(task);
    const fitsTrajectoryUpload = trajectoryUploadFilter === 'all'
      || (trajectoryUploadFilter === 'uploaded' && trajectoryUploaded)
      || (trajectoryUploadFilter === 'not-uploaded' && !trajectoryUploaded);
    const exportCount = Number(task.exportCount || 0);
    const fitsExportCount = exportCountFilter === 'all'
      || (exportCountFilter === '0' && exportCount === 0)
      || (exportCountFilter === '1' && exportCount === 1)
      || (exportCountFilter === '2' && exportCount === 2)
      || (exportCountFilter === '3-plus' && exportCount >= 3);
    const finishedTimestamp = task.finishedAt ? new Date(task.finishedAt).getTime() : null;
    const fromTimestamp = completionDateBoundary(completedFrom);
    const toTimestamp = completionDateBoundary(completedTo, true);
    const fitsCompletionTime = fromTimestamp == null && toTimestamp == null
      ? true
      : finishedTimestamp != null
        && !Number.isNaN(finishedTimestamp)
        && (fromTimestamp == null || finishedTimestamp >= fromTimestamp)
        && (toTimestamp == null || finishedTimestamp <= toTimestamp);
    const haystack = `${task.sessionId || ''} ${task.bug_id} ${task.repoName}`.toLowerCase();
    return fitsFilter && fitsReview && fitsTrajectoryUpload && fitsExportCount && fitsCompletionTime && haystack.includes(query.toLowerCase());
  }).sort((left, right) => {
    // Keep the queue chronological. Review and pipeline status are filters or
    // labels, not ordering criteria; otherwise failed/skipped rows jump ahead
    // of newer qualified rows.
    const leftFinished = left.finishedAt ? new Date(left.finishedAt).getTime() : 0;
    const rightFinished = right.finishedAt ? new Date(right.finishedAt).getTime() : 0;
    if (leftFinished !== rightFinished) return rightFinished - leftFinished;
    return String(left.bug_id || left.id).localeCompare(String(right.bug_id || right.id));
  }), [tasks, filter, reviewFilter, trajectoryUploadFilter, exportCountFilter, query, completedFrom, completedTo]);

  const filteredPipelineJobs = useMemo(() => pipelineJobs.filter((job) => {
    const fitsStatus = pipelineJobMatchesStatus(job, pipelineStatusFilter);
    const haystack = pipelineJobSearchText(job);
    const fitsQuery = haystack.includes(pipelineQuery.trim().toLowerCase());
    const createdTimestamp = job.createdAt ? new Date(job.createdAt).getTime() : null;
    const fromTimestamp = completionDateBoundary(pipelineCreatedFrom);
    const toTimestamp = completionDateBoundary(pipelineCreatedTo, true);
    const fitsCreatedTime = fromTimestamp == null && toTimestamp == null
      ? true
      : createdTimestamp != null
        && !Number.isNaN(createdTimestamp)
        && (fromTimestamp == null || createdTimestamp >= fromTimestamp)
        && (toTimestamp == null || createdTimestamp <= toTimestamp);
    return fitsStatus && fitsQuery && fitsCreatedTime;
  }), [pipelineJobs, pipelineStatusFilter, pipelineQuery, pipelineCreatedFrom, pipelineCreatedTo]);

  const passed = tasks.filter((task) => task.status === 'passed');
  const qualified = passed.filter((task) => task.reviewStatus === 'qualified');
  const exportReady = qualified.filter((task) => canExportArchivedTask(task)
    && !excelRejectedTaskIds.has(task.id)
    && isCloudTrajectoryUrl(task.trajectoryUrl || task.trajectory || '')
    && hasUploadedVerificationEvidence(task));
  const pendingReviewCount = passed.filter((task) => task.reviewStatus === 'pending').length;
  const unqualifiedCount = tasks.filter((task) => task.reviewStatus === 'unqualified').length;
  const duplicateSessionCount = tasks.filter((task) => task.duplicateFields?.includes('sessionId')).length;
  const duplicateBugCount = tasks.filter((task) => task.duplicateFields?.includes('bug_id')).length;
  const taskIds = new Set(tasks.map((task) => task.id));
  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pagedTasks = filteredTasks.slice(pageStart, pageStart + pageSize);
  const selectableFilteredTaskIds = pagedTasks.filter((task) => task.status !== 'running' && canExportArchivedTask(task)).map((task) => task.id);
  const allFilteredSelected = selectableFilteredTaskIds.length > 0 && selectableFilteredTaskIds.every((id) => selectedTaskIds.includes(id));
  const selectedTasks = tasks.filter((task) => selectedTaskIds.includes(task.id));
  const selectedExportReady = selectedTasks.filter((task) => canExportArchivedTask(task)
    && !excelRejectedTaskIds.has(task.id)
    && isCloudTrajectoryUrl(task.trajectoryUrl || task.trajectory || '')
    && hasUploadedVerificationEvidence(task));
  const selectedAllPassed = selectedTasks.length > 0 && selectedTasks.every((task) => task.status === 'passed');
  const selectedCanReview = selectedTasks.length > 0 && selectedTasks.every((task) => task.status === 'passed' && !task.archived);
  const selectedCanRegenerate = selectedTasks.length > 0 && selectedTasks.every((task) => task.status !== 'running' && !task.archived);
  const regenerateTasks = tasks.filter((task) => regenerateTaskIds.includes(task.id));
  const bugfixCount = tasks.filter((task) => task.task_type === 'bugfix').length;
  const diagnosisCount = tasks.filter((task) => task.task_type === 'diagnosis').length;
  const totalEvents = tasks.reduce((sum, task) => sum + task.eventCount, 0);
  const totalBytes = tasks.reduce((sum, task) => sum + task.totalBytes, 0);
  const isRunning = ['running', 'stopping'].includes(runState.status);
  const runtimeLabel = isRunning ? (runState.status === 'stopping' ? '正在停止手动任务' : '手动任务运行中') : runState.status === 'completed' ? '手动任务已完成' : '手动导入队列';
  const runtimeDone = isRunning ? runState.completed : 0;
  const runtimeTotal = isRunning ? runState.total : pendingCount;
  const currentTasks = Array.isArray(runState.currentTasks) ? runState.currentTasks : [];
  const recentTasks = passed.filter((task) => task.finishedAt).slice(0, 6);
  const pipelineActiveCount = Number(pipelineRuntime.activeCount || 0);
  const remoteRepairActive = (pipelineRuntime.distributedWorkers?.workers || []).some((worker) => worker.status === 'busy');
  const pipelineRunning = pipelineActiveCount > 0 || remoteRepairActive;
  const pipelinePoolSummary = [
    ['规划/编测', pipelineRuntime.resourcePools?.['codex-structured']],
    ['分析', pipelineRuntime.resourcePools?.['compute-analysis']],
    ['修复', pipelineRuntime.resourcePools?.['compute-repair']],
    ['证明', pipelineRuntime.resourcePools?.['compute-proof']],
    ['Docker', pipelineRuntime.resourcePools?.['compute-docker']],
  ].map(([label, pool]) => `${label}${pool?.occupied || 0}/${pool?.limit || 0}${pool?.waiting ? `(+${pool.waiting}排队)` : ''}`).join(' · ');
  const pipelineAtCapacity = !pipelineRuntime.effectiveMaxConcurrency
    || pipelineActiveCount >= pipelineRuntime.effectiveMaxConcurrency;
  const pipelineRefillActive = ['planning', 'provisioning'].includes(pipelineRuntime.refill?.status);
  const blockedContributors = pipelineRuntime.submissionQuality?.blockedContributors || [];
  const repairWorkers = pipelineRuntime.distributedWorkers?.workers || [];
  const repairWorker = repairWorkers.find((worker) => worker.status === 'busy') || repairWorkers.find((worker) => worker.status !== 'offline') || repairWorkers[0];
  const repairWorkerLabel = repairWorker
    ? `B ${repairWorker.workerId} · ${repairWorker.status === 'busy' ? `修复 ${repairWorker.currentJobId}` : repairWorker.status === 'offline' ? '离线' : '空闲'}`
    : 'B repair-worker · 未连接';
  const healthServices = ['git', 'cloud', 'docker', 'claude', 'codex', 'host'].map((key) => ({ key, ...(systemHealth.services?.[key] || { name: key, status: 'checking', detail: '等待检查' }) }));
  const resourceSnapshot = systemHealth.resources || {};
  const dailyBudget = systemHealth.scheduler?.budget || pipelineRuntime.budget || {};
  const performance = systemHealth.performance || pipelineRuntime.performance || {};
  const generationPerformance = performance.stages?.project_generate || {};
  const fixPerformance = performance.stages?.bug_claude_fix || {};
  const maintenanceStatus = systemHealth.scheduler?.resourceMaintenance?.status || pipelineRuntime.resourceMaintenance?.status || 'idle';
  const rolloutMode = pipelineRuntime.rollout?.mode || systemHealth.rollout?.mode || 'drain_to_v2';
  const rolloutLabel = rolloutMode === 'drain_to_v2'
    ? `排空旧流程 ${pipelineRuntime.rollout?.legacyActiveCount || 0}`
    : rolloutMode === 'v2_canary'
      ? `V2 canary · ${pipelineRuntime.rollout?.canaryJobId || systemHealth.rollout?.canaryJobId || '等待项目'}`
      : 'V2 正式运行';

  const pipelineForTask = (task) => pipelineJobs.find((job) => job.id === (task.pipelineJobId || task.pipeline_job_id)
    || (job.bugs || []).some((bug) => bug.task?.taskName === task.name || bug.task?.bugId === task.bug_id));
  const failedPipelineStageLabel = (job) => {
    const stage = String(job?.currentStage || '');
    if (stage === 'project_generate') return '项目生成失败';
    if (stage === 'project_validate') return '双架构校验失败';
    if (stage.endsWith('_bug_discovery')) return 'Bug 寻找失败';
    if (stage.endsWith('_bug_source_prepare')) return 'Bug 基线准备失败';
    if (stage.endsWith('_gold_fix')) return 'Gold 修复失败';
    if (stage.endsWith('_claude_fix')) return 'Claude 修复失败';
    if (stage.endsWith('_trajectory_validate')) return '轨迹采集登记失败';
    if (stage.endsWith('_sol_quality')) return '旧内容质检阶段已暂停';
    if (stage.endsWith('_cloud_upload')) return '轨迹上传失败';
    return '流水线执行失败';
  };
  const taskSessionLabel = (task) => {
    if (task.sessionId) return task.sessionId;
    const pipelineJob = pipelineForTask(task);
    if (!pipelineJob) return task.status === 'failed' ? '任务执行失败' : '手动导入任务待启动';
    if (task.status === 'skipped' || task.pipelineDisposition === 'skipped') return '此 Bug 已跳过，流水线继续';
    const bugStage = task.bug_index
      ? (pipelineJob.stages || []).find((stage) => stage.id === `bug${task.bug_index}_${String(pipelineJob.currentStage || '').split('_').slice(1).join('_')}`)
        || (pipelineJob.stages || []).find((stage) => stage.id.startsWith(`bug${task.bug_index}_`) && ['running', 'failed'].includes(stage.status))
      : null;
    if (pipelineJob.status === 'draft') return pipelineAtCapacity ? `等待项目槽位（${pipelineRuntime.maxConcurrency} 路已满）` : '项目草稿等待自动启动';
    if (pipelineJob.status === 'queued') return pipelineAtCapacity ? `项目排队中（${pipelineRuntime.maxConcurrency} 路已满）` : '项目排队中';
    if (pipelineJob.status === 'running') {
      if (bugStage?.label) return bugStage.label;
      if (String(pipelineJob.currentStage || '').endsWith('_claude_fix')) return 'Claude 正在修复代码或生成独立回归测试';
      return '等待进入 Claude 修复阶段';
    }
    if (pipelineJob.status === 'failed') return failedPipelineStageLabel(pipelineJob);
    if (pipelineJob.status === 'abandoned') return '项目已废弃';
    return 'Session 尚未生成';
  };

  useEffect(() => {
    setSelectedTaskIds((current) => current.filter((id) => taskIds.has(id)));
  }, [tasks]);

  useEffect(() => {
    if (activeTask) setActiveTask(tasks.find((task) => task.id === activeTask.id) || null);
  }, [tasks]);

  useEffect(() => {
    setPage(1);
  }, [filter, reviewFilter, trajectoryUploadFilter, exportCountFilter, query, completedFrom, completedTo, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const toggleAllFiltered = () => {
    setSelectedTaskIds((current) => {
      if (allFilteredSelected) return current.filter((id) => !selectableFilteredTaskIds.includes(id));
      return [...new Set([...current, ...selectableFilteredTaskIds])];
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><TerminalSquare size={18} strokeWidth={2.4} /></div>
          <div><strong>Go 题目运行台</strong><span>任务执行与轨迹审计</span></div>
        </div>
        <div className="topbar-actions">
          <span className="connection"><span className="status-dot" />本地数据已连接</span>
          <button className="icon-button" title="更多操作" aria-label="更多操作"><MoreHorizontal size={19} /></button>
          <div className="avatar">NY</div>
        </div>
      </header>

      <main className="content">
        <section className="page-heading">
          <div>
            <div className="eyebrow"><Activity size={14} /> RUN CONTROL / TASK LIBRARY</div>
            <h1>运行记录</h1>
            <p>Codex 出题，独立生成模型创建项目，Claude 完成测试模型修复，Codex 独立完成高阶修复。</p>
          </div>
          <div className="heading-actions">
            <button className="secondary-button" onClick={refresh}><RefreshCcw size={16} className={isRefreshing ? 'spin' : ''} />刷新状态</button>
            <span className="concurrency-control"><Activity size={14} /><span>{pipelineRefillActive ? `Codex 补题 ${pipelineRuntime.refill.createdCount}/${pipelineRuntime.refill.plannedCount || 10}` : pipelineRuntime.controlMode === 'running' ? '闭环调度中' : pipelineRuntime.controlMode === 'draining' ? '正在排空' : pipelineRuntime.controlMode === 'emergency_stopped' ? '紧急停止' : '调度已暂停'} · {pipelinePoolSummary}</span></span>
            {isRunning ? <button className="danger-button" onClick={stopRun}><XCircle size={16} />停止手动任务</button> : pendingCount > 0 ? <button className="primary-button" disabled={pipelineRunning} onClick={startRun} title={pipelineRunning ? '生产流水线运行期间不能启动手动导入任务' : `启动 ${pendingCount} 道手动导入任务`}><Play size={16} fill="currentColor" />启动手动导入任务</button> : null}
            <button className="secondary-button" onClick={() => setShowRuleValidator(true)}><CheckCheck size={16} />交付字段校验</button>
          </div>
        </section>

        <section className={`run-strip ${isRunning ? 'run-strip-active' : ''}`} aria-label="CLI运行状态">
          <div className="run-strip-leading"><span className={`run-orb ${isRunning ? 'active' : ''}`}><Play size={14} fill="currentColor" /></span><div><strong>{runtimeLabel}</strong><span>{isRunning ? `Claude 正在处理手动导入任务，当前并发 ${currentTasks.length} / 4` : (pendingCount ? `当前有 ${pendingCount} 道手动导入任务待运行` : '当前无手动导入任务；生产题目由上方流水线闭环调度')}</span></div></div>
          <div className="run-strip-progress"><div className="run-progress-track"><span style={{ width: `${runtimeTotal ? (runtimeDone / runtimeTotal) * 100 : 0}%` }} /></div><b>{runtimeDone} / {runtimeTotal}</b></div>
          {isRunning && currentTasks.length ? <div className="current-run"><span>当前并发 {currentTasks.length} / 4</span><strong>{currentTasks.map((task) => task.bugId).join(' · ')}</strong><small>{formatNumber(currentTasks.reduce((sum, task) => sum + (task.streamBytes || 0), 0))} bytes</small></div> : <div className="current-run idle-run"><span>手动 CLI 队列</span><strong>{pendingCount ? `${pendingCount} 道可启动` : '队列为空'}</strong><small>此入口仅用于旧任务或人工导入</small></div>}
        </section>
        <section className="system-health-band" aria-labelledby="system-health-title">
          <div className="system-health-heading"><div><span className="health-pulse" /><div><strong id="system-health-title">系统监控</strong><span>{rolloutLabel}</span></div></div><span className={`status-chip ${systemHealth.watchdog?.activeIncidentCount ? 'red' : 'green'}`}>{systemHealth.watchdog?.triaging ? 'Codex 正在排查' : `${systemHealth.watchdog?.activeIncidentCount || 0} 个活动异常`}</span></div>
          <div className="health-service-grid">{healthServices.map((service) => <div className={`health-service health-${service.status}`} key={service.key}><span className="health-service-dot" /><div><strong>{service.name}</strong><span>{service.status === 'online' ? '在线' : service.status === 'degraded' ? '需恢复' : service.status === 'offline' ? '离线' : '检查中'}</span></div><small title={service.detail}>{service.detail}</small></div>)}</div>
          <div className="resource-strip"><span>磁盘 <b>{Number(resourceSnapshot.diskUsedPercent || 0).toFixed(1)}%</b></span><span>可用内存 <b>{resourceSnapshot.memoryAvailablePercent == null ? formatBytes(resourceSnapshot.freeMemoryBytes) : `${resourceSnapshot.memoryAvailablePercent}%`}</b></span><span>Docker 可回收 <b>{formatBytes(resourceSnapshot.dockerReclaimableBytes)}</b></span><span>24h 交付 <b>{performance.delivered24h ?? 0}</b></span><span>项目生成 P50 <b>{generationPerformance.p50Minutes == null ? '采集中' : `${generationPerformance.p50Minutes}m`}</b></span><span>Claude 修复 P50 <b>{fixPerformance.p50Minutes == null ? '采集中' : `${fixPerformance.p50Minutes}m`}</b></span><span>今日项目 <b>{dailyBudget.createdProjects || 0}/{dailyBudget.projectLimit == null ? '不限' : dailyBudget.projectLimit}</b></span><span>今日轨迹 <b>{dailyBudget.deliveredTrajectories || 0}/{dailyBudget.trajectoryLimit == null ? '不限' : dailyBudget.trajectoryLimit}</b></span>{maintenanceStatus !== 'idle' && <span>缓存维护 <b>{maintenanceStatus === 'pending' ? '等待排空' : maintenanceStatus === 'running' ? '清理中' : '等待重试'}</b></span>}<button type="button" title="清理 Docker 缓存" disabled={pipelineBusy || pipelineRunning || maintenanceStatus === 'running'} onClick={cleanDockerResources}><Trash2 size={14} />清理缓存</button></div>
          {systemHealth.watchdog?.incidents?.length > 0 && <div className="watchdog-incidents">{systemHealth.watchdog.incidents.slice(0, 3).map((incident) => <div className="watchdog-incident" key={incident.id}><span className={`incident-level ${incident.severity}`} /><div><strong>{incident.jobId}</strong><span>{incident.triage?.conclusion || incident.message}</span></div><em>{incident.actionStatus === 'failed' ? '动作失败' : incident.actionStatus === 'executed' ? '动作已执行' : incident.actionStatus === 'observing' ? '继续观察' : incident.status === 'triaging' ? 'Codex 排查中' : incident.status === 'triaged' ? incident.triage?.category || '已分析' : incident.status === 'triage_failed' ? '等待重试排查' : '等待 Codex'}</em></div>)}</div>}
        </section>
        {runError && <div className="run-error"><XCircle size={15} />{runError}</div>}

        <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
          <div className="panel-heading pipeline-heading">
            <div><h2 id="pipeline-title">流水线作业</h2><span className="panel-subtitle">规划项目 → 生成模型创建 → 双架构构建与运行验证 → 本地冻结 → 找/准备 Bug → 发布 Git → 双修复 → 轨迹采集登记 → 云盘交付</span></div>
            <div className="pipeline-heading-controls"><span className={`status-chip ${pipelineRunning || pipelineRefillActive ? 'green' : 'blue'}`}><Workflow size={14} />{pipelineRefillActive ? `Codex 自动补题 ${pipelineRuntime.refill.createdCount}/${pipelineRuntime.refill.plannedCount || 10}` : pipelineRunning ? `执行 ${pipelineActiveCount}/${pipelineRuntime.effectiveMaxConcurrency} · 等待资源 ${pipelineRuntime.waitingResourceCount} · ${pipelinePoolSummary} · ${pipelineRuntime.controlMode === 'running' ? '自动补位' : '不补位'}` : `${pipelineJobs.length} 个作业 · 等待闭环检查`}</span>{pipelineRuntime.distributedWorkers?.enabled && <span className={`status-chip ${repairWorker?.status === 'busy' || repairWorker?.status === 'online' || repairWorker?.status === 'idle' ? 'green' : 'blue'}`}><Activity size={14} />{repairWorkerLabel}</span>}<div className="scheduler-controls"><button type="button" className={pipelineRuntime.controlMode === 'running' ? 'active' : ''} disabled={pipelineBusy} title="恢复闭环调度" onClick={() => setPipelineControl('running')}><Play size={14} />运行</button><button type="button" className={pipelineRuntime.controlMode === 'paused' ? 'active' : ''} disabled={pipelineBusy} title="暂停启动新任务" onClick={() => setPipelineControl('paused')}><Pause size={14} />暂停</button><button type="button" className={pipelineRuntime.controlMode === 'draining' ? 'active' : ''} disabled={pipelineBusy} title="当前任务完成后停止补位" onClick={() => setPipelineControl('draining')}><Workflow size={14} />排空</button><button type="button" className="emergency" disabled={pipelineBusy || !pipelineRunning} title="停止所有流水线 Runner" onClick={() => setPipelineControl('emergency_stopped')}><ShieldAlert size={14} />急停</button></div></div>
          </div>
          {pipelineMessage && <div className="pipeline-message">{pipelineMessage}</div>}
          {blockedContributors.length > 0 && <div className="hard-rule-alert"><strong>项目质量事故熔断已触发</strong><p>{blockedContributors.map((item) => item.contributorId).join('、')} 已有两个不同项目被确定性质量门禁判定失败；自动补题和调度保持暂停，需人工复核。</p></div>}
          <div className="pipeline-layout">
            <form className="pipeline-form" onSubmit={createPipeline}>
              <label className="pipeline-field pipeline-field-wide"><span>项目要求</span><textarea required minLength="20" value={pipelineForm.projectBrief} onChange={(event) => updatePipelineForm('projectBrief', event.target.value)} placeholder="说明项目领域、使用场景和核心能力，至少 20 个字符" /></label>
              <div className={`pipeline-auto-repository pipeline-field-wide ${pipelineRepositoryStatus.connected ? 'connected' : 'disconnected'}`}>
                <GitBranch size={18} />
                <div><span>自动 GitHub 仓库</span><strong>{pipelineRepositoryStatus.loading ? '检查中' : pipelineRepositoryStatus.connected ? `${pipelineRepositoryStatus.owner}/${pipelineRepositoryStatus.nextName}` : '未连接'}</strong><small>{pipelineRepositoryStatus.connected ? 'Public · Empty' : pipelineRepositoryStatus.message}</small></div>
              </div>
              <fieldset className="pipeline-field"><legend>轨迹类型</legend><div className="pipeline-segments"><button type="button" className={pipelineForm.taskType === 'bugfix' ? 'active' : ''} onClick={() => updatePipelineForm('taskType', 'bugfix')}>Bugfix</button><button type="button" className={pipelineForm.taskType === 'diagnosis' ? 'active' : ''} onClick={() => updatePipelineForm('taskType', 'diagnosis')}>Diagnosis</button></div></fieldset>
              <fieldset className="pipeline-field"><legend>项目规模</legend><div className="pipeline-segments"><button type="button" className={pipelineForm.projectTier === 'standard' ? 'active' : ''} onClick={() => updatePipelineForm('projectTier', 'standard')}>标准</button><button type="button" className={pipelineForm.projectTier === 'large' ? 'active' : ''} onClick={() => updatePipelineForm('projectTier', 'large')}>超大型</button></div><small className="pipeline-field-note">标准项目 10 个 Bug；超大型项目 30 个 Bug。{largeCanarySummary(pipelineRuntime.refill?.largeProjectCanary)}</small></fieldset>
              <label className="pipeline-field"><span>Bug 数量</span><select value={pipelineForm.projectTier === 'large' ? 30 : 10} disabled><option value={pipelineForm.projectTier === 'large' ? 30 : 10}>{pipelineForm.projectTier === 'large' ? 30 : 10}（等级固定）</option></select></label>
              <label className="pipeline-field"><span>轨迹最多尝试</span><select value={3} disabled><option value={3}>固定 3 次</option></select></label>
              <label className="pipeline-field"><span>创建人</span><input required value={pipelineForm.creator} onChange={(event) => updatePipelineForm('creator', event.target.value)} /></label>
              <div className="pipeline-form-action"><button className="primary-button" disabled={pipelineBusy || pipelineRuntime.controlMode !== 'running' || !pipelineRuntime.resourcePolicy?.canCreate || pipelineRepositoryStatus.loading || !pipelineRepositoryStatus.connected} type="submit"><GitBranch size={16} />创建仓库与草稿</button><small>{pipelineRuntime.controlMode !== 'running' ? '恢复运行后才能创建仓库。' : !pipelineRuntime.resourcePolicy?.canCreate ? '主机资源保护已阻止创建。' : '自动分配下一个编号；有空闲槽位时自动启动。'}</small></div>
            </form>
            <div className="pipeline-list-pane">
              <div className="pipeline-toolbar">
                <label className="search-box pipeline-search"><Search size={15} /><input aria-label="搜索流水线、仓库或 Bug ID" placeholder="搜索流水线、仓库或 Bug ID" value={pipelineQuery} onChange={(event) => setPipelineQuery(event.target.value)} />{pipelineQuery && <button type="button" title="清除流水线搜索" aria-label="清除流水线搜索" onClick={() => setPipelineQuery('')}><X size={13} /></button>}</label>
                <label className="completion-filter"><Clock3 size={14} /><span>题目时间</span><input type="date" aria-label="题目创建日期开始" value={pipelineCreatedFrom} max={pipelineCreatedTo || undefined} onChange={(event) => setPipelineCreatedFrom(event.target.value)} /><i>至</i><input type="date" aria-label="题目创建日期结束" value={pipelineCreatedTo} min={pipelineCreatedFrom || undefined} onChange={(event) => setPipelineCreatedTo(event.target.value)} />{(pipelineCreatedFrom || pipelineCreatedTo) && <button type="button" title="清除题目时间筛选" aria-label="清除题目时间筛选" onClick={() => { setPipelineCreatedFrom(''); setPipelineCreatedTo(''); }}><X size={13} /></button>}</label>
                <select className="review-filter-select" aria-label="题目状态筛选" value={pipelineStatusFilter} onChange={(event) => setPipelineStatusFilter(event.target.value)}><option value="all">全部题目状态</option><option value="draft">草稿</option><option value="waiting_review">等待题面确认</option><option value="waiting_resource">等待资源</option><option value="queued">准备启动</option><option value="running">运行中</option><option value="passed">已完成</option><option value="failed">失败</option><option value="abandoned">已废弃</option><option value="stopped">已停止</option></select>
                <span className="count-pill">{filteredPipelineJobs.length} / {pipelineJobs.length}</span>
              </div>
              <div className="pipeline-jobs">
              {filteredPipelineJobs.map((job) => {
                const stages = Array.isArray(job.stages) ? job.stages : [];
                const userQueryReadiness = pipelineUserQueryReadiness(job);
                const requestedBugCount = userQueryReadiness.requestedBugCount;
                const bugsByIndex = new Map((job.bugs || []).map((bug) => [Number(bug.bugIndex), bug]));
                const notApplicableBugIndexes = new Set((job.notApplicableBugIndexes || []).map(Number));
                const displayBugs = Array.from({ length: requestedBugCount }, (_, offset) => {
                  const bugIndex = offset + 1;
                  return bugsByIndex.get(bugIndex) || {
                    bugIndex,
                    discovery: { found: false, user_query: '' },
                    workbench: {},
                  };
                }).filter((bug) => !notApplicableBugIndexes.has(Number(bug.bugIndex)));
                const passedStages = stages.filter((stage) => stage.status === 'passed').length;
                const activeWorkbenchBugs = (job.bugs || []).filter((bug) => ['fast_lane_running', 'fast_lane_queued', 'fast_lane_switching'].includes(bug.workbench?.status));
                const activeWorkbenchBug = activeWorkbenchBugs[0];
                const activeWorkbenchSummary = activeWorkbenchBugs.map((bug) => {
                  const bugIndex = Number(bug.bugIndex);
                  const workbench = bug.workbench || {};
                  const status = bugWorkbenchStatusLabel[workbench.status] || '运行中';
                  const stage = pipelineStageDisplayLabel(workbench);
                  return `Bug ${bugIndex} · ${status}${stage ? ` · ${stage}` : ''}`;
                }).join('；');
                const currentStage = selectPipelineDisplayStage(stages, job, activeWorkbenchBug);
                const jobBugIds = [...new Set((job.bugs || []).map((bug) => bug.task?.bugId || bug.discovery?.bug_id).filter(Boolean))];
                const progress = stages.length ? (passedStages / stages.length) * 100 : 0;
                const autoRetryCount = Number(job.autoRetryCount) || 0;
                const waitingForCloud = job.status === 'failed' && String(job.currentStage || '').endsWith('_cloud_upload') && /请先连接轨迹云盘/.test(job.error || '');
                const waitingForPlatform = job.status === 'failed' && String(job.currentStage || '').endsWith('_platform_submit') && /提交平台|质检平台|钥匙串/.test(job.error || '');
                const invalidBaseline = job.status === 'failed' && /(?:已发布 main\s*|项目)基线不合格/.test(job.error || '');
                const retryExhausted = job.status === 'failed' && !waitingForCloud && !waitingForPlatform && !invalidBaseline && autoRetryCount >= pipelineRuntime.maxAutoRetries;
                const automaticRetryEligible = Number(job.workflowVersion || 1) >= CURRENT_WORKFLOW_VERSION || job.legacyAutoRetryEnabled || job.retryRequestedAt;
                const automaticRetryPending = job.status === 'failed' && !waitingForCloud && !waitingForPlatform && !invalidBaseline && !job.watchdogTriagePending && automaticRetryEligible && autoRetryCount < pipelineRuntime.maxAutoRetries && pipelineRuntime.autoFillEnabled;
                const waitingForResource = job.status === 'waiting_resource';
                const waitingForUserQuery = job.status === 'waiting_review';
                const injectionReviewIndexes = Array.isArray(job.injectionReviewPending?.bugIndexes)
                  ? job.injectionReviewPending.bugIndexes.map(Number).filter(Number.isInteger)
                  : [];
                const waitingForInjectionReview = waitingForUserQuery && injectionReviewIndexes.length > 0;
                const effectiveRunning = activeWorkbenchBugs.length > 0 || job.processActive || job.status === 'running';
                const currentIssue = activeWorkbenchBugs.length > 0
                  ? activeWorkbenchSummary
                  : waitingForResource
                  ? `已交还 Runner，等待中央调度 · ${job.waitingResource?.pool || 'general'} · 入队 ${formatCompletionTime(job.waitingResource?.queuedAt)}`
                  : waitingForInjectionReview
                    ? `注入候选连续失败，等待人工处理 Bug ${injectionReviewIndexes.join('、')}`
                  : waitingForUserQuery
                    ? 'Bug 技术定位与 BUG_BASE 已完成，请在工作台编辑并确认 user_query'
                  : automaticRetryPending
                  ? `已加入优先重试队列，等待调度容量释放（当前 Runner ${pipelineRuntime.activeCount}/${pipelineRuntime.effectiveMaxConcurrency}）`
                  : job.error;
                const displayStatus = effectiveRunning && activeWorkbenchBugs.length > 0
                  ? activeWorkbenchBugs.length > 1
                    ? `执行 ${activeWorkbenchBugs.map((bug) => `Bug ${Number(bug.bugIndex)}`).join('、')}`
                    : `Bug ${activeWorkbenchBug.bugIndex} ${bugWorkbenchStatusLabel[activeWorkbenchBug.workbench?.status] || '运行中'}`
                  : job.watchdogTriagePending
                  ? '等待 Codex 只读排查'
                  : job.status === 'abandoned'
                  ? (job.replacementJobId ? '已废弃，替补已创建' : '已废弃，等待替补')
                  : waitingForCloud
                  ? '等待连接云盘'
                  : waitingForPlatform
                  ? '等待连接提交平台'
                  : invalidBaseline
                    ? '失败，项目基线不合格'
                    : waitingForResource
                      ? '等待中央调度'
                    : waitingForInjectionReview
                      ? '等待注入复核'
                    : waitingForUserQuery
                      ? '等待题面确认'
                    : retryExhausted
                      ? '失败，已达到自动重试上限'
                      : automaticRetryPending
                        ? '等待自动重试'
                        : (pipelineStatusLabel[job.status] || job.status);
                const canStart = ['draft'].includes(job.status);
                const canRetry = ['failed', 'stopped'].includes(job.status) && !waitingForCloud && !waitingForPlatform && !job.watchdogTriagePending;
                const canStop = job.processActive || ['queued', 'running'].includes(job.status);
                return (
                  <article className={`pipeline-job pipeline-job-${job.status}`} key={job.id}>
                    <div className="pipeline-job-top"><div><strong>{job.id}</strong><span>{job.request?.repository}</span></div><span className={`status-chip ${effectiveRunning ? 'green' : job.status === 'passed' ? 'green' : job.status === 'abandoned' || job.status === 'failed' && !waitingForCloud && !waitingForPlatform && !automaticRetryPending ? 'red' : 'blue'}`}>{displayStatus}</span></div>
                    <div className="pipeline-bug-ids"><span>Bug ID</span>{jobBugIds.length ? jobBugIds.map((bugId) => <code key={bugId}>{bugId}</code>) : <em>尚未生成</em>}</div>
                    <div className="pipeline-job-meta"><span>{job.request?.bugCount} Bug</span><span>{job.request?.taskType}</span><span>创建 {formatCompletionTime(job.createdAt)}</span><span>轨迹尝试 {job.request?.maxTrajectoryAttempts}</span><span>自动重试 {autoRetryCount}/{pipelineRuntime.maxAutoRetries}</span><span>{passedStages}/{stages.length} 阶段</span>{job.replacementJobId && <span>替补 {job.replacementJobId}</span>}</div>
                    <div className="pipeline-progress"><span style={{ width: `${progress}%` }} /></div>
                    <div className="pipeline-current"><b>{pipelineStageDisplayLabel(currentStage) || (job.status === 'passed' ? '所有阶段已完成' : '等待启动')}</b>{currentIssue && <span className={activeWorkbenchBugs.length > 0 ? 'pipeline-active-summary' : ''} title={automaticRetryPending ? job.error : undefined}>{currentIssue}</span>}</div>
                    {requestedBugCount > 0 && <div className="pipeline-workbench">
                      <div className="pipeline-workbench-head"><strong>Bug 工作台</strong><span className="pipeline-workbench-review-hint">题面准备 {userQueryReadiness.preparedBugCount}/{requestedBugCount} · 项目级并行寻找并批量复核 Bug，全部准备后统一确认 user_query</span>{waitingForInjectionReview && <><button type="button" className="primary-button" disabled={pipelineBusy} onClick={() => resolveInjectionReview(job, 'retry')}><RefreshCcw size={14} />重新规划注入</button><button type="button" className="secondary-button" disabled={pipelineBusy} onClick={() => resolveInjectionReview(job, 'continue')}>停止注入并继续</button><span className="pipeline-workbench-review-hint">5 分钟无人操作将自动停止注入并继续</span></>}{!waitingForInjectionReview && job.status === 'waiting_review' && userQueryReadiness.pendingReviewIndexes.length > 0 && <button type="button" className="primary-button" disabled={pipelineBusy || !userQueryReadiness.ready} title={userQueryReadiness.ready ? '一次确认全部已准备的 Bug 题面' : `等待 Bug ${userQueryReadiness.unpreparedBugIndexes.join('、')} 准备完成后才能确认`} onClick={() => confirmAllBugUserQueries(job, job.bugs)}><CheckCheck size={14} />确认全部题面</button>}{!waitingForInjectionReview && job.status === 'waiting_review' && !userQueryReadiness.ready && userQueryReadiness.unpreparedBugIndexes.length > 0 && <span className="pipeline-workbench-review-hint">等待 Bug {userQueryReadiness.unpreparedBugIndexes.join('、')} 注入准备完成</span>}<label><input type="checkbox" checked={job.bugWorkbench?.autoContinue !== false} disabled={pipelineBusy} onChange={(event) => updateBugWorkbenchSettings(job, { autoContinue: event.target.checked })} />完成后继续下一个 Bug</label></div>
                      <div className="pipeline-workbench-list">{displayBugs.map((bug) => {
                        const bugIndex = Number(bug.bugIndex);
                        const workbench = bug.workbench || {};
                        const injectionRejection = Array.isArray(bug.injectionPreparation?.rejectedCandidates)
                          ? bug.injectionPreparation.rejectedCandidates.at(-1)
                          : null;
                        const selected = Boolean(workbench.selected);
                        const failure = workbench.firstFailure || bug.firstFailure || null;
                        const attempts = Array.isArray(workbench.attempts) ? workbench.attempts : [];
                        const workbenchStartedAt = Date.parse(workbench.startedAt || '');
                        const liveElapsedMs = workbench.status === 'fast_lane_running'
                          && Number.isFinite(workbenchStartedAt)
                          ? Math.max(Number(workbench.elapsedMs) || 0, workbenchNow - workbenchStartedAt)
                          : Number(workbench.elapsedMs) || 0;
                        const canOperate = !['passed', 'abandoned'].includes(job.status) && bug.discovery?.found !== false;
                        const userQueryReviewStage = stages.find((stage) => stage.id === `bug${bugIndex}_user_query_review`);
                        const userQueryNeedsReview = userQueryReviewStage && !['passed', 'skipped'].includes(userQueryReviewStage.status)
                          && ['passed'].includes(stages.find((stage) => stage.id === `bug${bugIndex}_bug_source_prepare`)?.status);
                        const userQueryKey = `${job.id}:${bugIndex}`;
                        const userQueryDraft = userQueryDrafts[userQueryKey] ?? bug.discovery?.user_query ?? '';
                        const placeholder = !bugsByIndex.has(bugIndex);
                        const stageRetry = workbench.status === 'delivered'
                          ? null
                          : bug.stageAutoRetries?.[workbench.currentStage]
                            || Object.values(bug.stageAutoRetries || {}).sort((left, right) => String(right.lastFailedAt || '').localeCompare(String(left.lastFailedAt || '')))[0]
                            || null;
                        return <div className={`pipeline-workbench-row ${selected ? 'selected' : ''} ${placeholder ? 'placeholder' : ''}`} key={`${job.id}-bug-${bugIndex}`}>
                          <span className="pipeline-workbench-bug">Bug {bugIndex}</span>
                          <span className="pipeline-workbench-stage">{placeholder ? '等待准备' : pipelineStageDisplayLabel(workbench) || (workbench.status === 'fast_lane_failed' && bug.failureDisposition === 'auto_continued' ? '失败，已自动继续' : workbench.status) || '待启动'}</span>
                          <span className="pipeline-workbench-time">当前阶段 {formatWorkbenchDuration(liveElapsedMs)} · 轨迹累计 {formatWorkbenchDuration(workbench.totalDurationMs)} · 轨迹尝试 {workbench.attemptCount || 0}</span>
                          {failure && <span className="pipeline-workbench-failure" title={failure.error || ''}>首次失败：{String(failure.error || '未知原因').slice(0, 80)}</span>}
                          {stageRetry && <span className="pipeline-workbench-failure" title={stageRetry.lastError || ''}>阶段重试 {stageRetry.retryCount || 0}/{stageRetry.maxRetries || 3}：{String(stageRetry.lastError || '等待重试').slice(0, 80)}</span>}
                          {injectionRejection && <span className="pipeline-workbench-failure" title={injectionRejection.reason || ''}>注入候选 {bug.injectionPreparation?.attempts || 0}/3：{Array.isArray(injectionRejection.failedTests) && injectionRejection.failedTests.length ? injectionRejection.failedTests.join('、') : '未通过候选复核'}</span>}
                          <span className="pipeline-workbench-actions">
                            <button type="button" title={`启动 Bug ${bugIndex}`} disabled={pipelineBusy || !canOperate || ['fast_lane_running', 'delivered'].includes(workbench.status)} onClick={() => controlBugWorkbench(job, bugIndex, 'start', job.bugWorkbench?.autoContinue !== false)}><Play size={13} /></button>
                            <button type="button" title={`切换到 Bug ${bugIndex}`} disabled={pipelineBusy || !canOperate || selected} onClick={() => controlBugWorkbench(job, bugIndex, 'switch', job.bugWorkbench?.autoContinue !== false)}><Workflow size={13} /></button>
                            <button type="button" title={`重试 Bug ${bugIndex}`} disabled={pipelineBusy || !canOperate || !['fast_lane_failed', 'fast_lane_stopped'].includes(workbench.status)} onClick={() => controlBugWorkbench(job, bugIndex, 'retry', job.bugWorkbench?.autoContinue !== false)}><RefreshCcw size={13} /></button>
                            <button type="button" title={`重置 Bug ${bugIndex} 尝试次数`} disabled={pipelineBusy || !canOperate || !['skipped', 'failed'].includes(bug.disposition) || Boolean(stages.find((stage) => Number(stage.bugIndex) === bugIndex && stage.status === 'running'))} onClick={() => resetBugAttempts(job, bugIndex)}><RotateCcw size={13} /></button>
                            <button type="button" title={`关闭 Bug ${bugIndex}`} disabled={pipelineBusy || !selected || !['fast_lane_running', 'fast_lane_queued', 'fast_lane_switching'].includes(workbench.status)} onClick={() => controlBugWorkbench(job, bugIndex, 'close', job.bugWorkbench?.autoContinue !== false)}><XCircle size={13} /></button>
                          </span>
                          {!placeholder && <div className="pipeline-workbench-phase-strip" aria-label={`Bug ${bugIndex} 执行阶段`}>
                            {bugExecutionPhases.map((phase, phaseIndex) => {
                              const currentPhaseIndex = bugExecutionPhaseIndex(workbench.subphase, workbench.currentStage || workbench.resourceStage);
                              const completed = ['fast_lane_completed', 'delivered'].includes(workbench.status);
                              const state = completed || phaseIndex < currentPhaseIndex ? 'done' : phaseIndex === currentPhaseIndex ? 'active' : '';
                              return <span className={state} key={phase.key}>{phase.label}</span>;
                            })}
                          </div>}
                          <div className="pipeline-workbench-fields" aria-label={`Bug ${bugIndex} 工作台字段`}>
                            <span><b>状态</b>{workbench.status === 'fast_lane_failed' && bug.failureDisposition === 'auto_continued' ? '失败，已自动继续' : bugWorkbenchStatusLabel[workbench.status] || workbench.status || '待启动'}</span>
                            <span><b>阶段</b>{pipelineStageDisplayLabel(workbench) || '未记录'}</span>
                            <span><b>当前尝试</b>{workbench.currentAttempt || 0}</span>
                            <span><b>开始</b>{formatCompletionTime(workbench.startedAt)}</span>
                            <span><b>心跳</b>{formatCompletionTime(workbench.lastHeartbeatAt)}</span>
                            <span><b>失败类别</b>{failure?.failureCategory || '未记录'}</span>
                            <span><b>退出码</b>{failure?.exitCode == null ? '未记录' : failure.exitCode}</span>
                            <span><b>Session</b>{failure?.sessionId || attempts.at(-1)?.sessionId || '未记录'}</span>
                            <span><b>动作</b>{workbench.lastAction || failure?.action || '未记录'}</span>
                            <span><b>阻塞</b>{workbench.blockedReason || '无'}</span>
                            <span><b>下一 Bug</b>{job.bugWorkbench?.nextBugIndex || '无'}</span>
                            <span><b>自动继续</b>{job.bugWorkbench?.autoContinue === false ? '关闭' : '开启'}</span>
                          </div>
                          {userQueryNeedsReview && <div className="pipeline-user-query-review">
                            <label htmlFor={`user-query-${job.id}-${bugIndex}`}>user_query 人工确认</label>
                            <textarea id={`user-query-${job.id}-${bugIndex}`} value={userQueryDraft} onChange={(event) => setUserQueryDrafts((current) => ({ ...current, [userQueryKey]: event.target.value }))} />
                            <div><button type="button" className="secondary-button" disabled={pipelineBusy || !userQueryDraft.trim()} onClick={() => reviewBugUserQuery(job, bug, false)}>保存本题草稿</button></div>
                          </div>}
                          {attempts.length > 0 && <details className="pipeline-workbench-history">
                            <summary>查看完整失败/尝试历史（{attempts.length} 次）</summary>
                            <div className="pipeline-attempt-list">{attempts.map((attempt, attemptIndex) => <div className={`pipeline-attempt pipeline-attempt-${attempt.status || 'unknown'}`} key={`${job.id}-${bugIndex}-attempt-${attemptIndex}`}>
                              <div className="pipeline-attempt-heading"><strong>第 {attempt.attempt || attemptIndex + 1} 次 · {attempt.status || '未知'}</strong><span>{attempt.stage || '阶段未记录'} · {formatWorkbenchDuration(attempt.durationMs)}</span></div>
                              <div className="pipeline-attempt-meta"><span>开始 {formatCompletionTime(attempt.startedAt)}</span><span>结束 {formatCompletionTime(attempt.finishedAt)}</span><span>退出码 {attempt.exitCode == null ? '未记录' : attempt.exitCode}</span><span>类别 {attempt.failureCategory || '未记录'}</span><span>Session {attempt.sessionId || '未记录'}</span><span>动作 {attempt.action || '未记录'}</span></div>
                              {attempt.error && <pre>{attempt.error}</pre>}
                            </div>)}</div>
                          </details>}
                        </div>;
                      })}</div>
                    </div>}
                    {(job.logs || []).length > 0 && <div className="pipeline-log">{job.logs.slice(-3).map((log, index) => <span key={`${log.at}-${index}`}><time>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>{log.message}</span>)}</div>}
                    <div className="pipeline-actions">
                      {canStart && <button type="button" className="primary-button" disabled={pipelineBusy || pipelineAtCapacity || isRunning} title={pipelineAtCapacity ? '已达到 4 路项目并发上限' : '启动此作业并自动补满 4 路'} onClick={() => controlPipeline(job, 'start')}><Play size={15} fill="currentColor" />启动并补位</button>}
                      {canRetry && <button type="button" className="secondary-button" disabled={pipelineBusy || isRunning || pipelineRuntime.controlMode !== 'running' || pipelineRuntime.resourcePolicy?.canStart === false} title={pipelineRuntime.controlMode !== 'running' ? '恢复流水线调度后才能重试' : pipelineRuntime.resourcePolicy?.canStart === false ? '主机资源保护已阻止重试' : pipelineAtCapacity ? '当前容量已满，点击后加入优先重试队列' : '重试此作业并自动补位'} onClick={() => controlPipeline(job, 'retry')}><RefreshCcw size={15} />{pipelineAtCapacity ? '加入重试队列' : '重试并补位'}</button>}
                      {canStop && <button type="button" className="danger-button" disabled={pipelineBusy} onClick={() => controlPipeline(job, 'stop')}><XCircle size={15} />停止</button>}
                    </div>
                  </article>
                );
              })}
              {!filteredPipelineJobs.length && <div className="empty-pipeline">{pipelineJobs.length ? '没有符合搜索、题目时间和状态筛选的作业' : '暂无生产作业；闭环调度会自动调用 Codex 补充 10 个题目。'}</div>}
              </div>
            </div>
          </div>
        </section>

        <section className="metric-grid" aria-label="任务统计">
          <div className="metric-card metric-card-main"><div className="metric-label">任务总数</div><div className="metric-value">{tasks.length} <small>题</small></div><div className="metric-foot"><span className="green-text"><CheckCircle2 size={14} /> 全部记录保留</span><span>更新于 {refreshed}</span></div></div>
          <div className="metric-card"><div className="metric-label">轨迹已生成</div><div className="metric-value">{passed.length} <small>/ {tasks.length}</small></div><div className="progress"><span style={{ width: `${tasks.length ? (passed.length / tasks.length) * 100 : 0}%` }} /></div><div className="metric-foot"><span className="green-text">{qualified.length} 合格</span><span>{pendingReviewCount} 待审核 · {unqualifiedCount} 不合格</span></div></div>
          <div className="metric-card"><div className="metric-label">轨迹事件</div><div className="metric-value">{formatNumber(totalEvents)} <small>条</small></div><div className="metric-foot"><span>{bugfixCount} bugfix · {diagnosisCount} diagnosis</span><span>{formatNumber(totalBytes / 1024 / 1024)} MB</span></div></div>
          <div className="metric-card"><div className="metric-label">手动待运行</div><div className="metric-value delivery-value"><span className="delivery-icon"><Clock3 size={18} /></span>{pendingCount} <small>题</small></div><div className="metric-foot"><span>旧任务 / 人工导入</span><span className={pendingCount ? '' : 'green-text'}>{pendingCount ? '等待手动启动' : '手动队列已清空'}</span></div></div>
        </section>

        <section className="workspace-grid">
          <div className="panel task-panel">
            <div className="panel-heading">
              <div><h2>任务队列</h2><span className="panel-subtitle">Codex 出题 → 独立模型生成项目 → 最多 5 个编号 Bug → 每个 Bug 双分支独立修复</span></div>
              <div className="panel-heading-actions">
                <label className="select-all"><input type="checkbox" checked={allFilteredSelected} disabled={!selectableFilteredTaskIds.length} onChange={toggleAllFiltered} />全选本页</label>
                <button className="review-update-button" disabled={!selectedTaskIds.length} title="取消所有已勾选任务" onClick={() => setSelectedTaskIds([])}><X size={14} />取消所有选择</button>
                <select className="review-status-select" aria-label="批量目标状态" value={reviewTargetStatus} onChange={(event) => setReviewTargetStatus(event.target.value)}><option value="unqualified">不合格</option><option value="qualified">合格</option><option value="pending">待审核</option></select>
                <button className="review-update-button" disabled={reviewBusy || !selectedCanReview} onClick={updateSelectedReviewStatus}>{reviewBusy ? <RefreshCcw size={14} className="spin" /> : <CheckCheck size={14} />}批量修改状态</button>
                <button className="bulk-export-button" disabled={!selectedAllPassed || trajectoryExportBusy} onClick={exportSelectedTrajectories}><Download size={14} />{trajectoryExportBusy ? '正在生成轨迹…' : `导出轨迹 (${selectedTaskIds.length})`}</button>
                <button className="review-update-button excel-selection-button" disabled={!selectedExportReady.length || excelExportProgress.busy} title={selectedExportReady.length ? `导出勾选任务中 ${selectedExportReady.length} 条已上传轨迹的记录；成功后自动取消这些勾选` : '勾选的任务尚未上传轨迹'} onClick={() => exportExcelWithTracking(selectedExportReady, true)}><FileSpreadsheet size={14} />{excelExportProgress.busy ? `${excelExportProgress.phase === 'validating' ? '校验中' : excelExportProgress.phase === 'generating' ? '生成中' : '登记中'} ${excelExportProgress.completed}/${excelExportProgress.total}` : `导出 Excel (${selectedExportReady.length})`}</button>
                <button className="review-update-button regenerate-button" disabled={isRunning || pipelineRunning || !selectedCanRegenerate} onClick={() => openRegenerateConfirm()}><RefreshCcw size={14} />重新生成 ({selectedTaskIds.length})</button>
                <span className="count-pill">{filteredTasks.length} / {tasks.length}</span>
              </div>
            </div>
            <div className="toolbar"><div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 session、仓库或任务 ID" /></div><div className="completion-filter"><Clock3 size={14} /><span>完成</span><input type="date" aria-label="完成日期开始" title="完成日期开始" value={completedFrom} max={completedTo || undefined} onChange={(event) => setCompletedFrom(event.target.value)} /><i>至</i><input type="date" aria-label="完成日期结束" title="完成日期结束" value={completedTo} min={completedFrom || undefined} onChange={(event) => setCompletedTo(event.target.value)} />{(completedFrom || completedTo) && <button type="button" title="清除完成时间筛选" aria-label="清除完成时间筛选" onClick={() => { setCompletedFrom(''); setCompletedTo(''); }}><X size={13} /></button>}</div><select className="review-filter-select" aria-label="导出次数筛选" value={exportCountFilter} onChange={(event) => setExportCountFilter(event.target.value)}><option value="all">全部导出次数</option><option value="0">未导出</option><option value="1">导出 1 次</option><option value="2">导出 2 次</option><option value="3-plus">导出 3 次及以上</option></select><select className="review-filter-select" aria-label="轨迹上传状态筛选" value={trajectoryUploadFilter} onChange={(event) => setTrajectoryUploadFilter(event.target.value)}><option value="all">全部轨迹</option><option value="uploaded">轨迹已上传</option><option value="not-uploaded">轨迹未上传</option></select><select className="review-filter-select" aria-label="人工状态筛选" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}><option value="all">全部状态</option><option value="pending">待审核</option><option value="qualified">合格</option><option value="unqualified">不合格</option></select><div className="filter-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button><button className={filter === 'bugfix' ? 'active' : ''} onClick={() => setFilter('bugfix')}>Bugfix</button><button className={filter === 'diagnosis' ? 'active' : ''} onClick={() => setFilter('diagnosis')}>Diagnosis</button></div></div>
            <div className="task-list">
              {pagedTasks.map((task, index) => { const trajectoryUploaded = hasRecordedTrajectoryUpload(task); const trajectorySkipped = task.status === 'skipped'; const platformImported = task.submissionPlatformImportStatus === 'imported'; const proofReady = Boolean(task.verificationEvidenceRecorded) || hasUploadedVerificationEvidence(task); const pipelineJob = pipelineForTask(task); const pipelineStage = pipelineJob ? (pipelineJob.stages || []).find((stage) => stage.id === pipelineJob.currentStage) : null; const archivedExportReady = canExportArchivedTask(task); return <div className={`task-row review-${task.reviewStatus || 'none'} ${task.duplicateFields?.length ? 'identity-duplicate' : ''} ${activeTask?.id === task.id ? 'selected' : ''}`} key={task.id}><label className="task-select" title={task.archived ? archivedExportReady ? '云盘原件已恢复，可选择导出' : '历史记录缺少可校验的云盘原件' : task.status === 'running' ? '运行中的任务不能选择' : '选择用于审核、导出或重新生成'}><input type="checkbox" checked={selectedTaskIds.includes(task.id)} disabled={task.status === 'running' || !archivedExportReady} onChange={() => toggleTaskSelection(task.id)} /></label><button className="task-row-button" onClick={() => setActiveTask(task)}><span className="task-sequence">{pageStart + index + 1}</span><span className={`task-status ${task.status}`}>{task.status === 'passed' ? <CheckCircle2 size={17} /> : task.status === 'running' ? <Activity size={17} /> : ['failed', 'duplicate', 'skipped'].includes(task.status) ? <XCircle size={17} /> : <Clock3 size={17} />}</span><span className="task-copy"><strong>{taskSessionLabel(task)}</strong><span><b>{task.bug_id}</b><i>·</i><GitBranch size={13} />{task.repoName}<i>·</i>{task.task_type}{task.archived && <em className="workflow-chip">历史恢复</em>}{task.archived && task.archiveExportReady && <em className="workflow-chip">云盘原件可导出</em>}{pipelineJob && <em className="workflow-chip">流水线 · {pipelineStageDisplayLabel(pipelineStage) || pipelineStatusLabel[pipelineJob.status] || pipelineJob.status}</em>}{task.project_origin === 'generated_0to1' && <em className="workflow-chip">Codex 题目 · {task.project_generation_provider === 'deepseek' ? 'DeepSeek 项目' : 'Claude 项目'}</em>}{task.gitStatus === 'prepared' && <em className="workflow-chip">Gold 已准备</em>}{task.gitStatus === 'passed' && <em className="workflow-chip">{task.task_type === 'diagnosis' ? '红分支已交付' : '双修复已交付'}</em>}{Number(task.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION && <em className={proofReady ? 'workflow-chip' : 'rule-chip'}>验证证明 {proofReady ? '已上传' : '待完成'}</em>}{trajectorySkipped && <em className="rule-chip" title={task.pipelineFailureReason || task.pipelineSkipReason}>轨迹登记未完成 · 已跳过</em>}{task.workflowConflict && <em className="duplicate-chip">流程冲突</em>}{task.reviewStatus && <em className={`review-chip ${task.reviewStatus}`}>{reviewStatusLabel[task.reviewStatus]}</em>}{task.ruleIssues?.length > 0 && <em className="rule-chip">规则问题 {task.ruleIssues.length}</em>}{task.trajectoryValidationError && <em className="rule-chip">轨迹登记失败</em>}{task.duplicateFields?.length > 0 && <em className="duplicate-chip">{task.duplicateFields.map((field) => field === 'sessionId' ? 'session-id' : field).join(' + ')} 重复</em>}</span></span><span className={`task-upload ${trajectorySkipped ? 'skipped' : trajectoryUploaded ? 'uploaded' : 'not-uploaded'}`}><strong>{trajectorySkipped ? '不会上传' : trajectoryUploaded ? '已上传' : '未上传'}</strong><span>{task.archived && trajectoryUploaded ? '历史记录' : trajectorySkipped ? '已跳过' : '主轨迹'}</span></span><span className={`task-platform-import ${platformImported ? 'imported' : 'not-imported'}`} title={task.submissionPlatformError || (platformImported ? `平台提交 ${task.submissionPlatformSubmissionId || ''}` : '尚未提交到数据系统')}><strong>{platformImported ? '已导入' : '未导入'}</strong><span>数据系统</span></span><span className="task-completed"><strong>{formatCompletionTime(task.finishedAt)}</strong><span>完成时间</span></span><span className="task-export-count"><strong>{Number(task.exportCount || 0)}</strong><span>导出次数</span></span><span className="task-events"><strong>{task.eventCount ? formatNumber(task.eventCount) : statusLabel[task.status]}</strong><span>{task.eventCount ? 'events' : 'status'}</span></span><ChevronRight size={16} className="row-chevron" /></button></div>; })}
              {!filteredTasks.length && <div className="empty-task-list">没有符合当前筛选条件的任务</div>}
            </div>
            {filteredTasks.length > 0 && <nav className="pagination" aria-label="任务队列分页"><span className="pagination-summary">第 {pageStart + 1}-{Math.min(pageStart + pageSize, filteredTasks.length)} 项，共 {filteredTasks.length} 项</span><label>每页<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label><div className="pagination-pages"><button type="button" title="上一页" aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button>{Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => <button type="button" className={pageNumber === currentPage ? 'active' : ''} aria-current={pageNumber === currentPage ? 'page' : undefined} key={pageNumber} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}<button type="button" title="下一页" aria-label="下一页" disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={15} /></button></div></nav>}
            <div className="panel-footer"><span><CircleDot size={14} />流水线自动产出；手动任务单独启动</span><span>{reviewMessage || (isRunning ? `手动任务并发 ${currentTasks.length} / 4 · 日志 ${runState.logs?.length || 0} 条` : `${qualified.length} 条合格 · ${pendingReviewCount} 条待审核 · 重复 session ${duplicateSessionCount} / bug_id ${duplicateBugCount}`)}</span></div>
          </div>

          <aside className="panel activity-panel"><div className="panel-heading"><div><h2>运行动态</h2><span className="panel-subtitle">实时日志与最近完成记录</span></div><span className="count-pill">{isRunning ? runState.logs?.length || 0 : recentTasks.length}</span></div><div className="activity-list">{isRunning && (runState.logs || []).slice(-6).reverse().map((log, index) => <div className="activity-item" key={`${log.at}-${index}`}><div className={`activity-marker ${index === 0 ? 'latest' : ''}`}><span /></div><div className="activity-body"><div className="activity-meta"><time>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className={`status-chip ${log.level === 'error' ? 'red' : log.level === 'warn' ? 'blue' : 'green'}`}>{log.level === 'error' ? '异常' : log.level === 'warn' ? '提示' : '运行中'}</span></div><strong>{log.message}</strong><p>Claude Code CLI 实时输出</p></div></div>)}{!isRunning && recentTasks.map((task, index) => <div className="activity-item" key={task.id}><div className={`activity-marker ${index === 0 ? 'latest' : ''}`}><span /></div><div className="activity-body"><div className="activity-meta"><time>{new Date(task.finishedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className={`status-chip ${task.reviewStatus === 'qualified' ? 'green' : task.reviewStatus === 'unqualified' ? 'red' : 'blue'}`}>{reviewStatusLabel[task.reviewStatus]}</span></div><strong>{task.sessionId}</strong><p>{task.bug_id} · {formatNumber(task.eventCount)} events</p></div></div>)}{!isRunning && !recentTasks.length && <div className="empty-activity">暂无运行记录</div>}</div><div className="activity-footer">所有历史任务均保留在左侧队列</div></aside>
        </section>

        <section className="export-band">
          <div className="export-copy"><div className="export-icon"><CloudUpload size={19} /></div><div><h2>交付数据</h2><p>主轨迹上传并通过交付校验后，新任务会自动提交质检平台。</p>{(cloudMessage || cloudState.lastError) && <span className={`cloud-message ${cloudState.lastError ? 'cloud-message-error' : ''}`}>{cloudMessage || cloudState.lastError}</span>}{(submissionPlatformMessage || submissionPlatformState.lastError) && <span className={`cloud-message ${submissionPlatformState.lastError ? 'cloud-message-error' : ''}`}>{submissionPlatformMessage || submissionPlatformState.lastError}</span>}{exportFeedback.message && <span className={`cloud-message ${exportFeedback.error ? 'cloud-message-error' : ''}`}>{exportFeedback.message}</span>}</div></div>
          <div className="export-actions cloud-actions">
            {cloudState.connected && <span className="cloud-connected"><CheckCircle2 size={14} />{cloudState.connectedAs}</span>}
            {cloudState.autoLoginConfigured && <span className="cloud-auto-login" title={cloudState.lastRefreshedAt ? `最近自动刷新：${formatCompletionTime(cloudState.lastRefreshedAt)}` : '凭据已保存到 macOS 钥匙串'}><RefreshCcw size={13} />自动登录</span>}
            {!cloudState.connected && <button className="secondary-button" onClick={openCloudLogin}><LogIn size={16} />{cloudState.autoLoginConfigured ? '重新连接' : '连接云盘'}</button>}
            {cloudState.connected && !cloudState.autoLoginConfigured && <button className="secondary-button" onClick={openCloudLogin}><LogIn size={16} />启用自动登录</button>}
            {(cloudState.connected || cloudState.autoLoginConfigured) && <button className="icon-button" disabled={cloudBusy} onClick={disconnectCloud} title="断开云盘并删除钥匙串凭据" aria-label="断开云盘并删除钥匙串凭据"><LogOut size={16} /></button>}
            {submissionPlatformState.connected && <a className="cloud-connected" href="https://go.jzxhnh.com/u/submissions" target="_blank" rel="noreferrer"><CheckCircle2 size={14} />质检平台 · {submissionPlatformState.connectedAs}</a>}
            {submissionPlatformState.syncPaused && <span className="rule-chip" title={submissionPlatformState.syncPauseReason || '等待质检平台恢复'}>平台维护中 · 待补 {submissionPlatformState.deferredSubmissionCount}</span>}
            {submissionPlatformState.pendingRepairCount > 0 && <span className="rule-chip" title={submissionPlatformState.reviewLastSyncedAt ? `最近同步：${formatCompletionTime(submissionPlatformState.reviewLastSyncedAt)}` : '等待同步平台审核状态'}>平台待返修 {submissionPlatformState.pendingRepairCount}</span>}
            {!submissionPlatformState.connected && <button className="secondary-button" onClick={openSubmissionPlatformLogin}><LogIn size={16} />{submissionPlatformState.autoLoginConfigured ? '重连提交平台' : '连接提交平台'}</button>}
            {submissionPlatformState.connected && <button className="secondary-button" disabled={submissionPlatformBusy} onClick={() => controlSubmissionPlatform(!submissionPlatformState.syncPaused)}>{submissionPlatformState.syncPaused ? <Play size={16} /> : <Pause size={16} />}{submissionPlatformState.syncPaused ? '恢复平台提交' : '暂停平台提交'}</button>}
            {(submissionPlatformState.connected || submissionPlatformState.autoLoginConfigured) && <button className="icon-button" disabled={submissionPlatformBusy} onClick={disconnectSubmissionPlatform} title="断开提交平台并删除钥匙串凭据" aria-label="断开提交平台并删除钥匙串凭据"><LogOut size={16} /></button>}
            <button className="secondary-button" disabled={cloudBusy} onClick={openTrajectoryUpload}><CloudUpload size={16} />手动补传轨迹</button>
            <button className="secondary-button" disabled={!exportReady.length || excelExportProgress.busy} title={exportReady.length ? `导出 ${exportReady.length} 条已完成采集登记和云盘回填的任务` : '暂无已完成云盘回填的合格任务'} onClick={() => exportExcelWithTracking(exportReady)}><FileSpreadsheet size={16} />{excelExportProgress.busy ? `${excelExportProgress.phase === 'validating' ? '校验中' : excelExportProgress.phase === 'generating' ? '生成中' : '登记中'} ${excelExportProgress.completed}/${excelExportProgress.total}` : `Excel (${exportReady.length})`}</button>
          </div>
        </section>
      </main>

      {activeTask && (
        <div className="drawer-backdrop" onClick={() => setActiveTask(null)}>
          <aside className="detail-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header"><div><span className="drawer-kicker">任务详情 / SESSION-ID</span><h2>{taskSessionLabel(activeTask)}</h2></div><button className="icon-button" onClick={() => setActiveTask(null)} title="关闭详情" aria-label="关闭详情"><X size={18} /></button></div>
            <div className="drawer-status">
              <span className={`status-chip ${activeTask.status === 'passed' ? 'green' : ['failed', 'duplicate', 'skipped'].includes(activeTask.status) ? 'red' : 'blue'}`}>{activeTask.status === 'passed' ? <CheckCircle2 size={14} /> : ['failed', 'duplicate', 'skipped'].includes(activeTask.status) ? <XCircle size={14} /> : <Clock3 size={14} />}{statusLabel[activeTask.status]}</span>
              {activeTask.reviewStatus && <span className={`status-chip ${activeTask.reviewStatus === 'qualified' ? 'green' : activeTask.reviewStatus === 'unqualified' ? 'red' : 'blue'}`}>{activeTask.reviewStatusSource === 'rule' ? '规则' : activeTask.reviewStatusSource === 'pipeline' ? '自动' : activeTask.reviewStatusSource === 'historical-archive' ? '恢复' : '人工'}：{reviewStatusLabel[activeTask.reviewStatus]}</span>}
              <span className={`status-chip ${activeTask.gitStatus === 'passed' ? 'green' : activeTask.gitStatus === 'failed' ? 'red' : 'blue'}`}>Git：{activeTask.gitStatus === 'passed' ? activeTask.task_type === 'diagnosis' ? '红分支已交付' : '双修复已交付' : activeTask.gitStatus === 'prepared' ? 'Gold 已准备，等待 Claude' : activeTask.gitStatus === 'failed' ? '准备链路不完整' : '历史任务'}</span>
              {activeTask.duplicateFields?.length > 0 && <span className="status-chip red">身份重复</span>}
              {activeTask.workflowConflict && <span className="status-chip red">流程冲突</span>}
            </div>
            {activeTask.status === 'skipped' && <div className="hard-rule-alert"><strong>轨迹不合格，系统不会上传</strong><p>{activeTask.pipelineSkipReason || '轨迹连续 3 次未通过规范，流水线已跳过该 Bug。'}</p>{activeTask.pipelineFailureReason && <pre className="pipeline-failure-reason">{activeTask.pipelineFailureStage ? `${activeTask.pipelineFailureStage}：` : ''}{activeTask.pipelineFailureReason}</pre>}</div>}
            {activeTask.ruleIssues?.length > 0 && <div className="hard-rule-alert"><strong>交付字段或项目规则未通过</strong><ul>{activeTask.ruleIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
            {activeTask.trajectoryValidationError && <div className="hard-rule-alert"><strong>轨迹文件违规</strong><p>{activeTask.trajectoryValidationError}</p></div>}
            {activeTask.gitStatus === 'failed' && <div className="hard-rule-alert"><strong>Git 准备流程未通过</strong><p>{Number(activeTask.workflow_version || 1) >= 3 ? '运行前必须完成 main 与每个 Bug 独立 orphan green 基线；修复结果发布到 bugN_green，并生成独立 bugN_red 验收快照。' : '运行前必须完成 Claude 生成的 main、对应编号的 bug_main / BUG_BASE 分支；修复结果由 Claude 发布到 test_model_fix。'}</p></div>}
            <dl className="detail-list">
              <div><dt>任务 ID</dt><dd>{activeTask.id}</dd></div><div><dt>业务任务</dt><dd>{activeTask.bug_id}</dd></div><div><dt>Session</dt><dd>{taskSessionLabel(activeTask)}</dd></div>{activeTask.archived && <div><dt>记录状态</dt><dd>{activeTask.archiveExportReady ? '历史恢复 · 云盘原件已校验，可导出' : '历史恢复 · 本地工件尚未恢复'}</dd></div>}<div><dt>数据系统</dt><dd>{activeTask.submissionPlatformImported ? `已导入${activeTask.submissionPlatformSubmittedAt ? `；${formatCompletionTime(activeTask.submissionPlatformSubmittedAt)}` : ''}${activeTask.submissionPlatformSubmissionId ? `；提交 ${activeTask.submissionPlatformSubmissionId}` : ''}` : `未导入${activeTask.submissionPlatformError ? `；${activeTask.submissionPlatformError}` : ''}`}</dd></div><div><dt>导出记录</dt><dd>共 {Number(activeTask.exportCount || 0)} 次（轨迹 {Number(activeTask.trajectoryExportCount || 0)} 次，Excel {Number(activeTask.excelExportCount || 0)} 次）{activeTask.lastExportedAt ? `；最近 ${formatCompletionTime(activeTask.lastExportedAt)}` : ''}</dd></div>
              {activeTask.submissionPlatformReviewStatus && <div><dt>平台审核</dt><dd>{activeTask.submissionPlatformReviewLabel || activeTask.submissionPlatformReviewStatus}{activeTask.submissionPlatformReviewReason ? `；${activeTask.submissionPlatformReviewReason}` : ''}</dd></div>}
              <div><dt>审核状态</dt><dd>{activeTask.reviewStatus ? reviewStatusLabel[activeTask.reviewStatus] : '轨迹尚未生成'}{activeTask.reviewStatusSource === 'rule' ? '（交付规则自动判定）' : ''}{activeTask.duplicateFields?.length > 0 ? `；重复字段：${activeTask.duplicateFields.map((field) => field === 'sessionId' ? 'session-id' : field).join('、')}` : ''}</dd></div>
              {Number(activeTask.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION && <div><dt>修复前证明</dt><dd>{activeTask.verification_evidence?.pre_fix?.trajectory_url ? `已上传 · ${activeTask.verification_evidence.pre_fix.result}` : activeTask.verificationEvidenceRecorded ? '已上传（历史记录）' : activeTask.verification_evidence?.pre_fix?.session_id ? '已生成，等待上传' : '等待新 Session 验证'}</dd></div>}
              {Number(activeTask.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION && <div><dt>修复后证明</dt><dd>{activeTask.task_type === 'diagnosis' ? '不需要（diagnosis 只传运行前证明）' : activeTask.verification_evidence?.post_fix?.trajectory_url ? `已上传 · ${activeTask.verification_evidence.post_fix.result}` : activeTask.verificationEvidenceRecorded ? '已上传（历史记录）' : activeTask.verification_evidence?.post_fix?.session_id ? '已生成，等待上传' : '等待新 Session 验证'}</dd></div>}
              <div><dt>生产流程</dt><dd>{activeTask.project_origin === 'generated_0to1' ? (Number(activeTask.workflow_version || 1) >= 2 ? `Codex 出题 → ${activeTask.project_generation_provider === 'deepseek' ? 'DeepSeek' : 'Claude'} 生成 0-1 → Git 前确定${activeTask.bug_source === 'injected' ? '独立注入' : '自然'} Bug ${activeTask.bug_index || ''} → 双修复` : `Codex 出题 → ${activeTask.project_generation_provider === 'deepseek' ? 'DeepSeek' : 'Claude'} 生成 0-1 → Codex 找到已有 Bug ${activeTask.bug_index || ''} → 双修复`) : '历史仓库题目（仅保留历史记录）'}{activeTask.trajectory_count ? ` · 当前 Bug ${activeTask.trajectory_count} 条轨迹` : ''}</dd></div>
              <div><dt>生成分工</dt><dd>{activeTask.project_prompt_author === 'codex' && activeTask.project_generator === 'claude_code_cli' ? `Codex 设计项目题目 · ${projectGeneratorLabel(activeTask)} 生成项目` : '历史任务未记录生成分工'}</dd></div>
              <div><dt>Git 提交流程</dt><dd>{activeTask.gitStatus === 'passed' ? activeTask.task_type === 'diagnosis' ? `${activeTask.main_branch} → ${activeTask.red_branch || 'bugN_red'}（R1）` : Number(activeTask.workflow_version || 1) >= 3 ? `${activeTask.main_branch} → ${activeTask.green_branch || activeTask.bug_base_branch}（G1/G2）→ ${activeTask.red_branch || 'bugN_red'}（R1）` : `${activeTask.main_branch} → ${activeTask.bug_main_branch} → ${activeTask.bug_base_branch} → ${activeTask.test_model_fix_branch}` : activeTask.gitStatus === 'prepared' ? (Number(activeTask.workflow_version || 1) >= 3 ? `${activeTask.green_branch || activeTask.bug_base_branch} G1 已完成；等待 Claude G2` : `${activeTask.bug_main_branch} → ${activeTask.bug_base_branch} 已完成；等待 Claude ${activeTask.test_model_fix_branch}`) : activeTask.gitStatus === 'missing' ? '历史任务未记录新 Git 提交流程' : '运行前 Git 准备不完整'}</dd></div>
              {activeTask.gitStatus === 'passed' && <div><dt>{activeTask.task_type === 'diagnosis' ? '诊断验收提交' : 'Claude 修复提交'}</dt><dd><a href={activeTask.repo_url} target="_blank" rel="noreferrer">{activeTask.repo_url}<ChevronRight size={14} /></a></dd></div>}
              {activeTask.gold_patch && <div><dt>历史 Gold 提交</dt><dd><a href={activeTask.gold_patch} target="_blank" rel="noreferrer">{activeTask.gold_patch}<ChevronRight size={14} /></a></dd></div>}
              <div><dt>项目来源</dt><dd>{activeTask.repository ? <a href={activeTask.repository} target="_blank" rel="noreferrer">{activeTask.project_origin === 'generated_0to1' ? `${activeTask.project_generation_provider === 'deepseek' ? 'DeepSeek' : 'Claude'} 生成的 0-1 Git 仓库` : activeTask.repoName}<ChevronRight size={14} /></a> : activeTask.project_origin === 'generated_0to1' ? '0-1 项目尚未填写 Git 仓库' : '历史项目（无仓库链接）'}</dd></div><div><dt>类型 / 分类</dt><dd>{activeTask.task_type} <span className="dot-divider">·</span> {activeTask.bug_category}</dd></div><div><dt>轨迹规模</dt><dd>{formatNumber(activeTask.eventCount)} events <span className="dot-divider">·</span> {formatNumber(activeTask.totalBytes / 1024)} KB</dd></div><div><dt>SHA-256</dt><dd className="mono">{activeTask.sha256 || '待生成'}</dd></div>
            </dl>
            <div className="drawer-section"><div className="drawer-section-title">验证命令</div><pre>{Array.isArray(activeTask.verify_cmds) ? activeTask.verify_cmds.join('\n') : activeTask.verify_cmds}</pre></div><div className="drawer-section"><div className="drawer-section-title">运行时间</div><div className="run-times"><span><Clock3 size={14} />开始 {activeTask.startedAt ? formatCompletionTime(activeTask.startedAt) : '未记录'}</span><span><CheckCircle2 size={14} />完成 {formatCompletionTime(activeTask.finishedAt)}</span></div></div>
            <div className="drawer-actions"><button className="secondary-button" disabled={activeTask.status !== 'passed' || trajectoryExportBusy || !canExportArchivedTask(activeTask)} onClick={() => exportTaskTrajectory(activeTask)}><Download size={15} />{trajectoryExportBusy ? '正在导出…' : '导出轨迹 JSON'}</button><button className="secondary-button" disabled={!canExportArchivedTask(activeTask)} onClick={() => validateTask(activeTask)}><CheckCheck size={15} />校验此题 JSON</button><button className="secondary-button" disabled={isRunning || activeTask.status === 'running' || activeTask.archived} onClick={() => openRegenerateConfirm([activeTask.id])}><RefreshCcw size={15} />重新生成轨迹</button></div>
          </aside>
        </div>
      )}
      {showRuleValidator && <div className="drawer-backdrop" onClick={() => setShowRuleValidator(false)}><aside className="detail-drawer rule-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="drawer-kicker">SCHEMA / GO LABEL</span><h2>交付字段校验</h2></div><button className="icon-button" onClick={() => setShowRuleValidator(false)} title="关闭校验" aria-label="关闭校验"><X size={18} /></button></div><p className="rule-intro">校验标注字段、项目证据和交付条件；主轨迹只登记原始文件，红绿证明按 V5 规则校验。</p><label className="rule-upload"><FileJson size={16} /><span>{ruleFileName || '选择 JSON 文件'}</span><input type="file" accept="application/json,.json" onChange={handleRuleFile} /></label><textarea className="rule-textarea" value={ruleInput} onChange={(event) => { setRuleInput(event.target.value); setRuleResult(null); }} placeholder="粘贴待校验的标注行 JSON 内容…" spellCheck="false" /><div className="rule-actions"><button className="secondary-button" disabled={!exportReady.length} onClick={() => { setRuleInput(JSON.stringify(exportReady.map(taskToRuleRecord), null, 2)); setRuleFileName('采集登记及云盘回填完成题目（17 字段）'); setRuleResult(null); }}><FileJson size={15} />载入合格 JSON</button><button className="primary-button" onClick={() => validateRuleJson()}><CheckCheck size={15} />开始校验</button></div>{ruleResult && <div className={`rule-result ${ruleResult.ok ? 'rule-result-ok' : 'rule-result-fail'}`}><div className="rule-result-heading">{ruleResult.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<strong>{ruleResult.ok ? `校验通过 · ${ruleResult.count} 条` : `校验失败 · ${ruleResult.issues.length} 个问题`}</strong></div>{ruleResult.ok ? <p>字段、项目证据和交付条件符合规则；轨迹内容质量未参与判定。</p> : <ul>{ruleResult.issues.map((issue, index) => <li key={`${issue.section}-${issue.message}-${index}`}><b>{issue.section}</b>：{issue.message}</li>)}</ul>}</div>}</aside></div>}
      {showCloudLogin && <div className="drawer-backdrop cloud-login-backdrop" onClick={() => !cloudBusy && setShowCloudLogin(false)}><form className="cloud-login-dialog" onSubmit={connectCloud} onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="drawer-kicker">UPLOAD.JZXHNH.COM</span><h2>连接轨迹云盘</h2></div><button type="button" className="icon-button" onClick={() => setShowCloudLogin(false)} title="关闭" aria-label="关闭"><X size={18} /></button></div><p>密码仅保存到本机 macOS 钥匙串，用于会话失效后的自动登录；不会写入任务文件、Excel、日志或前端存储。</p><label>账号<input autoComplete="username" value={cloudUsername} onChange={(event) => setCloudUsername(event.target.value)} required /></label><label>密码<input type="password" autoComplete="current-password" value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} required /></label>{cloudMessage && <div className="cloud-login-message">{cloudMessage}</div>}<button className="primary-button" disabled={cloudBusy} type="submit"><LogIn size={16} />{cloudBusy ? '连接中' : '连接并启用自动登录'}</button></form></div>}
      {showSubmissionPlatformLogin && <div className="drawer-backdrop cloud-login-backdrop" onClick={() => !submissionPlatformBusy && setShowSubmissionPlatformLogin(false)}><form className="cloud-login-dialog" onSubmit={connectSubmissionPlatform} onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="drawer-kicker">GO.JZXHNH.COM</span><h2>连接质检提交平台</h2></div><button type="button" className="icon-button" onClick={() => setShowSubmissionPlatformLogin(false)} title="关闭" aria-label="关闭"><X size={18} /></button></div><p>使用普通用户提交接口；密码只保存到本机 macOS 钥匙串，不写入任务、轨迹、日志或前端存储。</p><label>账号<input autoComplete="username" value={submissionPlatformUsername} onChange={(event) => setSubmissionPlatformUsername(event.target.value)} required /></label><label>密码<input type="password" autoComplete="current-password" value={submissionPlatformPassword} onChange={(event) => setSubmissionPlatformPassword(event.target.value)} required /></label>{submissionPlatformMessage && <div className="cloud-login-message">{submissionPlatformMessage}</div>}<button className="primary-button" disabled={submissionPlatformBusy} type="submit"><LogIn size={16} />{submissionPlatformBusy ? '连接中' : '连接并启用自动提交'}</button></form></div>}
      {showTrajectoryUpload && (
        <div className="drawer-backdrop trajectory-upload-backdrop" onClick={() => !cloudBusy && setShowTrajectoryUpload(false)}>
          <section className="trajectory-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="trajectory-upload-title" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <div><span className="drawer-kicker">PERMANENT SIGNED URL</span><h2 id="trajectory-upload-title">上传轨迹 JSON / JSONL</h2></div>
              <button type="button" className="icon-button" disabled={cloudBusy} onClick={() => setShowTrajectoryUpload(false)} title="关闭" aria-label="关闭"><X size={18} /></button>
            </div>
            <label
              className={`trajectory-dropzone ${trajectoryDragActive ? 'drag-active' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setTrajectoryDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); if (!event.currentTarget.contains(event.relatedTarget)) setTrajectoryDragActive(false); }}
              onDrop={(event) => { event.preventDefault(); setTrajectoryDragActive(false); addTrajectoryFiles(event.dataTransfer.files); }}
            >
              <CloudUpload size={46} strokeWidth={1.7} />
              <strong>点击选择文件，或拖拽到此处</strong>
              <span>可一次选择多个 JSON 或 JSONL 文件，按 session ID 自动匹配</span>
              <input ref={trajectoryFileInputRef} type="file" accept="application/json,application/x-ndjson,.json,.jsonl" multiple onChange={(event) => { addTrajectoryFiles(event.target.files); event.target.value = ''; }} />
            </label>
            {trajectoryFiles.length > 0 && (
              <div className="trajectory-file-list" aria-label="待上传文件">
                {trajectoryFiles.map((item) => (
                  <div className={`trajectory-file-row ${item.status}`} key={item.file.name}>
                    <FileJson size={18} />
                    <div><strong>{item.file.name}</strong><span>{formatNumber(item.file.size)} bytes · {item.sessionId}</span></div>
                    <span className="trajectory-file-status">
                      {item.status === 'uploading' ? <RefreshCcw size={15} className="spin" /> : item.status === 'uploaded' ? <CheckCircle2 size={16} /> : item.status === 'failed' ? <XCircle size={16} /> : null}
                      {item.message}
                    </span>
                    <button type="button" className="icon-button" disabled={cloudBusy} onClick={() => setTrajectoryFiles((current) => current.filter((candidate) => candidate.file.name !== item.file.name))} title="移除文件" aria-label={`移除 ${item.file.name}`}><X size={15} /></button>
                  </div>
                ))}
              </div>
            )}
            {trajectoryUploadMessage && <div className={`trajectory-upload-message ${trajectoryFiles.some((item) => item.status === 'failed') ? 'error' : ''}`}>{trajectoryUploadMessage}</div>}
            <div className="trajectory-upload-actions">
              <button type="button" className="secondary-button" disabled={cloudBusy} onClick={() => setShowTrajectoryUpload(false)}>取消</button>
              <button type="button" className="primary-button" disabled={cloudBusy || !trajectoryFiles.length} onClick={uploadSelectedTrajectories}><CloudUpload size={16} />{cloudBusy ? '正在上传' : '开始上传'}</button>
            </div>
          </section>
        </div>
      )}
      {showRegenerateConfirm && (
        <div className="drawer-backdrop regenerate-backdrop" onClick={() => !regenerateBusy && setShowRegenerateConfirm(false)}>
          <section className="regenerate-dialog" role="dialog" aria-modal="true" aria-labelledby="regenerate-title" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header"><div><span className="drawer-kicker">NEW SESSION / HARD VALIDATION</span><h2 id="regenerate-title">重新生成 {regenerateTasks.length} 道轨迹</h2></div><button type="button" className="icon-button" disabled={regenerateBusy} onClick={() => setShowRegenerateConfirm(false)} title="关闭" aria-label="关闭"><X size={18} /></button></div>
            <div className="regenerate-task-list">{regenerateTasks.map((task) => <span key={task.id}>{task.sessionId || '无 session'} · {task.bug_id}</span>)}</div>
            <div className="regenerate-guard-list"><span><CheckCircle2 size={15} />旧轨迹和旧 workspace 归档保留</span><span><CheckCircle2 size={15} />从 pristine 重建并隔离系统 grader</span><span><CheckCircle2 size={15} />新 Session 完成采集登记后生效</span></div>
            <label className="regenerate-feedback">内部审核备注<textarea value={regenerateFeedback} onChange={(event) => setRegenerateFeedback(event.target.value)} placeholder="可选：仅归档供人工追溯，不会发送给 Claude 或写入轨迹" /></label>
            <div className="trajectory-upload-actions"><button type="button" className="secondary-button" disabled={regenerateBusy} onClick={() => setShowRegenerateConfirm(false)}>取消</button><button type="button" className="danger-button" disabled={regenerateBusy || !regenerateTasks.length} onClick={regenerateTrajectories}>{regenerateBusy ? <RefreshCcw size={16} className="spin" /> : <RefreshCcw size={16} />}{regenerateBusy ? '正在归档并启动' : '归档并重新生成'}</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
