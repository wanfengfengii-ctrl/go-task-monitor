import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMutationAudit } from './trajectory-audit.js';

test('mutation audit reports workspace and temporary source writes by tool', () => {
  const records = [
    { event: 'V4Baseline', files: { 'workspace/a.go': 'old' } },
    { event: 'PreToolUse', tool_use_id: 'one', tool_name: 'Bash', files: { 'workspace/a.go': 'old' } },
    { event: 'PostToolUse', tool_use_id: 'one', tool_name: 'Bash', files: { 'workspace/a.go': 'new', 'temp-source/repro.go': 'hash' } },
    { event: 'V4Final', files: { 'workspace/a.go': 'new', 'temp-source/repro.go': 'hash' } },
  ];
  const result = analyzeMutationAudit(records);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mutations.map((item) => item.filename), ['temp-source/repro.go', 'workspace/a.go']);
});

test('mutation audit fails closed without baseline and final snapshots', () => {
  assert.equal(analyzeMutationAudit([{ event: 'PreToolUse', tool_use_id: 'one', files: {} }]).ok, false);
});

test('mutation audit fails closed when a writable tool is not fully paired', () => {
  const result = analyzeMutationAudit([
    { event: 'V4Baseline', files: {} },
    { event: 'PreToolUse', tool_use_id: 'one', tool_name: 'Bash', files: {} },
    { event: 'V4Final', files: {} },
  ], { expectedToolUses: [{ id: 'one', name: 'Bash' }] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(';'), /未记录 PostToolUse/);
});

test('mutation audit accepts an explicitly denied tool without a post snapshot', () => {
  const result = analyzeMutationAudit([
    { event: 'V4Baseline', files: {} },
    {
      event: 'PreToolUse',
      tool_use_id: 'denied',
      tool_name: 'Bash',
      permission_decision: 'deny',
      permission_reason: 'diagnosis code write denied',
      files: {},
    },
    { event: 'V4Final', files: {} },
  ], { expectedToolUses: [{ id: 'denied', name: 'Bash' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mutations, []);
});

test('mutation audit accepts a CLI-denied tool without a post snapshot', () => {
  const result = analyzeMutationAudit([
    { event: 'V4Baseline', files: {} },
    { event: 'PreToolUse', tool_use_id: 'cli-denied', tool_name: 'Bash', files: {} },
    { event: 'V4Final', files: {} },
  ], {
    expectedToolUses: [{ id: 'cli-denied', name: 'Bash' }],
    deniedToolUseIds: new Set(['cli-denied']),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mutations, []);
});
