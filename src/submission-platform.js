import crypto from 'node:crypto';
import { prepareExcelRecord } from './export-rules.js';

export const DEFAULT_SUBMISSION_PLATFORM_URL = 'https://go.jzxhnh.com';
export const SUBMISSION_ACTIVITY_TIME_ZONE = 'Asia/Shanghai';

export const PLATFORM_REVIEW_STATUS_LABELS = Object.freeze({
  PENDING_FIRST_REVIEW: '待初审',
  FIRST_REVIEWING: '初审中',
  FIRST_REVIEW_ERROR: '初审异常',
  FIRST_PASSED: '初审通过',
  FINAL_REVIEWING: '终审中',
  FINAL_REVIEW_ERROR: '终审异常',
  FINAL_PASSED: '已通过',
  SYNCING: '同步中',
  SYNC_FAILED: '同步失败',
  SYNCED: '已同步',
  PENDING_FIX: '待返修',
  DISCARDED: '已废弃',
});
const PLATFORM_REVIEW_LABEL_STATUSES = Object.freeze(Object.fromEntries(
  [
    ...Object.entries(PLATFORM_REVIEW_STATUS_LABELS).map(([status, label]) => [label, status]),
    ['通过', 'FINAL_PASSED'],
  ],
));

function text(value) {
  return String(value ?? '').trim();
}

function calendarDate(value, timeZone = SUBMISSION_ACTIVITY_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function submissionActivityAt(record) {
  if (record?.status === 'submitted') return record.submittedAt || record.reconciledAt || record.startedAt || '';
  if (record?.status === 'failed') return record.failedAt || record.startedAt || '';
  return record?.startedAt || '';
}

export function buildSubmissionActivityStats(submissionRecords = [], reviewRecords = [], {
  now = new Date(),
  timeZone = SUBMISSION_ACTIVITY_TIME_ZONE,
} = {}) {
  const date = calendarDate(now, timeZone);
  const submissions = Array.isArray(submissionRecords) ? submissionRecords : [];
  const reviews = Array.isArray(reviewRecords) ? reviewRecords : [];
  const qualified = reviews.filter((record) => record?.status === 'qualified');
  const qualifiedToday = qualified.filter((record) => calendarDate(record.updatedAt, timeZone) === date);
  const submittedTaskIds = new Set(submissions
    .filter((record) => record?.status === 'submitted')
    .map((record) => text(record.taskId))
    .filter(Boolean));
  const activityToday = submissions.filter((record) => calendarDate(submissionActivityAt(record), timeZone) === date);
  const recent = activityToday
    .map((record) => ({
      taskId: text(record.taskId),
      bugId: text(record.bugId),
      status: text(record.status) || 'unknown',
      activityAt: submissionActivityAt(record) || null,
      submissionId: text(record.platformSubmissionId),
      error: text(record.error),
    }))
    .sort((left, right) => String(right.activityAt || '').localeCompare(String(left.activityAt || '')))
    .slice(0, 20);

  return {
    date,
    timeZone,
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    today: {
      qualified: qualifiedToday.length,
      uploaded: activityToday.filter((record) => record?.status === 'submitted').length,
      failed: activityToday.filter((record) => record?.status === 'failed').length,
      submitting: activityToday.filter((record) => record?.status === 'submitting').length,
      pendingUpload: qualifiedToday.filter((record) => !submittedTaskIds.has(text(record.taskId))).length,
    },
    allTime: {
      qualified: qualified.length,
      uploaded: submissions.filter((record) => record?.status === 'submitted').length,
      failed: submissions.filter((record) => record?.status === 'failed').length,
      submitting: submissions.filter((record) => record?.status === 'submitting').length,
    },
    recent,
  };
}

export function normalizePlatformFieldKey(value) {
  return text(value).replace(/[\s_-]+/g, ' ').toLowerCase();
}

export function extractPlatformFields(payload) {
  const candidates = [
    payload?.data?.fields,
    payload?.data,
    payload?.fields,
    payload,
  ];
  const fields = candidates.find((candidate) => Array.isArray(candidate));
  return fields || [];
}

function platformFieldOptions(field) {
  const options = Array.isArray(field?.options)
    ? field.options
    : Array.isArray(field?.field_options)
      ? field.field_options
      : [];
  return options.map((option) => text(option?.value ?? option?.key ?? option)).filter(Boolean);
}

function isRequiredPlatformField(field) {
  return field?.required === true || field?.is_required === true || Number(field?.required) === 1;
}

function localValueForPlatformField(prepared, fieldKey) {
  if (Object.hasOwn(prepared, fieldKey)) return prepared[fieldKey];
  const normalized = normalizePlatformFieldKey(fieldKey);
  const matched = Object.keys(prepared).find((key) => normalizePlatformFieldKey(key) === normalized);
  return matched ? prepared[matched] : undefined;
}

export function preparePlatformSubmission(record, schemaPayload) {
  const prepared = prepareExcelRecord({
    ...record,
    repro_determinism: text(record?.repro_determinism) || 'deterministic',
    generator_model: text(record?.generator_model) || 'model_hub/glm-52-coding',
  });
  const fields = extractPlatformFields(schemaPayload);
  if (!fields.length) throw new Error('提交平台没有返回可用的动态字段定义');

  const data = {};
  for (const field of fields) {
    const fieldKey = text(field?.field_key ?? field?.key ?? field?.name);
    if (!fieldKey) continue;
    if (normalizePlatformFieldKey(fieldKey) === 'trajectory') continue;
    const value = localValueForPlatformField(prepared, fieldKey);
    if (isRequiredPlatformField(field) && !text(value)) {
      throw new Error(`提交平台必填字段 ${fieldKey} 缺失`);
    }
    if (value === undefined || value === null || value === '') continue;
    const options = platformFieldOptions(field);
    if (options.length && !options.includes(String(value))) {
      throw new Error(`提交平台字段 ${fieldKey} 的值 ${value} 不在允许选项中`);
    }
    data[fieldKey] = value;
  }

  const requiredLocalKeys = ['bug_id', 'task_type', 'bug_category', 'repo_url', 'go_version', 'repro_determinism'];
  for (const localKey of requiredLocalKeys) {
    const represented = Object.keys(data).some((fieldKey) => normalizePlatformFieldKey(fieldKey) === normalizePlatformFieldKey(localKey));
    if (!represented) throw new Error(`提交平台动态表单缺少系统字段 ${localKey}，已停止提交以避免字段错位`);
  }

  return {
    data,
    trajectoryUrl: prepared.trajectory,
    prepared,
  };
}

export function isLegacyDeliveredPlatformBackfill(job, bugIndex, currentPolicyVersion = 1) {
  const index = Number(bugIndex);
  if (!job || !Number.isInteger(index) || index < 1) return false;
  if (Number(job.submissionPlatformPolicyVersion || 0) >= Number(currentPolicyVersion || 1)) return false;
  const bug = (job.bugs || []).find((item) => Number(item?.bugIndex) === index);
  const delivery = (job.stages || []).find((stage) => stage?.id === `bug${index}_delivery_ready`);
  return bug?.disposition === 'delivered' && delivery?.status === 'passed';
}

export function isSubmissionPlatformUnavailableError(value) {
  const message = text(value?.message ?? value);
  if (!message) return false;
  return /质检提交平台维护中|等待统一补交|请在任务系统中连接一次提交平台|请重新连接|钥匙串中没有找到提交平台凭据|提交平台自动登录(?:已被取消|失败)|用户名或密码错误/i.test(message)
    || /(?:提交平台|质检平台)[\s\S]{0,160}(?:HTTP\s*5\d\d|fetch failed|network|timeout|timed out|超时|断开|不可用|维护|ECONN|ENOTFOUND|EAI_AGAIN)/i.test(message)
    || /(?:HTTP\s*5\d\d|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)[\s\S]{0,160}(?:提交平台|质检平台)/i.test(message);
}

export function isDeferredPlatformSubmissionStage(stage = {}) {
  if (stage?.stage !== 'platform_submit' && !/_platform_submit$/.test(text(stage?.id))) return false;
  if (stage.deferred === true || stage?.result?.deferred === true) return true;
  if (stage.status === 'skipped' && /延期|维护|统一补交|等待平台/.test(text(stage.reason))) return true;
  return stage.status === 'failed' && isSubmissionPlatformUnavailableError(stage.error);
}

export function deferredPlatformBugIndexes(job = {}) {
  return [...new Set((job.stages || [])
    .filter(isDeferredPlatformSubmissionStage)
    .map((stage) => Number(stage.bugIndex || text(stage.id).match(/^bug(\d+)_/)?.[1]))
    .filter((index) => Number.isInteger(index) && index > 0))]
    .sort((left, right) => left - right);
}

export function reopenDeferredPlatformSubmissions(job = {}, reopenedAt = new Date().toISOString()) {
  const updated = structuredClone(job || {});
  const bugIndexes = deferredPlatformBugIndexes(updated);
  if (!bugIndexes.length) return { changed: false, job: updated, bugIndexes };

  const pendingRetries = new Set((updated.pendingBugRetries || [])
    .map(Number)
    .filter((index) => Number.isInteger(index) && index > 0));
  for (const bugIndex of bugIndexes) {
    pendingRetries.add(bugIndex);
    const platformStage = (updated.stages || []).find((stage) => stage.id === `bug${bugIndex}_platform_submit`);
    if (platformStage) {
      platformStage.status = 'pending';
      platformStage.startedAt = null;
      platformStage.finishedAt = null;
      platformStage.error = '';
      platformStage.reason = '质检提交平台已恢复，等待统一补交';
      delete platformStage.deferred;
      delete platformStage.deferredAt;
      delete platformStage.result;
    }
    const deliveryStage = (updated.stages || []).find((stage) => stage.id === `bug${bugIndex}_delivery_ready`);
    if (deliveryStage) {
      deliveryStage.status = 'pending';
      deliveryStage.startedAt = null;
      deliveryStage.finishedAt = null;
      deliveryStage.error = '';
      deliveryStage.reason = '等待质检平台统一补交完成';
    }
    const bug = (updated.bugs || []).find((item) => Number(item.bugIndex) === bugIndex);
    if (bug) {
      delete bug.disposition;
      delete bug.failureDisposition;
      delete bug.failureStage;
      delete bug.failureReason;
      delete bug.deliveredAt;
      bug.workerExecution = {
        ...(bug.workerExecution || {}),
        status: 'fast_lane_queued',
        currentStage: `bug${bugIndex}_platform_submit`,
        currentAttempt: 0,
        blockedReason: '等待质检平台统一补交',
        lastAction: 'platform_backfill_queued',
        updatedAt: reopenedAt,
      };
    }
  }
  updated.pendingBugRetries = [...pendingRetries].sort((left, right) => left - right);
  updated.currentStage = `bug${bugIndexes[0]}_platform_submit`;
  updated.error = '';
  updated.finishedAt = null;
  updated.updatedAt = reopenedAt;
  updated.bugExecution = {
    ...(updated.bugExecution || {}),
    selectedBugIndex: bugIndexes[0],
    status: 'fast_lane_queued',
    startedAt: null,
    currentStage: `bug${bugIndexes[0]}_platform_submit`,
    currentAttempt: 0,
    blockedReason: '等待质检平台统一补交',
    lastAction: 'platform_backfill_queued',
    updatedAt: reopenedAt,
  };
  return { changed: true, job: updated, bugIndexes };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function platformSubmissionFingerprint(submission) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize({
    data: submission?.data || {},
    trajectory_url: text(submission?.trajectoryUrl),
  }))).digest('hex');
}

function cookiePairs(cookieHeader) {
  return text(cookieHeader).split(/;\s*/).map((pair) => pair.trim()).filter(Boolean);
}

export function mergePlatformCookies(existingCookieHeader, setCookieHeaders = []) {
  const cookies = new Map();
  for (const pair of cookiePairs(existingCookieHeader)) {
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const header of setCookieHeaders || []) {
    const pair = String(header || '').split(';', 1)[0].trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function platformCsrfToken(cookieHeader) {
  const pair = cookiePairs(cookieHeader).find((item) => item.startsWith('go_qa_csrf='));
  if (!pair) return '';
  const value = pair.slice('go_qa_csrf='.length);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractPlatformSubmissionItems(payload) {
  const candidates = [payload?.data?.items, payload?.data?.records, payload?.items, payload?.records, payload?.data];
  return candidates.find((candidate) => Array.isArray(candidate)) || [];
}

export function extractPlatformSubmissionTotal(payload) {
  const candidates = [payload?.data?.total, payload?.total, payload?.data?.count, payload?.count];
  const total = candidates.map(Number).find((value) => Number.isFinite(value) && value >= 0);
  return total ?? extractPlatformSubmissionItems(payload).length;
}

export function findPlatformSubmissionByBugId(payload, bugId) {
  const expected = text(bugId);
  return extractPlatformSubmissionItems(payload).find((item) => {
    return platformSubmissionBugId(item) === expected;
  }) || null;
}

export function platformSubmissionId(payload) {
  return text(payload?.data?.id ?? payload?.data?.submission_id ?? payload?.id ?? payload?.submission_id);
}

export function platformSubmissionBugId(item) {
  const direct = item?.bug_id ?? item?.bugId;
  const nested = item?.data?.bug_id ?? item?.form_data?.bug_id;
  const summaryBugId = text(item?.summary).split(/\s*\|\s*/, 1)[0];
  return text(direct ?? nested) || summaryBugId;
}

export function findPlatformSubmissionForRecord(payload, record = {}) {
  const items = extractPlatformSubmissionItems(payload);
  const expectedSubmissionId = text(record?.platformSubmissionId);
  if (expectedSubmissionId) {
    const exact = items.find((item) => platformSubmissionId(item) === expectedSubmissionId);
    if (exact) return exact;
  }
  return findPlatformSubmissionByBugId({ items }, record?.bugId);
}

export function mergePlatformSubmissionReview(record = {}, remote = {}, { observedAt = new Date().toISOString() } = {}) {
  const rawStatus = text(remote?.status ?? remote?.review_status);
  const status = PLATFORM_REVIEW_LABEL_STATUSES[rawStatus] || rawStatus.toUpperCase();
  if (!status) return { ...record };
  const reason = text(remote?.reject_reason ?? remote?.review_reason ?? remote?.discard_reason);
  const label = PLATFORM_REVIEW_STATUS_LABELS[status] || status;
  const version = Number(remote?.current_version ?? remote?.version);
  const changed = status !== text(record?.platformReviewStatus).toUpperCase()
    || reason !== text(record?.platformReviewReason)
    || (Number.isFinite(version) && version !== Number(record?.platformCurrentVersion || 0));
  return {
    ...record,
    platformReviewStatus: status,
    platformReviewLabel: label,
    platformReviewReason: reason,
    platformCurrentVersion: Number.isFinite(version) && version > 0 ? version : Number(record?.platformCurrentVersion || 0) || null,
    platformReviewUpdatedAt: changed
      ? text(remote?.updated_at ?? remote?.reviewed_at) || observedAt
      : record?.platformReviewUpdatedAt || null,
  };
}

export function isReadmeOnlyPlatformRepairReason(value) {
  const reason = text(value);
  if (!reason) return false;
  const reasonSection = reason.includes('打回原因：')
    ? reason.split('打回原因：').slice(1).join('打回原因：').split('关键证据：', 1)[0]
    : reason;
  const numberedItems = reasonSection.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+[.、]\s*/.test(line))
    .map((line) => line.replace(/^\d+[.、]\s*/, ''));
  const substantiveItems = numberedItems.filter((item) => !/^问题归属[:：]/.test(item));
  return substantiveItems.length === 1
    && /BENZHI_README\.md/i.test(substantiveItems[0])
    && /(?:项目简介|一句话简介)/.test(substantiveItems[0]);
}

export function buildPlatformReviewSnapshot(remoteItems = [], { observedAt = new Date().toISOString() } = {}) {
  const submissions = (Array.isArray(remoteItems) ? remoteItems : []).map((remote) => {
    const merged = mergePlatformSubmissionReview({}, remote, { observedAt });
    return {
      submissionId: platformSubmissionId(remote),
      bugId: platformSubmissionBugId(remote),
      reviewStatus: merged.platformReviewStatus || '',
      reviewLabel: merged.platformReviewLabel || '',
      reviewReason: merged.platformReviewReason || '',
      reviewUpdatedAt: merged.platformReviewUpdatedAt || null,
      currentVersion: merged.platformCurrentVersion || null,
    };
  }).filter((record) => record.submissionId);
  const reviewCounts = submissions.reduce((counts, record) => {
    if (record.reviewStatus) counts[record.reviewStatus] = Number(counts[record.reviewStatus] || 0) + 1;
    return counts;
  }, {});
  return { observedAt, reviewCounts, submissions };
}

export function platformImportState(record) {
  const submissionStatus = text(record?.status) || 'not_submitted';
  const imported = submissionStatus === 'submitted';
  return {
    submissionPlatformImported: imported,
    submissionPlatformImportStatus: imported ? 'imported' : 'not_imported',
    submissionPlatformStatus: submissionStatus,
    submissionPlatformSubmissionId: text(record?.platformSubmissionId),
    submissionPlatformSubmittedAt: record?.submittedAt || null,
    submissionPlatformUrl: text(record?.platformUrl),
    submissionPlatformError: text(record?.error || record?.platformReviewReason),
    submissionPlatformReviewStatus: text(record?.platformReviewStatus),
    submissionPlatformReviewLabel: text(record?.platformReviewLabel),
    submissionPlatformReviewReason: text(record?.platformReviewReason),
    submissionPlatformReviewUpdatedAt: record?.platformReviewUpdatedAt || null,
    submissionPlatformCurrentVersion: Number(record?.platformCurrentVersion || 0) || null,
  };
}

export function platformApiMessage(payload, fallback = '提交平台请求失败') {
  const detail = payload?.detail;
  if (Array.isArray(detail)) {
    const joined = detail.map((item) => text(item?.msg ?? item?.message ?? item)).filter(Boolean).join('；');
    if (joined) return joined;
  }
  return text(detail ?? payload?.message ?? payload?.error) || fallback;
}
