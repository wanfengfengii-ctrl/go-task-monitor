export function isCloudAuthenticationFailure(status, location = '', baseUrl = 'https://localhost') {
  if ([401, 403].includes(Number(status))) return true;
  if (Number(status) < 300 || Number(status) >= 400 || !location) return false;
  try {
    const target = new URL(location, baseUrl);
    return target.pathname === '/login' || target.pathname.startsWith('/login/');
  } catch {
    return false;
  }
}

export function shouldRetryCloudUpload(attempt, status, location = '', baseUrl) {
  const index = Number(attempt);
  return (index === 0 && isCloudAuthenticationFailure(status, location, baseUrl))
    || (index < 3 && isCloudTransientFailure(status));
}

export function isCloudTransientFailure(status, error = null) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true;
  const message = [error?.name, error?.code, error?.message, error]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /abort|timeout|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket|network|premature close|und_err/.test(message);
}

export function cloudUploadRetryDelayMs(attempt) {
  const index = Math.max(0, Number(attempt) || 0);
  return Math.min(8_000, 500 * (2 ** index));
}

export function createCloudPublicState({
  connected = false,
  connectedAs = '',
  autoLoginConfigured = false,
  lastCheckedAt = null,
  lastRefreshedAt = null,
  lastError = '',
} = {}, uploads = []) {
  return {
    connected: Boolean(connected),
    connectedAs: String(connectedAs || ''),
    autoLoginConfigured: Boolean(autoLoginConfigured),
    lastCheckedAt: lastCheckedAt || null,
    lastRefreshedAt: lastRefreshedAt || null,
    lastError: String(lastError || ''),
    uploads,
  };
}
