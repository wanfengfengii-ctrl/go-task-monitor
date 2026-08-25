function changedFiles(before = {}, after = {}) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

export function analyzeMutationAudit(records, { expectedToolUses = [], deniedToolUseIds = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(records) || !records.length) {
    return { ok: false, errors: ['缺少 Claude 外部写入审计记录'], warnings, mutations: [] };
  }
  const baselines = records.filter((record) => record?.event === 'V4Baseline');
  const finals = records.filter((record) => record?.event === 'V4Final');
  const baseline = baselines[0];
  const final = finals[0];
  if (baselines.length !== 1 || finals.length !== 1) {
    errors.push(`写入审计必须恰好包含一个 V4Baseline 和一个 V4Final，实际 ${baselines.length}/${finals.length}`);
  }

  const preByTool = new Map();
  const postByTool = new Map();
  const externallyDenied = new Set(deniedToolUseIds);
  const mutations = [];
  for (const record of records) {
    const id = String(record?.tool_use_id || '');
    if (!id) continue;
    if (record.event === 'PreToolUse') {
      if (preByTool.has(id)) errors.push(`工具 ${id} 存在重复 PreToolUse 审计快照`);
      preByTool.set(id, record);
    }
    if (record.event === 'PostToolUse' || record.event === 'PostToolUseFailure') {
      if (postByTool.has(id)) errors.push(`工具 ${id} 存在重复 PostToolUse 审计快照`);
      postByTool.set(id, record);
      const before = preByTool.get(id);
      if (!before) {
        errors.push(`工具 ${id} 缺少 PreToolUse 审计快照`);
        continue;
      }
      for (const filename of changedFiles(before.files, record.files)) {
        mutations.push({ toolUseId: id, toolName: record.tool_name || before.tool_name || '', filename });
      }
    }
  }
  for (const tool of expectedToolUses) {
    const id = String(tool?.id || '');
    if (!id) continue;
    const pre = preByTool.get(id);
    if (!pre) {
      errors.push(`工具 ${id} (${tool.name || 'unknown'}) 未记录 PreToolUse 审计快照`);
      continue;
    }
    const denied = pre.permission_decision === 'deny'
      || pre.permissionDecision === 'deny'
      || externallyDenied.has(id);
    if (!postByTool.has(id) && !denied) errors.push(`工具 ${id} (${tool.name || 'unknown'}) 未记录 PostToolUse 审计快照`);
  }
  if (baseline && final) {
    for (const filename of changedFiles(baseline.files, final.files)) {
      if (!mutations.some((item) => item.filename === filename)) {
        mutations.push({ toolUseId: 'session', toolName: 'session-diff', filename });
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, mutations };
}

export function parseMutationAudit(text) {
  return String(text || '').split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`写入审计 JSONL 第 ${index + 1} 行解析失败：${error.message}`);
    }
  });
}
