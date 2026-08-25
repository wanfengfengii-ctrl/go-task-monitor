export const LEGACY_PROJECT_PACKAGE_POLICY_VERSION = 1;
export const CURRENT_PROJECT_PACKAGE_POLICY_VERSION = 2;

const PROJECT_TYPES = new Set(['cli', 'web']);
const PROJECT_SUMMARY_ALLOWED_LATIN_TOKENS = new Set([
  'Go', 'CLI', 'Web', 'API', 'HTTP', 'HTTPS', 'REST', 'JSON', 'XML', 'YAML',
  'SQL', 'SQLite', 'MySQL', 'PostgreSQL', 'Redis', 'Kafka', 'MQTT', 'TCP',
  'UDP', 'TLS', 'DNS', 'DNSSEC', 'HSM', 'RFID', 'OCR', 'GIS', 'IoT', 'SaaS',
  'gRPC', 'OAuth', 'OAuth2', 'WebSocket', 'JWT', 'CSV', 'PDF', 'Excel', 'Git',
  'Docker', 'Kubernetes', 'UUID', 'ID', 'URL', 'HTML', 'CSS', 'JS', 'RPC',
  'S3', 'SFTP', 'SSH', 'SMTP', 'IMAP', 'ETL', 'OLAP', 'CI', 'CD', 'AI',
  'ML', 'LLM', 'RAG', 'WASM',
]);
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

function countHan(value) {
  return (String(value || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
}

function text(value) {
  return String(value || '').trim();
}

export function normalizeProjectPackagePolicyVersion(value) {
  const version = Number(value || LEGACY_PROJECT_PACKAGE_POLICY_VERSION);
  return Number.isInteger(version) && version >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION
    ? CURRENT_PROJECT_PACKAGE_POLICY_VERSION
    : LEGACY_PROJECT_PACKAGE_POLICY_VERSION;
}

export function normalizeProjectType(value) {
  const normalized = text(value).toLowerCase();
  return PROJECT_TYPES.has(normalized) ? normalized : '';
}

export function validateProjectPackagePlan(plan = {}, {
  policyVersion = plan.project_package_policy_version || plan.projectPackagePolicyVersion,
  frontendRequired = plan.frontend_required || plan.frontendRequired,
} = {}) {
  if (normalizeProjectPackagePolicyVersion(policyVersion) < CURRENT_PROJECT_PACKAGE_POLICY_VERSION) {
    return { ok: true, issues: [], projectType: '', projectSummary: '' };
  }
  const projectType = normalizeProjectType(plan.project_type || plan.projectType);
  const projectSummary = text(plan.project_summary || plan.projectSummary);
  const issues = [];
  if (!projectType) issues.push('project_type 必须是 cli 或 web');
  if (frontendRequired && projectType !== 'web') issues.push('包含前端的项目必须声明为 web');
  if (!projectSummary) issues.push('project_summary 不能为空');
  if (/\r|\n/.test(projectSummary)) issues.push('project_summary 必须是单行简介');
  if (/[#`*_]/.test(projectSummary)) issues.push('project_summary 不能包含 Markdown 标记');
  const length = Array.from(projectSummary).length;
  if (projectSummary && (length < 30 || length > 120)) issues.push('project_summary 必须为 30 至 120 个字符');
  if (projectSummary && !/^基于 Go 实现的/u.test(projectSummary)) issues.push('project_summary 必须以“基于 Go 实现的”开头');
  if (projectSummary && !/。$/u.test(projectSummary)) issues.push('project_summary 必须以一个中文句号结尾');

  const cliMatch = projectSummary.match(/^基于 Go 实现的([^,，。！？.!?：:\r\n]{2,40}) CLI 项目，一款命令行工具，([^。！？.!?\r\n]{6,70})。$/u);
  const webMatch = projectSummary.match(/^基于 Go 实现的([^,，。！？.!?：:\r\n]{2,40}) Web 项目，一款(后端服务|前后端应用)，([^。！？.!?\r\n]{6,70})。$/u);
  const structure = projectType === 'cli' ? cliMatch : projectType === 'web' ? webMatch : null;
  if (projectType && !structure) {
    issues.push(projectType === 'cli'
      ? 'CLI 项目简介必须严格使用“基于 Go 实现的{业务领域} CLI 项目，一款命令行工具，{核心能力}。”格式'
      : 'Web 项目简介必须严格使用“基于 Go 实现的{业务领域} Web 项目，一款后端服务或前后端应用，{核心能力}。”格式');
  }
  if (structure) {
    const domain = String(structure[1] || '');
    const capability = String(projectType === 'cli' ? structure[2] : structure[3] || '');
    if (domain !== domain.trim() || capability !== capability.trim()) {
      issues.push('project_summary 的业务领域和核心能力不能以空格开头或结尾');
    }
    if (!HAN_PATTERN.test(domain)) issues.push('project_summary 的业务领域必须以中文为主体');
    if (!HAN_PATTERN.test(capability)) issues.push('project_summary 的核心能力必须以中文为主体');
    if (countHan(domain) < 2) issues.push('project_summary 的业务领域至少需要包含 2 个汉字');
    if (countHan(capability) < 6) issues.push('project_summary 的核心能力至少需要包含 6 个汉字');
  }
  const latinTokens = projectSummary.match(/[A-Za-z][A-Za-z0-9+#.-]*/gu) || [];
  const unsupportedLatinTokens = [...new Set(latinTokens.filter((token) => (
    !PROJECT_SUMMARY_ALLOWED_LATIN_TOKENS.has(token)
  )))];
  if (unsupportedLatinTokens.length) {
    issues.push(`project_summary 必须以中文为主体，不能夹带英文叙述或品牌词：${unsupportedLatinTokens.slice(0, 5).join('、')}`);
  }
  if (/BUG_REPRO|BUG_BASE|gold_root_cause|修复方法|答案/u.test(projectSummary)) {
    issues.push('project_summary 不能包含 Bug、答案或修复信息');
  }
  return { ok: issues.length === 0, issues, projectType, projectSummary };
}

export function validateReadmeProjectIntroduction(readme, options = {}) {
  const policyVersion = normalizeProjectPackagePolicyVersion(
    options.projectPackagePolicyVersion || options.project_package_policy_version,
  );
  if (policyVersion < CURRENT_PROJECT_PACKAGE_POLICY_VERSION) return { ok: true, issues: [] };
  const firstLine = String(readme || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim();
  const plan = validateProjectPackagePlan({
    project_type: options.projectType || options.project_type,
    project_summary: firstLine,
    project_package_policy_version: policyVersion,
  }, { policyVersion });
  const issues = [...plan.issues];
  const expected = text(options.projectSummary || options.project_summary);
  if (expected && firstLine !== expected) issues.push('BENZHI_README.md 第一行必须与项目规划简介完全一致');
  return { ok: issues.length === 0, issues, firstLine };
}

export function isBugReproPath(value) {
  return String(value || '').replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() === 'bug_repro.md';
}

export function normalizePackageExpectedFailureCommands(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return [...new Set(values
    .map((command) => text(command).replace(/^\$\s*/, ''))
    .filter((command) => command
      && !/[\n\r;&|<>`]/.test(command)
      && !/\$\(/.test(command)
      && /^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:go\s+(?:build|test|run)\b|npm\s+(?:--prefix\s+[^\s]+\s+)?run\s+build\b)/.test(command)))];
}

export function projectPackageRuleOptions(value = {}) {
  const policyVersion = normalizeProjectPackagePolicyVersion(
    value.project_package_policy_version || value.projectPackagePolicyVersion,
  );
  const explicitExpectedFailures = value.package_expected_failure_commands
    || value.packageExpectedFailureCommands
    || value.expectedFailureCommands;
  const expectedFailureCommands = normalizePackageExpectedFailureCommands(
    explicitExpectedFailures || (policyVersion >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION && value.task_type === 'diagnosis'
      ? value.verify_cmds
      : []),
  );
  return {
    projectPackagePolicyVersion: policyVersion,
    projectType: normalizeProjectType(value.project_type || value.projectType),
    projectSummary: text(value.project_summary || value.projectSummary),
    expectedFailureCommands,
  };
}
