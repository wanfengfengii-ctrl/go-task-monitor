const sessionIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const trajectoryFilenamePattern = new RegExp(`^trajectory_(${sessionIdPattern})\\.jsonl?$`, 'i');

export function extractTrajectorySessionId(filename) {
  const value = String(filename ?? '').trim();
  const match = value.match(trajectoryFilenamePattern);
  if (!match) {
    throw new Error('文件名必须为 trajectory_<session-id>.json 或 trajectory_<session-id>.jsonl');
  }
  return match[1].toLowerCase();
}

export function selectPermanentSignedUrl(uploaded, baseUrl = '') {
  const candidate = [
    uploaded?.signedUrl,
    uploaded?.signed_url,
    uploaded?.permanentUrl,
    uploaded?.permanent_url,
    uploaded?.url,
  ].find((value) => typeof value === 'string' && value.trim());
  if (!candidate) throw new Error('云盘未返回有效的永久签名链接');

  let parsed;
  try {
    parsed = new URL(candidate, baseUrl || undefined);
  } catch {
    throw new Error('云盘未返回有效的永久签名链接');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('云盘返回的永久签名链接必须使用 HTTPS');
  }
  return parsed.href;
}

export function requireUniquePassedTaskForSession(tasks, sessionId, filename = '') {
  const normalizedSessionId = String(sessionId ?? '').toLowerCase();
  const matches = Array.from(tasks || []).filter((task) => (
    task?.status === 'passed' && String(task?.sessionId ?? '').toLowerCase() === normalizedSessionId
  ));
  const label = filename || normalizedSessionId || 'trajectory JSON';
  if (!matches.length) throw new Error(`${label} 找不到 session ID 对应的已通过题目`);
  if (matches.length > 1) throw new Error(`${label} 的 session ID 对应多道题目，无法唯一绑定`);
  return matches[0];
}
