export const VERIFICATION_POLICY_VERSION = 5;
export const VERIFICATION_POLICY_EFFECTIVE_AT = '2026-08-17T00:00:00+08:00';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRAJECTORY_URL_PATTERN = /^https:\/\/[^\s]+\.jsonl?(?:\?[^\s]*)?$/i;
const PROOF_KEYS = new Set(['trajectory_url', 'session_id', 'result']);

function parseValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeProof(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  return {
    trajectory_url: String(proof.trajectory_url || '').trim(),
    session_id: String(proof.session_id || '').trim().toLowerCase(),
    result: String(proof.result || '').trim().toLowerCase(),
  };
}

export function normalizeVerifyCommands(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
    .map((command) => String(command || '').trim())
    .filter(Boolean);
}

export function verificationResultIssues(value, { taskType = 'bugfix', mainSessionId = '' } = {}) {
  const issues = [];
  const parsed = parseValue(value);
  if (!parsed) return ['verify_result 必须是可解析的 JSON 对象'];
  const allowedTopLevel = taskType === 'diagnosis' ? new Set(['pre_fix']) : new Set(['pre_fix', 'post_fix']);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopLevel.has(key)) issues.push(`verify_result 不允许字段 ${key}`);
  }
  if (!parsed.pre_fix) issues.push('verify_result 缺少 pre_fix');
  if (taskType === 'bugfix' && !parsed.post_fix) issues.push('bugfix 的 verify_result 缺少 post_fix');
  if (taskType === 'diagnosis' && parsed.post_fix) issues.push('diagnosis 只能上传模型运行前的 pre_fix 证明');

  const expected = taskType === 'diagnosis'
    ? [['pre_fix', 'red']]
    : [['pre_fix', 'red'], ['post_fix', 'green']];
  const sessions = [];
  for (const [key, expectedResult] of expected) {
    const raw = parsed[key];
    const proof = normalizeProof(raw);
    if (!proof) continue;
    for (const field of Object.keys(raw || {})) {
      if (!PROOF_KEYS.has(field)) issues.push(`${key} 不允许字段 ${field}`);
    }
    if (!TRAJECTORY_URL_PATTERN.test(proof.trajectory_url)) issues.push(`${key}.trajectory_url 必须是 HTTPS JSON/JSONL 链接`);
    if (!UUID_PATTERN.test(proof.session_id)) issues.push(`${key}.session_id 必须是 Claude Session UUID`);
    if (proof.result !== expectedResult) issues.push(`${key}.result 必须是 ${expectedResult}`);
    if (proof.session_id) sessions.push(proof.session_id);
  }
  const normalizedMain = String(mainSessionId || '').trim().toLowerCase();
  if (normalizedMain) sessions.push(normalizedMain);
  if (new Set(sessions).size !== sessions.length) issues.push('主轨迹、pre_fix 和 post_fix 的 session_id 必须互不重复');
  return [...new Set(issues)];
}

export function normalizeVerificationResult(value, options = {}) {
  const issues = verificationResultIssues(value, options);
  if (issues.length) throw new Error(issues.join('；'));
  const parsed = parseValue(value);
  const normalized = { pre_fix: normalizeProof(parsed.pre_fix) };
  if (options.taskType !== 'diagnosis') normalized.post_fix = normalizeProof(parsed.post_fix);
  return normalized;
}

export function serializeVerificationResult(value, options = {}) {
  return JSON.stringify(normalizeVerificationResult(value, options));
}

export function buildVerificationResult({ taskType = 'bugfix', preFix, postFix }) {
  const value = { pre_fix: normalizeProof(preFix) };
  if (taskType === 'bugfix') value.post_fix = normalizeProof(postFix);
  return normalizeVerificationResult(value, { taskType });
}

export function isVerificationPolicyV5(record) {
  return Number(record?.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION;
}
