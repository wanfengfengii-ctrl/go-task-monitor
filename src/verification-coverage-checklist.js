// Build a small, deterministic checklist before Claude starts.  It is a
// prompt aid and an early feedback gate; the read-only semantic review remains
// the final authority.
export const VERIFICATION_COVERAGE_CHECKLIST_VERSION = 1;

const STATUS_RULES = [
  { id: 'available', label: 'available/可用状态', pattern: /\bavailable\b|可用|正常可用/i, terms: ['available', '可用'], preflight: true },
  { id: 'reserved', label: 'reserved/预约状态', pattern: /\breserved\b|预约|预留/i, terms: ['reserved', '预约', '预留'], preflight: true },
  { id: 'thawed', label: 'thawed/解冻状态', pattern: /\bthawed\b|解冻/i, terms: ['thawed', '解冻'], preflight: true },
  { id: 'aliquoting', label: 'aliquoting/分装中状态', pattern: /\baliquoting\b|分装中|分装/i, terms: ['aliquoting', '分装'], preflight: true },
  { id: 'depleted', label: 'depleted/耗尽状态', pattern: /\bdepleted\b|耗尽|余额归零|归零/i, terms: ['depleted', '耗尽', '归零'], preflight: true },
  { id: 'finalized', label: 'finalized/固化终态', pattern: /\bfinalized\b|固化终局|固化/i, terms: ['finalized', '固化'], preflight: true },
  { id: 'quarantined', label: 'quarantined/隔离终态', pattern: /\bquarantined\b|隔离终局|隔离/i, terms: ['quarantined', '隔离'], preflight: true },
];

const BEHAVIOR_RULES = [
  { id: 'restart', label: '重启后的持久化读取', pattern: /重启|重新打开|恢复读取|reopen|restart/i, terms: ['重启', '重新打开', 'reopen', 'restart', 'Close', 'Open'], preflight: true },
  { id: 'concurrency', label: '并发/竞态行为', matches: hasIssueSpecificConcurrencyRequirement, terms: ['并发', '竞态', 'concurr', 'race'], preflight: true },
  { id: 'idempotency', label: '幂等重放行为', pattern: /幂等|重放|重复提交|idempot/i, terms: ['幂等', '重放', '重复提交', 'idempot'], preflight: true },
  { id: 'rollback', label: '事务中断与回滚', pattern: /回滚|中断事务|检查点|rollback|checkpoint|transaction/i, terms: ['回滚', '中断', '检查点', 'rollback', 'checkpoint', 'transaction'], preflight: true },
  { id: 'normal_path', label: '保留的正常路径', pattern: /正常|继续成功|不受影响|保持现有|normal|retained/i, terms: ['正常', '继续成功', '不受影响', '保持现有', 'normal'] },
  { id: 'public_boundary', label: '公开服务/命令边界', pattern: /公开|服务接口|HTTP|命令入口|public|aggregate service/i, terms: ['公开', '服务', 'HTTP', '命令', 'public', 'Service'] },
];

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isGenericPreservationRequirement(value = '') {
  const text = normalized(value);
  if (!text) return false;
  const preservation = /不受影响|不应(?:被)?改变|不得影响|保持(?:现有|原有|既有|不变)|继续(?:正常|成功|通过|可用)|仍(?:然)?(?:正常|成功|通过|可用)|remain(?:s|ed|ing)?\s+(?:unchanged|unaffected|intact|stable)|(?:must|should)\s+not\s+(?:affect|change|regress)|without\s+(?:affecting|changing)|preserv(?:e|es|ing)\s+(?:existing|current)|no\s+regression/i.test(text);
  if (!preservation) return false;
  // A concrete concurrency trigger or outcome remains a hard behavior even
  // when the same sentence also asks to preserve unrelated behavior.
  return !hasIssueSpecificConcurrencyRequirement(text);
}

export function hasIssueSpecificConcurrencyRequirement(value = '') {
  const text = normalized(value);
  if (!/并发|竞态|竞争|协程|线程|goroutine|concurr|race|deadlock|interleav|simultaneous|parallel/i.test(text)) return false;
  return /数据竞争|竞态|死锁|活锁|丢更新|锁顺序|原子性|两个.{0,24}(?:goroutine|协程|线程)|(?:goroutine|协程|线程).{0,24}(?:并发|同时)|特定.{0,16}(?:交错|时序)|并发.{0,24}(?:时|下).{0,60}(?:错误|失败|panic|阻塞|丢失|不一致|重复|破坏)|并发(?:写入|提交|请求|调用|关闭|取消|启动|修改|更新|操作).{0,60}(?:导致|发生|触发|出现|返回|丢失|panic|阻塞)|-race\b|data\s+race|deadlock|livelock|lost\s+update|specific\s+interleav|two\s+goroutines|concurrent\s+(?:write|submit|request|call|close|cancel|start|update|operation).{0,60}(?:caus|trigger|return|lose|panic|block)/i.test(text);
}

function ruleMatches(rule, text) {
  return typeof rule.matches === 'function' ? rule.matches(text) : rule.pattern.test(text);
}

function addEntry(entries, seen, entry) {
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  entries.push({
    id: entry.id,
    label: entry.label,
    source: entry.source,
    requirement: entry.requirement,
    match_terms: entry.match_terms,
    preflight: entry.preflight === true,
  });
}

export function buildVerificationCoverageChecklist({ userQuery = '', successCriteria = '' } = {}) {
  const query = normalized(userQuery);
  const criteria = normalized(successCriteria);
  const entries = [];
  const seen = new Set();

  for (const rule of STATUS_RULES) {
    if (!rule.pattern.test(query)) continue;
    addEntry(entries, seen, {
      id: `status_${rule.id}`,
      label: rule.label,
      source: 'user_query',
      requirement: `公开 TestModel_ 测试必须通过公开服务或聚合边界触达并断言 ${rule.label}，不能只依赖隐藏 Gold 测试。`,
      match_terms: rule.terms,
      preflight: rule.preflight,
    });
  }
  for (const rule of BEHAVIOR_RULES) {
    if (!ruleMatches(rule, query)) continue;
    addEntry(entries, seen, {
      id: rule.id,
      label: rule.label,
      source: 'user_query',
      requirement: `公开 TestModel_ 测试必须直接覆盖${rule.label}，并断言题面要求的可观察结果。`,
      match_terms: rule.terms,
      preflight: rule.preflight,
    });
  }

  // Keep the checklist useful for short, domain-specific reports that do not
  // contain one of the common lifecycle words.
  if (!entries.length && query) {
    addEntry(entries, seen, {
      id: 'issue_specific_behavior',
      label: '题面中的具体 Bug 行为',
      source: 'user_query',
      requirement: '公开 TestModel_ 测试必须直接复现并断言 user_query 描述的具体 Bug 行为。',
      match_terms: [],
    });
  }

  return {
    policy_version: VERIFICATION_COVERAGE_CHECKLIST_VERSION,
    user_query: query,
    success_criteria: criteria,
    entries,
  };
}

export function formatVerificationCoverageChecklist(checklist = {}) {
  const entries = Array.isArray(checklist.entries) ? checklist.entries : [];
  const lines = [
    '# 公开回归测试覆盖清单',
    '',
    '这是提交前的早期检查清单，只包含 user_query 明确描述的硬要求。每一项都必须由提交仓库中的 TestModel_ 测试直接覆盖，并写入唯一的定向 verify_cmds。success_criteria 只能解释这些要求，不能新增失败场景。',
    '',
  ];
  for (const [index, entry] of entries.entries()) {
    lines.push(`${index + 1}. [${entry.id}] ${entry.label}（题面硬要求）`);
    lines.push(`   ${entry.requirement}`);
  }
  if (!entries.length) lines.push('1. [issue_specific_behavior] 直接覆盖 user_query 中描述的具体 Bug 行为。');
  lines.push('', '缺项时先补齐当前 workspace 的测试，再运行定向 go test；不要等全量 Docker 验证后才发现覆盖不足。');
  return `${lines.join('\n')}\n`;
}

function sourceText(testSources = []) {
  return (Array.isArray(testSources) ? testSources : [])
    .map((entry) => `${entry?.path || ''}\n${entry?.content || ''}`)
    .join('\n');
}

export function verificationCoverageChecklistIssues(checklist = {}, testSources = []) {
  const text = sourceText(testSources);
  const issues = [];
  for (const entry of Array.isArray(checklist.entries) ? checklist.entries : []) {
    // success_criteria-only details remain supplemental, matching the final
    // semantic coverage policy. The early gate must not make them hard.
    if (entry.source !== 'user_query' || entry.preflight !== true || !Array.isArray(entry.match_terms) || entry.match_terms.length === 0) continue;
    // Existing task directories may contain a checklist generated before the
    // preservation-clause distinction was introduced. Re-evaluate those
    // concurrency entries from the original query instead of forcing a retry
    // to add an unrelated concurrent scenario.
    if (entry.id === 'concurrency' && !hasIssueSpecificConcurrencyRequirement(checklist.user_query)) continue;
    const matched = entry.match_terms.some((term) => new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
    if (!matched) issues.push(`[${entry.id}] ${entry.label}`);
  }
  return issues;
}
