import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExportValidationTokenStore,
  EXCEL_EXPORT_VALIDATION_BATCH_SIZE,
  splitExportBatches,
} from './export-coordinator.js';

test('Excel exports are split into bounded validation batches', () => {
  const items = Array.from({ length: 25 }, (_, index) => `task-${index + 1}`);
  assert.equal(EXCEL_EXPORT_VALIDATION_BATCH_SIZE, 10);
  assert.deepEqual(splitExportBatches(items).map((batch) => batch.length), [10, 10, 5]);
});

test('export validation tokens bind the exact task set and are single-use', () => {
  let clock = 1_000;
  let sequence = 0;
  const store = createExportValidationTokenStore({
    ttlMs: 500,
    now: () => clock,
    createToken: () => `token-${++sequence}`,
  });
  const first = store.issue(['task-2', 'task-1']);
  const second = store.issue(['task-3']);
  assert.equal(store.consume([first, second], ['task-1', 'task-2', 'task-3']), true);
  assert.equal(store.consume([first], ['task-1', 'task-2']), false);

  const expired = store.issue(['task-4']);
  clock += 501;
  assert.equal(store.consume([expired], ['task-4']), false);
});
