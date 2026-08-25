const CLAUDE_CODE_VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export function normalizeClaudeCodeVersion(value) {
  const match = String(value || '').match(CLAUDE_CODE_VERSION_PATTERN);
  return match ? `${match[1]} (Claude Code)` : '';
}

export function extractClaudeCodeVersion(events) {
  if (!Array.isArray(events)) return '';
  const versions = [...new Set(events
    .filter((event) => event?.type === 'system' && event?.subtype === 'init')
    .map((event) => normalizeClaudeCodeVersion(event?.claude_code_version))
    .filter(Boolean))];
  return versions.length === 1 ? versions[0] : '';
}

export function upsertClaudeCodeHarness(value, version) {
  const normalizedVersion = normalizeClaudeCodeVersion(version);
  if (!normalizedVersion) throw new Error('Claude Code CLI 版本号不合法');
  const parts = String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^target_cli(?:_version)?\s*=/i.test(part));
  const insertAfter = parts.findIndex((part) => /^container_network\s*=/i.test(part));
  const insertion = ['target_cli=Claude Code CLI', `target_cli_version=${normalizedVersion}`];
  if (insertAfter >= 0) parts.splice(insertAfter + 1, 0, ...insertion);
  else parts.push(...insertion);
  return `${parts.join('; ')};`;
}

export function getClaudeHarnessIssues(value) {
  const text = String(value || '');
  const issues = [];
  if (!/\btarget_cli\s*=\s*(?:Claude Code CLI|claude)\b/i.test(text)) issues.push('缺少生成轨迹的工具名 target_cli=Claude Code CLI');
  if (!/\btarget_cli_version\s*=\s*\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*\(Claude Code\)/i.test(text)) {
    issues.push('缺少生成轨迹的工具版本 target_cli_version=x.y.z (Claude Code)');
  }
  return issues;
}
