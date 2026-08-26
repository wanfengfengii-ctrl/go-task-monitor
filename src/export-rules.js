import { getGoVersionRuleIssues, getGoldRootCauseRuleIssues, resolvePinnedGoVersion } from './review-rules.js';
import { getClaudeHarnessIssues } from './harness-rules.js';
import { isVerificationPolicyV5, serializeVerificationResult, VERIFICATION_POLICY_VERSION } from './verification-evidence.js';
import { directPublicVerifyCommandIssues, isConcurrencyVerificationRecord } from './verification-proof.js';
import { bugCategoryLabel } from './bug-policy.js';
import { normalizeDiagnosisPublicCommand } from './diagnosis-verification.js';

export const EXCEL_EXPORT_FIELDS = [
  'session  id',
  'bug_id',
  'task_type',
  'bug_category',
  'repo_url',
  'go_version',
  'repro_determinism',
  'user_query',
  'trajectory',
  'verify_cmds',
  'gold_root_cause',
  'success_criteria',
  'verify_result',
  'harness',
  'generator_model',
];

const removedHarnessKeys = new Set([
  'trajectory_events',
  'api_retry',
  'workspace_policy',
]);

export function hasChineseText(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(String(value ?? ''));
}

const englishProseWords = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by',
  'each', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its',
  'no', 'not', 'of', 'on', 'only', 'or', 'so', 'still', 'than', 'that', 'the',
  'then', 'there', 'this', 'through', 'to', 'was', 'were', 'when', 'while', 'with',
  'without',
]);

export function hasEnglishProse(value) {
  const text = String(value ?? '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/(?:^|\n)\s*(?:公开复现命令|复现命令|验证命令)\s*[：:]\s*[^\n]*/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/(?:[A-Za-z0-9_.*{}()-]+\/)+[A-Za-z0-9_.*{}()\/-]+/gu, ' ');
  return text.split(/[\u3400-\u4dbf\u4e00-\u9fff]+/u).some((fragment) => {
    const words = fragment.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) || [];
    if (words.length < 7) return false;
    return words.filter((word) => englishProseWords.has(word.toLowerCase())).length >= 3;
  });
}

export function isChineseDescription(value) {
  return hasChineseText(value) && !hasEnglishProse(value);
}

export function stripMarkdownBackticks(value) {
  return String(value ?? '').replace(/`+/g, '').trim();
}

export function naturalizeGoldRootCause(value) {
  const text = stripMarkdownBackticks(value);
  const fixed = text.match(/^问题文件\s*[：:]\s*([\s\S]+?)；\s*问题符号\s*[：:]\s*([\s\S]+?)；\s*失效机制\s*[：:]\s*([\s\S]+)$/u);
  if (!fixed) return text;

  const files = fixed[1].trim();
  const symbols = fixed[2].trim();
  const mechanism = fixed[3]
    .trim()
    .replace(/^根本原因是\s*/u, '')
    .replace(/^内部原因是\s*/u, '')
    .replace(/；\s*传播过程是\s*/gu, '；')
    .replace(/；\s*最终导致\s*/gu, '，最终导致');
  return `${files} 中的 ${symbols} 根本原因是${mechanism}`.trim();
}

export function buildGoldRootCause({ target_files = [], gold_files = [], symbols = [], gold_symbols = [], failure_mechanism = '', state_or_resource_impact = '' } = {}) {
  const preferredFiles = Array.isArray(gold_files) && gold_files.length ? gold_files : target_files;
  const preferredSymbols = Array.isArray(gold_symbols) && gold_symbols.length ? gold_symbols : symbols;
  const files = [...new Set((Array.isArray(preferredFiles) ? preferredFiles : []).map(String).map((value) => value.trim()).filter(Boolean))];
  const symbolList = [...new Set((Array.isArray(preferredSymbols) ? preferredSymbols : []).map(String).map((value) => value.trim()).filter(Boolean))];
  const mechanism = stripMarkdownBackticks(failure_mechanism);
  const build = (value) => naturalizeGoldRootCause(`问题文件：${files.join('、') || '未记录'}；问题符号：${symbolList.join('、') || '未记录'}；失效机制：${value}`);
  let rootCause = build(mechanism);
  let issues = getGoldRootCauseRuleIssues({ gold_root_cause: rootCause, gold_files: files, gold_symbols: symbolList });
  const impact = stripMarkdownBackticks(state_or_resource_impact).replace(/[。；;\s]+$/u, '');
  if (issues.some((issue) => issue.includes('失效机制')) && impact) {
    rootCause = build(`${mechanism.replace(/[。；;\s]+$/u, '')}；最终导致${impact}。`);
    issues = getGoldRootCauseRuleIssues({ gold_root_cause: rootCause, gold_files: files, gold_symbols: symbolList });
  }
  if (!isChineseDescription(rootCause)) {
    throw new Error('gold_root_cause 必须以中文为主体，完整 SQL、代码或英文说明必须改写为中文机制描述');
  }
  if (issues.length) throw new Error(issues.join('；'));
  return rootCause;
}

export function requireChineseText(value, field, bugId = '') {
  const text = String(value ?? '').trim();
  if (!text || !isChineseDescription(text)) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 ${field} 必须以中文为主体，Go 标识符和命令可以保留英文，但不能夹带英文叙述段落，已取消 Excel 导出`);
  }
  return text;
}

export function requireNonEmptyText(value, field, bugId = '') {
  const text = String(value ?? '').trim();
  if (!text) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 ${field} 不能为空，已取消 Excel 导出`);
  }
  return text;
}

export function requireChineseGoldRootCause(value, bugId = '') {
  const rootCause = requireChineseText(naturalizeGoldRootCause(value), 'gold_root_cause', bugId);
  const issues = getGoldRootCauseRuleIssues(rootCause);
  if (issues.length) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 ${issues.join('；')}，已取消 Excel 导出`);
  }
  return rootCause;
}

export function isCloudTrajectoryUrl(value) {
  return /^https:\/\/[^\s]+$/i.test(String(value ?? '').trim());
}

export function isCloudTrajectoryFileUrl(value) {
  const text = String(value ?? '').trim();
  return isCloudTrajectoryUrl(text) && /\.jsonl?(?:\?|$)/i.test(text);
}

export function requireCloudTrajectoryUrl(value, bugId = '') {
  const text = String(value ?? '').trim();
  if (!isCloudTrajectoryFileUrl(text)) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 缺少已上传的 trajectory 云盘链接，请先上传通过校验的 JSON 或 JSONL`);
  }
  return text;
}

export function isGitCommitUrl(value) {
  return /^https:\/\/[^\s]+\/commit\/[0-9a-f]{40}(?:[^\s]*)?$/i.test(String(value ?? '').trim());
}

export function requireGitCommitUrl(value, field, bugId = '') {
  const text = String(value ?? '').trim();
  if (!isGitCommitUrl(text)) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 ${field} 必须是完整 HTTPS Git commit 地址，已取消 Excel 导出`);
  }
  return text;
}

export function gitReviewBranchRole(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^https:\/\/[^\s]+\/tree\/(?:bug-?\d+(?:_|\/))?(red|green)(?:[12])?$/i);
  return match ? match[1].toLowerCase() : '';
}

export function isGitTestModelBranchUrl(value, expectedRole = '') {
  const role = gitReviewBranchRole(value);
  return Boolean(role) && (!expectedRole || role === String(expectedRole).trim().toLowerCase());
}

export function requireGitTestModelBranchUrl(value, bugId = '', taskType = '') {
  const text = String(value ?? '').trim();
  const expectedRole = taskType === 'diagnosis' ? 'red' : taskType === 'bugfix' ? 'green' : '';
  if (!isGitTestModelBranchUrl(text, expectedRole)) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    const roleLabel = expectedRole ? `${expectedRole} ` : 'red/green ';
    throw new Error(`${taskLabel} 的 repo_url 必须使用显式 ${roleLabel}分支（如 .../tree/bug1_${expectedRole || 'green'}、.../tree/bug1/${expectedRole || 'green'} 或 .../tree/${expectedRole || 'green'}）；test_model_fix 等无法识别红绿角色的分支禁止提交，已取消 Excel 导出`);
  }
  return text;
}

export function stripVerifyPassPrefix(value) {
  return String(value ?? '')
    .replace(/^\s*PASS\b\s*[；;：:,，、.-]?\s*/i, '')
    .trim();
}

export function requirePinnedGoVersion(value, bugId = '') {
  const text = String(value ?? '').trim();
  const [issue] = getGoVersionRuleIssues(text);
  if (issue) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 ${issue}，已取消 Excel 导出`);
  }
  return text;
}

export function sanitizeHarness(value) {
  const parts = String(value ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.split('=', 1)[0].trim().toLowerCase();
      return !removedHarnessKeys.has(key) && !key.startsWith('permission');
    });

  return parts.length ? `${parts.join('; ')};` : '';
}

export function requireDockerVerifyCmds(value, taskType, bugId = '') {
  const text = (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim();
  const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if ((taskType === 'diagnosis' || taskType === 'bugfix') && !lines.some((line) => /^docker\s+/i.test(line))) {
    const issues = [];
    if (lines.length !== 1) issues.push('必须且只能填写一条真实公开复现命令');
    const command = lines[0] || '';
    if (/run_docker\.sh/i.test(command)) issues.push('不能只填写 run_docker.sh 封装命令');
    if (!/^(?:GOTOOLCHAIN=local\s+)?go\s+(?:test|run)\b/i.test(command)) {
      issues.push('必须是可直接执行的 go test 命令');
    }
    if (/\bundefined\b/i.test(command)) issues.push('不能包含完整单词 undefined');
    if (/\b(?:docker|git|gh)\b|https?:\/\/|\/(?:private\/)?tmp\/|\/var\/folders\//i.test(command)) {
      issues.push('不能依赖 Docker、Git、外部网络或本地临时路径');
    }
    if (/[;&|]|>>?|(?:^|\s)(?:sed|perl)\s+-i\b|\b(?:rm|mv|cp|install|tee|truncate|touch|mkdir|python\d*|perl|ruby|node)\b/i.test(command)) {
      issues.push('必须是只读直接命令，不能写文件、重定向或调用辅助脚本');
    }
    if (issues.length) throw new Error(`${taskLabel} 的 ${taskType} verify_cmds 不合格：${issues.join('；')}，已取消 Excel 导出`);
    return text;
  }
  const issues = [];
  if (lines.some((line) => /\bundefined\b/i.test(line))) issues.push('不能包含完整单词 undefined');
  if (lines.some((line) => /run_docker\.sh/i.test(line))) issues.push('不能只填写 run_docker.sh 封装命令');
  if (/[；。]/u.test(text)) issues.push('不能使用中文分号或句号连接命令');
  for (const platform of ['linux/arm64', 'linux/amd64']) {
    const escapedPlatform = platform.replace('/', '\\/');
    const rootBuild = new RegExp(`^docker\\s+build\\b.*--platform\\s+${escapedPlatform}\\b.*-f\\s+benzhi\\.Dockerfile\\b.*\\s\\.$`, 'i');
    const packagedBuild = new RegExp(`^docker\\s+build\\b.*--platform\\s+${escapedPlatform}\\b.*-f\\s+workspace/benzhi\\.Dockerfile\\b.*\\sworkspace$`, 'i');
    if (!lines.some((line) => rootBuild.test(line) || packagedBuild.test(line))) issues.push(`缺少 ${platform} 的显式 docker build`);
    const runs = lines.filter((line) => line.includes(`--platform ${platform}`) && /^docker\s+run\b/i.test(line));
    const rootIsolated = (line) => /--network\s+none\b/i.test(line) && /-e\s+GOTOOLCHAIN=local\b/i.test(line) && /\$\(pwd\):\/workspace:ro/.test(line) && /-w\s+\/workspace\b/.test(line);
    const packagedIsolated = (line) => /--network\s+none\b/i.test(line)
      && ((/\$\(pwd\)\/workspace:\/workspace:ro/.test(line) && /\$\(pwd\)\/grader:\/grader:ro/.test(line))
        || (/\$\{PWD\}\/grader:\/grader:ro/.test(line) && /-e\s+GO_BIN=go\b/i.test(line)));
    const rootTarget = (line) => rootIsolated(line) && (taskType === 'bugfix'
      ? /\bgo\s+test\b[^\n]*-run\b/i.test(line)
      : /\bgo\s+test\b[^\n]*-run\b|\bcurl\b[^\n]*(?:localhost|127\.0\.0\.1)|\.\/(?:repro|test|check)/i.test(line));
    const packagedTarget = (line) => packagedIsolated(line)
      && (/\/grader\/run_target\.sh\s+\/workspace\b/i.test(line) || /\/grader\/run_target\.sh\s+\/app\b/i.test(line));
    const rootFull = (line) => rootIsolated(line) && /\bgo\s+test\s+\.\/\.\.\./i.test(line);
    const packagedFull = (line) => packagedIsolated(line)
      && (/\/grader\/run_full\.sh\s+\/workspace\b/i.test(line) || /\/grader\/run_full\.sh\s+\/app\b/i.test(line));
    if (!runs.some((line) => rootTarget(line) || packagedTarget(line))) issues.push(`缺少 ${platform} 的公开目标复现 Docker 命令`);
    if (!runs.some((line) => rootFull(line) || packagedFull(line))) issues.push(`缺少 ${platform} 的全量测试 Docker 命令`);
  }
  if (issues.length) {
    throw new Error(`${taskLabel} 的 verify_cmds 不完整：${issues.join('；')}，已取消 Excel 导出`);
  }
  return text;
}

export function requireDirectPublicVerifyCmd(value, taskType, bugId = '', options = {}) {
  const text = (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim();
  const commands = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((command) => taskType === 'diagnosis' ? normalizeDiagnosisPublicCommand(command) : command);
  const issues = directPublicVerifyCommandIssues(commands, taskType, options);
  if (issues.length) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 verify_cmds 不合格：${issues.join('；')}，已取消 Excel 导出`);
  }
  return commands.join('\n');
}

export function requireVerificationPolicyV5(value, bugId = '') {
  if (Number(value || 0) < VERIFICATION_POLICY_VERSION) {
    const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
    throw new Error(`${taskLabel} 的 verification_policy_version 必须大于等于 ${VERIFICATION_POLICY_VERSION}，旧任务没有可核验的独立红绿证明，已取消 Excel 导出`);
  }
  return Number(value);
}

export function requireDockerHarness(value, bugId = '') {
  const text = sanitizeHarness(value);
  const taskLabel = bugId ? `任务 ${bugId}` : '当前任务';
  if (!/\bbackend\s*=\s*docker-target\b/i.test(text)) {
    throw new Error(`${taskLabel} 的 harness 必须是 backend=docker-target，不能使用 local-target，已取消 Excel 导出`);
  }
  const missingPlatforms = ['linux/arm64', 'linux/amd64'].filter((platform) => !text.toLowerCase().includes(platform));
  if (missingPlatforms.length) {
    throw new Error(`${taskLabel} 的 harness 缺少双架构平台：${missingPlatforms.join('、')}，已取消 Excel 导出`);
  }
  const cliIssues = getClaudeHarnessIssues(text);
  if (cliIssues.length) {
    throw new Error(`${taskLabel} 的 harness ${cliIssues.join('；')}，已取消 Excel 导出`);
  }
  return text;
}

export function prepareExcelRecord(record) {
  requireVerificationPolicyV5(record?.verification_policy_version, record?.bug_id);
  const goVersion = resolvePinnedGoVersion(record?.go_version, record?.go_mod_version);
  const bugCategory = bugCategoryLabel(record?.bug_category) || String(record?.bug_category ?? '');
  const verifyResult = isVerificationPolicyV5(record)
    ? serializeVerificationResult(record?.verify_result, {
      taskType: record?.task_type,
      mainSessionId: record?.['session  id'] || record?.sessionId || record?.test_model_fix_session_id,
    })
    : stripVerifyPassPrefix(record?.verify_result);
  const prepared = {
    ...record,
    'session  id': record?.['session  id'] || record?.sessionId || record?.test_model_fix_session_id || '',
    bug_category: bugCategory,
    go_version: requirePinnedGoVersion(goVersion, record?.bug_id),
    trajectory: requireCloudTrajectoryUrl(record?.trajectory, record?.bug_id),
    repo_url: requireGitTestModelBranchUrl(record?.repo_url, record?.bug_id, record?.task_type),
    user_query: requireChineseText(record?.user_query, 'user_query', record?.bug_id),
    verify_cmds: isVerificationPolicyV5(record)
      ? requireDirectPublicVerifyCmd(record?.verify_cmds, record?.task_type, record?.bug_id, {
          concurrency: isConcurrencyVerificationRecord(record),
        })
      : requireDockerVerifyCmds(record?.verify_cmds, record?.task_type, record?.bug_id),
    gold_root_cause: requireChineseGoldRootCause(record?.gold_root_cause, record?.bug_id),
    success_criteria: requireChineseText(record?.success_criteria, 'success_criteria', record?.bug_id),
    verify_result: verifyResult,
    harness: requireDockerHarness(record?.harness, record?.bug_id),
  };
  return Object.fromEntries(EXCEL_EXPORT_FIELDS.map((field) => [field, prepared[field] ?? '']));
}
