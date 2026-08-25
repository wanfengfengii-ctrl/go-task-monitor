const DEFAULT_PREFIX = 'go';
const DEFAULT_WIDTH = 4;

function requireIdentifier(value, label, pattern) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) throw new Error(`${label} 不合法：${normalized || '(empty)'}`);
  return normalized;
}

export function nextSequentialRepositoryName(names, { prefix = DEFAULT_PREFIX, width = DEFAULT_WIDTH } = {}) {
  const normalizedPrefix = requireIdentifier(prefix, '仓库前缀', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const normalizedWidth = Number(width);
  if (!Number.isInteger(normalizedWidth) || normalizedWidth < 1 || normalizedWidth > 12) throw new Error('仓库编号宽度必须是 1-12 的整数');
  const pattern = new RegExp(`^${normalizedPrefix}-(\\d{${normalizedWidth},})$`);
  const highest = Array.from(names || []).reduce((current, value) => {
    const matched = String(value || '').trim().match(pattern);
    if (!matched) return current;
    const number = Number(matched[1]);
    return Number.isSafeInteger(number) ? Math.max(current, number) : current;
  }, 0);
  const next = highest + 1;
  if (!Number.isSafeInteger(next)) throw new Error('仓库编号已超出安全整数范围');
  return `${normalizedPrefix}-${String(next).padStart(normalizedWidth, '0')}`;
}

export function githubRepositoryUrls(owner, name) {
  const normalizedOwner = requireIdentifier(owner, 'GitHub owner', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
  const normalizedName = requireIdentifier(name, 'GitHub 仓库名', /^[A-Za-z0-9._-]+$/);
  return {
    owner: normalizedOwner,
    name: normalizedName,
    nameWithOwner: `${normalizedOwner}/${normalizedName}`,
    repository: `https://github.com/${normalizedOwner}/${normalizedName}`,
    cloneUrl: `git@github.com:${normalizedOwner}/${normalizedName}.git`,
  };
}

export function parseGitHubRepositoryNames(value) {
  const records = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(records)) throw new Error('GitHub 仓库列表返回值必须是数组');
  return records.map((record) => String(record?.name || '').trim()).filter(Boolean);
}

export function validateProvisionedRepository(value, expected) {
  if (!value || typeof value !== 'object') throw new Error('GitHub 建仓结果缺失');
  if (value.nameWithOwner !== expected.nameWithOwner) throw new Error(`GitHub 建仓结果不匹配：${value.nameWithOwner || '(empty)'}`);
  if (value.isPrivate !== false) throw new Error(`${expected.nameWithOwner} 必须是公开仓库`);
  if (value.isEmpty !== true) throw new Error(`${expected.nameWithOwner} 必须是空仓库`);
  if (value.url !== expected.repository) throw new Error(`${expected.nameWithOwner} 的公开地址不匹配`);
  if (value.sshUrl !== expected.cloneUrl) throw new Error(`${expected.nameWithOwner} 的 SSH 地址不匹配`);
  return expected;
}
