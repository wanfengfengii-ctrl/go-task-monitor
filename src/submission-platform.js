import crypto from 'node:crypto';
import { prepareExcelRecord } from './export-rules.js';

export const DEFAULT_SUBMISSION_PLATFORM_URL = 'https://go.jzxhnh.com';

function text(value) {
  return String(value ?? '').trim();
}

export function normalizePlatformFieldKey(value) {
  return text(value).replace(/\s+/g, ' ').toLowerCase();
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

export function findPlatformSubmissionByBugId(payload, bugId) {
  const expected = text(bugId);
  return extractPlatformSubmissionItems(payload).find((item) => {
    const direct = item?.bug_id ?? item?.bugId;
    const nested = item?.data?.bug_id ?? item?.form_data?.bug_id;
    return text(direct ?? nested) === expected;
  }) || null;
}

export function platformSubmissionId(payload) {
  return text(payload?.data?.id ?? payload?.data?.submission_id ?? payload?.id ?? payload?.submission_id);
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
    submissionPlatformError: text(record?.error),
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
