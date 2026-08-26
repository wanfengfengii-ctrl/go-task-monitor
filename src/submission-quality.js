export const QUALITY_INCIDENT_TYPES = Object.freeze([
  'project_unrunnable',
  'unrelated_verify_cmds',
  'red_green_invalid',
]);
export const QUALITY_INCIDENT_LIMIT = 2;

function text(value) {
  return String(value || '').trim();
}

export function classifySubmissionQualityIncident(job = {}) {
  if (job?.status !== 'failed') return null;
  const stage = text(job.currentStage);
  const stageError = (job.stages || []).find((item) => item?.id === stage)?.error || '';
  const error = `${text(job.error)}\n${text(stageError)}`;
  if (/Docker (?:Desktop|daemon)|Cannot connect to the Docker daemon|TLS handshake timeout|no space left on device|云盘|数据快照|SEEK_HOLE|snapshot lock|网关|\b429\b|\b5\d\d\b/i.test(error)) return null;
  // Proof binding is an orchestrator/artifact compatibility failure. It does
  // not say that the project failed to produce a deterministic red or green
  // result, so it must never count toward a contributor quality breaker.
  if (/(?:验证)?证明.{0,80}(?:绑定失效|提示词与系统固定提示不一致|源码 commit 与任务元数据不一致|manifest|Session|附件|哈希).{0,80}(?:不完整|不一致|失效|缺少)?/i.test(error)) return null;
  if (/verify_cmds.{0,120}(?:无关|不相关|不匹配)|(?:目标|验证)命令.{0,80}(?:与|和).{0,30}(?:Bug|故障).{0,20}(?:无关|不相关|不匹配)/i.test(error)) {
    return { type: 'unrelated_verify_cmds', reason: error };
  }
  if (/(?:红绿|red[\s_-]*green|pre_fix|post_fix).{0,100}(?:无效|失败|不完整|不匹配)|BUG_BASE.{0,80}(?:没有失败|未失败|通过异常|红测失败)/i.test(error)) {
    return { type: 'red_green_invalid', reason: error };
  }
  if (stage === 'project_validate' || /项目(?:与双架构 Docker|运行|质量).{0,40}(?:失败|不合格)|项目不可运行|项目无法启动/i.test(error)) {
    return { type: 'project_unrunnable', reason: error };
  }
  return null;
}

export function normalizeSubmissionQualityState(value = {}) {
  const incidents = Array.isArray(value.incidents) ? value.incidents.filter((item) => item && item.jobId && QUALITY_INCIDENT_TYPES.includes(item.type)) : [];
  const deduped = [];
  const keys = new Set();
  for (const incident of incidents) {
    const key = `${incident.contributorId || 'unknown'}:${incident.jobId}:${incident.type}`;
    if (keys.has(key)) continue;
    keys.add(key);
    deduped.push({ ...incident, confirmed: incident.confirmed !== false });
  }
  return {
    updatedAt: value.updatedAt || null,
    incidents: deduped.slice(-500),
    blockedContributors: Array.isArray(value.blockedContributors) ? value.blockedContributors : [],
  };
}

export function recordSubmissionQualityIncident(state = {}, { contributorId = '', jobId = '', type = '', reason = '', at = new Date().toISOString() } = {}) {
  const current = normalizeSubmissionQualityState(state);
  if (!jobId || !contributorId || !QUALITY_INCIDENT_TYPES.includes(type)) return { state: current, added: false, blocked: false };
  const key = `${contributorId}:${jobId}:${type}`;
  if (current.incidents.some((incident) => `${incident.contributorId}:${incident.jobId}:${incident.type}` === key)) {
    const blocked = current.blockedContributors.some((item) => item.contributorId === contributorId);
    return { state: current, added: false, blocked };
  }
  const incidents = [...current.incidents, { contributorId, jobId, type, reason: text(reason).slice(-4000), confirmed: true, at }];
  const contributorJobs = new Set(incidents.filter((incident) => incident.contributorId === contributorId && incident.confirmed).map((incident) => incident.jobId));
  const alreadyBlocked = current.blockedContributors.some((item) => item.contributorId === contributorId);
  const blocked = alreadyBlocked || contributorJobs.size >= QUALITY_INCIDENT_LIMIT;
  const blockedContributors = alreadyBlocked || !blocked
    ? current.blockedContributors
    : [...current.blockedContributors, { contributorId, blockedAt: at, reason: '两个不同项目被确定性质量门禁判定失败' }];
  return {
    added: true,
    blocked,
    state: { updatedAt: at, incidents: incidents.slice(-500), blockedContributors },
  };
}

export function isContributorQualityBlocked(state = {}, contributorId = '') {
  return normalizeSubmissionQualityState(state).blockedContributors.some((item) => item.contributorId === contributorId);
}
