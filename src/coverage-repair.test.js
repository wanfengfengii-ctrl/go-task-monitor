import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCoverageRepairOnlyChangesTests, coverageRepairNonTestChanges } from './coverage-repair.js';

test('coverage repair permits only Go test file changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-repair-'));
  const baseline = path.join(root, 'baseline');
  const workspace = path.join(root, 'workspace');
  try {
    await Promise.all([mkdir(baseline), mkdir(workspace)]);
    await Promise.all([
      writeFile(path.join(baseline, 'service.go'), 'package sample\n'),
      writeFile(path.join(workspace, 'service.go'), 'package sample\n'),
      writeFile(path.join(baseline, 'service_test.go'), 'package sample\n'),
      writeFile(path.join(workspace, 'service_test.go'), 'package sample\n// added assertion\n'),
      writeFile(path.join(workspace, 'http_test.go'), 'package sample\n'),
    ]);
    assert.deepEqual(await coverageRepairNonTestChanges(baseline, workspace), []);
    assert.deepEqual(await assertCoverageRepairOnlyChangesTests(baseline, workspace), {
      ok: true,
      changed_non_test_files: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coverage repair rejects production and configuration changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-repair-'));
  const baseline = path.join(root, 'baseline');
  const workspace = path.join(root, 'workspace');
  try {
    await Promise.all([mkdir(baseline), mkdir(workspace)]);
    await writeFile(path.join(baseline, 'service.go'), 'package sample\n');
    await writeFile(path.join(workspace, 'service.go'), 'package changed\n');
    await writeFile(path.join(workspace, 'go.sum'), 'new dependency\n');
    assert.deepEqual(await coverageRepairNonTestChanges(baseline, workspace), ['go.sum', 'service.go']);
    await assert.rejects(
      assertCoverageRepairOnlyChangesTests(baseline, workspace),
      /覆盖补测模式禁止修改生产代码或其他文件：go.sum, service.go/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
