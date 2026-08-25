import crypto from 'node:crypto';

export const TRAJECTORY_EXPORTER_VERSION = 'v4.1.1';
export const TRAJECTORY_MANIFEST_VERSION = 1;
const LEGACY_TRAJECTORY_EXPORTER_VERSIONS = new Set(['v4.0.0', 'v4.1.0']);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_POLICY_PATTERNS = [
  /controlled benchmark trajectory/i,
  /Hidden acceptance is performed later by the system/i,
  /retry-feedback=internal-only/i,
  /^Stop hook feedback:/im,
];
const INTERNAL_HOOK_FEEDBACK_PATTERN = /^Stop hook feedback:\s*/i;
const INTERNAL_CONTINUATION_PROMPT_PATTERN = /^\[Your previous response had no visible output\. Please continue and produce a user-visible response\.\]$/;

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function resolveTrajectoryManifestPrompt(manifest, promptDocument) {
  const fullPrompt = String(promptDocument || '').trim();
  const bodyPrompt = fullPrompt.replace(/^# 用户题面\s*/u, '').trim();
  const candidates = [...new Set([fullPrompt, bodyPrompt].filter(Boolean))];
  return candidates.find((candidate) => sha256(candidate) === manifest?.prompt_sha256) || fullPrompt;
}

function eventSessionId(event) {
  return String(event?.sessionId || event?.session_id || '').toLowerCase();
}

function userPromptText(event) {
  if (event?.type !== 'user') return '';
  const content = event?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const textBlocks = content.filter((block) => block?.type === 'text' && String(block.text || '').trim());
  const nonToolBlocks = content.filter((block) => block?.type !== 'tool_result' && block?.type !== 'text');
  if (!textBlocks.length || nonToolBlocks.length) return '';
  return textBlocks.map((block) => String(block.text).trim()).join('\n').trim();
}

export function isClaudeInternalContinuationPrompt(value) {
  return INTERNAL_CONTINUATION_PROMPT_PATTERN.test(String(value || '').trim());
}

function isInternalHookFeedback(event) {
  if (event?.type !== 'user') return false;
  const content = event?.message?.content;
  if (typeof content === 'string') return INTERNAL_HOOK_FEEDBACK_PATTERN.test(content.trim());
  if (!Array.isArray(content) || !content.length) return false;
  return content.every((block) => block?.type === 'text')
    && INTERNAL_HOOK_FEEDBACK_PATTERN.test(content.map((block) => String(block.text || '')).join('\n').trim());
}

export function isClaudeInternalUserEvent(event) {
  return isInternalHookFeedback(event)
    || (event?.isSynthetic === true && isClaudeInternalContinuationPrompt(userPromptText(event)));
}

function canonicalConversationEvent(event) {
  const copy = structuredClone(event);
  // Native transcripts duplicate every tool result in toolUseResult. The message
  // content is the authoritative conversation record and is retained verbatim.
  delete copy.toolUseResult;
  delete copy.tool_use_result;
  return copy;
}

function canonicalConversationEvents(events) {
  const retainedUuids = new Set(events.map((event) => String(event?.uuid || '').trim()).filter(Boolean));
  return events.map((event) => {
    const copy = canonicalConversationEvent(event);
    const parentKey = Object.hasOwn(copy, 'parentUuid') ? 'parentUuid' : Object.hasOwn(copy, 'parent_uuid') ? 'parent_uuid' : '';
    const parentUuid = parentKey ? String(copy[parentKey] || '').trim() : '';
    // Claude may anchor the first assistant turn to a session-root event that
    // is not included in the conversation export. A missing external root is
    // a valid boundary; preserve links between retained events for validation.
    if (parentKey && parentUuid && !retainedUuids.has(parentUuid)) copy[parentKey] = null;
    return copy;
  });
}

export function canonicalizeClaudeTranscript(rawEvents, { expectedPrompt = '' } = {}) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) throw new Error('Claude 原生轨迹不能为空');
  const sessionIds = [...new Set(rawEvents.map(eventSessionId).filter(Boolean))];
  if (sessionIds.length !== 1) throw new Error(`Claude 原生轨迹必须只有一个 session，实际 ${sessionIds.length}`);

  const humanInputs = rawEvents
    .filter((event) => !isClaudeInternalUserEvent(event))
    .map((event, index) => ({ event, index, text: userPromptText(event) }))
    .filter((item) => item.text);
  if (humanInputs.length !== 1) throw new Error(`Claude 原生轨迹必须只有一轮用户输入，实际 ${humanInputs.length}`);
  const prompt = humanInputs[0].text;
  if (expectedPrompt && prompt !== String(expectedPrompt).trim()) throw new Error('Claude 原生轨迹中的用户题面与 PROMPT.md 不一致');

  const conversation = rawEvents
    .filter((event) => (event?.type === 'user' || event?.type === 'assistant') && !isClaudeInternalUserEvent(event))
  const canonicalConversation = canonicalConversationEvents(conversation);
  const finalConversation = canonicalConversation.at(-1);
  const finalText = Array.isArray(finalConversation?.message?.content)
    ? finalConversation.message.content.some((block) => block?.type === 'text' && String(block.text || '').trim())
    : false;
  if (finalConversation?.type !== 'assistant' || !finalText) throw new Error('Claude 原生轨迹没有以完整 assistant 文本答复结束');

  const lastPromptSource = rawEvents.findLast((event) => event?.type === 'last-prompt') || {};
  const lastPrompt = {
    ...structuredClone(lastPromptSource),
    type: 'last-prompt',
    sessionId: sessionIds[0],
    lastPrompt: prompt,
  };
  delete lastPrompt.session_id;

  return {
    events: [...canonicalConversation, lastPrompt],
    sessionId: sessionIds[0],
    prompt,
    rawEventCount: rawEvents.length,
  };
}

export function serializeCanonicalTrajectory(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export function assertNoPrivatePolicyLeak(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const marker = PRIVATE_POLICY_PATTERNS.find((pattern) => pattern.test(text));
  if (marker) throw new Error('Claude 交付轨迹包含隐藏系统约束文本，已拒绝导出');
  return true;
}

export function createTrajectoryManifest({
  sessionId,
  taskType,
  prompt,
  rawNativeContent,
  rawStreamContent,
  deliveryContent,
  auditContent,
  deliveryFilename,
  rawFilename,
  rawEventCount,
  eventCount,
  goVersion = '',
}) {
  return {
    manifest_version: TRAJECTORY_MANIFEST_VERSION,
    policy_version: 4,
    exporter_version: TRAJECTORY_EXPORTER_VERSION,
    session_id: sessionId,
    task_type: taskType,
    delivery_filename: deliveryFilename,
    raw_filename: rawFilename,
    upload_source: 'raw_native',
    upload_filename: `trajectory_${sessionId}.jsonl`,
    raw_event_count: rawEventCount,
    delivery_event_count: eventCount,
    prompt_sha256: sha256(String(prompt).trim()),
    raw_sha256: sha256(rawNativeContent),
    upload_sha256: sha256(rawNativeContent),
    stream_sha256: sha256(rawStreamContent),
    delivery_sha256: sha256(deliveryContent),
    audit_sha256: sha256(auditContent),
    go_version: goVersion,
  };
}

export function validateTrajectoryManifest(manifest, artifacts) {
  const issues = [];
  if (manifest?.manifest_version !== TRAJECTORY_MANIFEST_VERSION) issues.push('runner manifest 版本不合法');
  if (manifest?.policy_version !== 4) issues.push('runner manifest 未绑定 V4 策略');
  if (manifest?.exporter_version !== TRAJECTORY_EXPORTER_VERSION && !LEGACY_TRAJECTORY_EXPORTER_VERSIONS.has(manifest?.exporter_version)) {
    issues.push(`exporter_version 必须是 ${TRAJECTORY_EXPORTER_VERSION}`);
  }
  if (!SESSION_ID_PATTERN.test(String(manifest?.session_id || ''))) issues.push('runner manifest 的 session_id 不合法');
  if (!['bugfix', 'diagnosis'].includes(manifest?.task_type)) issues.push('runner manifest 的 task_type 不合法');
  if (!new RegExp(`^trajectory_${manifest?.session_id || ''}\\.jsonl$`, 'i').test(String(manifest?.delivery_filename || ''))) issues.push('runner manifest 的 delivery_filename 不合法');
  if (!new RegExp(`^raw\\.native\\.${manifest?.session_id || ''}\\.jsonl$`, 'i').test(String(manifest?.raw_filename || ''))) issues.push('runner manifest 的 raw_filename 不合法');
  if (manifest?.exporter_version === TRAJECTORY_EXPORTER_VERSION && manifest?.upload_source !== 'raw_native') {
    issues.push('当前 runner manifest 必须将 Claude 原生轨迹作为上传源');
  }
  if (manifest?.upload_source != null) {
    if (manifest.upload_source !== 'raw_native') issues.push('runner manifest 的 upload_source 不合法');
    if (!new RegExp(`^trajectory_${manifest?.session_id || ''}\\.jsonl$`, 'i').test(String(manifest?.upload_filename || ''))) issues.push('runner manifest 的 upload_filename 不合法');
    if (manifest.upload_sha256 !== sha256(artifacts.rawNativeContent || '')) issues.push('upload_sha256 与 Claude 原生轨迹不一致');
  }
  if (!Number.isInteger(manifest?.raw_event_count) || manifest.raw_event_count < 1) issues.push('runner manifest 的 raw_event_count 不合法');
  if (!Number.isInteger(manifest?.delivery_event_count) || manifest.delivery_event_count < 1) issues.push('runner manifest 的 delivery_event_count 不合法');
  if (artifacts.expectedSessionId && String(manifest?.session_id).toLowerCase() !== String(artifacts.expectedSessionId).toLowerCase()) issues.push('runner manifest 的 session_id 与交付轨迹不一致');
  if (artifacts.expectedTaskType && manifest?.task_type !== artifacts.expectedTaskType) issues.push('runner manifest 的 task_type 与任务不一致');
  if (Number.isInteger(artifacts.rawEventCount) && manifest?.raw_event_count !== artifacts.rawEventCount) issues.push('runner manifest 的 raw_event_count 与原生轨迹不一致');
  if (Number.isInteger(artifacts.deliveryEventCount) && manifest?.delivery_event_count !== artifacts.deliveryEventCount) issues.push('runner manifest 的 delivery_event_count 与交付轨迹不一致');
  const checks = [
    ['prompt_sha256', String(artifacts.prompt || '').trim()],
    ['raw_sha256', artifacts.rawNativeContent],
    ['stream_sha256', artifacts.rawStreamContent],
    ['delivery_sha256', artifacts.deliveryContent],
    ['audit_sha256', artifacts.auditContent],
  ];
  for (const [field, content] of checks) {
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) issues.push(`${field} 缺少本地原始文件`);
    else if (manifest?.[field] !== sha256(content)) issues.push(`${field} 与本地不可变文件不一致`);
  }
  return { ok: issues.length === 0, issues };
}
