export const EXCEL_EXPORT_VALIDATION_BATCH_SIZE = 10;

function normalizedStrings(values) {
  const source = Array.isArray(values) ? values : [...(values || [])];
  return [...new Set(source.map(String).filter(Boolean))].sort();
}

export function splitExportBatches(items, batchSize = EXCEL_EXPORT_VALIDATION_BATCH_SIZE) {
  const size = Math.max(1, Number(batchSize) || EXCEL_EXPORT_VALIDATION_BATCH_SIZE);
  const batches = [];
  for (let index = 0; index < (items || []).length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function createExportValidationTokenStore({
  ttlMs = 10 * 60_000,
  now = () => Date.now(),
  createToken,
} = {}) {
  if (typeof createToken !== 'function') throw new Error('createToken is required');
  const records = new Map();

  const prune = () => {
    const current = now();
    for (const [token, record] of records) {
      if (record.expiresAt <= current) records.delete(token);
    }
  };

  return {
    issue(taskIds) {
      prune();
      const tasks = normalizedStrings(taskIds);
      if (!tasks.length) throw new Error('cannot issue an empty export validation token');
      const token = String(createToken());
      records.set(token, { tasks, expiresAt: now() + ttlMs });
      return token;
    },
    consume(tokens, taskIds) {
      prune();
      const requestedTokens = normalizedStrings(tokens);
      const requestedTasks = normalizedStrings(taskIds);
      if (!requestedTokens.length || !requestedTasks.length) return false;
      const authorized = new Set();
      for (const token of requestedTokens) {
        const record = records.get(token);
        if (!record) return false;
        record.tasks.forEach((taskId) => authorized.add(taskId));
      }
      if (normalizedStrings(authorized).join('\n') !== requestedTasks.join('\n')) return false;
      requestedTokens.forEach((token) => records.delete(token));
      return true;
    },
  };
}
