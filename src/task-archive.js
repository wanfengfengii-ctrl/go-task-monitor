const RESTORABLE_STATUSES = new Set(['passed', 'failed', 'skipped']);
const RESTORABLE_REVIEWS = new Set(['pending', 'qualified', 'unqualified']);

function archivedTaskRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = String(record.id || '').trim();
  const name = String(record.name || '').trim();
  const bugId = String(record.bug_id || '').trim();
  if (!/^task-[0-9a-f]{16}$/i.test(id) || !name || !bugId) return null;

  return {
    ...record,
    id,
    name,
    bug_id: bugId,
    status: RESTORABLE_STATUSES.has(record.status) ? record.status : 'failed',
    reviewStatus: RESTORABLE_REVIEWS.has(record.reviewStatus) ? record.reviewStatus : null,
    archived: true,
    sourceId: 'historical-archive',
    taskDir: null,
    workspaceAvailable: false,
    productionFlowEligible: false,
    gitPreparationEligible: false,
    gitWorkflowEligible: false,
    ruleIssues: [],
    recoveryWarnings: [],
    duplicateFields: [],
  };
}

export function mergeArchivedTaskRecords(liveTasks = [], archivedRecords = []) {
  const live = Array.isArray(liveTasks) ? liveTasks : [];
  const occupiedIds = new Set(live.map((task) => String(task?.id || '')).filter(Boolean));
  const occupiedNames = new Set(live.map((task) => String(task?.name || '')).filter(Boolean));
  const occupiedBugIds = new Set(live.map((task) => String(task?.bug_id || '')).filter(Boolean));
  const restored = [];

  for (const raw of Array.isArray(archivedRecords) ? archivedRecords : []) {
    const task = archivedTaskRecord(raw);
    if (!task) continue;
    if (occupiedIds.has(task.id) || occupiedNames.has(task.name) || occupiedBugIds.has(task.bug_id)) continue;
    restored.push(task);
    occupiedIds.add(task.id);
    occupiedNames.add(task.name);
    occupiedBugIds.add(task.bug_id);
  }

  return [...live, ...restored];
}

export function hasCurrentArchivedExportPolicy(task, currentVerificationPolicyVersion) {
  return task?.archiveExportReady === true
    && Number(task.verification_policy_version || 0) >= Number(currentVerificationPolicyVersion || 0);
}
